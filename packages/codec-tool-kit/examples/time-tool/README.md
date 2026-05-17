# codec-time-tool

Reference Codec-native bolt-on tool built on [`@codecai/tool-kit`](../../). Returns the current UTC time as **pre-cached token IDs** — the gateway memcpys the response into the model's generation context with **zero detokenize/retokenize on the hot path**.

This is the canonical demo of the precache-at-build-time pattern. Tools sit in their own repo, on their own infra, but speak token IDs natively when the model is one they've pre-built a cache for.

## What's in the box

```
.
├── manifest.json              # the tool contract (name, args schema, models)
├── scripts/build-cache.ts     # build-time cache compiler (run once, ship the result)
├── cache/                     # per-model precompiled token caches (JSON)
├── src/index.ts               # runtime: load cache, lookup fragments, return IDs
└── test/                      # cache-presence + CLI smoke tests
```

## Quick start

```bash
cd packages/codec-tool-kit/examples/time-tool

# 1. Pre-build the token cache (one model: Qwen2.5-0.5B-Instruct)
npm run build:cache

# 2. Compile the runtime
npm run build

# 3. Try it
node dist/index.js iso
# → model:       Qwen/Qwen2.5-0.5B-Instruct
# → format:      iso
# → response IDs (5): [12345, 67890, ...]
# → (would be memcpy'd into the model's generation context — no detokenize, no JSON envelope)

node dist/index.js human
# → same shape, different cached template
```

## What's happening on a call

1. The model emits `<tool_call>{"name":"get_current_time","arguments":{"format":"iso"}}</tool_call>` between its control tokens.
2. The gateway's `ToolWatcher` matches the control tokens (single 32-bit compare per token — no detokenize), extracts the argument IDs, and routes the call to this tool over the bolt-on wire.
3. This tool reads its cache, picks the `iso-line` template entry, fills the date/time slots (the only runtime tokenization — small ~15-char slot values), and returns the response IDs.
4. The gateway reinjects those IDs into the model's generation context. The model continues.

**Nowhere in this loop is a JSON envelope serialized, parsed, detokenized, or re-tokenized.** That's the whole point of the bolt-on architecture.

## What it would look like with a real tokenizer

The reference `build-cache.ts` uses a stub tokenizer to keep the example zero-dep. Replace it with the real thing:

```ts
// scripts/build-cache.ts (production)
import { precache } from '@codecai/tool-kit/precache';
import { AutoTokenizer } from '@huggingface/transformers';

const tok = await AutoTokenizer.from_pretrained('Qwen/Qwen2.5-0.5B-Instruct');
const tokenizer = {
  encode: (text: string) => tok.encode(text),
  hash: () => 'sha256:' + sha256OfTokenizerFile(),
};

const cache = precache({ fragments: [...], tokenizer });
writeFileSync('cache/qwen25-0.5b-instruct.json', JSON.stringify(cache));
```

The cache file shape is identical; only the actual ID values change.

## Why this beats in-process MCP dispatch

| Axis | In-process MCP | Bolt-on with `@codecai/tool-kit` |
|---|---|---|
| Tokenization at runtime | every call (server BPE) | **none** — pre-cached at build time |
| Tool release cadence | tied to inference server | independent — tool team owns their repo + deploy |
| Security review | shared with engine | scoped to tool |
| Cache lifetime | model-restart | tool-build-time (shipped artifact) |
| Cross-model support | engine handles all | tool manifest lists supported model bindings |
| Hot-path cost | detok + parse + dispatch + retok | hashtable lookup + memcpy |

The wire savings are the same as in-process. The latency win is one extra hop (tool ↔ gateway, typically a unix socket or LAN RTT — single-digit ms) — worth it for the operational decoupling.

## Source & links

- SDK: [`@codecai/tool-kit`](https://www.npmjs.com/package/@codecai/tool-kit)
- Companion: [`@codecai/mcp-leaf`](https://www.npmjs.com/package/@codecai/mcp-leaf) — leaf wraps existing MCP servers; tool-kit is for net-new Codec-native tools
- Bench: [agent-loop measurements](https://github.com/wdunn001/Codec/tree/main/packages/bench/results/2026-05-15T20-00-00Z/agent-loop)
- Spec: [`PROTOCOL.md` § Tool-call calling conventions](https://github.com/wdunn001/Codec/blob/main/spec/PROTOCOL.md)
