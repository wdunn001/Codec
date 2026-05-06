# Codec

**Token-native binary transport for AI APIs.**

AI models speak token IDs internally — 32-bit integers drawn from a fixed vocabulary. Current APIs convert those IDs to UTF-8, wrap them in JSON, and ship that over HTTPS. The wire carries 50–100 bytes per token. The model emitted a 4-byte integer.

Codec fixes the layer boundary. Token IDs stay token IDs until a human actually needs to read them.

```
Current:  model → uint32 IDs → UTF-8 → JSON/SSE → wire → JSON → UTF-8 → uint32 IDs → model
Codec:    model → uint32 IDs → binary frames → wire → uint32 IDs → model
```

---

## Structure

```
packages/
  core/       @codec/core    — binary frame encoder/decoder
  client/     @codec/client  — TypeScript client for vLLM Codec endpoints
  bench/      @codec/bench   — wire / handoff / live benchmarks
  demo/       @codec/demo    — illustrative agent-to-agent demo
spec/
  PROTOCOL.md                    wire format specification
  tokenizer-map.schema.json      JSON Schema for tokenizer map contract
```

---

## Quick start

```bash
npm install
```

### Run the benchmarks (no API keys, no server required)

```bash
npm run bench:wire      # encoder microbench (deterministic, ~5s)
npm run bench:handoff   # agent round-trip cost (deterministic, ~5s)
```

These produce the numbers below from pure code — no network, no model.

### Benchmark against a live model server

The live bench works against any OpenAI-compatible streaming endpoint. Two servers we've tested with:

```bash
# Ollama (baseline JSON-SSE measurement — unmodified server)
BENCH_URL=http://192.168.1.88:11434 BENCH_MODEL=qwen2.5:latest npm run bench:live

# vLLM with the Codec patch applied (true binary path)
# See: https://github.com/vllm-project/vllm/pull/41765
BENCH_URL=http://localhost:8000 BENCH_MODEL=meta-llama/Llama-3.1-8B npm run bench:live
```

Against Ollama (or any OpenAI-compat server), the live bench measures the real JSON-SSE wire cost and projects what Codec would cost using the actual token count.

### Run the illustrative agent demo (Anthropic API)

```bash
ANTHROPIC_API_KEY=sk-... npm run demo:agent
```

This streams from the live Anthropic API and shows what the same response would have cost over Codec frames. Kept for narrative clarity — for hard numbers, use `npm run bench`.

---

## What the benchmark shows

Wire microbench, 4,096 tokens, 1 token per chunk:

| Encoder  | Wire bytes | Bytes/token | vs JSON-SSE | Decode/chunk |
|----------|------------|-------------|-------------|--------------|
| json-sse | 616 KB     | 154.0       | 1.0×        | 2.7 µs       |
| msgpack  | 64 KB      | 16.0        | **9.6×**    | 0.8 µs       |
| protobuf | 43 KB      | 10.9        | **14.2×**   | 0.3 µs       |
| raw      | 16 KB      | 4.0         | 38.5×       | 0.2 µs       |

Live bench against Ollama `qwen2.5:7b`, 315 tokens generated:

| Encoder           | Wire bytes | Bytes/token | vs JSON-SSE |
|-------------------|------------|-------------|-------------|
| JSON-SSE measured | 58.5 KB    | 190.2       | 1.0×        |
| msgpack projected | 4.6 KB     | 15.1        | **12.6×**   |
| protobuf projected| 3.4 KB     | 11.0        | **17.3×**   |

Agent round-trip, 1,024 tokens, including detokenize+tokenize:

| Path             | Wire bytes | Total time | vs text |
|------------------|------------|------------|---------|
| text (JSON-SSE)  | 115 KB     | 11.1 ms    | 1.0×    |
| codec (msgpack)  | 16 KB      | 4.7 ms     | **2.4× faster** |
| codec (protobuf) | 11 KB      | 2.0 ms     | **5.5× faster** |

Decode CPU is also lower for binary formats: protobuf decodes in ~0.3 µs/chunk vs ~2.7 µs/chunk for JSON-SSE — a 9× reduction. See [packages/bench/README.md](packages/bench/README.md) for the full methodology.

---

## How Codec works

### 1. Session handshake

The client sends a `HELLO` frame declaring which tokenizers it can decode.  
The server responds with a `READY` frame naming the chosen tokenizer and a URL to fetch the map.

```
Client → HELLO { accept_tokenizers: ["claude-sonnet-4-6-v1"] }
Server → READY { tokenizer_id: "claude-sonnet-4-6-v1", map_url: "...", map_hash: "sha256:..." }
```

This is the same pattern as HTTP's `Content-Type: charset=`. The vocabularies stay vendor-specific; the declaration mechanism is standardised.

### 2. Token streaming

The model emits `TOKENS` frames — arrays of uint32 token IDs packed 4 bytes each, in big-endian order.

```
Frame: [1 byte type][4 bytes payload_len][N × 4 bytes token IDs]
```

No UTF-8 conversion. No JSON envelope.

### 3. Presentation layer (client-side, lazy)

When a human is going to read the output, the client looks up each token ID in the cached tokenizer map and concatenates the fragments. When the caller is another model, this step is skipped.

---

## The agent-to-agent case

Today, two AI agents talking to each other do this:

1. Agent A's model emits token IDs
2. Server converts to UTF-8, wraps in JSON
3. Text crosses the wire
4. Agent B's API ingests JSON, extracts UTF-8
5. Agent B's tokeniser converts UTF-8 back to token IDs
6. Agent B's model consumes IDs

Steps 2–5 exist for an audience of zero. In Codec, Agent A ships token IDs directly. Agent B receives token IDs. The UTF-8 round-trip never happens.

---

## Spec

[spec/PROTOCOL.md](spec/PROTOCOL.md) — wire format, frame types, session lifecycle, cross-vendor tokenizer handling, migration path.

[spec/tokenizer-map.schema.json](spec/tokenizer-map.schema.json) — JSON Schema for the tokenizer map contract.

---

## Status

The wire format, encoders, and benchmarks are real and runnable today. A reference server implementation exists as an open pull request against vLLM:

- **vLLM server** — [vllm-project/vllm#41765](https://github.com/vllm-project/vllm/pull/41765). Adds `stream_format: "msgpack"|"protobuf"` to `/v1/completions` and a dedicated bidirectional `/v1/completions/codec` endpoint. Implementation lives in `vllm/entrypoints/codec_frame.py`.
- **TypeScript client** — `@codec/client` in this repo. `stream()`, `streamFromIds()`, `agentHandoff()`. Decodes binary frames via `@msgpack/msgpack`.
- **Benchmark suite** — `@codec/bench` in this repo. Three independent measurements (wire / handoff / live), all deterministic, all reproducible.

What's been validated:

- ✅ Wire-format correctness — round-trip semantic equivalence for msgpack and protobuf, verified by the bench.
- ✅ Bytes-per-token claim — 9–17× reduction vs JSON-SSE, measured against both synthetic streams and a live Ollama server.
- ✅ Agent-handoff CPU win — 2–5× faster round-trip vs JSON-SSE even with a hash-table tokenizer (real BPE widens the gap further).

What's still on the roadmap:

- HTTP/2 multiplexing and persistent gRPC sessions.
- Stateful context block references (cross-call prompt reuse without re-shipping).
- A canonical-IR transpilation layer that lets the same wire payload route to multiple model backends.
