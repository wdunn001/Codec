"""
FastAPI app: wire surface for the diffusers codec_server.

Implements the v0.3 latent-modality endpoints from spec/PROTOCOL.md.
Stays thin: route handlers parse the request, call into
LatentPipelineRunner for the actual generation, then run the resulting
latents through LatentStreamEncoder and return a StreamingResponse.

All pipeline math lives in the vendored latent_frame.py: this file
NEVER computes scales, packs ints, or otherwise touches latent bytes
directly. The contract is "ask the encoder, write the bytes."
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from typing import AsyncIterator, Optional, Tuple

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

from .latent_frame import (   # vendored from packages/python/src/codecai/server/
    LatentStreamEncoder,
    PIPELINE_NAMES,
    PROTO_SCHEMA,
)
from .pipeline import LatentPipelineRunner
from .settings import CodecServerSettings


# ── Request / negotiation helpers ────────────────────────────────────────────


_MSGPACK_CT  = "application/x-msgpack"
_PROTOBUF_CT = "application/x-protobuf"


def _resolve_stream_format(body: dict, accept_header: str) -> str:
    explicit = body.get("stream_format")
    if explicit in ("msgpack", "protobuf"):
        return explicit
    # Fall back to Accept header.
    if "x-protobuf" in accept_header:
        return "protobuf"
    if "x-msgpack" in accept_header:
        return "msgpack"
    # Default per spec: msgpack: broadest client support.
    return "msgpack"


def _content_type(stream_format: str) -> str:
    return _PROTOBUF_CT if stream_format == "protobuf" else _MSGPACK_CT


def _parse_size(s: str) -> Tuple[int, int]:
    """`"512x512"` → `(512, 512)` (width, height)."""
    try:
        w, h = s.lower().split("x")
        return (int(w), int(h))
    except Exception:
        raise HTTPException(400, f"size must be like '512x512', got {s!r}")


def _validate_modality_pipeline(
    settings: CodecServerSettings, modality: str, pipeline: str,
) -> None:
    if pipeline not in PIPELINE_NAMES:
        raise HTTPException(
            400, f"pipeline {pipeline!r} not in registry; must be one of {PIPELINE_NAMES}",
        )
    if modality == "image-latents":
        allowed = settings.image_pipelines
    elif modality == "video-latents":
        allowed = settings.video_pipelines
    else:
        raise HTTPException(400, f"modality must be image-latents or video-latents, got {modality!r}")
    if pipeline not in allowed:
        raise HTTPException(
            400,
            f"pipeline {pipeline!r} not supported for {modality}; "
            f"this engine supports {allowed}. "
            "(`raw` is always supported as the negotiation fallback.)",
        )


# ── Encoder construction ─────────────────────────────────────────────────────


def _build_encoder(
    *,
    latent_space_id: str,
    shape: tuple,
    pipeline: str,
    stream_format: str,
    first_latent: np.ndarray,
    fps: Optional[int],
    total_frames: Optional[int],
    vae_scale_factor: Optional[float],
) -> LatentStreamEncoder:
    """Construct the encoder, computing static scales upfront for int8/int4."""
    static_scales = None
    if pipeline in ("int8", "int4"):
        # Per spec/PIPELINES.md: static-scale pipelines pin per-channel scales
        # in the LatentStreamHeader once. We compute against the first (and
        # only, for image-latents) frame's range.
        static_scales = np.max(
            np.abs(first_latent.reshape(first_latent.shape[0], -1)),
            axis=1,
        ).astype(np.float16)
    return LatentStreamEncoder(
        latent_space_id=latent_space_id,
        shape=tuple(shape),
        dtype="fp16",
        pipeline=pipeline,
        stream_format=stream_format,
        static_scales=static_scales,
        fps=fps,
        total_frames=total_frames,
        vae_scale_factor=vae_scale_factor,
        # v0.5: when CODEC_GPU_QUANTIZE=1 is set in the engine env, opt the
        # encoder into the torch-on-device fast path. Caller still has to
        # hand the encoder a torch.cuda.Tensor on each .frame(...) call
        # for the GPU path to actually fire; numpy + CPU torch inputs fall
        # through to the cross-runtime numpy path unchanged.
        gpu_quantize=bool(int(os.environ.get("CODEC_GPU_QUANTIZE", "0"))),
    )


# ── Streaming generators ─────────────────────────────────────────────────────


async def _stream_image(
    encoder: LatentStreamEncoder,
    latent: np.ndarray,
) -> AsyncIterator[bytes]:
    yield encoder.header()
    yield encoder.frame(
        latent, seq=0, keyframe=True, done=True, finish_reason="ok",
    )


async def _stream_video(
    encoder: LatentStreamEncoder,
    latents: list,
    keyframe_interval: int,
) -> AsyncIterator[bytes]:
    yield encoder.header()
    n = len(latents)
    for i, latent in enumerate(latents):
        is_keyframe = (i == 0) or (i % keyframe_interval == 0)
        yield encoder.frame(
            latent,
            seq=i,
            keyframe=is_keyframe,
            done=(i == n - 1),
            finish_reason="ok" if i == n - 1 else None,
        )


# ── App ──────────────────────────────────────────────────────────────────────


def build_app(settings: CodecServerSettings) -> FastAPI:
    app = FastAPI(
        title="codec-diffusers reference server",
        version="0.3.0",
        docs_url="/codec/docs",
        redoc_url=None,
    )
    runner = LatentPipelineRunner(
        model_id=settings.model,
        latent_space_id=settings.latent_space,
        device=settings.device,
        torch_dtype=settings.torch_dtype,
    )

    # ── /health ──────────────────────────────────────────────────────────
    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "model": settings.model, "latent_space": settings.latent_space}

    # ── /codec/info ──────────────────────────────────────────────────────
    @app.get("/codec/info")
    async def info() -> dict:
        return {
            "modality_supported":  ["image-latents", "video-latents"],
            "stream_format_supported": ["msgpack", "protobuf"],
            "compression_supported":   ["identity", "gzip"],   # zstd-with-dict TBD
            "image_pipelines":     settings.image_pipelines,
            "video_pipelines":     settings.video_pipelines,
            "latent_space_id":     settings.latent_space,
            "latent_map_url":      settings.latent_map_url,
            "latent_map_sha256":   settings.latent_map_sha256,
            "model":               settings.model,
            "codec_version":       "0.3",
        }

    # ── /codec/schema ────────────────────────────────────────────────────
    @app.get("/codec/schema")
    async def schema() -> PlainTextResponse:
        return PlainTextResponse(PROTO_SCHEMA, media_type="text/plain")

    # ── /v1/images/generations ──────────────────────────────────────────
    @app.post("/v1/images/generations")
    async def images_generations(req: Request) -> StreamingResponse:
        try:
            body = await req.json()
        except json.JSONDecodeError:
            raise HTTPException(400, "request body must be JSON")

        modality = body.get("modality", "image-latents")
        if modality != "image-latents":
            raise HTTPException(
                400, f"/v1/images/generations is image-latents only; got {modality!r}",
            )

        latent_space = body.get("latent_space", settings.latent_space)
        if latent_space != settings.latent_space:
            raise HTTPException(
                400,
                f"server is loaded for latent_space {settings.latent_space!r}; "
                f"client requested {latent_space!r}. Reconfigure the server or "
                "issue against /v1/images/generations on a server loaded for "
                "the requested latent_space.",
            )
        pipeline = body.get("pipeline", "raw")
        _validate_modality_pipeline(settings, modality, pipeline)

        size = _parse_size(body.get("size", "512x512"))
        steps = int(body.get("steps", 25))
        seed = int(body.get("seed", 42))
        prompt = body.get("prompt", "")
        if not prompt:
            raise HTTPException(400, "prompt is required")

        stream_format = _resolve_stream_format(body, req.headers.get("accept", ""))

        # Generate the latent tensor.
        result = await runner.generate_image_latent(
            prompt=prompt, size=size, steps=steps, seed=seed,
        )
        latent = result.latents[0]

        encoder = _build_encoder(
            latent_space_id=settings.latent_space,
            shape=result.shape,
            pipeline=pipeline,
            stream_format=stream_format,
            first_latent=latent,
            fps=None,
            total_frames=1,
            vae_scale_factor=None,
        )

        headers = {
            "Codec-Latent-Map": settings.latent_map_sha256 or "",
            # Codec-Zstd-Dict is set per spec only when Content-Encoding: zstd
            # is negotiated; gzip/identity paths leave it absent.
            "X-Codec-Generation-Ms": f"{result.generation_ms:.1f}",
        }
        return StreamingResponse(
            _stream_image(encoder, latent),
            media_type=_content_type(stream_format),
            headers={k: v for k, v in headers.items() if v},
        )

    # ── /v1/videos/generations ──────────────────────────────────────────
    @app.post("/v1/videos/generations")
    async def videos_generations(req: Request) -> StreamingResponse:
        body = await req.json()
        modality = body.get("modality", "video-latents")
        if modality != "video-latents":
            raise HTTPException(400, f"/v1/videos/generations is video-latents only; got {modality!r}")

        latent_space = body.get("latent_space", settings.latent_space)
        if latent_space != settings.latent_space:
            raise HTTPException(
                400,
                f"server is loaded for latent_space {settings.latent_space!r}",
            )
        pipeline = body.get("pipeline", "raw")
        _validate_modality_pipeline(settings, modality, pipeline)

        resolution = int(body.get("resolution", 512))
        fps = int(body.get("fps", 24))
        frames = int(body.get("frames", 24))
        steps = int(body.get("steps", 25))
        seed = int(body.get("seed", 42))
        prompt = body.get("prompt", "")
        keyframe_interval = int(body.get("keyframe_interval", 24))

        stream_format = _resolve_stream_format(body, req.headers.get("accept", ""))

        result = await runner.generate_video_latents(
            prompt=prompt, resolution=resolution, fps=fps,
            frames=frames, steps=steps, seed=seed,
        )

        encoder = _build_encoder(
            latent_space_id=settings.latent_space,
            shape=result.shape,
            pipeline=pipeline,
            stream_format=stream_format,
            first_latent=result.latents[0],
            fps=fps,
            total_frames=frames,
            vae_scale_factor=None,
        )

        return StreamingResponse(
            _stream_video(encoder, result.latents, keyframe_interval=keyframe_interval),
            media_type=_content_type(stream_format),
            headers={"Codec-Latent-Map": settings.latent_map_sha256 or ""},
        )

    # ── lifecycle hooks ──────────────────────────────────────────────────
    @app.on_event("startup")
    async def on_startup() -> None:
        if settings.preload:
            await runner.preload()

    return app
