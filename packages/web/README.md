# @codecai/web

**Isomorphic edge tokenizer + lazy detokenizer for the [Codec](https://github.com/wdunn001/Codec) binary transport protocol.**

Codec ships token IDs over the wire instead of UTF-8 text. `@codec/web` is the presentation layer: it loads per-model tokenizer maps, tokenizes text at the edge before transport, and detokenizes IDs to text only when a human is actually going to read them. Agent-to-agent calls skip detokenization entirely — text never enters the transport at all.

Works in browsers, Node 18+, Cloudflare Workers, Deno, and Bun. No Node-only imports, no transitive heavyweight dependencies. The only runtime dep is `@msgpack/msgpack` for stream decoding.

## Install

```bash
npm install @codecai/web
```

## Quick start

### Lazy presentation (most common)

```ts
import { loadMap, Detokenizer, decodeStream } from '@codecai/web';

// 1. Load the dialect map once. Cached after first fetch.
const map = await loadMap({
  url: 'https://maps.codec.ai/llama-3.1-8b.json',
  hash: 'sha256:abcd1234…',
});

// 2. Stream from a Codec-compliant server (e.g. vLLM with stream_format=msgpack).
const resp = await fetch('http://localhost:8000/v1/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'meta-llama/Llama-3.1-8B',
    prompt: 'Explain entropy.',
    stream: true,
    stream_format: 'msgpack',
    max_tokens: 256,
  }),
});

// 3. Detokenize lazily — only when rendering for a human.
const detok = new Detokenizer(map);
for await (const frame of decodeStream(resp.body!)) {
  // frame.ids is the raw token output. Pass it forward unchanged for
  // agent-to-agent. Render it for humans:
  output.append(detok.render(frame.ids, { partial: !frame.done }));
}
```

### Edge-side tokenization

```ts
import { loadMap, LongestMatchTokenizer } from '@codecai/web';

const map = await loadMap({ url: '…', hash: '…' });
const tok = new LongestMatchTokenizer(map);

const ids = tok.encode('Hello, world!');
// Send ids over the wire as msgpack/protobuf — never text.
```

### Protobuf instead of msgpack

```ts
for await (const frame of decodeStream(resp.body!, 'protobuf')) {
  // …
}
```

## What's in the box

| Export                      | Purpose                                                       |
|-----------------------------|---------------------------------------------------------------|
| `loadMap(opts)`             | Fetch + hash-verify + cache a tokenizer map                   |
| `MemoryMapCache`            | Default in-memory cache. Implement `MapCache` for IDB / KV    |
| `validateMap(unknown)`      | Type-narrowing schema check                                   |
| `Detokenizer`               | Stateful detokenizer with byte-fallback + partial-UTF-8 buffering |
| `detokenize(map, ids)`      | One-shot helper for non-streaming use                         |
| `LongestMatchTokenizer`     | Vocab-based tokenizer (longest-prefix match)                  |
| `tokenize(map, text)`       | One-shot helper                                               |
| `decodeStream(body)`        | `ReadableStream<Uint8Array>` → `AsyncIterable<CodecFrame>`    |
| `decodeMsgpackStream`       | msgpack-specific decoder                                      |
| `decodeProtobufStream`      | protobuf-specific decoder                                     |

## Correctness notes

- **Byte-fallback handling**: tokenizers that emit raw UTF-8 bytes for OOV characters (the `byte_fallback_start` / `byte_fallback_end` range in the map) are decoded byte-by-byte with partial sequences buffered until complete. Tested against 3-byte (`€`) and 4-byte (`🚀`) sequences.
- **Partial sequences across frames**: `Detokenizer` is stateful — call `render(ids, { partial: true })` while more frames are coming, then `render(ids, { partial: false })` (or omit `partial`) on the last frame so the buffer flushes. Use `reset()` between conversations.
- **Hash verification** uses Web Crypto's `SubtleCrypto.digest('SHA-256', ...)` — available in every target runtime. A mismatch throws `TokenizerMapHashMismatchError`.

## What this MVP does and doesn't do

The bundled `LongestMatchTokenizer` is correct for vocab-based tokenizers and is a *reasonable approximation* for BPE. It is not a full BPE merge engine — for exact compatibility with Llama / Qwen / Mistral / Claude vocabs you should plug in a wasm `tiktoken` or `sentencepiece` adapter via the `Tokenizer` interface:

```ts
import type { Tokenizer } from '@codecai/web';

class WasmTiktokenAdapter implements Tokenizer {
  constructor(public readonly id: string, private inner: any) {}
  encode(text: string): number[] { return this.inner.encode(text); }
}
```

The Detokenizer is exact — it reads the map directly and handles every tokenizer shape the Codec spec supports.

## License

MIT. See [LICENSE](../../LICENSE) at the repo root.
