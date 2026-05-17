"""
codec_endpoints.py — Codec v0.3 latent-modality REST endpoints for ComfyUI.

Drops into the wdunn001/ComfyUI fork's `feat/codec-latent-transport`
branch at:

    <ComfyUI>/app/codec_endpoints.py

…and is imported once from the fork's `main.py` (or any startup hook
ComfyUI loads at boot — `extra_model_paths.yaml` won't suffice). The
import has a side-effect: it registers POST routes on the running
aiohttp server via `server.PromptServer.instance.routes`. After import,
ComfyUI exposes:

    POST /v1/images/generations
    POST /v1/videos/generations
    GET  /codec/info
    GET  /codec/schema
    GET  /codec/health      (alongside ComfyUI's own /system_stats)

This template uses diffusers directly inside ComfyUI's process —
bypassing ComfyUI's workflow graph and KSampler — for the first cut.
That keeps the integration small and lets us share latent-capture math
with the diffusers fork. A fuller integration that hooks into ComfyUI's
native sampler (so a user-supplied workflow's KSampler output can stream
out as codec latents) is a follow-up; the entry points stay the same.

VENDORING REQUIREMENT
---------------------
This file imports `latent_frame` as a peer module. The fork integrator
must vendor a copy of:

    <codec-repo>/packages/python/src/codecai/server/latent_frame.py

…into the same directory as this file:

    <ComfyUI>/app/latent_frame.py

…before the import will resolve. Do NOT modify the vendored file —
it's the canonical seven-pipeline forward encoder pinned by
spec/PIPELINES.md.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import time
from dataclasses import dataclass
from typing import AsyncIterator, Optional, Tuple

import numpy as np
import torch
from aiohttp import web

# ComfyUI's server singleton — registered route table lives at
# server.PromptServer.instance.routes.
import server  # type: ignore

# Vendored from packages/python/src/codecai/server/latent_frame.py.
# Same-directory import. Do NOT modify the vendored copy.
from .latent_frame import (
    LatentStreamEncoder,
    PIPELINE_NAMES,
    PROTO_SCHEMA,
)


# ── Configuration ──────────────────────────────────────────────────────────


@dataclass
class CodecConfig:
    model:                str
    latent_space:         str
    image_pipelines:      list
    video_pipelines:      list
    latent_map_url:       Optional[str]
    latent_map_sha256:    Optional[str]
    latent_dicts_dir:     str
    device:               str
    torch_dtype:          str

    @classmethod
    def from_env(cls) -> "CodecConfig":
        return cls(
            model=os.environ.get(
                "CODEC_INITIAL_MODEL", "stabilityai/stable-diffusion-2-1-base",
            ),
            latent_space=os.environ.get(
                "CODEC_INITIAL_LATENT_SPACE", "stabilityai/sd-vae-ft-mse",
            ),
            image_pipelines=["raw", "int8", "int4"],
            video_pipelines=[
                "raw", "int8-adaptive", "int4-adaptive",
                "delta+int8", "delta+int4",
            ],
            latent_map_url=os.environ.get("CODEC_LATENT_MAP_URL"),
            latent_map_sha256=os.environ.get("CODEC_LATENT_MAP_SHA256"),
            latent_dicts_dir=os.environ.get(
                "CODEC_LATENT_DICTS_DIR", "/opt/codec/dicts/latents",
            ),
            device="cuda" if torch.cuda.is_available() else "cpu",
            torch_dtype="float16",
        )


CONFIG = CodecConfig.from_env()


# ── Latent generation (diffusers-direct, bypasses ComfyUI workflows) ──────


class _LatentRunner:
    """Lazy-loaded diffusers pipeline. Image done; video stub raises until
    the integrator picks the appropriate diffusers video pipeline class
    for the configured latent_space."""

    def __init__(self) -> None:
        self._pipe = None
        self._video_pipe = None
        self._lock = asyncio.Lock()

    def _load_image_pipe(self):
        from diffusers import AutoPipelineForText2Image
        dtype = torch.float16 if CONFIG.torch_dtype == "float16" else torch.float32
        pipe = AutoPipelineForText2Image.from_pretrained(
            CONFIG.model,
            torch_dtype=dtype,
            safety_checker=None,
            requires_safety_checker=False,
        )
        pipe = pipe.to(CONFIG.device)
        if hasattr(pipe, "vae"):
            pipe.vae.eval()
        return pipe

    async def image_latent(
        self,
        *,
        prompt: str,
        size: Tuple[int, int],
        steps: int,
        seed: int,
    ) -> Tuple[np.ndarray, float]:
        async with self._lock:
            if self._pipe is None:
                loop = asyncio.get_event_loop()
                self._pipe = await loop.run_in_executor(None, self._load_image_pipe)
            t0 = time.perf_counter()
            generator = torch.Generator(device=CONFIG.device).manual_seed(seed)
            with torch.no_grad():
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(
                    None,
                    lambda: self._pipe(
                        prompt=prompt,
                        height=size[1], width=size[0],
                        num_inference_steps=steps,
                        output_type="latent",
                        generator=generator,
                    ),
                )
            elapsed = (time.perf_counter() - t0) * 1000.0
        latent = result.images[0].detach().to(torch.float16).cpu().numpy()
        return latent, elapsed

    async def video_latents(self, **kwargs):
        # Replace with the appropriate video pipeline matching
        # CONFIG.latent_space. SVD example:
        #
        #     from diffusers import StableVideoDiffusionPipeline
        #     self._video_pipe = StableVideoDiffusionPipeline.from_pretrained(
        #         CONFIG.model, torch_dtype=torch.float16,
        #     ).to(CONFIG.device)
        #     result = self._video_pipe(image=cond_image, ..., output_type="latent")
        #     return [f.detach().to(torch.float16).cpu().numpy() for f in result.frames[0]]
        raise NotImplementedError(
            "video latent generation: pick the diffusers video pipeline class "
            f"for {CONFIG.latent_space!r} (StableVideoDiffusion / AnimateDiff / "
            "CogVideoX / etc.) and wire it the same way image is wired in "
            "_load_image_pipe + image_latent."
        )


_RUNNER = _LatentRunner()


# ── Request validation ────────────────────────────────────────────────────


def _parse_size(s: str) -> Tuple[int, int]:
    try:
        w, h = s.lower().split("x")
        return int(w), int(h)
    except Exception:
        raise web.HTTPBadRequest(reason=f"size must be like '512x512', got {s!r}")


def _validate_modality_pipeline(modality: str, pipeline: str) -> None:
    if pipeline not in PIPELINE_NAMES:
        raise web.HTTPBadRequest(
            reason=f"pipeline {pipeline!r} not in registry; must be one of {PIPELINE_NAMES}",
        )
    if modality == "image-latents":
        allowed = CONFIG.image_pipelines
    elif modality == "video-latents":
        allowed = CONFIG.video_pipelines
    else:
        raise web.HTTPBadRequest(
            reason=f"modality must be image-latents or video-latents, got {modality!r}",
        )
    if pipeline not in allowed:
        raise web.HTTPBadRequest(
            reason=f"pipeline {pipeline!r} not supported for {modality}; "
                   f"this engine supports {allowed} (`raw` is always supported as fallback)",
        )


def _resolve_stream_format(body: dict, accept_header: str) -> str:
    explicit = body.get("stream_format")
    if explicit in ("msgpack", "protobuf"):
        return explicit
    if "x-protobuf" in accept_header:
        return "protobuf"
    if "x-msgpack" in accept_header:
        return "msgpack"
    return "msgpack"


def _content_type(stream_format: str) -> str:
    return (
        "application/x-protobuf" if stream_format == "protobuf"
        else "application/x-msgpack"
    )


def _build_encoder(
    *,
    shape: tuple,
    pipeline: str,
    stream_format: str,
    first_latent: np.ndarray,
    fps: Optional[int],
    total_frames: Optional[int],
) -> LatentStreamEncoder:
    static_scales = None
    if pipeline in ("int8", "int4"):
        static_scales = np.max(
            np.abs(first_latent.reshape(first_latent.shape[0], -1)), axis=1,
        ).astype(np.float16)
    return LatentStreamEncoder(
        latent_space_id=CONFIG.latent_space,
        shape=tuple(shape),
        dtype="fp16",
        pipeline=pipeline,
        stream_format=stream_format,
        static_scales=static_scales,
        fps=fps,
        total_frames=total_frames,
        # v0.5: when CODEC_GPU_QUANTIZE=1 is set in the engine env, opt
        # the encoder into the torch-on-device fast path. Caller still has
        # to hand the encoder a torch.cuda.Tensor on each .frame(...) call
        # for the GPU path to actually fire; numpy + CPU torch inputs fall
        # through to the cross-runtime numpy path unchanged.
        gpu_quantize=bool(int(os.environ.get("CODEC_GPU_QUANTIZE", "0"))),
    )


# ── Streaming response helpers ────────────────────────────────────────────


async def _send_stream(
    request: web.Request,
    *,
    content_type: str,
    headers: dict,
    chunks: AsyncIterator[bytes],
) -> web.StreamResponse:
    resp = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": content_type,
            "Cache-Control": "no-store",
            **{k: v for k, v in headers.items() if v},
        },
    )
    await resp.prepare(request)
    async for chunk in chunks:
        await resp.write(chunk)
    await resp.write_eof()
    return resp


# ── Route handlers ────────────────────────────────────────────────────────


async def _handler_images_generations(request: web.Request) -> web.StreamResponse:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise web.HTTPBadRequest(reason="request body must be JSON")

    modality = body.get("modality", "image-latents")
    if modality != "image-latents":
        raise web.HTTPBadRequest(
            reason=f"/v1/images/generations is image-latents only; got {modality!r}",
        )
    latent_space = body.get("latent_space", CONFIG.latent_space)
    if latent_space != CONFIG.latent_space:
        raise web.HTTPBadRequest(
            reason=f"server is loaded for {CONFIG.latent_space!r}, "
                   f"client requested {latent_space!r}",
        )
    pipeline = body.get("pipeline", "raw")
    _validate_modality_pipeline(modality, pipeline)
    size = _parse_size(body.get("size", "512x512"))
    steps = int(body.get("steps", 25))
    seed = int(body.get("seed", 42))
    prompt = body.get("prompt", "")
    if not prompt:
        raise web.HTTPBadRequest(reason="prompt is required")

    stream_format = _resolve_stream_format(body, request.headers.get("Accept", ""))

    latent, gen_ms = await _RUNNER.image_latent(
        prompt=prompt, size=size, steps=steps, seed=seed,
    )
    encoder = _build_encoder(
        shape=latent.shape,
        pipeline=pipeline,
        stream_format=stream_format,
        first_latent=latent,
        fps=None,
        total_frames=1,
    )

    async def chunks() -> AsyncIterator[bytes]:
        yield encoder.header()
        yield encoder.frame(latent, seq=0, keyframe=True, done=True, finish_reason="ok")

    return await _send_stream(
        request,
        content_type=_content_type(stream_format),
        headers={
            "Codec-Latent-Map": CONFIG.latent_map_sha256 or "",
            "X-Codec-Generation-Ms": f"{gen_ms:.1f}",
        },
        chunks=chunks(),
    )


async def _handler_videos_generations(request: web.Request) -> web.StreamResponse:
    body = await request.json()
    modality = body.get("modality", "video-latents")
    if modality != "video-latents":
        raise web.HTTPBadRequest(reason=f"/v1/videos/generations is video-latents only")
    latent_space = body.get("latent_space", CONFIG.latent_space)
    if latent_space != CONFIG.latent_space:
        raise web.HTTPBadRequest(reason="latent_space mismatch")
    pipeline = body.get("pipeline", "raw")
    _validate_modality_pipeline(modality, pipeline)

    fps = int(body.get("fps", 24))
    frames = int(body.get("frames", 24))
    keyframe_interval = int(body.get("keyframe_interval", 24))

    stream_format = _resolve_stream_format(body, request.headers.get("Accept", ""))

    latents = await _RUNNER.video_latents(
        prompt=body.get("prompt", ""),
        resolution=int(body.get("resolution", 512)),
        fps=fps,
        frames=frames,
        steps=int(body.get("steps", 25)),
        seed=int(body.get("seed", 42)),
    )

    encoder = _build_encoder(
        shape=latents[0].shape,
        pipeline=pipeline,
        stream_format=stream_format,
        first_latent=latents[0],
        fps=fps,
        total_frames=frames,
    )

    async def chunks() -> AsyncIterator[bytes]:
        yield encoder.header()
        n = len(latents)
        for i, latent in enumerate(latents):
            is_keyframe = (i == 0) or (i % keyframe_interval == 0)
            yield encoder.frame(
                latent, seq=i, keyframe=is_keyframe, done=(i == n - 1),
                finish_reason="ok" if i == n - 1 else None,
            )

    return await _send_stream(
        request,
        content_type=_content_type(stream_format),
        headers={"Codec-Latent-Map": CONFIG.latent_map_sha256 or ""},
        chunks=chunks(),
    )


async def _handler_codec_info(_: web.Request) -> web.Response:
    return web.json_response({
        "modality_supported":      ["image-latents", "video-latents"],
        "stream_format_supported": ["msgpack", "protobuf"],
        "compression_supported":   ["identity", "gzip"],
        "image_pipelines":         CONFIG.image_pipelines,
        "video_pipelines":         CONFIG.video_pipelines,
        "latent_space_id":         CONFIG.latent_space,
        "latent_map_url":          CONFIG.latent_map_url,
        "latent_map_sha256":       CONFIG.latent_map_sha256,
        "model":                   CONFIG.model,
        "engine":                  "comfyui",
        "codec_version":           "0.3",
    })


async def _handler_codec_schema(_: web.Request) -> web.Response:
    return web.Response(text=PROTO_SCHEMA, content_type="text/plain")


async def _handler_codec_health(_: web.Request) -> web.Response:
    return web.json_response({
        "ok": True,
        "model": CONFIG.model,
        "latent_space": CONFIG.latent_space,
    })


# ── Route registration (side-effect on import) ────────────────────────────
#
# ComfyUI exposes its aiohttp router via server.PromptServer.instance.routes.
# Routes added here become live as soon as this module is imported by the
# fork's main.py at startup. Order doesn't matter — duplicates would be
# caught by aiohttp at startup; we only define each path once.

routes = server.PromptServer.instance.routes
routes.post("/v1/images/generations")(_handler_images_generations)
routes.post("/v1/videos/generations")(_handler_videos_generations)
routes.get("/codec/info")(_handler_codec_info)
routes.get("/codec/schema")(_handler_codec_schema)
routes.get("/codec/health")(_handler_codec_health)
