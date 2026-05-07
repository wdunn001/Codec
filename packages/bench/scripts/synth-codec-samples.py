#!/usr/bin/env python3
"""
synth-codec-samples.py — deterministic offline corpus generator for zstd
dictionary training. Produces .bin files in the same shape as
capture-codec-samples.py but without needing a live server.

The synthetic corpus is built by:
  1. Reading token IDs from packages/bench/golden/qwen2.json (a snapshot of
     real Qwen2.5 tokenizer outputs over a curated text corpus).
  2. Sampling ID sequences that mimic real generation: 1 token per frame for
     most frames (matches sglang's per-token streaming), with occasional
     2- and 3-token bursts (mimics speculative decoding / batched flushes),
     plus a few large prefill-style chunks at the start of some streams.
  3. Encoding each chunk into a CodecFrame in msgpack and protobuf and
     concatenating the frames the way the wire shows them.

The dictionary trained from this corpus will be weaker than one trained from
live captures (it doesn't see the model's true output distribution — only
a permutation over a tokenizer test corpus). But it's reproducible, has no
GPU/server dependency, and proves the pipeline end-to-end.

The shipped artifacts of this run are named with `-synthetic-` so they're
distinguishable from live-trained dicts. Both can be measured side-by-side
in RESULTS.md §1g.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

import msgpack


# ─── Encoders (Python ports of packages/bench/src/lib/encoders.ts) ───────────


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n == 0:
            out.append(b)
            return bytes(out)
        out.append(b | 0x80)


def encode_protobuf_frame(ids: list[int], done: bool, finish_reason: str | None) -> bytes:
    """Mirror packages/bench/src/lib/encoders.ts encodeProtobuf. Returns the
    full wire-form frame: 4-byte BE length prefix + protobuf payload."""
    parts = bytearray()
    if ids:
        packed = bytearray()
        for tok in ids:
            packed.extend(_varint(tok))
        parts.append(0x0A)             # field 1 (ids), wt=2
        parts.extend(_varint(len(packed)))
        parts.extend(packed)
    parts.append(0x10)                 # field 2 (done), wt=0
    parts.append(1 if done else 0)
    if finish_reason:
        enc = finish_reason.encode("utf-8")
        parts.append(0x1A)             # field 3 (finish_reason), wt=2
        parts.extend(_varint(len(enc)))
        parts.extend(enc)
    out = bytearray(struct.pack(">I", len(parts)))
    out.extend(parts)
    return bytes(out)


def encode_msgpack_frame(ids: list[int], done: bool, finish_reason: str | None) -> bytes:
    """Mirror packages/bench/src/lib/encoders.ts encodeMsgpack."""
    obj: dict[str, object] = {"ids": ids, "done": done}
    if finish_reason:
        obj["finish_reason"] = finish_reason
    return msgpack.packb(obj, use_bin_type=True)


# ─── Streaming shape ─────────────────────────────────────────────────────────


def _chunk_burst_size(rng: random.Random) -> int:
    """How many tokens to emit in this frame. Matches the empirical sglang
    distribution: mostly 1, occasionally 2-3 for speculative decoding."""
    r = rng.random()
    if r < 0.85:
        return 1
    if r < 0.97:
        return 2
    return 3


@dataclass
class StreamShape:
    n_tokens: int
    has_prefill: bool


def _pick_shape(rng: random.Random) -> StreamShape:
    """Match the (max_tokens, has_prefill) mix that capture-codec-samples uses
    so the synthetic dict has comparable provenance."""
    r = rng.random()
    if r < 0.20:
        n = rng.choice([16, 32, 48, 64])
    elif r < 0.65:
        n = rng.choice([128, 192, 256, 384, 512])
    elif r < 0.90:
        n = rng.choice([768, 1024, 1536])
    else:
        n = rng.choice([2048, 3072])
    # 30% of streams open with a small prefill burst, mimicking speculative
    # decoding's first-flush pattern.
    return StreamShape(n_tokens=n, has_prefill=rng.random() < 0.30)


# ─── Token-ID source ─────────────────────────────────────────────────────────


def load_token_pool(golden_path: Path) -> list[int]:
    """Read the golden tokenizer file and return a flat list of all observed
    token IDs (with repetition). This pool is sampled to build streams. Real
    distribution > random uint32s — the dict learns the model's actual
    high-frequency tokens."""
    data = json.loads(golden_path.read_text(encoding="utf-8"))
    pool: list[int] = []
    for s in data.get("samples", []):
        ids = s.get("ids", [])
        pool.extend(int(x) for x in ids)
    if not pool:
        raise SystemExit(f"no IDs found in {golden_path}")
    return pool


def sample_stream(rng: random.Random, pool: list[int], shape: StreamShape) -> list[list[int]]:
    """Build a list of frames (each frame is a list of IDs) totaling
    shape.n_tokens IDs, with optional prefill chunk at the start."""
    frames: list[list[int]] = []
    emitted = 0

    if shape.has_prefill:
        prefill = min(rng.randint(8, 32), shape.n_tokens)
        frames.append([rng.choice(pool) for _ in range(prefill)])
        emitted += prefill

    while emitted < shape.n_tokens:
        burst = min(_chunk_burst_size(rng), shape.n_tokens - emitted)
        frames.append([rng.choice(pool) for _ in range(burst)])
        emitted += burst

    return frames


# ─── Driver ──────────────────────────────────────────────────────────────────


def emit_stream(frames: list[list[int]], fmt: str) -> bytes:
    """Concatenate per-frame bytes into the wire-form stream for the format."""
    encoder = encode_msgpack_frame if fmt == "msgpack" else encode_protobuf_frame
    out = bytearray()
    last = len(frames) - 1
    for i, ids in enumerate(frames):
        is_done = i == last
        finish = "stop" if is_done else None
        out.extend(encoder(ids, is_done, finish))
    return bytes(out)


def main() -> int:
    ap = argparse.ArgumentParser(prog="synth-codec-samples")
    ap.add_argument(
        "--golden",
        default=str(Path(__file__).resolve().parents[1] / "golden" / "qwen2.json"),
        help="path to a golden tokenizer file (provides the token-ID pool)",
    )
    ap.add_argument(
        "--out",
        default="./corpora/qwen2.5-synth",
        help="output directory (default: %(default)s)",
    )
    ap.add_argument("--n-samples", type=int, default=256,
                    help="samples per format (default: %(default)s)")
    ap.add_argument("--formats", nargs="+", default=["msgpack", "protobuf"],
                    choices=["msgpack", "protobuf"])
    ap.add_argument("--seed", type=int, default=0xC0DEC,
                    help="RNG seed (default: 0xC0DEC, deterministic)")
    args = ap.parse_args()

    golden_path = Path(args.golden)
    pool = load_token_pool(golden_path)
    print(f"▶ loaded {len(pool)} token IDs from {golden_path}", file=sys.stderr)

    rng = random.Random(args.seed)
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    for fmt in args.formats:
        fmt_dir = out_root / fmt
        fmt_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = fmt_dir / "manifest.jsonl"
        with manifest_path.open("w", encoding="utf-8") as mf:
            for i in range(args.n_samples):
                shape = _pick_shape(rng)
                frames = sample_stream(rng, pool, shape)
                wire = emit_stream(frames, fmt)
                n_tokens = sum(len(f) for f in frames)
                sha8 = hashlib.sha256(wire).hexdigest()[:8]
                fname = f"{sha8}-{n_tokens}tok.bin"
                (fmt_dir / fname).write_bytes(wire)
                mf.write(json.dumps({
                    "format": fmt,
                    "max_tokens": shape.n_tokens,
                    "has_prefill": shape.has_prefill,
                    "wire_bytes": len(wire),
                    "n_tokens": n_tokens,
                    "n_frames": len(frames),
                    "file": fname,
                    "sha8": sha8,
                    "source": "synthetic",
                    "golden": str(golden_path.name),
                }) + "\n")
        print(f"    {fmt}: {args.n_samples} samples → {fmt_dir}", file=sys.stderr)

    print(f"\n✓ done. synthetic corpus at {out_root}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
