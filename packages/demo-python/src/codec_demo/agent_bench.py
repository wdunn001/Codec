"""
Agentic loop bench: complete tool-calling round-trip through sglang
PR #24557 (server-side ToolWatcher).

Flow:
  1. Send a prompt that needs a tool call.
  2. Stream the model's output.
  3. When sglang surfaces a tool_call on the wire, dispatch it
     (HTTP call to a registered tool: searxng, mcp, mock, etc.).
  4. Append the tool result to the chat history as a `tool` message.
  5. Re-send the (extended) history to sglang for the final answer.
  6. Stream the final answer.

Compares two wire paths:

  A) JSON-SSE baseline. Orchestrator detokenizes every frame and
     regex-scans for <tool_call>...</tool_call>. We measure the wire
     bytes, the client CPU spent on detection, and the total
     round-trip latency including the tool call.

  B) Codec msgpack + server tool_watcher. Orchestrator just reads
     `frame.tool_calls`. Zero detokenize on the hot path.

Usage:
    py -3.13 -c "import sys;sys.argv=['agent','--url','http://192.168.1.88:30000']; \\
        from codec_demo.agent_bench import main; main()"
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
from typing import Any, Awaitable, Callable, Dict, List, Optional

import httpx
import msgpack


# ─── tool registry ──────────────────────────────────────────────────────────


# A "tool" here is any async callable: name + JSON args → result string.
# Real implementations would dispatch to MCP / SearXNG / a user-registered
# function. For the bench we ship a deterministic mock so latency numbers
# are comparable across runs.

ToolFn = Callable[[Dict[str, Any]], Awaitable[str]]


async def mock_get_weather(args: Dict[str, Any]) -> str:
    """Mock weather tool. ~1 ms simulated dispatch latency."""
    await asyncio.sleep(0.001)
    city = args.get("city", "?")
    return json.dumps({
        "city": city,
        "temperature_c": 18,
        "condition": "partly cloudy",
        "humidity_pct": 62,
    })


# Real tool: SearXNG metasearch on the lab box.
SEARXNG_URL = "http://192.168.1.88:8888"

# Real tool: MetaMCP gateway on the lab box, fronting Time / Calculator /
# YouTube-Transcripts / Sequential-Thinking / Playwright / etc.
# Auth via Bearer token. Path /metamcp/<endpoint>/mcp uses the MCP
# Streamable HTTP transport: POST initialize → grab session id from
# `mcp-session-id` response header → POST tools/call with the same id.
import os

METAMCP_URL = "http://192.168.1.88:12008/metamcp/openwebui-api/mcp"
METAMCP_KEY = os.environ.get("METAMCP_API_KEY", "")


class _MetaMCPClient:
    """One-shot client. Initializes a session lazily, reuses it for
    every `call`. Streamable HTTP responses are SSE-framed (one
    `data:` line per JSON-RPC reply); we accumulate and return."""

    def __init__(self, url: str, api_key: str) -> None:
        self.url = url
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        self.session_id: Optional[str] = None
        self._req_id = 0

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    @staticmethod
    def _parse_sse(body: str) -> dict:
        for line in body.splitlines():
            if line.startswith("data: "):
                payload = line[6:].strip()
                if payload:
                    try:
                        return json.loads(payload)
                    except json.JSONDecodeError:
                        continue
        return {}

    async def _initialize(self, c: httpx.AsyncClient) -> None:
        body = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "codec-bench", "version": "0.1"},
            },
        }
        r = await c.post(self.url, headers=self.headers, json=body, timeout=15)
        r.raise_for_status()
        sid = r.headers.get("mcp-session-id")
        if not sid:
            raise RuntimeError("MetaMCP initialize: no mcp-session-id header")
        self.session_id = sid
        # Send the initialized notification (no response expected).
        nbody = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        await c.post(
            self.url,
            headers={**self.headers, "Mcp-Session-Id": sid},
            json=nbody,
            timeout=15,
        )

    async def call(self, c: httpx.AsyncClient,
                   tool_name: str, args: Dict[str, Any]) -> str:
        if self.session_id is None:
            await self._initialize(c)
        body = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": args},
        }
        r = await c.post(
            self.url,
            headers={**self.headers, "Mcp-Session-Id": self.session_id},
            json=body, timeout=30,
        )
        r.raise_for_status()
        # Body may be SSE-framed (text/event-stream) or plain JSON.
        ct = r.headers.get("content-type", "")
        if "event-stream" in ct:
            data = self._parse_sse(r.text)
        else:
            try:
                data = r.json()
            except Exception:
                data = {}
        # Extract the tool's text content. MCP tool responses look like
        # {"result":{"content":[{"type":"text","text":"..."}]}}
        result = data.get("result", {}) or {}
        contents = result.get("content") or []
        texts = []
        for c_ in contents:
            if isinstance(c_, dict) and c_.get("type") == "text":
                texts.append(c_.get("text", ""))
        if texts:
            return "\n".join(texts)
        # Fall back to raw result for non-text content (images, errors, etc.)
        return json.dumps(result if result else data)


_mcp_client: Optional[_MetaMCPClient] = None


def _get_mcp() -> Optional[_MetaMCPClient]:
    """Lazily build the singleton client. Returns None if no key set."""
    global _mcp_client
    if not METAMCP_KEY:
        return None
    if _mcp_client is None:
        _mcp_client = _MetaMCPClient(METAMCP_URL, METAMCP_KEY)
    return _mcp_client


def _make_mcp_tool(remote_name: str) -> ToolFn:
    """Build a ToolFn that routes to a specific MCP tool by name.
    The local name (in REGISTRY / TOOLS_MANIFEST) and remote name can
    differ: useful when the MetaMCP tool name has a server prefix
    that confuses small chat-tuned models."""
    async def fn(args: Dict[str, Any]) -> str:
        mcp = _get_mcp()
        if mcp is None:
            return json.dumps({"error": "METAMCP_API_KEY not set"})
        async with httpx.AsyncClient() as c:
            try:
                return await mcp.call(c, remote_name, args)
            except Exception as e:
                return json.dumps({"error": f"{type(e).__name__}: {e}"})
    return fn


async def searxng_search(args: Dict[str, Any]) -> str:
    """Hit SearXNG's JSON API and return the top-N results as a
    compact JSON string the model can read back. Results are
    truncated to keep the tool response small enough that the model
    can incorporate them without hitting context limits."""
    query = args.get("query") or args.get("q") or ""
    if not query:
        return json.dumps({"error": "missing 'query' arg"})
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                f"{SEARXNG_URL}/search",
                params={"q": query, "format": "json", "safesearch": 1},
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        return json.dumps({"error": f"{type(e).__name__}: {e}"})
    top = []
    for hit in (data.get("results") or [])[:5]:
        top.append({
            "title": (hit.get("title") or "")[:120],
            "url": hit.get("url"),
            "snippet": (hit.get("content") or "")[:200],
        })
    return json.dumps({"query": query, "results": top})


REGISTRY: Dict[str, ToolFn] = {
    "get_weather": mock_get_weather,
    "search":      searxng_search,
    # MetaMCP-backed tools. Local names are short and "model-friendly";
    # they route to MetaMCP tool names with the server prefix.
    "get_current_time": _make_mcp_tool("Time__get_current_time"),
    "convert_time":     _make_mcp_tool("Time__convert_time"),
    "youtube_transcript": _make_mcp_tool("YouTube-Transcripts__get_transcript"),
}


# ─── prompts / chat shape ───────────────────────────────────────────────────


TOOLS_MANIFEST = [
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
    },
    {
        "type": "function",
        "function": {
            "name": "search",
            "description": (
                "Search the web for current information. Use this when "
                "the user asks about recent events, factual questions, "
                "or anything that may have changed since your training."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query, plain text",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "Get the current time in a specific IANA timezone.",
            "parameters": {
                "type": "object",
                "properties": {
                    "timezone": {
                        "type": "string",
                        "description": "IANA timezone, e.g. 'Asia/Tokyo'.",
                    },
                },
                "required": ["timezone"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "convert_time",
            "description": "Convert a time between two IANA timezones.",
            "parameters": {
                "type": "object",
                "properties": {
                    "source_timezone": {"type": "string"},
                    "time": {"type": "string", "description": "HH:MM"},
                    "target_timezone": {"type": "string"},
                },
                "required": ["source_timezone", "time", "target_timezone"],
            },
        },
    },
]


def build_chat(model: str, messages: List[dict], *,
               stream_format: Optional[str] = None,
               tool_watcher: Optional[dict] = None,
               max_tokens: int = 256) -> dict:
    body: dict = {
        "model": model,
        "messages": messages,
        "tools": TOOLS_MANIFEST,
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


# ─── agent loop, JSON-SSE baseline ──────────────────────────────────────────


@dataclass
class TurnStats:
    label: str
    wire_bytes: int = 0
    tokens: int = 0
    detect_ms: float = 0.0     # client CPU for tool-call detection
    dispatch_ms: float = 0.0   # time spent calling the tool (network/exec)
    ttfb_ms: float = 0.0
    total_ms: float = 0.0
    tool_calls_seen: List[dict] = field(default_factory=list)
    final_answer: str = ""
    error: Optional[str] = None


TOOL_CALL_RE = re.compile(r"<tool_call>(.*?)</tool_call>", re.DOTALL)


async def _stream_jsonsse(client: httpx.AsyncClient, url: str, body: dict
                          ) -> tuple[int, float, float, str]:
    """Returns (wire_bytes, ttfb_ms, total_ms, full_text). Concatenates
    delta.content (chat) or text (legacy completion) into a single string."""
    t0 = time.perf_counter()
    ttfb = None
    parts: list[str] = []
    wire = 0
    async with client.stream(
        "POST", url + "/v1/chat/completions", json=body,
        headers={"Accept-Encoding": "identity"}, timeout=120,
    ) as resp:
        resp.raise_for_status()
        buf = bytearray()
        async for chunk in resp.aiter_raw():
            if ttfb is None:
                ttfb = (time.perf_counter() - t0) * 1000
            buf.extend(chunk)
        wire = len(buf)
        text = bytes(buf).decode("utf-8", errors="replace")
        for line in text.split("\n"):
            if not line.startswith("data: "):
                continue
            payload = line[6:].strip()
            if payload == "[DONE]":
                continue
            try:
                obj = json.loads(payload)
                ch = obj.get("choices", [{}])[0]
                piece = (ch.get("delta") or {}).get("content") or ch.get("text") or ""
                if piece:
                    parts.append(piece)
            except Exception:
                pass
    total = (time.perf_counter() - t0) * 1000
    return wire, ttfb or 0.0, total, "".join(parts)


async def _stream_codec(client: httpx.AsyncClient, url: str, body: dict
                        ) -> tuple[int, float, float, list[int], list[dict]]:
    """Returns (wire_bytes, ttfb_ms, total_ms, ids, tool_calls). Both
    `ids` and `tool_calls` come straight off the binary wire: no
    detokenize."""
    t0 = time.perf_counter()
    ttfb = None
    async with client.stream(
        "POST", url + "/v1/chat/completions", json=body,
        headers={"Accept-Encoding": "identity"}, timeout=120,
    ) as resp:
        resp.raise_for_status()
        buf = bytearray()
        async for chunk in resp.aiter_raw():
            if ttfb is None:
                ttfb = (time.perf_counter() - t0) * 1000
            buf.extend(chunk)
    wire = len(buf)
    ids: list[int] = []
    tool_calls: list[dict] = []
    for frame in msgpack.Unpacker(io.BytesIO(bytes(buf)), raw=False):
        for _id in frame.get("ids", []):
            ids.append(_id)
        for tc in frame.get("tool_calls", []) or []:
            tool_calls.append(tc)
    total = (time.perf_counter() - t0) * 1000
    return wire, ttfb or 0.0, total, ids, tool_calls


async def dispatch(tool_calls: List[dict]) -> tuple[List[dict], float]:
    """Call each tool, return (tool_messages, ms_spent)."""
    d0 = time.perf_counter()
    out: List[dict] = []
    for i, tc in enumerate(tool_calls):
        name = tc.get("name") or "unknown"
        # The model emits the body as {"name":"f","arguments":{...}} per
        # convention. Server-side ToolWatcher already extracted `name`
        # into the tool_call event, but `arguments_json` is still the
        # full body string. Parse it and pull out just the arguments.
        try:
            parsed = json.loads(tc.get("arguments_json") or "{}")
            if isinstance(parsed, dict) and "arguments" in parsed:
                args = parsed["arguments"] if isinstance(parsed["arguments"], dict) else {}
                if not name or name == "unknown":
                    name = parsed.get("name") or name
            elif isinstance(parsed, dict):
                args = parsed
            else:
                args = {}
        except json.JSONDecodeError:
            args = {}
        fn = REGISTRY.get(name)
        if fn is None:
            result = json.dumps({"error": f"unknown function {name!r}"})
        else:
            try:
                result = await fn(args)
            except Exception as e:
                result = json.dumps({"error": f"{type(e).__name__}: {e}"})
        out.append({
            "role": "tool",
            "tool_call_id": tc.get("id") or f"call_{i}",
            "content": result,
        })
    return out, (time.perf_counter() - d0) * 1000


# ─── path A: JSON-SSE ───────────────────────────────────────────────────────


async def run_jsonsse_loop(client: httpx.AsyncClient, url: str, model: str,
                            user_prompt: str, max_tokens: int) -> TurnStats:
    s = TurnStats(label="JSON-SSE + client text scan + dispatch")
    messages = [{"role": "user", "content": user_prompt}]
    t0 = time.perf_counter()
    try:
        # Turn 1: model decides on a tool call.
        body = build_chat(model, messages, max_tokens=max_tokens)
        wire1, ttfb1, t1_ms, text1 = await _stream_jsonsse(client, url, body)
        s.wire_bytes += wire1
        s.ttfb_ms = ttfb1

        # Detect on the assembled text.
        d0 = time.perf_counter()
        tool_calls = []
        for m in TOOL_CALL_RE.finditer(text1):
            body_text = m.group(1).strip()
            try:
                obj = json.loads(body_text)
                tool_calls.append({
                    "name": obj.get("name"),
                    "arguments_json": body_text,
                })
            except Exception:
                tool_calls.append({"name": None, "arguments_json": body_text})
        s.detect_ms = (time.perf_counter() - d0) * 1000
        s.tool_calls_seen = tool_calls

        if tool_calls:
            # Dispatch.
            tool_msgs, dispatch_ms = await dispatch(tool_calls)
            s.dispatch_ms = dispatch_ms

            # Turn 2: append the assistant turn (with the tool_call payload)
            # and the tool result, ask for the final answer.
            assistant_msg = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": tc.get("id") or f"call_{i}",
                        "type": "function",
                        "function": {
                            "name": tc.get("name") or "",
                            "arguments": tc.get("arguments_json") or "",
                        },
                    } for i, tc in enumerate(tool_calls)
                ],
            }
            messages2 = messages + [assistant_msg] + tool_msgs
            body2 = build_chat(model, messages2, max_tokens=max_tokens)
            wire2, _, t2_ms, text2 = await _stream_jsonsse(client, url, body2)
            s.wire_bytes += wire2
            s.final_answer = text2
        else:
            s.final_answer = text1

        s.total_ms = (time.perf_counter() - t0) * 1000
    except Exception as e:
        s.error = f"{type(e).__name__}: {e}"
    return s


# ─── path B: Codec + server tool_watcher ────────────────────────────────────


async def run_codec_loop(client: httpx.AsyncClient, url: str, model: str,
                          user_prompt: str, max_tokens: int,
                          start_id: int, end_id: int) -> TurnStats:
    s = TurnStats(label="Codec msgpack + server tool_watcher + dispatch")
    messages = [{"role": "user", "content": user_prompt}]
    t0 = time.perf_counter()
    try:
        body = build_chat(
            model, messages, stream_format="msgpack",
            tool_watcher={"start_id": start_id, "end_id": end_id},
            max_tokens=max_tokens,
        )
        wire1, ttfb1, _t1_ms, _ids, tool_calls = await _stream_codec(
            client, url, body
        )
        s.wire_bytes += wire1
        s.ttfb_ms = ttfb1
        # No client-side detection cost: the tool_calls list is on the wire.
        s.detect_ms = 0.0
        s.tool_calls_seen = tool_calls

        if tool_calls:
            tool_msgs, dispatch_ms = await dispatch(tool_calls)
            s.dispatch_ms = dispatch_ms

            assistant_msg = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": tc.get("id") or f"call_{i}",
                        "type": "function",
                        "function": {
                            "name": tc.get("name") or "",
                            "arguments": tc.get("arguments_json") or "",
                        },
                    } for i, tc in enumerate(tool_calls)
                ],
            }
            messages2 = messages + [assistant_msg] + tool_msgs
            body2 = build_chat(
                model, messages2, stream_format="msgpack",
                # No watcher needed on turn 2: final answer is plain text.
                max_tokens=max_tokens,
            )
            wire2, _, _t2_ms, _ids2, _ = await _stream_codec(client, url, body2)
            s.wire_bytes += wire2
            # We don't try to render the IDs to text here: that would
            # require a tokenizer. The bench only cares about wire bytes,
            # detection latency, and end-to-end timing. A real client
            # would call tokenizer.decode(ids2) to render to the user.
            s.final_answer = f"<{len(_ids2)} output tokens>"
        else:
            s.final_answer = f"<{len(_ids)} output tokens, no tool call>"

        s.total_ms = (time.perf_counter() - t0) * 1000
    except Exception as e:
        s.error = f"{type(e).__name__}: {e}"
    return s


# ─── runner + render ────────────────────────────────────────────────────────


def fmt(n: float) -> str:
    return f"{n:6.1f} ms"


def render(results: List[TurnStats]) -> str:
    out = ["", f"{'path':50s}  {'wire':>8s}  {'detect':>9s}  "
           f"{'dispatch':>9s}  {'TTFB':>9s}  {'total':>9s}  calls"]
    out.append("-" * 110)
    for r in results:
        if r.error:
            out.append(f"{r.label:50s}  ERROR: {r.error}")
            continue
        out.append(
            f"{r.label:50s}  {r.wire_bytes:>8d}  {fmt(r.detect_ms):>9s}  "
            f"{fmt(r.dispatch_ms):>9s}  {fmt(r.ttfb_ms):>9s}  "
            f"{fmt(r.total_ms):>9s}  {len(r.tool_calls_seen)}"
        )
    out.append("")
    if any(r.tool_calls_seen for r in results):
        out.append("tool calls dispatched:")
        for r in results:
            for tc in r.tool_calls_seen:
                out.append(f"  [{r.label[:30]}] {tc.get('name')} ← {tc.get('arguments_json')}")
    return "\n".join(out)


async def run_all(url: str, model: str, prompt: str, max_tokens: int,
                  start_id: int, end_id: int) -> List[TurnStats]:
    async with httpx.AsyncClient() as client:
        a = await run_jsonsse_loop(client, url, model, prompt, max_tokens)
        print(f"  ✓ {a.label}", file=sys.stderr)
        b = await run_codec_loop(client, url, model, prompt, max_tokens,
                                  start_id, end_id)
        print(f"  ✓ {b.label}", file=sys.stderr)
        return [a, b]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://192.168.1.88:30000")
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--prompt", default="What's the weather in Tokyo?")
    ap.add_argument("--max-tokens", type=int, default=128)
    ap.add_argument("--start-id", type=int, default=151657)
    ap.add_argument("--end-id", type=int, default=151658)
    args = ap.parse_args()

    print(f"target: {args.url}\nmodel:  {args.model}\nprompt: {args.prompt}")
    results = asyncio.run(run_all(args.url, args.model, args.prompt,
                                   args.max_tokens, args.start_id, args.end_id))
    print(render(results))


if __name__ == "__main__":
    main()
