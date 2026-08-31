"""
Server configuration. Reads CODEC_* env vars (matching the codec-supervisor
Dockerfile env contract) plus a small set of CLI overrides.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class CodecServerSettings:
    # Engine identity: the diffusers checkpoint loaded behind the latent_space.
    model: str = "stabilityai/stable-diffusion-2-1-base"
    latent_space: str = "stabilityai/sd-vae-ft-mse"

    # Network
    host: str = "127.0.0.1"
    port: int = 8200

    # Pipeline support: the seven names from spec/PIPELINES.md, gated to the
    # subset this engine can actually produce. raw is mandatory.
    image_pipelines: List[str] = field(
        default_factory=lambda: ["raw", "int8", "int4"]
    )
    video_pipelines: List[str] = field(
        default_factory=lambda: ["raw", "int8-adaptive", "int4-adaptive", "delta+int8", "delta+int4"]
    )

    # Latent dict pool: directory the supervisor populates from the
    # latent-space-map's zstd_dictionaries[] entries. Each file is named
    # `<latent_space_slug>-<format>-<pipeline_slug>-v1.dict`. Empty path
    # disables zstd negotiation; the server falls through to gzip / identity.
    latent_dicts_dir: str = "/opt/codec/dicts/latents"

    # Latent-space-map document URL: what /codec/info advertises. Bench
    # cells reference this URL plus the document's sha256 for fingerprinting.
    latent_map_url: Optional[str] = None
    latent_map_sha256: Optional[str] = None

    # Eager model load. False = lazy (first request triggers load); True =
    # load on startup, slower boot but no first-request latency.
    preload: bool = False

    # Where torch goes. cuda when present, cpu fallback.
    device: str = "cuda"
    torch_dtype: str = "float16"

    # Diffusers cache (matches HF_HOME convention).
    hf_home: Optional[str] = None

    @classmethod
    def from_env(cls) -> "CodecServerSettings":
        s = cls()
        # Match the Dockerfile.diffusers env contract.
        s.model = os.environ.get("CODEC_INITIAL_MODEL", s.model)
        s.latent_space = os.environ.get("CODEC_INITIAL_LATENT_SPACE", s.latent_space)
        s.host = os.environ.get("CODEC_BACKEND_HOST", s.host)
        port_env = os.environ.get("CODEC_BACKEND_PORT")
        if port_env:
            s.port = int(port_env)
        s.latent_dicts_dir = os.environ.get("CODEC_LATENT_DICTS_DIR", s.latent_dicts_dir)
        s.latent_map_url = os.environ.get("CODEC_LATENT_MAP_URL")
        s.latent_map_sha256 = os.environ.get("CODEC_LATENT_MAP_SHA256")
        s.hf_home = os.environ.get("HF_HOME")
        return s
