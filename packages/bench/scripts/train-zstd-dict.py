#!/usr/bin/env python3
"""
train-zstd-dict.py — train pre-shared zstd dictionaries from a captured (or
synthetic) corpus of CodecFrame streams.

Reads `corpora/<model>/<format>/*.bin`, runs `zstandard.train_dictionary()`
across a sweep of dict sizes (4 KB / 16 KB / 64 KB), evaluates each candidate
on a held-out 20% slice of the corpus, and emits the winner per (model,
format) into `dictionaries/`. Writes (or merges into) `dictionaries/manifest.json`.

Usage:
    python train-zstd-dict.py \\
        --corpus ../corpora/qwen2.5 \\
        --out ../../../dictionaries \\
        --model "Qwen/Qwen2.5-0.5B-Instruct" \\
        --tag qwen2.5

This is the only stage that REQUIRES `pip install zstandard`. The other
scripts (capture, synth) only need `httpx` and `msgpack`.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import random
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    import zstandard as zstd
except ImportError:
    sys.stderr.write(
        "error: the `zstandard` package is required.\n"
        "       run: pip install zstandard\n"
    )
    sys.exit(1)


DEFAULT_DICT_SIZES = [4 * 1024, 16 * 1024, 64 * 1024]
COMPRESSION_LEVEL_FOR_EVAL = 3   # zstd's default level — what middleware will use
HOLDOUT_FRACTION = 0.20
HOLDOUT_SEED = 0xC0DEC


@dataclass
class TrainResult:
    dict_size: int
    dict_bytes: bytes
    avg_compressed_train: float   # mean compressed length on training set
    avg_compressed_holdout: float # mean compressed length on holdout set
    holdout_baseline: float       # mean compressed length on holdout WITHOUT dict
    gain_pct: float               # 1 - dict/baseline, as %


def split_train_holdout(samples: list[bytes]) -> tuple[list[bytes], list[bytes]]:
    rng = random.Random(HOLDOUT_SEED)
    idx = list(range(len(samples)))
    rng.shuffle(idx)
    holdout_n = max(1, int(len(samples) * HOLDOUT_FRACTION))
    holdout_idx = set(idx[:holdout_n])
    train = [s for i, s in enumerate(samples) if i not in holdout_idx]
    holdout = [s for i, s in enumerate(samples) if i in holdout_idx]
    return train, holdout


def measure_avg_compressed(samples: list[bytes], cctx: zstd.ZstdCompressor) -> float:
    if not samples:
        return 0.0
    sizes = [len(cctx.compress(s)) for s in samples]
    return statistics.mean(sizes)


def train_one_size(
    train_samples: list[bytes],
    holdout_samples: list[bytes],
    dict_size: int,
) -> TrainResult:
    if not train_samples:
        raise SystemExit("training corpus is empty")
    print(f"    training dict_size={dict_size}B on {len(train_samples)} samples...",
          file=sys.stderr)
    dict_data = zstd.train_dictionary(
        dict_size,
        train_samples,
        level=COMPRESSION_LEVEL_FOR_EVAL,
        notifications=2,
    )
    cctx_dict = zstd.ZstdCompressor(level=COMPRESSION_LEVEL_FOR_EVAL, dict_data=dict_data)
    cctx_nodict = zstd.ZstdCompressor(level=COMPRESSION_LEVEL_FOR_EVAL)

    avg_train = measure_avg_compressed(train_samples, cctx_dict)
    avg_holdout_dict = measure_avg_compressed(holdout_samples, cctx_dict)
    avg_holdout_base = measure_avg_compressed(holdout_samples, cctx_nodict)

    if avg_holdout_base > 0:
        gain = 1.0 - (avg_holdout_dict / avg_holdout_base)
    else:
        gain = 0.0
    return TrainResult(
        dict_size=dict_size,
        dict_bytes=dict_data.as_bytes(),
        avg_compressed_train=avg_train,
        avg_compressed_holdout=avg_holdout_dict,
        holdout_baseline=avg_holdout_base,
        gain_pct=gain * 100,
    )


def pick_winner(results: list[TrainResult]) -> TrainResult:
    """Pick the smallest dict size that's within 10% of the best gain. We
    prefer small dicts because they're cheaper to ship and load."""
    if not results:
        raise SystemExit("no candidates trained")
    best_gain = max(r.gain_pct for r in results)
    threshold = best_gain - 1.0  # within 1 percentage point
    eligible = [r for r in results if r.gain_pct >= threshold]
    eligible.sort(key=lambda r: r.dict_size)
    return eligible[0]


def load_corpus(corpus_dir: Path) -> tuple[list[bytes], list[Path]]:
    files = sorted(p for p in corpus_dir.glob("*.bin"))
    if not files:
        raise SystemExit(f"no .bin samples in {corpus_dir}")
    return [p.read_bytes() for p in files], files


def write_dict(out_path: Path, dict_bytes: bytes) -> str:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(dict_bytes)
    return "sha256:" + hashlib.sha256(dict_bytes).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(prog="train-zstd-dict")
    ap.add_argument("--corpus", required=True,
                    help="path to corpus root (contains <format>/*.bin subdirs)")
    ap.add_argument("--out", required=True,
                    help="path to dictionaries/ output directory")
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct",
                    help="model id stored in the dictionary manifest")
    ap.add_argument("--tag", default="qwen2.5",
                    help="short tag used in the .dict filename "
                         "(<tag>-<format>-v1.dict)")
    ap.add_argument("--version", default="v1",
                    help="version suffix in filename / manifest key")
    ap.add_argument("--formats", nargs="+", default=["msgpack", "protobuf"],
                    choices=["msgpack", "protobuf"])
    ap.add_argument("--dict-sizes", type=int, nargs="+", default=DEFAULT_DICT_SIZES,
                    help=f"dict sizes (bytes) to sweep (default: {DEFAULT_DICT_SIZES})")
    ap.add_argument("--source-tag", default=None,
                    help="annotation for manifest (e.g. 'live-sglang' or 'synthetic'). "
                         "if omitted, inferred from the corpus dir name.")
    args = ap.parse_args()

    corpus_root = Path(args.corpus).resolve()
    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    source_tag = args.source_tag or (
        "synthetic" if "synth" in corpus_root.name.lower() else "live-sglang"
    )

    manifest_path = out_root / "manifest.json"
    if manifest_path.exists():
        manifest: dict[str, object] = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = {"version": 1, "dictionaries": {}}

    dictionaries = manifest.setdefault("dictionaries", {})
    assert isinstance(dictionaries, dict)

    print(f"▶ training zstd dicts", file=sys.stderr)
    print(f"  corpus root: {corpus_root}", file=sys.stderr)
    print(f"  out:         {out_root}", file=sys.stderr)
    print(f"  model:       {args.model}", file=sys.stderr)
    print(f"  tag:         {args.tag}", file=sys.stderr)
    print(f"  source tag:  {source_tag}", file=sys.stderr)

    for fmt in args.formats:
        fmt_dir = corpus_root / fmt
        if not fmt_dir.exists():
            print(f"  ⚠ skipping {fmt}: no {fmt_dir}", file=sys.stderr)
            continue
        samples, files = load_corpus(fmt_dir)
        print(f"\n  --- {fmt}: {len(samples)} samples (median {statistics.median(len(s) for s in samples):.0f}B)",
              file=sys.stderr)
        train, holdout = split_train_holdout(samples)
        print(f"      train={len(train)}  holdout={len(holdout)}", file=sys.stderr)

        results: list[TrainResult] = []
        for ds in args.dict_sizes:
            try:
                r = train_one_size(train, holdout, ds)
            except zstd.ZstdError as e:
                print(f"      dict_size={ds}: FAILED ({e})", file=sys.stderr)
                continue
            print(
                f"      dict_size={ds}: holdout {r.holdout_baseline:.0f}B → "
                f"{r.avg_compressed_holdout:.0f}B  (gain {r.gain_pct:+.1f}%)",
                file=sys.stderr,
            )
            results.append(r)

        if not results:
            continue
        winner = pick_winner(results)
        out_name = f"{args.tag}-{fmt}-{args.version}.dict"
        out_file = out_root / out_name
        sha = write_dict(out_file, winner.dict_bytes)

        median_bytes = int(statistics.median(len(s) for s in samples))
        manifest_key = f"{args.tag}-{fmt}-{args.version}"
        dictionaries[manifest_key] = {
            "model": args.model,
            "codec_format": fmt,
            "dict_size_bytes": winner.dict_size,
            "file": out_name,
            "sha256": sha,
            "trained_at": datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "corpus": {
                "n_samples": len(samples),
                "median_bytes": median_bytes,
                "source": source_tag,
                "corpus_dir": str(corpus_root.relative_to(corpus_root.parent.parent)
                                  if corpus_root.parent.parent in corpus_root.parents
                                  else corpus_root),
            },
            "holdout": {
                "n_samples": len(holdout),
                "baseline_avg_bytes": round(winner.holdout_baseline, 1),
                "with_dict_avg_bytes": round(winner.avg_compressed_holdout, 1),
                "gain_pct": round(winner.gain_pct, 2),
            },
            "training_level": COMPRESSION_LEVEL_FOR_EVAL,
        }
        print(f"      ✓ chose dict_size={winner.dict_size}, gain={winner.gain_pct:+.1f}% on holdout",
              file=sys.stderr)
        print(f"      ✓ wrote {out_file} ({len(winner.dict_bytes)}B, {sha})", file=sys.stderr)

    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"\n✓ manifest at {manifest_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
