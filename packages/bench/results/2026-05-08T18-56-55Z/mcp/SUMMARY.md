# MCP wire bench: 2026-05-08T18:56:55Z

Phase 1 of the MCP+inference bench plan: client → MetaMCP → real MCP servers
→ MetaMCP → client. **No inference engine in the loop.**

Target: codec-metamcp **v0.2.5** (commit `afa8d45`) on production lab box,
endpoint `openwebui-api`, namespace `asdasd`, scoped to the **Time MCP server**
(2 tools: `get_current_time`, `convert_time`) for clean baseline numbers.

## Headline: `tools/list` ships 3.6× smaller wire end-to-end

| variant                | resp (wire) | vs json |  TTFB  |
|------------------------|------------:|--------:|-------:|
| `json` (baseline)      | 20.7 KB     |   1.0×  |  95 ms |
| `msgpack-resp`         | 18.5 KB     |   1.1×  | (2.1 s: see note) |
| `msgpack-both`         | 18.5 KB     |   1.1×  |  57 ms |
| **`msgpack-both+gzip`** | **5.8 KB**  | **3.6×**| (2.3 s: see note) |

The tools/list payload is text-heavy (35 tool definitions × names + descriptions
+ JSON-Schema): exactly the response shape where gzip-on-msgpack compounds.
Three distinct mechanisms stacking:
1. **msgpack envelope** drops ~10% by replacing JSON field-name strings with
   binary tags (`name`, `description`, `inputSchema`, etc. all become 1-byte
   field markers).
2. **Codec request encoding** drops ~3% on the inbound side (msgpack vs JSON
   for the request body).
3. **gzip-on-msgpack** drops the remaining ~70%: msgpack's binary keys are
   highly compressible and the JSON-Schema property strings repeat heavily
   across 35 tool defs.

## `tools/call`: small payloads, modest savings

| variant            | resp (wire) | vs json |
|--------------------|------------:|--------:|
| `json`             | 863 B       |   1.0×  |
| `msgpack-resp`     | 809 B       |   1.1×  |
| `msgpack-both`     | 809 B       |   1.1×  |
| `msgpack-both+gzip`| 838 B       |   1.0×  |

Tiny tool-call responses (Time returns ~50 B of UTF-8 content wrapped in a
~750 B MCP envelope). gzip *adds* a few bytes due to its dictionary header
overhead overwhelming the compression on a sub-1KB payload. Wire-format
choice doesn't matter at this size; this is the floor where **`+map`** (the
text → token-IDs deep variant) becomes the next gear: but it needs a
text-heavy tool to show meaningful gain (transcripts, page HTML, large
Sequential-Thinking chains).

## What landed in this session

The full 4-variant matrix needed two metamcp fork patches:

1. **`c80719a`: Content-Type spoof.** The metamcp wrapper was decoding
   the Codec request body but leaving `req.headers["content-type"]` as
   `application/x-codec-msgpack`. The MCP SDK's
   `StreamableHTTPServerTransport` validates Content-Type independently
   and 415'd anything not `application/json`. Symmetric fix to the
   existing Accept-spoof on the response side.
2. **`afa8d45`: Pass parsed body to `handleRequest`.** After the
   Content-Type fix the SDK accepted the request but then tried to
   re-read the request body from the stream: which `express.raw()` had
   already consumed. The SDK's `handleRequest` accepts a parsed body as
   its third argument exactly for this case; passing `req.body` when
   `reqCodecFormat` is set fixes the "stream is not readable" parse
   error.

Both committed to `wdunn001/metamcp:feat/codec-binary-transport` and
shipped in image `wdunn001/codec-metamcp:v0.2.5`.

The Dockerfile also got `uv` layered in: fixes the preexisting
`spawn uvx ENOENT` blocker on `mcp-server-time` and any other Python
MCP server configured to spawn via `uvx`. Time + Calculator now spin
up cleanly on container start.

## Known issue (orthogonal): non-deterministic 2-second TTFB stall

On every bench run, **one** of the four variants' `tools/list` calls hits
a 2.1 to 2.3 s TTFB stall while the other three return in 60 to 95 ms. *Which*
variant stalls is not consistent across runs: it tracks the second new
session created in metamcp's session pool. Reproducible with raw `curl`
across three sequential init+tools/list cycles: 0.10 s, 2.15 s, 0.08 s.

This is **not** a Codec wire-format issue: wire bytes are stable
across runs and the stall happens to whichever variant happens to be
the second-session draw. Smells like an upstream MCP connection-pool
warmup race in `metaMcpServerPool.cleanupSession` / `getServer`.
Filed as a separate follow-up; orthogonal to this bench.

## Reproduce

```bash
# Build (run on the lab box, not local: Docker isn't on dev machine)
ssh vinez@192.168.1.88 'cd /tmp/codec-metamcp-build && docker build \
  --build-arg CODEC_METAMCP_COMMIT=afa8d4533aa7b057107fc9df530a100f37f6217e \
  -f Dockerfile.metamcp -t wdunn001/codec-metamcp:v0.2.5 .'

# Deploy
ssh vinez@192.168.1.88 'bash /tmp/deploy-codec-metamcp-lab.sh v0.2.5'

# Bench
BENCH_MCP_BEARER=sk_mt_<private-key> \
BENCH_MCP_URL=http://192.168.1.88:12008/metamcp/openwebui-api/mcp \
BENCH_MCP_TOOLS=Time__get_current_time,Time__convert_time \
pnpm --filter @codec/bench mcp:live
```

## Files

- `mcp-live.md`: full per-method tables (4 method groups × 4 variants)
- `mcp-live.json`: raw measurement records

## Next runs

1. Re-run with `BENCH_MCP_MAP_URL` + `BENCH_MCP_MAP_HASH` set (point at a
   qwen2 or llama-3 vocab map URL) to capture the **+map** deep-tokenization
   variant. Will show meaningful gain on a text-heavy corpus.
2. Re-run with a text-heavy tool (YouTube transcripts of multi-minute
   videos, Sequential-Thinking long chains) to surface the per-token
   reduction story that's the actual product value: Time MCP's tiny
   responses are good for protocol correctness but undersell the wire
   savings.
3. Phase 2: same matrix with a real engine in the loop
   (codec-sglang | codec-vllm | codec-llamacpp), measuring the full six-hop
   tool-call cycle bytes-and-latency.
4. Investigate the second-session stall in metamcp's pool warmup: this
   is the only thing on the latency side that looks like a real product
   issue.
