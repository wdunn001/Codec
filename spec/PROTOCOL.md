# Codec Protocol Specification — v0.1 (Draft)

Codec is a binary transport protocol for AI inference APIs.
It replaces the UTF-8/JSON wire format with a stream of token IDs,
deferring text decoding to the presentation layer — and skipping it entirely
when the caller is another model.

---

## Motivation

Current AI APIs convert model-internal token IDs to UTF-8, wrap them in JSON,
and ship them over HTTP. The model emits a ~17-bit integer; the wire carries
50–100 bytes per token. For agent-to-agent calls the receiving model immediately
re-tokenises the text back into IDs. The round-trip through UTF-8 serves nobody.

Codec separates the layers:

| Layer        | Job                          | Format             |
|--------------|------------------------------|--------------------|
| Model        | Produce token IDs            | uint32 IDs (native)|
| Transport    | Move IDs across the wire     | Binary frames      |
| Presentation | Decode IDs for human readers | UTF-8 text (lazy)  |

The presentation layer is invoked only when a human is actually going to read
the output. Agent-to-agent traffic skips it entirely.

---

## Wire Format

### Frame Structure

Every unit on the wire is a **Frame**:

```
┌──────────┬──────────────────────────┬──────────────────┐
│  1 byte  │         4 bytes          │     N bytes      │
│   type   │  payload_len  (uint32BE) │    payload       │
└──────────┴──────────────────────────┴──────────────────┘
```

All multi-byte integers are **big-endian**.

### Frame Types

| Value | Name     | Direction      | Description                          |
|-------|----------|----------------|--------------------------------------|
| 0x00  | `HELLO`  | Client → Server| Session init, declares capabilities  |
| 0x01  | `READY`  | Server → Client| Confirms tokenizer, provides map URL |
| 0x02  | `TOKENS` | Server → Client| Packed token ID array                |
| 0x03  | `EOS`    | Server → Client| End of stream, empty payload         |
| 0x04  | `ERROR`  | Either         | UTF-8 error message                  |

---

## Session Lifecycle

### 1. Handshake

**HELLO** — client opens session:

```json
{
  "codec_version": "0.1",
  "accept_tokenizers": ["claude-sonnet-4-6-v1", "cl100k_base"]
}
```

**READY** — server confirms tokenizer and provides map:

```json
{
  "codec_version": "0.1",
  "tokenizer_id": "claude-sonnet-4-6-v1",
  "map_url": "https://models.example.com/maps/claude-sonnet-4-6-v1.json",
  "map_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb924..."
}
```

The client fetches the tokenizer map once, validates the SHA-256 hash, and
caches it. Subsequent sessions on the same connection skip the fetch.

### 2. Token Streaming

**TOKENS** frames carry packed token IDs:

```
payload = uint32BE × N   (4 bytes per token ID, no separator)
```

Frames are chunked at 64 IDs by default. The chunk boundary is an
implementation detail; the protocol imposes no minimum or maximum chunk size.

Example — 3 token IDs (50001, 50002, 50003):

```
02              ← type TOKENS
00 00 00 0C     ← payload_len = 12 bytes
00 00 C3 51     ← token 50001
00 00 C3 52     ← token 50002
00 00 C3 53     ← token 50003
```

### 3. End of Stream

**EOS** frame — empty payload, signals the model turn is complete:

```
03 00 00 00 00
```

---

## Tokenizer Map

The tokenizer map is a JSON document conforming to `tokenizer-map.schema.json`.
It is the client-side decode table: given a token ID, return the string fragment.

Clients load the map from `map_url`, verify against `map_hash`, and cache by
`(tokenizer_id, map_hash)`. Maps are immutable once published; a new model
version publishes a new map at a new URL with a new ID.

### Byte-fallback tokens

Some models emit raw UTF-8 byte tokens for characters outside their vocabulary.
The schema marks the fallback range with `byte_fallback_start` / `byte_fallback_end`.
IDs in this range are decoded as single bytes; the client accumulates them until
a valid UTF-8 sequence is complete before emitting to the display.

### Partial sequences during streaming

Clients must buffer partial multi-byte sequences across frame boundaries.
A TOKENS frame boundary is never a valid rendering boundary for a partial
emoji or multi-byte character. Buffer until the sequence is complete.

---

## Cross-vendor tokenizer handling

Different vendors publish different tokenizer vocabularies. They do not need
to be unified — only the **contract** for declaring and fetching them does.

The pattern is identical to HTTP `Content-Type: charset=`:

- The encoding stays vendor-specific.
- The declaration mechanism is standardised.
- Clients load whichever map the server declares.

A client talking to three vendors loads three maps, the same way a media player
loads three codecs. Maps are cached after first fetch, versioned with the model,
and updated when the model updates.

### Cross-vocab agent handoffs

When Agent A (vocab V₁) passes tokens to Agent B (vocab V₂):

1. The protocol layer translates IDs via the declared maps.
2. No UTF-8 intermediate is produced.
3. The translation table is deterministic and cacheable.

When V₁ = V₂ (same vendor, same model version), no translation is needed.

---

## What this is NOT

- Not a replacement for HTTP. Codec frames are transported over HTTP/2 or QUIC.
- Not a new tokenizer. Codec declares and fetches existing tokenizers; it does
  not define vocabularies.
- Not a model API. Codec is a wire-format layer beneath the existing message API.
  Text-mode APIs continue to work unchanged for clients that want simplicity.

---

## Migration path

Text APIs and Codec coexist the way HTTP/1.1 and HTTP/2 coexist.

```
POST /v1/messages                 ← existing text API (no change)
POST /v1/messages?codec=1         ← opt-in to binary token stream
GET  /v1/tokenizer-maps/{id}      ← tokenizer map endpoint
```

Clients that want efficiency opt in. Clients that want simplicity stay on text.
Logging and debugging tools decode token streams using the declared map, the
same way Wireshark decodes binary protocols.

---

## Open questions (v0.1)

1. **Compression.** Should TOKENS frames be ZSTD-compressed? IDs are not
   compressible as uint32, but delta-coding (store Δid instead of id) may
   halve bytes for runs of sequential IDs.

2. **Batched / parallel streams.** Multi-stream multiplexing (like HTTP/2
   streams) within a single connection, for speculative decoding outputs.

3. **Bidirectional.** Client-to-model token input (not just output) using the
   same framing.

4. **gRPC vs raw frames.** This spec describes a custom binary framing. A gRPC
   transport with a Protobuf message definition for TOKENS frames would work
   equally well and comes with tooling for free.
