# `@codecai/mcp-leaf` — both sides of the Codec leaf-mode contract

This package implements **both halves** of the Codec leaf-mode contract specified in [`spec/PROTOCOL.md`](../../spec/PROTOCOL.md) §"Tool-call calling conventions in the map":

- **Writer side** (`makeMetaTokenizer`, `wrapToolCall`, `buildMetaBlock`) — for MCP tool authors. Drop this package into your MCP server, wrap `CallToolResult`s on the way out, and the result graduates to leaf-mode tokenization. A Codec-aware gateway ([`codec-metamcp`](https://hub.docker.com/r/wdunn001/codec-metamcp)) detects the pre-tokenized output and skips its back-compat shim, becoming a transparent ID pipe for the hop.
- **Reader side** (`hasCodecMeta`, `findCodecMeta`, `readCodecMeta`, `takeIds`, `stripCodecMeta`) — for client code that receives wrapped `CallToolResult`s. Lifts the IDs back out without re-tokenizing, validates `Codec-Tokenizer-Map` agreement (throws `CodecMetaMapMismatchError` on divergence — KV-cache poisoning is a fail-fast condition), and offers a strip helper for forwarding to non-Codec-aware downstream clients.

The canonical Codec-aware MCP server, [`codec-time-leaf`](./examples/time-server/), is published to [npm](https://www.npmjs.com/package/@codecai/codec-time-leaf) and [Docker Hub](https://hub.docker.com/r/wdunn001/codec-time-leaf) as the reference + bench workload (variant 5 of the [MCP-live bench](../bench/src/mcp-live.ts) — `msgpack-both+gzip+map`).

## Why it exists

By default, an MCP gateway with Codec enabled sees plaintext tool results, tokenizes them itself, and ships token IDs to the receiving model. That works, but it's a **degraded path**: every gateway hop re-tokenizes the same text. The architectural target is leaf-tokenization — the tool that produces the text knows the tokenizer, so it does the work once.

This package is the smallest possible change to graduate a tool. Two function calls.

## Quick start

```ts
import { makeMetaTokenizer, wrapToolCall } from '@codecai/mcp-leaf';

// Once at server startup.
const meta = await makeMetaTokenizer({
  mapUrl:  'https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json',
  mapHash: 'sha256:0549cbec9d451832f9f8c9dcd2553210fdf4e6f4ff64feebe64d3a09950a5022',
});

// In your tool handler — whatever you used to return:
const result = {
  content: [{ type: 'text', text: 'It is currently 14:30 UTC.' }],
};

// Just wrap it:
return wrapToolCall(result, meta);
```

That returns:

```jsonc
{
  "content": [
    {
      "type": "text",
      "text": "It is currently 14:30 UTC.",
      "_meta": {
        "ai.codec/leaf-tokenization": {
          "map_id": "sha256:0549cbec9d451832f9f8c9dcd2553210fdf4e6f4ff64feebe64d3a09950a5022",
          "ids": [2132, 374, 5023, 220, 16, 19, 25, 18, 15, 27269, 13]
        }
      }
    }
  ]
}
```

The Codec payload is **additive** — non-Codec-aware clients on the same MCP namespace ignore the `_meta` field and see the original `text` block exactly as before. No protocol change, no MCP version bump.

> **Wire shape change in v0.3.2.** Earlier v0.3.0 / v0.3.1 builds emitted Codec metadata as a SIBLING content block (`{ type: "_codec_meta", map_id, ids }`). The MCP SDK's `ContentBlockSchema` is a strict discriminated union over `text | image | audio | resource | resource_link`, so the sibling form crashed time-server itself with `MCP error -32602: Invalid tools/call result` before the result ever left the process. v0.3.2 moves the payload onto the text block's per-block `_meta` field — a first-class MCP spec slot that the SDK validator passes through. The reader-side helpers (`readCodecMeta`, `takeIds`, `stripCodecMeta`) accept BOTH wire shapes for back-compat with results from older Codec-aware tools.

## What the gateway sees

A Codec-aware gateway like [metamcp](https://github.com/wdunn001/metamcp) `feat/codec-binary-transport` will detect the leaf-mode result via its `hasExistingCodecMeta` guard and bypass its back-compat shim:

```
[Codec][leaf] downstream tool returned pre-tokenized result for vocab
  0549cbec9d45… — gateway shim bypassed.
```

Versus the legacy path, which logs:

```
[Codec][shim] tokenizing tool result for vocab 0549cbec9d45… —
  leaf-mode MCP server would skip this.
```

Operators dashboarding the gateway watch the `leafBypasses` counter grow over time as more tools graduate.

## Pick the right map for your tool

Your tool's `mapUrl` + `mapHash` MUST match the tokenizer the receiving model expects. The natural way to source them:

1. The model your downstream agent runs (Qwen-2.5, Llama-3, etc.) maps to a tokenizer dialect ID like `qwen/qwen2`.
2. That ID resolves to a map document via `.well-known/codec/maps/<id>.json` or directly from [`codec-maps`](https://github.com/wdunn001/codec-maps).
3. Pin the URL + sha256 hash. Both are content-addressed and immutable.

If your tool needs to serve multiple downstream models with different tokenizers, instantiate one `MetaTokenizer` per (mapUrl, mapHash) pair and pick the one that matches the request's vocab. The gateway carries this in its routing fabric — see metamcp's per-vocab counter in `getShimMetrics()`.

## Idempotence + isolation

- `wrapToolCall` doesn't mutate its input. Returns a new result.
- Wrapping twice produces the same tree as wrapping once — re-running the wrapper (e.g. across a retry layer) is safe.
- Non-text content blocks (`image`, `audio`, `resource`, etc.) pass through untouched.
- Empty text blocks get no meta sibling; very short text can be skipped via `wrapToolCall(result, meta, { minTextLength: 32 })` to avoid the meta-block overhead on small messages.

## Testing

```bash
npm install
npm run build
npm test
```

The bundled test suite verifies idempotence, the multi-block case, the non-text passthrough, the minTextLength gate, and that input results are not mutated. No CDN fetch — the test pre-seeds the map cache with an inline fixture.

## When to NOT use this

- **Tools whose output isn't model-bound text.** A tool that returns an image, an audio clip, or a binary file has nothing to tokenize. Skip the wrapper or return those blocks unchanged — the gateway shim already passes non-text content through.
- **Tools running behind a non-Codec gateway.** The `_codec_meta` block adds a few hundred bytes per tool call. If no client downstream understands it, the wrapper is dead weight; benchmark before adding it.

## Spec references

- [`spec/PROTOCOL.md`](../../spec/PROTOCOL.md) §"Tool-call calling conventions in the map" — the architectural target.
- [`spec/tokenizer-map.schema.json`](../../spec/tokenizer-map.schema.json) — the map document this package consumes via `loadMap`.
- metamcp's `apps/backend/src/lib/metamcp/codec/codec-content.ts` — gateway-side detection logic (the `hasExistingCodecMeta` guard) that this package's output is contract-checked against.
