# Codec Latent Pipelines — v1

Status: stable, additive to v0.3. Companion to
[`PROTOCOL.md`](./PROTOCOL.md) §Latent Modality.

This document pins the **bit-level math** for every named latent pipeline.
A pipeline is a deterministic byte-level transform applied server-side
before a `LatentFrame` hits the wire and inverted client-side before
bytes are fed to the decoder. Same pipeline name = bit-identical bytes
across every implementation, on every host, in every language.

---

## Why

The `pipeline` field on `LatentStreamHeader` and on `accept_pipelines` in
`HELLO` is a name from a normative registry, not a parameter set. Two
servers running the same pipeline name MUST produce byte-identical wire
output for byte-identical fp16 latent input. Otherwise:

  - Pre-trained zstd dictionaries (keyed by `(format, pipeline)`) silently
    miscompress.
  - Cross-runtime reference vectors stop being a conformance contract.
  - A latent stream emitted by server A becomes undecodable by client B
    even though they agreed on the name.

Pipelines are not extensible per-deployment. Adding pipeline #8 is a
v0.3+ point release that ships the math here, fixtures under
`packages/bench/golden/pipelines/<name>/`, and conformance updates in
every client's bench harness. See [`PROTOCOL.md`](./PROTOCOL.md) Open
Question (v0.3) #2.

---

## Schema — where the bytes live

Pipeline payloads occupy two places:

```
LatentStreamHeader.scales         ← per-stream scale block (static-scale pipelines only)
LatentFrame.data                  ← per-frame payload (every pipeline)
```

| Field                          | Semantics                                                                                                    |
|--------------------------------|--------------------------------------------------------------------------------------------------------------|
| `LatentStreamHeader.scales`    | C × 2 bytes (one fp16 little-endian per channel). REQUIRED for `int8`, `int4`. ABSENT for all others.        |
| `LatentFrame.data` (raw)       | `prod(shape) × sizeof(dtype)` bytes, packed C-order, little-endian.                                           |
| `LatentFrame.data` (int8/int4) | Quantized payload only — no scales prefix. Scales come from the header.                                       |
| `LatentFrame.data` (adaptive)  | On a `keyframe=true` frame: scales block (C × 2 bytes fp16 LE) followed by quantized payload. On a `keyframe=false` frame: payload only — scales inherited from the most recent keyframe. |
| `LatentFrame.data` (delta+\*)  | Adaptive-style scales on every `keyframe=true` frame. `keyframe=false` frames carry residuals only.            |

### Universal conventions

These rules hold for every pipeline. Implementations MUST follow them:

1. **Endianness: little-endian everywhere.** fp16 / fp32 / int8 / int4
   payloads, scale floats, every multi-byte value. Matches msgpack /
   protobuf defaults and x86/ARM native.
2. **Element order: C-order, channel-axis first.** Indexing `(c, h, w)`
   for shape `[C, H, W]`: `w` varies fastest, then `h`, then `c`. Same
   convention numpy / torch / ONNX use for NCHW tensors with N=1.
3. **Channel axis = `shape[0]`.** Every pipeline that needs per-channel
   scales takes C from `LatentStreamHeader.shape[0]`.
4. **fp16 = IEEE 754 binary16.** No flush-to-zero, no denormal handling
   beyond the IEEE default. NaN and ±Inf in scales are protocol errors
   (real latents never produce them).
5. **Rounding mode: round-half-to-even** (IEEE 754 `roundTiesToEven`,
   numpy/torch default). Other modes diverge at exact-half values and
   break bit-exact round-trip.
6. **Quantized integer ranges are symmetric and avoid the negative
   edge.** int8 ∈ [−127, 127], int4 ∈ [−7, 7]. The −128 / −8 edge is
   not used; this trades 0.4% of dynamic range for a clean symmetric
   quantizer (`q = round(x · max_q / s)`, no zero-point).
7. **Saturation, not wraparound.** Any quantize step that overflows the
   integer range MUST clamp to the symmetric bound. Wraparound produces
   visually catastrophic errors in delta pipelines; clamping degrades
   gracefully.

---

## Pipelines v1

### `raw`

Lossless pack of the latent tensor.

**Forward** (server):
```
data = bytes(latent.astype(dtype), order='C', endian='little')
```
**Inverse** (client):
```
latent = ndarray(data, shape=shape, dtype=dtype, order='C', endian='little')
```
**Layout:**

```
LatentStreamHeader.scales : absent
LatentFrame.data          : prod(shape) × sizeof(dtype) bytes
```

`raw` is the **mandatory negotiation fallback**. Every implementation —
server or client — MUST support it. A server picks `raw` whenever the
client's `accept_pipelines` and the server's supported set intersect at
no other pipeline. `raw` works against any latent-space map without
additional metadata, weights, or training.

---

### `int8` — static-scale, image-latents

Per-channel symmetric int8 quantization. Scales pinned in the header
once, used by every frame in the stream. Suitable for image streams
(single keyframe, no temporal drift).

**Forward** (server):
```
for c in range(C):
    s[c] = max(abs(latent[c, :, :]).flatten())                # per-channel max
q[c, h, w] = round_to_even(latent[c, h, w] / s[c] * 127.0)
q[c, h, w] = clamp(q[c, h, w], -127, 127)                     # saturate
```
**Inverse** (client):
```
latent[c, h, w] = q[c, h, w] / 127.0 * s[c]
```
**Layout:**
```
LatentStreamHeader.scales : C × 2 bytes (fp16 LE, one per channel)
LatentFrame.data          : C × H × W bytes (signed int8)
```
**Edge case:** `s[c] = 0` (entirely-zero channel). `q[c, h, w] = 0` for
all h, w. Inverse trivially returns zeros. No special framing.

---

### `int4` — static-scale, image-latents

Per-channel symmetric int4 quantization, two values packed per byte
(low nibble first within each byte).

**Forward** (server):
```
for c in range(C):
    s[c] = max(abs(latent[c, :, :]).flatten())
q[c, h, w] = round_to_even(latent[c, h, w] / s[c] * 7.0)
q[c, h, w] = clamp(q[c, h, w], -7, 7)
```

**Packing.** Iterate values in C-order. Pair them up; for each pair
`(v_lo, v_hi)`:
```
byte = (v_lo & 0x0F) | ((v_hi & 0x0F) << 4)
```
That is — first value goes in the **low nibble**, second in the **high
nibble**. If `prod(shape)` is odd, the final byte's high nibble is
zero-padded.

**Inverse** (client):
```
v_lo = sign_extend_4(byte & 0x0F)            # → int8 in [-8, 7]
v_hi = sign_extend_4(byte >> 4)
```
where `sign_extend_4(n) = n - 16 if n >= 8 else n`.

**Layout:**
```
LatentStreamHeader.scales : C × 2 bytes (fp16 LE, one per channel)
LatentFrame.data          : ceil(C × H × W / 2) bytes
```

---

### `int8-adaptive` — per-keyframe scale, video-latents

Same forward/inverse math as `int8`, but scales are recomputed and
transmitted on **every keyframe**. Non-keyframe (delta) frames are
not used by this pipeline — every frame is a keyframe under
`int8-adaptive`. (For temporal compression, use `delta+int8`.)

**Forward** (server, every frame):
```
for c in range(C):
    s_n[c] = max(abs(latent_n[c, :, :]).flatten())              # frame-n scales
q_n[c, h, w] = clamp(round_to_even(latent_n[c, h, w] / s_n[c] * 127.0), -127, 127)
```
**Inverse** (client, every frame): same as `int8`, with the per-frame
scales that prefix `data`.

**Layout:**
```
LatentStreamHeader.scales : ABSENT
LatentFrame.data (every frame, keyframe=true):
  bytes [0 .. 2C)     : scales block (C × 2 bytes fp16 LE)
  bytes [2C .. 2C + CHW) : quantized payload (signed int8)
```

The `keyframe=false` form is reserved for `delta+*` pipelines and MUST
NOT appear under `int8-adaptive`.

---

### `int4-adaptive` — per-keyframe scale, video-latents

`int4` math with `int8-adaptive` framing.

**Layout:**
```
LatentStreamHeader.scales : ABSENT
LatentFrame.data (every frame, keyframe=true):
  bytes [0 .. 2C)            : scales block (C × 2 bytes fp16 LE)
  bytes [2C .. 2C + ceil(CHW/2)) : packed int4 payload
```

---

### `delta+int8` — temporal residual, video-latents

Keyframes carry int8-adaptive payloads. Delta frames carry int8
**residuals** against the most recent keyframe in the same stream,
encoded with that keyframe's scales (so the quantization grid stays
consistent).

**Keyframe N (`keyframe=true`):**
Identical to `int8-adaptive` keyframe layout. The receiver retains
`s_N[c]` and `q_N[c, h, w]` until the next keyframe arrives.

**Delta frame M (`keyframe=false`), referencing the most recent keyframe N:**

Forward:
```
q_M[c, h, w] = clamp(round_to_even(latent_M[c, h, w] / s_N[c] * 127.0), -127, 127)
delta[c, h, w] = clamp(q_M[c, h, w] - q_N[c, h, w], -127, 127)        # saturating
```
Note the **outer saturation** on `delta`: even though `q_M, q_N ∈
[−127, 127]` so the natural difference is in `[−254, 254]`, the
transmitted residual is clipped to int8 range. A delta exceeding ±127
is a protocol-permitted lossy event; receivers MUST NOT special-case it.

Inverse:
```
q_M[c, h, w] = clamp(q_N[c, h, w] + delta[c, h, w], -127, 127)        # saturating add
latent_M[c, h, w] = q_M[c, h, w] / 127.0 * s_N[c]
```

After processing frame M, the receiver retains `q_M` as the new
"most recent reconstruction" but **does not** treat M as the next
keyframe — it keeps using N's scales until a frame arrives with
`keyframe=true`.

**Reference rule.** A delta frame's reference is *always* the most
recent keyframe in the same stream by `seq` order. Implementations
MUST drop a delta frame whose `seq` < that keyframe's `seq` (a
re-ordered packet on a lossy transport — WebRTC datagram channels with
`max_retransmits: 0` permit this). Out-of-order keyframes are also
dropped; only forward-progressing `seq` values are valid.

**Stream restart.** A `keyframe=true` frame discards the previous
keyframe state. Subsequent deltas reference the new keyframe.

**Layout:**
```
LatentStreamHeader.scales : ABSENT

Keyframe (keyframe=true):
  bytes [0 .. 2C)               : scales block (C × 2 bytes fp16 LE)
  bytes [2C .. 2C + CHW)        : int8 quantized payload

Delta (keyframe=false):
  bytes [0 .. CHW)              : int8 residual payload
```

---

### `delta+int4` — temporal residual, video-latents

`delta+int8` framing with int4 quantization. Residuals are packed
two-per-byte with the same low-nibble-first convention as `int4`. The
saturating bound is ±7 instead of ±127.

Note: the int4 quantization grid is coarse enough that delta saturation
events are common in motion-rich content. Use `delta+int8` unless wire
budget is tight enough to justify the perceptual cost.

**Layout:**
```
Keyframe (keyframe=true):
  bytes [0 .. 2C)                       : scales block (C × 2 bytes fp16 LE)
  bytes [2C .. 2C + ceil(CHW/2))        : packed int4 quantized payload

Delta (keyframe=false):
  bytes [0 .. ceil(CHW/2))              : packed int4 residual payload
```

---

## Worked example

A toy fp16 latent with `shape = [2, 2, 2]` (C=2, H=2, W=2):

```
latent[0, :, :] = [[ 1.000, -2.000],
                   [ 3.000,  0.500]]    # max |x| = 3.000 → s_0 = 3.000

latent[1, :, :] = [[-0.500,  0.250],
                   [-0.125,  0.0625]]   # max |x| = 0.500 → s_1 = 0.500
```

### Under `raw`

`LatentFrame.data` = 16 bytes (8 fp16 LE values, C-order):
```
ch0:  3C 00  C0 00  42 00  38 00         # fp16 LE: 1.0, -2.0, 3.0, 0.5
ch1:  B8 00  34 00  B0 00  2C 00         # fp16 LE: -0.5, 0.25, -0.125, 0.0625
```

### Under `int8`

Per-channel scales:
```
s[0] = 3.0  → fp16 0x4200 → bytes 00 42
s[1] = 0.5  → fp16 0x3800 → bytes 00 38
```

Quantize (`q = round_to_even(x / s · 127)`, clamp to [−127, 127]):
```
ch0: round( 1.000/3 · 127) = round( 42.333) =  42  →  0x2A
     round(-2.000/3 · 127) = round(-84.667) = -85  →  0xAB  (two's-complement int8)
     round( 3.000/3 · 127) = round( 127.0)  = 127  →  0x7F
     round( 0.500/3 · 127) = round( 21.167) =  21  →  0x15

ch1: round(-0.500 /0.5 · 127) = -127  →  0x81
     round( 0.250 /0.5 · 127) =   64  →  0x40   (round-half-to-even: 63.5 → 64)
     round(-0.125 /0.5 · 127) =  -32  →  0xE0
     round( 0.0625/0.5 · 127) =   16  →  0x10   (round-half-to-even: 15.875 → 16)
```

Wire:
```
LatentStreamHeader.scales : 00 42 00 38                                       (4 bytes)
LatentFrame.data          : 2A AB 7F 15 81 40 E0 10                            (8 bytes)
```
Total: **12 bytes** vs `raw`'s **16 bytes** (25% reduction at this size; the
ratio approaches 50% as `prod(shape)` grows because the 4-byte scales
amortize).

### Under `int4`

Quantize with `max_q = 7`:
```
ch0: round( 1.000/3 · 7) =  2     ; round(-2.000/3 · 7) = -5
     round( 3.000/3 · 7) =  7     ; round( 0.500/3 · 7) =  1

ch1: round(-0.500 /0.5 · 7) = -7  ; round( 0.250 /0.5 · 7) =  4   (3.5 → 4)
     round(-0.125 /0.5 · 7) = -2  ; round( 0.0625/0.5 · 7) =  1   (0.875 → 1)
```
Two's-complement nibbles: `2=0x2, -5=0xB, 7=0x7, 1=0x1, -7=0x9, 4=0x4, -2=0xE, 1=0x1`.

Pack low-nibble-first within each byte:
```
byte 0: lo = 0x2, hi = 0xB → 0xB2     (ch0 values 2, -5)
byte 1: lo = 0x7, hi = 0x1 → 0x17     (ch0 values 7,  1)
byte 2: lo = 0x9, hi = 0x4 → 0x49     (ch1 values -7, 4)
byte 3: lo = 0xE, hi = 0x1 → 0x1E     (ch1 values -2, 1)
```

Wire:
```
LatentStreamHeader.scales : 00 42 00 38         (4 bytes)
LatentFrame.data          : B2 17 49 1E         (4 bytes)
```
Total: **8 bytes** — half of `int8`, a quarter of `raw`. Dequantization
recovers values within ±s/14 of the original, which for SD VAE latents
typically leaves SSIM > 0.99 at decode time.

### Under `int8-adaptive` (single keyframe)

Same numbers as `int8`, scales relocated to the frame:
```
LatentStreamHeader.scales : ABSENT
LatentFrame.data (keyframe=true):
  bytes [0..4)  : 00 42 00 38                        (scales)
  bytes [4..12) : 2A AB 7F 15 81 40 E0 10            (payload)
```
Total wire payload: 12 bytes (identical to `int8`; the adaptive form
breaks even on a single-keyframe stream and wins as soon as a second
keyframe with different per-channel ranges arrives).

---

## Cross-implementation conformance

Every pipeline ships with three reference files under
`packages/bench/golden/pipelines/<name>/`:

```
input.fp16        ← canonical fp16 latent tensor (the worked-example
                    fixture, plus a richer SD-style 4×64×64 fixture)
header.bin        ← bytes of LatentStreamHeader.scales (or zero-length
                    file for pipelines that put scales in the frame)
frame.bin         ← bytes of LatentFrame.data (the keyframe; deltas have
                    additional fixtures for delta+int8/delta+int4)
output.fp16       ← post-roundtrip latent (equals input.fp16 for raw;
                    quantization-snapped for int8/int4)
```

Every client's bench harness MUST run two checks per pipeline:

1. **Forward conformance.** Server-side encoder reads `input.fp16`,
   produces `header.bin` and `frame.bin`, asserts byte-identical equality.
2. **Inverse conformance.** Client-side decoder reads `header.bin` +
   `frame.bin`, produces a latent tensor, asserts byte-identical equality
   to `output.fp16`.

A pipeline that fails either check on any client is a release blocker
for that client.

---

## Compatibility

v1 is the initial pipeline registry: `raw`, `int8`, `int4`,
`int8-adaptive`, `int4-adaptive`, `delta+int8`, `delta+int4`. All
seven names are normative.

An implementation that receives a `LatentStreamHeader.pipeline` not in
this list MUST reject the stream with an `ERROR` frame
(`finish_reason: "error"` if the stream is already established) rather
than silently treating it as a known pipeline.

Adding a pipeline to v1.x is additive (new name, new fixture set, new
client conformance test). Removing or changing the math of an existing
pipeline is a v2 break — a deployed `(latent_space_id, pipeline)` pair
would change meaning, which the discovery convention's hash-pinning
cannot detect because the pipeline name is not part of the map's
content addressing.

The seven v1 pipeline names are reserved permanently. A future v2 that
wants to redefine `int8` (e.g. asymmetric instead of symmetric) MUST
publish under a new name (`int8v2`, etc.).
