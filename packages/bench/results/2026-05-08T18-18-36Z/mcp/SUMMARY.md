# MCP wire bench — 2026-05-08T18:18:36Z (Phase 1, partial)

Phase 1 of the MCP+inference bench plan: client → MetaMCP → real downstream
MCP servers → MetaMCP → client. **No inference engine in the loop.** This
isolates the gateway+downstream cost so the engine bench (Phase 2) has a clean
baseline to subtract from.

## What ran

- Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp` (codec-metamcp v0.2.4 on production lab box)
- Endpoint: `openwebui-api` namespace `asdasd` — proxies 35 tools across three MCP servers:
  - **Playwright** (33 tools — start/end codegen sessions, navigate/click/fill/etc.)
  - **YouTube-Transcripts** (1 tool — get_transcript)
  - **Sequential-Thinking** (1 tool — sequentialthinking)
- 37 method groups: `initialize`, `tools/list`, `tools/call` ×35
- 4 variants requested per group; **2 succeeded**, **2 failed** (see "Known issues" below)

## Headline numbers (json baseline vs. msgpack-resp)

| Metric                       | JSON     | msgpack-resp | Reduction |
|------------------------------|---------:|-------------:|----------:|
| `initialize` resp wire       | 892 B    | 826 B        | 1.08×     |
| `tools/list` resp wire       | 19,813 B | 17,657 B     | 1.12×     |
| 35 `tools/call` resp wire    | 55,062 B | 52,842 B     | 1.04×     |
| `tools/call` total wall-time | 81.8 s   | 82.2 s       | ~equal    |

The wire reductions are smaller than the headline 67×–1404× we see on raw
token streams from inference engines. **This is expected at this layer:**

- MCP responses are already small JSON envelopes (~800 B–1.8 KB typical).
  msgpack saves ~10% on the envelope by replacing field-name strings with
  shorter binary tags; the JSON keys are short already (`name`, `description`,
  `content`, …) so there's not much fat to trim.
- The **deep wins live in the Codec stack we couldn't run today**:
  - **`msgpack-both + gzip`** (HTTP 415 on the running image — fixed in
    a v0.2.5 patch, queued for redeploy): adds gzip on top, which compounds
    against the larger `tools/list` payloads — projection from the wire-only
    bench suggests 5–8× on `tools/list`.
  - **`+ X-Codec-Map`** (vocab map not configured today): rewrites
    `CallToolResult.content[].text` from UTF-8 strings into Codec ID arrays.
    This is where text-heavy tool returns (YouTube transcripts, page HTML,
    long Sequential-Thinking chains) collapse to tens-of-bytes-per-token.
    Playwright's stub responses we measured today are NOT text-heavy
    (mostly small JSON like `{"isError":true,"content":[{"type":"text","text":"Browser not started"}]}`),
    so the +map win on this corpus would be modest. Re-running with a
    transcript-heavy or page-scrape-heavy tool will be the right showcase.

## Headline insight: where the wire actually doesn't matter (yet)

For 22 of the 35 Playwright tools the **server-side tool execution time
itself dominates** — 3.6–3.8 s per call (the Playwright MCP server returning
"Browser not started" after a timeout). The wire wrap cost is single-digit
ms in that picture; nobody will pick a transport based on this corpus.

The methods that DO show real wire impact:
- `tools/list` (19.8 KB, all metadata) — 1.12× reduction with msgpack alone,
  and the projected 5–8× with gzip is meaningful for clients that re-list
  on every connection.
- `tools/call` on the four `playwright_get|put|patch|delete` tools that
  actually returned ~1.4 KB JSON bodies in 70–425 ms — 1.07× reduction,
  again with gzip projected to push into 3–5×.

## Known issues

### 1. msgpack-both variants returning HTTP 415 (FIXED, redeploy pending)

The MCP SDK's `StreamableHTTPServerTransport` runs Content-Type validation
*after* the metamcp wrapper has already decoded the Codec request body.
The wrapper was spoofing `Accept` for the response side but not
`Content-Type` for the request side. Fixed in
metamcp@`c80719a` ("fix(codec): spoof Content-Type for SDK after request
decode") on `feat/codec-binary-transport`. Once
`wdunn001/codec-metamcp:v0.2.5` is built and redeployed on the lab box
(blocked on local Docker Desktop being up), the full 4-variant matrix
will run.

### 2. 2.15 s stall on the *second* sequential Codec session (server-side)

The bench saw `tools/list` under msgpack-resp take 2.42 s vs. 0.10 s for
JSON. Reproducible with raw `curl` on three sequential init+tools/list
cycles: 0.10 s, 2.15 s, 0.08 s. The pattern is **exactly the second
session** that stalls; subsequent sessions warm up.

This is **not** a wire-format issue — the server is genuinely sitting
idle for ~2 s on the second new session. Smells like an upstream MCP
connection-pool warmup race in MetaMCP itself (possibly the
`SessionLifetimeManagerImpl` waiting on `metaMcpServerPool` to spin up
new upstream connections per session). Filed as a follow-up; orthogonal
to the Codec patch path.

### 3. `X-Codec-Map` (deep tokenization) variant not run

`BENCH_MCP_MAP_URL` and `BENCH_MCP_MAP_HASH` were not configured for this
run, so the deepest-compression variant (CallToolResult content blocks
tokenized to ID arrays) was skipped. Pinning a vocab map from the
`codec-maps` repo and re-running will exercise this path.

## Files

- `mcp-live.md` — full per-method-group tables (37 groups × 4 variants)
- `mcp-live.json` — raw measurement records (for `aggregate.py` /
  `plot_*.py` integration once Phase 2 lands)

## Next runs (queued)

1. Build `wdunn001/codec-metamcp:v0.2.5` with the Content-Type fix; deploy to
   the lab box; re-run this bench to capture msgpack-both + gzip data.
2. Add `BENCH_MCP_MAP_URL` + `BENCH_MCP_MAP_HASH` from a vocab map (qwen2 or
   llama-3) and re-run to capture the `+map` deep-tokenization variant.
3. Re-run with a text-heavy corpus (YouTube transcripts of multi-minute
   videos, large Sequential-Thinking chains) to surface the per-token
   reduction that's the actual product story.
4. Phase 2: same matrix with a real engine in the loop
   (codec-sglang | codec-vllm | codec-llamacpp), measuring the full six-hop
   tool-call cycle bytes-and-latency. That run is what produces the wire-vs.-text
   comparison the protocol page actually wants.
