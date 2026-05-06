# @codec/bench

No-bullshit benchmarks for the Codec binary transport protocol.

📊 **Latest aggregated results: [`RESULTS.md`](RESULTS.md)** — full A/B numbers from a live sglang server with Codec PRs #24483 + #24557, polyglot interop across 4 client implementations, end-to-end agent loops with SearXNG and MetaMCP.

Three independent measurements, each runnable in isolation:

| Bench | What it measures | Needs network? |
|-------|------------------|----------------|
| `wire` | Pure encode/decode cost per token across JSON-SSE, msgpack, protobuf, raw | No |
| `handoff` | Agent-to-agent round-trip: text path vs Codec path | No |
| `live` | Real wire bytes against a streaming OpenAI-compatible endpoint | Yes |

Plus full agent-loop benches (prompt → tool call → dispatch → final answer) live under `packages/demo-python` — see [`RESULTS.md`](RESULTS.md) §4–§6 for numbers.

## Run

From the repo root:

```bash
npm run bench           # all three
npm run bench:wire      # encoder microbench (deterministic, ~5s)
npm run bench:handoff   # round-trip cost (deterministic, ~5s)
npm run bench:live      # against a live server
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
