"""Per-language tokenize/detokenize micro-benchmark.

Stand-alone companion to `matrix_run.py`: that driver measures wire-byte
/ TTFT / total-ms across the 3×4 size × {fmt, encoding} grid; this driver
times client-side BPE encode + detokenize on a fixed corpus so reviewers
can compare per-language tokenizer-library throughput.

Usage:
    python -m codec_demo.token_bench \\
        --map ../../codec-maps/maps/qwen/qwen2.json \\
        --corpus ../bench/golden/qwen2.json \\
        --reps 200 \\
        --out ../bench/results/<run-id>/token/python.json

Output schema (see also `packages/bench/methodology/SCHEMA.md`):

    {
      "schema_version": "1",
      "kind": "token_bench",
      "captured_at": "<ISO-8601>",
      "client": { "lang": "python", "lib_name": "codecai",
                  "lib_version": "...", "runtime": "..." },
      "map": { "id": "qwen/qwen2", "vocab_size": 151665 },
      "corpus": { "path": "...", "sha256": "...", "samples": 35,
                  "total_text_bytes": 1234,
                  "total_tokens": 567 },
      "reps": 200,
      "encode_ms_total_median": 12.34,
      "encode_ms_total_p99": 14.56,
      "decode_ms_total_median": 8.91,
      "decode_ms_total_p99": 10.23,
      "encode_tokens_per_sec": 9876543.0,
      "decode_tokens_per_sec": 1234567.0
    }

Each `*_total` value is the time to encode/decode the WHOLE corpus once
: i.e. one full pass over all samples in `corpus.json`. We run `reps`
passes and report median + p99 of total-time.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import statistics
import sys
import time
from datetime import datetime, timezone
from importlib import metadata as _meta
from pathlib import Path
from typing import Any

from codecai import BPETokenizer, Detokenizer, TokenizerMap


def percentile(values: list[float], pct: float) -> float:
    """Closest-rank percentile (no interpolation). Cheap + reviewer-friendly."""
    if not values:
        return 0.0
    s = sorted(values)
    idx = max(0, min(len(s) - 1, int(round(pct / 100 * (len(s) - 1)))))
    return s[idx]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--map", required=True, help="codec-maps tokenizer map JSON")
    parser.add_argument(
        "--corpus", required=True,
        help="golden corpus JSON with {samples: [{text, ids}]}",
    )
    parser.add_argument("--reps", type=int, default=200)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    map_path = Path(args.map)
    map_bytes = map_path.read_bytes()
    m = TokenizerMap.from_json(map_bytes)

    corpus_path = Path(args.corpus)
    corpus_bytes = corpus_path.read_bytes()
    corpus = json.loads(corpus_bytes.decode("utf-8"))
    samples: list[dict[str, Any]] = corpus["samples"]
    if not samples:
        print(f"corpus {args.corpus!r} has no samples", file=sys.stderr)
        return 1

    tok = BPETokenizer(m)
    detok = Detokenizer(m)

    # Pull texts + reference ids once; we re-render detok per rep but the
    # corpus arrays don't change.
    texts: list[str] = [s["text"] for s in samples]
    ref_ids: list[list[int]] = [list(s["ids"]) for s in samples]
    total_text_bytes = sum(len(t.encode("utf-8")) for t in texts)
    total_tokens = sum(len(ids) for ids in ref_ids)

    # Warmup: get JIT / cache effects out of the median.
    for _ in range(args.warmup):
        for t in texts:
            tok.encode(t)
        for ids in ref_ids:
            detok.render(ids)

    encode_ms: list[float] = []
    decode_ms: list[float] = []
    for _ in range(args.reps):
        t0 = time.perf_counter()
        for t in texts:
            tok.encode(t)
        encode_ms.append((time.perf_counter() - t0) * 1000)

        t0 = time.perf_counter()
        for ids in ref_ids:
            detok.render(ids)
        decode_ms.append((time.perf_counter() - t0) * 1000)

    encode_med = statistics.median(encode_ms)
    decode_med = statistics.median(decode_ms)

    result = {
        "schema_version": "1",
        "kind": "token_bench",
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "client": {
            "lang": "python",
            "lib_name": "codecai",
            "lib_version": _safe_version("codecai"),
            "runtime": f"CPython {platform.python_version()}",
        },
        "map": {
            "id": m.id,
            "vocab_size": m.vocab_size,
            "sha256": "sha256:" + hashlib.sha256(map_bytes).hexdigest(),
        },
        "corpus": {
            "path": str(corpus_path),
            "sha256": "sha256:" + hashlib.sha256(corpus_bytes).hexdigest(),
            "samples": len(samples),
            "total_text_bytes": total_text_bytes,
            "total_tokens": total_tokens,
        },
        "reps": args.reps,
        "warmup_reps": args.warmup,
        "encode_ms_total_median": encode_med,
        "encode_ms_total_p99": percentile(encode_ms, 99),
        "decode_ms_total_median": decode_med,
        "decode_ms_total_p99": percentile(decode_ms, 99),
        "encode_tokens_per_sec": (total_tokens / encode_med * 1000) if encode_med > 0 else None,
        "decode_tokens_per_sec": (total_tokens / decode_med * 1000) if decode_med > 0 else None,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2))

    print(
        f"  python  encode={encode_med:6.2f} ms ({result['encode_tokens_per_sec']:,.0f} tok/s)"
        f"  decode={decode_med:6.2f} ms ({result['decode_tokens_per_sec']:,.0f} tok/s)"
        f"  → {out_path}",
        file=sys.stderr,
    )
    return 0


def _safe_version(pkg: str) -> str:
    try:
        return _meta.version(pkg)
    except _meta.PackageNotFoundError:
        return "unknown"


if __name__ == "__main__":
    raise SystemExit(main())
