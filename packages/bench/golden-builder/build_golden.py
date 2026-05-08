#!/usr/bin/env python3
"""
Build the perceptual ground-truth pixels for Codec latent bench fixtures.

This script runs INSIDE the codec-golden container (see Dockerfile in
this directory). It loads each fixture from latent-fixtures.json,
either:

  (a) Generates the latent tensor deterministically by running the
      diffusers pipeline at the configured seed + steps (default mode),
  (b) OR reads a pre-captured latent tensor from --latent-bytes-dir
      (when re-rendering against existing wire captures, e.g. when
      bumping the perceptual reference).

It then runs vae.decode(latent / vae_scale_factor) and saves the
resulting RGB image (or video frames) as PNGs under:

    /golden/<latent_space_id>/<fixture_key>/reference.png       (image)
    /golden/<latent_space_id>/<fixture_key>/frame_<NNNN>.png    (video)

Plus a manifest.json carrying:
  - fixture key + parameters
  - sha256 of input latent bytes
  - sha256 of decoded reference output
  - the container's PERCEPTUAL_REFERENCE_PINS attestation
  - torch / diffusers versions seen at decode time

Bench cells reference these manifests by sha256 — a mismatch quarantines
the cell rather than silently using a stale golden.

This is the **only** place SSIM/PSNR/LPIPS comparisons are anchored.
Every (engine, lang) cell measuring perceptual quality runs its decoder
on the SAME latent bytes captured in the corresponding corpora/ entry,
and resolves against THIS golden. Cross-runtime drift (torch vs ONNX-Web
vs ggml vs WGSL on identical inputs) is then a measurable property
because the input is bit-fixed and the reference is fixed at this
container's digest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
import torch
from diffusers import AutoencoderKL, DiffusionPipeline
from PIL import Image


# Latent-space → torch model resolution. The ID is the same string that
# travels on the wire in LatentStreamHeader.latent_space_id; the value
# is the HuggingFace repo to pull the VAE checkpoint from. Add an entry
# here when adding a new latent-space-map to the spec/examples/ tree.
LATENT_SPACE_TO_REPO: Dict[str, str] = {
    "stabilityai/sd-vae-ft-mse":  "stabilityai/sd-vae-ft-mse",
    "stabilityai/sdxl-vae":       "stabilityai/sdxl-vae",
    # Pipeline-bundled VAEs — we load the parent pipeline below since the
    # VAE doesn't ship as a standalone repo.
    "stabilityai/stable-video-diffusion-img2vid-xt-vae": "stabilityai/stable-video-diffusion-img2vid-xt",
}

# Default VAE scale factor per latent-space, matching the spec example.
# When loading from diffusers AutoencoderKL.config.scaling_factor is
# preferred — this table is only the fallback.
DEFAULT_SCALE_FACTOR: Dict[str, float] = {
    "stabilityai/sd-vae-ft-mse": 0.18215,
    "stabilityai/sdxl-vae":      0.13025,
}


@dataclass
class FixtureManifest:
    """One entry per (latent_space_id, fixture_key) pair under /golden."""

    latent_space_id:    str
    fixture_key:        str
    fixture:            Dict[str, Any]
    input_latent_sha256: str
    reference_sha256:   str        # sha256 of the decoded PNG bytes (image)
                                   # or sha256 of the first frame (video — full
                                   # per-frame list is in `frame_sha256s`)
    frame_sha256s:      Optional[list]
    decoded_at:         str        # ISO 8601 UTC
    decode_ms_total:    float
    container_pins:     str        # contents of /opt/golden/PERCEPTUAL_REFERENCE_PINS
    torch_version:      str
    diffusers_version:  str

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2) + "\n"


def sha256_bytes(b: bytes) -> str:
    return "sha256:" + hashlib.sha256(b).hexdigest()


def read_container_pins() -> str:
    pin_path = Path("/opt/golden/PERCEPTUAL_REFERENCE_PINS")
    if pin_path.exists():
        return pin_path.read_text().strip()
    return ""


def load_vae(latent_space_id: str, device: str) -> AutoencoderKL:
    """Resolve the VAE for a latent_space_id and load it onto the GPU.

    For standalone-VAE repos (sd-vae-ft-mse, sdxl-vae), AutoencoderKL.from_pretrained
    works directly. For pipeline-bundled VAEs (e.g. SVD), we load the full
    pipeline and reach into pipe.vae.
    """
    if latent_space_id not in LATENT_SPACE_TO_REPO:
        raise ValueError(
            f"unknown latent_space_id {latent_space_id!r}; "
            f"add it to LATENT_SPACE_TO_REPO at the top of this script.",
        )
    repo = LATENT_SPACE_TO_REPO[latent_space_id]
    try:
        # Standalone VAE checkpoint.
        vae = AutoencoderKL.from_pretrained(repo, torch_dtype=torch.float16)
    except Exception:
        # Pipeline-bundled — fall back to loading the pipeline + extracting.
        pipe = DiffusionPipeline.from_pretrained(repo, torch_dtype=torch.float16)
        vae = pipe.vae
    vae = vae.to(device)
    vae.eval()
    return vae


def latent_from_pipeline(
    latent_space_id: str,
    fixture: Dict[str, Any],
    device: str,
) -> torch.Tensor:
    """Run a diffusers pipeline at the fixture's seed + steps and return the
    latent tensor BEFORE vae.decode. Used when --generate is passed (the
    default — captures the latent to disk so the bench can reproduce
    against the same bytes downstream)."""
    # Wire this when the engine forks land — the canonical generator is
    # whichever pipeline produces the latent_space's native unit. For
    # sd-vae-ft-mse + StableDiffusion-2.1, that's StableDiffusionPipeline
    # with output_type="latent". For SVD it's StableVideoDiffusionPipeline.
    raise NotImplementedError(
        "Latent generation from a prompt isn't wired yet — pass "
        "--latent-bytes-dir <dir> with pre-captured latent fixtures (the "
        "same ones the corpora/ capture step produces). The generation "
        "path lands once the engine forks expose the latent capture hook.",
    )


def latent_from_bytes(
    fixture: Dict[str, Any],
    bytes_path: Path,
    device: str,
) -> torch.Tensor:
    """Read a raw fp16 LE latent tensor from disk and return as a torch
    tensor on `device` with shape [1, *fixture['latent_shape']]."""
    raw = bytes_path.read_bytes()
    shape = tuple(fixture["latent_shape"])
    arr = np.frombuffer(raw, dtype="<f2").reshape(shape)
    return torch.from_numpy(arr.astype(np.float32)).unsqueeze(0).half().to(device)


def decode_latent(
    vae: AutoencoderKL,
    latent: torch.Tensor,
    scale_factor: float,
) -> np.ndarray:
    """Run vae.decode on a [1, C, H, W] latent and return [H, W, 3] uint8.

    Matches the diffusers convention: latent is divided by the model's
    scale_factor before decode, output is in [-1, 1], rescaled to [0, 255].
    """
    with torch.no_grad():
        out = vae.decode(latent / scale_factor).sample
    out = (out / 2 + 0.5).clamp(0, 1)
    out = out.cpu().permute(0, 2, 3, 1).float().numpy()
    return (out[0] * 255).round().astype(np.uint8)


def write_image_golden(
    out_dir: Path,
    pixels: np.ndarray,
) -> str:
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "reference.png"
    Image.fromarray(pixels).save(out_path)
    return sha256_bytes(out_path.read_bytes())


def write_video_golden(
    out_dir: Path,
    frames: list,
) -> tuple:
    out_dir.mkdir(parents=True, exist_ok=True)
    sha_list: list = []
    for i, frame in enumerate(frames):
        path = out_dir / f"frame_{i:04d}.png"
        Image.fromarray(frame).save(path)
        sha_list.append(sha256_bytes(path.read_bytes()))
    return sha_list[0] if sha_list else "", sha_list


def build_one_fixture(
    *,
    latent_space_id: str,
    fixture_key: str,
    fixture: Dict[str, Any],
    out_root: Path,
    bytes_path: Optional[Path],
    vae: AutoencoderKL,
    scale_factor: float,
    device: str,
) -> FixtureManifest:
    out_dir = out_root / latent_space_id / fixture_key
    fixture_kind = fixture.get("kind", "image")

    if bytes_path is None:
        latent = latent_from_pipeline(latent_space_id, fixture, device)
    else:
        latent = latent_from_bytes(fixture, bytes_path, device)

    input_sha = sha256_bytes(
        (bytes_path.read_bytes() if bytes_path else
         latent.detach().cpu().to(torch.float16).numpy().tobytes(order="C")),
    )

    t0 = time.perf_counter()
    if fixture_kind == "image":
        pixels = decode_latent(vae, latent, scale_factor)
        ref_sha = write_image_golden(out_dir, pixels)
        frame_shas = None
    else:
        # Video: latent is shape [1, C, H, W] per frame; the bytes file
        # holds N concatenated frames. Decode each, concatenate to a
        # frame list, write per-frame PNGs.
        n = fixture["frames"]
        per_frame_size = int(np.prod(fixture["latent_shape"]))
        if bytes_path is None:
            raise NotImplementedError(
                "video latent generation requires --latent-bytes-dir (pre-captured frames)",
            )
        raw = bytes_path.read_bytes()
        # fp16 = 2 bytes per element
        expected = n * per_frame_size * 2
        if len(raw) != expected:
            raise ValueError(
                f"video latent bytes for {fixture_key} have wrong length: "
                f"got {len(raw)}, expected {expected} ({n} frames × "
                f"{per_frame_size} elements × 2 bytes)",
            )
        frames = []
        for i in range(n):
            chunk = raw[i * per_frame_size * 2:(i + 1) * per_frame_size * 2]
            arr = np.frombuffer(chunk, dtype="<f2").reshape(fixture["latent_shape"])
            t = torch.from_numpy(arr.astype(np.float32)).unsqueeze(0).half().to(device)
            frames.append(decode_latent(vae, t, scale_factor))
        ref_sha, frame_shas = write_video_golden(out_dir, frames)
    decode_ms = (time.perf_counter() - t0) * 1000.0

    import diffusers as _diffusers
    manifest = FixtureManifest(
        latent_space_id=latent_space_id,
        fixture_key=fixture_key,
        fixture=fixture,
        input_latent_sha256=input_sha,
        reference_sha256=ref_sha,
        frame_sha256s=frame_shas,
        decoded_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        decode_ms_total=decode_ms,
        container_pins=read_container_pins(),
        torch_version=torch.__version__,
        diffusers_version=_diffusers.__version__,
    )
    (out_dir / "manifest.json").write_text(manifest.to_json(), encoding="utf-8")
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="build_golden.py",
        description=(
            "Build perceptual ground-truth pixels for Codec latent bench fixtures. "
            "Runs inside the codec-golden Docker image."
        ),
    )
    ap.add_argument(
        "--fixtures",
        type=Path,
        required=True,
        help="Path to methodology/latent-fixtures.json (canonical fixture list).",
    )
    ap.add_argument(
        "--latent-space",
        required=True,
        help="latent_space_id to render against (e.g. stabilityai/sd-vae-ft-mse).",
    )
    ap.add_argument(
        "--latent-bytes-dir",
        type=Path,
        default=None,
        help=(
            "Directory of pre-captured latent bytes (one file per fixture key, "
            "matching the corpora/ output of capture-latent-samples.py). "
            "Required for video fixtures and recommended for image fixtures so "
            "the golden is rendered against the SAME bytes the bench measured."
        ),
    )
    ap.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Output root directory. Reference pixels land at <out>/<latent_space>/<fixture>/.",
    )
    ap.add_argument(
        "--only",
        action="append",
        default=None,
        help="Only render the listed fixture keys (repeatable). Default: all.",
    )
    ap.add_argument(
        "--device",
        default="cuda" if torch.cuda.is_available() else "cpu",
        choices=("cuda", "cpu"),
    )
    args = ap.parse_args()

    fixtures_doc = json.loads(args.fixtures.read_text())
    fixtures = fixtures_doc["fixtures"]

    if args.only:
        fixtures = {k: v for k, v in fixtures.items() if k in set(args.only)}
        if not fixtures:
            print("no fixtures matched --only", file=sys.stderr)
            return 2

    print(f"▶ loading VAE for {args.latent_space} on {args.device}...")
    vae = load_vae(args.latent_space, args.device)
    scale_factor = float(getattr(vae.config, "scaling_factor", 0.0)) \
        or DEFAULT_SCALE_FACTOR.get(args.latent_space, 0.18215)
    print(f"  vae_scale_factor = {scale_factor}")

    args.out.mkdir(parents=True, exist_ok=True)

    summary = []
    for key, fix in fixtures.items():
        bytes_path = None
        if args.latent_bytes_dir:
            candidate = args.latent_bytes_dir / f"{key}.bin"
            if candidate.exists():
                bytes_path = candidate
            elif fix.get("kind") == "video":
                print(f"  ✗ {key}: video fixture requires {candidate} — skipping", file=sys.stderr)
                continue
        try:
            man = build_one_fixture(
                latent_space_id=args.latent_space,
                fixture_key=key,
                fixture=fix,
                out_root=args.out,
                bytes_path=bytes_path,
                vae=vae,
                scale_factor=scale_factor,
                device=args.device,
            )
            summary.append((key, man.reference_sha256, man.decode_ms_total))
            print(f"  ✓ {key:12} {man.reference_sha256[:23]}…  decode={man.decode_ms_total:6.1f} ms")
        except NotImplementedError as e:
            print(f"  ✗ {key}: {e}", file=sys.stderr)
        except Exception as e:
            print(f"  ✗ {key}: {type(e).__name__}: {e}", file=sys.stderr)

    print()
    print(f"▶ wrote {len(summary)} reference manifests under {args.out}/{args.latent_space}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
