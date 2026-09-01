# syntax=docker/dockerfile:1.7
#
# golden-builder: frozen torch + diffusers + CUDA reference image.
#
# This container is the **perceptual trust anchor** for every latent bench
# cell. Given a latent tensor (the bytes a Codec server emits) and a
# latent-space identifier (e.g. stabilityai/sd-vae-ft-mse), it produces the
# reference RGB pixels every SSIM / PSNR / LPIPS / VMAF measurement is
# resolved against.
#
# The container's sha256 digest IS the contract. Bench fingerprints
# (methodology.modality.quality_reference.container_sha256) reference this
# digest by hash, not by tag. Bumping torch or diffusers here re-pins the
# perceptual reference for every downstream cell: bump
# `codec-supervisor/Dockerfile.diffusers` in lockstep, or the bench
# fingerprint-validator quarantines diffusers cells against a stale golden.
#
# Usage:
#   docker build -t codec-golden:torch-2.5.1-diffusers-0.31.0 -f Dockerfile .
#   docker run --rm --gpus all \
#       -v $(pwd)/golden:/golden \
#       -v $(pwd)/methodology:/methodology:ro \
#       codec-golden:torch-2.5.1-diffusers-0.31.0 \
#       --fixtures /methodology/latent-fixtures.json \
#       --latent-space stabilityai/sd-vae-ft-mse \
#       --out /golden
#
# The image's PERCEPTUAL_REFERENCE_PINS file (written at build time) is the
# self-attestation a downstream validator reads to confirm the container is
# what its tag claims it is.

ARG UBUNTU_VERSION=24.04
ARG CUDA_VERSION=12.4.1
ARG BASE_IMAGE=nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_VERSION}

# These three are THE perceptual contract. Bumping any of them is a
# breaking change to every latent bench cell; the bench validator
# refuses to compare cells across different pins.
ARG TORCH_VERSION=2.5.1
ARG TORCHVISION_VERSION=0.20.1
ARG DIFFUSERS_VERSION=0.31.0
ARG TRANSFORMERS_VERSION=4.45.2
ARG SAFETENSORS_VERSION=0.4.5
ARG ACCELERATE_VERSION=1.1.1
ARG NUMPY_VERSION=2.1.2

FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.title="codec-golden" \
      org.opencontainers.image.description="Frozen torch + diffusers reference for Codec latent-modality bench. The container digest IS the perceptual contract." \
      org.opencontainers.image.source="https://github.com/wdunn001/Codec" \
      org.opencontainers.image.url="https://codecai.net" \
      org.opencontainers.image.vendor="Quasarke" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        ca-certificates curl \
        libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

ARG TORCH_VERSION
ARG TORCHVISION_VERSION
ARG DIFFUSERS_VERSION
ARG TRANSFORMERS_VERSION
ARG SAFETENSORS_VERSION
ARG ACCELERATE_VERSION
ARG NUMPY_VERSION

# ---------- 1. install pinned torch + diffusers stack ----------
RUN --mount=type=cache,target=/root/.cache/pip,id=golden-pip \
    pip install --break-system-packages --upgrade pip \
 && pip install --break-system-packages \
        --index-url https://download.pytorch.org/whl/cu124 \
        torch==${TORCH_VERSION} torchvision==${TORCHVISION_VERSION} \
 && pip install --break-system-packages \
        diffusers==${DIFFUSERS_VERSION} \
        transformers==${TRANSFORMERS_VERSION} \
        safetensors==${SAFETENSORS_VERSION} \
        accelerate==${ACCELERATE_VERSION} \
        numpy==${NUMPY_VERSION} \
        pillow \
        scikit-image \
        lpips

# ---------- 2. self-attestation file ----------
# Written at build time. The bench fingerprint-validator reads this on
# container start so every golden image carries the (torch_version,
# diffusers_version, transformers_version, numpy_version) triple it was
# rendered against. Mismatch with methodology.modality.quality_reference
# fails the validator fast.
RUN python3 -c "import torch, diffusers, transformers, numpy; \
print(f'torch={torch.__version__}\\ndiffusers={diffusers.__version__}\\ntransformers={transformers.__version__}\\nnumpy={numpy.__version__}')" \
    > /opt/golden/PERCEPTUAL_REFERENCE_PINS

# ---------- 3. entry point ----------
COPY build_golden.py /opt/golden/build_golden.py
RUN chmod +x /opt/golden/build_golden.py

ENV HF_HOME=/root/.cache/huggingface

# Run as a script, not a server. The container is one-shot: start, decode
# every fixture in latent-fixtures.json into reference pixels under /golden,
# write a manifest.json, exit.
ENTRYPOINT ["python3", "/opt/golden/build_golden.py"]
CMD ["--help"]
