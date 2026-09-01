"""Delta-varint stream encoding for Codec (v0.5+, opt-in axis).

Spec: ``spec/versions/v0.5.md § "v0.5-1: Delta-varint stream encoding (opt-in)"``.

Wire shape per frame (msgpack):

    {
      "base_id": int,          # anchor: encoder's last-id-seen-at-end-of-prev-frame
                               # (0 on the very first frame in a stream)
      "ids_delta": [int, ...], # zigzag-encoded chained deltas
                               #   d[0] = zigzag(ids[0] - base_id)
                               #   d[k] = zigzag(ids[k] - ids[k-1])  for k > 0
      "done": bool,            # terminal-frame flag (same as standard frame)
      "finish_reason": str | None,  # optional, same semantics as standard
    }

Decode is the inverse: cumulative sum starting from base_id, dezigzag each
delta to get the signed int, add to the running id.

Why chained deltas: adjacent tokens
in semantically related sequences typically differ by small amounts (1-100).
Chained zigzag-varint therefore stays in the 1-byte msgpack range. With base-relative
deltas, a frame's later ids would have arbitrarily large offsets and need
multi-byte encoding.

Stateless framing preserved: every frame carries its own base_id. A proxy
that drops a frame in the middle of a stream therefore doesn't desynchronise
the decoder for subsequent frames.

The chained-vs-base-relative choice is normative: picked because chained
gives 10-15% better wire on real token sequences (see v0.5 OQ2 for the
"per-frame base_id" knob discussion).
"""
from __future__ import annotations

from typing import Iterable, Sequence

import msgspec

from .types import CodecFrame


class _DeltaMsgpackFrame(msgspec.Struct, kw_only=True):
    base_id: int
    ids_delta: list[int]
    done: bool
    finish_reason: str | None = None


_msgpack_encoder = msgspec.msgpack.Encoder()
_msgpack_decoder = msgspec.msgpack.Decoder(_DeltaMsgpackFrame)


# ── zigzag encoding (matches protobuf's sint32/sint64 scheme) ──────────────


def zigzag_encode(n: int) -> int:
    """Map a signed int to an unsigned int suitable for varint encoding.

    The mapping interleaves negative and positive values around zero:
      0 →  0
     -1 →  1
      1 →  2
     -2 →  3
      2 →  4
    ... so small magnitudes (positive OR negative) get small unsigned
    values that fit in one byte under msgpack's fixint encoding.
    """
    # Use int.bit_length() so this works for arbitrarily large negative
    # ints in Python (no fixed bit width).
    if n >= 0:
        return n * 2
    return -n * 2 - 1


def zigzag_decode(n: int) -> int:
    """Inverse of :func:`zigzag_encode`."""
    if n & 1 == 0:
        return n >> 1
    return -((n + 1) >> 1)


# ── single-frame encode / decode ────────────────────────────────────────────


def encode_delta_frame(
    ids: Sequence[int],
    *,
    base_id: int = 0,
    done: bool = False,
    finish_reason: str | None = None,
) -> bytes:
    """Encode one frame as msgpack delta-varint bytes.

    ``base_id`` is the encoder's last-id-seen-at-end-of-previous-frame.
    Pass 0 for the first frame in a stream. Subsequent frames pass the
    last id of the previous frame.
    """
    if len(ids) == 0:
        ids_delta: list[int] = []
    else:
        prev = base_id
        ids_delta = []
        for tid in ids:
            ids_delta.append(zigzag_encode(tid - prev))
            prev = tid
    obj = _DeltaMsgpackFrame(
        base_id=base_id,
        ids_delta=ids_delta,
        done=done,
        finish_reason=finish_reason,
    )
    return _msgpack_encoder.encode(obj)


def decode_delta_frame(data: bytes) -> CodecFrame:
    """Decode one frame's bytes back into a :class:`CodecFrame`."""
    parsed = _msgpack_decoder.decode(data)
    prev = parsed.base_id
    ids: list[int] = []
    for delta in parsed.ids_delta:
        tid = prev + zigzag_decode(delta)
        ids.append(tid)
        prev = tid
    return CodecFrame(
        ids=tuple(ids),
        done=parsed.done,
        finish_reason=parsed.finish_reason,
    )


# ── stream-level encode / decode ────────────────────────────────────────────


def encode_delta_stream(frames: Iterable[tuple[Sequence[int], bool]]) -> list[bytes]:
    """Encode a sequence of ``(ids, done)`` tuples into delta-varint payloads.

    Tracks the running ``base_id`` automatically: each frame's base is the
    last id of the previous frame (or 0 for the first frame). The returned
    list of bytes can be sent over the wire concatenated; each payload is
    self-contained so a proxy that drops a frame doesn't desync.

    For finish-reason support pass ``encode_delta_frame`` directly.
    """
    out: list[bytes] = []
    base = 0
    for ids, done in frames:
        out.append(encode_delta_frame(ids, base_id=base, done=done))
        if ids:
            base = ids[-1]
    return out


def decode_delta_stream(payloads: Iterable[bytes]) -> list[CodecFrame]:
    """Decode a list of delta-varint frame payloads."""
    return [decode_delta_frame(p) for p in payloads]
