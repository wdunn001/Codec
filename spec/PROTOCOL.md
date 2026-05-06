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

## Implementations

**vLLM server** — [vllm-project/vllm PR #41765](https://github.com/vllm-project/vllm/pull/41765)  
Server-side encoder in `vllm/entrypoints/codec_frame.py`. Adds `stream_format`
to the completions API and a dedicated bidirectional `/v1/completions/codec`
endpoint.

**TypeScript client** — [github.com/wdunn001/Codec](https://github.com/wdunn001/Codec)  
`@codec/client` — `stream()`, `streamFromIds()`, `agentHandoff()`. Decodes
binary frames via `@msgpack/msgpack decodeMultiStream`.

---

## Wire Formats

Codec defines two wire modes. Both carry identical frame semantics; they differ
only in serialization.

### Mode A — MessagePack (application/x-msgpack)

Each frame is a MessagePack-encoded map:

```
{ "ids": [uint32, ...], "done": bool, "finish_reason"?: str }
```

Frames are emitted sequentially in the HTTP response body with no delimiter.
The receiver decodes using a streaming MessagePack unpacker (e.g.
`decodeMultiStream` in `@msgpack/msgpack`, `msgspec.msgpack.Decoder` in Python).

**Bytes per token:** ~4–6 (vs ~80 for JSON SSE).

### Mode B — Protobuf (application/x-protobuf)

Each frame is a 4-byte big-endian length prefix followed by the raw protobuf
bytes for `CodecFrame`:

```
┌─────────────────────┬─────────────────────────┐
│  4 bytes (uint32BE) │       N bytes           │
│    frame length     │  protobuf CodecFrame    │
└─────────────────────┴─────────────────────────┘
```

Schema (fetch from `/codec/schema` on any Codec-enabled server):

```protobuf
syntax = "proto3";

message CodecFrame {
  repeated uint32 ids          = 1 [packed = true];
  bool            done         = 2;
  optional string finish_reason = 3;
}

message CodecRequest {
  repeated uint32 prompt_ids   = 1 [packed = true];
  uint32          max_tokens   = 2;
  float           temperature  = 3;
  repeated string stop         = 4;
  string          stream_format = 5;  // "msgpack" or "protobuf"
}
```

### Frame Semantics (both modes)

| Field           | Type          | Rules                                                    |
|----------------|---------------|----------------------------------------------------------|
| `ids`          | uint32[]      | Raw model token IDs for this chunk. Never empty except on the terminal frame when `done=true` and no final token was produced. |
| `done`         | bool          | `true` on the last frame. No further frames follow.      |
| `finish_reason`| string (opt.) | Only set when `done=true`. Values: `"length"`, `"eos_token"`, `"stop_sequence"`. |

---

## Session Lifecycle — Stateless HTTP Mode

The current implementation uses stateless HTTP — compatible with existing
load balancers, proxies, and API gateways.

### Unidirectional (text prompt → binary token stream)

```
POST /v1/completions
Content-Type: application/json

{
  "model": "...",
  "prompt": "Explain entropy.",
  "stream_format": "msgpack",   ← the only required change
  "max_tokens": 256
}

→ 200 OK
   Content-Type: application/x-msgpack

   [msgpack frame] {ids:[1234,5678], done:false}
   [msgpack frame] {ids:[9012],      done:false}
   [msgpack frame] {ids:[3456],      done:true,  finish_reason:"eos_token"}
```

`stream_format` accepts `"msgpack"` or `"protobuf"`. Setting it automatically
forces `detokenize=false` server-side — no text is produced at any point.

### Bidirectional (token IDs in → token IDs out)

For agent-to-agent calls where the prompt is itself a token sequence:

```
POST /v1/completions/codec
Content-Type: application/x-msgpack      ← or application/x-protobuf

[msgpack] {prompt_ids:[1,2,3,...], max_tokens:256, stream_format:"msgpack"}

→ 200 OK
   Content-Type: application/x-msgpack

   [msgpack frame] {ids:[4567], done:false}
   ...
   [msgpack frame] {ids:[8901], done:true, finish_reason:"length"}
```

No text is produced or consumed at any point in this path. Agent A's output
token IDs become Agent B's input token IDs over the wire.

### Schema endpoint

```
GET /codec/schema
→ 200 OK   Content-Type: text/plain

syntax = "proto3";
message CodecFrame { ... }
message CodecRequest { ... }
```

---

## Session Lifecycle — Full Frame Protocol (future)

The stateless HTTP mode covers most use cases. A session-based protocol is
specified below for persistent connections, multiplexed streams, and
cross-vendor tokenizer negotiation.

### Frame Structure

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

### Handshake

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

### TOKENS Frames

Payload: packed uint32BE token IDs, 4 bytes each, no separator.

```
02              ← type TOKENS
00 00 00 0C     ← payload_len = 12 bytes
00 00 C3 51     ← token 50001
00 00 C3 52     ← token 50002
00 00 C3 53     ← token 50003
```

### EOS

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
A frame boundary is never a valid rendering boundary for a partial emoji or
multi-byte character. Buffer until the sequence is complete.

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

- Not a replacement for HTTP. Codec frames are transported over HTTP/1.1, HTTP/2, or QUIC.
- Not a new tokenizer. Codec declares and fetches existing tokenizers; it does
  not define vocabularies.
- Not a model API. Codec is a wire-format layer beneath the existing message API.
  Text-mode APIs continue to work unchanged for clients that want simplicity.

---

## Migration path

Text APIs and Codec coexist the way HTTP/1.1 and HTTP/2 coexist.

```
POST /v1/completions                  ← existing JSON/SSE path (unchanged)
POST /v1/completions  + stream_format ← opt-in binary output, text input
POST /v1/completions/codec            ← binary input + binary output
GET  /codec/schema                    ← proto schema for client codegen
GET  /v1/tokenizer-maps/{id}          ← tokenizer map (full session protocol)
```

Clients that want efficiency opt in. Clients that want simplicity stay on text.
Logging and debugging tools decode token streams using the declared map, the
same way Wireshark decodes binary protocols.

---

## Open questions (v0.1)

1. **Compression.** Should frames be ZSTD-compressed? Raw uint32 IDs compress
   poorly, but delta-coding (store Δid instead of id) may halve bytes for runs
   of sequential IDs. Not yet benchmarked.

2. **Batched / parallel streams.** Multi-stream multiplexing (like HTTP/2
   streams) within a single connection, for speculative decoding outputs.

3. ~~**Bidirectional.**~~ **Resolved.** `POST /v1/completions/codec` accepts
   binary request bodies (`prompt_ids` as packed uint32) and streams binary
   frames in response. Implemented in the vLLM PR.

4. ~~**gRPC vs raw frames.**~~ **Resolved toward HTTP + MessagePack/Protobuf.**
   The stateless HTTP mode ships today and composes with existing infrastructure.
   gRPC remains an option for the full session protocol if persistent connections
   and multiplexing become requirements.
