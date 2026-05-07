"""matrix_run — runs the standard 3 paths × 4 encodings × N sizes grid
against an engine and emits a SCHEMA-v1 result JSON.

This is the *only* python bench runner that should be used for the
cross-stack matrix. It MUST consume a methodology JSON written by
packages/bench/scripts/capture_methodology.py — it never invents
methodology fields. The runner only fills in the `client` and
`bench_tool` blocks before emitting.

Usage:
    python -m codec_demo.matrix_run \\
        --methodology packages/bench/methodology/{run_id}/{engine}.json \\
        --sizes 64 512 2048 \\
        --reps 2 \\
        --out packages/bench/results/{run_id}/{engine}/python.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from . import PATHS, ENCODINGS, Cell, run_one


REPO_ROOT = Path(__file__).resolve().parents[4]


def sh(cmd: list[str], cwd: Path | None = None) -> str:
    try:
        r = subprocess.run(cmd, cwd=cwd or REPO_ROOT, capture_output=True,
                           text=True, timeout=15, check=False)
        return (r.stdout or "").strip()
    except Exception:
        return ""


def client_block() -> dict[str, Any]:
    """Build the `client` block for the methodology output. Captures the
    Python runtime + pinned versions of the libs the bench actually uses."""
    runtime_parts = [f"CPython {sys.version.split()[0]}"]
    try:
        import httpx as _httpx
        runtime_parts.append(f"httpx {_httpx.__version__}")
    except Exception:
        pass
    try:
        import msgpack as _msgpack
        runtime_parts.append(f"msgpack {_msgpack.version[0]}.{_msgpack.version[1]}.{_msgpack.version[2]}")
    except Exception:
        pass
    try:
        import codecai as _codecai
        codec_ver = getattr(_codecai, "__version__", "0.1.0")
    except Exception:
        codec_ver = "0.1.0"

    return {
        "lang": "python",
        "lib_name": "codecai",
        "lib_version": codec_ver,
        "lib_commit": sh(["git", "rev-parse", "HEAD"]),
        "runtime": " / ".join(runtime_parts),
    }


def bench_tool_block(reps: int) -> dict[str, Any]:
    return {
        "name": "demo-python/codec-demo.matrix_run",
        "version": "0.1.0",
        "commit": sh(["git", "rev-parse", "HEAD"]),
        "reps": reps,
        "warmup_reps": 0,
        "aggregation": "median",
        "ttft_definition":
            "wall-clock from request POST to first received byte (httpx aiter_raw, before decompression)",
        "wire_bytes_definition":
            "raw socket bytes received before any Content-Encoding decompression",
        "total_ms_definition":
            "wall-clock from request POST to last byte (after server emits final frame)",
    }


def load_prompts(methodology: dict[str, Any]) -> dict[str, str]:
    prompts_rel = methodology["workload"]["prompts_file"]
    prompts_path = REPO_ROOT / "packages" / "bench" / prompts_rel
    j = json.loads(prompts_path.read_text())
    return j["prompts"]


async def run_size(
    client: httpx.AsyncClient,
    url: str,
    model: str,
    prompt: str,
    size: int,
    reps: int,
) -> list[dict[str, Any]]:
    """Run the 3×4 grid at one size, return SCHEMA-v1 row dicts."""
    rows: list[dict[str, Any]] = []
    for label, fmt in PATHS:
        for enc in ENCODINGS:
            rep_wire: list[int] = []
            rep_ttft: list[float] = []
            rep_total: list[float] = []
            tokens = 0
            error: str | None = None
            for _ in range(reps):
                cell = Cell(path_label=label, format=fmt, encoding=enc)
                await run_one(client, url, model, prompt, size, cell)
                if cell.status == "done" and cell.wire_bytes is not None:
                    rep_wire.append(cell.wire_bytes)
                    if cell.ttfb_ms is not None: rep_ttft.append(cell.ttfb_ms)
                    if cell.total_ms is not None: rep_total.append(cell.total_ms)
                    tokens = max(tokens, cell.tokens)
                else:
                    error = cell.error
            row: dict[str, Any] = {
                "size": size,
                "format": fmt,
                "encoding": enc,
                "wire_bytes": int(statistics.median(rep_wire)) if rep_wire else None,
                "ttft_ms": float(statistics.median(rep_ttft)) if rep_ttft else None,
                "total_ms": float(statistics.median(rep_total)) if rep_total else None,
                "tokens_emitted": tokens,
                "rep_wire_bytes": rep_wire,
                "rep_ttft_ms": rep_ttft,
                "rep_total_ms": rep_total,
                "error": error,
            }
            rows.append(row)
            print(
                f"    {label:25s} {enc:8s} size={size:5d}  wire={row['wire_bytes']}  ttft={row['ttft_ms']}  total={row['total_ms']}  tokens={tokens}",
                file=sys.stderr,
            )
    return rows


async def main_async(args: argparse.Namespace) -> None:
    methodology_path = Path(args.methodology)
    if not methodology_path.exists():
        sys.exit(f"methodology file not found: {methodology_path}")
    methodology = json.loads(methodology_path.read_text())

    # Fill in our own blocks. NEVER touch other methodology fields.
    methodology["client"] = client_block()
    methodology["bench_tool"] = bench_tool_block(args.reps)

    prompts = load_prompts(methodology)
    endpoint = methodology["engine"]["endpoint"]
    model = methodology["model"]["id"]

    rows: list[dict[str, Any]] = []
    async with httpx.AsyncClient() as cli:
        for size in args.sizes:
            prompt = prompts.get(str(size))
            if prompt is None:
                sys.exit(f"no canonical prompt defined for size={size} in {methodology['workload']['prompts_file']}")
            print(f">>> size={size}  prompt: {prompt[:60]!r}{'...' if len(prompt) > 60 else ''}",
                  file=sys.stderr)
            rows.extend(await run_size(cli, endpoint, model, prompt, size, args.reps))

    out = {
        "schema_version": "1",
        "methodology": methodology,
        "rows": rows,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2))
    print(f"\nwrote {out_path} ({len(rows)} rows)", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(prog="codec-bench-matrix")
    ap.add_argument("--methodology", required=True,
                    help="methodology JSON written by capture_methodology.py")
    ap.add_argument("--sizes", type=int, nargs="+", default=[64, 512, 2048])
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--out", required=True,
                    help="path to write the unified result JSON")
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
