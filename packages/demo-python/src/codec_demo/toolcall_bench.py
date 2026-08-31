"""
Tool-call bench: hit a Codec-enabled sglang with a Qwen2.5-Instruct
prompt that requires a tool call, then compare three paths:

  A) JSON-SSE (today's baseline): orchestrator must detokenize every
     frame and substring-match for `<tool_call>...</tool_call>` text.
     We measure the wire bytes and ALSO the cost of the substring
     scan client-side.

  B) Codec msgpack, NO tool_watcher: wire is binary, but the client
     still has to detokenize each frame's IDs to text and scan for
     markers. Same logic as JSON-SSE, just over a smaller wire.

  C) Codec msgpack + tool_watcher: server detects the region and
     surfaces parsed tool_calls on the wire frame. Client just reads
     `frame.tool_calls`. Zero detokenize.

For each path we report wire bytes, time-to-first-byte, total time,
client CPU spent on tool detection, and "tool calls observed".

Usage:
    py -3.13 -c "from codec_demo.toolcall_bench import main; main()" \\
        --url http://192.168.1.88:30000 \\
        --start-id 151657 --end-id 151658
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import re
import sys
import time
from dataclasses import dataclass, field
from typing import List, Optional

import httpx
import msgpack


# Qwen2.5-Instruct chat template asks for tool calls inside literal
# `<tool_call>...</tool_call>` delimiters. The corresponding token IDs
# are 151657 / 151658 in the qwen2 vocab. The model emits these as
# single tokens, so server-side detection is a uint32 compare.
DEFAULT_PROMPT = (
    "<|im_start|>system\n"
    "You are a helpful assistant. You may call functions when relevant.\n"
    "# Tools\n"
    "<tools>\n"
    '[{"type":"function","function":{"name":"get_weather","description":'
    '"Get current weather for a city.","parameters":'
    '{"type":"object","properties":{"city":{"type":"string"}},'
    '"required":["city"]}}}]\n'
    "</tools>\n"
    "For each function call return a json object with `name` and `arguments` "
    "inside <tool_call></tool_call> XML tags.<|im_end|>\n"
    "<|im_start|>user\nWhat's the weather in Tokyo?<|im_end|>\n"
    "<|im_start|>assistant\n"
)

TOOL_CALL_REGEX = re.compile(
    r"<tool_call>(.*?)</tool_call>", re.DOTALL
)

# A test prompt that asks for a function call. Used as the user message
# in /v1/chat/completions so sglang applies the model's chat template
# (which inserts the special begin/end markers as single tokens that
# the watcher can match against by ID).
DEFAULT_USER_PROMPT = "What's the weather in Tokyo?"

DEFAULT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }
]


def _chat_body(model: str, user_prompt: str, max_tokens: int,
               *, stream_format: Optional[str] = None,
               tool_watcher: Optional[dict] = None) -> dict:
    body = {
        "model": model,
        "messages": [
            {"role": "user", "content": user_prompt},
        ],
        "tools": DEFAULT_TOOLS,
        "tool_choice": "auto",
        "max_tokens": max_tokens,
        "stream": True,
        "temperature": 0.0,
    }
    if stream_format is not None:
        body["stream_format"] = stream_format
    if tool_watcher is not None:
        body["tool_watcher"] = tool_watcher
    return body


@dataclass
class Result:
    label: str
    wire_bytes: int = 0
    decoded_bytes: int = 0
    tokens: int = 0
    ttfb_ms: float = 0.0
    total_ms: float = 0.0
    detect_ms: float = 0.0   # client-side time spent looking for tool calls
    tool_calls: list = field(default_factory=list)
    error: Optional[str] = None


def fmt_ms(n: float) -> str:
    return f"{n:6.1f} ms"


# ── path A: JSON-SSE + client-side text scan ───────────────────────────────


async def run_json_sse(client: httpx.AsyncClient, url: str, model: str,
                        prompt: str, max_tokens: int) -> Result:
    r = Result(label="JSON-SSE + client text scan")
    body = _chat_body(model, prompt, max_tokens)
    t0 = time.perf_counter()
    ttfb = None
    text_buf: list[str] = []
    try:
        async with client.stream("POST", url + "/v1/chat/completions",
                                  json=body,
                                  headers={"Accept-Encoding": "identity"},
                                  timeout=120) as resp:
            resp.raise_for_status()
            wire = bytearray()
            async for chunk in resp.aiter_raw():
                if ttfb is None:
                    ttfb = (time.perf_counter() - t0) * 1000
                wire.extend(chunk)
            r.wire_bytes = len(wire)
            r.decoded_bytes = len(wire)
        # Parse SSE → text deltas → scan.
        d0 = time.perf_counter()
        body_text = wire.decode("utf-8", errors="replace")
        full_text = ""
        for line in body_text.split("\n"):
            if not line.startswith("data: "):
                continue
            payload = line[6:].strip()
            if payload == "[DONE]":
                continue
            try:
                obj = json.loads(payload)
                ch = obj.get("choices", [{}])[0]
                # Chat completions: piece is in delta.content; legacy
                # text completions used choices[0].text.
                piece = (ch.get("delta") or {}).get("content") or ch.get("text") or ""
                full_text += piece
                r.tokens += 1
            except Exception:
                pass
        # Run the text scan once over the assembled string.
        for m in TOOL_CALL_REGEX.finditer(full_text):
            r.tool_calls.append(m.group(1).strip())
        r.detect_ms = (time.perf_counter() - d0) * 1000
        r.ttfb_ms = ttfb or 0.0
        r.total_ms = (time.perf_counter() - t0) * 1000
    except Exception as e:
        r.error = f"{type(e).__name__}: {e}"
    return r


# ── path B: Codec msgpack + client-side detokenize+scan ────────────────────


async def run_codec_no_watcher(client: httpx.AsyncClient, url: str, model: str,
                                prompt: str, max_tokens: int,
                                tokenizer) -> Result:
    r = Result(label="Codec msgpack + client detokenize+scan")
    body = _chat_body(model, prompt, max_tokens, stream_format="msgpack")
    t0 = time.perf_counter()
    ttfb = None
    all_ids: list[int] = []
    try:
        async with client.stream("POST", url + "/v1/chat/completions",
                                  json=body,
                                  headers={"Accept-Encoding": "identity"},
                                  timeout=120) as resp:
            resp.raise_for_status()
            wire = bytearray()
            async for chunk in resp.aiter_raw():
                if ttfb is None:
                    ttfb = (time.perf_counter() - t0) * 1000
                wire.extend(chunk)
            r.wire_bytes = len(wire)
            r.decoded_bytes = len(wire)
        # Decode the binary frames.
        for frame in msgpack.Unpacker(io.BytesIO(wire), raw=False):
            for _id in frame.get("ids", []):
                all_ids.append(_id)
        r.tokens = len(all_ids)
        # Client-side detection: detokenize the full output and scan.
        d0 = time.perf_counter()
        if tokenizer is not None:
            text = tokenizer.decode(all_ids, skip_special_tokens=False)
        else:
            text = ""
        for m in TOOL_CALL_REGEX.finditer(text):
            r.tool_calls.append(m.group(1).strip())
        r.detect_ms = (time.perf_counter() - d0) * 1000
        r.ttfb_ms = ttfb or 0.0
        r.total_ms = (time.perf_counter() - t0) * 1000
    except Exception as e:
        r.error = f"{type(e).__name__}: {e}"
    return r


# ── path C: Codec msgpack + server-side ToolWatcher ────────────────────────


async def run_codec_with_watcher(client: httpx.AsyncClient, url: str, model: str,
                                  prompt: str, max_tokens: int,
                                  start_id: int, end_id: int) -> Result:
    r = Result(label="Codec msgpack + server tool_watcher")
    body = _chat_body(model, prompt, max_tokens, stream_format="msgpack",
                       tool_watcher={"start_id": start_id, "end_id": end_id})
    t0 = time.perf_counter()
    ttfb = None
    try:
        async with client.stream("POST", url + "/v1/chat/completions",
                                  json=body,
                                  headers={"Accept-Encoding": "identity"},
                                  timeout=120) as resp:
            resp.raise_for_status()
            wire = bytearray()
            async for chunk in resp.aiter_raw():
                if ttfb is None:
                    ttfb = (time.perf_counter() - t0) * 1000
                wire.extend(chunk)
            r.wire_bytes = len(wire)
            r.decoded_bytes = len(wire)
        # Decode binary frames; collect tool_calls directly off the wire.
        d0 = time.perf_counter()
        for frame in msgpack.Unpacker(io.BytesIO(wire), raw=False):
            r.tokens += len(frame.get("ids", []))
            for tc in frame.get("tool_calls", []) or []:
                r.tool_calls.append(tc.get("arguments_json", ""))
        r.detect_ms = (time.perf_counter() - d0) * 1000
        r.ttfb_ms = ttfb or 0.0
        r.total_ms = (time.perf_counter() - t0) * 1000
    except Exception as e:
        r.error = f"{type(e).__name__}: {e}"
    return r


# ── runner ──────────────────────────────────────────────────────────────────


async def run_all(url: str, model: str, prompt: str, max_tokens: int,
                  start_id: int, end_id: int) -> List[Result]:
    # Tokenizer used by path B for client-side detokenization. Pulled
    # from HuggingFace; cached in ~/.cache/huggingface.
    tokenizer = None
    try:
        from transformers import AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained(model)
    except Exception as e:
        print(f"  warn: tokenizer load failed ({e}); path B will skip detokenize",
              file=sys.stderr)

    async with httpx.AsyncClient() as client:
        results = []
        for runner in [
            lambda: run_json_sse(client, url, model, prompt, max_tokens),
            lambda: run_codec_no_watcher(client, url, model, prompt, max_tokens, tokenizer),
            lambda: run_codec_with_watcher(client, url, model, prompt, max_tokens,
                                            start_id, end_id),
        ]:
            r = await runner()
            print(f"  ✓ {r.label}: wire={r.wire_bytes} bytes  "
                  f"tokens={r.tokens}  detect={fmt_ms(r.detect_ms)}  "
                  f"calls={len(r.tool_calls)}", file=sys.stderr)
            results.append(r)
        return results


def render(results: List[Result]) -> str:
    out = ["", f"{'path':45s}  {'wire':>10s}  {'tokens':>6s}  {'detect':>10s}  "
           f"{'TTFB':>9s}  {'total':>9s}  calls"]
    out.append("-" * 110)
    for r in results:
        if r.error:
            out.append(f"{r.label:45s}  ERROR: {r.error}")
            continue
        out.append(
            f"{r.label:45s}  {r.wire_bytes:>10d}  {r.tokens:>6d}  "
            f"{fmt_ms(r.detect_ms):>10s}  {fmt_ms(r.ttfb_ms):>9s}  "
            f"{fmt_ms(r.total_ms):>9s}  {len(r.tool_calls)}"
        )
    out.append("")
    if any(r.tool_calls for r in results):
        out.append("tool calls captured:")
        for r in results:
            if r.tool_calls:
                out.append(f"  [{r.label}]")
                for i, tc in enumerate(r.tool_calls):
                    snip = (tc[:80] + "...") if len(tc) > 80 else tc
                    out.append(f"    {i}: {snip}")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(prog="codec-toolcall-bench")
    ap.add_argument("--url", default="http://192.168.1.88:30000")
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--prompt", default=DEFAULT_USER_PROMPT)
    ap.add_argument("--max-tokens", type=int, default=128)
    ap.add_argument("--start-id", type=int, default=151657,
                    help="tool-call start marker token id (Qwen2.5: 151657)")
    ap.add_argument("--end-id", type=int, default=151658,
                    help="tool-call end marker token id (Qwen2.5: 151658)")
    args = ap.parse_args()

    print(f"target: {args.url}")
    print(f"model:  {args.model}")
    print(f"max_tokens={args.max_tokens}  watcher_ids=({args.start_id}, {args.end_id})")
    results = asyncio.run(run_all(args.url, args.model, args.prompt,
                                   args.max_tokens, args.start_id, args.end_id))
    print(render(results))


if __name__ == "__main__":
    main()
