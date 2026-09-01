#!/usr/bin/env python3
"""
capture-latent-samples.py: capture raw Codec latent streams from a running
latent-aware Codec server (Dockerfile.diffusers or Dockerfile.comfyui in
codec-supervisor). Sibling of capture-codec-samples.py for the latent
modality (Codec v0.3+).

Two purposes, one collection step:

  1. Bench corpus: deterministic per-fixture capture (one .bin per
     (latent_space, format, pipeline, fixture-key) tuple). The bytes
     match the wire bench cells will measure against. The same
     latent tensor inside (after pipeline inversion) also feeds
     golden-builder. The perceptual reference is therefore rendered
     against bit-exact inputs.
  2. Dict-training corpus: repeated capture across many seed +
     prompt variants for a given (format, pipeline) pair. This gives
     train-zstd-dict-latents.py enough byte-distribution diversity
     to produce a useful dict. Pass --mode=train and --n-samples=N to
     opt in.

Output layout (mirrors capture-codec-samples.py with a (latent-space,
pipeline) extra layer):

    corpora/<latent-space>-synth/<format>/<pipeline>/<fixture-key>.bin
    corpora/<latent-space>-synth/<format>/<pipeline>/manifest.jsonl

Wire request shape (per spec/PROTOCOL.md §"Endpoints"):

    POST /v1/images/generations
    Content-Type: application/json
    Accept-Encoding: identity                 # raw frames, no compression layer
    Accept: application/x-msgpack             # or application/x-protobuf

    {
      "model":         "<engine model id>",
      "prompt":        "<fixture prompt>",
      "stream_format": "msgpack",             # or "protobuf"
      "modality":      "image-latents",       # or "video-latents"
      "latent_space":  "stabilityai/sd-vae-ft-mse",
      "pipeline":      "int8",                # one of seven names from spec/PIPELINES.md
      "size":          "512x512",             # or "1024x1024" etc.; from latent-fixtures.json
      "steps":         25,
      "seed":          42
    }

Response: a single LatentStreamHeader followed by N LatentFrames in
msgpack or protobuf (the LATENT_HEADER + LATENTS frame types in the
session protocol). The script saves the entire response body (header +
frames) verbatim: the dict trainer treats the whole captured stream
as one corpus entry.

Status: engine fork dependency
-------------------------------
The `wdunn001/ComfyUI` and `wdunn001/diffusers` forks at branch
`feat/codec-latent-transport` are required for this script to fetch
real bytes. Without them the script runs but every fixture errors out
on connection / 404. The script ships now so capture is wired up the
moment the forks land: no follow-up CLI work blocks the bench.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import httpx


# Pipeline → modality compatibility check. The 7-pipeline registry from
# spec/PIPELINES.md splits into image-latents-only and video-latents-only
# subsets. Capturing a video-only pipeline (delta+*) against an image
# fixture is a configuration error.
IMAGE_PIPELINES = ("raw", "int8", "int4")
VIDEO_PIPELINES = ("raw", "int8-adaptive", "int4-adaptive", "delta+int8", "delta+int4")


def _compatible(fixture_kind: str, pipeline: str) -> bool:
    if fixture_kind == "image":
        return pipeline in IMAGE_PIPELINES
    if fixture_kind == "video":
        return pipeline in VIDEO_PIPELINES
    return False


def _endpoint(fixture_kind: str) -> str:
    return "/v1/images/generations" if fixture_kind == "image" else "/v1/videos/generations"


def _modality(fixture_kind: str) -> str:
    return "image-latents" if fixture_kind == "image" else "video-latents"


async def fetch_latent_stream(
    client: httpx.AsyncClient,
    base_url: str,
    *,
    model: str,
    fixture_key: str,
    fixture: Dict[str, Any],
    latent_space: str,
    fmt: str,
    pipeline: str,
) -> tuple[bytes, float, Dict[str, str]]:
    kind = fixture["kind"]
    body: Dict[str, Any] = {
        "model":         model,
        "prompt":        fixture["prompt"],
        "stream_format": fmt,
        "modality":      _modality(kind),
        "latent_space":  latent_space,
        "pipeline":      pipeline,
        "seed":          fixture["seed"],
        "steps":         fixture.get("steps", 25),
    }
    if kind == "image":
        body["size"] = f"{fixture['resolution']}x{fixture['resolution']}"
    else:
        body["fps"] = fixture["fps"]
        body["frames"] = fixture["frames"]
        body["resolution"] = fixture["resolution"]

    headers = {
        "Accept-Encoding": "identity",        # raw msgpack/protobuf bytes
        "Accept": (
            "application/x-msgpack" if fmt == "msgpack"
            else "application/x-protobuf"
        ),
    }
    t0 = time.perf_counter()
    buf = bytearray()
    async with client.stream(
        "POST", base_url + _endpoint(kind),
        json=body, headers=headers, timeout=600.0,
    ) as resp:
        resp.raise_for_status()
        ce = resp.headers.get("content-encoding", "identity")
        if ce != "identity":
            raise RuntimeError(
                f"server returned content-encoding={ce!r} despite Accept-Encoding: identity. "
                "the corpus would be polluted with already-compressed bytes: aborting."
            )
        # Capture the Codec-Latent-Map and Codec-Zstd-Dict headers so the
        # corpus manifest can record what map + dict the server was
        # operating against.
        captured_headers = {
            "codec-latent-map":   resp.headers.get("codec-latent-map", ""),
            "codec-zstd-dict":    resp.headers.get("codec-zstd-dict", ""),
            "content-type":       resp.headers.get("content-type", ""),
        }
        async for chunk in resp.aiter_raw():
            buf.extend(chunk)
    elapsed = (time.perf_counter() - t0) * 1000
    return bytes(buf), elapsed, captured_headers


async def main_async(args: argparse.Namespace) -> int:
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    fixtures_doc = json.loads(Path(args.fixtures).read_text())
    all_fixtures: Dict[str, Any] = fixtures_doc["fixtures"]
    if args.only:
        all_fixtures = {k: v for k, v in all_fixtures.items() if k in set(args.only)}
        if not all_fixtures:
            print("no fixtures matched --only", file=sys.stderr)
            return 2

    print(
        f"▶ capturing latent fixtures × {len(args.formats)} formats × "
        f"{len(args.pipelines)} pipelines from {args.url}",
        file=sys.stderr,
    )
    print(f"  latent_space:   {args.latent_space}", file=sys.stderr)
    print(f"  fixtures:       {list(all_fixtures.keys())}", file=sys.stderr)
    print(f"  formats:        {args.formats}", file=sys.stderr)
    print(f"  pipelines:      {args.pipelines}", file=sys.stderr)
    print(f"  out:            {out_root}", file=sys.stderr)

    timeout = httpx.Timeout(connect=10.0, read=600.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for fmt in args.formats:
            for pipeline in args.pipelines:
                pipe_dir = out_root / fmt / pipeline
                pipe_dir.mkdir(parents=True, exist_ok=True)
                manifest_path = pipe_dir / "manifest.jsonl"
                existing_keys: set = set()
                if manifest_path.exists() and not args.overwrite:
                    for line in manifest_path.open(encoding="utf-8"):
                        try:
                            existing_keys.add(json.loads(line)["fixture_key"])
                        except Exception:
                            pass

                with manifest_path.open(
                    "a" if existing_keys else "w", encoding="utf-8"
                ) as mf:
                    for key, fixture in all_fixtures.items():
                        if not _compatible(fixture["kind"], pipeline):
                            print(
                                f"    {fmt}/{pipeline}/{key}: incompatible "
                                f"(kind={fixture['kind']}); skipping",
                                file=sys.stderr,
                            )
                            continue
                        if key in existing_keys:
                            continue
                        try:
                            wire, elapsed, hdrs = await fetch_latent_stream(
                                client, args.url,
                                model=args.model,
                                fixture_key=key,
                                fixture=fixture,
                                latent_space=args.latent_space,
                                fmt=fmt,
                                pipeline=pipeline,
                            )
                        except Exception as e:
                            print(
                                f"    {fmt}/{pipeline}/{key}: ERROR "
                                f"{type(e).__name__}: {e}",
                                file=sys.stderr,
                            )
                            continue

                        sha8 = hashlib.sha256(wire).hexdigest()[:8]
                        fname = f"{key}.bin"
                        (pipe_dir / fname).write_bytes(wire)

                        rec = {
                            "fixture_key":    key,
                            "fixture":        fixture,
                            "latent_space":   args.latent_space,
                            "format":         fmt,
                            "pipeline":       pipeline,
                            "wire_bytes":     len(wire),
                            "file":           fname,
                            "sha8":           sha8,
                            "sha256":         "sha256:" + hashlib.sha256(wire).hexdigest(),
                            "elapsed_ms":     round(elapsed, 1),
                            "headers":        hdrs,
                            "model":          args.model,
                        }
                        mf.write(json.dumps(rec) + "\n")
                        mf.flush()
                        print(
                            f"    {fmt}/{pipeline}/{key}: "
                            f"{len(wire)}B in {elapsed:.0f}ms",
                            file=sys.stderr,
                        )

    print(f"\n✓ done. corpus at {out_root}", file=sys.stderr)
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(prog="capture-latent-samples")
    ap.add_argument(
        "--url", default="http://127.0.0.1:8090",
        help="latent-aware Codec server URL: typically the codec-comfyui or "
             "codec-diffusers container in codec-supervisor compose. "
             "(default: %(default)s)",
    )
    ap.add_argument(
        "--fixtures", default="methodology/latent-fixtures.json",
        help="path to latent-fixtures.json (default: %(default)s)",
    )
    ap.add_argument(
        "--latent-space", required=True,
        help="latent_space_id to capture against (e.g. stabilityai/sd-vae-ft-mse)",
    )
    ap.add_argument(
        "--model", required=True,
        help="engine model id the server should load behind the latent_space "
             "(e.g. stabilityai/stable-diffusion-2-1-base)",
    )
    ap.add_argument(
        "--formats", nargs="+", default=["msgpack", "protobuf"],
        choices=["msgpack", "protobuf"],
        help="codec wire formats to capture (default: both)",
    )
    ap.add_argument(
        "--pipelines", nargs="+",
        default=["raw", "int8", "int4"],
        choices=["raw", "int8", "int4", "int8-adaptive", "int4-adaptive",
                 "delta+int8", "delta+int4"],
        help=(
            "pipelines to capture. Image fixtures: raw / int8 / int4 only. "
            "Video fixtures: raw / int8-adaptive / int4-adaptive / delta+int8 "
            "/ delta+int4. The script auto-skips incompatible (fixture, "
            "pipeline) pairs. Passing the full set is safe."
        ),
    )
    ap.add_argument(
        "--only", action="append", default=None,
        help="Only capture the listed fixture keys (repeatable). Default: all.",
    )
    ap.add_argument(
        "--out", default="./corpora/sd-vae-ft-mse-synth",
        help="output directory (default: %(default)s)",
    )
    ap.add_argument(
        "--overwrite", action="store_true",
        help="overwrite the existing manifest (the default resumes)",
    )
    args = ap.parse_args()
    sys.exit(asyncio.run(main_async(args)))


if __name__ == "__main__":
    main()
