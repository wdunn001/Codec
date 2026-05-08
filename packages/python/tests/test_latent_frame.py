"""
Conformance tests for codecai.server.latent_frame against the worked
example pinned in spec/PIPELINES.md.

Verifies the seven pipelines produce the byte-exact output the spec
documents, plus stream/encoder lifecycle invariants.
"""

from __future__ import annotations

import struct

import numpy as np
import pytest

# Skip cleanly on installs that didn't pull the [server] extra (numpy).
np = pytest.importorskip("numpy")

from codecai.server.latent_frame import (  # noqa: E402
    LatentStreamEncoder,
    PIPELINE_NAMES,
    _compute_scales,
    _quantize_int8,
    _quantize_int4,
    _pack_int4_low_first,
    _saturating_int8_diff,
)


# ── Worked example fixture (spec/PIPELINES.md §Worked example) ────────────────

@pytest.fixture
def worked_example_latent() -> np.ndarray:
    """The toy [2, 2, 2] fp16 fixture used to pin pipeline byte output."""
    return np.array(
        [
            [[1.0, -2.0], [3.0, 0.5]],
            [[-0.5, 0.25], [-0.125, 0.0625]],
        ],
        dtype=np.float16,
    )


def test_worked_example_scales(worked_example_latent: np.ndarray) -> None:
    scales = _compute_scales(worked_example_latent)
    assert scales.dtype == np.float16
    assert scales.shape == (2,)
    # Channel-0 max(|x|) = 3.0; channel-1 max(|x|) = 0.5.
    assert float(scales[0]) == 3.0
    assert float(scales[1]) == 0.5
    # fp16 hex check: 3.0 = 0x4200, 0.5 = 0x3800
    raw = scales.tobytes()
    assert raw == b"\x00\x42\x00\x38"


def test_worked_example_int8_quantize(worked_example_latent: np.ndarray) -> None:
    scales = _compute_scales(worked_example_latent)
    q = _quantize_int8(worked_example_latent, scales)
    expected_ch0 = np.array([42, -85, 127, 21], dtype=np.int8)
    expected_ch1 = np.array([-127, 64, -32, 16], dtype=np.int8)
    np.testing.assert_array_equal(q[0].flatten(), expected_ch0)
    np.testing.assert_array_equal(q[1].flatten(), expected_ch1)
    # Hex layout from the spec doc.
    assert q.tobytes() == bytes([0x2A, 0xAB, 0x7F, 0x15, 0x81, 0x40, 0xE0, 0x10])


def test_worked_example_int4_quantize_and_pack(worked_example_latent: np.ndarray) -> None:
    scales = _compute_scales(worked_example_latent)
    q = _quantize_int4(worked_example_latent, scales)
    expected_ch0 = np.array([2, -5, 7, 1], dtype=np.int8)
    expected_ch1 = np.array([-7, 4, -2, 1], dtype=np.int8)
    np.testing.assert_array_equal(q[0].flatten(), expected_ch0)
    np.testing.assert_array_equal(q[1].flatten(), expected_ch1)
    packed = _pack_int4_low_first(q)
    # Spec: byte-by-byte = 0xB2, 0x17, 0x49, 0x1E
    assert packed == bytes([0xB2, 0x17, 0x49, 0x1E])


# ── Encoder lifecycle ────────────────────────────────────────────────────────


def test_encoder_pipeline_names_match_registry() -> None:
    assert PIPELINE_NAMES == (
        "raw", "int8", "int4",
        "int8-adaptive", "int4-adaptive",
        "delta+int8", "delta+int4",
    )


def test_encoder_raw_round_trip(worked_example_latent: np.ndarray) -> None:
    enc = LatentStreamEncoder(
        "test/space",
        worked_example_latent.shape,
        "fp16",
        "raw",
    )
    header = enc.header()
    assert isinstance(header, bytes)
    frame = enc.frame(worked_example_latent, seq=0, keyframe=True, done=True, finish_reason="ok")
    assert isinstance(frame, bytes)
    # Raw pipeline data == direct fp16-LE bytes of the latent.
    expected_raw = worked_example_latent.astype("<f2").tobytes()
    # Locate `data` field inside msgpack frame: easiest approach — decode and check.
    import msgspec.msgpack
    decoded = msgspec.msgpack.Decoder().decode(frame)
    assert decoded["data"] == expected_raw
    assert decoded["seq"] == 0
    assert decoded["keyframe"] is True
    assert decoded["done"] is True
    assert decoded["finish_reason"] == "ok"


def test_encoder_int8_static_requires_scales(worked_example_latent: np.ndarray) -> None:
    with pytest.raises(ValueError, match="static_scales"):
        LatentStreamEncoder(
            "test/space",
            worked_example_latent.shape,
            "fp16",
            "int8",
        )


def test_encoder_int8_static_round_trip(worked_example_latent: np.ndarray) -> None:
    scales = _compute_scales(worked_example_latent)
    enc = LatentStreamEncoder(
        "test/space",
        worked_example_latent.shape,
        "fp16",
        "int8",
        static_scales=scales,
    )
    import msgspec.msgpack
    decoded_header = msgspec.msgpack.Decoder().decode(enc.header())
    assert decoded_header["pipeline"] == "int8"
    assert decoded_header["scales"] == b"\x00\x42\x00\x38"
    decoded_frame = msgspec.msgpack.Decoder().decode(
        enc.frame(worked_example_latent, seq=0, keyframe=True, done=True, finish_reason="ok")
    )
    assert decoded_frame["data"] == bytes([0x2A, 0xAB, 0x7F, 0x15, 0x81, 0x40, 0xE0, 0x10])


def test_encoder_int4_static_round_trip(worked_example_latent: np.ndarray) -> None:
    scales = _compute_scales(worked_example_latent)
    enc = LatentStreamEncoder(
        "test/space",
        worked_example_latent.shape,
        "fp16",
        "int4",
        static_scales=scales,
    )
    import msgspec.msgpack
    decoded_frame = msgspec.msgpack.Decoder().decode(
        enc.frame(worked_example_latent, seq=0, keyframe=True, done=True)
    )
    assert decoded_frame["data"] == bytes([0xB2, 0x17, 0x49, 0x1E])


def test_encoder_int8_adaptive_carries_scales_in_frame(worked_example_latent: np.ndarray) -> None:
    enc = LatentStreamEncoder(
        "test/space",
        worked_example_latent.shape,
        "fp16",
        "int8-adaptive",
    )
    import msgspec.msgpack
    decoded_header = msgspec.msgpack.Decoder().decode(enc.header())
    assert "scales" not in decoded_header  # adaptive: no static scales in header
    decoded_frame = msgspec.msgpack.Decoder().decode(
        enc.frame(worked_example_latent, seq=0, keyframe=True, done=True)
    )
    # Frame data layout: scales (4 bytes) || quantized payload (8 bytes).
    assert decoded_frame["data"][:4] == b"\x00\x42\x00\x38"
    assert decoded_frame["data"][4:] == bytes([0x2A, 0xAB, 0x7F, 0x15, 0x81, 0x40, 0xE0, 0x10])


def test_encoder_delta_int8_first_frame_must_be_keyframe(worked_example_latent: np.ndarray) -> None:
    enc = LatentStreamEncoder(
        "test/space",
        worked_example_latent.shape,
        "fp16",
        "delta+int8",
    )
    with pytest.raises(ValueError, match="keyframe"):
        enc.frame(worked_example_latent, seq=0, keyframe=False)


def test_encoder_delta_int8_residual_against_keyframe(worked_example_latent: np.ndarray) -> None:
    enc = LatentStreamEncoder(
        "test/space",
        worked_example_latent.shape,
        "fp16",
        "delta+int8",
    )
    enc.header()
    # Keyframe at seq=0
    keyframe_bytes_via_msgpack = enc.frame(worked_example_latent, seq=0, keyframe=True)
    # Frame at seq=1 with the SAME latent — residual should be all zeros.
    import msgspec.msgpack
    decoded = msgspec.msgpack.Decoder().decode(
        enc.frame(worked_example_latent, seq=1, keyframe=False)
    )
    assert decoded["data"] == bytes(worked_example_latent.size)  # all zeros
    assert len(decoded["data"]) == 8  # CHW = 2*2*2 = 8 int8 values


def test_encoder_seq_must_be_monotonic(worked_example_latent: np.ndarray) -> None:
    enc = LatentStreamEncoder(
        "test/space",
        worked_example_latent.shape,
        "fp16",
        "raw",
    )
    enc.header()
    enc.frame(worked_example_latent, seq=0, keyframe=True)
    with pytest.raises(ValueError, match="monotonically"):
        enc.frame(worked_example_latent, seq=0, keyframe=True)


def test_encoder_protobuf_header_has_length_prefix(worked_example_latent: np.ndarray) -> None:
    enc = LatentStreamEncoder(
        "test/space",
        worked_example_latent.shape,
        "fp16",
        "raw",
        stream_format="protobuf",
    )
    header = enc.header()
    assert len(header) >= 4
    declared_len = struct.unpack(">I", header[:4])[0]
    assert declared_len == len(header) - 4
