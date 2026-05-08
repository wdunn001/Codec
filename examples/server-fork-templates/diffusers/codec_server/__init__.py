"""
codec_server — FastAPI wrapper around HuggingFace diffusers that emits
Codec latent streams (msgpack/protobuf) instead of decoded pixels.

Lives at `<fork>/codec_server/` after vendoring into the wdunn001/diffusers
fork's `feat/codec-latent-transport` branch. The fork's
`examples/codec_server/` directory contains exactly this Python package
plus a vendored copy of `latent_frame.py` from the main Codec repo
(`packages/python/src/codecai/server/latent_frame.py`).

Entry point:

    python -m codec_server \\
        --model         stabilityai/stable-diffusion-2-1-base \\
        --latent-space  stabilityai/sd-vae-ft-mse \\
        --host          0.0.0.0 \\
        --port          8200

The server pre-loads the model on first request (or eagerly with
`--preload`) and exposes the wire surface from spec/PROTOCOL.md
§"Latent Modality":

    POST /v1/images/generations
    POST /v1/videos/generations
    GET  /codec/info
    GET  /codec/schema
    GET  /health

This wrapper doubles as the bench/golden perceptual-conformance
reference — the torch + diffusers versions pinned in the parent
Dockerfile.diffusers MUST match packages/bench/golden-builder/Dockerfile
in the main Codec repo, or the bench validator quarantines its cells.
"""

__version__ = "0.3.0"

from .app import build_app
from .pipeline import LatentPipelineRunner
from .settings import CodecServerSettings

__all__ = [
    "build_app",
    "LatentPipelineRunner",
    "CodecServerSettings",
    "__version__",
]
