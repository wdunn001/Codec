# SUMMARY: first end-to-end latent bench, real diffusers latents on the wire

**Run**: `2026-05-09T13-01-55Z`
**Engine**: `wdunn001/codec-diffusers:v0.3.4` running `stable-diffusion-v1-5/stable-diffusion-v1-5`
**Lab**: `vinez@192.168.1.88` GPU 1 (RTX 3090, fp16, CUDA)
**Endpoint**: `http://192.168.1.88:8181/v1/images/generations`
**Latent space**: `stabilityai/sd-vae-ft-mse`
**Reps**: 1

## Headline: pipeline math validates against real latents

Pipeline math (per `spec/PIPELINES.md`) collapses wire bytes exactly as the spec promises, end-to-end against real diffusers SD-1.5 latents:

| Fixture           | raw         | int8        | int4        | int8 vs raw | int4 vs raw |
|-------------------|------------:|------------:|------------:|------------:|------------:|
| **256×256** (4×32×32 latent) |     8.4 KB  |     4.4 KB  |     2.4 KB  |    **1.9×** |    **3.5×** |
| **512×512** (4×64×64 latent) |    32.4 KB  |    16.4 KB  |     8.4 KB  |    **2.0×** |    **3.9×** |

`raw` matches the theoretical wire shape exactly:
- 256×256 → 4×32×32×2 bytes (fp16) = 8192 B + 230 B msgpack envelope = 8.4 KB ✓
- 512×512 → 4×64×64×2 bytes (fp16) = 32768 B + 247 B envelope = 32.4 KB ✓

`int8` halves it (per-channel symmetric quantization to int8). `int4` halves it again (packed 2-per-byte, low-nibble-first). All three pipelines match the spec's pipeline registry to the byte.

## Compression on top doesn't help (yet): expected

| 256/int8/encoding   | wire  |
|---------------------|------:|
| `identity`          | 4.4 KB|
| `gzip`              | 4.4 KB|
| `zstd`              | 4.4 KB|

Per `spec/PROTOCOL.md` § "Compression and dictionaries":

> Raw fp16 latents are near-Gaussian by construction (the VAE encoder is trained to produce a near-isotropic prior), so a dict trained on raw bytes wins only ~5 to 15% over no-dict zstd. The dict pays off only after a structural pre-pass: quantization concentrates bytes into a small alphabet, and (for video) delta-coding collapses temporally redundant values into mostly-zero residuals. A dict trained on the post-pipeline byte stream therefore captures the structure the pipeline produces: and is meaningless against any other pipeline.

This run **doesn't have per-pipeline zstd dicts loaded**: those need a corpus capture (`packages/bench/scripts/capture-latent-samples.py`) followed by training (`train-zstd-dict-latents.py`). Tracked as the next concrete step. Expected gain: ~25 to 40% additional reduction on int8/int4 with a properly-trained per-pipeline dict.

## Adaptive pipelines correctly rejected for image fixtures

```
HTTP 400: pipeline 'int8-adaptive' not supported for image-latents
HTTP 400: pipeline 'int4-adaptive' not supported for image-latents
```

Per spec: `int8-adaptive` / `int4-adaptive` recompute scales per keyframe, which only buys anything on video streams. The diffusers fork enforces this at the request layer. ✓

## Wire-shape vs raw-pixel comparison (informative)

A 512×512 RGB image as JPEG (typical web quality 85): ~80 to 150 KB. As fp16 raw pixels: 1.5 MB.

The 512 latent at int8 (**16.4 KB**) is ~5 to 10× smaller than JPEG and ~90× smaller than raw fp16 pixels. The leaf-side `vae_decode` reconstructs pixels client-side (out of scope for this wire bench).

## TTFF observations

| Fixture | First call | Steady-state |
|---------|-----------:|-------------:|
| 256     |     6 min* |       ~640 ms|
| 512     |     ~1.2 s |       ~1.2 s |

*First-call latency is dominated by the SD-1.5 model fetch from HuggingFace (4 GB): once cached, generation is steady-state.

## Methodology fingerprint (preliminary)

This is the first latent run; the full SCHEMA-v1 methodology block isn't filled in yet (no perceptual numbers, no decoder runtime split, no rate-distortion plot: those need the perceptual sibling pass + the golden-builder reference). What's measured here:
- Raw socket bytes received (no Content-Encoding decompression)
- TTFF = first response body chunk (approximation of first LatentFrame)
- Total = wall-clock to last byte
- 1 rep per cell (a smoke run; `BENCH_LATENT_REPS=2+` would median)

## Next concrete steps

1. **Train per-pipeline zstd dicts** to unlock the structural compression layer. Pipeline:
   - `python3 packages/bench/scripts/capture-latent-samples.py` against the running diffusers (need ~50+ generations per pipeline to populate the corpus).
   - `python3 packages/bench/scripts/train-zstd-dict-latents.py` per `(latent_space_id, format, pipeline)` triple → ship dicts under `dictionaries/`.
   - Re-run with `BENCH_LATENT_FIXTURES=256,512 BENCH_LATENT_REPS=3` to measure the dict-zstd numbers.

2. **Add video fixtures** (`video-1s`, `video-5s`) once the diffusers fork has a video pipeline loaded (currently SD-1.5 image-only). Will surface the `delta+int8` / `delta+int4` win: expected 3 to 5× over per-frame int8 due to temporal redundancy.

3. **Perceptual sibling pass**: the wire bench measures bytes; the perceptual gate measures SSIM/PSNR/LPIPS against the canonical decoder reference. Land as a separate `latent-perceptual.ts` script that loads a decoder + computes quality vs `packages/bench/golden/`.

4. **codec-comfyui A/B**: same fixtures + pipelines through the comfyui fork, validate cross-engine wire-byte parity.
