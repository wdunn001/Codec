# Handoff — Codec v0.3 latent modality (in flight)

**Branch:** `feat/v0.3-latent-modality` on `wdunn001/Codec`
**Sister branch:** `feat/v0.3-latent-modality` on `wdunn001/codec-supervisor`
**Status (2026-05-08):** spec slice + CLI integration + reference Python encoder landed; engine forks (ComfyUI, diffusers) and bench methodology not yet started.

This file is a temporary handoff for the next worker picking up the slice. Delete before merging to `main`.

---

## What's done

### 1. Spec (additive to v0.2 → target v0.3)

| File | Status |
|---|---|
| `spec/PROTOCOL.md` | Bumped to v0.3. New sections: `## Modalities`, `## Latent Modality (v0.3)` (frame schemas, pipelines, endpoints, compression, discovery, validation contract, fallback). HELLO/READY extended with `modalities`, `accept_latent_spaces`, `accept_decoders`, `accept_pipelines`, `accept_transports`. New frame types `LATENT_HEADER` (0x05), `LATENTS` (0x06). Transport upgrade negotiation (http/ws/webrtc). v0.3 Open Questions section added. |
| `spec/PIPELINES.md` *(new)* | Bit-level math for all seven pipelines (`raw`, `int8`, `int4`, `int8-adaptive`, `int4-adaptive`, `delta+int8`, `delta+int4`). Universal conventions: little-endian, C-order, channel-first, IEEE 754 binary16 scales, round-half-to-even, symmetric ranges, saturating arithmetic, low-nibble-first int4 packing. Worked numerical example on a `[2,2,2]` fp16 fixture with verified hex output. |
| `spec/WELL_KNOWN_DISCOVERY.md` | Extended with `latents/<id>.json` parallel publication path. Modality-aware index.json (v0.3 carries both `maps[]` and `latents[]`). Resolution algorithm now takes a `kind` discriminator. Worked example for `stabilityai/sd-vae-ft-mse`. |
| `spec/latent-space-map.schema.json` *(new)* | Draft-07 JSON Schema for the latent-space-map document (parallel to `tokenizer-map.schema.json`). Enum holds all seven pipeline names. |
| `spec/examples/sd-vae-ft-mse.latent-map.json` *(new)* | Canonical reference example. Three decoders (onnx-web, ggml, torch). Pipelines: `raw`, `int8`, `int4` (image-only — no `delta+*`). Placeholder hashes as `sha256:000...0NN`. Validates clean against the schema. |

### 2. Client SDK — `@codecai/web` + `@codecai/maps-cli`

| File | Status |
|---|---|
| `packages/web/src/latent-types.ts` *(new)* | `LatentSpaceMap`, `LatentDecoder`, `LatentZstdDictionaryEntry`, `LatentVideoMetadata`, `LatentSpaceMapCache`, `LatentPipeline` (string union), `LatentDecoderRuntime`. |
| `packages/web/src/latent-map.ts` *(new)* | `validateLatentMap` (hand-written shape check, no JSON-Schema dep — same approach as `validateMap`), `loadLatentMap` (fetch + sha256 verify + cache), `makeLatentMap`, `MemoryLatentSpaceMapCache`, `LatentSpaceMapValidationError`, `LatentSpaceMapHashMismatchError`. |
| `packages/web/src/discover.ts` | `LatentSpacePointer`, `MapIndex.latents?` (v0.3-additive), `wellKnownLatentSpaceUrl`, `discoverLatentSpace`, `isLatentSpacePointerShape`, `discoverIndex` extended. |
| `packages/web/src/index.ts` | Re-exports for the above. |
| `packages/maps-cli/src/convert.ts` | `hashLatentMap` parallel to `hashMap` (shared canonical form via `hashJsonDocument`). |
| `packages/maps-cli/src/cli.ts` | `latents validate`, `latents hash`, `latents well-known` subcommands. |

**Verified:** `tsc --noEmit` clean on both packages; `codecai-maps latents validate spec/examples/sd-vae-ft-mse.latent-map.json` returns `✓ valid`; `latents well-known` emits a v0.3 `index.json` with both `maps[]` and `latents[]`.

### 3. Reference Python encoder — `codecai.server.latent_frame`

| File | Status |
|---|---|
| `packages/python/src/codecai/server/__init__.py` *(new)* | Re-exports for the latent encoder API. |
| `packages/python/src/codecai/server/latent_frame.py` *(new, ~470 lines)* | Canonical Python forward-encoder for all seven pipelines + msgpack/protobuf encoders for `LatentStreamHeader` and `LatentFrame`. Hand-rolled protobuf (no codegen step), matching the existing text-side `codec_frame.py` pattern. Stateful `LatentStreamEncoder` class holds keyframe state for delta pipelines. Vendored copy ships into each engine fork. |
| `packages/python/tests/test_latent_frame.py` *(new)* | Conformance test suite. Validates every pipeline against the PIPELINES.md worked-example fixture byte-for-byte. |

**Verified:** Python smoke test produces `scales=00420038`, `int8=2aab7f158140e010`, `int4=b217491e` — all matching the PIPELINES.md hex tables exactly. Adaptive prepends scales to frame data; delta produces zero residual when latent is unchanged across keyframe→delta; protobuf header carries the 4-byte BE length prefix.

---

## What's next (in order)

### 4. Engine forks (in flight on the sister repo)

The codec-supervisor branch carries `Dockerfile.comfyui` and `Dockerfile.diffusers` that build from forks at:

- `wdunn001/ComfyUI` branch `feat/codec-latent-transport` *(does not yet exist — needs to be created)*
- `wdunn001/diffusers` branch `feat/codec-latent-transport` *(does not yet exist — needs to be created)*

Each fork must:

1. Vendor a copy of `packages/python/src/codecai/server/latent_frame.py` from this repo into its own tree (sibling to how `codec_frame.py` lives in the vllm/sglang/llama.cpp forks today).
2. Add `/v1/images/generations` (and `/v1/videos/generations` for video VAEs) endpoints that accept `stream_format: "msgpack" | "protobuf"` and `modality: "image-latents" | "video-latents"`.
3. Tap into the engine's VAE encode path — capture latent tensor → `LatentStreamEncoder.frame(...)` → emit on the wire.
4. Set `Codec-Latent-Map` and `Codec-Zstd-Dict` response headers per spec.

ComfyUI's plugin hook surface should make endpoint addition straightforward; diffusers needs a small `examples/codec_server/` FastAPI wrapper since it's a library, not a server.

**This image (codec-diffusers) doubles as the bench/golden perceptual-conformance reference** — see Open Question #3 in PROTOCOL.md (v0.3) and the `golden/` trust-anchor decision (frozen Docker image, locked 2026-05-08).

### 5. Bench methodology extension

Originally requested as "we need the methodology for testing" — paused while we did the spec + CLI + Python encoder slices first. Scope:

- Extend `packages/bench/methodology/SCHEMA.md` with a `modality` block (latent_space_id/sha256, shape/dtype, pipeline, decoder runtime/weights/sha256, quality_reference).
- New `latent-fixtures.json` keyed by canonical sizes (256/512/1024 px, video-1s/5s/30s).
- `packages/bench/scripts/capture-latent-samples.py` (sibling of `capture-codec-samples.py`).
- `packages/bench/scripts/train-zstd-dict-latents.py` (sibling of `train-zstd-dict.py`).
- `packages/bench/golden-builder/Dockerfile` pinning torch + diffusers (the perceptual trust anchor).
- New plots: `rate-distortion-{space}.png`, `runtime-drift-{space}.png`.
- Row schema additions: `decode_cold_ms`, `decode_steady_ms`, `decode_peak_mem_mb`, `ssim`, `psnr`, `lpips`, plus `vmaf` + `temporal_ssim` for video.

### 6. Per-language client parity

Once the TS surface stabilises here, port to:

- `packages/python` (`codecai`) — `LatentSpaceMap` types + `validate_latent_map` + `discover_latent_space`. Server-side encoder already lives in `codecai.server`.
- `packages/dotnet` (`Codec.Net`)
- `packages/c` (`libcodec`) — frame parser only; decoder runtime delegated to a `libcodec-decode-ggml` plugin per the existing zero-deps-core posture.
- `packages/rust`
- `packages/java`

---

## Verification commands

A fresh worker on this branch should be able to run:

```bash
# Spec example validates against the schema
python3 -c "
import json, jsonschema
ex = json.load(open('spec/examples/sd-vae-ft-mse.latent-map.json'))
sc = json.load(open('spec/latent-space-map.schema.json'))
ex.pop('\$schema', None)
jsonschema.validate(ex, sc)
print('schema OK')
"

# TS clients type-check
(cd packages/web && tsc -p tsconfig.esm.json --noEmit)
(cd packages/maps-cli && tsc --noEmit)

# CLI smoke
codecai-maps latents validate spec/examples/sd-vae-ft-mse.latent-map.json
codecai-maps latents hash      spec/examples/sd-vae-ft-mse.latent-map.json

# Python encoder conformance
(cd packages/python && pip install -e ".[test]" && pip install numpy && pytest tests/test_latent_frame.py -v)
```

All should pass.

---

## Open design risks (escalate before merge)

1. **Pipeline registry governance.** v0.3 ships seven pipelines; #8 needs a documented review process + reference vectors. Tracked as Open Question #2 in `PROTOCOL.md` (v0.3).
2. **`golden/` reference container ownership.** Decision: frozen Docker image, pinned torch + diffusers + CUDA + driver versions; container sha256 is the trust anchor. Owner not yet named. Tracked as Open Question #3.
3. **Decoder weight distribution.** 50 MB–GB per VAE; client caching strategy and air-gapped substitution are still client-side concerns. Tracked as Open Question #5.

---

## Don't touch on this branch

- `packages/bench/results/2026-05-08T*/` — concurrent bench-run output from another job.
- `packages/bench/src/mcp-live.ts` + `packages/bench/package.json` `mcp:live` script — concurrent MCP work, unrelated.
- `.claude/scheduled_tasks.lock` — Claude Code artifact.

These were intentionally excluded from this branch's commits.
