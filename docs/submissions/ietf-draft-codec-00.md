---
title: "Codec: A Binary Transport Protocol for AI Inference APIs"
abbrev: "codec"
docname: draft-quasarke-codec-00
category: info
ipr: trust200902
area: Applications and Real-Time
workgroup: Independent Submission
keyword:
 - AI
 - inference
 - transport
 - tokenizer
 - JSON
 - msgpack
 - SSE
stand_alone: yes
pi:
 - toc
 - sortrefs
 - symrefs
author:
 -
   ins: W. Dunn
   name: William Dunn
   organization: Quasarke
   email: wdunn001@gmail.com

normative:
  RFC7231:
  RFC7541:
  RFC8259:
  RFC9112:

informative:
  RFC7515:
  MSGPACK:
    title: "MessagePack Specification"
    target: "https://github.com/msgpack/msgpack/blob/master/spec.md"
    author:
     -
       ins: S. Furuhashi
  PROTOBUF:
    title: "Protocol Buffers Encoding"
    target: "https://protobuf.dev/programming-guides/encoding/"
    author:
     -
       org: Google LLC
  ZSTD:
    title: "Zstandard Compression and the application/zstd Media Type"
    target: "https://datatracker.ietf.org/doc/html/rfc8878"
---

# Codec: A Binary Transport Protocol for AI Inference APIs

# Status of This Memo

This Internet-Draft is submitted in full conformance with the provisions of
BCP 78 and BCP 79. Internet-Drafts are working documents of the Internet
Engineering Task Force (IETF). This is an Independent Submission to the
Internet-Drafts repository.

This document describes a wire-format extension on top of HTTP/1.1 and is
intended to be implementable independently of the Quasarke reference
implementations. The protocol itself carries no patent encumbrance —
functional interfaces are uncopyrightable per the *Lotus v. Borland* line
of cases (specification-as-API is uncopyrightable functional matter).

# Abstract

This document describes Codec, a binary transport protocol for the
streaming response bodies of AI inference APIs. The current de-facto
standard — JSON-encoded Server-Sent Events (JSON-SSE) — requires the
inference server to detokenize generated token identifiers into UTF-8
text on each frame, and requires every intermediate hop in an
agent-mesh deployment to re-tokenize that text back into identifiers
before feeding it to the next model. This document defines a wire
shape that carries the native unit of inference (token identifiers)
end-to-end, with optional rendering at the leaf of the consumer graph.

Codec is layered on HTTP/1.1 [@!RFC9112] via the existing
`Content-Encoding` / `Accept-Encoding` negotiation surface and a small
set of additive request/response headers. It does not require changes
to existing HTTP infrastructure (proxies, load balancers, CDNs) and
graceful-downgrades to JSON-SSE when the client or server does not
advertise the Codec capability.

Measurements collected against three open-source inference engines
(sglang, vLLM, llama.cpp) over six client-language implementations
(TypeScript, Python, Rust, .NET, Java, C) show a per-visible-reply
wire-byte reduction in the range of 16× to 1,700×, depending on
payload entropy and the presence of a pre-trained ZSTD dictionary for
the tokenizer in use.

# Introduction

## Problem Statement

Modern AI inference APIs ({{LANG-PLATFORMS}}) accept text prompts,
generate token identifiers, then serialize those identifiers back to
text — typically as JSON-Server-Sent-Events (JSON-SSE) — before
emitting them on the wire. The receiving client (whether a browser, a
mobile app, or another inference server in an agent-mesh deployment)
parses the JSON, extracts the text content, and — for the agent-mesh
case — re-tokenizes the text back into identifiers before sending it
to the next model in the chain.

This text round-trip provides no value to the AI model itself; the
model is downstream of the conversions and operates exclusively on
token identifiers. The conversion is overhead from the perspective of
every consumer in the chain except the final leaf node (typically a
human-facing rendering surface).

The overhead is non-trivial. Empirical measurement across a
representative cohort of open-source inference engines on a 2K-token
output shows JSON-SSE payloads of 485-529 kilobytes per visible reply,
versus 140-3,900 bytes when the same response is carried as Codec
frames. The wire-byte reduction factor is content-dependent (it scales
with how compressible the token sequence is) and the corresponding
reduction in non-GPU CPU work at every hop is approximately
proportional.

## Scope

This document specifies:

- The frame shape for token-identifier streams in MessagePack
  ({{MSGPACK}}) and length-prefixed Protocol Buffers ({{PROTOBUF}}).
- A negotiation surface (HTTP request body field `stream_format` plus
  the standard `Accept-Encoding` / `Content-Encoding` axis) that
  selects Codec over JSON-SSE when both client and server support it.
- A `.well-known/codec/` discovery surface ({{WELL-KNOWN}}) for the
  out-of-band data (tokenizer maps, ZSTD dictionaries, safety
  policies) required for clients to interpret Codec frames.
- Optional axes (delta-varint stream encoding, per-block MCP leaf
  tokenization metadata, latent-modality frames) layered on the same
  negotiation fabric.

This document does NOT specify:

- The semantics of the token identifiers themselves (those are
  defined by the inference model's tokenizer).
- Higher-level chat or completion semantics (those are defined by
  product-specific APIs such as OpenAI's `/v1/chat/completions` or
  Anthropic's Messages API).
- Server-side inference behaviour, safety classifiers, or model
  routing.

## Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in BCP
14 [@!RFC2119].

The term "token identifier" or "token ID" refers to a non-negative
integer identifying one entry in a tokenizer's vocabulary. Token IDs
are the native unit of inference for transformer-based language
models. The mapping from text to identifiers and back is performed by
a "tokenizer".

The term "tokenizer map" refers to a published JSON document
describing the vocabulary, byte-encoding scheme, special tokens, and
optional metadata needed for a client to detokenize a stream of token
identifiers back to text. The canonical form is defined by
[CODEC-SPEC] §"Tokenizer Map".

The term "agent mesh" refers to a deployment in which one inference
model's output is fed as input to another inference model without
human-readable rendering between them.

# Wire Format

Codec defines two interchangeable wire encodings for streamed token
identifiers, selected by the client via the request-body
`stream_format` field:

- `"msgpack"` — MessagePack {{MSGPACK}} maps with named keys.
- `"protobuf"` — Length-prefixed Protocol Buffers {{PROTOBUF}}
  messages.

Both produce a stream of frames. Each frame represents one or more
generated tokens (the number is implementation-defined; servers
typically emit one token per frame, but MAY batch).

## MessagePack frame

A MessagePack frame is a single map with the following fields. Field
order is not normative.

| Field           | MessagePack type | Required | Semantics                                                            |
|-----------------|------------------|----------|----------------------------------------------------------------------|
| `ids`           | array of uint32  | MUST     | The token identifiers in this frame.                                 |
| `done`          | bool             | MUST     | True iff this is the terminal frame of the stream.                   |
| `finish_reason` | string           | MAY      | Present iff `done` is true. Implementation-defined values.           |
| `tool_calls`    | array of map     | MAY      | Server-side tool-watcher emissions; structure defined in {{TOOL}}.   |

## Protocol Buffers frame

The Protocol Buffers schema:

~~~
syntax = "proto3";

message CodecFrame {
  repeated uint32 ids           = 1 [packed = true];
  bool            done          = 2;
  optional string finish_reason = 3;
  repeated ToolCall tool_calls  = 4;
}

message ToolCall {
  optional string name           = 1;
  string          arguments_json = 2;
  optional string id             = 3;
}
~~~

Each frame on the wire is preceded by a 4-byte big-endian length
prefix indicating the byte length of the following encoded
`CodecFrame` message.

## Stream framing

A Codec response body consists of one or more concatenated frames.
The HTTP response Content-Type MUST be:

- `application/x-msgpack` when `stream_format` is `"msgpack"`.
- `application/x-protobuf` when `stream_format` is `"protobuf"`.

A frame with `done = true` MUST be the last frame of the stream; the
server MUST NOT emit further frames after it.

## Negotiation

Codec negotiation reuses the standard HTTP `Accept-Encoding` /
`Content-Encoding` axis for compression and adds:

- A `stream_format` field on the request body (a JSON or
  Codec-request object). Permitted values: `"json"` (default;
  backwards-compatible JSON-SSE), `"msgpack"`, `"protobuf"`. The
  server MAY support additional implementation-defined values
  (e.g. `"msgpack-delta"`, see {{DELTA}}); clients SHOULD ignore
  unknown values from the server's `/codec/schema` response.

- An optional response header `Codec-Server-Version: <major.minor>`
  identifying the highest Codec protocol minor version the server
  implements. Clients MAY gate per-version feature use on this
  header value.

- An optional GET endpoint `<origin>/codec/version` returning a JSON
  object describing the server's capabilities:

  ~~~
  { "version": "0.5",
    "stream_formats": ["msgpack", "protobuf"],
    "delta_varint": false,
    "bolt_on_dispatch": false }
  ~~~

  Clients MAY probe this endpoint before opening a generation
  request. The runtime `Codec-Server-Version` header is
  authoritative.

- An optional GET endpoint `<origin>/codec/schema` returning the
  Protocol Buffers schema text (Content-Type `text/plain`). Clients
  MAY fetch this to generate decoder code at deploy time.

## Compression

The Codec response body MAY be compressed using standard HTTP
content encoding ({{Section 8.4 of !RFC7231}}). Servers SHOULD
support at minimum `identity` and `gzip`; `br` and `zstd` are
RECOMMENDED. When the server emits `Content-Encoding: zstd` with a
pre-trained dictionary, it MUST include a `Codec-Zstd-Dict:
sha256:<lowercase hex>` response header identifying the
dictionary, and the dictionary bytes MUST be retrievable from the
well-known surface (see {{DISCOVERY}}).

## Discoverable artefacts {#DISCOVERY}

Codec defines a `<origin>/.well-known/codec/` URI prefix for
discovery of out-of-band data clients need to interpret a Codec
stream:

- `.well-known/codec/maps/<id>.json` — tokenizer maps (the
  vocabulary + byte-encoding metadata needed to detokenize identifiers
  to text). Mutable per-`id` path; clients MAY also fetch a
  content-addressed sibling at `.well-known/codec/maps/sha256/<hex>.json`.

- `.well-known/codec/policies/<id>.json` — published safety-policy
  descriptors. Both mutable per-`id` path and a content-addressed
  sibling at `.well-known/codec/policies/sha256/<hex>.json`.

- `.well-known/codec/dicts/<sha256-hex>.zstd` — pre-trained ZSTD
  dictionaries (binary). Path is always content-addressed; there is
  no mutable per-id form.

- `.well-known/codec/version-policy.json` — optional document
  declaring the server's minimum supported Codec version and required
  features. Clients MAY probe before opening a connection to avoid
  wasting a `426 Upgrade Required` round-trip.

All `.well-known/codec/` paths MUST be served over HTTPS.

## Optional axes

Implementations MAY support additional axes negotiated through the
same `stream_format` and capability mechanisms above. Two examples
defined by the reference implementation:

- {{DELTA}}: delta-varint stream encoding (`stream_format:
  "msgpack-delta"` / `"protobuf-delta"`), exploiting locality in
  adjacent token identifiers for 10-15% wire reduction pre-zstd.

- Tool-watcher emissions: server-side detection of delimited regions
  (tool calls, reasoning blocks) in the model's output, surfaced as
  the `tool_calls` field on the frame in which the region terminates.
  See {{TOOL}}.

## Delta-varint axis {#DELTA}

When the request specifies `stream_format: "msgpack-delta"` or
`"protobuf-delta"`, each frame carries:

- `base_id` (uint32) — the encoder's last-id-seen-at-end-of-previous-
  frame (0 for the first frame in a stream).
- `ids_delta` (array of zigzag-encoded signed integer) — chained
  deltas. The first delta is `zigzag(ids[0] - base_id)`; subsequent
  deltas are `zigzag(ids[k] - ids[k-1])`.

The receiver reconstructs `ids` by cumulative-sum from `base_id`.
Each frame carries its own `base_id` so the framing is stateless —
a proxy that drops a frame in the middle of a stream does NOT
desynchronise the decoder.

## Tool-watcher field {#TOOL}

Each entry in the optional `tool_calls` array on a frame describes
one tool-call region the server detected (by special-token match) in
the model's output. The fields:

- `name` (optional string) — parsed from the call body when the model
  uses the standard `{"name": "...", "arguments": {...}}` JSON shape.
- `arguments_json` (string) — the raw JSON body between the start
  and end markers.
- `id` (optional string) — server-generated call identifier, e.g.
  `tc_<hex>`.

The `tool_calls` field is informational from the wire perspective;
the model's own output stream (the `ids` field) continues to be
authoritative.

# Security Considerations

See [CODEC-SPEC] §"Security Considerations" for the threat model
covering client-claimed version trust, leaf-mode `_codec_meta`
integrity, latent buffer overflows, well-known cache poisoning, and
sentinel token spoofing.

The MessagePack and length-prefixed Protocol Buffers serialisations
used by Codec are binary formats; security middleware that inspects
JSON request/response bodies (WAFs, IDS systems) will not see Codec
frames as inspectable without a binary-decoder integration. Operators
SHOULD ensure their security middleware either understands the Codec
frame shape or terminates Codec at a boundary they do inspect.

# IANA Considerations

This document requests no IANA action. The negotiation surface uses
existing HTTP `Content-Encoding` registry values
({{Section 8.4 of !RFC7231}}) and adds no new registered tokens. The
`.well-known/codec/` URI suffix is documented for informational
purposes; this draft does not request registration of the suffix
under [BCP 190].

A future version of this document MAY request:

- Registration of `application/vnd.codec+msgpack` and
  `application/vnd.codec+protobuf` media types under
  {{Section 14.18 of !RFC9110}}.
- Registration of the `Codec-Tokenizer-Map`, `Codec-Zstd-Dict`,
  `Codec-Safety-Policy`, and `Codec-Client-Version` response headers
  under [BCP 90].
- Registration of the `.well-known/codec/` URI suffix under [BCP 190].

# References

## Normative References

[CODEC-SPEC]: The canonical machine-readable spec, at
`https://github.com/wdunn001/Codec/blob/main/spec/PROTOCOL.md`.

## Informative References

Existing reference implementations are at:

- TypeScript: `@codecai/web` on npm
- Python: `codecai` on PyPI
- Rust: `codec-rs` on crates.io
- .NET: `Codec.Net` on NuGet
- Java: `ai.codec:codec` on Maven Central
- C: `libcodec` via CMake FetchContent and vcpkg

# Acknowledgements

[ TBD — populated by the IETF submission pass ]

# Submission Status

This draft is at the **`-00`** stage and not yet submitted to the
IETF datatracker. The intended submission path is:

1. Convert this markdown to RFC-flavour kramdown via `kdrfc` or
   `mmark`.
2. Submit via the Independent Submission Stream at
   `https://datatracker.ietf.org/submit/`.
3. Publish the datatracker-assigned draft URL on the Codec website.

Estimated submission date: post-v0.5 cut, dependent on a focused
2-4 week spec-writing pass to fill in the wire-format body skeleton
above with the kramdown-formatted normative text.
