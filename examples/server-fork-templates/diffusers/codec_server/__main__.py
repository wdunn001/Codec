"""
codec_server entry point: `python -m codec_server`.

Reads CODEC_* env vars (the contract codec-supervisor's
Dockerfile.diffusers ships) and accepts CLI overrides for one-off runs.
The Dockerfile invokes this module directly:

    ENTRYPOINT ["python", "-m", "codec_server"]
"""

from __future__ import annotations

import argparse
import sys

import uvicorn

from .app import build_app
from .settings import CodecServerSettings


def main() -> int:
    s = CodecServerSettings.from_env()

    ap = argparse.ArgumentParser(prog="codec_server")
    ap.add_argument("--model", default=s.model,
                    help="diffusers model id (default: %(default)s)")
    ap.add_argument("--latent-space", default=s.latent_space,
                    help="latent_space_id this server is loaded for (default: %(default)s)")
    ap.add_argument("--host", default=s.host, help="bind host (default: %(default)s)")
    ap.add_argument("--port", type=int, default=s.port, help="bind port (default: %(default)s)")
    ap.add_argument("--device", default=s.device, choices=("cuda", "cpu"))
    ap.add_argument("--torch-dtype", default=s.torch_dtype, choices=("float16", "bfloat16", "float32"))
    ap.add_argument("--preload", action="store_true",
                    help="eagerly load the pipeline on startup (default: %(default)s)")
    ap.add_argument("--latent-map-url", default=s.latent_map_url,
                    help="URL of the latent-space-map JSON this server's bytes resolve against")
    ap.add_argument("--latent-map-sha256", default=s.latent_map_sha256,
                    help="sha256 of the latent-space-map JSON (sent in Codec-Latent-Map header)")
    args = ap.parse_args()

    s.model = args.model
    s.latent_space = args.latent_space
    s.host = args.host
    s.port = args.port
    s.device = args.device
    s.torch_dtype = args.torch_dtype
    s.preload = args.preload or s.preload
    s.latent_map_url = args.latent_map_url
    s.latent_map_sha256 = args.latent_map_sha256

    app = build_app(s)

    print(f"▶ codec-diffusers serving on http://{s.host}:{s.port}", file=sys.stderr)
    print(f"  model:        {s.model}", file=sys.stderr)
    print(f"  latent_space: {s.latent_space}", file=sys.stderr)
    print(f"  device:       {s.device} ({s.torch_dtype})", file=sys.stderr)
    print(f"  preload:      {s.preload}", file=sys.stderr)

    uvicorn.run(
        app,
        host=s.host,
        port=s.port,
        log_level="info",
        access_log=False,           # supervisor handles request logging
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
