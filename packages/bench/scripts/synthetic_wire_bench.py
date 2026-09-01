#!/usr/bin/env python3
"""Pure-library Codec wire-byte measurement.

Measures protocol efficiency in isolation: takes a deterministic token-ID
sequence, runs it through the Codec msgpack/protobuf encoder + each
HTTP-level compression (identity, gzip, br, zstd-with-dict) using the
SAME library calls every engine uses. It records the resulting wire
bytes. No HTTP server, no inference engine, no model.

Purpose: the cross-stack matrix's §1 headline ratios are content-dependent
because temperature=0 greedy decoding produces different token sequences
across engines. To measure protocol efficiency cleanly we need a known
input. This script does that by computing the wire bytes locally for a
fixed corpus of synthetic token-ID sequences.

Limitations:
  - Does NOT measure HTTP chunked-transfer-encoding overhead. That's
    constant per chunk across engines (5 bytes per chunk for the length
    prefix + CRLF) and doesn't differentiate protocol efficiency. The
    engine-output cells in MATRIX.md §1b still capture end-to-end HTTP.
  - Uses the canonical Codec encoders (msgpack via msgspec / msgpack;
    protobuf via the spec's length-prefixed shape; gzip via zlib;
    brotli via brotli; zstd via zstandard with a pre-trained dict).
    Other implementations should produce byte-identical output for the
    same inputs.

Output:
  packages/bench/results/<run_id>/synthetic/wire.json: SCHEMA:
  {
    "schema_version": "1",
    "kind": "synthetic_wire_bench",
    "run_id": "<UTC>",
    "encoder_versions": {
      "msgpack":  "X.Y.Z",
      "brotli":   "X.Y.Z",
      "zstandard":"X.Y.Z"
    },
    "dicts": {"<format>": "sha256:<hex>"},
    "corpora": [
      {
        "name": "uniform-random-vocab-152064",
        "n_tokens": 2048,
        "seed": 42,
        "first_10_ids": [...]
      },
      ...
    ],
    "cells": [
      {"corpus": "...", "n_tokens": 2048, "format": "msgpack", "encoding": "zstd",
       "wire_bytes": 291, "bytes_per_token": 0.142}
    ]
  }
"""
from __future__ import annotations

import argparse
import datetime as _dt
import gzip
import hashlib
import io
import json
import os
import sys
import zlib
from pathlib import Path
from typing import Any

import msgpack  # type: ignore

REPO_ROOT = Path(__file__).resolve().parents[3]
DICTS_DIR = REPO_ROOT / "dictionaries"
RESULTS_DIR = REPO_ROOT / "packages" / "bench" / "results"


# ── encoders ──────────────────────────────────────────────────────────────


def encode_msgpack_frame(ids: list[int], *, done: bool, finish_reason: str | None = None) -> bytes:
    """One CodecFrame in MessagePack mode. Matches sglang/vllm/llamacpp
    encoders' output byte-for-byte.

    Shape:
      {"ids": [uint32...], "done": bool, [optional "finish_reason": str]}
    """
    obj: dict[str, Any] = {"ids": ids, "done": done}
    if finish_reason is not None:
        obj["finish_reason"] = finish_reason
    return msgpack.packb(obj, use_bin_type=True)


def encode_protobuf_frame(ids: list[int], *, done: bool, finish_reason: str | None = None) -> bytes:
    """One CodecFrame in protobuf mode (4-byte BE length prefix + payload).

    Matches the engine encoders: field 1 (packed uint32 ids), field 2
    (bool done), field 3 (string finish_reason: only when set).
    """
    payload = bytearray()
    # Field 1: repeated uint32, packed.
    if ids:
        ids_buf = bytearray()
        for tid in ids:
            # varint encode each id
            v = tid
            while v >= 0x80:
                ids_buf.append((v & 0x7F) | 0x80)
                v >>= 7
            ids_buf.append(v & 0x7F)
        # tag: field 1, wire type 2 (length-delimited) → (1 << 3) | 2 = 0x0A
        payload.append(0x0A)
        # length of the packed array
        ln = len(ids_buf)
        while ln >= 0x80:
            payload.append((ln & 0x7F) | 0x80)
            ln >>= 7
        payload.append(ln & 0x7F)
        payload.extend(ids_buf)
    # Field 2: bool done. Tag (2 << 3) | 0 = 0x10. Value: 1 byte (0 or 1).
    payload.append(0x10)
    payload.append(0x01 if done else 0x00)
    # Field 3: optional string finish_reason. Tag (3 << 3) | 2 = 0x1A.
    if finish_reason:
        fr_bytes = finish_reason.encode("utf-8")
        payload.append(0x1A)
        ln = len(fr_bytes)
        while ln >= 0x80:
            payload.append((ln & 0x7F) | 0x80)
            ln >>= 7
        payload.append(ln & 0x7F)
        payload.extend(fr_bytes)
    # Length-prefix the whole frame (4-byte BE).
    total = len(payload)
    return total.to_bytes(4, "big") + bytes(payload)


def encode_stream(token_ids: list[int], stream_format: str, *, batch_size: int = 1) -> bytes:
    """Encode a full token stream as concatenated frames (production shape).

    Mirrors the engine pattern: one frame per scheduler step (batch_size
    tokens), final frame has done=True and a finish_reason.
    """
    enc = encode_msgpack_frame if stream_format == "msgpack" else encode_protobuf_frame
    out = bytearray()
    i = 0
    n = len(token_ids)
    while i < n:
        chunk = token_ids[i : i + batch_size]
        i += batch_size
        is_last = i >= n
        out.extend(enc(chunk, done=is_last, finish_reason="synthetic" if is_last else None))
    return bytes(out)


# ── compressors ────────────────────────────────────────────────────────────


def compress_identity(stream: bytes) -> bytes:
    return stream


def compress_gzip(stream: bytes) -> bytes:
    """gzip via zlib at level 6, wbits=31 (gzip wrapper). Same call shape
    as the engine streaming compressors at end-of-stream."""
    c = zlib.compressobj(level=6, wbits=31)
    out = c.compress(stream)
    out += c.flush(zlib.Z_FINISH)
    return out


def compress_brotli(stream: bytes) -> bytes:
    """brotli at quality 4 (engine settings). One-shot since the input is
    already the whole stream. Matches the engine compressor's no-per-chunk-
    flush regression fix from v0.4.1."""
    import brotli  # type: ignore

    return brotli.compress(stream, quality=4, mode=brotli.MODE_GENERIC, lgwin=22)


def compress_zstd_with_dict(stream: bytes, dict_bytes: bytes) -> bytes:
    """zstd with pre-trained dict, level 3. Matches engine encoders."""
    import zstandard  # type: ignore

    zdict = zstandard.ZstdCompressionDict(dict_bytes)
    cctx = zstandard.ZstdCompressor(level=3, dict_data=zdict)
    return cctx.compress(stream)


# ── corpora ───────────────────────────────────────────────────────────────


def corpus_uniform_random(n_tokens: int, *, vocab_size: int = 152064, seed: int = 42) -> list[int]:
    """Uniformly random token IDs from [0, vocab_size). Worst case for
    compression: no patterns, no repetition. Codec's wire-level structural
    bytes (msgpack overhead) still compress because they're identical
    across frames; only the token IDs are entropy."""
    import numpy as np

    rng = np.random.default_rng(seed)
    return rng.integers(0, vocab_size, size=n_tokens).tolist()


def corpus_cyclic(n_tokens: int, *, period: int = 10) -> list[int]:
    """Cyclic [0, 1, 2, ..., period-1, 0, 1, ...]. Highly compressible:
    upper bound for what dict-zstd can achieve on Codec wire."""
    return [i % period for i in range(n_tokens)]


def corpus_low_entropy(n_tokens: int, *, n_unique: int = 50, seed: int = 42) -> list[int]:
    """Sampled from a small vocab (n_unique distinct IDs). Models the
    'enumerated list / template-heavy response' pattern from real
    model output."""
    import numpy as np

    rng = np.random.default_rng(seed)
    return rng.integers(0, n_unique, size=n_tokens).tolist()


def corpus_mostly_one_token(n_tokens: int, *, dominant_id: int = 11, dominant_pct: float = 0.5, seed: int = 42) -> list[int]:
    """One ID appears dominant_pct of the time; others are uniformly
    random. Models the 'comma-and-the-glue token dominates' pattern."""
    import numpy as np

    rng = np.random.default_rng(seed)
    ids: list[int] = []
    for _ in range(n_tokens):
        if rng.random() < dominant_pct:
            ids.append(dominant_id)
        else:
            ids.append(int(rng.integers(0, 152064)))
    return ids


CORPORA = {
    "uniform-random-vocab-152064": lambda n: corpus_uniform_random(n),
    "cyclic-period-10":            lambda n: corpus_cyclic(n, period=10),
    "low-entropy-50-unique":       lambda n: corpus_low_entropy(n, n_unique=50),
    "comma-dominated-50pct":       lambda n: corpus_mostly_one_token(n),
}

SIZES = [16, 32, 64, 128, 256, 512, 1024, 2048]
FORMATS = ["msgpack", "protobuf"]
ENCODINGS = ["identity", "gzip", "br", "zstd"]


# ── main ──────────────────────────────────────────────────────────────────


def _hash_dict(dict_bytes: bytes) -> str:
    return "sha256:" + hashlib.sha256(dict_bytes).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(prog="synthetic_wire_bench")
    ap.add_argument("run_id", nargs="?", help="ISO-8601-ish run id; defaults to UTC now")
    ap.add_argument("--out", help="output path (default: results/<run_id>/synthetic/wire.json)")
    args = ap.parse_args()

    run_id = args.run_id or _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    out_path = Path(args.out) if args.out else RESULTS_DIR / run_id / "synthetic" / "wire.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Load shipped dicts. zstd cells skip silently if absent.
    dicts: dict[str, bytes] = {}
    dict_hashes: dict[str, str] = {}
    for fmt, fname in [("msgpack", "qwen2.5-synth-msgpack-v1.dict"), ("protobuf", "qwen2.5-synth-protobuf-v1.dict")]:
        p = DICTS_DIR / fname
        if p.exists():
            dicts[fmt] = p.read_bytes()
            dict_hashes[fmt] = _hash_dict(dicts[fmt])
            print(f"loaded dict {fname} → {dict_hashes[fmt][:24]}…", file=sys.stderr)
        else:
            print(f"WARN: dict {p} missing: zstd cells for {fmt} will skip", file=sys.stderr)

    # Encoder versions for reproducibility.
    import brotli  # type: ignore
    import zstandard  # type: ignore

    encoder_versions = {
        "msgpack":   ".".join(str(v) for v in msgpack.version),
        "brotli":    brotli.__version__,
        "zstandard": zstandard.__version__,
    }

    cells: list[dict[str, Any]] = []
    corpora_meta: list[dict[str, Any]] = []

    for corpus_name, builder in CORPORA.items():
        for size in SIZES:
            ids = builder(size)
            corpora_meta.append({
                "name":          corpus_name,
                "n_tokens":      size,
                "first_10_ids":  ids[:10],
            })
            for fmt in FORMATS:
                stream = encode_stream(ids, fmt)
                for enc in ENCODINGS:
                    if enc == "identity":
                        wire = compress_identity(stream)
                    elif enc == "gzip":
                        wire = compress_gzip(stream)
                    elif enc == "br":
                        wire = compress_brotli(stream)
                    elif enc == "zstd":
                        if fmt not in dicts:
                            continue
                        wire = compress_zstd_with_dict(stream, dicts[fmt])
                    n = len(wire)
                    cells.append({
                        "corpus":          corpus_name,
                        "n_tokens":        size,
                        "format":          fmt,
                        "encoding":        enc,
                        "wire_bytes":      n,
                        "bytes_per_token": round(n / size, 4),
                    })

    doc = {
        "schema_version":   "1",
        "kind":              "synthetic_wire_bench",
        "run_id":            run_id,
        "encoder_versions":  encoder_versions,
        "dicts":             dict_hashes,
        "corpora":           corpora_meta,
        "cells":             cells,
    }
    out_path.write_text(json.dumps(doc, indent=2))
    print(f"wrote {out_path}  ({len(cells)} cells across {len(CORPORA)} corpora × {len(SIZES)} sizes)", file=sys.stderr)

    # Headline summary on stdout for the impatient.
    print()
    print(f"{'corpus':<32s} {'n_tok':>6s} {'fmt':<9s} {'enc':<10s} {'wire B':>10s} {'B/tok':>8s}")
    for c in cells:
        print(f"{c['corpus']:<32s} {c['n_tokens']:>6d} {c['format']:<9s} {c['encoding']:<10s} {c['wire_bytes']:>10d} {c['bytes_per_token']:>8.3f}")


if __name__ == "__main__":
    main()
