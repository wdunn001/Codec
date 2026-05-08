# `golden-builder` — perceptual trust anchor for Codec latent bench

This directory builds the Docker image that produces the **reference RGB pixels** every Codec latent bench cell resolves SSIM / PSNR / LPIPS / VMAF against.

## Why a frozen container?

Codec latent streams travel as VAE latent tensors, not pixels. The contract splits in two (see [`spec/PROTOCOL.md`](../../../spec/PROTOCOL.md) §"Validation contract"):

1. **Latent-byte boundary: bit-identical.** Server-emitted bytes equal client-received bytes, byte-for-byte. Tested without a decoder loaded, so every client (including ones with no GPU) can verify it.
2. **Pixel boundary: perceptual bound only.** VAE decoders are floating-point and non-deterministic across runtimes (torch / ONNX-Web / ggml / WGSL), so the contract collapses to "your decoded pixels match a frozen reference within published SSIM / PSNR / LPIPS thresholds."

The reference is *this image*. Its sha256 digest IS the contract. Bench fingerprints reference the image by digest, not by tag — pinning by tag would let a registry rebuild silently re-render every reference.

## What it does

Given:
- `methodology/latent-fixtures.json` — the canonical fixture list,
- A `latent_space_id` (e.g. `stabilityai/sd-vae-ft-mse`),
- A directory of pre-captured latent bytes (one file per fixture key, produced by `capture-latent-samples.py`),

…it loads the matching VAE in pinned `torch` + `diffusers` versions, runs `vae.decode(latent / scale_factor)`, and writes the decoded RGB pixels under:

```
golden/<latent_space_id>/<fixture_key>/reference.png        # image fixtures
golden/<latent_space_id>/<fixture_key>/frame_<NNNN>.png     # video fixtures
golden/<latent_space_id>/<fixture_key>/manifest.json
```

The `manifest.json` carries the `(torch_version, diffusers_version, container_pins)` triple, the input latent sha256, and the reference output sha256. Bench cells fail fingerprint-validation if any of these drift.

## Build + run

```bash
cd packages/bench/golden-builder

# Build (one-shot; tag includes the perceptual pin so the digest is reproducible).
docker build -t codec-golden:torch-2.5.1-diffusers-0.31.0 .

# Render the canonical reference for sd-vae-ft-mse against pre-captured bytes.
docker run --rm --gpus all \
    -v "$(pwd)/../golden:/golden" \
    -v "$(pwd)/../methodology:/methodology:ro" \
    -v "$(pwd)/../corpora/sd-vae-ft-mse-synth:/inputs:ro" \
    codec-golden:torch-2.5.1-diffusers-0.31.0 \
    --fixtures        /methodology/latent-fixtures.json \
    --latent-space    stabilityai/sd-vae-ft-mse \
    --latent-bytes-dir /inputs \
    --out             /golden
```

## Bumping the perceptual pin

Bumping torch or diffusers in the `Dockerfile` is a **breaking change** to every latent bench cell already rendered against the previous pin. To roll forward:

1. Bump `TORCH_VERSION` / `DIFFUSERS_VERSION` (and friends) in `Dockerfile`.
2. Bump the matching `ARG` block in `codec-supervisor/Dockerfile.diffusers` so the codec-diffusers server image tracks the same versions. Out-of-lockstep pins make the diffusers server's `quality_reference` mismatch the canonical golden, and the bench fingerprint-validator will quarantine every cell from that server.
3. Rebuild this image, re-render every latent fixture, push the new image with a new tag (`torch-X.Y.Z-diffusers-A.B.C`), publish the new digest.
4. Bump `methodology.modality.quality_reference.container_sha256` in any methodology JSON that references the prior pin.

Per [`spec/PROTOCOL.md`](../../../spec/PROTOCOL.md) Open Question (v0.3) #3, this image is the canonical implementation of the "frozen Docker image" trust-anchor decision. Owner: tracked separately in HANDOFF.md.
