"""
Codec latent-modality frame encoding (v0.3+).

Server-side reference for emitting `LatentStreamHeader` and `LatentFrame`
messages on the Codec wire. Mirrors the text-side `codec_frame.py` already
vendored in sglang / vLLM / llama.cpp forks: hand-rolled msgpack +
protobuf encoders (no codegen step), plus the seven pipeline forward
transforms specified in `spec/PIPELINES.md`.

Latent-aware engine forks (ComfyUI, diffusers reference, future ones)
vendor this file rather than depending on `codecai[server]` at import
time — keeps the inference container's dependency surface tight.

Wire format
-----------
MessagePack  (Content-Type: application/x-msgpack)
  Header — first frame in the response body:
    {"type": "header",
     "latent_space_id": str, "shape": [u32...], "dtype": str,
     "pipeline": str, "scales": bytes | None,
     "fps": u32 | None, "total_frames": u32 | None,
     "vae_scale_factor": f32 | None}
  Frame  — every subsequent frame:
    {"data": bytes, "seq": u32, "keyframe": bool, "done": bool,
     "finish_reason": str | None}

Protobuf     (Content-Type: application/x-protobuf)
  Each message is prefixed by a 4-byte big-endian length, same envelope
  as text-side CodecFrame.  See PROTO_SCHEMA below for the wire fields.

Pipeline math is pinned in spec/PIPELINES.md; this module is the
canonical Python forward-encoder for all seven names. Forward
conformance is checked against fixtures in
packages/bench/golden/pipelines/<name>/.
"""

from __future__ import annotations

import struct
from typing import Any, Optional, Tuple

import msgspec.msgpack
import numpy as np

# Optional torch — only loaded when the caller actually opts into the v0.5
# gpu_quantize fast path. Importing torch is expensive (~hundreds of ms +
# pulls in CUDA libs), so we keep it lazy.
try:
    import torch as _torch  # type: ignore[import-not-found]
    _TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only in torch-installed envs
    _torch = None  # type: ignore[assignment]
    _TORCH_AVAILABLE = False


def _is_cuda_tensor(x: Any) -> bool:
    """True iff ``x`` is a torch.Tensor on a CUDA device. Safe with no torch."""
    if not _TORCH_AVAILABLE:
        return False
    return isinstance(x, _torch.Tensor) and x.is_cuda


def _to_numpy_for_quantize(x: Any) -> np.ndarray:
    """Normalise input to numpy for the numpy quantize path.

    - numpy arrays pass through unchanged
    - torch tensors (any device) are moved to CPU + converted; the existing
      numpy-side quantize math runs on the result
    """
    if _TORCH_AVAILABLE and isinstance(x, _torch.Tensor):
        return x.detach().cpu().numpy()
    return x

# ---------------------------------------------------------------------------
# Pipeline registry (mirrors spec/PIPELINES.md)
# ---------------------------------------------------------------------------

PIPELINE_NAMES = (
    "raw",
    "int8",
    "int4",
    "int8-adaptive",
    "int4-adaptive",
    "delta+int8",
    "delta+int4",
)

# Pipelines whose scales travel in LatentStreamHeader.scales (set once).
_STATIC_SCALE_PIPELINES = frozenset({"int8", "int4"})
# Pipelines whose scales travel inside each keyframe LatentFrame.data.
_ADAPTIVE_SCALE_PIPELINES = frozenset({
    "int8-adaptive", "int4-adaptive", "delta+int8", "delta+int4",
})
# Pipelines that delta-code against the most recent keyframe.
_DELTA_PIPELINES = frozenset({"delta+int8", "delta+int4"})
# Pipelines that pack int4 (two-per-byte, low nibble first).
_INT4_PIPELINES = frozenset({"int4", "int4-adaptive", "delta+int4"})

PROTO_SCHEMA = """\
syntax = "proto3";

// First message in any latent stream — sets the per-stream contract.
message LatentStreamHeader {
  string          latent_space_id  = 1;
  repeated uint32 shape            = 2;
  string          dtype            = 3;
  string          pipeline         = 4;
  optional bytes  scales           = 5;  // C * 2 bytes fp16 LE; static-scale pipelines only
  optional uint32 fps              = 6;
  optional uint32 total_frames     = 7;
  optional float  vae_scale_factor = 8;
}

// Each subsequent message — one latent frame's payload bytes.
message LatentFrame {
  bytes  data            = 1;
  uint32 seq             = 2;
  bool   keyframe        = 3;
  bool   done            = 4;
  optional string finish_reason = 5;
}
"""


# ---------------------------------------------------------------------------
# Pipeline forward transforms (spec/PIPELINES.md §"Pipelines v1")
#
# All transforms are pure functions. `_compute_scales` and `_quantize_*`
# implement the per-channel symmetric quantizer (round-half-to-even,
# saturate to ±max_q, avoid the asymmetric -max_q-1 edge).
# ---------------------------------------------------------------------------


def _np_dtype_for(dtype: str) -> np.dtype:
    """Map a Codec dtype string to a numpy little-endian dtype."""
    mapping = {
        "fp32": np.dtype("<f4"),
        "fp16": np.dtype("<f2"),
        "bf16": np.dtype("<f2"),  # bf16 has no native numpy dtype; servers handle separately
        "int8": np.dtype("<i1"),
        "int4": np.dtype("<i1"),  # placeholder — int4 is bit-packed downstream
    }
    if dtype not in mapping:
        raise ValueError(f"unknown latent dtype {dtype!r}; must be one of {list(mapping)}")
    return mapping[dtype]


def _to_contiguous_le(latent: np.ndarray, dtype: str) -> np.ndarray:
    """Coerce to contiguous, little-endian, target dtype (no copy if already matching)."""
    target = _np_dtype_for(dtype)
    if latent.dtype != target or not latent.flags["C_CONTIGUOUS"]:
        latent = np.ascontiguousarray(latent.astype(target, copy=False))
    return latent


def _compute_scales(latent: np.ndarray) -> np.ndarray:
    """Per-channel max(abs) over the spatial axes. Returns fp16 1-D array, length C."""
    # latent shape is [C, ...spatial]; channel axis is the first axis.
    flat = latent.reshape(latent.shape[0], -1)
    return np.max(np.abs(flat), axis=1).astype(np.float16)


def _quantize_int8(latent: np.ndarray, scales: np.ndarray) -> np.ndarray:
    """Per-channel symmetric int8 quantization with the supplied scales.

    `scales` is fp16 length-C; `latent` is shape [C, ...]. Returns int8 array
    of the same shape as `latent`. Round-half-to-even (numpy default).
    Saturating clamp to [-127, 127]. Channels with scale=0 produce all-zero
    output.
    """
    C = latent.shape[0]
    out = np.zeros_like(latent, dtype=np.int8)
    sf32 = scales.astype(np.float32)
    for c in range(C):
        s = float(sf32[c])
        if s == 0.0:
            continue
        # Cast to fp32 for the multiply-add to avoid fp16 precision artifacts
        # right at the rounding boundary.
        ch = latent[c].astype(np.float32) / s * 127.0
        # numpy.rint = round-half-to-even (matches IEEE 754 roundTiesToEven).
        out[c] = np.clip(np.rint(ch), -127, 127).astype(np.int8)
    return out


def _quantize_int4(latent: np.ndarray, scales: np.ndarray) -> np.ndarray:
    """Per-channel symmetric int4 quantization. Returns int8 array (each value in [-7, 7])."""
    C = latent.shape[0]
    out = np.zeros_like(latent, dtype=np.int8)
    sf32 = scales.astype(np.float32)
    for c in range(C):
        s = float(sf32[c])
        if s == 0.0:
            continue
        ch = latent[c].astype(np.float32) / s * 7.0
        out[c] = np.clip(np.rint(ch), -7, 7).astype(np.int8)
    return out


def _pack_int4_low_first(values: np.ndarray) -> bytes:
    """Pack an array of int4 values (each in [-7, 7]) two-per-byte, low nibble first.

    The low nibble of byte k holds values[2k]; the high nibble holds values[2k+1].
    A trailing odd value zero-pads the high nibble. The stored nibble is the
    two's-complement int4 representation of the signed value.
    """
    flat = values.reshape(-1).astype(np.int8)
    n = flat.size
    # Build a (n_pairs, 2) view, padding with a synthetic zero if odd.
    if n % 2 == 1:
        flat = np.concatenate([flat, np.zeros(1, dtype=np.int8)])
    pairs = flat.reshape(-1, 2)
    lo = (pairs[:, 0] & 0x0F).astype(np.uint8)
    hi = (pairs[:, 1] & 0x0F).astype(np.uint8)
    packed = (lo | (hi << 4)).astype(np.uint8)
    return packed.tobytes()


def _scales_to_bytes(scales: np.ndarray) -> bytes:
    """Pack fp16 scales as little-endian C * 2 bytes."""
    return scales.astype("<f2").tobytes()


def _saturating_int8_diff(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Compute clamp(a - b, -127, 127) in int16 internal arithmetic, return int8."""
    diff = a.astype(np.int16) - b.astype(np.int16)
    return np.clip(diff, -127, 127).astype(np.int8)


def _saturating_int8_add(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Inverse of _saturating_int8_diff for symmetry tests; not used in forward path."""
    s = a.astype(np.int16) + b.astype(np.int16)
    return np.clip(s, -127, 127).astype(np.int8)


def _saturating_int4_diff(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    diff = a.astype(np.int16) - b.astype(np.int16)
    return np.clip(diff, -7, 7).astype(np.int8)


# ---------------------------------------------------------------------------
# GPU fast paths (v0.5+, opt-in via LatentStreamEncoder(gpu_quantize=True))
#
# The torch-on-CUDA path runs the per-channel quantize math on-device, then
# transfers the smaller int8 tensor across PCIe instead of the full fp16/fp32
# latent. Bit-identical to the numpy path under the same scales (required +
# verified by the per-pipeline golden fixtures in
# packages/bench/golden/pipelines/<name>/).
#
# Quantize math reproduces _quantize_int8 / _quantize_int4 exactly:
#   per channel c:
#       if scales[c] == 0: output channel is all zeros
#       else:              clip(round-half-to-even(latent[c] / scales[c] * max_q),
#                               -max_q, +max_q).int8
#
# Round-half-to-even is the default for torch's tensor.round() (matches
# numpy.rint + IEEE 754 roundTiesToEven), so the math is the same.
# ---------------------------------------------------------------------------


def _quantize_int8_gpu(latent: Any, scales: np.ndarray) -> np.ndarray:
    """Quantize a CUDA tensor to int8 on-device, return numpy int8 array.

    Bit-identical to ``_quantize_int8`` under the same ``scales``. Caller MUST
    have already gated this through ``_is_cuda_tensor(latent)``.
    """
    assert _TORCH_AVAILABLE, "_quantize_int8_gpu requires torch"
    # Cast both to fp32 on-device for the multiply/divide; same precision
    # guarantee as the numpy path's "Cast to fp32 to avoid fp16 artifacts".
    lat32 = latent.to(dtype=_torch.float32)
    # scales is shape (C,) on CPU; move to the same device, reshape for broadcast
    # over the spatial axes.
    sc = _torch.from_numpy(scales.astype(np.float32)).to(lat32.device)
    sc_b = sc.reshape((sc.shape[0],) + (1,) * (lat32.ndim - 1))

    # Avoid division-by-zero for channels with scale=0 — output is all-zero
    # for those channels per the numpy spec.
    safe = sc_b.clone()
    safe[safe == 0] = 1.0  # placeholder; we zero those channels post-quantize
    q = (lat32 / safe * 127.0).round().clamp(-127, 127).to(_torch.int8)
    if (sc == 0).any():
        zero_mask = (sc == 0).reshape((sc.shape[0],) + (1,) * (lat32.ndim - 1))
        q = _torch.where(zero_mask, _torch.zeros_like(q), q)
    return q.cpu().numpy()


def _quantize_int4_gpu(latent: Any, scales: np.ndarray) -> np.ndarray:
    """Quantize a CUDA tensor to int4 on-device (returned as int8 in [-7,7]).

    Bit-identical to ``_quantize_int4`` under the same ``scales``.
    """
    assert _TORCH_AVAILABLE, "_quantize_int4_gpu requires torch"
    lat32 = latent.to(dtype=_torch.float32)
    sc = _torch.from_numpy(scales.astype(np.float32)).to(lat32.device)
    sc_b = sc.reshape((sc.shape[0],) + (1,) * (lat32.ndim - 1))
    safe = sc_b.clone()
    safe[safe == 0] = 1.0
    q = (lat32 / safe * 7.0).round().clamp(-7, 7).to(_torch.int8)
    if (sc == 0).any():
        zero_mask = (sc == 0).reshape((sc.shape[0],) + (1,) * (lat32.ndim - 1))
        q = _torch.where(zero_mask, _torch.zeros_like(q), q)
    return q.cpu().numpy()


def _compute_scales_gpu(latent: Any) -> np.ndarray:
    """Per-channel max(abs) on-device, returned as a CPU fp16 numpy array."""
    assert _TORCH_AVAILABLE, "_compute_scales_gpu requires torch"
    flat = latent.reshape(latent.shape[0], -1).abs().amax(dim=1)
    return flat.to(_torch.float16).cpu().numpy()


# ---------------------------------------------------------------------------
# Stateful encoder — holds keyframe state for delta pipelines, dispatches
# to the right pipeline math, emits header + frame bytes.
# ---------------------------------------------------------------------------


class LatentStreamEncoder:
    """
    One encoder per outbound latent stream. Construct with the negotiated
    `(latent_space_id, shape, dtype, pipeline)` from `READY`, then call
    `header()` once and `frame(latent, ...)` per produced latent.

    Static-scale pipelines (`int8`, `int4`) require all per-channel scales
    upfront — pass `static_scales` to the constructor. Adaptive-scale
    pipelines (`int8-adaptive`, `int4-adaptive`) recompute scales each
    keyframe and prepend them to the frame data. Delta pipelines maintain
    the most recent keyframe's quantized values and scales internally.
    """

    def __init__(
        self,
        latent_space_id: str,
        shape: Tuple[int, ...],
        dtype: str,
        pipeline: str,
        *,
        stream_format: str = "msgpack",
        static_scales: Optional[np.ndarray] = None,
        fps: Optional[int] = None,
        total_frames: Optional[int] = None,
        vae_scale_factor: Optional[float] = None,
        gpu_quantize: bool = False,
    ) -> None:
        if pipeline not in PIPELINE_NAMES:
            raise ValueError(
                f"unknown pipeline {pipeline!r}; must be one of {PIPELINE_NAMES}"
            )
        if stream_format not in ("msgpack", "protobuf"):
            raise ValueError(f"stream_format must be 'msgpack' or 'protobuf', got {stream_format!r}")
        if pipeline in _STATIC_SCALE_PIPELINES and static_scales is None:
            raise ValueError(
                f"pipeline {pipeline!r} requires static_scales (per-channel fp16 array)"
            )
        if pipeline not in _STATIC_SCALE_PIPELINES and static_scales is not None:
            raise ValueError(
                f"pipeline {pipeline!r} doesn't accept static_scales — scales travel per-keyframe"
            )

        self.latent_space_id = latent_space_id
        self.shape = tuple(shape)
        self.dtype = dtype
        self.pipeline = pipeline
        self.stream_format = stream_format
        self.fps = fps
        self.total_frames = total_frames
        self.vae_scale_factor = vae_scale_factor
        # v0.5: opt-in torch-on-device quantize fast path. No-op for non-CUDA
        # inputs even when True — the numpy path stays the cross-runtime
        # default. See spec/PIPELINES.md § "Encoder fast paths (v0.5+)".
        self.gpu_quantize = gpu_quantize

        if static_scales is not None:
            scales_fp16 = np.asarray(static_scales, dtype=np.float16)
            if scales_fp16.shape != (self.shape[0],):
                raise ValueError(
                    f"static_scales must have shape ({self.shape[0]},); got {scales_fp16.shape}"
                )
            self._static_scales = scales_fp16
        else:
            self._static_scales = None

        # Delta-pipeline state: last keyframe's quantized tensor + its scales.
        self._last_keyframe_q: Optional[np.ndarray] = None
        self._last_keyframe_scales: Optional[np.ndarray] = None
        self._last_seq: int = -1

    # ── Header ────────────────────────────────────────────────────────────

    def header(self) -> bytes:
        scales_bytes = (
            _scales_to_bytes(self._static_scales)
            if self._static_scales is not None else None
        )
        if self.stream_format == "msgpack":
            return encode_latent_header_msgpack(
                latent_space_id=self.latent_space_id,
                shape=self.shape,
                dtype=self.dtype,
                pipeline=self.pipeline,
                scales=scales_bytes,
                fps=self.fps,
                total_frames=self.total_frames,
                vae_scale_factor=self.vae_scale_factor,
            )
        return encode_latent_header_protobuf(
            latent_space_id=self.latent_space_id,
            shape=self.shape,
            dtype=self.dtype,
            pipeline=self.pipeline,
            scales=scales_bytes,
            fps=self.fps,
            total_frames=self.total_frames,
            vae_scale_factor=self.vae_scale_factor,
        )

    # ── Per-frame ─────────────────────────────────────────────────────────

    def frame(
        self,
        latent: Any,
        *,
        seq: int,
        keyframe: bool,
        done: bool = False,
        finish_reason: Optional[str] = None,
    ) -> bytes:
        if seq <= self._last_seq:
            raise ValueError(
                f"seq must be monotonically increasing; got {seq} after {self._last_seq}"
            )
        if tuple(latent.shape) != self.shape:
            raise ValueError(
                f"latent shape {tuple(latent.shape)} does not match stream shape {self.shape}"
            )
        # GPU fast path only kicks in when gpu_quantize was opted in AND the
        # input is a CUDA tensor. Non-CUDA torch tensors and numpy arrays
        # always take the numpy path, even with gpu_quantize=True — the flag
        # is advisory; the runtime decides per frame.
        if not (self.gpu_quantize and _is_cuda_tensor(latent)):
            latent = _to_numpy_for_quantize(latent)

        # Apply the configured pipeline.
        data = self._encode_pipeline(latent, keyframe=keyframe)
        self._last_seq = seq

        if self.stream_format == "msgpack":
            return encode_latent_frame_msgpack(
                data=data,
                seq=seq,
                keyframe=keyframe,
                done=done,
                finish_reason=finish_reason,
            )
        return encode_latent_frame_protobuf(
            data=data,
            seq=seq,
            keyframe=keyframe,
            done=done,
            finish_reason=finish_reason,
        )

    # ── Pipeline dispatch ─────────────────────────────────────────────────

    def _compute_scales_dispatch(self, latent: Any) -> np.ndarray:
        if _is_cuda_tensor(latent):
            return _compute_scales_gpu(latent)
        return _compute_scales(latent)

    def _quantize_int8_dispatch(self, latent: Any, scales: np.ndarray) -> np.ndarray:
        if _is_cuda_tensor(latent):
            return _quantize_int8_gpu(latent, scales)
        return _quantize_int8(latent, scales)

    def _quantize_int4_dispatch(self, latent: Any, scales: np.ndarray) -> np.ndarray:
        if _is_cuda_tensor(latent):
            return _quantize_int4_gpu(latent, scales)
        return _quantize_int4(latent, scales)

    def _encode_pipeline(self, latent: Any, *, keyframe: bool) -> bytes:
        p = self.pipeline
        if p == "raw":
            # Raw has no quantize step; if we're handed a CUDA tensor, the
            # caller paid the full PCIe transfer here.
            if _is_cuda_tensor(latent):
                latent = latent.cpu().numpy()
            return _to_contiguous_le(latent, self.dtype).tobytes()

        if p == "int8":
            assert self._static_scales is not None
            q = self._quantize_int8_dispatch(latent, self._static_scales)
            return q.tobytes()

        if p == "int4":
            assert self._static_scales is not None
            q = self._quantize_int4_dispatch(latent, self._static_scales)
            return _pack_int4_low_first(q)

        if p == "int8-adaptive":
            if not keyframe:
                raise ValueError(
                    "int8-adaptive: every frame must be keyframe=True (delta is unsupported)"
                )
            scales = self._compute_scales_dispatch(latent)
            q = self._quantize_int8_dispatch(latent, scales)
            return _scales_to_bytes(scales) + q.tobytes()

        if p == "int4-adaptive":
            if not keyframe:
                raise ValueError(
                    "int4-adaptive: every frame must be keyframe=True (delta is unsupported)"
                )
            scales = self._compute_scales_dispatch(latent)
            q = self._quantize_int4_dispatch(latent, scales)
            return _scales_to_bytes(scales) + _pack_int4_low_first(q)

        if p == "delta+int8":
            if keyframe:
                scales = self._compute_scales_dispatch(latent)
                q = self._quantize_int8_dispatch(latent, scales)
                self._last_keyframe_q = q
                self._last_keyframe_scales = scales
                return _scales_to_bytes(scales) + q.tobytes()
            else:
                if self._last_keyframe_q is None:
                    raise ValueError(
                        "delta+int8: first frame in stream must be keyframe=True"
                    )
                # Quantize current latent against the keyframe's scales (consistent grid).
                q_now = self._quantize_int8_dispatch(latent, self._last_keyframe_scales)
                residual = _saturating_int8_diff(q_now, self._last_keyframe_q)
                return residual.tobytes()

        if p == "delta+int4":
            if keyframe:
                scales = self._compute_scales_dispatch(latent)
                q = self._quantize_int4_dispatch(latent, scales)
                self._last_keyframe_q = q
                self._last_keyframe_scales = scales
                return _scales_to_bytes(scales) + _pack_int4_low_first(q)
            else:
                if self._last_keyframe_q is None:
                    raise ValueError(
                        "delta+int4: first frame in stream must be keyframe=True"
                    )
                q_now = self._quantize_int4_dispatch(latent, self._last_keyframe_scales)
                residual = _saturating_int4_diff(q_now, self._last_keyframe_q)
                return _pack_int4_low_first(residual)

        raise AssertionError(f"unhandled pipeline {p!r}")  # pragma: no cover


# ---------------------------------------------------------------------------
# MessagePack encoders (free functions; vendored copies in forks call these
# directly without instantiating LatentStreamEncoder)
# ---------------------------------------------------------------------------

_msgpack_encoder = msgspec.msgpack.Encoder()


def encode_latent_header_msgpack(
    *,
    latent_space_id: str,
    shape: Tuple[int, ...],
    dtype: str,
    pipeline: str,
    scales: Optional[bytes] = None,
    fps: Optional[int] = None,
    total_frames: Optional[int] = None,
    vae_scale_factor: Optional[float] = None,
) -> bytes:
    """Encode a LatentStreamHeader as a single msgpack map. The first frame
    of any latent stream MUST be a header; subsequent frames are LatentFrames.
    """
    msg: dict = {
        "type": "header",
        "latent_space_id": latent_space_id,
        "shape": list(shape),
        "dtype": dtype,
        "pipeline": pipeline,
    }
    if scales is not None:
        msg["scales"] = scales
    if fps is not None:
        msg["fps"] = fps
    if total_frames is not None:
        msg["total_frames"] = total_frames
    if vae_scale_factor is not None:
        msg["vae_scale_factor"] = vae_scale_factor
    return _msgpack_encoder.encode(msg)


def encode_latent_frame_msgpack(
    *,
    data: bytes,
    seq: int,
    keyframe: bool,
    done: bool,
    finish_reason: Optional[str] = None,
) -> bytes:
    msg: dict = {
        "data": data,
        "seq": seq,
        "keyframe": keyframe,
        "done": done,
    }
    if finish_reason is not None:
        msg["finish_reason"] = finish_reason
    return _msgpack_encoder.encode(msg)


# ---------------------------------------------------------------------------
# Protobuf encoders (hand-rolled; same style as text-side codec_frame.py)
# ---------------------------------------------------------------------------


def _varint(n: int) -> bytes:
    parts: list[int] = []
    while True:
        bits = n & 0x7F
        n >>= 7
        if n == 0:
            parts.append(bits)
            break
        parts.append(bits | 0x80)
    return bytes(parts)


def _tag(field: int, wire_type: int) -> bytes:
    return _varint((field << 3) | wire_type)


def _length_delim_field(field: int, payload: bytes) -> bytes:
    return _tag(field, 2) + _varint(len(payload)) + payload


def _string_field(field: int, s: str) -> bytes:
    return _length_delim_field(field, s.encode("utf-8"))


def _bool_field(field: int, b: bool) -> bytes:
    return _tag(field, 0) + (b"\x01" if b else b"\x00")


def _uint32_field(field: int, n: int) -> bytes:
    return _tag(field, 0) + _varint(n)


def _packed_uint32_field(field: int, values: Tuple[int, ...]) -> bytes:
    payload = b"".join(_varint(v) for v in values)
    return _length_delim_field(field, payload)


def _float_field(field: int, f: float) -> bytes:
    # Wire type 5 = 32-bit fixed (little-endian)
    return _tag(field, 5) + struct.pack("<f", f)


def encode_latent_header_protobuf(
    *,
    latent_space_id: str,
    shape: Tuple[int, ...],
    dtype: str,
    pipeline: str,
    scales: Optional[bytes] = None,
    fps: Optional[int] = None,
    total_frames: Optional[int] = None,
    vae_scale_factor: Optional[float] = None,
) -> bytes:
    """Encode a LatentStreamHeader protobuf prefixed by a 4-byte big-endian
    length, matching the text-side CodecFrame envelope."""
    parts: list[bytes] = []
    parts.append(_string_field(1, latent_space_id))
    parts.append(_packed_uint32_field(2, tuple(shape)))
    parts.append(_string_field(3, dtype))
    parts.append(_string_field(4, pipeline))
    if scales is not None:
        parts.append(_length_delim_field(5, scales))
    if fps is not None:
        parts.append(_uint32_field(6, fps))
    if total_frames is not None:
        parts.append(_uint32_field(7, total_frames))
    if vae_scale_factor is not None:
        parts.append(_float_field(8, vae_scale_factor))
    payload = b"".join(parts)
    return struct.pack(">I", len(payload)) + payload


def encode_latent_frame_protobuf(
    *,
    data: bytes,
    seq: int,
    keyframe: bool,
    done: bool,
    finish_reason: Optional[str] = None,
) -> bytes:
    parts: list[bytes] = [
        _length_delim_field(1, data),
        _uint32_field(2, seq),
        _bool_field(3, keyframe),
        _bool_field(4, done),
    ]
    if finish_reason is not None:
        parts.append(_string_field(5, finish_reason))
    payload = b"".join(parts)
    return struct.pack(">I", len(payload)) + payload
