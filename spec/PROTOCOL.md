# Codec Protocol Specification — v0.2

Codec is a binary transport protocol for AI inference APIs. It replaces the
UTF-8 / JSON wire format with a stream of token IDs, deferring text decoding
to the presentation layer — and skipping it entirely when the caller is
another model.

---

## Motivation

Current AI APIs convert model-internal token IDs to UTF-8, wrap them in JSON,
and ship them over HTTP. The model emits a ~17-bit integer; the wire carries
50–100 bytes per token. For agent-to-agent calls the receiving model
immediately re-tokenises the text back into IDs. The round-trip through UTF-8
serves nobody.

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

### Servers

- **vLLM** — [vllm-project/vllm PR #41765](https://github.com/vllm-project/vllm/pull/41765).
  Adds `stream_format: "msgpack" | "protobuf"` to `/v1/completions` plus a
  bidirectional `/v1/completions/codec` endpoint. Encoder in
  `vllm/entrypoints/codec_frame.py`; transport compression in
  `vllm/entrypoints/codec_compression.py`.

- **SGLang** — [sgl-project/sglang PR #24483](https://github.com/sgl-project/sglang/pull/24483).
  Same surface area, mirrored into SGLang's serving layer. Encoder in
  `python/sglang/srt/entrypoints/codec_frame.py`; transport compression in
  `codec_compression.py`.

### Clients

- **`@codecai/web`** ([npm](https://www.npmjs.com/package/@codecai/web)) —
  isomorphic tokenizer + detokenizer for browsers, Node 18+, Cloudflare
  Workers, Deno, Bun. Includes a pure-JS BPE encoder verified against
  production tokenizers.

- **`@codecai/maps-cli`** ([npm](https://www.npmjs.com/package/@codecai/maps-cli)) —
  CLI for generating Codec tokenizer dialect maps from any HuggingFace
  `tokenizer.json`. The "tsc --declaration" for token vocabularies.

### Map registry

- **`codec-maps`** ([github.com/wdunn001/codec-maps](https://github.com/wdunn001/codec-maps)) —
  community registry of pre-generated maps for 14 model families covering
  70+ aliases (Llama-3, Qwen-2, Mistral, Mixtral, Gemma, Phi-3/4,
  DeepSeek-V3, Falcon, SmolLM2, Codestral). Served via jsDelivr CDN.

---

## Wire Formats

Codec defines two wire modes. Both carry identical frame semantics; they
differ only in serialization.

### Mode A — MessagePack (`application/x-msgpack`)

Each frame is a MessagePack-encoded map:

```
{ "ids": [uint32, ...], "done": bool, "finish_reason"?: str }
```

Frames are emitted sequentially in the HTTP response body with no delimiter.
The receiver decodes using a streaming MessagePack unpacker (e.g.
`decodeMultiStream` in `@msgpack/msgpack`, `msgspec.msgpack.Decoder` in
Python).

**Bytes per token:** ~2.5 (vs ~80 for JSON SSE). Compression (see below)
brings this to ~1.8 bytes/token.

### Mode B — Protobuf (`application/x-protobuf`)

Each frame is a 4-byte big-endian length prefix followed by the raw protobuf
bytes for `CodecFrame`:

```
┌─────────────────────┬─────────────────────────┐
│  4 bytes (uint32BE) │       N bytes           │
│    frame length     │  protobuf CodecFrame    │
└─────────────────────┴─────────────────────────┘
```

Schema (also fetchable from `/codec/schema` on any Codec-enabled server):

```protobuf
syntax = "proto3";

message CodecFrame {
  repeated uint32 ids           = 1 [packed = true];
  bool            done          = 2;
  optional string finish_reason = 3;
}

message CodecRequest {
  repeated uint32 prompt_ids    = 1 [packed = true];
  uint32          max_tokens    = 2;
  float           temperature   = 3;
  repeated string stop          = 4;
  string          stream_format = 5;  // "msgpack" or "protobuf"
}
```

### Frame Semantics (both modes)

| Field           | Type          | Rules                                                    |
|-----------------|---------------|----------------------------------------------------------|
| `ids`           | uint32[]      | Raw model token IDs for this chunk. Empty only on the terminal frame when `done=true` and no final token was produced. |
| `done`          | bool          | `true` on the last frame. No further frames follow.      |
| `finish_reason` | string (opt.) | Set when `done=true`. Values: `"length"`, `"eos_token"`, `"stop_sequence"`, `"error"`. |

`finish_reason: "error"` is emitted on the terminal frame when the server
encountered an error mid-generation. Clients use this to distinguish a
genuine error from a clean stream truncation.

---

## Endpoints

### Unidirectional (text prompt → binary token stream)

```
POST /v1/completions
Content-Type: application/json
Accept-Encoding: zstd, gzip   ← optional, see Transport Compression below

{
  "model": "...",
  "prompt": "Explain entropy.",
  "stream_format": "msgpack",
  "max_tokens": 256
}

→ 200 OK
   Content-Type: application/x-msgpack
   Content-Encoding: zstd       ← only if negotiated

   <msgpack frame> {ids:[1234,5678], done:false}
   <msgpack frame> {ids:[9012],      done:false}
   <msgpack frame> {ids:[3456],      done:true,  finish_reason:"eos_token"}
```

`stream_format` accepts `"msgpack"` or `"protobuf"`. Setting it forces
`detokenize=false` server-side — no text is produced at any point.

Servers MUST reject `n > 1` for binary `stream_format` because `CodecFrame`
carries no choice index — multiple sequences would be undemultiplexable.

### Bidirectional (token IDs in → token IDs out)

There are two equivalent ways to express "no text on the wire in either
direction." Pick whichever fits your client.

**Path A — `/v1/completions` with `prompt: int[]`.** OpenAI's `prompt`
field already accepts `int[]`, so no new endpoint is required. Best for
typical prompts (<10K tokens) where the JSON `[1,2,3,...]` array is fine.

```
POST /v1/completions
Content-Type: application/json
Accept-Encoding: zstd, gzip
Content-Encoding: gzip            ← optional request-body compression

{
  "model": "...",
  "prompt": [1, 2, 3, 4567, ...],
  "stream_format": "msgpack",
  "max_tokens": 256
}

→ 200 OK
   Content-Type: application/x-msgpack
   Content-Encoding: zstd

   <msgpack frame> {ids:[8901], done:false}
   ...
   <msgpack frame> {ids:[3456], done:true, finish_reason:"length"}
```

**Path B — `/v1/completions/codec` with binary request body.** Same wire
output, but the request body is itself msgpack/protobuf instead of JSON.
This saves 2–3× bandwidth for very large prompts where a JSON
`[int, int, ...]` array balloons relative to the equivalent packed varint
encoding. Recommended for >50K-token contexts (e.g. RAG with long
documents). Also useful for proxies/observers that want the binary
contract explicit in the routing table rather than inferred from
`Content-Type` of the response.

```
POST /v1/completions/codec
Content-Type: application/x-msgpack       ← or application/x-protobuf
Accept-Encoding: zstd, gzip

<msgpack> {prompt_ids:[1,2,3,...], max_tokens:256, stream_format:"msgpack"}

→ 200 OK
   Content-Type: application/x-msgpack
   Content-Encoding: zstd

   <msgpack frame> {ids:[8901], done:false}
   ...
```

Both paths produce identical streaming output and identical "zero text on
the wire" guarantees. Servers MUST implement Path A (it's just OpenAI's
existing `prompt: int[]` plus `stream_format`). Servers SHOULD implement
Path B for the bandwidth case but MAY omit it; clients should fall back to
Path A if a `/v1/completions/codec` request returns 404.

### Schema endpoint

```
GET /codec/schema
→ 200 OK   Content-Type: text/plain

syntax = "proto3";
message CodecFrame { ... }
message CodecRequest { ... }
```

---

## Transport Compression (Optional)

Codec supports optional compression of the streaming response body using
standard HTTP `Accept-Encoding` / `Content-Encoding` negotiation. Compression
is **opt-in** (PKCE-style): the client advertises supported encodings; the
server picks one if any overlap exists, or returns identity-encoded frames if
not. Implementations on either side that don't support compression are
unaffected.

### Negotiation

```
Client request:
  Accept-Encoding: zstd, gzip

Server response (preference order: zstd > gzip > identity):
  Content-Encoding: zstd       ← if zstd supported on both sides
  Vary: Accept-Encoding
```

### Required vs optional support

| Encoding   | Server | Client | Notes                                          |
|------------|--------|--------|------------------------------------------------|
| `identity` | MUST   | MUST   | The fallback. Always works.                    |
| `gzip`     | SHOULD | SHOULD | Stdlib in every language. Universal browser support. |
| `zstd`     | MAY    | MAY    | Best ratio + speed. Browsers: Chrome 123+, Firefox 126+. |

Browsers handle `Content-Encoding` decompression transparently in `fetch()`,
so `@codecai/web` and other browser clients need no extra code to consume
compressed streams.

### Why HTTP-level compression, not per-frame

A single compression context spans the whole response stream, so the
compressor builds a dictionary from earlier frames to compress later ones
better. Per-frame compression discards this benefit and adds 10–20 bytes of
header overhead per frame, which dominates for small frames.

For the same reason, compression has **no minimum-size threshold**. The
streaming nature means total size isn't known upfront; gzip/zstd overhead
(~20 bytes) is negligible against typical Codec stream sizes (hundreds of
bytes minimum); and token IDs are uniformly distributed integers, so
compression always achieves some gain.

### Wire impact (Qwen-2 measurements)

| Configuration                          | Bytes/token |
|----------------------------------------|-------------|
| JSON SSE (baseline)                    | ~80         |
| Codec msgpack/protobuf, identity       | ~2.5        |
| + `Content-Encoding: zstd`             | ~1.8        |
| + Pre-trained zstd dictionary (future) | ~1.2        |

### Future: pre-trained ZSTD dictionaries

A v2 protocol extension will allow tokenizer maps to declare an optional
ZSTD dictionary URL alongside the map URL:

```json
{
  "id": "qwen/qwen2",
  "vocab": {...},
  "merges": [...],
  "zstd_dictionary": {
    "url": "https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/dictionaries/qwen-qwen2.zstd",
    "hash": "sha256:..."
  }
}
```

Servers that load the dictionary compress all frames against it; clients that
load the same dictionary decompress with it. Estimated improvement to
~1.2 bytes/token with negligible CPU overhead.

---

## Tokenizer Map

The tokenizer map is a JSON document conforming to
[`tokenizer-map.schema.json`](./tokenizer-map.schema.json). It carries the
data needed to:

- **Decode** token IDs back to text (presentation layer, browser side).
- **Encode** text into token IDs (when the client does its own
  tokenization — required for the bidirectional endpoint with text input).

### Schema summary (v2)

```json
{
  "id": "meta-llama/llama-3",
  "version": "2",
  "vocab_size": 128256,

  "vocab":   { "Hello": 9906, "Ġworld": 1917, ... },
  "encoder": "byte_level",
  "merges":  ["Ġ Ġ", "Ġ t", "i n", ...],
  "pre_tokenizer_pattern": "(?i:'s|'t|...)| ?\\p{L}+|...",

  "byte_fallback_start": 3,
  "byte_fallback_end":   258,

  "special_tokens": { "<|begin_of_text|>": 128000, ... },
  "published_at":   "2026-05-06T00:00:00Z"
}
```

### Encoder families

Three tokenizer families cover ~95% of open models:

| `encoder`   | Vocab key form    | Byte fallback | Examples                         |
|-------------|-------------------|---------------|----------------------------------|
| `byte_level`| `Ġhello`          | implicit (every byte is in vocab) | Llama-3, Qwen-2, Phi-3/4, DeepSeek-V3, Mistral-Nemo, Falcon, SmolLM2 |
| `metaspace` | `▁hello`          | `<0x00>`–`<0xFF>` range | Llama-2, Mistral-v3, Mixtral, Gemma, Codestral |
| omitted     | `hello` (decoded) | optional      | Synthetic / canonical-IR / closed vocabs |

### Encode path

For `byte_level`:
1. Apply `pre_tokenizer_pattern` regex to split text into pieces.
2. UTF-8-encode each piece, then map every byte through the GPT-2
   byte→unicode table to produce the vocab character space.
3. Apply BPE merges greedily by priority.
4. Look up resulting tokens in `vocab`.

For `metaspace`:
1. Split text on whitespace; prefix each word with `▁`.
2. Apply BPE merges greedily by priority.
3. Look up resulting tokens in `vocab`. Tokens not in vocab fall back to
   their UTF-8 bytes via `byte_fallback_start`.

### Decode path

For `byte_level`: each vocab token is a string of GPT-2-encoded bytes.
Reverse the byte table per character to get raw bytes; accumulate across
tokens; UTF-8-decode complete sequences.

For `metaspace`: replace `▁` with space and append. IDs in
`[byte_fallback_start, byte_fallback_end]` are decoded as raw bytes and
buffered for UTF-8 reassembly.

For both: partial multi-byte sequences MUST be buffered across frame
boundaries — a frame boundary is never a valid rendering boundary for a
partial emoji or multi-byte character.

### Content addressing and caching

Maps are content-addressed by sha256 hash. Clients call
`loadMap({ url, hash })` and the loader rejects any payload whose hash
doesn't match — making the URL itself untrusted; the hash is the trust
anchor. Cached by `(url, hash)`; cache hits skip the network entirely.

A new model version publishes a new map at a new URL with a new hash. Maps
are immutable once published.

### Map discovery

Clients learn `map_url` and `map_hash` from one of:

1. **Direct configuration** — the application code passes them to `loadMap`.
   Simplest case, used for fixed-model deployments.

2. **Future: `READY` frame** — when the full session protocol is
   implemented, the server's `READY` response carries `map_url` and
   `map_hash` for the negotiated tokenizer. Same data; different transport.

3. **Future: registry lookup** — `GET registry.codec.ai/v1/maps/<model-id>`
   returns `{ url, hash }`. Enables cross-org discovery and air-gapped
   substitution.

---

## Cross-vendor tokenizer handling

Different vendors publish different tokenizer vocabularies. They do not need
to be unified — only the **contract** for declaring and fetching them does.

The pattern is identical to HTTP `Content-Type: charset=`:

- The encoding stays vendor-specific.
- The declaration mechanism is standardised.
- Clients load whichever map the server declares.

A client talking to three vendors loads three maps, the same way a media
player loads three codecs. Maps are cached after first fetch, versioned with
the model, and updated when the model updates.

### Cross-vocab agent handoffs

When Agent A (vocab V₁) passes tokens to Agent B (vocab V₂):

1. The protocol layer translates IDs via the declared maps.
2. No UTF-8 intermediate is produced.
3. The translation table is deterministic and cacheable.

When V₁ = V₂ (same vendor, same model version), no translation is needed.

---

## Session Protocol (future)

The stateless HTTP mode covers the common case. A frame-based session
protocol is sketched below for persistent connections, multiplexed streams,
and dynamic tokenizer negotiation. Not yet implemented.

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
  "codec_version": "0.2",
  "accept_tokenizers": ["meta-llama/llama-3", "qwen/qwen2"],
  "accept_encoding": ["zstd", "gzip"]
}
```

**READY** — server confirms tokenizer and provides map:

```json
{
  "codec_version": "0.2",
  "tokenizer_id": "meta-llama/llama-3",
  "map_url": "https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/meta-llama/llama-3.json",
  "map_hash": "sha256:79b707aea8c2b41c2883ec7913b0c4a0c880044ac844d89a9a03e779eb92db04",
  "encoding": "zstd"
}
```

---

## What this is NOT

- Not a replacement for HTTP. Codec frames are transported over HTTP/1.1,
  HTTP/2, or QUIC.
- Not a new tokenizer. Codec declares and fetches existing tokenizers; it
  does not define vocabularies.
- Not a model API. Codec is a wire-format layer beneath the existing message
  API. Text-mode APIs continue to work unchanged for clients that want
  simplicity.

---

## Migration path

Text APIs and Codec coexist the way HTTP/1.1 and HTTP/2 coexist.

```
POST /v1/completions                              ← existing JSON/SSE path (unchanged)
POST /v1/completions  + stream_format             ← opt-in binary output
POST /v1/completions  + prompt:int[] + stream_format  ← bidirectional via JSON request
POST /v1/completions/codec                        ← bidirectional via binary request (huge prompts)
GET  /codec/schema                                ← proto schema for client codegen
```

Clients that want efficiency opt in. Clients that want simplicity stay on
text. Logging and debugging tools decode token streams using the declared
map, the same way Wireshark decodes binary protocols.

---

## Open questions (v0.2)

1. **Pre-trained ZSTD dictionaries.** The next compression win, ~30%
   beyond raw zstd. Distribution model: dictionary URL + hash declared in
   the tokenizer map. Trained on a corpus of typical token sequences for
   each model. Not yet benchmarked.

2. **Batched / parallel streams.** Multi-stream multiplexing (HTTP/2 push
   style) within a single connection, for speculative decoding outputs.

3. **Map discovery registry.** Centralised lookup
   (`registry.codec.ai/v1/maps/<id>`) vs convention-based
   (`https://<creator>/.well-known/codec/<slug>.json`). Both have advocates;
   the registry is more flexible for enterprise, the convention is more
   decentralised.

4. ~~**Bidirectional.**~~ **Resolved.** `POST /v1/completions/codec` accepts
   binary request bodies (`prompt_ids` as packed uint32) and streams binary
   frames in response.

5. ~~**Compression.**~~ **Resolved.** HTTP `Accept-Encoding` / `Content-Encoding`
   negotiation. Optional zstd, fallback gzip, identity always works.

6. ~~**gRPC vs raw frames.**~~ **Resolved toward HTTP + MessagePack/Protobuf.**
   The stateless HTTP mode ships today and composes with existing
   infrastructure. gRPC remains an option for the full session protocol if
   persistent connections and multiplexing become requirements.
