# codec-tool-kit

Build Codec-native tools as **bolt-ons** — independently versioned, deployed, and authored, hosted in their own repos. Tools speak token IDs natively when the model is one they've pre-built a cache for, and gracefully fall back to text when it isn't.

The architectural premise: **the gateway should stay a pure token router**. Today, every agent platform pays detokenize → JSON → tool → JSON → tokenize on every tool call. Most of that work is repeated thousands of times for the same response fragments ("It is currently ", " UTC.", "°F", common error messages). This SDK lets a tool author tokenize those fragments **once at build time**, ship the cached IDs, and pay nothing on the hot path.

```
                ┌──── gateway (sglang / vLLM / llama.cpp / MetaMCP) ────┐
client ─call──→ │ ToolWatcher detects <tool_call> in token stream      │
                │  → routes raw token IDs to the tool over the wire    │ ──→ tool
                │ ◀── tool returns response token IDs (pre-cached)     │
                │ ToolWatcher reinjects IDs into generation context    │
                └──────────────────────────────────────────────────────┘
                          (no detokenize anywhere here)
```

## Install

```bash
npm install codec-tool-kit
```

Zero runtime dependencies. ~6 KB minified. Works in Node, Bun, Deno, browsers.

## Why bolt-ons (and not in-process)

An earlier sketch of this architecture had the gateway dispatch tools in-process. We backed off that for three reasons your environment will probably share:

1. **Modularity.** Tools want their own release cadence, security review, dependencies, and deploy surface. Locking them into the inference server forces every tool change into a server release.
2. **Independent hosting.** A team that builds a Codec-native search tool wants to host it in their own repo, on their own infra, with their own SLOs. The gateway only needs the manifest URL.
3. **Pre-cached tokenization belongs at the tool, not the gateway.** Every tool knows its own response shape better than any gateway can. Putting the cache in the tool means each tool ships *exactly the fragments it emits* — no central dictionary to maintain, no cross-tool coupling.

The wire savings are the same as in-process dispatch. The latency win is one extra hop (tool ↔ gateway, typically a unix socket or LAN RTT — single-digit ms) — worth it for the operational decoupling.

## Quick start: a date/time tool

The full example would normally live in `packages/codec-tool-time/` — here's the shape compressed into one file. Three pieces:

### 1. `manifest.json` — the contract

```json
{
  "schema": "1",
  "name": "get_current_time",
  "version": "0.1.0",
  "description": "Return the current time in UTC, optionally formatted.",
  "argumentsSchema": {
    "type": "object",
    "properties": {
      "format": { "type": "string", "enum": ["iso", "human"] }
    }
  },
  "models": [
    {
      "modelId": "Qwen/Qwen2.5-0.5B-Instruct",
      "tokenizerHash": "f3e9c7…",
      "cacheFile": "cache/qwen25-0.5b.json"
    },
    {
      "modelId": "meta-llama/Llama-3.2-3B-Instruct",
      "tokenizerHash": "d1a8f2…",
      "cacheFile": "cache/llama-3.2-3b.json"
    }
  ],
  "homepage": "https://github.com/your-org/codec-tool-time"
}
```

### 2. `build-cache.ts` — pre-cache at build time

```ts
import { precache } from 'codec-tool-kit/precache';
import { writeFileSync } from 'node:fs';
import { huggingfaceTokenizer } from 'your-favorite-tokenizer';

const tokenizer = huggingfaceTokenizer({ from: 'Qwen/Qwen2.5-0.5B-Instruct' });

const cache = precache({
  fragments: [
    { id: 'iso-prefix',     kind: 'static',   text: 'The current time is ' },
    { id: 'iso-suffix',     kind: 'static',   text: ' UTC.' },
    { id: 'human-template', kind: 'template', text: 'It is {hours}:{minutes} on {day}.' },
    { id: 'error-fmt',      kind: 'static',   text: 'Unsupported format requested.' },
  ],
  tokenizer,
});

writeFileSync('cache/qwen25-0.5b.json', JSON.stringify(cache));
// repeat for each model in the manifest
```

Run this at `npm run build`. Ship the resulting `cache/*.json` files in the published package.

### 3. `index.ts` — the runtime

```ts
import {
  type CodecTool,
  type CodecToolCall,
  type CodecToolResult,
  tokensResult,
  textResult,
  errorResult,
  findBinding,
  verifyCache,
  renderTemplate,
} from 'codec-tool-kit';

import manifest from './manifest.json' with { type: 'json' };
import qwenCache from './cache/qwen25-0.5b.json' with { type: 'json' };
import { decodeArgs, smallTokenizer } from './internals.js';

const caches = {
  'Qwen/Qwen2.5-0.5B-Instruct': qwenCache,
};

export const tool: CodecTool = {
  manifest,

  async handle(call: CodecToolCall): Promise<CodecToolResult> {
    const args = decodeArgs(call.argumentIds);             // decode once
    const now = new Date();

    const binding = findBinding(manifest, call.modelId);
    if (!binding) {
      // No cache for this model — fall back to text mode.
      return textResult(call.callId,
        `The current time is ${now.toISOString()} UTC.`);
    }

    const cache = caches[call.modelId as keyof typeof caches];
    if (!verifyCache(cache, binding.tokenizerHash)) {
      return errorResult(call.callId,
        'Stale cache; rebuild against current tokenizer.', 'E_STALE');
    }

    if (args.format === 'iso') {
      // Hot path: concat cached prefix + freshly-tokenized timestamp + cached suffix.
      const prefix = (cache.fragments['iso-prefix'] as { ids: number[] }).ids;
      const suffix = (cache.fragments['iso-suffix'] as { ids: number[] }).ids;
      const dynamic = smallTokenizer.encode(now.toISOString());
      return tokensResult(call.callId, [...prefix, ...dynamic, ...suffix]);
    }

    if (args.format === 'human') {
      const tpl = cache.fragments['human-template'] as { kind: 'template'; parts: ({ ids: number[] } | { slot: string })[] };
      const ids = renderTemplate(tpl, {
        hours:   String(now.getUTCHours()).padStart(2, '0'),
        minutes: String(now.getUTCMinutes()).padStart(2, '0'),
        day:     now.toLocaleDateString('en', { weekday: 'long' }),
      }, smallTokenizer);
      return tokensResult(call.callId, ids);
    }

    return errorResult(call.callId, 'Unknown format.', 'E_BAD_ARG');
  },
};
```

## API

### Manifest

| Export | Purpose |
|---|---|
| `ToolManifest` | The contract published alongside every tool. Schema version 1. |
| `validateManifest(unknown)` | Returns `null` if valid, or an error string. |
| `findBinding(manifest, modelId)` | Returns the per-model binding or `null`. |

### Tool runtime

| Export | Purpose |
|---|---|
| `CodecTool` | The interface every bolt-on implements. |
| `CodecToolCall` | Wire shape from gateway → tool. Carries argument token IDs. |
| `CodecToolResult` | Discriminated union: `tokens` (fast path), `text` (fallback), `error`. |
| `tokensResult(callId, ids)` | Build a token-mode result. |
| `textResult(callId, text)` | Build a text-fallback result. |
| `errorResult(callId, message, code?)` | Build an error result. |

### Build-time precache

| Export | Purpose |
|---|---|
| `Tokenizer` | Minimal interface — bring your own (HF, tiktoken, sentencepiece, codecai BPE). |
| `Fragment` | Either `static` (literal text) or `template` (with `{slot}` markers). |
| `precache({ fragments, tokenizer })` | Compile fragment list to a per-model cache. |
| `renderTemplate(entry, slots, tokenizer)` | Runtime fill of a template; only slot values are tokenized. |
| `verifyCache(cache, expectedHash)` | Detect stale caches at cold-start. |

## How a gateway uses this

A Codec-aware gateway (codec-sglang, codec-vllm, codec-llamacpp, codec-metamcp) registers a tool by reading its manifest. The gateway:

1. **Advertises the tool's `argumentsSchema`** to the model in whatever way it normally does (system prompt, tool catalog, etc.).
2. **Detects tool calls** with the in-stream ToolWatcher (uint32 compare on token IDs — see [tool-calling docs](https://codecai.net/docs/tool-calling/)).
3. **Routes the raw argument token IDs** to the tool over MCP-style HTTP/IPC, with the active `modelId` in the call envelope.
4. **Reinjects the response token IDs** into the generation context. If the tool returned `text` instead, the gateway tokenizes it itself first.

The gateway never needs to know what fragments a tool emits. The tool never needs to know what gateway it's running behind. The model only sees tokens.

## Why pre-caching matters

Real-world tools have heavy template repetition. A typical date/time tool's response is 95% literal ("The current time is ", " UTC.", " on ") and 5% dynamic (digits, day name). A search tool's response is heavy on punctuation, URL prefixes, and category labels. A weather tool emits the same units strings on every call.

Build-time tokenization moves all of that off the hot path. At runtime the tool tokenizes only the truly dynamic parts — usually just digits or single short words — and concatenates with the cached IDs. CPU per call drops from "BPE on N hundred bytes" to "memcpy of N hundred bytes."

The architectural payoff: at gateway scale (thousands of concurrent agent sessions), this is what makes the difference between needing a tokenization sidecar and not.

## License

MIT.
