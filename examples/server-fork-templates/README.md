# Server fork templates: Codec v0.3 latent modality

This directory holds the **canonical Python bodies** that the latent-aware engine forks vendor into their trees. The engine forks tracked under [`codec-supervisor`](https://github.com/wdunn001/codec-supervisor)'s latent-modality images are:

| Fork | Branch | Vendors | Image |
|---|---|---|---|
| [`wdunn001/ComfyUI`](https://github.com/wdunn001/ComfyUI) | `feat/codec-latent-transport` | [`comfyui/`](./comfyui/) | [`wdunn001/codec-comfyui`](https://hub.docker.com/r/wdunn001/codec-comfyui): `:vX.Y.Z` + `:latest` + `:sha-<git7>` (built by [`Dockerfile.comfyui`](https://github.com/wdunn001/codec-supervisor/blob/main/Dockerfile.comfyui), auto-pushed by [`release.yml`](https://github.com/wdunn001/codec-supervisor/blob/main/.github/workflows/release.yml) on every `v*` git tag) |
| [`wdunn001/diffusers`](https://github.com/wdunn001/diffusers) | `feat/codec-latent-transport` | [`diffusers/codec_server/`](./diffusers/codec_server/) | [`wdunn001/codec-diffusers`](https://hub.docker.com/r/wdunn001/codec-diffusers): `:vX.Y.Z` + `:latest` + `:sha-<git7>` (built by [`Dockerfile.diffusers`](https://github.com/wdunn001/codec-supervisor/blob/main/Dockerfile.diffusers), same release workflow) |

Why "fork-only" rather than upstream PRs:

- **ComfyUI**: the codec endpoints touch enough of the request loop (latent capture during sampling, msgpack/protobuf streaming response, zstd dict negotiation) that a downstream fork is cleaner than threading hooks through ComfyUI's plugin system. Also: ComfyUI moves fast and PRs land slowly.
- **diffusers**: diffusers is purely a *library*. Our fork adds an `examples/codec_server/` FastAPI wrapper: the surface area HuggingFace would never accept upstream because they don't ship servers. The codec_server doubles as the **bench/golden perceptual-conformance reference**.

For the contrast, the text-engine forks (vLLM, sglang, llama.cpp) are upstream-PR-track. Different posture; different reasoning.

## How to integrate

For each fork:

1. **Vendor `latent_frame.py`.** Both templates import from a relative path that's expected to land at:
   ```
   <fork>/codec_server/latent_frame.py        (diffusers)
   <fork>/codec_server/latent_frame.py        (ComfyUI: same path inside the fork)
   ```
   Copy from this repo at [`packages/python/src/codecai/server/latent_frame.py`](../../packages/python/src/codecai/server/latent_frame.py): DO NOT modify after vendoring. It's the canonical reference for the seven pipeline forward transforms (`raw`, `int8`, `int4`, `int8-adaptive`, `int4-adaptive`, `delta+int8`, `delta+int4`) and the msgpack + protobuf encoders for `LatentStreamHeader` / `LatentFrame`. The pipeline math is bit-pinned in [`spec/PIPELINES.md`](../../spec/PIPELINES.md); changes to the vendored copy that break the bit contract are protocol violations.

2. **Drop in the template.** From the matching subdirectory of this folder, copy the entire tree into the fork. The ComfyUI template is one file; the diffusers template is a Python package.

3. **Wire up the entry point.**
   - **diffusers**: the Dockerfile entry point invokes `python -m codec_server`. The fork's `examples/codec_server/__main__.py` is the entry; it reads `--model` / `--latent-space` / `--port` flags.
   - **ComfyUI**: the file ships in ComfyUI's `app/` (or equivalent) directory and registers routes via `@server.PromptServer.instance.routes.post(...)` at import time. ComfyUI's main process loads it on startup if it's discovered via the existing extension/plugin mechanism. The template's README walks through the exact location.

4. **Push the branch.** `wdunn001/<engine>` `feat/codec-latent-transport`. Once the branch exists, `Dockerfile.{comfyui,diffusers}` in codec-supervisor builds against it and the codec image works.

## What the templates implement

Both templates implement the same wire surface from [`spec/PROTOCOL.md`](../../spec/PROTOCOL.md) §"Latent Modality":

```
POST /v1/images/generations          # image-latents
POST /v1/videos/generations          # video-latents
GET  /codec/info                     # active latent_space + decoder + pipeline support
GET  /codec/schema                   # protobuf schema for client codegen
GET  /health                         # supervisor health probe
```

Both also:

- Validate `pipeline` against the seven-name registry from [`spec/PIPELINES.md`](../../spec/PIPELINES.md) and reject incompatible (modality, pipeline) pairs (e.g. `delta+int8` on an image request).
- Emit `LatentStreamHeader` as the first frame of every response, then `LatentFrame`(s).
- Set `Codec-Latent-Map` and `Codec-Zstd-Dict` response headers when applicable.
- Negotiate compression via `Accept-Encoding` (identity / gzip / zstd with dict).
- Fall back to `raw` pipeline when client and server share no other named pipeline (the protocol-mandated negotiation floor).

Both **stop short of**:

- WebSocket / WebRTC transport upgrade (HTTP only for v0.3-initial; transport upgrade is open-question territory in the spec).
- Cross-stream multiplexing within a single connection.

Both pipeline forward transforms run inside the templates by reusing the `LatentStreamEncoder` class from the vendored `latent_frame.py`. No template-side math; the templates only handle:

1. Engine setup (load the diffusers pipeline / ComfyUI checkpoint).
2. Capturing the latent tensor at the right point in the diffusion process.
3. Running it through `LatentStreamEncoder.frame(...)`.
4. Streaming the resulting bytes back over HTTP.

## Bench/golden reference

The diffusers template specifically pins to torch + diffusers versions in the `Dockerfile.diffusers` build args that match [`packages/bench/golden-builder/Dockerfile`](../../packages/bench/golden-builder/Dockerfile). Bumping either container without bumping the other re-pins the perceptual contract and the bench fingerprint-validator will quarantine cells. See [`packages/bench/golden-builder/README.md`](../../packages/bench/golden-builder/README.md) for the bump protocol.

ComfyUI's torch + diffusers pin matches diffusers' for the same reason.

## When to update these templates

These bodies are the **source of truth** for the engine forks. The development workflow:

1. Edit the template here in the main Codec repo (this directory).
2. Test changes locally against a checkout of the fork (sync via `cp` or symlink).
3. When ready, vendor the new template into the fork's branch and push.
4. The fork's PR / commit message references the template revision in this repo for traceability.

Keeping the templates in the main Codec repo means anyone adding a new engine integration starts from the same source: the templates encode the protocol, the forks encode engine specifics.
