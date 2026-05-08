#!/usr/bin/env python3
"""Cross-vocab handoff benchmark — Llama-3 → Qwen-2.

Measures the agent-to-agent handoff cell of the Codec story: agent A
emits a token stream in vocab V_A, agent B consumes a stream in vocab
V_B, and a Codec-aware bridge translates IDs end-to-end without UTF-8
ever leaving the process.

Two paths are timed against the SAME prompt + the SAME source ID
sequence:

    Codec wire path
        A produces V_A IDs → encode as Codec msgpack frames →
        wire bytes → bridge: decode + Translator(V_A→V_B) →
        V_B IDs handed to B as `prompt: int[]`

    JSON-SSE wire path
        A produces V_A IDs → A.detokenize(V_A) → JSON-SSE chunks →
        wire bytes → bridge: parse SSE + concat text →
        BPETokenizer(V_B).encode(text) → V_B IDs handed to B

The two paths produce identical V_B IDs by construction (we assert
this as a correctness check). The bench reports:

    - wire bytes   per path  (lower is better)
    - bridge CPU   per path  (lower is better; this is the work the
                              receiving end does to turn wire bytes
                              into V_B prompt IDs)
    - agreement    True / False   (must be True; otherwise the
                                   marketing claim is unsound)

The output JSON is SCHEMA-v1-shaped (rows[].size, format, encoding,
…) so it slots into the same aggregator as the cross-stack matrix.

Hardware-agnostic: this is a CPU microbench, not a GPU run, so it
can land on any laptop. Run on the lab box for parity with the
cross-stack matrix; numbers are stable to ~1 ms either way.

Usage:
    python packages/bench/scripts/translator_bench.py \
        --sizes 64 512 2048 --reps 5 \
        --out packages/bench/results/<run_id>/translator/python.json
"""
from __future__ import annotations

import argparse
import asyncio
import gzip
import io
import json
import statistics
import sys
import time
from pathlib import Path

import msgpack  # type: ignore[import]

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "packages" / "python" / "src"))

from codecai import (  # noqa: E402  (after sys.path tweak)
    BPETokenizer,
    Detokenizer,
    Translator,
    load_map,
)

# Two well-known divergent vocabularies. Llama-3 has 128 K tokens and
# its own merge rules; Qwen-2 has 151 K tokens trained largely on
# Chinese + multilingual corpora. Re-tokenizing across these two is
# the canonical "cross-vocab" stress test.
LLAMA_MAP_URL = "https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/meta-llama/llama-3.json"
LLAMA_MAP_HASH = "sha256:79b707aea8c2b41c2883ec7913b0c4a0c880044ac844d89a9a03e779eb92db04"
QWEN_MAP_URL = "https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json"
QWEN_MAP_HASH = "sha256:887311099cdc09e7022001a01fa1da396750d669b7ed2c242a000b9badd09791"

# A multi-paragraph English passage, deterministic across runs. Encoded
# through Llama-3 BPE, this gives ~580 tokens; we tile it to reach
# whatever target size the bench requested.
SAMPLE_TEXT = (
    "Entropy is the measure of how many microscopic configurations "
    "correspond to a given macroscopic state. The second law of "
    "thermodynamics says that for an isolated system the total "
    "entropy never decreases over time. In information theory, "
    "Shannon entropy quantifies the average number of bits needed "
    "to represent a symbol drawn from a known probability "
    "distribution. The two definitions, despite arising from "
    "different fields, share the same mathematical form: a sum over "
    "states of probability times the logarithm of probability, "
    "negated so the result is non-negative. This is not a "
    "coincidence — both quantify the same underlying notion of "
    "uncertainty.\n\n"
    "Codec is a token-native binary transport for AI APIs. It "
    "replaces JSON wrapping with a compact frame carrying raw "
    "uint32 token IDs. Because models speak token IDs natively, "
    "shipping IDs directly avoids the detokenize → UTF-8 → re-"
    "tokenize round trip that JSON-SSE forces on every chunk. The "
    "wire saves bytes; the model saves work; the agent boundary "
    "stops being a translation choke point.\n\n"
    "Cross-vocab handoff is the most interesting case. Agent A "
    "speaks vocabulary V_A; agent B speaks V_B. With JSON the "
    "bridge has to detokenize A's output to text, then re-tokenize "
    "into V_B for B. With Codec the bridge can do the same work "
    "in-process — A's IDs come over the wire as packed integers, "
    "the Translator pipes them through a tokenizer-of-V_B, and B "
    "receives V_B IDs without text ever crossing the wire."
)


def _build_target_ids(detok: Detokenizer, llama_tok: BPETokenizer, target: int) -> list[int]:
    """Encode SAMPLE_TEXT through Llama-3 BPE, tile/truncate to `target` IDs."""
    seed_ids = llama_tok.encode(SAMPLE_TEXT)
    if not seed_ids:
        raise RuntimeError("Llama-3 tokenizer produced empty output for sample text")
    out: list[int] = []
    while len(out) < target:
        out.extend(seed_ids)
    return out[:target]


def _encode_codec_msgpack_frame(ids: list[int]) -> bytes:
    """Build one Codec msgpack frame matching the wire format used by sglang/vllm/llamacpp.

    Single-frame here (no chunking) — we're measuring bridge-side CPU,
    not stream chunking; chunk overhead is subsumed in the cross-stack
    matrix already.
    """
    body = msgpack.packb({"ids": ids, "done": True}, use_bin_type=True)
    length = len(body).to_bytes(4, "big")
    return length + body


def _encode_json_sse(text: str, chunk_chars: int = 4) -> bytes:
    """Build a JSON-SSE byte-string for the given output text.

    Mimics the OpenAI streaming envelope: one `data:` line per chunk,
    each chunk wrapping a JSON object with the next slice of text in
    `choices[0].delta.content`. Emits `data: [DONE]` at the tail.
    """
    buf = io.BytesIO()
    for i in range(0, len(text), chunk_chars):
        chunk = text[i : i + chunk_chars]
        envelope = {
            "id": "chatcmpl-bench",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "agent-A",
            "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}],
        }
        buf.write(b"data: ")
        buf.write(json.dumps(envelope, ensure_ascii=False).encode("utf-8"))
        buf.write(b"\n\n")
    buf.write(b"data: [DONE]\n\n")
    return buf.getvalue()


def _parse_json_sse_to_text(wire: bytes) -> str:
    """Reassemble the JSON-SSE chunks back into text — what the bridge does."""
    out: list[str] = []
    for line in wire.splitlines():
        if not line.startswith(b"data: "):
            continue
        payload = line[len(b"data: ") :]
        if payload == b"[DONE]":
            break
        obj = json.loads(payload.decode("utf-8"))
        delta = obj["choices"][0]["delta"].get("content", "")
        if delta:
            out.append(delta)
    return "".join(out)


async def main() -> None:
    ap = argparse.ArgumentParser(prog="translator_bench")
    ap.add_argument("--sizes", type=int, nargs="+", default=[64, 512, 2048])
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument(
        "--no-gzip",
        action="store_true",
        help="Skip the +gzip cells (run identity-only)",
    )
    args = ap.parse_args()

    print(f"loading Llama-3 map …", flush=True)
    llama_map = await load_map(url=LLAMA_MAP_URL, hash=LLAMA_MAP_HASH)
    print(f"loading Qwen-2 map …", flush=True)
    qwen_map = await load_map(url=QWEN_MAP_URL, hash=QWEN_MAP_HASH)

    llama_detok = Detokenizer(llama_map)
    llama_tok = BPETokenizer(llama_map)
    qwen_tok = BPETokenizer(qwen_map)
    translator = Translator(llama_map, qwen_map)

    rows: list[dict] = []
    for size in args.sizes:
        print(f"\n>>> size={size}", flush=True)
        ids_a = _build_target_ids(llama_detok, llama_tok, size)
        text_full = llama_detok.render(ids_a)

        # Pre-build wire bytes once (deterministic); time only the
        # bridge-side work in the timed loop. That isolates the cost
        # we actually pay at the agent boundary.
        codec_frame = _encode_codec_msgpack_frame(ids_a)
        json_sse = _encode_json_sse(text_full)

        encodings = ["identity"] if args.no_gzip else ["identity", "gzip"]

        # === Codec path: wire bytes + bridge CPU ===
        for enc in encodings:
            wire = (
                codec_frame
                if enc == "identity"
                else gzip.compress(codec_frame, compresslevel=6)
            )

            # Run the receiver work `reps` times. Reset the translator
            # each rep so we measure cold-state-per-call (the realistic
            # per-handoff cost).
            cpu_ns: list[int] = []
            qwen_ids_codec: list[int] = []
            for _ in range(args.reps):
                t = Translator(llama_map, qwen_map)
                t0 = time.perf_counter_ns()
                # Decode the frame back to IDs (same work the bridge
                # does after reading from the socket).
                if enc == "gzip":
                    payload = gzip.decompress(wire)
                else:
                    payload = wire
                length = int.from_bytes(payload[:4], "big")
                body = payload[4 : 4 + length]
                frame = msgpack.unpackb(body, raw=False)
                qwen_ids_codec = t.translate(frame["ids"], partial=False)
                t1 = time.perf_counter_ns()
                cpu_ns.append(t1 - t0)
            cpu_ms = statistics.median(cpu_ns) / 1e6

            rows.append(
                {
                    "size": size,
                    "format": "codec_msgpack",
                    "encoding": enc,
                    "wire_bytes": len(wire),
                    "bridge_cpu_ms": round(cpu_ms, 3),
                    "out_token_count": len(qwen_ids_codec),
                    "rep_cpu_ns": cpu_ns,
                }
            )
            print(
                f"    Codec msgpack          {enc:8s} size={size:5d}  "
                f"wire={len(wire):7d}  bridgeCPU={cpu_ms:7.3f} ms  outIDs={len(qwen_ids_codec)}",
                flush=True,
            )

        # === JSON-SSE path: wire bytes + bridge CPU ===
        for enc in encodings:
            wire = json_sse if enc == "identity" else gzip.compress(json_sse, compresslevel=6)

            cpu_ns = []
            qwen_ids_json: list[int] = []
            for _ in range(args.reps):
                tok = BPETokenizer(qwen_map)
                t0 = time.perf_counter_ns()
                if enc == "gzip":
                    payload = gzip.decompress(wire)
                else:
                    payload = wire
                text = _parse_json_sse_to_text(payload)
                qwen_ids_json = tok.encode(text)
                t1 = time.perf_counter_ns()
                cpu_ns.append(t1 - t0)
            cpu_ms = statistics.median(cpu_ns) / 1e6

            rows.append(
                {
                    "size": size,
                    "format": "json_sse",
                    "encoding": enc,
                    "wire_bytes": len(wire),
                    "bridge_cpu_ms": round(cpu_ms, 3),
                    "out_token_count": len(qwen_ids_json),
                    "rep_cpu_ns": cpu_ns,
                }
            )
            print(
                f"    JSON-SSE               {enc:8s} size={size:5d}  "
                f"wire={len(wire):7d}  bridgeCPU={cpu_ms:7.3f} ms  outIDs={len(qwen_ids_json)}",
                flush=True,
            )

        # === Correctness: both paths must produce the SAME Qwen IDs.
        # Strict equality is the only acceptable outcome — a single
        # divergent token here would invalidate the marketing claim.
        if qwen_ids_codec != qwen_ids_json:
            # Find first divergence for the postmortem
            min_len = min(len(qwen_ids_codec), len(qwen_ids_json))
            first_diff = next(
                (
                    i
                    for i in range(min_len)
                    if qwen_ids_codec[i] != qwen_ids_json[i]
                ),
                min_len,
            )
            raise SystemExit(
                f"FATAL: Codec path and JSON-SSE path produced different "
                f"Qwen IDs at size={size}. "
                f"len(codec)={len(qwen_ids_codec)}, len(json)={len(qwen_ids_json)}, "
                f"first divergence at index {first_diff}."
            )

    # === SCHEMA-v1-style output JSON ===
    out = {
        "schema_version": "1",
        "bench": "translator-cross-vocab",
        "from_map_id": llama_map.id,
        "to_map_id": qwen_map.id,
        "from_map_hash": LLAMA_MAP_HASH,
        "to_map_hash": QWEN_MAP_HASH,
        "reps_per_cell": args.reps,
        "rows": rows,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\nwrote {args.out} ({len(rows)} rows)")


if __name__ == "__main__":
    asyncio.run(main())
