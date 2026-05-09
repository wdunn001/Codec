# `@codecai/mcp-leaf-example-time` — reference Codec-aware MCP server

The minimum viable Codec-aware MCP server. Demonstrates the leaf-mode contract from [`spec/PROTOCOL.md`](../../../../spec/PROTOCOL.md) §"Tool-call calling conventions in the map" with two trivially-implementable tools (`get_current_time`, `convert_time`).

## What it does

Runs as a standard MCP server over stdio. Exposes two tools. **Wraps every tool result with `_codec_meta` siblings via `@codecai/mcp-leaf`** so a Codec-aware gateway (metamcp at `feat/codec-binary-transport` ≥ commit `6632f17`) detects the pre-tokenized output and skips its back-compat shim.

The graduation is invisible to clients that don't understand `_codec_meta` — they see the original `text` block exactly as before. Drop this server alongside any other MCP server in a metamcp namespace and the gateway handles both legacy + leaf-mode tools transparently.

## Run it

```bash
npm install
npm run build

# Without leaf-mode — server runs, gateway shim handles tokenization:
codec-time-leaf

# With leaf-mode — server emits _codec_meta, gateway bypass kicks in:
CODEC_MAP_URL=https://cdn.jsdelivr.net/gh/wdunn001/codec-maps@main/maps/qwen/qwen2.json \
CODEC_MAP_HASH=sha256:887311099cdc09e7022001a01fa1da396750d669b7ed2c242a000b9badd09791 \
codec-time-leaf
```

Wire it into an MCP client (Claude Desktop, Continue, the metamcp gateway as an upstream):

```jsonc
// claude_desktop_config.json or equivalent
{
  "mcpServers": {
    "time-leaf": {
      "command": "codec-time-leaf",
      "env": {
        "CODEC_MAP_URL": "https://cdn.jsdelivr.net/gh/wdunn001/codec-maps@main/maps/qwen/qwen2.json",
        "CODEC_MAP_HASH": "sha256:887311099cdc09e7022001a01fa1da396750d669b7ed2c242a000b9badd09791"
      }
    }
  }
}
```

## What you should see in the gateway logs

After this server starts emitting wrapped results, `metamcp` (running v0.2.8 or later) emits a one-time INFO log per `(vocab, process-lifetime)` pair the first time it observes a leaf-mode result:

```
[Codec][leaf] downstream tool returned pre-tokenized result for vocab
  887311099cdc… — gateway shim bypassed.
```

Versus the pre-leaf-mode path which logs WARN:

```
[Codec][shim] tokenizing tool result for vocab 887311099cdc… —
  leaf-mode MCP server would skip this.
```

Operators dashboarding the gateway watch the `leafBypasses` counter (exposed via `getShimMetrics()`) grow over time as more tools graduate.

## What's in the code

```
src/index.ts     ~150 lines
  ├ Tool implementations (get_current_time, convert_time)
  ├ MetaTokenizer load (lazy, env-var-driven, graceful fallback)
  └ wrapToolCall on every CallToolResult → _codec_meta sibling per text block
```

The pattern is the same for any MCP server that wants to graduate. Two function calls:

1. `await makeMetaTokenizer({ mapUrl, mapHash })` — once at startup
2. `wrapToolCall(result, meta)` — on every result before returning

That's the whole contract.

## Comparison: a non-Codec-aware Time server

```ts
// Before — non-Codec-aware:
return { content: [{ type: 'text', text: 'It is 14:30 UTC' }] };

// After — Codec-aware (this server):
return wrapToolCall(
  { content: [{ type: 'text', text: 'It is 14:30 UTC' }] },
  meta,
);
// → { content: [
//     { type: 'text', text: 'It is 14:30 UTC' },
//     { type: '_codec_meta', map_id: 'sha256:…', ids: [...] }
//   ] }
```

One extra block per text content. Backward-compatible. Idempotent (wrapping twice produces the same tree).

## Build the dist

```bash
npm install
npm run build
```

`tsc` emits `dist/index.js` ready to run via `codec-time-leaf` (the `bin` entry in `package.json`).
