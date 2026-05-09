# @codec/bench

No-bullshit benchmarks for the Codec binary transport protocol.

📊 **Latest aggregated results: [`RESULTS.md`](RESULTS.md)** — full A/B numbers from a live sglang server with Codec PRs #24483 + #24557, polyglot interop across 4 client implementations, end-to-end agent loops with SearXNG and MetaMCP.

Three independent measurements, each runnable in isolation:

| Bench | What it measures | Needs network? |
|-------|------------------|----------------|
| `wire` | Pure encode/decode cost per token across JSON-SSE, msgpack, protobuf, raw (sweeps 256/1024/4096 tokens) | No |
| `handoff` | Agent-to-agent round-trip: text path vs Codec path | No |
| `compression` | Compression scaling sweep: each encoder × {identity, gzip, br, zstd} at small/medium/large | No |
| `live` | Real wire bytes against a streaming OpenAI-compatible endpoint (set `BENCH_SWEEP=1` for sizes) | Yes |
| `mcp:live` (v0.3) | 5-variant MCP wire matrix against a live MetaMCP gateway: `json` → `msgpack-resp` → `msgpack-both` → `+gzip` → `+gzip+map` (the leaf-mode bypass with [`codec-time-leaf`](https://hub.docker.com/r/wdunn001/codec-time-leaf) in-namespace) | Yes |
| `latent:live` (v0.3) | Latent-modality wire matrix against [`codec-comfyui`](https://hub.docker.com/r/wdunn001/codec-comfyui) / [`codec-diffusers`](https://hub.docker.com/r/wdunn001/codec-diffusers): per-(format, encoding, pipeline, fixture) cells. **Live as of 2026-05-09** — first end-to-end run validates pipeline math byte-for-byte (results: [`results/2026-05-09T13-01-55Z/latent/`](results/2026-05-09T13-01-55Z/latent/)). | Yes |

The methodology spec — including the v0.3 negotiation-headers requirements (Codec-Tokenizer-Map / Codec-Latent-Map / Codec-Zstd-Dict) and the MCP-live + latent-modality result-row schemas — lives in [`methodology/SCHEMA.md`](methodology/SCHEMA.md).

### v0.3.x lab results (committed)

| Run | Pathway | Headline |
|---|---|---|
| [`2026-05-09T09-26-54Z/mcp/`](results/2026-05-09T09-26-54Z/mcp/) | MCP, baseline | `tools/list` 38 tools: **3.6×** (msgpack-both+gzip vs JSON) |
| [`2026-05-09T11-10-48Z/mcp/`](results/2026-05-09T11-10-48Z/mcp/) | MCP, validator-fix | First codec-time-leaf integration; bug discovery (CodecAwareCallToolResultSchema) |
| [`2026-05-09T12-17-48Z/mcp/`](results/2026-05-09T12-17-48Z/mcp/) | MCP, leaf-mode bypass | `[Codec][leaf]` log fires end-to-end on real lab traffic |
| [`2026-05-09T13-01-55Z/latent/`](results/2026-05-09T13-01-55Z/latent/) | Latent, first run | Pipeline math validates byte-for-byte; int4 = **3.9×** vs raw on 512×512 |

Plus full agent-loop benches (prompt → tool call → dispatch → final answer) live under `packages/demo-python` — see [`RESULTS.md`](RESULTS.md) §4–§6 for numbers.

## Run

From the repo root:

```bash
npm run bench               # all three
npm run bench:wire          # encoder microbench (deterministic, ~5s)
npm run bench:handoff       # round-trip cost (deterministic, ~5s)
npm run bench:compression   # compression scaling sweep (deterministic, ~5s)
npm run bench:live          # against a live server
BENCH_SWEEP=1 npm run bench:live   # sweep small/medium/large on a live server
```

The live bench targets `http://192.168.1.88:11434` (Ollama) by default. Override:

```bash
BENCH_URL=http://localhost:8000 \
BENCH_MODEL=llama3.1:8b \
BENCH_PROMPT="..." \
BENCH_MAX_TOKENS=512 \
  npm run bench:live
```

If the server is unreachable, `bench:live` exits with a skip notice rather than failing.

## What the numbers mean

- **wire**: bytes-on-wire per token, encode/decode CPU per chunk. The headline number is `vs json-sse` — how much smaller each Codec mode is than the JSON-SSE incumbent.
- **handoff**: shows the cost of detokenize+JSON+tokenize round trip every agent-to-agent call pays today. Tokenization is modeled as a hash lookup, which is a *lower bound* on real BPE cost — the gap is wider in production.
- **live**: measures the real JSON-SSE wire cost from a server you point it at, then projects what the same response would cost over Codec frames using the actual token count.

## What it doesn't claim

- TTFT and tokens/sec are model-bound; Codec doesn't change them on a single connection.
- The Codec wire-cost advantage shows up at (a) gateway/proxy per-byte cost, (b) concurrent-session memory, (c) agent handoffs where the text round-trip is waste. The benches measure (a) and (c) directly; (b) is left for a future load test.
