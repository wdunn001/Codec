#!/usr/bin/env python3
"""Measure Codec frame overhead per candidate wire shape.

The v0.5 spec reports 16.0 bytes/token for msgpack at one token per chunk
against 10.9 for protobuf on the identical payload. Protobuf carries field
numbers where msgpack carries the strings "ids", "done", and "finish_reason",
so that 5.1-byte gap is the key names. This script measures exactly how much
each candidate shape recovers.

Real Qwen2.5-7B-Instruct token IDs are read from packages/bench/golden/qwen2.json
so the integer-width distribution is the one a live stream actually produces.

Both encoders are written out here rather than imported. msgspec is not a
dependency of this script, and a hand-written encoder makes the byte accounting
auditable against the MessagePack and protobuf specifications directly.

Usage:
    python packages/bench/scripts/frame_shape_bench.py
    python packages/bench/scripts/frame_shape_bench.py --json
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, "..", "golden", "qwen2.json")


# ── MessagePack (subset: the types a CodecFrame uses) ────────────────────────

def mp_uint(n: int) -> bytes:
    if n < 0:
        raise ValueError("token ids are unsigned")
    if n < 0x80:
        return bytes([n])                       # positive fixint
    if n < 0x100:
        return b"\xcc" + n.to_bytes(1, "big")   # uint8
    if n < 0x10000:
        return b"\xcd" + n.to_bytes(2, "big")   # uint16
    if n < 0x100000000:
        return b"\xce" + n.to_bytes(4, "big")   # uint32
    return b"\xcf" + n.to_bytes(8, "big")       # uint64


def mp_str(s: str) -> bytes:
    b = s.encode()
    if len(b) < 32:
        return bytes([0xA0 | len(b)]) + b       # fixstr
    return b"\xd9" + bytes([len(b)]) + b        # str8


def mp_array(items: list[bytes]) -> bytes:
    if len(items) < 16:
        return bytes([0x90 | len(items)]) + b"".join(items)
    return b"\xdc" + len(items).to_bytes(2, "big") + b"".join(items)


def mp_map(pairs: list[tuple[bytes, bytes]]) -> bytes:
    if len(pairs) < 16:
        head = bytes([0x80 | len(pairs)])
    else:
        head = b"\xde" + len(pairs).to_bytes(2, "big")
    return head + b"".join(k + v for k, v in pairs)


def mp_bin(b: bytes) -> bytes:
    if len(b) < 0x100:
        return b"\xc4" + bytes([len(b)]) + b    # bin8
    return b"\xc5" + len(b).to_bytes(2, "big") + b  # bin16


MP_FALSE, MP_TRUE = b"\xc2", b"\xc3"


def leb128(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def zigzag(n: int) -> int:
    return (n << 1) ^ (n >> 63) if n < 0 else n << 1


# ── Candidate frame shapes ───────────────────────────────────────────────────
#
# Each takes (ids, done, finish_reason) and returns the encoded frame bytes.

def shape_current(ids, done, fr):
    """{"ids": [...], "done": bool, "finish_reason"?: str}: what ships today."""
    pairs = [
        (mp_str("ids"), mp_array([mp_uint(i) for i in ids])),
        (mp_str("done"), MP_TRUE if done else MP_FALSE),
    ]
    if fr is not None:
        pairs.append((mp_str("finish_reason"), mp_str(fr)))
    return mp_map(pairs)


def shape_short_keys(ids, done, fr):
    """{"i": [...], "d": bool, "f"?: str}: one-character string keys."""
    pairs = [
        (mp_str("i"), mp_array([mp_uint(i) for i in ids])),
        (mp_str("d"), MP_TRUE if done else MP_FALSE),
    ]
    if fr is not None:
        pairs.append((mp_str("f"), mp_str(fr)))
    return mp_map(pairs)


def shape_int_keys(ids, done, fr):
    """{0: [...], 1: bool, 2?: str}: msgpack fixint keys, one byte each."""
    pairs = [
        (mp_uint(0), mp_array([mp_uint(i) for i in ids])),
        (mp_uint(1), MP_TRUE if done else MP_FALSE),
    ]
    if fr is not None:
        pairs.append((mp_uint(2), mp_str(fr)))
    return mp_map(pairs)


def shape_int_keys_sparse(ids, done, fr):
    """{0: [...]} with `done` present only when true. Decoder defaults it false."""
    pairs = [(mp_uint(0), mp_array([mp_uint(i) for i in ids]))]
    if done:
        pairs.append((mp_uint(1), MP_TRUE))
    if fr is not None:
        pairs.append((mp_uint(2), mp_str(fr)))
    return mp_map(pairs)


def shape_positional(ids, done, fr):
    """[[...], bool, str|nil]: fixarray, no keys at all."""
    items = [mp_array([mp_uint(i) for i in ids]), MP_TRUE if done else MP_FALSE]
    if fr is not None:
        items.append(mp_str(fr))
    return mp_array(items)


def shape_varint_bin(ids, done, fr):
    """{0: bin(LEB128 ids)}: ids packed as varints in one bin blob."""
    packed = b"".join(leb128(i) for i in ids)
    pairs = [(mp_uint(0), mp_bin(packed))]
    if done:
        pairs.append((mp_uint(1), MP_TRUE))
    if fr is not None:
        pairs.append((mp_uint(2), mp_str(fr)))
    return mp_map(pairs)


def shape_varint_delta(ids, done, fr):
    """{0: base, 1: bin(zigzag-varint deltas)}: the v0.5 msgpack-delta idea."""
    pairs = []
    if ids:
        base = ids[0]
        deltas = b"".join(
            leb128(zigzag(ids[k] - ids[k - 1])) for k in range(1, len(ids))
        )
        pairs.append((mp_uint(0), mp_uint(base)))
        if deltas:
            pairs.append((mp_uint(1), mp_bin(deltas)))
    if done:
        pairs.append((mp_uint(2), MP_TRUE))
    if fr is not None:
        pairs.append((mp_uint(3), mp_str(fr)))
    return mp_map(pairs)


def shape_protobuf(ids, done, fr):
    """CodecFrame protobuf with the 4-byte big-endian length prefix.

    proto3 omits an implicit-presence scalar at its default, so `done: false`
    contributes nothing. The engine forks emit b"\\x10\\x00" unconditionally,
    which costs 2 bytes on every non-final frame; `shape_protobuf_forks`
    below measures that.
    """
    parts = []
    if ids:
        packed = b"".join(leb128(i) for i in ids)
        parts.append(b"\x0a" + leb128(len(packed)) + packed)
    if done:
        parts.append(b"\x10\x01")
    if fr:
        enc = fr.encode()
        parts.append(b"\x1a" + leb128(len(enc)) + enc)
    payload = b"".join(parts)
    return len(payload).to_bytes(4, "big") + payload


def shape_protobuf_forks(ids, done, fr):
    """What sglang, vllm, and llama.cpp actually emit: field 2 always present."""
    parts = []
    if ids:
        packed = b"".join(leb128(i) for i in ids)
        parts.append(b"\x0a" + leb128(len(packed)) + packed)
    parts.append(b"\x10" + (b"\x01" if done else b"\x00"))
    if fr:
        enc = fr.encode()
        parts.append(b"\x1a" + leb128(len(enc)) + enc)
    payload = b"".join(parts)
    return len(payload).to_bytes(4, "big") + payload


SHAPES = [
    ("msgpack current {ids,done}", shape_current),
    ("msgpack 1-char keys {i,d}", shape_short_keys),
    ("msgpack int keys {0,1}", shape_int_keys),
    ("msgpack int keys, sparse done", shape_int_keys_sparse),
    ("msgpack positional array", shape_positional),
    ("msgpack int key + varint bin", shape_varint_bin),
    ("msgpack delta-varint", shape_varint_delta),
    ("protobuf (canonical proto3)", shape_protobuf),
    ("protobuf (as forks emit it)", shape_protobuf_forks),
]


def load_ids() -> list[int]:
    with open(GOLDEN, encoding="utf-8") as fh:
        golden = json.load(fh)
    ids: list[int] = []
    for sample in golden["samples"]:
        ids.extend(sample["ids"])
    return ids


def measure(ids: list[int], per_chunk: int) -> dict[str, float]:
    """Stream `ids` in fixed-size chunks; return bytes per token per shape."""
    chunks = [ids[i:i + per_chunk] for i in range(0, len(ids), per_chunk)]
    out = {}
    for name, fn in SHAPES:
        total = 0
        for n, chunk in enumerate(chunks):
            last = n == len(chunks) - 1
            total += len(fn(chunk, last, "stop" if last else None))
        out[name] = total / len(ids)
    return out


def selftest() -> None:
    """Assert exact bytes for hand-computed cases.

    Every expectation below is derived from the MessagePack and protobuf
    specifications by hand, so an encoder regression fails here rather than
    silently shifting a benchmark number.
    """
    # 0x82 fixmap(2) | 0xa3 "ids" | 0x91 fixarray(1) 0xcd 0x25 0xeb (uint16
    # 9707) | 0xa4 "done" | 0xc2 false. Fifteen bytes to carry one token.
    assert shape_current([9707], False, None) == (
        b"\x82\xa3ids\x91\xcd\x25\xeb\xa4done\xc2"
    )

    # 0x81 fixmap(1) | 0x00 fixint key | 0x91 0xcd 0x25 0xeb. Six bytes.
    assert shape_int_keys_sparse([9707], False, None) == (
        b"\x81\x00\x91\xcd\x25\xeb"
    )

    # A positive fixint id needs no type marker: id 0 is a single 0x00 byte.
    assert shape_int_keys_sparse([0], False, None) == b"\x81\x00\x91\x00"

    # proto3 omits an implicit-presence scalar at its default value, so a
    # non-final frame carries no `done` field at all.
    assert shape_protobuf([1], False, None) == b"\x00\x00\x00\x03\x0a\x01\x01"

    # The forks append b"\x10\x00" regardless. Two bytes on every frame.
    assert shape_protobuf_forks([1], False, None) == (
        b"\x00\x00\x00\x05\x0a\x01\x01\x10\x00"
    )

    # LEB128 boundary: 127 is one byte, 128 is two.
    assert leb128(127) == b"\x7f"
    assert leb128(128) == b"\x80\x01"

    # zigzag maps -1 to 1 and 1 to 2.
    assert zigzag(-1) == 1
    assert zigzag(1) == 2


def main() -> None:
    selftest()
    ids = load_ids()
    widths = [
        ("< 128 (fixint)", sum(1 for i in ids if i < 0x80)),
        ("128 to 65535", sum(1 for i in ids if 0x80 <= i < 0x10000)),
        (">= 65536", sum(1 for i in ids if i >= 0x10000)),
    ]

    if "--json" in sys.argv:
        print(json.dumps({
            "source": "packages/bench/golden/qwen2.json",
            "model": "Qwen/Qwen2.5-7B-Instruct",
            "token_count": len(ids),
            "results": {str(c): measure(ids, c) for c in (1, 4, 8, 16)},
        }, indent=2))
        return

    print(f"Corpus: {len(ids)} real Qwen2.5-7B-Instruct token ids "
          f"from packages/bench/golden/qwen2.json")
    print("Token id widths: " + ", ".join(f"{k} {v}" for k, v in widths))
    print()

    chunk_sizes = (1, 4, 8, 16)
    results = {c: measure(ids, c) for c in chunk_sizes}
    baseline = results[1]["msgpack current {ids,done}"]

    head = f"{'shape':<32}" + "".join(f"{c:>10}" for c in chunk_sizes) + f"{'vs now':>11}"
    print(head)
    print("-" * len(head))
    for name, _ in SHAPES:
        row = f"{name:<32}" + "".join(f"{results[c][name]:>10.2f}" for c in chunk_sizes)
        saving = (1 - results[1][name] / baseline) * 100
        print(row + f"{saving:>10.1f}%")
    print()
    print("Columns are bytes per token at that many tokens per frame.")
    print("The `vs now` column is the saving at one token per frame, the "
          "worst case for framing overhead and the shape of token-by-token "
          "streaming.")


if __name__ == "__main__":
    main()
