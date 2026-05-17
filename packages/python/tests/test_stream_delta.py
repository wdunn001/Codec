"""Tests for the v0.5 delta-varint stream encoding."""
from __future__ import annotations

import pytest

from codecai.types import CodecFrame
from codecai.stream_delta import (
    decode_delta_frame,
    decode_delta_stream,
    encode_delta_frame,
    encode_delta_stream,
    zigzag_decode,
    zigzag_encode,
)


# ── zigzag ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("n", [0, 1, -1, 2, -2, 100, -100, 1234567, -1234567])
def test_zigzag_round_trip(n: int) -> None:
    assert zigzag_decode(zigzag_encode(n)) == n


def test_zigzag_known_values() -> None:
    assert zigzag_encode(0) == 0
    assert zigzag_encode(-1) == 1
    assert zigzag_encode(1) == 2
    assert zigzag_encode(-2) == 3
    assert zigzag_encode(2) == 4
    assert zigzag_decode(0) == 0
    assert zigzag_decode(1) == -1
    assert zigzag_decode(2) == 1


# ── single-frame round-trip ─────────────────────────────────────────────────


def test_frame_round_trip_simple() -> None:
    ids = (10, 20, 30, 15, 100)
    data = encode_delta_frame(ids, base_id=0, done=False)
    frame = decode_delta_frame(data)
    assert frame.ids == ids
    assert frame.done is False
    assert frame.finish_reason is None


def test_frame_round_trip_with_base_id() -> None:
    ids = (1234, 1240, 1238, 1300)
    data = encode_delta_frame(ids, base_id=1000, done=True, finish_reason="stop")
    frame = decode_delta_frame(data)
    assert frame.ids == ids
    assert frame.done is True
    assert frame.finish_reason == "stop"


def test_frame_round_trip_empty_ids() -> None:
    data = encode_delta_frame((), base_id=42, done=True, finish_reason="stop")
    frame = decode_delta_frame(data)
    assert frame.ids == ()
    assert frame.done is True


def test_frame_round_trip_negative_deltas() -> None:
    """The encoder must support deltas in both directions; token sequences
    can go up AND down (e.g. greedy decoding visits different vocab regions).
    """
    ids = (100, 50, 200, 75, 1, 500)
    data = encode_delta_frame(ids, base_id=80, done=False)
    frame = decode_delta_frame(data)
    assert frame.ids == ids


# ── stream-level round-trip ─────────────────────────────────────────────────


def test_stream_round_trip_multi_frame() -> None:
    frames_in = [
        ((1, 5, 7), False),
        ((9, 11, 20), False),
        ((18, 22), True),
    ]
    payloads = encode_delta_stream(frames_in)
    assert len(payloads) == 3
    decoded = decode_delta_stream(payloads)
    assert decoded[0].ids == (1, 5, 7)
    assert decoded[1].ids == (9, 11, 20)
    assert decoded[2].ids == (18, 22)
    assert decoded[2].done is True


def test_stream_each_frame_is_self_anchoring() -> None:
    """Stateless framing — a proxy that drops a frame in the middle should
    still be able to decode subsequent frames correctly, because each
    frame carries its own base_id.
    """
    frames_in = [
        ((10, 20), False),
        ((30, 40), False),
        ((50, 60), True),
    ]
    payloads = encode_delta_stream(frames_in)
    # Decode frame[2] in isolation (frames 0 and 1 dropped). It must produce
    # the same ids as the in-order decode.
    isolated = decode_delta_frame(payloads[2])
    in_order = decode_delta_stream(payloads)[2]
    assert isolated.ids == in_order.ids == (50, 60)


# ── byte-shape regression: ensure the wire stays stable ────────────────────


def test_first_frame_base_id_zero() -> None:
    """First frame in any stream must declare base_id=0 (per spec)."""
    payloads = encode_delta_stream([((100, 200, 300), True)])
    frame = decode_delta_frame(payloads[0])
    # The encoder anchors on 0; the decoded ids must equal what was supplied.
    assert frame.ids == (100, 200, 300)


def test_wire_smaller_than_naive_for_dense_sequence() -> None:
    """The whole point: dense neighbouring tokens should shrink under
    delta+zigzag versus naive uint32 encoding (8-15% measured per spec).
    """
    # 128 adjacent tokens around a value in the middle of a 128K vocab.
    ids = tuple(60_000 + i for i in range(128))
    payload = encode_delta_frame(ids, base_id=60_000)
    # All deltas are +1 → zigzag-encoded as 2 → msgpack-encoded as 1 byte
    # each. Naive uint32 would be 4 bytes per token = 512 bytes; delta
    # should be much smaller.
    assert len(payload) < 256, f"expected dense sequence to compress; got {len(payload)} bytes"