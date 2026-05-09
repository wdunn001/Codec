# SUMMARY — MCP wire bench against codec-metamcp v0.3.0

**Run**: `2026-05-09T09-26-54Z`
**Engine**: `wdunn001/codec-metamcp:v0.3.0` (commit
[`9f69e57`](https://github.com/wdunn001/codec-supervisor/commit/9f69e57)
on the supervisor — the v0.3 cut that ships the MCP-shaped zstd dict and
the leaf-mode bypass log paths)
**Lab**: `vinez@192.168.1.88` (2× RTX 3090 + Docker 27.5)
**Endpoint**: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
**Tools in namespace**: 38 (Playwright × 32 + Calculator + Sequential-Thinking
+ Time × 2 + YouTube-Transcripts + Memory)
**Vocab map**: `qwen2` (sha256:`9db56ff6`) via jsDelivr

## Headline (`tools/list`, 38 tools)

The headline cell — `tools/list` against a 38-tool namespace is where
real MCP wire weight lives. Numbers below are the response-bytes ratio
vs the `json` baseline:

| Variant                  | Wire bytes | vs `json` | Notes                                                   |
|--------------------------|-----------:|----------:|---------------------------------------------------------|
| `json`                   |    20.7 KB |      1.0× | SDK default — what every MCP client emits today         |
| `msgpack-resp`           |    18.5 KB |      1.1× | Cheapest opt-in (request stays JSON, response Codec)    |
| `msgpack-both`           |    18.5 KB |      1.1× | Symmetric Codec (no compression yet)                    |
| `msgpack-both+gzip`      |     5.7 KB |  **3.6×** | Production-shape lane                                   |
| `msgpack-both+gzip+map`  |     5.7 KB |  **3.6×** | Same — leaf-mode bypass not yet active (see below)      |

**3.6× wire reduction** on the canonical MCP enumeration call vs vanilla
JSON-RPC. Same 38 tools, same payload shape, gzip on top of msgpack
framing.

## Leaf-mode bypass (variant 5) — known caveat

Variant 5 (`msgpack-both+gzip+map`) is the deep-compression lane. It
sends the `X-Codec-Map` header and expects downstream MCP servers in
the namespace to emit `_codec_meta` blocks alongside their text content.
The gateway then forwards token IDs verbatim and the
`[Codec][leaf]` log fires.

**This run does not exercise leaf-mode** — the `openwebui-api`
namespace's 38 tools are all standard (non-Codec-aware) MCP servers
running plain `mcp-server-time`, `mcp-server-playwright`, etc. So
variant 5 falls back to gateway-side tokenization (the `[Codec][shim]`
path) and the wire bytes match variant 4 + the `X-Codec-Map` header
overhead (~162 B in the request).

To exercise leaf-mode, drop `wdunn001/codec-time-leaf:v0.3.0` (built
on this lab box; 321 MB) into a metamcp namespace as a stdio MCP
server. The follow-up run will show variant 5's separation from
variant 4 — the prior commit-message claim of ~4.7× over JSON+gzip on
real MCP traffic comes from the dict-zstd training holdout, not from
this end-to-end bench yet.

## Per-tool wire reduction (representative)

Smaller request/responses dominated by tool-call payloads:

| Tool                                        | json | msgpack-both+gzip | reduction |
|---------------------------------------------|-----:|------------------:|----------:|
| `Calculator__calculate`                     |  822 B |    811 B           |  ~1.0×    |
| `Sequential-Thinking__sequentialthinking`   | 1012 B |    878 B           |  ~1.2×    |
| `Time__get_current_time`                    |  864 B |    838 B           |  ~1.0×    |
| `Time__convert_time`                        |  864 B |    840 B           |  ~1.0×    |
| `Playwright__playwright_resize`             |  1.8 KB |   1.0 KB           |  **1.8×** |

Small payloads (<1 KB) don't benefit much from gzip — that's
expected; gzip's table needs entropy to compress. The leaf-mode
bypass is the unlock for those: `_codec_meta` is fixed-cost, so a
1 KB JSON tool result compresses to ~50 B once the gateway sees the
pre-tokenized IDs. The bigger the namespace's tool registry, the
bigger the win on `tools/list`; the more text-heavy the tool result,
the bigger the win per `tools/call`.

## Methodology fingerprint

- HTTP request + response bytes counted at the raw socket (no
  Content-Encoding decompression). See
  [`packages/bench/methodology/SCHEMA.md`](../../methodology/SCHEMA.md)
  §"MCP-live methodology (v0.3+)" for the variant matrix
  normative definition.
- 2 reps per (variant, method); median reported.
- TTFB measured from request POST to first response body byte
  (canonical SCHEMA-v1 reading).
- Each `tools/call` cell exercises the matching tool with empty/minimal
  args; the response carries whatever the tool ships back (often a
  stock 3.6 s timeout for Playwright start-style calls — that's the
  tool, not the gateway).

## What ships next

1. **Add codec-time-leaf to a metamcp namespace** to exercise the
   leaf-mode bypass and quantify variant-5 vs variant-4 separation.
2. **Add a `msgpack-both+zstd` variant** to the bench so the
   MCP-shaped zstd dict (mounted at `/opt/codec/dicts/mcp-msgpack-v1.dict`,
   sha256:`ecc9410a…`) is exercised. Today's bench only asks for
   gzip on the wire; the zstd dict is loaded but unreached.
3. **Latent bench** — `wdunn001/codec-diffusers:v0.3.0` and
   `wdunn001/codec-comfyui:v0.3.0` are building on this lab as of
   this commit; once they're up the latent-live harness fires.
