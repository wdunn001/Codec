# SUMMARY: `[Codec][leaf]` fires; v0.3.2 closes the leaf-mode loop

**Run**: `2026-05-09T12-17-48Z`
**Engine**: `wdunn001/codec-metamcp:v0.3.2` (per-block `_meta` detector: metamcp@0634f90)
**Tool**: `wdunn001/codec-time-leaf:v0.3.2` (per-block `_meta` writer: Codec@0a658bb)
**Lab**: `vinez@192.168.1.88` (2× RTX 3090, Docker 27.5)
**Endpoint**: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
**Bridge**: `mcp-proxy@6.4.6` wrapping codec-time-leaf
**Vocab map**: `qwen2` (sha256:`9db56ff6`)

## Headline: leaf-mode bypass observable end-to-end

The `[Codec][leaf]` log fired for the first time end-to-end through real MCP traffic:

```
[INFO] [Codec][leaf] downstream tool returned pre-tokenized result for vocab sha256:9db56ff6…: gateway shim bypassed. (spec/PROTOCOL.md § Tool-call calling conventions in the map)
```

This is the architectural target the v0.3 leaf-mode contract was designed to demonstrate. The codec-time-leaf MCP server pre-tokenized its result against the qwen2 vocab; the codec-metamcp gateway recognized the per-block `_meta['ai.codec/leaf-tokenization']` payload and bypassed its tokenization shim: the gateway became a transparent ID pipe for the hop.

## Wire numbers (post-shape-change)

The wire-shape change in v0.3.2 (per-block `_meta` instead of sibling content block) also collapsed the JSON baseline by **~4.6×** vs the v0.3.1 numbers: the per-block representation has dramatically less structural overhead than the sibling-block form had:

| Workload                                 | json (v0.3.2) | json (v0.3.1, prior) |
|------------------------------------------|--------------:|---------------------:|
| `codec-time-leaf__get_current_time`      |      **990 B** |              4.6 KB  |
| `codec-time-leaf__convert_time`          |      **1.0 KB**|              4.6 KB  |

Across the 5-variant matrix on a Codec-aware tool call:

| Variant                  | get_current_time | convert_time |
|--------------------------|-----------------:|-------------:|
| `json`                   |            990 B |       1.0 KB |
| `msgpack-resp`           |            883 B |        935 B |
| `msgpack-both`           |            883 B |        935 B |
| `msgpack-both+gzip`      |            931 B |        972 B |
| `msgpack-both+gzip+map`  |            931 B |        972 B |

Note the wire bytes between variant 4 (`+gzip`) and variant 5 (`+gzip+map`, leaf-bypass-eligible) are now **identical** but for different reasons:
- Variant 4: gateway runs the shim, tokenizes the text itself → emits IDs in a meta block → gzip compresses the full result.
- Variant 5: gateway sees the leaf's `_meta` payload → forwards it verbatim → gzip compresses the same content.

Both produce the same final bytes; the difference is **CPU on the gateway** (variant 4 runs a tokenizer; variant 5 doesn't). Wire-bytes are NOT the right metric to separate them; the `[Codec][leaf]` vs `[Codec][shim]` log line is.

`tools/list` (40 tools) holds at **3.6×** wire reduction (5.9 KB vs 21.4 KB JSON): same as prior runs.

## What v0.3.2 ships

The leaf-mode story closes end-to-end with two coordinated changes:

1. **`@codecai/mcp-leaf` v0.3.2**: `wrapToolCall` now annotates each text block with a per-block `_meta['ai.codec/leaf-tokenization']` payload instead of pushing a sibling `_codec_meta` content block. The MCP SDK's `TextContentSchema._meta` slot is a first-class spec field; the previous sibling-block form crashed the SDK's discriminated-union validator on the SERVER side with `MCP error -32602` before the result ever left the time-leaf process.

2. **`codec-metamcp` v0.3.2**: `hasExistingCodecMeta` now checks both shapes (per-block `_meta` first, legacy sibling-block as fallback). Combined with v0.3.1's `CodecAwareCallToolResultSchema`, the gateway accepts and bypasses leaf-mode results cleanly.

Back-compat: the reader-side helpers in `@codecai/mcp-leaf` recognize both wire shapes; results emitted by older Codec-aware tools (none in production, but possible during the v0.3.0/v0.3.1 window) still parse cleanly.

## Methodology

Same as the prior 2026-05-09T*/mcp/ runs:
- HTTP request + response bytes counted at the raw socket
- 2 reps per (variant, method); median reported
- TTFB measured to first response body byte
- Per `packages/bench/methodology/SCHEMA.md` §"MCP-live methodology (v0.3+)"

## Status of the v0.3 release

- ✅ Spec
- ✅ Polyglot client parity (5 langs)
- ✅ Engine fork CI workflow + `:v0.3.x` images on lab
- ✅ Website + What's New + RSS + protocol-map
- ✅ Bench methodology
- ✅ MCP bench: text matrix (18×) + tools/list (3.6×) + leaf-mode bypass (`[Codec][leaf]` observed)
- 🟡 Latent bench: codec-comfyui + codec-diffusers building on lab (pip-fix landed; ~30+ min build)
- ✅ Visual diagram
- ✅ READMEs synced
- 🟡 npm publish for `@codecai/codec-time-leaf` v0.3.2: pending
- 🟡 GitHub Releases for v0.3.0 / v0.3.1 / v0.3.2: pending
