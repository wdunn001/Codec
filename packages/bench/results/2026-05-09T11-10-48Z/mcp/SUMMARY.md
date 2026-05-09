# SUMMARY — MCP wire bench against codec-metamcp v0.3.1 + validator fix

**Run**: `2026-05-09T11-10-48Z`
**Engine**: `wdunn001/codec-metamcp:v0.3.1` (validator-before-bypass fix —
metamcp@e8c3fca on the supervisor)
**Lab**: `vinez@192.168.1.88` (2× RTX 3090, Docker 27.5)
**Endpoint**: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
**Namespace**: 7 MCP servers (6 standard + `codec-time-leaf` via mcp-proxy SSE bridge)
**Bridge**: `mcp-proxy@6.4.6` wrapping `wdunn001/codec-time-leaf:v0.3.0`
**Vocab map**: `qwen2` (sha256:`9db56ff6`)

## Headline

| Variant                  | tools/list (40 tools) | codec-time-leaf__get_current_time |
|--------------------------|----------------------:|----------------------------------:|
| `json`                   |               21.4 KB |                            4.6 KB |
| `msgpack-resp`           |               19.0 KB |                            4.2 KB |
| `msgpack-both`           |               19.0 KB |                            4.2 KB |
| `msgpack-both+gzip`      |    **5.9 KB (3.6×)**  |              **1.1 KB (4.2×)**    |
| `msgpack-both+gzip+map`  |    **5.9 KB (3.6×)**  |              **1.1 KB (4.2×)**    |

`tools/list` against the augmented 40-tool namespace holds at 3.6×;
**Codec-aware tool calls (codec-time-leaf) compress 4.2×** end-to-end
through the gateway. The 4.6 KB JSON baseline includes the `_codec_meta`
sibling block the leaf-mode tool emits — gzip collapses it and the
duplicated-text/IDs encoding to 1.1 KB.

## What this run validates

✅ The codec-metamcp v0.3.1 validator fix
([metamcp@e8c3fca](https://github.com/wdunn001/metamcp/commit/e8c3fca))
unblocked the leaf-mode integration end-to-end:

- Previous (v0.3.0) cells returned `McpError -32602 Invalid tools/call result`
  envelopes because the SDK's `CompatibilityCallToolResultSchema` rejected
  the `_codec_meta` content block.
- v0.3.1 swaps that for a hand-rolled `CodecAwareCallToolResultSchema` that
  validates the envelope shape but uses `.passthrough()` per content block
  so `_codec_meta` (and any future custom content type) survives.
- All five variants now return `200 OK` on `codec-time-leaf__*` cells with
  real tool results — the bench measures the actual leaf-mode wire shape,
  not error envelopes.

✅ `codec-time-leaf` is fully wired into a metamcp namespace via the SSE
bridge (`mcp-proxy@6.4.6` — supergateway crash-loops on metamcp's concurrent
SSE reconnects). Bench discovered both `codec-time-leaf__get_current_time`
and `codec-time-leaf__convert_time` and exercised them across all 5 variants.

## ⚠️ Remaining bug: leaf-mode bypass not firing

Despite the schema fix, the gateway's `[Codec][leaf]` log never fires —
only `[Codec][shim]` does, even on variant 5. That means
`hasExistingCodecMeta()` (codec-content.ts:169) returns `false` even
though codec-time-leaf reports `[codec-time-leaf] leaf-mode enabled` at
startup and `wrapToolCall(result, leafMeta)` is in the time-server's
tools/call handler (verified in source).

Symptom on the wire: variant 4 (`+gzip`, no map header — pure shim path)
and variant 5 (`+gzip+map`, would-be leaf-bypass path) compress to
**identical 1.1 KB / 4.2× wire bytes**. If leaf-mode were firing,
variant 5 would either match variant 4 exactly (when gzip dominates)
or beat it (when the gateway can drop the redundant text). Either way
the `[Codec][leaf]` log line is the proof we want — and it's not firing.

Likely cause (not yet bisected): the result returned from
`clientForTool.client.request(...)` in `metamcp-proxy.ts:441` is
post-validation, but the per-content-block fields are processed somewhere
between the schema parse and `tokenizeContent()` invocation in
`codec-transcode.ts:322`, stripping or mutating the `_codec_meta` block.
Candidates:
- mcp-proxy SSE bridge re-marshaling (re-serializes JSON-RPC, may
  filter unknown content types)
- metamcp's middleware chain
  (`createFilterCallToolMiddleware` / `createToolOverridesCallToolMiddleware`)
  rebuilding the result without `_codec_meta`
- A second SDK validation pass on the response side (`ServerNotification`,
  `JSONRPCResponse` schemas)

Tracked as the next concrete v0.3.x patch in metamcp.

## What still ships from this run

The wire numbers above are real — they measure metamcp's behavior on
Codec-aware MCP traffic with the validator fix in place. The 4.2×
reduction on a 4.6 KB Codec-aware tool result is the production-shape
answer for "what does Codec do to MCP wire weight today" *even when the
leaf-mode bypass is dormant*. The full bypass story comes once the
second bug above lands; for now the v0.3 release ships with these
numbers as the validated end-to-end measurement.

## Methodology

- HTTP request + response bytes counted at the raw socket
- 2 reps per (variant, method); median reported
- TTFB measured to first response body byte
- Per spec/PROTOCOL.md and `packages/bench/methodology/SCHEMA.md`
  §"MCP-live methodology (v0.3+)"
