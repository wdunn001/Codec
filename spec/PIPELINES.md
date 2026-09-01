# Codec Latent Pipelines (v1)

Status: stable, additive to v0.3.

This document is the normative spec for the seven byte-level transforms a server may apply to latents before they enter the wire. Every pipeline has a forward (server) and inverse (client) form. The round-trip is **bit-exact at the latent-byte boundary**: server-emitted bytes equal client-reconstructed bytes after the inverse transform. Pixels-after-VAE are governed separately by the per-pipeline `quality_thresholds` in `spec/latent-space-map.schema.json`.

The Python reference encoder lives at `packages/python/src/codecai/server/latent_frame.py`. Forward conformance fixtures live under `packages/bench/golden/pipelines/<name>/`.

---

## Conventions

- Latents are channel-first: `shape = [C, ...spatial]`. Channel axis is always axis 0.
- All on-wire byte arrays are **little-endian** for fixed-width types.
- Per-channel symmetric quantization uses **round-half-to-even** (IEEE 754 `roundTiesToEven`, `numpy.rint` default). Never round-half-away-from-zero.
- Saturation is mandatory: int8 → `[-127, +127]` (the `-128` slot is unused on purpose to keep the grid symmetric); int4 → `[-7, +7]`.
- `scales` is always per-channel, fp16, length `C`, encoded as `C × 2` LE bytes. A channel with `scale = 0` produces an all-zero output for that channel (no division).
- int4 packing is **two-per-byte, low nibble first**. Byte `k` holds `value[2k]` in its low nibble and `value[2k+1]` in its high nibble (two's-complement int4). An odd-length value array zero-pads the trailing high nibble.
- "Adaptive" means scales are recomputed per keyframe and travel inside the frame's `data` (prefixed); "static" means scales are pinned by the latent-space map and travel once in `LatentStreamHeader.scales`.
- "Delta" pipelines are **video-only**. The first frame in any delta stream MUST have `keyframe = true`; non-keyframes carry a residual against the most recent keyframe.

---

## Pipeline registry

The seven pipeline names below are normative. They are a closed enum on the wire (`LatentStreamHeader.pipeline`) and in the latent-space-map schema (`pipelines[].name`). Adding a pipeline is an additive v0.3+ point release; per-deployment extension is not supported.

| Name              | Scale source     | Frame kind               | Wire data layout                      | Reduction vs `raw`    |
|-------------------|------------------|--------------------------|---------------------------------------|------------------------|
| `raw`             | n/a              | every frame is keyframe  | tensor bytes, contiguous, LE          | 1×                     |
| `int8`            | static (header)  | every frame is keyframe  | int8 tensor bytes                     | 2× over fp16           |
| `int4`            | static (header)  | every frame is keyframe  | int4 packed (low-nibble-first)        | 4× over fp16           |
| `int8-adaptive`   | per-keyframe     | every frame is keyframe  | `scales(2C)` ‖ int8 bytes             | ~2× over fp16          |
| `int4-adaptive`   | per-keyframe     | every frame is keyframe  | `scales(2C)` ‖ int4 packed            | ~4× over fp16          |
| `delta+int8`      | per-keyframe     | mixed (key + delta)      | key: `scales` ‖ int8; delta: int8     | 2× + temporal collapse |
| `delta+int4`      | per-keyframe     | mixed (key + delta)      | key: `scales` ‖ int4; delta: int4     | 4× + temporal collapse |

`‖` denotes byte concatenation.

---

## Forward transforms (server → wire)

### `raw`

```
data = ascontiguous(latent.astype(dtype, little_endian)).tobytes()
```

No channel reduction, no quantization, no header-side state. The dtype is the latent-space-map's `dtype`. Mandatory for every latent-space map: `raw` is the conformance baseline every other pipeline is measured against.

### `int8`

```
require static_scales (C fp16 values, supplied at stream construction time)
for c in 0..C-1:
  s = static_scales[c]
  data[c] = clip( rint( latent[c] / s * 127 ), -127, +127 ).int8
data_bytes = data.tobytes()
```

The fp32 multiply-divide before `rint` is mandatory: doing it in fp16 produces rounding artifacts at the boundary. Header carries `static_scales` once.

### `int4`

Same as `int8`, using `7` in place of `127`, with `int4` packing:

```
for c in 0..C-1:
  s = static_scales[c]
  data[c] = clip( rint( latent[c] / s * 7 ), -7, +7 ).int4
data_bytes = pack_int4_low_first(data)
```

### `int8-adaptive`

```
require keyframe == true (no delta variant exists)
scales = max(abs(latent), axis=spatial).fp16     # per-channel
for c in 0..C-1:
  s = scales[c]
  q[c] = clip( rint( latent[c] / s * 127 ), -127, +127 ).int8
data = scales_to_bytes(scales) ‖ q.tobytes()
```

`scales_to_bytes` writes `C × 2` LE fp16 bytes. `int8-adaptive` is preferred over `int8` when latents are heterogeneous across frames or when the maintainer doesn't want to ship a separate scales file.

### `int4-adaptive`

Same as `int8-adaptive` with int4 quantization and packing.

### `delta+int8`

```
if keyframe:
  scales = compute_per_channel_scales(latent)
  q = quantize_int8(latent, scales)
  state.last_keyframe_q = q
  state.last_keyframe_scales = scales
  data = scales_to_bytes(scales) ‖ q.tobytes()
else:
  require state.last_keyframe_q is not None        # first frame must be keyframe
  q_now = quantize_int8(latent, state.last_keyframe_scales)   # quantize against KEYFRAME's scales
  residual = sat_diff_int8(q_now, state.last_keyframe_q)      # int16 internal; clamp to [-127, +127]
  data = residual.tobytes()
```

**Why quantize against the keyframe's scales (not a fresh per-frame computation).** The whole point of delta-coding is that consecutive frames share a coordinate system. Recomputing scales per non-keyframe would shift the grid every frame and turn small motion into large residuals.

### `delta+int4`

Identical control flow to `delta+int8`, with `quantize_int4` / `sat_diff_int4` (residual clamp to `[-7, +7]`) and int4 packing.

---

## Inverse transforms (wire → client)

The inverse of every pipeline is the obvious symmetric operation: unpack bytes → multiply-add to reconstruct fp values → cast to client dtype. Implementations MUST verify bit-exact reconstruction against the fixtures in `packages/bench/golden/pipelines/<name>/` before being considered conformant.

For delta pipelines specifically:

```
on keyframe:
  parse scales(2C bytes), then int8-or-int4 keyframe values
  store state.last_keyframe_q, state.last_keyframe_scales
on delta:
  parse residual bytes (int8 or int4)
  q_now = sat_add(state.last_keyframe_q, residual)             # clamp on the same grid
  latent = q_now.astype(fp32) * state.last_keyframe_scales / max_q
```

Where `max_q` is `127` for int8 variants and `7` for int4 variants.

---

## Negotiation

A client requests a pipeline via the `pipeline` field on the request body (e.g. `POST /v1/images/generations { "pipeline": "int8", ... }`). The server MUST:

1. Reject (4xx) any pipeline name not present in this latent-space map's `pipelines[]` list.
2. Reject any `delta+*` pipeline if the request modality is `image-latents` (deltas are video-only).
3. Reject any `int8` / `int4` pipeline if the latent-space map does not provide `static_scales` for that pipeline.
4. Emit the chosen pipeline name verbatim in `LatentStreamHeader.pipeline`.

Mid-stream pipeline switches are not permitted. A new pipeline is a new stream (new `LatentStreamHeader`).

---

## Conformance

A latent client/server pair is conformant for pipeline `P` against latent-space `S` if and only if:

1. **Bit-identity**: for every fixture under `packages/bench/golden/pipelines/<P>/`, the client's reconstructed bytes match the server's emitted bytes after the inverse transform. Tested without a decoder loaded.
2. **Perceptual bound**: for every fixture, the pixels produced by the client-side decoder (loaded per the latent-space map's `decoder` block) meet the `quality_thresholds` for `(S, P)` against the canonical reference image (`decoder.canonical_image`). Tested via `latents validate` in `@codecai/maps-cli`.

The `latents validate` subcommand bundles both halves; a map cannot ship without a green run on its full pipeline registry.

---

## Encoder fast paths (v0.5+)

The forward transforms above are normative on the **wire bytes** only.
The implementation is free to differ. The Python reference encoder ships two interchangeable
fast paths for the per-channel quantize step:

| Fast path           | Triggered when                                          | Pre-quantize transfer cost                          |
|---------------------|---------------------------------------------------------|-----------------------------------------------------|
| `numpy` (default)   | Input is a numpy array, OR a torch tensor on CPU        | full fp16/fp32 latent across PCIe                   |
| `torch-gpu`         | `gpu_quantize: true` AND input is `torch.cuda.Tensor`   | post-quantize int8/int4 across PCIe (75% smaller)  |

The `torch-gpu` path runs `(latent * scale).round().clamp(-q, +q).to(int8)`
on-device and transfers the quantized tensor. Bit-exact equality with the
numpy path under the same `quality_thresholds` is **required** and
verified by the per-pipeline fixture round-trip
(`packages/bench/golden/pipelines/<name>/`). A fork that swaps numpy for
torch-gpu without passing the bit-identity gate is non-conformant.

The flag is opt-in on `LatentStreamEncoderOptions.gpu_quantize` (default
`false`). Cross-runtime callers (clients that don't carry a torch
dependency) see no behavioural change: the numpy path stays the default.

The fast path applies to all `int8` / `int4` / `int8-adaptive` /
`int4-adaptive` / `delta+*` pipelines. The `raw` pipeline has no quantize
step and is unaffected.

---

## Activation profile (v0.6+)

Status: stable, additive to v0.3/v0.5. Freezes the wire contract for
legion's pipeline-split activation frames: transformer hidden states
handed off between browser peers as one compute stage finishes a chunk of
tokens and the next stage picks it up.

The activation profile reuses the **same** `LatentStreamHeader` /
`LatentFrame` envelope as the video/image latent modality above: it does
not introduce new top-level message types. It is selected by a discriminator
field and distinguished structurally by *what varies per frame*:

|                        | Video/image latent modality        | Activation profile                     |
|------------------------|--------------------------------------|-----------------------------------------|
| Per-stream shape       | fixed `shape = [C, ...spatial]`      | none: no VAE, no spatial axes          |
| Per-frame token count  | n/a (spatial size is constant)       | **varies**: prefill chunks up to ~256 tokens, decode = 1 token |
| Header discriminator   | `profile` absent (or `'latent'`)     | `profile: 'activation'`                 |
| Header carries         | `shape`, `dtype`, `pipeline`, …      | `nEmbd`, `dtype`, `pipeline`, `profile` |
| Frame carries          | `data`, `seq`, `keyframe`, `done`, … | + `tokenCount`, `posStart`, `tokens`, `stageIndex` (all optional, activation-only) |

### Header fields

| Field        | Type      | Required                     | Meaning |
|--------------|-----------|-------------------------------|---------|
| `profile`    | `'activation'` | yes (this is the discriminator) | Selects the activation profile. Absent or `'latent'` means the original v0.3 video/image semantics: existing streams are byte-for-byte unaffected. |
| `nEmbd`      | uint      | yes                            | Fixed per-token embedding width. Every frame's payload is `tokenCount * nEmbd` elements of `dtype`. |
| `dtype`      | string    | yes                            | `fp32` or `fp16` for the `raw` pipeline today (see below). |
| `pipeline`   | string    | yes                            | One of the seven registered pipeline names (§ Pipeline registry). Only `raw` is implemented for activations today. |
| `latent_space_id` | string | yes                        | Convention: `legion/pipeline-split/<model-id>` identifies the model whose activations these are. Not a latent-space-map lookup key: there is no VAE, no `latent-space-map.schema.json` entry for activation streams (see § Relationship to latent-space maps below). |
| `shape`      | uint[]    | **omitted**                    | Not used by this profile: there is no fixed per-stream spatial shape to encode (token count varies per frame). Implementations MUST NOT require `shape` on an activation header. |

### Per-frame fields

| Field        | Type      | Required                     | Meaning |
|--------------|-----------|-------------------------------|---------|
| `tokenCount` | uint      | yes (activation frames)        | Number of tokens carried by this frame. **Explicit, not inferred**: a receiver MUST read `tokenCount` off the frame rather than derive it from `data.length` (dtype byte-width makes that derivation ambiguous, and it forecloses future non-`raw` activation pipelines whose payload isn't a fixed multiple of `tokenCount * nEmbd`). |
| `posStart`   | uint      | optional                       | Position of this frame's first token in the overall sequence (0-indexed). A prefill chunk `[tok_5 .. tok_9]` has `posStart = 5`. |
| `tokens`     | uint[]    | optional                       | Token-id sideband for prefill chunks: the ids that produced this frame's activations. Length MUST equal `tokenCount` when present. Decode frames (single generated token) typically omit `tokens`; the id isn't known until sampling completes downstream. |
| `stageIndex` | uint      | optional                       | Index of the pipeline-split stage that produced this frame, for stage-protocol routing/logging on a multi-stage split. |

All four are optional on the shared `LatentFrame` type specifically so
non-activation (video/image) latent streams are unaffected: they simply
never set them. The fields don't appear on the wire as a result (same
omit-if-undefined convention as `finish_reason`).

### Forward transform: `raw`

```
require dtype in {fp32, fp16}
data = ascontiguous(activations.astype(dtype, little_endian)).tobytes()
# activations is token-major, row-major: shape (tokenCount, nEmbd)
```

Identical byte layout to the video/image modality's `raw` pipeline (§
`raw` above): same `f32ToF16`/`f16ToF32` conversion, same little-endian
packing, applied here to a `(tokenCount, nEmbd)` tensor. The video/image
profile applies that same layout to a `(C, ...spatial)` one.
`bf16`/`int8`/`int4` dtypes are not precluded by the
wire format (the byte-length table below covers them), but are untested
for this profile until a caller needs them.

### Inverse transform

```
expected_bytes = tokenCount * nEmbd * dtype_size(dtype)   # dtype_size(int4) rounds up: ceil(n/2)
require frame.data.length == expected_bytes               # reject otherwise
activations = frombuffer(frame.data, dtype).reshape(tokenCount, nEmbd)
```

A decoder MUST validate `frame.data.length` against
`tokenCount * nEmbd * dtype_size(dtype)` and reject a mismatched frame;
silently truncating or over-reading is not acceptable. This is the activation
profile's analogue of the video modality's bit-identity conformance
requirement, just checked per-frame here. The video modality instead checks
against a fixed stream shape.

### Pipelines beyond `raw` (not yet shipped)

`int8` / `int4` / adaptive / delta variants remain optional at this
point release. The design does not preclude them: `pipeline` on an
activation header remains the same closed seven-name enum as the video/
image modality (§ Pipeline registry). An activation-profile encoder/
decoder dispatches on `pipeline` exactly like the video/image one does.
Implementations that receive a non-`raw` `pipeline` on an activation
stream today MUST reject it with a clear "not yet implemented" error.
Falling back silently to `raw` is not allowed. A future point release that
ships `int8` (say, with per-token-major-row scales in place of per-channel) adds
a forward/inverse subsection here following the same three-place checklist
as § Adding a pipeline.

### Relationship to latent-space maps

`spec/latent-space-map.schema.json` is unchanged by this profile. Its
`pipelines[].name` enum already covers every pipeline name (`raw` included)
that an activation stream could ever emit. Activation streams don't
carry a VAE, `vae_scale_factor`, or `decoder` block. There is nothing in
the schema for this profile to negotiate against. Activation streams are
negotiated out-of-band by legion's pipeline-split stage protocol (which
peer is which stage, what `nEmbd` the shared model uses).

### Example

```jsonc
// Header (msgpack; shown as JSON for readability)
{
  "type": "header",
  "latent_space_id": "legion/pipeline-split/llama-3-70b",
  "dtype": "fp16",
  "pipeline": "raw",
  "profile": "activation",
  "nEmbd": 8192
}

// Frame 1: prefill chunk, 256 tokens, stage 0 → stage 1 hop
{
  "data": /* 256 * 8192 * 2 bytes, fp16 LE, token-major */,
  "seq": 0, "keyframe": true, "done": false,
  "tokenCount": 256, "posStart": 0,
  "tokens": [/* 256 token ids */], "stageIndex": 0
}

// Frame 42: single decode token, same stage hop
{
  "data": /* 1 * 8192 * 2 bytes */,
  "seq": 42, "keyframe": false, "done": false,
  "tokenCount": 1, "posStart": 297, "stageIndex": 0
}
```

TypeScript reference: `ActivationStreamEncoder` / `ActivationStreamDecoder`
in `packages/web/src/latent-frame.ts`. Golden fixtures:
`packages/bench/golden/pipelines/activation/*.json` (header + frame bytes,
base64-encoded, alongside the plaintext token-major activation values that
produced them: the frozen reference every future change to this profile
must keep reproducing byte-for-byte).

Python twin (`packages/python/src/codecai/server/latent_frame.py`) does not
yet implement this profile: tracked as a follow-up; port the same
`profile`/`nEmbd`/`tokenCount`/`posStart`/`tokens`/`stageIndex` fields
against `encode_latent_header_msgpack` / `encode_latent_frame_msgpack` plus
new `ActivationStreamEncoder`/decode-side functions mirroring this section.

---

## Compression interaction

Latent zstd dictionaries are keyed by `(latent_space_id, format, pipeline)`: see `latent-space-map.schema.json#/properties/zstd_dictionaries`. A dict trained on `raw` bytes is meaningless against `int8` bytes (different distributions). A server MUST NOT respond with `Content-Encoding: zstd` unless it has loaded a dict whose `(format, pipeline)` triple matches the response.

The `Codec-Zstd-Dict` response header carries the active dict's sha256 unchanged from the v0.2 text-side semantics; the client matches it against the latent-space map's `zstd_dictionaries[]` to locate the bytes.

---

## Adding a pipeline (informative)

A new pipeline ships in three places, all in the same point release:

1. This document: append to the registry table and write forward + inverse subsections.
2. `spec/latent-space-map.schema.json`: extend the `pipelines[].name` enum and the `zstd_dictionaries[].pipeline` enum.
3. `packages/python/src/codecai/server/latent_frame.py`: add to `PIPELINE_NAMES`, the appropriate `_*_PIPELINES` set, and a branch in `LatentStreamEncoder._encode_pipeline`.

Forks (ComfyUI, diffusers) vendor `latent_frame.py` directly and pick up new pipelines on the next sync.
