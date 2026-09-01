#!/usr/bin/env python3
"""
capture-codec-samples.py: capture raw Codec response streams from a running
sglang (or any Codec-aware server) for use as zstd-dictionary training data.

We deliberately request `Accept-Encoding: identity` so the saved bytes are
the unencoded msgpack / protobuf wire frames. The dictionary will be trained
on those raw bytes; a compressor with the dict loaded will then compress
fresh streams much better than no-dict zstd.

Each (prompt, format) pair becomes one .bin file plus one line in
manifest.jsonl. Run separately per (model, format) to keep the corpus tidy:

    python capture-codec-samples.py \\
        --url http://192.168.1.88:30000 \\
        --model Qwen/Qwen2.5-0.5B-Instruct \\
        --formats msgpack protobuf \\
        --n-samples 256 \\
        --out ./corpora/qwen2.5

Re-uses the streaming POST plumbing from `codec_demo.run_one` indirectly:
this script writes its own slim httpx loop because we need pre-decompression
bytes (the demo decompresses for token counting; we want the raw frames).
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import os
import random
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import httpx


# Curated prompt set: varied lengths and shapes so the trained dictionary
# captures the *distribution* of real traffic. Add liberally. Keep prompts
# short. The model output is the corpus that matters here.
PROMPTS_SHORT = [
    "Explain entropy in one sentence:",
    "What is 12 * 17?",
    "Capital of France?",
    "Define recursion.",
    "Translate 'hello' to French.",
    "What year did World War II end?",
    "List three primary colors.",
    "Who wrote Hamlet?",
    "What is the speed of light?",
    "Define machine learning.",
]

PROMPTS_MEDIUM = [
    "Write a Python function that returns the nth Fibonacci number.",
    "Describe how a transformer attention head works.",
    "Compare REST and gRPC in three bullet points.",
    "Outline the steps to deploy a Docker container to AWS ECS.",
    "Explain the CAP theorem with a concrete example.",
    "Write a SQL query to find the top 5 customers by revenue.",
    "Describe the Linux boot process from BIOS to login prompt.",
    "Summarize the plot of Crime and Punishment in one paragraph.",
    "Write a regular expression that matches valid IPv4 addresses.",
    "Explain how TLS 1.3 differs from TLS 1.2.",
]

PROMPTS_LONG = [
    "Write a long, detailed essay covering: 1) the history of artificial intelligence "
    "from 1950 to today, 2) every major architecture (perceptrons, RNNs, LSTMs, "
    "transformers, mixture-of-experts), 3) the math behind backprop and attention, "
    "4) the alignment problem, 5) hardware evolution from CPUs to TPUs to ASICs, "
    "6) the economics of training large models. Be thorough and use complete sentences.",
    "Write a comprehensive guide to building a distributed key-value store. Cover "
    "consistent hashing, replication, leader election with Raft, gossip-based "
    "failure detection, snapshotting, and operational concerns like rolling "
    "upgrades and capacity planning. Include code skeletons in Go.",
    "Explain in depth how the Linux scheduler works, from CFS to EEVDF, with "
    "examples of how nice levels, cgroups, and real-time priorities interact. "
    "Discuss the trade-offs between latency and throughput, and how kernel "
    "developers measure scheduler performance.",
    "Walk through the entire lifecycle of an HTTP request from a browser to a "
    "modern web server, covering DNS resolution, TCP handshake, TLS negotiation, "
    "HTTP/2 framing, server-side request routing, database query, response "
    "encoding, and finally rendering in the browser. Be specific about each "
    "layer's data structures.",
]

ALL_PROMPTS = PROMPTS_SHORT + PROMPTS_MEDIUM + PROMPTS_LONG


@dataclass
class CaptureResult:
    prompt: str
    format: str
    max_tokens: int
    wire_bytes: int
    n_tokens: int
    file: str
    sha8: str
    elapsed_ms: float


def count_msgpack(buf: bytes) -> int:
    import msgpack
    n = 0
    for frame in msgpack.Unpacker(io.BytesIO(buf), raw=False):
        n += len(frame.get("ids", []))
    return n


def count_protobuf(buf: bytes) -> int:
    """4-byte BE length prefix + protobuf body. Field 1 = packed uint32 ids."""
    n = 0
    pos = 0
    L = len(buf)
    while pos + 4 <= L:
        (length,) = struct.unpack(">I", buf[pos:pos + 4])
        pos += 4
        if pos + length > L:
            break
        body = buf[pos:pos + length]
        bp = 0
        while bp < len(body):
            tag = 0; shift = 0
            while True:
                b = body[bp]; bp += 1
                tag |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
            field = tag >> 3
            wt = tag & 0x07
            if field == 1 and wt == 2:
                ln = 0; shift = 0
                while True:
                    b = body[bp]; bp += 1
                    ln |= (b & 0x7F) << shift
                    if not (b & 0x80):
                        break
                    shift += 7
                end = bp + ln
                while bp < end:
                    while True:
                        b = body[bp]; bp += 1
                        if not (b & 0x80):
                            break
                    n += 1
            elif wt == 0:
                while True:
                    b = body[bp]; bp += 1
                    if not (b & 0x80):
                        break
            elif wt == 2:
                ln = 0; shift = 0
                while True:
                    b = body[bp]; bp += 1
                    ln |= (b & 0x7F) << shift
                    if not (b & 0x80):
                        break
                    shift += 7
                bp += ln
            elif wt == 5:
                bp += 4
            elif wt == 1:
                bp += 8
            else:
                break
        pos += length
    return n


COUNTERS = {"msgpack": count_msgpack, "protobuf": count_protobuf}


async def fetch_stream(
    client: httpx.AsyncClient,
    url: str,
    model: str,
    prompt: str,
    fmt: str,
    max_tokens: int,
    temperature: float,
) -> tuple[bytes, float]:
    body = {
        "model": model,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "stream": True,
        "temperature": temperature,
        "stream_format": fmt,
    }
    headers = {"Accept-Encoding": "identity"}  # raw frames: no compression layer
    t0 = time.perf_counter()
    buf = bytearray()
    async with client.stream(
        "POST", url + "/v1/completions",
        json=body, headers=headers, timeout=120.0,
    ) as resp:
        resp.raise_for_status()
        ce = resp.headers.get("content-encoding", "identity")
        if ce != "identity":
            raise RuntimeError(
                f"server returned content-encoding={ce!r} despite Accept-Encoding: identity. "
                "the corpus would be polluted with already-compressed bytes: aborting."
            )
        async for chunk in resp.aiter_raw():
            buf.extend(chunk)
    elapsed = (time.perf_counter() - t0) * 1000
    return bytes(buf), elapsed


def pick_size(rng: random.Random) -> int:
    """Bias toward medium sizes (where compression wins are most measurable),
    with a long tail of large samples and a short tail of tiny ones."""
    r = rng.random()
    if r < 0.20:
        return rng.choice([16, 32, 48, 64])
    if r < 0.65:
        return rng.choice([128, 192, 256, 384, 512])
    if r < 0.90:
        return rng.choice([768, 1024, 1536])
    return rng.choice([2048, 3072])


async def main_async(args: argparse.Namespace) -> int:
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    rng = random.Random(args.seed)

    formats = list(args.formats)
    print(f"▶ capturing {args.n_samples} samples × {len(formats)} formats from {args.url}",
          file=sys.stderr)
    print(f"  model:   {args.model}", file=sys.stderr)
    print(f"  out:     {out_root}", file=sys.stderr)
    print(f"  formats: {formats}", file=sys.stderr)

    timeout = httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for fmt in formats:
            fmt_dir = out_root / fmt
            fmt_dir.mkdir(parents=True, exist_ok=True)
            manifest_path = fmt_dir / "manifest.jsonl"
            existing = 0
            if manifest_path.exists() and not args.overwrite:
                existing = sum(1 for _ in manifest_path.open(encoding="utf-8"))
                print(f"    {fmt}: resuming after {existing} existing samples",
                      file=sys.stderr)
            n_remaining = max(0, args.n_samples - existing)

            with manifest_path.open("a" if existing else "w", encoding="utf-8") as mf:
                for i in range(n_remaining):
                    prompt = rng.choice(ALL_PROMPTS)
                    max_tokens = pick_size(rng)
                    # Slight temperature jitter so identical (prompt,size) pairs
                    # don't collapse to the same bytes: the trained dict
                    # benefits from diversity.
                    temp = rng.uniform(0.0, 0.4)
                    try:
                        wire, elapsed = await fetch_stream(
                            client, args.url, args.model, prompt, fmt, max_tokens, temp,
                        )
                    except Exception as e:
                        print(f"    {fmt}[{existing + i}]: ERROR {type(e).__name__}: {e}",
                              file=sys.stderr)
                        continue

                    n_tokens = COUNTERS[fmt](wire)
                    sha8 = hashlib.sha256(wire).hexdigest()[:8]
                    fname = f"{sha8}-{n_tokens}tok.bin"
                    (fmt_dir / fname).write_bytes(wire)

                    rec = {
                        "prompt": prompt,
                        "format": fmt,
                        "max_tokens": max_tokens,
                        "temperature": temp,
                        "wire_bytes": len(wire),
                        "n_tokens": n_tokens,
                        "file": fname,
                        "sha8": sha8,
                        "elapsed_ms": round(elapsed, 1),
                        "model": args.model,
                    }
                    mf.write(json.dumps(rec) + "\n")
                    mf.flush()
                    if (i + 1) % 16 == 0 or i + 1 == n_remaining:
                        print(f"    {fmt}: {existing + i + 1}/{args.n_samples}  "
                              f"last={len(wire)}B/{n_tokens}tok in {elapsed:.0f}ms",
                              file=sys.stderr)

    print(f"\n✓ done. corpus at {out_root}", file=sys.stderr)
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(prog="capture-codec-samples")
    ap.add_argument("--url", default="http://192.168.1.88:30000",
                    help="sglang server URL (default: %(default)s)")
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct",
                    help="model id (default: %(default)s)")
    ap.add_argument("--formats", nargs="+", default=["msgpack", "protobuf"],
                    choices=["msgpack", "protobuf"],
                    help="codec formats to capture (default: both)")
    ap.add_argument("--n-samples", type=int, default=256,
                    help="samples per format (default: %(default)s)")
    ap.add_argument("--out", default="./corpora/qwen2.5",
                    help="output directory (default: %(default)s)")
    ap.add_argument("--seed", type=int, default=0xC0DEC,
                    help="prompt-shuffle RNG seed (default: 0xC0DEC)")
    ap.add_argument("--overwrite", action="store_true",
                    help="overwrite the existing manifest")
    args = ap.parse_args()
    sys.exit(asyncio.run(main_async(args)))


if __name__ == "__main__":
    main()
