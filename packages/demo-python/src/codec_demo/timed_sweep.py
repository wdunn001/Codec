"""Definitive timed sweep — single run, fixed prompt, multiple reps, all
12 cells (3 paths x 4 encodings) at 3 sizes. Reports both wire bytes
and TTFT so the time-vs-bytes story comes from one consistent dataset.

This exists because the previous TTFT and crossover tables were stitched
together from separate runs, which produced subtle inconsistencies in
the brotli numbers (small Codec frames + small differences in emitted
token counts give surprisingly different br behaviour).

Usage:
    codec-bench-timed --url http://192.168.1.88:30000
                      --sizes 64 512 2048 --reps 3
"""
from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
import time
from dataclasses import dataclass

import httpx

from . import PATHS, ENCODINGS, Cell, run_one, fmt_bytes


LONG_PROMPT = (
    "Write a long, detailed essay covering: 1) the complete history of "
    "artificial intelligence from 1950 to today, 2) every major architecture, "
    "3) the math behind backprop and attention with worked examples, "
    "4) the alignment problem in detail, 5) hardware evolution, 6) the "
    "economics of training large models. Be thorough and use complete sentences."
)


@dataclass
class CellTime:
    size: int
    path_label: str
    fmt: str
    encoding: str
    wire_bytes: int | None
    ttfb_ms: float | None
    total_ms: float | None
    tokens: int


async def run_cell(client: httpx.AsyncClient, url: str, model: str,
                   prompt: str, max_tokens: int,
                   path_label: str, fmt: str, encoding: str,
                   reps: int) -> CellTime:
    wires: list[int] = []
    ttfbs: list[float] = []
    totals: list[float] = []
    tokens = 0
    for _ in range(reps):
        cell = Cell(path_label=path_label, format=fmt, encoding=encoding)
        await run_one(client, url, model, prompt, max_tokens, cell)
        if cell.status == "done" and cell.wire_bytes is not None:
            wires.append(cell.wire_bytes)
            if cell.ttfb_ms is not None: ttfbs.append(cell.ttfb_ms)
            if cell.total_ms is not None: totals.append(cell.total_ms)
            tokens = max(tokens, cell.tokens)
    return CellTime(
        size=max_tokens,
        path_label=path_label,
        fmt=fmt,
        encoding=encoding,
        wire_bytes=int(statistics.median(wires)) if wires else None,
        ttfb_ms=statistics.median(ttfbs) if ttfbs else None,
        total_ms=statistics.median(totals) if totals else None,
        tokens=tokens,
    )


async def main_async(args: argparse.Namespace) -> None:
    results: list[CellTime] = []
    async with httpx.AsyncClient() as client:
        for size in args.sizes:
            print(f"\n>>> size={size}", file=sys.stderr)
            for label, fmt in PATHS:
                for enc in ENCODINGS:
                    print(f"    {label:25s} {enc:8s}  ", end="", file=sys.stderr, flush=True)
                    r = await run_cell(client, args.url, args.model,
                                       LONG_PROMPT, size, label, fmt, enc, args.reps)
                    results.append(r)
                    print(
                        f"wire={fmt_bytes(r.wire_bytes):>10s} "
                        f"ttfb={int(r.ttfb_ms or 0):>5d} ms "
                        f"total={int(r.total_ms or 0):>5d} ms "
                        f"tokens={r.tokens}",
                        file=sys.stderr,
                    )

    print(f"# Codec timed sweep — definitive run\n")
    print(f"Server: {args.url}")
    print(f"Model:  {args.model}")
    print(f"Reps:   {args.reps}  (medians shown)")
    print(f"Sizes:  {args.sizes}\n")

    # Wire bytes table
    print("\n## Wire bytes (median of reps)\n")
    sizes = args.sizes
    header = f"| {'path · encoding':30s} |" + "|".join(f" {s:>9d} tok " for s in sizes) + "|"
    sep = "|" + "-" * 32 + "|" + "|".join("-----------:" for _ in sizes) + "|"
    print(header)
    print(sep)
    for label, fmt in PATHS:
        for enc in ENCODINGS:
            cells = []
            for size in sizes:
                hit = next((r for r in results if r.size == size and r.path_label == label and r.encoding == enc), None)
                cells.append(f"{fmt_bytes(hit.wire_bytes) if hit else '-':>11s}")
            print(f"| {label + ' · ' + enc:30s} |" + "|".join(f" {c} " for c in cells) + "|")

    # TTFT table
    print("\n## TTFT (ms, median of reps)\n")
    print(header)
    print(sep)
    for label, fmt in PATHS:
        for enc in ENCODINGS:
            cells = []
            for size in sizes:
                hit = next((r for r in results if r.size == size and r.path_label == label and r.encoding == enc), None)
                v = "-" if hit is None or hit.ttfb_ms is None else f"{int(hit.ttfb_ms)} ms"
                cells.append(f"{v:>11s}")
            print(f"| {label + ' · ' + enc:30s} |" + "|".join(f" {c} " for c in cells) + "|")

    # Total
    print("\n## Total wall-clock (ms, median of reps)\n")
    print(header)
    print(sep)
    for label, fmt in PATHS:
        for enc in ENCODINGS:
            cells = []
            for size in sizes:
                hit = next((r for r in results if r.size == size and r.path_label == label and r.encoding == enc), None)
                v = "-" if hit is None or hit.total_ms is None else f"{int(hit.total_ms)} ms"
                cells.append(f"{v:>11s}")
            print(f"| {label + ' · ' + enc:30s} |" + "|".join(f" {c} " for c in cells) + "|")

    # Composite metric: bytes x TTFT (lower is better). Normalized so the
    # JSON-SSE identity cell at each size = 1.0; everything else is "X times
    # more efficient than the baseline at this size for interactive use."
    # This captures the bytes/time trade-off in a single number.
    print("\n## Interactive efficiency: bytes \xd7 TTFT (lower = better; X = times better than json-sse identity)\n")
    print(header)
    print(sep)
    baselines: dict[int, float] = {}
    for size in sizes:
        base = next((r for r in results
                     if r.size == size
                     and r.path_label == PATHS[0][0]
                     and r.encoding == ENCODINGS[0]
                     and r.wire_bytes is not None
                     and r.ttfb_ms is not None), None)
        if base is not None and base.wire_bytes and base.ttfb_ms:
            baselines[size] = base.wire_bytes * base.ttfb_ms
    for label, fmt in PATHS:
        for enc in ENCODINGS:
            cells = []
            for size in sizes:
                hit = next((r for r in results if r.size == size and r.path_label == label and r.encoding == enc), None)
                if hit is None or hit.wire_bytes is None or hit.ttfb_ms is None:
                    cells.append("           -")
                    continue
                product = hit.wire_bytes * hit.ttfb_ms
                base = baselines.get(size)
                if not base or not product:
                    cells.append("           -")
                else:
                    ratio = base / product
                    cells.append(f"{ratio:>9.1f}\xd7")
            print(f"| {label + ' \xb7 ' + enc:30s} |" + "|".join(f" {c} " for c in cells) + "|")

    # Batch efficiency: bytes-only. (TTFT doesn't matter when nobody is waiting.)
    print("\n## Batch efficiency: wire bytes only (X = times better than json-sse identity)\n")
    print(header)
    print(sep)
    bytes_baselines: dict[int, int] = {}
    for size in sizes:
        base = next((r for r in results
                     if r.size == size
                     and r.path_label == PATHS[0][0]
                     and r.encoding == ENCODINGS[0]
                     and r.wire_bytes is not None), None)
        if base is not None and base.wire_bytes:
            bytes_baselines[size] = base.wire_bytes
    for label, fmt in PATHS:
        for enc in ENCODINGS:
            cells = []
            for size in sizes:
                hit = next((r for r in results if r.size == size and r.path_label == label and r.encoding == enc), None)
                if hit is None or hit.wire_bytes is None:
                    cells.append("           -")
                    continue
                base = bytes_baselines.get(size)
                if not base:
                    cells.append("           -")
                else:
                    ratio = base / hit.wire_bytes
                    cells.append(f"{ratio:>9.1f}\xd7")
            print(f"| {label + ' \xb7 ' + enc:30s} |" + "|".join(f" {c} " for c in cells) + "|")

    # Tokens emitted (sanity: should be roughly equal across encodings within a size)
    print("\n## Tokens emitted (sanity check)\n")
    print(header)
    print(sep)
    for label, fmt in PATHS:
        for enc in ENCODINGS:
            cells = []
            for size in sizes:
                hit = next((r for r in results if r.size == size and r.path_label == label and r.encoding == enc), None)
                cells.append(f"{(hit.tokens if hit else 0):>11d}")
            print(f"| {label + ' · ' + enc:30s} |" + "|".join(f" {c} " for c in cells) + "|")


def main() -> None:
    ap = argparse.ArgumentParser(prog="codec-bench-timed")
    ap.add_argument("--url", default="http://192.168.1.88:30000")
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--sizes", type=int, nargs="+", default=[64, 512, 2048])
    ap.add_argument("--reps", type=int, default=2)
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
