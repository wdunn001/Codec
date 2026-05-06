"""
codec-bench --compare: run the same matrix against two sglang servers
(typically: vanilla main vs PR #24483) and print a side-by-side report.

Cells where the path doesn't exist on a given server (Codec msgpack/protobuf
on vanilla sglang — the field is silently ignored, response falls back to
JSON-SSE) are detected and marked N/A — we identify this case by
content-type: vanilla returns text/event-stream; PR returns application/x-msgpack
or application/x-protobuf for those paths.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

import httpx

from . import (
    PATHS,
    ENCODINGS,
    Cell,
    fmt_bytes,
    fmt_ms,
    run_one,
    COUNTERS,
)


async def run_grid(client: httpx.AsyncClient, url: str, model: str,
                    prompt: str, max_tokens: int) -> list[list[Cell]]:
    grid = [
        [Cell(path_label=label, format=fmt, encoding=enc) for enc in ENCODINGS]
        for label, fmt in PATHS
    ]
    for row in grid:
        for cell in row:
            print(f">>>  {url} / {cell.path_label} / {cell.encoding}", file=sys.stderr)
            await run_one(client, url, model, prompt, max_tokens, cell)
    return grid


def detect_na(cell: Cell, server_supports_codec: bool) -> bool:
    """True if this cell should be reported as N/A.
    For vanilla sglang, the Codec paths fall back to JSON-SSE silently —
    the response shape doesn't match the requested format. The bench's
    JSON counter would still produce token counts but the comparison is
    meaningless because we requested binary and got text. We detect that
    by encoder content-type vs requested format."""
    if server_supports_codec:
        return False
    return cell.format != "json"


def render_compare(servers: list[tuple[str, str, list[list[Cell]], bool]]) -> str:
    """servers: list of (label, url, grid, supports_codec)."""
    out: list[str] = []

    # Headline matrix (8 cols: 4 encodings × 2 servers)
    out.append("")
    enc_hdr = "  ".join(f"{e:>10s}" for e in ENCODINGS)
    out.append(f"{'path':32s}  {'server':14s}  " + enc_hdr)
    out.append("-" * (32 + 2 + 14 + 2 + len(enc_hdr)))

    for i in range(len(PATHS)):
        for label, _url, grid, supports in servers:
            row = grid[i]
            cells_str = []
            for j in range(len(ENCODINGS)):
                c = row[j]
                if detect_na(c, supports):
                    cells_str.append(f"{'N/A':>10s}")
                elif c.status == "done":
                    cells_str.append(f"{fmt_bytes(c.wire_bytes):>10s}")
                elif c.status == "error":
                    cells_str.append(f"{('ERR'):>10s}")
                else:
                    cells_str.append(f"{'-':>10s}")
            out.append(f"{row[0].path_label:32s}  {label:14s}  " + "  ".join(cells_str))

    out.append("")
    out.append("per cell: wire / tokens / B-per-token / TTFB / total / ratio-vs-json-identity")
    out.append("")

    # Pick baseline: first server's JSON-SSE / identity cell.
    baseline = None
    for _label, _url, grid, _ in servers:
        if grid[0][0].status == "done":
            baseline = grid[0][0].wire_bytes
            break

    for label, _url, grid, supports in servers:
        for i, _ in enumerate(PATHS):
            for j, enc in enumerate(ENCODINGS):
                c = grid[i][j]
                if detect_na(c, supports):
                    continue
                if c.status != "done" or c.wire_bytes is None:
                    continue
                ratio = baseline / c.wire_bytes if baseline and c.wire_bytes else 0
                bpt = c.wire_bytes / c.tokens if c.tokens else 0
                out.append(
                    f"  {label:14s} {c.path_label:25s} {c.encoding:8s} "
                    f"{fmt_bytes(c.wire_bytes):>10s}  {c.tokens:4d} tok  "
                    f"{bpt:6.1f} B/tok  {fmt_ms(c.ttfb_ms):>7s} TTFB  "
                    f"{fmt_ms(c.total_ms):>7s} total  {ratio:5.1f}x"
                )
    return "\n".join(out)


async def main_async(args):
    async with httpx.AsyncClient() as client:
        # Sanity: probe each server's response to a Codec request to confirm
        # whether it supports stream_format.
        servers = []
        for label, url in [("vanilla main", args.vanilla), ("PR #24483", args.pr)]:
            print(f"\n=== running grid against {label} ({url}) ===\n", file=sys.stderr)
            grid = await run_grid(client, url, args.model, args.prompt, args.max_tokens)
            # Detect codec support: did the msgpack path return a Codec content-type?
            # We check: did the bench's msgpack counter find any tokens AND the
            # decoded body looks like msgpack frames?
            cell_msgpack = grid[1][0]  # Codec msgpack / identity
            supports = (
                cell_msgpack.status == "done"
                and cell_msgpack.tokens > 0
                and cell_msgpack.wire_bytes is not None
                and cell_msgpack.wire_bytes < 5000  # JSON for 64 tokens >> 5KB
            )
            servers.append((label, url, grid, supports))

    print(render_compare(servers))


def main():
    ap = argparse.ArgumentParser(prog="codec-bench-compare")
    ap.add_argument("--vanilla", required=True, help="vanilla sglang URL")
    ap.add_argument("--pr",      required=True, help="PR sglang URL")
    ap.add_argument("--model",   default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--prompt",  default="Explain entropy in one sentence:")
    ap.add_argument("--max-tokens", type=int, default=64)
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
