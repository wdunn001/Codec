# Activation profile golden fixtures

Conformance fixtures for the `raw`-pipeline activation profile (see
[`spec/PIPELINES.md`](../../../../spec/PIPELINES.md) § Activation
profile). Each `*.json` file freezes one `(header bytes, frame bytes)`
pair produced by `ActivationStreamEncoder` in
`packages/web/src/latent-frame.ts`: the bytes every conformant
implementation (this TS module, the Python twin once it's ported, any
future vendor of the wire contract) must keep reproducing exactly, given
the same input activations and frame options.

## Fixture shape

```jsonc
{
  "description": "...",
  "profile": "activation",
  "pipeline": "raw",
  "dtype": "fp32" | "fp16",
  "latent_space_id": "legion/pipeline-split/test-model",
  "nEmbd": 4,
  "frame_meta": {
    "seq": 0, "keyframe": true, "done": false,
    "tokenCount": 3, "posStart": 0, "tokens": [15, 22, 9], "stageIndex": 1
  },
  "activations": [[...], [...], [...]],   // tokenCount x nEmbd, row-major, plaintext fp32 input
  "header_msgpack_b64": "...",             // base64(encodeLatentHeaderMsgpack(...))
  "frame_msgpack_b64": "..."               // base64(encodeLatentFrameMsgpack(...))
}
```

`activations` is the plaintext (never-quantized) input. A from-scratch
implementation in another language can therefore regenerate `header_msgpack_b64` /
`frame_msgpack_b64` independently and diff against the frozen bytes,
without needing to reverse-engineer them out of the msgpack payload first.

## Conformance check

1. Base64-decode `header_msgpack_b64` / `frame_msgpack_b64`, msgpack-decode
   them, and verify the decoded fields match `profile` / `nEmbd` / `dtype`
   / `pipeline` / `frame_meta`.
2. Decode `frame.data` per the `raw` pipeline's inverse transform (§
   Activation profile in PIPELINES.md) and verify it equals `activations`
   flattened, exactly (both fixtures use fp16-exact values: this holds
   bit-for-bit for both `fp32` and `fp16` dtype fixtures as a result).
3. Re-encode `activations` with the same `frame_meta` and verify the
   resulting bytes equal the frozen `header_msgpack_b64` /
   `frame_msgpack_b64` exactly.

`packages/web/test/latent-frame.test.ts` (`describe('activation profile:
golden fixtures ...')`) implements all three checks for the TypeScript
side and is the reference implementation of this conformance procedure.

## Regenerating

Fixtures are deterministic (no RNG) and should only change if the wire
format intentionally changes: which is a breaking change to this profile
and must be called out in `spec/PIPELINES.md`. To regenerate after an
intentional change, re-run the generator that produced these files against
`ActivationStreamEncoder`, freezing new `header_msgpack_b64` /
`frame_msgpack_b64` values.

## Files

- `raw-fp32-prefill.json`: 3 tokens × 4-wide fp32, full sideband (`tokens`, `posStart`, `stageIndex`).
- `raw-fp32-decode.json`: 1 token × 4-wide fp32 (decode step), no `tokens[]` (id not yet known at encode time).
- `raw-fp16-prefill.json`: 5 tokens × 8-wide fp16, full sideband, later pipeline-split stage (`stageIndex: 2`).
