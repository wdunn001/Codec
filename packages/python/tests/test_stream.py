"""Stream decoder tests: mirror packages/web/test/stream.test.ts."""
from __future__ import annotations

import struct
from collections.abc import AsyncIterator

import msgspec
import pytest

from codecai import (
    decode_msgpack_stream,
    decode_protobuf_frame,
    decode_protobuf_stream,
)


def _encode_msgpack_frame(ids: list[int], done: bool, finish_reason: str | None = None) -> bytes:
    obj: dict = {"ids": ids, "done": done}
    if finish_reason is not None:
        obj["finish_reason"] = finish_reason
    return msgspec.msgpack.encode(obj)


def _encode_protobuf_frame(ids: list[int], done: bool, finish_reason: str | None = None) -> bytes:
    parts: list[int] = []

    def varint(n: int) -> list[int]:
        out: list[int] = []
        while True:
            bits = n & 0x7F
            n >>= 7
            if n == 0:
                out.append(bits)
                break
            out.append(bits | 0x80)
        return out

    if ids:
        packed: list[int] = []
        for tok_id in ids:
            packed.extend(varint(tok_id))
        parts.append(0x0A)
        parts.extend(varint(len(packed)))
        parts.extend(packed)
    parts.extend([0x10, 1 if done else 0])
    if finish_reason:
        enc = finish_reason.encode("utf-8")
        parts.append(0x1A)
        parts.extend(varint(len(enc)))
        parts.extend(enc)
    payload = bytes(parts)
    return struct.pack(">I", len(payload)) + payload


async def _stream_of(chunks: list[bytes]) -> AsyncIterator[bytes]:
    for c in chunks:
        yield c


# ── msgpack ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_msgpack_yields_frames_in_order_and_stops_at_done():
    frames = b"".join([
        _encode_msgpack_frame([1, 2, 3], False),
        _encode_msgpack_frame([4, 5], False),
        _encode_msgpack_frame([6], True, "stop"),
    ])
    collected = []
    async for f in decode_msgpack_stream(_stream_of([frames])):
        collected.append(f)

    assert len(collected) == 3
    assert list(collected[0].ids) == [1, 2, 3]
    assert list(collected[2].ids) == [6]
    assert collected[2].done is True
    assert collected[2].finish_reason == "stop"


@pytest.mark.asyncio
async def test_msgpack_handles_frame_split_across_chunks():
    buf = _encode_msgpack_frame([42, 43, 44], True)
    half = len(buf) // 2
    chunks = [buf[:half], buf[half:]]
    collected = []
    async for f in decode_msgpack_stream(_stream_of(chunks)):
        collected.append(list(f.ids))
    assert collected == [[42, 43, 44]]


# ── protobuf ─────────────────────────────────────────────────────────────────


def test_decode_protobuf_frame_round_trips_all_fields():
    wire = _encode_protobuf_frame([100, 200, 300], True, "length")
    payload = wire[4:]  # strip 4-byte length prefix
    frame = decode_protobuf_frame(payload)
    assert list(frame.ids) == [100, 200, 300]
    assert frame.done is True
    assert frame.finish_reason == "length"


@pytest.mark.asyncio
async def test_protobuf_reassembles_frames_split_across_chunks():
    wire = b"".join([
        _encode_protobuf_frame([1, 2], False),
        _encode_protobuf_frame([3, 4], False),
        _encode_protobuf_frame([5], True, "stop"),
    ])
    # Split into 7-byte chunks so frames straddle reads.
    chunks = [wire[i:i + 7] for i in range(0, len(wire), 7)]
    collected: list[list[int]] = []
    async for f in decode_protobuf_stream(_stream_of(chunks)):
        collected.append(list(f.ids))
    assert collected == [[1, 2], [3, 4], [5]]


@pytest.mark.asyncio
async def test_protobuf_throws_on_truncated_frame():
    wire = _encode_protobuf_frame([1, 2, 3], True)
    truncated = wire[:-2]
    with pytest.raises(ValueError, match="ended mid-frame"):
        async for _f in decode_protobuf_stream(_stream_of([truncated])):
            pass
