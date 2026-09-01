"""Codec wire-format stream decoders.

Adapt an HTTP response body (any async byte iterable) into an
``AsyncIterator[CodecFrame]``.
"""
from __future__ import annotations

import struct
from collections.abc import AsyncIterable, AsyncIterator

import msgspec

from .types import CodecFrame


class _MsgpackFrame(msgspec.Struct, kw_only=True):
    """Internal struct used by msgspec to decode incoming frames."""

    ids: list[int]
    done: bool
    finish_reason: str | None = None


_msgpack_decoder = msgspec.msgpack.Decoder(_MsgpackFrame)


# ── Unified entry point ──────────────────────────────────────────────────────


def decode_stream(
    body: AsyncIterable[bytes],
    fmt: str = "msgpack",
) -> AsyncIterator[CodecFrame]:
    """Pick the decoder based on ``fmt``."""
    if fmt == "protobuf":
        return decode_protobuf_stream(body)
    return decode_msgpack_stream(body)


# ── MessagePack ──────────────────────────────────────────────────────────────


async def decode_msgpack_stream(body: AsyncIterable[bytes]) -> AsyncIterator[CodecFrame]:
    """Yield frames from a stream of concatenated MessagePack maps.

    Frame shape: ``{"ids": [int...], "done": bool, "finish_reason"?: str}``.
    msgspec doesn't ship a streaming unpacker. We reassemble incrementally
    instead, trying to decode the buffer after each chunk and advancing on success.
    """
    buf = bytearray()
    async for chunk in body:
        if not chunk:
            continue
        buf.extend(chunk)
        # Try to decode as many complete frames as possible from the buffer.
        while True:
            try:
                frame_struct, consumed = _decode_msgpack_one(bytes(buf))
            except _Incomplete:
                break  # need more bytes
            yield CodecFrame(
                ids=tuple(frame_struct.ids),
                done=frame_struct.done,
                finish_reason=frame_struct.finish_reason,
            )
            del buf[:consumed]
            if frame_struct.done:
                return


class _Incomplete(Exception):
    pass


def _decode_msgpack_one(data: bytes) -> tuple[_MsgpackFrame, int]:
    """Decode the first complete msgpack frame from ``data``; return (frame, bytes_consumed).

    Raises ``_Incomplete`` if more data is needed.
    """
    # Walk msgpack structure to find the boundary, then hand the slice to msgspec.
    try:
        end = _msgpack_end_offset(data, 0)
    except _Incomplete:
        raise
    try:
        frame = _msgpack_decoder.decode(data[:end])
    except msgspec.ValidationError as e:
        raise ValueError(f"Codec msgpack: invalid frame shape: {e}") from e
    return frame, end


def _msgpack_end_offset(data: bytes, pos: int) -> int:
    """Find the end offset of the msgpack value starting at ``pos``.

    Implements just enough of the msgpack spec to bound a value boundary.
    Raises ``_Incomplete`` if data is truncated mid-value.
    """
    if pos >= len(data):
        raise _Incomplete()
    b = data[pos]

    # positive fixint, negative fixint, fixstr, fixarray, fixmap, nil, false, true
    if b <= 0x7F or b >= 0xE0:
        return pos + 1
    if b == 0xC0 or b == 0xC2 or b == 0xC3:
        return pos + 1

    # fixstr (0xA0-0xBF)
    if 0xA0 <= b <= 0xBF:
        return _need(data, pos + 1 + (b & 0x1F))
    # fixarray (0x90-0x9F)
    if 0x90 <= b <= 0x9F:
        n = b & 0x0F
        return _array_end(data, pos + 1, n)
    # fixmap (0x80-0x8F)
    if 0x80 <= b <= 0x8F:
        n = b & 0x0F
        return _array_end(data, pos + 1, n * 2)

    # bin/str/array/map with explicit length
    if b in (0xC4, 0xC5, 0xC6):  # bin 8/16/32
        return _len_prefixed(data, pos, _len_size(b))
    if b in (0xD9, 0xDA, 0xDB):  # str 8/16/32
        return _len_prefixed(data, pos, _len_size(b))
    if b in (0xDC, 0xDD):  # array 16/32
        size = 2 if b == 0xDC else 4
        if pos + 1 + size > len(data):
            raise _Incomplete()
        n = int.from_bytes(data[pos + 1:pos + 1 + size], "big")
        return _array_end(data, pos + 1 + size, n)
    if b in (0xDE, 0xDF):  # map 16/32
        size = 2 if b == 0xDE else 4
        if pos + 1 + size > len(data):
            raise _Incomplete()
        n = int.from_bytes(data[pos + 1:pos + 1 + size], "big")
        return _array_end(data, pos + 1 + size, n * 2)

    # int8/16/32/64, uint8/16/32/64, float32/64, fixext, ext
    fixed_widths = {
        0xCC: 1, 0xCD: 2, 0xCE: 4, 0xCF: 8,        # uint
        0xD0: 1, 0xD1: 2, 0xD2: 4, 0xD3: 8,        # int
        0xCA: 4, 0xCB: 8,                           # float
        0xD4: 2, 0xD5: 3, 0xD6: 5, 0xD7: 9, 0xD8: 17,  # fixext 1/2/4/8/16
    }
    width = fixed_widths.get(b)
    if width is not None:
        return _need(data, pos + 1 + width)

    if b in (0xC7, 0xC8, 0xC9):  # ext 8/16/32
        size = _len_size(b)
        if pos + 1 + size + 1 > len(data):
            raise _Incomplete()
        n = int.from_bytes(data[pos + 1:pos + 1 + size], "big")
        return _need(data, pos + 1 + size + 1 + n)

    raise ValueError(f"Codec msgpack: unsupported byte 0x{b:02X} at offset {pos}")


def _len_size(prefix: int) -> int:
    return {0xC4: 1, 0xC5: 2, 0xC6: 4, 0xC7: 1, 0xC8: 2, 0xC9: 4, 0xD9: 1, 0xDA: 2, 0xDB: 4}[prefix]


def _len_prefixed(data: bytes, pos: int, size: int) -> int:
    if pos + 1 + size > len(data):
        raise _Incomplete()
    n = int.from_bytes(data[pos + 1:pos + 1 + size], "big")
    return _need(data, pos + 1 + size + n)


def _need(data: bytes, end: int) -> int:
    if end > len(data):
        raise _Incomplete()
    return end


def _array_end(data: bytes, pos: int, n: int) -> int:
    for _ in range(n):
        pos = _msgpack_end_offset(data, pos)
    return pos


# ── Protobuf ─────────────────────────────────────────────────────────────────


async def decode_protobuf_stream(body: AsyncIterable[bytes]) -> AsyncIterator[CodecFrame]:
    """Yield frames from a stream of length-prefixed protobuf CodecFrame payloads.

    Wire: 4-byte big-endian length followed by the protobuf bytes.
    """
    buf = bytearray()
    body_iter = body.__aiter__()

    async def _read_more() -> bool:
        try:
            chunk = await body_iter.__anext__()
        except StopAsyncIteration:
            return False
        if chunk:
            buf.extend(chunk)
        return True

    while True:
        # Need at least 4 bytes for the length prefix.
        while len(buf) < 4:
            if not await _read_more():
                if buf:
                    raise ValueError(
                        f"Codec protobuf stream ended mid-frame ({len(buf)} bytes left)"
                    )
                return

        frame_len = struct.unpack(">I", bytes(buf[:4]))[0]

        # Read more until we have 4 + frame_len.
        while len(buf) < 4 + frame_len:
            if not await _read_more():
                raise ValueError(
                    f"Codec protobuf stream ended mid-frame (need {frame_len} bytes)"
                )

        payload = bytes(buf[4:4 + frame_len])
        del buf[:4 + frame_len]

        frame = decode_protobuf_frame(payload)
        yield frame
        if frame.done:
            return


def decode_protobuf_frame(data: bytes) -> CodecFrame:
    """Decode a single CodecFrame protobuf payload (no length prefix)."""
    ids: list[int] = []
    done = False
    finish_reason: str | None = None
    pos = 0

    while pos < len(data):
        tag, pos = _read_varint(data, pos)
        field = tag >> 3
        wt = tag & 0x07

        if wt == 0:  # varint
            val, pos = _read_varint(data, pos)
            if field == 2:
                done = bool(val)
        elif wt == 1:  # 64-bit fixed: skip
            pos += 8
        elif wt == 2:  # length-delimited
            length, pos = _read_varint(data, pos)
            chunk = data[pos:pos + length]
            pos += length
            if field == 1:  # packed repeated uint32 ids
                p = 0
                while p < len(chunk):
                    val, p = _read_varint(chunk, p)
                    ids.append(val)
            elif field == 3:  # optional string finish_reason
                finish_reason = chunk.decode("utf-8")
        elif wt == 5:  # 32-bit fixed: skip
            pos += 4
        else:
            raise ValueError(
                f"Codec: unknown protobuf wire type {wt} in CodecFrame field {field}"
            )

    return CodecFrame(ids=tuple(ids), done=done, finish_reason=finish_reason)


def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= len(data):
            raise ValueError("Codec protobuf: truncated varint")
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift > 63:
            raise ValueError("Codec protobuf: varint too long")
