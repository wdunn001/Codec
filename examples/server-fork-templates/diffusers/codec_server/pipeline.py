"""
Diffusers pipeline runner: loads a checkpoint, runs sampling up to (but
not including) VAE decode, returns the latent tensor that
LatentStreamEncoder serializes.

This is the only place the template touches torch + diffusers internals.
The wire surface (FastAPI routes in app.py) calls into here for "give me
a latent for this prompt" and never sees the model directly.

Latent capture point
--------------------
For text-to-image, we use diffusers' `output_type="latent"` argument,
which is the official supported way to skip VAE decode:

    result = pipe(prompt, output_type="latent")
    latent = result.images[0]   # tensor shape [C, H, W]

The latent is in the model's native scale (i.e. NOT divided by
vae_scale_factor: that happens inside vae.decode). The bench/golden
reference image performs `vae.decode(latent / scale_factor)` on these
exact bytes, so the perceptual contract is "the latent server emits
matches the latent the golden image decodes."

For text-to-video / image-to-video (StableVideoDiffusion, AnimateDiff,
CogVideoX), the same pattern holds: the pipeline returns latents of
shape [N, C, H, W] for N frames and we yield them one LatentFrame at
a time.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Iterable, List, Optional

import numpy as np
import torch
from diffusers import (
    AutoPipelineForText2Image,
    DiffusionPipeline,
    StableVideoDiffusionPipeline,
)


@dataclass
class LatentResult:
    """One image or video's worth of latents, ready for LatentStreamEncoder."""

    latents: List[np.ndarray]   # one entry per frame; image = single-element list
    shape: tuple                # per-frame latent shape, channel-first (matches LatentStreamHeader.shape)
    fps: Optional[int]          # video only
    generation_ms: float        # wall-clock from request to latent-tensor-ready


class LatentPipelineRunner:
    """Loads a diffusers checkpoint once, serves repeated generation
    requests against it. Thread-unsafe by design: the FastAPI app
    serializes calls behind a per-pipeline asyncio.Lock.
    """

    def __init__(
        self,
        model_id: str,
        latent_space_id: str,
        device: str = "cuda",
        torch_dtype: str = "float16",
    ) -> None:
        self.model_id = model_id
        self.latent_space_id = latent_space_id
        self.device = device if torch.cuda.is_available() else "cpu"
        self.torch_dtype = self._resolve_dtype(torch_dtype)
        self._pipe: Optional[DiffusionPipeline] = None
        self._video_pipe: Optional[StableVideoDiffusionPipeline] = None
        self._lock = asyncio.Lock()

    @staticmethod
    def _resolve_dtype(name: str) -> torch.dtype:
        return {
            "float16": torch.float16,
            "fp16":    torch.float16,
            "bfloat16": torch.bfloat16,
            "bf16":     torch.bfloat16,
            "float32":  torch.float32,
            "fp32":     torch.float32,
        }.get(name.lower(), torch.float16)

    async def preload(self) -> None:
        """Eagerly load the image pipeline. Video pipeline is loaded lazily
        on the first /v1/videos request because most installs don't need it
        and SVD is heavy."""
        async with self._lock:
            if self._pipe is None:
                self._pipe = await asyncio.get_event_loop().run_in_executor(
                    None, self._load_image_pipe,
                )

    def _load_image_pipe(self) -> DiffusionPipeline:
        pipe = AutoPipelineForText2Image.from_pretrained(
            self.model_id,
            torch_dtype=self.torch_dtype,
            safety_checker=None,
            requires_safety_checker=False,
        )
        pipe = pipe.to(self.device)
        # Performance: we never want decoded pixels back, so the VAE
        # decoder weights are unused on the hot path. Keep them loaded for
        # clients that downgrade to server-side render fallback per the
        # spec, but mark eval mode to avoid grad bookkeeping.
        if hasattr(pipe, "vae"):
            pipe.vae.eval()
        return pipe

    def _load_video_pipe(self) -> StableVideoDiffusionPipeline:
        # Replace with the appropriate video pipeline class for the
        # configured latent_space (SVD, CogVideoX, etc.). The fork
        # integrator picks one per their target use case.
        pipe = StableVideoDiffusionPipeline.from_pretrained(
            self.model_id,
            torch_dtype=self.torch_dtype,
        )
        pipe = pipe.to(self.device)
        return pipe

    async def generate_image_latent(
        self,
        *,
        prompt: str,
        size: tuple,
        steps: int,
        seed: int,
    ) -> LatentResult:
        """Run text-to-image up to (but not including) VAE decode. Returns
        the latent tensor as a single-frame LatentResult."""
        async with self._lock:
            if self._pipe is None:
                self._pipe = await asyncio.get_event_loop().run_in_executor(
                    None, self._load_image_pipe,
                )

            t0 = time.perf_counter()
            generator = torch.Generator(device=self.device).manual_seed(seed)
            with torch.no_grad():
                result = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._pipe(
                        prompt=prompt,
                        height=size[1],
                        width=size[0],
                        num_inference_steps=steps,
                        output_type="latent",
                        generator=generator,
                    ),
                )
            elapsed = (time.perf_counter() - t0) * 1000.0

        # diffusers returns a tensor on the model's device; pull to CPU + numpy
        # so the encoder can run pipeline math on plain ndarrays.
        latent_t = result.images[0]  # shape [C, H, W]
        latent_np = latent_t.detach().to(torch.float16).cpu().numpy()
        return LatentResult(
            latents=[latent_np],
            shape=tuple(latent_np.shape),
            fps=None,
            generation_ms=elapsed,
        )

    async def generate_video_latents(
        self,
        *,
        prompt: str,
        resolution: int,
        fps: int,
        frames: int,
        steps: int,
        seed: int,
    ) -> LatentResult:
        """Run video pipeline up to (but not including) VAE decode. Returns
        all frames' latents as a multi-element LatentResult.

        Note: most diffusers video pipelines accept an image conditioner
        rather than a text prompt (SVD specifically needs an image). For
        a text-driven video flow, swap the pipeline class to one of
        AnimateDiff / CogVideoX / etc. The latent-capture pattern is the
        same.
        """
        async with self._lock:
            if self._video_pipe is None:
                self._video_pipe = await asyncio.get_event_loop().run_in_executor(
                    None, self._load_video_pipe,
                )
            t0 = time.perf_counter()
            generator = torch.Generator(device=self.device).manual_seed(seed)
            # Replace this stub once you've picked the video pipeline:
            raise NotImplementedError(
                "video latent generation: replace _load_video_pipe and this call "
                "site with the pipeline class that matches the configured "
                f"latent_space ({self.latent_space_id}). The capture pattern is "
                "the same as image: call the pipeline with output_type='latent', "
                "iterate the result tensor frame-by-frame."
            )
