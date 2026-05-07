"""
codec-bench-crossover: fine-grained size sweep to find the encoding
crossover thresholds.

Single-size benches mask the real story. This walks the full grid
(json-sse / msgpack / protobuf  x  identity / gzip / br / zstd) at
many output sizes and prints:

  1. wire bytes per (size, path, encoding) cell
  2. winner per (size, path) row
  3. recommended-encoding rules derived from the data

Usage:
    codec-bench-crossover --url http://192.168.1.88:30000
                          [--model Qwen/Qwen2.5-0.5B-Instruct]
                          [--sizes 16 32 64 128 256 512 1024 2048]
                          [--prompt-long]
                          [--reps 1]
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


SHORT_PROMPT = "Explain entropy in one sentence:"
LONG_PROMPT = (
    "Write a long, detailed essay covering: 1) the complete history of "
    "artificial intelligence from 1950 to today, 2) every major architecture "
    "(perceptrons, RNNs, LSTMs, GRUs, transformers, mixture-of-experts), "
    "3) the math behind backprop and attention with worked examples, "
    "4) the alignment problem in detail, 5) hardware evolution from CPUs to "
    "TPUs to dedicated ASICs, 6) the economics of training large models. "
    "Be thorough and use complete sentences."
)


@dataclass
class CellResult:
    size: int
    path_label: str
    fmt: str
    encoding: str
    wire_bytes: int | None
    tokens: int


async def run_grid_at_size(
    client: httpx.AsyncClient,
    url: str,
    model: str,
    prompt: str,
    max_tokens: int,
    reps: int,
) -> list[CellResult]:
    out: list[CellResult] = []
    for label, fmt in PATHS:
        for enc in ENCODINGS:
            wire_runs: list[int] = []
            tokens = 0
            for _ in range(reps):
                cell = Cell(path_label=label, format=fmt, encoding=enc)
                await run_one(client, url, model, prompt, max_tokens, cell)
                if cell.status == "done" and cell.wire_bytes is not None:
                    wire_runs.append(cell.wire_bytes)
                    tokens = max(tokens, cell.tokens)
            wire = int(statistics.median(wire_runs)) if wire_runs else None
            out.append(CellResult(max_tokens, label, fmt, enc, wire, tokens))
            print(
                f"    {label:25s} {enc:8s} max={max_tokens:5d}  "
                f"wire={fmt_bytes(wire):>10s}  tokens={tokens}",
                file=sys.stderr,
            )
    return out


def render_wire_table(results: list[CellResult], sizes: list[int]) -> str:
    lines: list[str] = []
    lines.append("\n## Wire bytes by (path, encoding, size)\n")
    header = f"| {'path · encoding':30s} |" + "|".join(f" {s:>9d} tok " for s in sizes) + "|"
    sep = "|" + "-" * 32 + "|" + "|".join("-----------:" for _ in sizes) + "|"
    lines.append(header)
    lines.append(sep)
    for label, fmt in PATHS:
        for enc in ENCODINGS:
            cells = []
            for size in sizes:
                hit = next(
                    (r for r in results if r.size == size and r.path_label == label and r.encoding == enc),
                    None,
                )
                cells.append(f"{fmt_bytes(hit.wire_bytes) if hit else '-':>11s}")
            lines.append(f"| {label + ' · ' + enc:30s} |" + "|".join(f" {c} " for c in cells) + "|")
    return "\n".join(lines)


def render_winner_per_size(results: list[CellResult], sizes: list[int]) -> str:
    lines: list[str] = []
    lines.append("\n## Best encoding per (path, size)\n")
    header = f"| {'path':25s} |" + "|".join(f" {s:>9d} tok " for s in sizes) + "|"
    sep = "|" + "-" * 27 + "|" + "|".join("-----------:" for _ in sizes) + "|"
    lines.append(header)
    lines.append(sep)
    for label, fmt in PATHS:
        cells = []
        for size in sizes:
            row = [r for r in results if r.size == size and r.path_label == label and r.wire_bytes is not None]
            if not row:
                cells.append("-")
                continue
            winner = min(row, key=lambda r: r.wire_bytes or 1 << 60)
            cells.append(f"{winner.encoding} ({fmt_bytes(winner.wire_bytes)})")
        lines.append(f"| {label:25s} |" + "|".join(f" {c:>13s} " for c in cells) + "|")
    return "\n".join(lines)


def derive_rule(results: list[CellResult], path_label: str, sizes: list[int]) -> dict[str, object]:
    """For one path, find the size at which each encoding starts winning, and
    the size at which each encoding stops being competitive (>20% over winner)."""
    out: dict[str, object] = {"path": path_label, "wins": {}, "losses": {}}
    for size in sizes:
        row = [r for r in results if r.size == size and r.path_label == path_label and r.wire_bytes is not None]
        if not row:
            continue
        winner = min(row, key=lambda r: r.wire_bytes or 1 << 60)
        winners = out["wins"]
        assert isinstance(winners, dict)
        winners.setdefault(winner.encoding, []).append(size)
        for r in row:
            if r.wire_bytes and winner.wire_bytes and r.wire_bytes > winner.wire_bytes * 1.2:
                losses = out["losses"]
                assert isinstance(losses, dict)
                losses.setdefault(r.encoding, []).append(size)
    return out


def render_recommendation(results: list[CellResult], sizes: list[int]) -> str:
    lines: list[str] = []
    lines.append("\n## Recommendation thresholds\n")
    lines.append("For each Codec wire format, here's where each compression starts being")
    lines.append("competitive (within 20% of the size-winner) and where it falls out:\n")
    for label, fmt in PATHS:
        if fmt == "json":
            continue
        rule = derive_rule(results, label, sizes)
        wins = rule["wins"]
        losses = rule["losses"]
        assert isinstance(wins, dict)
        assert isinstance(losses, dict)
        lines.append(f"### {label}")
        for enc in ENCODINGS:
            w = wins.get(enc, [])
            l = losses.get(enc, [])
            if w:
                lines.append(f"- **{enc}**: wins at sizes {w}")
            elif l:
                lines.append(f"- {enc}: never wins; >20% over best at sizes {l}")
            else:
                lines.append(f"- {enc}: never wins, always within 20% of best")
        lines.append("")
    return "\n".join(lines)


async def main_async(args: argparse.Namespace) -> None:
    prompt = LONG_PROMPT if args.prompt_long else SHORT_PROMPT
    sizes: list[int] = args.sizes
    results: list[CellResult] = []
    async with httpx.AsyncClient() as client:
        for size in sizes:
            print(f"\n>>> size={size}", file=sys.stderr)
            results.extend(
                await run_grid_at_size(client, args.url, args.model, prompt, size, args.reps)
            )

    print(f"# Codec encoding crossover study\n")
    print(f"Server: {args.url}")
    print(f"Model:  {args.model}")
    print(f"Prompt: {'long-form essay' if args.prompt_long else 'short prompt'}")
    print(f"Sizes:  {sizes}")
    print(f"Reps per cell: {args.reps}\n")
    print(render_wire_table(results, sizes))
    print(render_winner_per_size(results, sizes))
    print(render_recommendation(results, sizes))


def main() -> None:
    ap = argparse.ArgumentParser(prog="codec-bench-crossover")
    ap.add_argument("--url", default="http://192.168.1.88:30000")
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument(
        "--sizes",
        type=int,
        nargs="+",
        default=[16, 32, 64, 128, 256, 512, 1024, 2048],
        help="max_tokens values to sweep",
    )
    ap.add_argument("--prompt-long", action="store_true",
                    help="use a long-form prompt (forces large outputs)")
    ap.add_argument("--reps", type=int, default=1,
                    help="repetitions per cell (median of N)")
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
