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
  core/       @codec/core — binary frame encoder/decoder
  demo/       live benchmark + agent-to-agent demo
spec/
  PROTOCOL.md             wire format specification
  tokenizer-map.schema.json  JSON Schema for tokenizer map contract
```

---

## Quick start

```bash
npm install
ANTHROPIC_API_KEY=sk-... npm run demo
```

**Agent-to-agent demo** (two Claude models passing context):

```bash
ANTHROPIC_API_KEY=sk-... npm run demo:agent
```

---

## What the benchmark shows

A typical Sonnet streaming response (≈120 tokens):

| Mode  | Wire bytes | Bytes/token |
|-------|-----------|-------------|
| Text  | ~6,000    | ~50         |
| Codec | ~490      | ~4.1        |

**~90% wire reduction.** For agent-to-agent calls the text detokenise/re-tokenise loop is eliminated entirely.

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

MVP / proof of concept. The demo is real — it makes live Anthropic API calls and measures actual wire bytes. The Codec binary encoding is implemented and correct. What doesn't exist yet: a server that natively emits token IDs (today we re-tokenise the text response client-side to simulate it), and the HTTP/2 transport layer.

The next step is a Codec-native server endpoint on a real inference backend.

[Pull Request for vLLM support](https://github.com/vllm-project/vllm/pull/41765)
