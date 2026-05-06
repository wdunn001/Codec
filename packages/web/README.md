# @codecai/web

**Isomorphic tokenizer + lazy detokenizer for the [Codec](https://github.com/wdunn001/Codec) binary transport protocol.**

Codec ships token IDs over the wire instead of UTF-8 text. `@codecai/web` is the presentation layer:

- **Detokenizer** (IDs → text) for rendering binary streams in the browser, lazily, only when a human needs to read them.
- **BPETokenizer** (text → IDs) — pure-JS, exact, no wasm — so the browser can send token-ID prompts upstream and skip the JSON-text round trip entirely.
- **Stream decoder** for both Codec wire modes (msgpack, protobuf) plus the future zstd/gzip-compressed variants (handled transparently by `fetch()`).

Works in browsers, Node 18+, Cloudflare Workers, Deno, Bun. No Node-only imports. Only runtime dep is `@msgpack/msgpack` for stream decoding (~5 kB).

## Why this exists

Real numbers from `Codec/packages/bench`:

| Configuration                              | B/token | vs JSON-SSE |
|--------------------------------------------|--------:|------------:|
| JSON-SSE (live Ollama qwen2.5)             |   186.4 |        1.0× |
| Codec msgpack (identity)                   |    16.0 |        9.6× |
| Codec protobuf (identity)                  |    10.9 |   **14.2×** |
| Codec msgpack + `Content-Encoding: zstd`   |     3.4 |   **45.0×** |

End-to-end agent round-trip (1024 tokens): **3.6× faster** with binary frames, because both the wire shrinks AND detokenize+tokenize gets eliminated.

## Install

```bash
npm install @codecai/web
```

## Quick start — decoding a stream

```ts
import { loadMap, Detokenizer, decodeStream } from '@codecai/web';

// 1. Load and pin the dialect map by hash. Cached forever after first fetch.
const map = await loadMap({
  url:  'https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json',
  hash: 'sha256:c73972f7a580…',
});

// 2. Stream from a Codec-compliant server (vLLM, SGLang).
const resp = await fetch('http://localhost:8000/v1/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'Qwen/Qwen2.5-7B-Instruct',
    prompt: 'Explain entropy.',
    stream_format: 'msgpack',     // ← the only required change
    max_tokens: 256,
  }),
});

// 3. Detokenize lazily — only when rendering for a human.
const detok = new Detokenizer(map);
for await (const frame of decodeStream(resp.body!, 'msgpack')) {
  // frame.ids is the raw token output. Pass it forward unchanged for
  // agent-to-agent. Render it for humans:
  output.append(detok.render(frame.ids, { partial: !frame.done }));
}
```

## Quick start — encoding text (for the bidirectional path)

When you want **zero text on the wire in either direction** — agent A's output IDs feeding straight into agent B's input — encode text to IDs in the browser before sending:

```ts
import { BPETokenizer } from '@codecai/web';

const tok = new BPETokenizer(map);
const promptIds = tok.encode('Explain entropy.');   // pure-JS BPE, exact

await fetch('http://localhost:8000/v1/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: promptIds,            // OpenAI accepts int[] here
    stream_format: 'msgpack',
    max_tokens: 256,
  }),
});
```

For **huge prompts** (>50K tokens, e.g. RAG with long context), the dedicated `/v1/completions/codec` endpoint accepts a binary msgpack request body too. Same wire output, smaller request:

```ts
import { encode as msgpackEncode } from '@msgpack/msgpack';

const body = msgpackEncode({
  prompt_ids: promptIds,
  max_tokens: 256,
  stream_format: 'msgpack',
});
await fetch('http://localhost:8000/v1/completions/codec', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-msgpack' },
  body,
});
```

## Picking the right tokenizer

`pickTokenizer(map)` returns the best implementation for the loaded map:

```ts
import { pickTokenizer } from '@codecai/web';

const tok = pickTokenizer(map);  // → BPETokenizer if map has merges,
                                  //   LongestMatchTokenizer otherwise
const ids = tok.encode(text);
```

| Class                    | When                                                    |
|--------------------------|---------------------------------------------------------|
| `BPETokenizer`           | Real model maps (have `merges` + `encoder`). Exact BPE. |
| `LongestMatchTokenizer`  | Vocab-only / canonical-IR maps. Fallback.               |
| `Detokenizer`            | Always. Decodes IDs → text via the map's encoder.       |

`BPETokenizer` handles both byte-level (Llama-3, Qwen, Phi-3, DeepSeek-V3, Mistral-Nemo, Falcon, SmolLM2) and metaspace SentencePiece (Llama-2, Mistral-v3, Mixtral, Gemma, Codestral). Verified via round-trip tests against the real Qwen-2 152K-vocab tokenizer for ASCII, code, emoji, and CJK.

## API

| Export                      | Purpose                                                       |
|-----------------------------|---------------------------------------------------------------|
| `loadMap(opts)`             | Fetch + sha256-verify + cache a tokenizer map                 |
| `MemoryMapCache`            | Default in-memory cache. Implement `MapCache` for IDB / KV    |
| `validateMap(unknown)`      | Type-narrowing schema check                                   |
| `Detokenizer`               | Stateful detokenizer: byte-level + metaspace + byte fallback + partial UTF-8 buffering |
| `detokenize(map, ids)`      | One-shot helper for non-streaming use                         |
| `BPETokenizer`              | Pure-JS BPE: byte-level and metaspace                         |
| `LongestMatchTokenizer`     | Vocab-only longest-prefix-match (fallback for canonical-IR maps) |
| `pickTokenizer(map)`        | Build the right tokenizer for the loaded map                  |
| `tokenize(map, text)`       | One-shot helper                                               |
| `decodeStream(body, fmt)`   | `ReadableStream<Uint8Array>` → `AsyncIterable<CodecFrame>`    |
| `decodeMsgpackStream`       | msgpack-specific decoder                                      |
| `decodeProtobufStream`      | protobuf-specific decoder                                     |

## Correctness notes

- **Byte-level decode**: every vocab token is a sequence of GPT-2-encoded bytes. The Detokenizer reverses the byte→unicode table and accumulates bytes across tokens until they form a complete UTF-8 sequence. Tested against 3-byte (`€`) and 4-byte (`🚀`) sequences.
- **Metaspace decode**: `▁` becomes space; SentencePiece byte-fallback IDs (`<0x00>`–`<0xFF>`) are decoded as raw bytes through the same UTF-8 buffer.
- **Partial sequences across frames**: `Detokenizer` is stateful — call `render(ids, { partial: true })` while frames are streaming, then `render(ids, { partial: false })` (or omit `partial`) on the last frame so the buffer flushes. Use `reset()` between conversations.
- **BPE merge ordering**: merges are applied greedily by priority, not left-to-right. Matches HuggingFace tokenizers reference behaviour. Test fixture verifies this explicitly.
- **Hash verification** uses Web Crypto's `SubtleCrypto.digest('SHA-256', ...)` — available in every target runtime. A mismatch throws `TokenizerMapHashMismatchError`.

## Map sources

`loadMap` accepts any URL — the sha256 hash is what matters. For a curated set of pre-generated maps:

```
https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/<family>.json
```

14 families covering 70+ aliases — see [`codec-maps`](https://github.com/wdunn001/codec-maps) for the index.

To generate your own from a HuggingFace `tokenizer.json`:

```bash
npx @codecai/maps-cli build my-org/my-model --id=my-org/my-model
npx @codecai/maps-cli hash my-org_my-model.json
```

## Compatibility

| Runtime              | Status              |
|----------------------|---------------------|
| Browsers (modern)    | ✅ Chrome 123+ supports `Content-Encoding: zstd` natively |
| Node.js 18+          | ✅                  |
| Cloudflare Workers   | ✅                  |
| Deno                 | ✅                  |
| Bun                  | ✅                  |

## License

MIT. See [LICENSE](../../LICENSE) at the repo root.
