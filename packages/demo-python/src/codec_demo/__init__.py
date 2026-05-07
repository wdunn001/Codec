"""
codec-bench - CLI bench for the Codec wire format.

Same shape as packages/demo-web (TypeScript) and the .NET / C demos:
    3 wire formats x 4 compression encodings = 12 cells per run.

Usage:
    codec-bench [--url http://192.168.1.88:30000]
                [--model Qwen/Qwen2.5-0.5B-Instruct]
                [--prompt "..."]
                [--max-tokens 64]
"""
from __future__ import annotations

import argparse
import asyncio
import io
import struct
import sys
import time
from dataclasses import dataclass, field
from typing import AsyncIterator

import httpx
import msgpack


# ----- config ----------------------------------------------------------------


PATHS = [
    ("JSON-SSE (default)", "json"),
    ("Codec msgpack",      "msgpack"),
    ("Codec protobuf",     "protobuf"),
]
ENCODINGS = ["identity", "gzip", "br", "zstd"]


@dataclass
class Cell:
    path_label: str
    format: str
    encoding: str
    status: str = "pending"          # pending / running / done / error
    wire_bytes: int | None = None
    decoded_bytes: int | None = None
    tokens: int = 0
    ttfb_ms: float | None = None
    total_ms: float | None = None
    error: str | None = None


# ----- helpers ---------------------------------------------------------------


def fmt_bytes(n: int | None) -> str:
    if n is None:
        return "-"
    if n < 1024:
        return f"{n} B"
    if n < 1_048_576:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1_048_576:.2f} MB"


def fmt_ms(n: float | None) -> str:
    return "-" if n is None else f"{n:.0f} ms"


def count_jsonsse(decoded: bytes) -> int:
    n = 0
    for line in decoded.split(b"\n"):
        if line.startswith(b"data: ") and b"[DONE]" not in line:
            n += 1
    return n


def count_msgpack(decoded: bytes) -> int:
    n = 0
    for frame in msgpack.Unpacker(io.BytesIO(decoded), raw=False):
        n += len(frame.get("ids", []))
    return n


def count_protobuf(decoded: bytes) -> int:
    """Length-prefixed CodecFrames: 4-byte BE length + payload. Decode field 1
    (packed uint32 ids) only; skip everything else."""
    n = 0
    pos = 0
    L = len(decoded)
    while pos + 4 <= L:
        (length,) = struct.unpack(">I", decoded[pos:pos + 4])
        pos += 4
        if pos + length > L:
            break
        body = decoded[pos:pos + length]
        bp = 0
        while bp < len(body):
            tag = 0; shift = 0
            while True:
                b = body[bp]; bp += 1
                tag |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
            field = tag >> 3
            wt = tag & 0x07
            if field == 1 and wt == 2:
                ln = 0; shift = 0
                while True:
                    b = body[bp]; bp += 1
                    ln |= (b & 0x7F) << shift
                    if not (b & 0x80):
                        break
                    shift += 7
                end = bp + ln
                while bp < end:
                    while True:
                        b = body[bp]; bp += 1
                        if not (b & 0x80):
                            break
                    n += 1
            elif wt == 0:
                while True:
                    b = body[bp]; bp += 1
                    if not (b & 0x80):
                        break
            elif wt == 2:
                ln = 0; shift = 0
                while True:
                    b = body[bp]; bp += 1
                    ln |= (b & 0x7F) << shift
                    if not (b & 0x80):
                        break
                    shift += 7
                bp += ln
            elif wt == 5:
                bp += 4
            elif wt == 1:
                bp += 8
            else:
                break
        pos += length
    return n


COUNTERS = {
    "json": count_jsonsse,
    "msgpack": count_msgpack,
    "protobuf": count_protobuf,
}


# ----- single-cell runner ----------------------------------------------------
#
# httpx's `aiter_raw()` yields bytes BEFORE any Accept-Encoding decompression,
# so summing them gives the actual wire size. We then decompress manually for
# token counting (gzip via stdlib, brotli via brotli pkg, zstd via zstandard
# pkg). If a codec isn't available the request still happens with that
# Accept-Encoding header — the server just won't pick it.


async def run_one(client: httpx.AsyncClient, url: str, model: str, prompt: str,
                  max_tokens: int, cell: Cell) -> None:
    cell.status = "running"
    body = {
        "model": model,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "stream": True,
        "temperature": 0.0,
    }
    if cell.format != "json":
        body["stream_format"] = cell.format

    headers = {"Accept-Encoding": cell.encoding}

    t0 = time.perf_counter()
    ttfb = None
    try:
        async with client.stream(
            "POST",
            url + "/v1/completions",
            json=body,
            headers=headers,
            timeout=120.0,
        ) as resp:
            resp.raise_for_status()
            content_encoding = resp.headers.get("content-encoding", "identity")
            wire_buf = bytearray()
            async for chunk in resp.aiter_raw():
                if ttfb is None:
                    ttfb = (time.perf_counter() - t0) * 1000
                wire_buf.extend(chunk)

        wire_bytes = bytes(wire_buf)
        cell.wire_bytes = len(wire_bytes)

        # Decompress for token counting if the server applied an encoding.
        if content_encoding == "gzip":
            import gzip
            decompressed = gzip.decompress(wire_bytes)
        elif content_encoding == "br":
            import brotli  # type: ignore
            decompressed = brotli.decompress(wire_bytes)
        elif content_encoding == "zstd":
            # Use stream_reader: server-side compression doesn't write a
            # content-size header in the zstd frame, which makes the
            # one-shot .decompress() raise. stream_reader handles
            # frame-by-frame decompression cleanly.
            import io
            import zstandard  # type: ignore
            with zstandard.ZstdDecompressor().stream_reader(
                io.BytesIO(wire_bytes)
            ) as reader:
                decompressed = reader.read()
        else:
            decompressed = wire_bytes

        cell.decoded_bytes = len(decompressed)
        cell.tokens = COUNTERS[cell.format](decompressed)
        cell.ttfb_ms = ttfb
        cell.total_ms = (time.perf_counter() - t0) * 1000
        cell.status = "done"
    except Exception as e:
        cell.error = f"{type(e).__name__}: {e}"
        cell.status = "error"


# ----- table rendering -------------------------------------------------------


def render_table(grid: list[list[Cell]]) -> str:
    # Find baseline (top-left = JSON-SSE / identity)
    baseline = None
    if grid and grid[0] and grid[0][0].status == "done":
        baseline = grid[0][0].wire_bytes

    rows = []
    header = f"{'path':25s}  " + "  ".join(f"{e:>16s}" for e in ENCODINGS)
    rows.append(header)
    rows.append("-" * len(header))

    for row in grid:
        cells = [f"{row[0].path_label:25s}"]
        for c in row:
            if c.status == "pending":
                cells.append(f"{'-':>16s}")
            elif c.status == "running":
                cells.append(f"{'running':>16s}")
            elif c.status == "error":
                cells.append(f"{c.error[:16]:>16s}")
            else:
                cells.append(f"{fmt_bytes(c.wire_bytes):>16s}")
        rows.append("  ".join(cells))

    rows.append("")
    rows.append("per cell: wire_bytes / tokens / B-per-tok / ttfb / total / ratio-vs-json")
    rows.append("")

    for row in grid:
        for c in row:
            if c.status != "done" or c.wire_bytes is None:
                continue
            ratio = baseline / c.wire_bytes if baseline and c.wire_bytes else 0
            bpt = c.wire_bytes / c.tokens if c.tokens else 0
            rows.append(
                f"  {c.path_label:25s} {c.encoding:8s} "
                f"{fmt_bytes(c.wire_bytes):>10s}  {c.tokens:4d} tok  "
                f"{bpt:6.1f} B/tok  {fmt_ms(c.ttfb_ms):>7s} TTFB  "
                f"{fmt_ms(c.total_ms):>7s} total  {ratio:5.1f}x"
            )

    return "\n".join(rows)


# ----- driver ----------------------------------------------------------------


async def run_all(url: str, model: str, prompt: str, max_tokens: int) -> None:
    grid: list[list[Cell]] = [
        [Cell(path_label=label, format=fmt, encoding=enc) for enc in ENCODINGS]
        for label, fmt in PATHS
    ]
    async with httpx.AsyncClient() as client:
        for row in grid:
            for cell in row:
                print(f">>>  {cell.path_label} / {cell.encoding}", file=sys.stderr)
                await run_one(client, url, model, prompt, max_tokens, cell)
                if cell.status == "done":
                    print(
                        f"     wire={fmt_bytes(cell.wire_bytes)} tokens={cell.tokens} "
                        f"total={fmt_ms(cell.total_ms)}",
                        file=sys.stderr,
                    )
                else:
                    print(f"     {cell.status}: {cell.error}", file=sys.stderr)

    print()
    print(render_table(grid))


async def run_sweep(url: str, model: str, prompt: str,
                    sizes: list[tuple[str, int]]) -> None:
    """Run the full grid at small/medium/large and print each table.
    Sizes is a list of (label, max_tokens) pairs."""
    for label, max_tokens in sizes:
        print(f"\n========== size={label} (max_tokens={max_tokens}) ==========")
        await run_all(url, model, prompt, max_tokens)


def main() -> None:
    ap = argparse.ArgumentParser(prog="codec-bench")
    ap.add_argument("--url", default="http://192.168.1.88:30000",
                    help="sglang server URL (default: %(default)s)")
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct",
                    help="model id (default: %(default)s)")
    ap.add_argument("--prompt", default="Explain entropy in one sentence:",
                    help="prompt to send")
    ap.add_argument("--max-tokens", type=int, default=64,
                    help="max output tokens, single-size mode (default: %(default)s)")
    ap.add_argument("--sweep", action="store_true",
                    help="sweep small/medium/large sizes; ignores --max-tokens")
    ap.add_argument("--small",  type=int, default=64,   help="small  size tokens (default: 64)")
    ap.add_argument("--medium", type=int, default=512,  help="medium size tokens (default: 512)")
    ap.add_argument("--large",  type=int, default=2048, help="large  size tokens (default: 2048)")
    args = ap.parse_args()

    if args.sweep:
        sizes = [("small", args.small), ("medium", args.medium), ("large", args.large)]
        asyncio.run(run_sweep(args.url, args.model, args.prompt, sizes))
    else:
        asyncio.run(run_all(args.url, args.model, args.prompt, args.max_tokens))


if __name__ == "__main__":
    main()
