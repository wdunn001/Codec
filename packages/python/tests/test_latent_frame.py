"""LatentStreamEncoder tests: exercises the seven-pipeline forward path.

Adds the v0.5 ``gpu_quantize`` opt-in contract on top of the existing
pipeline math: with numpy input the flag MUST be a no-op (bytes identical
to the gpu_quantize=False path). The constructor MUST also accept it
unconditionally even when torch isn't installed.

Bit-identity against the true torch-CUDA path is verified separately by
the cross-stack bench cohort (which runs on a GPU box). This suite stays
hermetic: no torch dependency required.
"""
from __future__ import annotations

import numpy as np
import pytest

from codecai.server.latent_frame import (
    LatentStreamEncoder,
    PIPELINE_NAMES,
)


def _make_latent(shape=(4, 8, 8), seed=42):
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(shape) * 2.0 - 0.5).astype(np.float32)


# ── Pipeline forward path: bytes are stable + non-empty ────────────────────


@pytest.mark.parametrize(
    "pipeline,needs_static_scales",
    [
        ("raw", False),
        ("int8", True),
        ("int4", True),
        ("int8-adaptive", False),
        ("int4-adaptive", False),
        ("delta+int8", False),
        ("delta+int4", False),
    ],
)
def test_pipeline_produces_bytes(pipeline: str, needs_static_scales: bool) -> None:
    latent = _make_latent()
    kw = {}
    if needs_static_scales:
        kw["static_scales"] = np.ones(latent.shape[0], dtype=np.float16)

    enc = LatentStreamEncoder(
        latent_space_id="test/synth",
        shape=latent.shape,
        dtype="fp32",
        pipeline=pipeline,
        **kw,
    )
    header = enc.header()
    assert isinstance(header, bytes) and len(header) > 0

    frame = enc.frame(latent, seq=0, keyframe=True, done=False)
    assert isinstance(frame, bytes) and len(frame) > 0


def test_pipeline_registry_complete() -> None:
    """If a new pipeline name lands in PIPELINE_NAMES, the test above must
    grow a row for it: this guards against silently un-tested pipelines."""
    parametrised = {
        "raw", "int8", "int4", "int8-adaptive", "int4-adaptive",
        "delta+int8", "delta+int4",
    }
    assert set(PIPELINE_NAMES) == parametrised


# ── gpu_quantize: constructor contract (v0.5) ──────────────────────────────


def test_gpu_quantize_kwarg_defaults_to_false() -> None:
    enc = LatentStreamEncoder(
        latent_space_id="test/synth",
        shape=(2, 4, 4),
        dtype="fp32",
        pipeline="int8-adaptive",
    )
    assert enc.gpu_quantize is False


def test_gpu_quantize_kwarg_stored() -> None:
    enc = LatentStreamEncoder(
        latent_space_id="test/synth",
        shape=(2, 4, 4),
        dtype="fp32",
        pipeline="int8-adaptive",
        gpu_quantize=True,
    )
    assert enc.gpu_quantize is True


# ── gpu_quantize=True is a no-op for non-CUDA inputs ───────────────────────


@pytest.mark.parametrize(
    "pipeline,needs_static_scales",
    [
        ("raw", False),
        ("int8", True),
        ("int4", True),
        ("int8-adaptive", False),
        ("int4-adaptive", False),
        ("delta+int8", False),
        ("delta+int4", False),
    ],
)
def test_gpu_quantize_true_is_noop_for_numpy_input(
    pipeline: str, needs_static_scales: bool
) -> None:
    """The v0.5 contract: gpu_quantize is advisory. For numpy/CPU-torch
    input, the numpy path runs regardless and produces identical bytes."""
    latent = _make_latent()
    kw = {}
    if needs_static_scales:
        kw["static_scales"] = np.ones(latent.shape[0], dtype=np.float16)

    enc_cpu = LatentStreamEncoder(
        latent_space_id="test/synth",
        shape=latent.shape,
        dtype="fp32",
        pipeline=pipeline,
        gpu_quantize=False,
        **kw,
    )
    enc_gpu_flag = LatentStreamEncoder(
        latent_space_id="test/synth",
        shape=latent.shape,
        dtype="fp32",
        pipeline=pipeline,
        gpu_quantize=True,
        **kw,
    )

    # First frame: keyframe.
    bytes_cpu = enc_cpu.frame(latent, seq=0, keyframe=True)
    bytes_gpu = enc_gpu_flag.frame(latent, seq=0, keyframe=True)
    assert bytes_cpu == bytes_gpu, (
        f"pipeline={pipeline!r}: gpu_quantize=True changed numpy-path output bytes"
    )


def test_gpu_quantize_delta_chain_bit_identical_for_numpy() -> None:
    """Delta pipelines are stateful: verify the full keyframe + delta
    sequence matches between gpu_quantize=False and True with numpy input.
    """
    rng = np.random.default_rng(7)
    shape = (3, 6, 6)
    frames = [rng.standard_normal(shape).astype(np.float32) for _ in range(4)]

    enc_cpu = LatentStreamEncoder(
        latent_space_id="test/synth",
        shape=shape,
        dtype="fp32",
        pipeline="delta+int8",
        gpu_quantize=False,
    )
    enc_gpu = LatentStreamEncoder(
        latent_space_id="test/synth",
        shape=shape,
        dtype="fp32",
        pipeline="delta+int8",
        gpu_quantize=True,
    )

    for i, lat in enumerate(frames):
        kf = i == 0
        bytes_cpu = enc_cpu.frame(lat, seq=i, keyframe=kf, done=(i == len(frames) - 1))
        bytes_gpu = enc_gpu.frame(lat, seq=i, keyframe=kf, done=(i == len(frames) - 1))
        assert bytes_cpu == bytes_gpu, f"delta+int8 frame {i} (keyframe={kf}) bytes differ"


# ── Torch tensor input (CPU): handled transparently ────────────────────────


def test_torch_cpu_tensor_input_routes_through_numpy_path() -> None:
    """Catching torch tensors on CPU is the no-CUDA half of the contract:
    even with gpu_quantize=True the input is converted to numpy and runs
    the standard numpy path. Skipped when torch isn't installed."""
    torch = pytest.importorskip("torch")
    rng = np.random.default_rng(11)
    arr_np = rng.standard_normal((2, 4, 4)).astype(np.float32)
    arr_torch = torch.from_numpy(arr_np)
    assert not arr_torch.is_cuda

    enc_np = LatentStreamEncoder(
        latent_space_id="test/synth",
        shape=arr_np.shape,
        dtype="fp32",
        pipeline="int8-adaptive",
        gpu_quantize=True,
    )
    enc_torch = LatentStreamEncoder(
        latent_space_id="test/synth",
        shape=arr_np.shape,
        dtype="fp32",
        pipeline="int8-adaptive",
        gpu_quantize=True,
    )

    bytes_np = enc_np.frame(arr_np, seq=0, keyframe=True)
    bytes_torch = enc_torch.frame(arr_torch, seq=0, keyframe=True)
    assert bytes_np == bytes_torch
