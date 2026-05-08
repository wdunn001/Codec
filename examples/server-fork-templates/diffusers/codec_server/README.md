# `codec_server` — diffusers fork integration template

This is the FastAPI wrapper that lives at `examples/codec_server/` inside the [`wdunn001/diffusers`](https://github.com/wdunn001/diffusers) fork's `feat/codec-latent-transport` branch. The fork's Dockerfile build (in [`codec-supervisor`](https://github.com/wdunn001/codec-supervisor) `Dockerfile.diffusers`) clones the fork, `pip install -e`'s it, and invokes this package's `__main__` as the container entry point.

## Vendoring into the fork

From the main Codec repo's `examples/server-fork-templates/diffusers/codec_server/` directory:

```bash
# In the diffusers fork checkout
mkdir -p examples/codec_server
cp -r <codec-repo>/examples/server-fork-templates/diffusers/codec_server/* examples/codec_server/

# Vendor the canonical pipeline encoder (DO NOT modify after copy):
cp <codec-repo>/packages/python/src/codecai/server/latent_frame.py \
   examples/codec_server/latent_frame.py

git add examples/codec_server/
git commit -m "feat(codec): add codec_server FastAPI wrapper for v0.3 latent modality"
git push origin feat/codec-latent-transport
```

The fork's `examples/codec_server/` then contains:

```
examples/codec_server/
├── __init__.py
├── __main__.py
├── app.py
├── pipeline.py
├── settings.py
├── latent_frame.py     ← vendored from main Codec repo, untouched
└── README.md
```

## Files at a glance

| File | Lines | Role |
|---|---|---|
| `__init__.py`       | ~30  | Module init + re-exports. |
| `__main__.py`       | ~60  | `python -m codec_server` entry point. Reads CODEC_* env vars, parses CLI flags, runs uvicorn. |
| `app.py`            | ~250 | FastAPI routes — `/v1/images/generations`, `/v1/videos/generations`, `/codec/info`, `/codec/schema`, `/health`. Stays thin: parses requests, calls into `LatentPipelineRunner`, runs the result through `LatentStreamEncoder`, returns a `StreamingResponse`. |
| `pipeline.py`       | ~200 | Loads the diffusers pipeline once, runs sampling up to but not including VAE decode. The latent capture point is the official `output_type="latent"` argument — no torch internals patching. Image done; video stub points at `StableVideoDiffusionPipeline` for the integrator to wire. |
| `settings.py`       | ~70  | `CodecServerSettings` — env-var-backed config (CODEC_INITIAL_MODEL / CODEC_INITIAL_LATENT_SPACE / CODEC_BACKEND_HOST etc.) plus CLI overrides. |
| `latent_frame.py`   | ~470 | Vendored from `packages/python/src/codecai/server/latent_frame.py`. Contains `LatentStreamEncoder` and the seven pipeline forward transforms. **Do not modify**; bit-pinned by `spec/PIPELINES.md`. |

## What the template does

- Implements the v0.3 wire surface from `spec/PROTOCOL.md` §"Latent Modality" — image-latents endpoint complete, video-latents endpoint stubbed (one swap on the pipeline class wires it).
- Validates `pipeline` against the seven-name registry from `spec/PIPELINES.md` and rejects invalid (modality, pipeline) combinations.
- Computes per-channel scales upfront for static-scale pipelines (`int8`, `int4`); leaves them out of the header for adaptive/delta.
- Streams the response via FastAPI's `StreamingResponse` — first frame is `LatentStreamHeader`, subsequent frames are `LatentFrame`s.
- Sets `Codec-Latent-Map` response header from `--latent-map-sha256` config.

## What the template does *not* do (left for the integrator)

- **Video pipeline**: `pipeline.py:_load_video_pipe()` raises `NotImplementedError`. The integrator picks the diffusers video class matching the configured latent_space (SVD, AnimateDiff, CogVideoX, etc.) and wires it the same way image is wired.
- **zstd-with-dict negotiation**: `Codec-Zstd-Dict` header machinery is in place but the dict-loading path needs supervisor wiring (read `CODEC_LATENT_DICTS_DIR`, hold a per-(format, pipeline) dict pool, attach to `zstandard.ZstdCompressor` per response). Punted to a follow-up; gzip + identity work today.
- **Brotli**: the protocol allows `br`, but on small msgpack streams brotli overhead dominates — see `RESULTS.md` §1b in the main Codec repo. Add only if there's a measured reason to.
- **WebSocket / WebRTC transport upgrade**: HTTP only for v0.3-initial. Transport upgrade is open-question territory (PROTOCOL.md §"Transport selection").

## Running it

Inside the fork checkout, with the Codec image's torch + diffusers pinned:

```bash
# From within the fork (depends on the fork being pip-installed editable):
pip install -e .                # the diffusers fork itself
pip install fastapi uvicorn msgspec numpy

python -m examples.codec_server \
    --model         stabilityai/stable-diffusion-2-1-base \
    --latent-space  stabilityai/sd-vae-ft-mse \
    --host          0.0.0.0 \
    --port          8200 \
    --preload
```

Smoke-test once running:

```bash
curl http://127.0.0.1:8200/codec/info | jq

curl -X POST http://127.0.0.1:8200/v1/images/generations \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/x-msgpack' \
    -H 'Accept-Encoding: identity' \
    --data '{"model":"stabilityai/stable-diffusion-2-1-base","prompt":"a snowy mountain at dusk","stream_format":"msgpack","modality":"image-latents","latent_space":"stabilityai/sd-vae-ft-mse","pipeline":"int8","size":"512x512","steps":25,"seed":42}' \
    --output /tmp/sd-vae-ft-mse-512.bin

# Pipe into a Codec client to verify the latent decodes back to a real image:
python -m codecai.bench.decode_latent_stream \
    --bytes /tmp/sd-vae-ft-mse-512.bin \
    --latent-space stabilityai/sd-vae-ft-mse \
    --pipeline int8 \
    --out /tmp/decoded.png
```

(The decode script is part of the bench harness, not this template.)

## When to re-vendor `latent_frame.py`

Re-vendor when the main Codec repo bumps the pipeline registry — adding pipeline #8, fixing a math bug, etc. The change protocol is documented in `spec/PIPELINES.md` §Compatibility and `spec/PROTOCOL.md` Open Question (v0.3) #2.

The fork's vendored `latent_frame.py` should always carry the relative path comment at the top noting the upstream commit it came from, so a reader can `git log` from the upstream copy to see what changed.
