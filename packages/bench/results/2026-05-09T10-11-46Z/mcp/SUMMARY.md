# SUMMARY: MCP wire bench against codec-metamcp v0.3.0 + codec-time-leaf

**Run**: `2026-05-09T10-11-46Z`
**Engine**: `wdunn001/codec-metamcp:v0.3.0` (MCP zstd dict mounted)
**Lab**: `vinez@192.168.1.88` (2× RTX 3090, Docker 27.5)
**Endpoint**: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
**Namespace**: 7 MCP servers: original 6 (Time / Calculator / Playwright / Sequential-Thinking / YouTube-Transcripts / Memory) **+ `codec-time-leaf` (the Codec-aware reference server)**
**Bridge**: `wdunn001/codec-time-leaf:v0.3.0` exposed via `mcp-proxy` SSE bridge at `codec-time-leaf-bridge:9001/sse` on the lab's docker network
**Vocab map**: `qwen2` (sha256:`9db56ff6`)

## Headline (`tools/list`, 38 + 2 = 40 tools)

| Variant                  | Wire bytes | vs `json` |
|--------------------------|-----------:|----------:|
| `json`                   |    21.4 KB |      1.0× |
| `msgpack-resp`           |    19.0 KB |      1.1× |
| `msgpack-both`           |    19.0 KB |      1.1× |
| `msgpack-both+gzip`      |     5.9 KB |  **3.6×** |
| `msgpack-both+gzip+map`  |     5.9 KB |  **3.6×** |

Same 3.6× win as the prior namespace (38 tools); time-leaf adds ~700 B
to the list but compresses identically. Variants 4 and 5 collapse to
the same number on `tools/list` because that endpoint is purely a
metamcp-internal dispatcher response: no downstream `_codec_meta`
blocks to short-circuit.

## End-to-end integration milestone

This run is the first time `codec-time-leaf` and `codec-metamcp` ran
end-to-end on the same lab box and serviced a real MCP client (the bench).
The plumbing path validates:

1. ✅ `wdunn001/codec-time-leaf:v0.3.0` runs as a stdio MCP server (via
   `node /opt/codec/packages/mcp-leaf/examples/time-server/dist/index.js`).
2. ✅ `mcp-proxy` SSE bridge wraps stdio for metamcp's SSE transport
   (supergateway crash-loops on metamcp's concurrent connections;
   `mcp-proxy@6.4.6` handles them).
3. ✅ `codec-metamcp:v0.3.0` enumerates the bridge's tools
   (`codec-time-leaf__get_current_time`, `codec-time-leaf__convert_time`)
   in `tools/list`.
4. ✅ Bench harness can hit `tools/call` against codec-time-leaf via
   the gateway and receive a wrapped JSON-RPC response.

## ⚠️ Bug discovered: validator-before-bypass

The codec-time-leaf `tools/call` cells in the wire matrix
(`codec-time-leaf__get_current_time`, `codec-time-leaf__convert_time`)
SHOW HTTP 200 OK, but the JSON-RPC envelope inside is an MCP error:

```
McpError: MCP error -32602: Invalid tools/call result: …
```

`codec-time-leaf` correctly emits `_codec_meta` blocks alongside the
original `text` blocks (per the v0.3 leaf-mode contract in
spec/PROTOCOL.md). But codec-metamcp's MCP SDK validator runs
**before** the leaf-mode bypass shim in
[codec-content.ts](https://github.com/wdunn001/metamcp/blob/feat/codec-binary-transport/),
and rejects any content block whose `type` isn't in the SDK's closed
union (`text | image | audio | resource`). `_codec_meta` is not in
that union, so the validator throws a `-32602 Invalid tools/call result`
*before* the bypass code path runs.

Net effect on this bench:
- The 4.6 KB response shown for `codec-time-leaf__get_current_time`
  under `json` is the **error envelope**, not a real tool result.
- The 1.1 KB compressed response under `msgpack-both+gzip+map` (variant 5)
  is the **same error envelope, gzipped**: which still compresses to
  4.2× over the JSON form, but doesn't quantify the leaf-mode bypass.

The bug is in codec-metamcp's CallToolResult validation order. The
[`@codecai/mcp-leaf`](../../mcp-leaf/) writer-side helper is correct;
codec-time-leaf is correct; the gateway needs to either:
- (a) Permit `_codec_meta` in the SDK's content-block union (extend
  the validator), or
- (b) Pre-process the result tree to lift `_codec_meta` blocks out
  before the validator sees them.

Tracked as the Phase 6 follow-up against the codec-metamcp fork.

## What this run does demonstrate (truthfully)

- v0.3.0 metamcp + the MCP zstd dict load cleanly; no regression on
  the 38 baseline tools.
- The `tools/list` 3.6× win is reproducible against the augmented namespace.
- The codec-time-leaf integration plumbing is end-to-end live:
  what's blocking the leaf-mode wire-bytes number is the gateway-side
  validation order bug above, not the leaf-mode contract itself.
- The `[Codec][shim]` and `[Codec][leaf]` log paths in metamcp v0.3.0
  exist (we saw `[Codec][shim]` fire on the prior run when there were
  no Codec-aware servers); fixing the validator order will surface
  `[Codec][leaf]` log lines on the codec-time-leaf cells.

## Methodology fingerprint

Same as `2026-05-09T09-26-54Z/mcp/SUMMARY.md`:
- HTTP request + response bytes counted at the raw socket
- 2 reps per (variant, method); median reported
- TTFB measured to first response body byte
- 5 variants × 8 method groups; per spec/PROTOCOL.md and
  `packages/bench/methodology/SCHEMA.md` §"MCP-live methodology (v0.3+)"

## Next concrete step

Fix codec-metamcp's CallToolResult validation order so `_codec_meta`
blocks pass through the gateway. Then re-run this bench: the
codec-time-leaf cells will show real tool results (not error envelopes)
and variant 5 will quantify the leaf-mode bypass against variant 4
end-to-end. That's the headline number we set out to measure.
