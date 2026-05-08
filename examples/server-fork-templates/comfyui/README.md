# `codec_endpoints.py` — ComfyUI fork integration template

This is the single Python file that lives at `app/codec_endpoints.py` inside the [`wdunn001/ComfyUI`](https://github.com/wdunn001/ComfyUI) fork's `feat/codec-latent-transport` branch. The fork's Dockerfile build (in [`codec-supervisor`](https://github.com/wdunn001/codec-supervisor) `Dockerfile.comfyui`) clones the fork, installs requirements, and ComfyUI's `main.py` imports this module on startup. The import has a side-effect: it registers v0.3 latent-modality routes on ComfyUI's running aiohttp server.

## Vendoring into the fork

From the main Codec repo:

```bash
# In the ComfyUI fork checkout
cp <codec-repo>/examples/server-fork-templates/comfyui/codec_endpoints.py \
   app/codec_endpoints.py

# Vendor the canonical pipeline encoder (DO NOT modify after copy):
cp <codec-repo>/packages/python/src/codecai/server/latent_frame.py \
   app/latent_frame.py

# Wire it in: add ONE line to ComfyUI's main.py near the top, after
# `import server`:
#
#     import app.codec_endpoints  # noqa: F401  (Codec v0.3 latent endpoints)
#
# (The import is for its side effect — registering routes on the running
# aiohttp server. The noqa suppresses the unused-import lint.)

git add app/codec_endpoints.py app/latent_frame.py main.py
git commit -m "feat(codec): add v0.3 latent-modality endpoints"
git push origin feat/codec-latent-transport
```

The fork's `app/` directory then contains the codec module sitting alongside ComfyUI's existing app code. No changes to ComfyUI's plugin loader or `custom_nodes/` mechanism are needed — this is a core extension, not a custom node.

## What the template implements

- `POST /v1/images/generations` — image-latents endpoint, full implementation.
- `POST /v1/videos/generations` — video-latents endpoint, stub. The integrator wires their preferred diffusers video pipeline class (StableVideoDiffusion / AnimateDiff / CogVideoX / etc.) at the marked `NotImplementedError`. Capture pattern is identical to image.
- `GET /codec/info` — advertises modality / pipeline / format / compression support, plus the active latent_space and its map sha256.
- `GET /codec/schema` — returns the protobuf schema for client codegen.
- `GET /codec/health` — supervisor health probe (alongside ComfyUI's own `/system_stats`).
- Pipeline validation against the seven-name registry from `spec/PIPELINES.md`.
- Static-scale computation upfront for `int8` / `int4`; adaptive/delta scales handled by the encoder per-frame.
- Streaming aiohttp `StreamResponse` carrying header → frames in msgpack or protobuf.
- `Codec-Latent-Map` response header from the configured map sha256.

## What the template does NOT do (yet)

**Bypasses ComfyUI's workflow graph.** This template uses diffusers directly inside ComfyUI's process — the same pattern as the diffusers fork's `codec_server`. Concretely: `_LatentRunner` loads `AutoPipelineForText2Image` and runs it independently of ComfyUI's KSampler / VAE / checkpoint loader nodes.

This is the right starting point because it ships fast and shares latent-capture code with the diffusers fork. **It is NOT the right end state.** A fuller integration would:

1. Reuse ComfyUI's already-loaded checkpoint (saves VRAM — no double-loading the same UNet).
2. Plug into ComfyUI's KSampler so a user-supplied workflow's latent output streams as codec.
3. Expose a custom node ("Codec Output") that drops into a workflow alongside the existing VAEDecode node, letting users opt into latent streaming on a per-workflow basis.

These are tracked as TODO inside the file's docstring. Picking up that work means:

- Resolving ComfyUI's `comfy/sd.py` model load → reusing the loaded VAE / UNet from the diffusers pipeline.
- Hooking after the sampler step (`comfy/samplers.py`) to capture the latent.
- Registering a node class in `comfy_extras/nodes_codec.py` that emits codec when triggered.

The current template's `/v1/images/generations` endpoint serves the protocol surface; the workflow-integrated version will live alongside, not replace it.

**Other intentionally-deferred surface:**
- zstd-with-dict negotiation. `Codec-Zstd-Dict` header support is in place but the dict pool integration (read `CODEC_LATENT_DICTS_DIR` → load per-(format, pipeline) dicts → attach to the response compressor) is TODO.
- WebSocket / WebRTC transport upgrade. HTTP only for now.

## Running it

ComfyUI's Dockerfile (in codec-supervisor) takes care of this. For local dev against a fork checkout:

```bash
cd <ComfyUI fork>
pip install -r requirements.txt
pip install fastapi msgspec numpy   # if not already in requirements.txt

CODEC_INITIAL_MODEL=stabilityai/stable-diffusion-2-1-base \
CODEC_INITIAL_LATENT_SPACE=stabilityai/sd-vae-ft-mse \
python main.py --listen 0.0.0.0 --port 8188
```

Smoke-test:

```bash
curl http://127.0.0.1:8188/codec/info | jq

curl -X POST http://127.0.0.1:8188/v1/images/generations \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/x-msgpack' \
    -H 'Accept-Encoding: identity' \
    --data '{"prompt":"a snowy mountain at dusk","stream_format":"msgpack","modality":"image-latents","latent_space":"stabilityai/sd-vae-ft-mse","pipeline":"int8","size":"512x512","steps":25,"seed":42}' \
    --output /tmp/sd-latent.bin

ls -la /tmp/sd-latent.bin     # ~12 KB for int8 @ 512x512
```

## Why the diffusers and ComfyUI templates look similar

The latent-emit pipeline (load checkpoint → sample → capture latent → run through `LatentStreamEncoder`) is genuinely the same algorithm in both forks. The differences are:

- **Server framework**: FastAPI (diffusers fork) vs aiohttp (ComfyUI fork — that's what ComfyUI ships).
- **Process model**: standalone server (diffusers) vs running inside ComfyUI's existing process (ComfyUI).
- **End state**: diffusers stays a thin shim. ComfyUI grows an integrated path that reuses its workflow execution.

The shared `latent_frame.py` keeps the wire-format math identical, which is the contract that matters. Server-framework differences are local concerns.
