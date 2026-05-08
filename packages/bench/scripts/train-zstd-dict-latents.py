#!/usr/bin/env python3
"""
train-zstd-dict-latents.py — train pre-shared zstd dictionaries from a
captured corpus of Codec LATENT streams (Codec v0.3+).

Sibling of train-zstd-dict.py for the latent modality. Two key
differences from the text-side trainer:

1. **Three-axis keying.** Latent dicts are keyed on
   (latent_space_id, format, pipeline) instead of (model, format).
   A dict trained for `(sd-vae-ft-mse, msgpack, int8)` is meaningless
   against `(sd-vae-ft-mse, msgpack, raw)` — the byte distributions
   are different distributions. Servers MUST NOT cross-apply.

2. **Pipeline-driven byte distribution.** Raw VAE latents are
   near-Gaussian by training, so a dict on raw bytes wins ~5-15% over
   no-dict zstd. The dict pays off only after a structural pre-pass:
   per-channel int8/int4 quantization concentrates bytes into a small
   alphabet, and (for video) delta-coding collapses temporally
   redundant values into mostly-zero residuals. So `--pipelines int8
   delta+int8` is where the meaningful dict gains live; training
   `--pipelines raw` is mostly for completeness / comparison.

Reads `corpora/<latent-space>-synth/<format>/<pipeline>/*.bin` produced
by capture-latent-samples.py, runs zstandard.train_dictionary() across a
sweep of dict sizes (4 KB / 16 KB / 64 KB), evaluates each candidate
on a held-out 20% slice of the corpus, and emits the winner per
(latent-space, format, pipeline) into:

    dictionaries/latents/<latent-space-slug>-<format>-<pipeline>-v1.dict

Plus an entry in `dictionaries/latents/manifest.json`.

Usage:

    python train-zstd-dict-latents.py \\
        --corpus ../corpora/sd-vae-ft-mse-synth \\
        --out ../../../dictionaries/latents \\
        --latent-space stabilityai/sd-vae-ft-mse \\
        --tag sd-vae-ft-mse \\
        --formats msgpack protobuf \\
        --pipelines int8 int4 delta+int8

The text-side trainer's holdout-vs-baseline reporting is kept verbatim —
we want to see whether dict gain over no-dict zstd is positive at all
on these byte streams, since "trained dict on raw latents underperforms"
is itself a finding worth recording.
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
from typing import List

try:
    import zstandard as zstd
except ImportError:
    sys.stderr.write(
        "error: the `zstandard` package is required.\n"
        "       run: pip install zstandard\n"
    )
    sys.exit(1)


DEFAULT_DICT_SIZES = [4 * 1024, 16 * 1024, 64 * 1024]
COMPRESSION_LEVEL_FOR_EVAL = 3
HOLDOUT_FRACTION = 0.20
HOLDOUT_SEED = 0xC0DEC

# Same registry as spec/PIPELINES.md, gated here so a typo on the CLI
# fails fast.
PIPELINE_NAMES = (
    "raw", "int8", "int4",
    "int8-adaptive", "int4-adaptive",
    "delta+int8", "delta+int4",
)


@dataclass
class TrainResult:
    dict_size: int
    dict_bytes: bytes
    avg_compressed_train: float
    avg_compressed_holdout: float
    holdout_baseline: float
    gain_pct: float


def split_train_holdout(samples: List[bytes]) -> tuple[List[bytes], List[bytes]]:
    rng = random.Random(HOLDOUT_SEED)
    idx = list(range(len(samples)))
    rng.shuffle(idx)
    holdout_n = max(1, int(len(samples) * HOLDOUT_FRACTION))
    holdout_idx = set(idx[:holdout_n])
    train = [s for i, s in enumerate(samples) if i not in holdout_idx]
    holdout = [s for i, s in enumerate(samples) if i in holdout_idx]
    return train, holdout


def measure_avg_compressed(samples: List[bytes], cctx: zstd.ZstdCompressor) -> float:
    if not samples:
        return 0.0
    sizes = [len(cctx.compress(s)) for s in samples]
    return statistics.mean(sizes)


def train_one_size(
    train_samples: List[bytes],
    holdout_samples: List[bytes],
    dict_size: int,
) -> TrainResult:
    if not train_samples:
        raise SystemExit("training corpus is empty")
    print(
        f"        training dict_size={dict_size}B on {len(train_samples)} samples...",
        file=sys.stderr,
    )
    dict_data = zstd.train_dictionary(
        dict_size, train_samples,
        level=COMPRESSION_LEVEL_FOR_EVAL, notifications=2,
    )
    cctx_dict = zstd.ZstdCompressor(level=COMPRESSION_LEVEL_FOR_EVAL, dict_data=dict_data)
    cctx_nodict = zstd.ZstdCompressor(level=COMPRESSION_LEVEL_FOR_EVAL)

    avg_train = measure_avg_compressed(train_samples, cctx_dict)
    avg_holdout_dict = measure_avg_compressed(holdout_samples, cctx_dict)
    avg_holdout_base = measure_avg_compressed(holdout_samples, cctx_nodict)

    gain = (1.0 - (avg_holdout_dict / avg_holdout_base)) if avg_holdout_base > 0 else 0.0
    return TrainResult(
        dict_size=dict_size,
        dict_bytes=dict_data.as_bytes(),
        avg_compressed_train=avg_train,
        avg_compressed_holdout=avg_holdout_dict,
        holdout_baseline=avg_holdout_base,
        gain_pct=gain * 100,
    )


def pick_winner(results: List[TrainResult]) -> TrainResult:
    """Pick the smallest dict size whose gain is within 1pp of the best."""
    if not results:
        raise SystemExit("no candidates trained")
    best = max(r.gain_pct for r in results)
    eligible = [r for r in results if r.gain_pct >= best - 1.0]
    eligible.sort(key=lambda r: r.dict_size)
    return eligible[0]


def load_corpus(corpus_dir: Path) -> List[bytes]:
    files = sorted(p for p in corpus_dir.glob("*.bin"))
    if not files:
        raise SystemExit(f"no .bin samples in {corpus_dir}")
    return [p.read_bytes() for p in files]


def slugify_latent_space(latent_space_id: str) -> str:
    """`stabilityai/sd-vae-ft-mse` → `sd-vae-ft-mse`. Same convention as
    text-side `--tag` but auto-derived from the spec ID so the same name
    appears across the trainer, the latent-space-map, and the CDN."""
    if "/" in latent_space_id:
        return latent_space_id.rsplit("/", 1)[-1]
    return latent_space_id


def main() -> int:
    ap = argparse.ArgumentParser(prog="train-zstd-dict-latents")
    ap.add_argument(
        "--corpus", required=True,
        help="path to corpus root (contains <format>/<pipeline>/*.bin subdirs) "
             "produced by capture-latent-samples.py",
    )
    ap.add_argument(
        "--out", required=True,
        help="path to dictionaries/latents/ output directory",
    )
    ap.add_argument(
        "--latent-space", required=True,
        help="latent_space_id from the LatentSpaceMap (e.g. stabilityai/sd-vae-ft-mse)",
    )
    ap.add_argument(
        "--tag", default=None,
        help="short tag for the .dict filename. Defaults to the slug of "
             "--latent-space.",
    )
    ap.add_argument("--version", default="v1",
                    help="version suffix in filename / manifest key")
    ap.add_argument(
        "--formats", nargs="+", default=["msgpack", "protobuf"],
        choices=["msgpack", "protobuf"],
    )
    ap.add_argument(
        "--pipelines", nargs="+",
        default=["int8", "int8-adaptive", "delta+int8"],
        choices=PIPELINE_NAMES,
        help=(
            "pipelines to train dicts for. Default skips `raw` because raw "
            "fp16 latents are near-Gaussian by training — dict gain is "
            "marginal. Train it explicitly with `--pipelines raw int8 ...` "
            "if you want the comparison data."
        ),
    )
    ap.add_argument(
        "--dict-sizes", type=int, nargs="+", default=DEFAULT_DICT_SIZES,
        help=f"dict sizes (bytes) to sweep (default: {DEFAULT_DICT_SIZES})",
    )
    ap.add_argument(
        "--source-tag", default=None,
        help="annotation for manifest (e.g. 'live-comfyui' or 'synthetic'). "
             "If omitted, inferred from the corpus directory name.",
    )
    args = ap.parse_args()

    corpus_root = Path(args.corpus).resolve()
    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    tag = args.tag or slugify_latent_space(args.latent_space)

    source_tag = args.source_tag or (
        "synthetic" if "synth" in corpus_root.name.lower() else "live-engine-fork"
    )

    manifest_path = out_root / "manifest.json"
    if manifest_path.exists():
        manifest: dict = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = {"version": 1, "dictionaries": {}}
    dictionaries = manifest.setdefault("dictionaries", {})

    print(f"▶ training latent zstd dicts", file=sys.stderr)
    print(f"  corpus root:    {corpus_root}", file=sys.stderr)
    print(f"  out:            {out_root}", file=sys.stderr)
    print(f"  latent_space:   {args.latent_space}", file=sys.stderr)
    print(f"  tag:            {tag}", file=sys.stderr)
    print(f"  source tag:     {source_tag}", file=sys.stderr)
    print(f"  formats:        {args.formats}", file=sys.stderr)
    print(f"  pipelines:      {args.pipelines}", file=sys.stderr)

    for fmt in args.formats:
        for pipeline in args.pipelines:
            pipe_dir = corpus_root / fmt / pipeline
            if not pipe_dir.exists():
                print(f"  ⚠ skipping {fmt}/{pipeline}: no {pipe_dir}",
                      file=sys.stderr)
                continue

            samples = load_corpus(pipe_dir)
            median = int(statistics.median(len(s) for s in samples))
            print(
                f"\n  --- {fmt}/{pipeline}: {len(samples)} samples (median {median}B)",
                file=sys.stderr,
            )
            train, holdout = split_train_holdout(samples)
            print(f"        train={len(train)}  holdout={len(holdout)}",
                  file=sys.stderr)

            results: List[TrainResult] = []
            for ds in args.dict_sizes:
                try:
                    r = train_one_size(train, holdout, ds)
                except zstd.ZstdError as e:
                    print(f"        dict_size={ds}: FAILED ({e})",
                          file=sys.stderr)
                    continue
                print(
                    f"        dict_size={ds}: holdout {r.holdout_baseline:.0f}B → "
                    f"{r.avg_compressed_holdout:.0f}B  (gain {r.gain_pct:+.1f}%)",
                    file=sys.stderr,
                )
                results.append(r)
            if not results:
                continue
            winner = pick_winner(results)

            # File naming: <tag>-<format>-<pipeline-slug>-<version>.dict
            # Pipeline names contain '+'; slugify to '-' so the filename is shell-safe.
            pipeline_slug = pipeline.replace("+", "-")
            out_name = f"{tag}-{fmt}-{pipeline_slug}-{args.version}.dict"
            out_file = out_root / out_name
            out_file.parent.mkdir(parents=True, exist_ok=True)
            out_file.write_bytes(winner.dict_bytes)
            sha = "sha256:" + hashlib.sha256(winner.dict_bytes).hexdigest()

            manifest_key = f"{tag}-{fmt}-{pipeline_slug}-{args.version}"
            dictionaries[manifest_key] = {
                "latent_space_id": args.latent_space,
                "codec_format":    fmt,
                "pipeline":        pipeline,
                "dict_size_bytes": winner.dict_size,
                "file":            out_name,
                "sha256":          sha,
                "trained_at":      datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
                "corpus": {
                    "n_samples":    len(samples),
                    "median_bytes": median,
                    "source":       source_tag,
                    "corpus_dir":   str(corpus_root),
                },
                "holdout": {
                    "n_samples":           len(holdout),
                    "baseline_avg_bytes":  round(winner.holdout_baseline, 1),
                    "with_dict_avg_bytes": round(winner.avg_compressed_holdout, 1),
                    "gain_pct":            round(winner.gain_pct, 2),
                },
                "training_level": COMPRESSION_LEVEL_FOR_EVAL,
            }
            print(
                f"        ✓ chose dict_size={winner.dict_size}, gain={winner.gain_pct:+.1f}% on holdout",
                file=sys.stderr,
            )
            print(
                f"        ✓ wrote {out_file} ({len(winner.dict_bytes)}B, {sha})",
                file=sys.stderr,
            )

    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"\n✓ manifest at {manifest_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
