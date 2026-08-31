# codecai

**Python client for the [Codec](https://github.com/wdunn001/Codec) binary transport protocol.**

The Python twin of [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) (browser/Node) and [`Codec.Net`](https://www.nuget.org/packages/Codec.Net) (.NET). Decodes streaming token IDs from Codec-compliant servers (vLLM, SGLang) and encodes text into IDs for the bidirectional path. Pure Python, no native dependencies beyond `msgspec` and `httpx`.

## Why this exists

Real measurements from `Codec/packages/bench` (live Ollama qwen2.5):

| Configuration                              | B/token | vs JSON-SSE |
|--------------------------------------------|--------:|------------:|
| JSON-SSE (live Ollama)                     |   186.4 |        1.0× |
| Codec msgpack                              |    16.0 |        9.6× |
| Codec protobuf                             |    10.9 |   **14.2×** |
| Codec msgpack + `Content-Encoding: br`     |    2.79 |   **55.2×** |

Agent-to-agent handoffs: **3.6× faster** end-to-end at 1024 tokens. Both the wire shrinks and detokenize+tokenize gets eliminated.

## Install

```bash
pip install codecai
```

Requires Python 3.9+.

## Quick start: decode a stream

```python
import asyncio
import httpx

from codecai import Detokenizer, decode_msgpack_stream, load_map


async def main() -> None:
    # 1. Load and pin the dialect map by sha256.
    m = await load_map(
        url="https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json",
        hash="sha256:c73972f7a580…",
    )

    # 2. Stream from a Codec-compliant server.
    async with httpx.AsyncClient() as client:
        async with client.stream(
            "POST",
            "http://localhost:8000/v1/completions",
            json={
                "model": "Qwen/Qwen2.5-7B-Instruct",
                "prompt": "Explain entropy.",
                "stream_format": "msgpack",
                "max_tokens": 256,
            },
            timeout=None,
        ) as resp:
            # 3. Detokenize lazily: only when rendering for a human.
            detok = Detokenizer(m)
            async for frame in decode_msgpack_stream(resp.aiter_raw()):
                print(
                    detok.render(frame.ids, partial=not frame.done),
                    end="",
                    flush=True,
                )


asyncio.run(main())
```

## Forwarding IDs to another model (agent-to-agent, same vocab)

When the next consumer of this stream is another model on the same vocab: agent → agent, orchestrator → planner, model → tool that re-feeds the model: you do NOT need a `Detokenizer` at all. Forward `frame.ids` directly:

```python
# No Detokenizer constructed: zero UTF-8 reassembly, zero BPE-merge work.
async for frame in decode_msgpack_stream(resp.aiter_raw()):
    await forward_codec_frame(next_agent, frame.ids, done=frame.done)
```

This is the **hot-loop fast path** for agent mesh code. Skipping `detok.render(...)` saves ~10-20% client CPU on heavy reply streams (no string allocation, no partial-UTF-8 buffering, no metaspace decode). For cross-vocab handoff use [`Translator`](#cross-vocab-agent-handoff): that case still needs the byte-level path because the two vocabs disagree.

## Quick start: encode text (bidirectional path)

When you want **zero text on the wire in either direction**: agent A's output IDs feeding straight into agent B's input: encode text to IDs locally before sending:

```python
from codecai import BPETokenizer

tok = BPETokenizer(m)
prompt_ids = tok.encode("Explain entropy.")  # pure-Python BPE, exact

# Send IDs as a normal OpenAI prompt: list[int] (no special endpoint needed).
async with httpx.AsyncClient() as client:
    async with client.stream(
        "POST",
        "http://localhost:8000/v1/completions",
        json={
            "prompt": prompt_ids,
            "stream_format": "msgpack",
            "max_tokens": 256,
        },
    ) as resp:
        ...
```

For huge prompts (>50K tokens, e.g. RAG with long context), `/v1/completions/codec` accepts a binary msgpack request body with the same effect. See [PROTOCOL.md](https://github.com/wdunn001/Codec/blob/main/spec/PROTOCOL.md) for both paths.

## API

| Symbol | Purpose |
|---|---|
| `load_map(url=..., hash=...)` | Fetch + sha256-verify + cache a dialect map (async) |
| `discover_map(origin=..., id=...)` | Resolve a map via the `.well-known/codec/` convention (async) |
| `discover_index(origin=...)` | Fetch `.well-known/codec/index.json` (optional directory, async) |
| `MemoryMapCache` | Default in-memory `MapCache`. Subclass for Redis / disk |
| `TokenizerMap.from_json(...)` | Parse + schema check |
| `Detokenizer` | Stateful detokenizer: byte_level + metaspace + byte fallback + partial UTF-8 |
| `detokenize(map, ids)` | One-shot for non-streaming use |
| `BPETokenizer` | Pure-Python BPE: byte_level + metaspace |
| `LongestMatchTokenizer` | Vocab-only fallback for canonical-IR maps |
| `pick_tokenizer(map)` | Build the right tokenizer for the loaded map |
| `tokenize(map, text)` | One-shot helper |
| `decode_msgpack_stream(body)` | `AsyncIterable[bytes]` → `AsyncIterator[CodecFrame]` |
| `decode_protobuf_stream(body)` | Same for length-prefixed protobuf |
| `decode_protobuf_frame(payload)` | One-shot frame decoder (no length prefix) |
| `ToolWatcher` | Detect delimited regions (tool calls, reasoning blocks, vision spans) without decoding |
| `Translator`, `translate(...)`, `static_translation_table(...)` | Cross-vocab agent handoff: `ids_A → text → ids_B` with streaming-safe word-boundary buffering |
| `SafetyPolicyDescriptor`, `validate_safety_policy`, `hash_safety_policy` (v0.4) | Sanitized publishable safety-policy descriptor: load and verify a server's advertised policy without operator-internal fields ever crossing the wire |
| `load_safety_policy(url=..., hash=...)`, `discover_safety_policy(origin=..., id=..., hash=...)` (v0.4) | Async loader + `.well-known/codec/policies/` discovery; cross-stack canonical-bytes hash matches the TS / Rust / .NET / Java / supervisor implementations bit-for-bit |
| `discover_zstd_dict(origin=..., hash=...)`, `well_known_dict_url(origin, hash)` (v0.5) | Resolve a zstd dictionary at `.well-known/codec/dicts/<sha256-hex>.zstd`. Hash-pin-verified against the URL's path component; hard-fails on 404 or mismatch (no silent fallback). |

## Detect tool calls without decoding

Most chat-tuned models delimit tool calls with single-token specials (Qwen `<tool_call>` / `</tool_call>`, Llama 3.1+ `<|python_tag|>` / `<|eom_id|>`, DeepSeek-R1 `<think>` / `</think>`, etc.). Detecting one is a uint32 compare in the hot loop: no detokenize, no string allocation:

```python
from codecai import ToolWatcher

watcher = ToolWatcher(map, "<tool_call>", "</tool_call>")

async for frame in decode_msgpack_stream(resp.aiter_raw()):
    for ev in watcher.feed(frame.ids):
        if ev.kind == "passthrough":
            forward_codec_frame(next_agent, ev.ids)   # no decode
        else:  # "region"
            json_args = json.loads(detok.render(ev.ids))
            dispatch_tool(json_args)
```

Stateful: regions split between network frames buffer until the end marker arrives. The same primitive covers reasoning blocks, multimodal spans, code-interpreter regions: anything delimited by a `(start, end)` special pair.

## Cross-vocab agent handoff

When agent A's output feeds agent B as a prompt and the two models have different vocabs, decode-then-reencode through text: without ever putting text on the wire:

```python
from codecai import Translator

tr = Translator(qwen_map, llama_map)
async for frame in decode_msgpack_stream(resp.aiter_raw()):
    llama_ids = tr.translate(frame.ids, partial=not frame.done)
    forward_codec_frame(llama_agent, llama_ids)
# tr.finish() drains the trailing partial-word buffer.
```

`Translator` is stateful: pre-tokenizers split at whitespace. It buffers partial words until a safe boundary arrives as a result. For analysis-only use, `static_translation_table(A, B)` gives a context-free `id_A → ids_B` lookup.

## Correctness

- **Byte-level decode**: every vocab token is a sequence of GPT-2-encoded bytes. The Detokenizer reverses the byte→unicode table and accumulates bytes across tokens until a complete UTF-8 sequence forms. Tested with 3-byte (`€`) and 4-byte (`🚀`) sequences.
- **Metaspace decode**: `▁` becomes space; SentencePiece byte-fallback IDs (`<0x00>`:`<0xFF>`) decoded through the same UTF-8 buffer.
- **Partial sequences across frames**: `Detokenizer` is stateful: call `render(ids, partial=True)` while frames stream, then `partial=False` (default) on the last frame so the buffer flushes. `reset()` between conversations.
- **BPE merge ordering**: greedy by priority rather than left-to-right. Matches HuggingFace `tokenizers` reference behavior. Test fixture verifies this explicitly.
- **HuggingFace round-trip**: real Qwen-2 (152K vocab, byte_level) round-trips ASCII, code, emoji, multi-script CJK / Latin diacritics. Bit-identical with HF's Rust `tokenizers` library (verified by `tests/test_bpe.py::test_qwen_matches_hf_reference`).
- **Hash verification** uses `hashlib.sha256`. Mismatch raises `TokenizerMapHashMismatchError`.

## Map sources

`load_map` accepts any URL: the sha256 hash is what matters. Curated maps:

```
https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/<family>.json
```

14 families covering 70+ aliases: see [`codec-maps`](https://github.com/wdunn001/codec-maps) for the index.

To generate a map from a HuggingFace `tokenizer.json`:

```bash
npx @codecai/maps-cli build my-org/my-model --id=my-org/my-model
```

### Self-hosted discovery via `.well-known/codec/`

If the model maintainer publishes their map at the standard `.well-known/codec/` location on a domain they control, clients only need the origin and map ID:

```python
from codecai import discover_map

m = await discover_map(origin="https://qwen.io", id="qwen/qwen2")
```

This fetches `https://qwen.io/.well-known/codec/maps/qwen/qwen2.json`: either a small `{ id, url, hash }` pointer (recommended) or the full map served inline. Hash verification still anchors the bytes. Spec: [`WELL_KNOWN_DISCOVERY.md`](https://github.com/wdunn001/Codec/blob/main/spec/WELL_KNOWN_DISCOVERY.md). Maintainers can generate the publishing tree with `codecai-maps well-known --map=... --url=...`.

## Compression

`load_map` uses `httpx`. That transparently decompresses `gzip` and `brotli` `Content-Encoding`. jsDelivr serves brotli automatically (3.4× smaller transfers). For Codec streaming responses, the server negotiates `Content-Encoding` based on the request's `Accept-Encoding`.

## License

MIT. See [LICENSE](https://github.com/wdunn001/Codec/blob/main/LICENSE).
