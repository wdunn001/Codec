---
title: "Codec: A Binary Transport for Token-Identifier Streaming in AI Inference APIs"
abbrev: "codec"
docname: draft-dunn-codec-00
category: info
ipr: trust200902
area: Applications and Real-Time
workgroup: Independent Submission
keyword:
 - AI
 - inference
 - transport
 - tokenizer
 - msgpack
 - protobuf
 - zstd
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
  RFC2119:
  RFC7231:
  RFC8174:
  RFC8259:
  RFC8878:
  RFC9110:
  RFC9112:

informative:
  RFC3552:
  RFC7322:
  MSGPACK:
    title: "MessagePack Specification"
    target: "https://github.com/msgpack/msgpack/blob/master/spec.md"
    date: 2017-08
    author:
     -
       ins: S. Furuhashi
       name: Sadayuki Furuhashi
  PROTOBUF:
    title: "Protocol Buffers Version 3 Language Specification"
    target: "https://protobuf.dev/reference/protobuf/proto3-spec/"
    date: 2024-12
    author:
     -
       org: Google LLC
  BROTLI:
    title: "Brotli Compressed Data Format"
    target: "https://www.rfc-editor.org/rfc/rfc7932"
    date: 2016-07
    seriesinfo:
      RFC: 7932
  POSTEL:
    title: "Transmission Control Protocol"
    target: "https://www.rfc-editor.org/rfc/rfc793"
    date: 1981-09
    seriesinfo:
      RFC: 793
---

# Codec: A Binary Transport for Token-Identifier Streaming in AI Inference APIs

# Abstract

This document describes Codec, a binary streaming transport for AI
inference APIs. Codec replaces the JSON Server-Sent-Events encoding
used by the de-facto AI inference APIs with a stream of native
token identifiers, framed as MessagePack maps or length-prefixed
Protocol Buffers messages. Codec layers on existing HTTP semantics
via standard content-type and content-encoding negotiation and
introduces no new transport-layer protocols. Compared with the
JSON-encoded baseline on a 2048-token completion, Codec reduces
per-response wire bytes by factors observed between 16 and 1700
depending on payload entropy and the use of a pre-trained
dictionary for the dictionary-zstd content encoding.

# Status of This Memo

This Internet-Draft is submitted in full conformance with the
provisions of BCP 78 and BCP 79.

Internet-Drafts are working documents of the Internet Engineering
Task Force (IETF). Note that other groups may also distribute
working documents as Internet-Drafts. The list of current
Internet-Drafts is at https://datatracker.ietf.org/drafts/current/.

Internet-Drafts are draft documents valid for a maximum of six
months and may be updated, replaced, or obsoleted by other documents
at any time. It is inappropriate to use Internet-Drafts as reference
material or to cite them other than as "work in progress."

# Introduction

## Problem Statement

Contemporary AI inference APIs (typified by the OpenAI Chat
Completions and Anthropic Messages interfaces) accept a text prompt,
internally tokenize it into a sequence of integer identifiers, run
the model over those identifiers, and emit the resulting
identifiers as text after a per-token detokenization step. The
typical wire format wraps the resulting text fragments in a JSON
object and ships them as a sequence of Server-Sent-Events frames.

For a human-facing consumer this round-trip is reasonable: the wire
carries the text the human will read. For an agent-mesh deployment
in which one inference model's output is the input to another, the
text round-trip is overhead. The receiving model immediately
re-tokenizes the text back into integer identifiers before
processing. The intermediate detokenize/re-tokenize pair
produces no value the next model can observe.

The overhead is non-trivial. Empirical measurement across three
open-source inference engines on a 2048-token output shows JSON-SSE
payloads in the 480-540 kilobyte range per visible reply, versus
140-3900 bytes when the same response is carried as Codec frames.
The ratio is content-dependent; high-entropy text reduces the
compression headroom and low-entropy text (code, structured data,
repeated patterns) expands it.

## Scope

This document specifies:

- The frame shape for token-identifier streams in MessagePack
  ({{MSGPACK}}) and length-prefixed Protocol Buffers ({{PROTOBUF}}).
- A negotiation procedure using the standard `Content-Type`,
  `Accept-Encoding`, and `Content-Encoding` axes plus a small set
  of additive request and response fields.
- A discovery surface at `<origin>/.well-known/codec/` for
  out-of-band artefacts (tokenizer descriptors, pre-trained
  Zstandard dictionaries) that a Codec client requires to
  interpret a stream.
- Optional extensions (delta-varint stream encoding) negotiated
  through the same axes.

This document does NOT specify:

- The semantics of the token identifiers themselves; identifiers
  are defined by the tokenizer of the inference model in use.
- The model-facing API contract (chat-completion semantics, system
  prompts, tool-calling schemas); these are defined by
  product-specific specifications outside this document.
- Server-side inference behaviour, content classification, or model
  routing.

## Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL
NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED",
"MAY", and "OPTIONAL" in this document are to be interpreted as
described in BCP 14 [RFC2119] [RFC8174] when, and only when, they
appear in all capitals, as shown here.

The term **token identifier** (token ID) refers to a non-negative
integer identifying one entry in a tokenizer's vocabulary. Token
IDs are the native unit of inference for transformer-based
language models.

The term **tokenizer** refers to the mapping from text to token
identifiers and back. The mapping is bijective on its domain (the
text-form representations the tokenizer was trained on) and
implementation-specific.

The term **tokenizer descriptor** refers to a JSON document
describing the vocabulary, byte-encoding scheme, and special
tokens needed for an independent implementation to detokenize a
stream of token identifiers back to text. The canonical schema is
referenced in {{DISCOVERY}}.

The term **agent mesh** refers to a deployment in which the
output of one inference model is fed as input to a second
inference model without intermediate human-readable rendering.

The term **frame** refers to one self-delimited unit on the wire;
the units of {{MSGPACK}} or length-prefixed {{PROTOBUF}}.

The term **deployment** refers to one HTTP origin that
participates in Codec negotiation as a server.

# Codec Versions and Changes  {#VERSIONS}

This document describes Codec at version `0.5`. Earlier minor
versions (`0.2`, `0.3`, `0.4`) of the same major version are
wire-compatible with the surface specified here: a `0.2` client
implementation can speak with a `0.5` server. A `0.5` client
implementation can likewise speak with a `0.2` server, modulo the optional
extensions added at each subsequent minor.

The following table summarizes the additive evolution across
minor versions. A subsequent revision of this document MAY refine
the version-history table; the wire shape specified in {{WIRE}}
is normative for `0.5`.

| Version | Additive change                                                                                  |
|--------:|--------------------------------------------------------------------------------------------------|
| 0.2     | Text-token streaming; MessagePack and Protocol Buffers wire encodings; tokenizer-descriptor discovery via `.well-known/codec/maps/`. |
| 0.3     | Latent-tensor streaming (`LatentStreamHeader` + `LatentFrame`) for image and video generation models; latent-space descriptor discovery via `.well-known/codec/latents/`. Out of scope for this document; specified in a separate companion. |
| 0.4     | Safety-policy negotiation as an additional handshake axis; sanitized policy descriptor at `.well-known/codec/policies/`; explicit minor-version-additive policy. |
| 0.5     | Discoverable Zstandard dictionaries (`.well-known/codec/dicts/<sha256>.zstd`); optional delta-varint stream encoding ({{DELTA}}); content-aware compression-picker rewrite (out of band). |

This document specifies the text-token surface (versions 0.2
through 0.5) and the discovery + dictionary surface. The
latent-tensor surface (introduced in 0.3) is out of scope and is
referenced for completeness only.

# Wire Format  {#WIRE}

Codec defines two interchangeable wire encodings for streamed
token identifiers, selected by the client via the request-body
`stream_format` field:

- `"msgpack"`: MessagePack {{MSGPACK}} maps with named keys.
- `"protobuf"`: Length-prefixed Protocol Buffers {{PROTOBUF}}
  messages.

A Codec response body consists of one or more concatenated frames
of the chosen encoding. The choice is final for the lifetime of a
single response; a server MUST NOT mix encodings within one
response body.

## MessagePack frame

A MessagePack frame is a single map with the following fields.
Field order is not significant. Unknown fields MUST be silently
ignored on receipt.

| Field           | MessagePack type | Required | Semantics                                                            |
|-----------------|------------------|----------|----------------------------------------------------------------------|
| `ids`           | array of uint32  | MUST     | The token identifiers in this frame. May be empty when `done = true` and no final identifier was produced. |
| `done`          | bool             | MUST     | True if and only if this is the terminal frame of the stream.        |
| `finish_reason` | string           | SHOULD   | Present if `done = true`. Open enum; values "length", "eos_token", "stop_sequence", "error" are defined. Other values MAY be defined by extensions. |
| `tool_calls`    | array of map     | MAY      | Server-detected delimited regions in the model's output. Shape defined in {{TOOL}}. |
| `base_id`       | uint32           | MAY      | Required when delta-varint encoding is in use; see {{DELTA}}.        |
| `ids_delta`     | array of int     | MAY      | Required when delta-varint encoding is in use; see {{DELTA}}.        |

When `done` is true the server MUST NOT emit further frames on
the response body. Receivers MUST treat the byte sequence after a
terminal frame as a protocol error and abandon the stream.

## Protocol Buffers frame

The Protocol Buffers schema for the text-token surface:

~~~
syntax = "proto3";

message CodecFrame {
  repeated uint32 ids           = 1 [packed = true];
  bool            done          = 2;
  optional string finish_reason = 3;
  repeated ToolCall tool_calls  = 4;
  optional uint32 base_id       = 5;   // delta-varint, see Section "Delta-varint axis"
  // Field tags 6 and above reserved for future extension.
}

message ToolCall {
  optional string name           = 1;
  string          arguments_json = 2;
  optional string id             = 3;
}

message CodecRequest {
  repeated uint32 prompt_ids    = 1 [packed = true];
  uint32          max_tokens    = 2;
  float           temperature   = 3;
  repeated string stop          = 4;
  string          stream_format = 5;   // "msgpack" | "protobuf" | extensions
}
~~~

Each frame on the wire is preceded by a 4-byte length prefix in
network byte order (big-endian) indicating the byte length of the
following encoded `CodecFrame` message. The prefix is not part of
the protobuf message and is not parsed by the protobuf decoder.

### Frame layout diagram

~~~
   0                   1                   2                   3
   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |                       Frame length N                          |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |                                                               |
  +                                                               +
  |                  Protocol Buffers CodecFrame                  |
  +                       (N bytes)                               +
  |                            ...                                |
  +                                                               +
  |                                                               |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
~~~

A receiver decodes the response body by repeatedly reading the
4-byte length, then reading exactly that many bytes and feeding
them to the protobuf decoder.

## Content types

The HTTP response `Content-Type` header MUST be:

- `application/x-msgpack` when `stream_format` is `"msgpack"`.
- `application/x-protobuf` when `stream_format` is `"protobuf"`.

A request body MAY use the same `Content-Type` values when the
request body is itself Codec-encoded (see {{ENDPOINTS}}).

These media-type tokens are placeholders pending IANA registration
(see {{IANA}}); deployments today use the listed tokens and the
present document specifies them.

# Negotiation

Codec negotiation reuses the standard HTTP content-encoding axes
({{Section 8.4 of RFC7231}}, {{Section 8.4 of RFC9110}}) and adds
the per-request `stream_format` field on the request body.

## Request-body field

A Codec-aware client SHOULD include in the JSON request body (or
in the equivalent Codec-Request message for bidirectional
endpoints; see {{ENDPOINTS}}) the field:

~~~
"stream_format": "msgpack"
~~~

Permitted values: `"json"` (default; the existing JSON-SSE wire
shape), `"msgpack"`, `"protobuf"`. Extensions MAY define
additional values (for example, `"msgpack-delta"` and
`"protobuf-delta"` defined in {{DELTA}}). A server that does not
support a requested value MUST either fall back to a value it does
support and report the fall-back in a response header, or return
an HTTP 4xx response indicating the unsupported value.

When `stream_format` is set to a Codec value, the server MUST NOT
perform detokenization on the generated identifiers before
emitting them on the wire; the wire carries identifiers only.

## Compression

The Codec response body MAY be compressed using standard HTTP
content-encoding ({{Section 8.4 of RFC9110}}). Servers SHOULD
support at minimum the `identity` and `gzip` codings. The `br`
({{BROTLI}}) and `zstd` ({{RFC8878}}) codings are RECOMMENDED;
clients indicate preference via `Accept-Encoding` and servers
select via `Content-Encoding`.

When the server emits `Content-Encoding: zstd` and the zstd
compression uses a pre-trained dictionary, the server MUST
include a response header naming the dictionary's content hash:

~~~
Codec-Zstd-Dict: sha256:<lowercase hex digest>
~~~

The dictionary bytes MUST be retrievable from the well-known
surface (see {{DISCOVERY}}) by content-addressed lookup. A client
that cannot resolve the dictionary MUST treat the response body
as undecodable and abort the request.

## Capability advertisement

A server MAY include the following response header on Codec
responses:

~~~
Codec-Server-Version: 0.5
~~~

The value is a `<major>.<minor>` version identifier. A client MAY
use the value to gate use of optional extensions defined in
subsequent minor versions.

A server MAY support a GET endpoint at `<origin>/codec/version`
returning a JSON object describing capabilities:

~~~
{ "version": "0.5",
  "stream_formats": ["msgpack", "protobuf"],
  "delta_varint": false }
~~~

Clients MAY probe this endpoint before opening a generation
request. The `Codec-Server-Version` response header (when
present) is authoritative for the negotiated session.

## Handshake sequence

The negotiation procedure for a typical Codec request is:

~~~
   client                                              server

     |  POST /v1/completions                              |
     |  Content-Type: application/json                    |
     |  Accept-Encoding: zstd, gzip, identity             |
     |  body: {"stream_format": "msgpack", ...}           |
     |--------------------------------------------------> |
     |                                                    |
     |                       200 OK                       |
     |   Content-Type: application/x-msgpack              |
     |   Content-Encoding: zstd                           |
     |   Codec-Zstd-Dict: sha256:29a8...                  |
     |   Codec-Server-Version: 0.5                        |
     |                                                    |
     | <-------------------------------------------------|
     |                                                    |
     |   <msgpack frame {ids:[8123],     done:false}>     |
     |   <msgpack frame {ids:[1402,77],  done:false}>     |
     |   <msgpack frame {ids:[],         done:true,       |
     |                   finish_reason:"eos_token"}>      |
     | <-------------------------------------------------|
~~~

If the server cannot honour `stream_format: "msgpack"` it MAY
fall back to `"json"` and emit a response with
`Content-Type: text/event-stream`. The client distinguishes the
case by inspecting `Content-Type` on the first response chunk.

# Endpoints  {#ENDPOINTS}

This document specifies two ingress shapes. Both produce
identical Codec response bodies; they differ only in the request
side.

## Path A: JSON request, Codec response

The most widely deployed shape. Identifiable by `Content-Type:
application/json` on the request and `application/x-msgpack` (or
`application/x-protobuf`) on the response.

~~~
POST /v1/completions
Content-Type: application/json
Accept-Encoding: zstd, gzip

{
  "model": "<model identifier>",
  "prompt": "Explain entropy.",
  "stream_format": "msgpack",
  "max_tokens": 256
}
~~~

The OpenAI-style `prompt` field MAY be either a string (which
the server tokenizes) or an array of integers (token identifiers
the server uses verbatim, skipping tokenization on ingress).

## Path B: Codec request body, Codec response

Optimization for prompts whose token-identifier JSON
representation balloons relative to the equivalent
varint-packed binary form (typically >50,000 tokens, e.g.,
retrieval-augmented contexts). The request body itself is a
Codec-encoded `CodecRequest` message.

~~~
POST /v1/completions/codec
Content-Type: application/x-msgpack
Accept-Encoding: zstd, gzip

<msgpack> {prompt_ids:[...], max_tokens:256, stream_format:"msgpack"}
~~~

Servers SHOULD implement Path A. Servers MAY implement Path B; if
not, the server MUST return HTTP 404 to `/v1/completions/codec`
and the client MUST fall back to Path A.

## Schema endpoint

A server MAY support a GET endpoint at `<origin>/codec/schema`
returning the Protocol Buffers schema text as `text/plain`.
Clients MAY fetch this once to generate decoder code at deploy
time. The endpoint is optional; the schema in {{WIRE}} is
normative.

# Discovery  {#DISCOVERY}

Codec defines a `<origin>/.well-known/codec/` URI prefix for
discovery of out-of-band artefacts that a client requires to
interpret a Codec stream. The subpaths defined in this
version are:

- `<origin>/.well-known/codec/maps/<id>.json`: mutable tokenizer
  descriptor keyed by identifier. A content-addressed sibling
  `<origin>/.well-known/codec/maps/sha256/<hex>.json` SHOULD also be
  present.
- `<origin>/.well-known/codec/policies/<id>.json`: mutable
  sanitized safety-policy descriptor. A content-addressed sibling
  at `<origin>/.well-known/codec/policies/sha256/<hex>.json` SHOULD
  also be present.
- `<origin>/.well-known/codec/dicts/<sha256-hex>.zstd`: the
  pre-trained Zstandard dictionary bytes, always content-addressed.
  No mutable per-id form is defined; the sha256 IS the identifier.

All `<origin>/.well-known/codec/` paths MUST be served over
HTTPS. A client receiving a Codec response that references a
discovery artefact (for example, `Codec-Zstd-Dict: sha256:<hex>`)
MUST verify, on fetch, that the bytes returned by the well-known
URL hash to the named sha256; mismatch MUST be treated as a
discovery failure and the request MUST be aborted.

# Optional axes

## Delta-varint axis  {#DELTA}

A server MAY support the `stream_format` values
`"msgpack-delta"` and `"protobuf-delta"`, in which each frame
carries:

- `base_id` (uint32): the encoder's last-identifier-emitted at
  the end of the previous frame, or 0 for the first frame in a
  stream.
- `ids_delta` (array of zigzag-encoded signed integer): chained
  deltas. The first delta is `zigzag(ids[0] - base_id)`;
  subsequent deltas are `zigzag(ids[k] - ids[k-1])`.

The receiver reconstructs `ids` by cumulative summation from
`base_id`. Each frame independently carries its own `base_id`;
the framing is therefore stateless across frames. A proxy
that drops a frame in transit does NOT desynchronize the decoder as a result.

The delta-varint axis exploits locality in adjacent token
identifiers (consecutive token IDs from a vocabulary commonly
cluster) and reduces wire bytes by approximately 10-15% pre-zstd
on typical natural-language outputs. The benefit narrows to 3-5%
post-zstd, since zstd compresses out much of the same regularity;
the axis is therefore RECOMMENDED only for deployments where
post-zstd bandwidth is the dominant cost.

## Tool-watcher field  {#TOOL}

Each entry in the optional `tool_calls` array on a frame
describes one delimited tool-call region the server detected in
the model's output stream. Fields:

- `name` (optional string): parsed from the call body when the
  model uses a recognized JSON shape.
- `arguments_json` (string): the raw JSON body between the start
  and end markers, verbatim.
- `id` (optional string): server-generated correlation identifier
  for asynchronous dispatch.

The `tool_calls` field is informational. The model's output
stream (the `ids` field) remains authoritative; the tool-call
region's identifiers are still present in `ids`.

# Liberal/Conservative Acceptance  {#LIBERAL}

Codec follows the principle articulated in {{POSTEL}}: be liberal
in what is accepted, conservative in what is emitted.

A Codec receiver MUST:

- Accept frames with unknown MessagePack map keys, silently
  ignoring them.
- Accept frames with unknown Protocol Buffers field tags within
  the reserved range; the proto3 wire format requires this
  natively.
- Accept response headers with unknown `Codec-*` names; absence
  of a header is the signal that the corresponding optional
  feature is not in use.
- Accept any `Content-Type` it has registered as decodable; a
  v0.5 receiver that supports both `"msgpack"` and `"protobuf"`
  MUST handle either on the same response.

A Codec emitter MUST:

- Emit only the fields defined for the negotiated `stream_format`
  value. A server MUST NOT emit `base_id`/`ids_delta` on a
  non-delta stream and MUST NOT emit `tool_calls` if no
  tool-call region was detected.
- Emit `finish_reason` from the defined values on every terminal
  frame.
- Emit response headers in their defined form; in particular, a
  `Codec-Zstd-Dict` value MUST be the lowercase hexadecimal
  digest with the `sha256:` prefix.

# Out-of-Specification Behaviour  {#OOSPEC}

This section enumerates the response a Codec implementation
takes when receiving input that does not conform to this
document. Behaviour falls into three classes: silently ignore,
fail the request, or abort the stream.

## Server-side receipt

| Condition                                                | Response                                                                 |
|----------------------------------------------------------|--------------------------------------------------------------------------|
| Unknown `stream_format` value                            | HTTP 400 with a body explaining the supported set.                       |
| `stream_format: "msgpack"` with `Content-Type` mismatch on a Codec-encoded request body | HTTP 415 (Unsupported Media Type).                                       |
| `n > 1` requested with a binary `stream_format`          | HTTP 400. The `CodecFrame` shape carries no choice index; multiple sequences cannot be demultiplexed on the wire. |
| Malformed Protocol Buffers in a Codec request body       | HTTP 400. The error body identifies the field offset when feasible.       |
| Varint overflow during request decode (>5 bytes for a uint32) | HTTP 400. Implementations MUST reject rather than enter an unbounded decode loop. |
| Truncated request body                                   | HTTP 400.                                                                |

## Client-side receipt

| Condition                                                | Response                                                                 |
|----------------------------------------------------------|--------------------------------------------------------------------------|
| Response `Content-Type` does not match a `stream_format` the client requested | Abandon parse; report transport error to the caller.       |
| 4-byte length prefix indicates a frame larger than a client-configurable cap | Abandon parse. Default cap RECOMMENDED at 16 MiB; deployments handling very large per-frame payloads MAY override. |
| Protocol Buffers decode failure mid-stream                | Abandon parse. The client MAY surface the bytes consumed so far as a partial response. |
| Response carries `Codec-Zstd-Dict` for a dictionary that fails the post-fetch hash check | Abort the request. Treat the response body as undecodable.              |
| Terminal frame (`done = true`) followed by additional bytes | Treat the extra bytes as a protocol error and discard.                  |

# Implementation Experience

At the time this document is published, independent Codec
implementations exist as language libraries (TypeScript, Python,
Rust, .NET, Java, C) and as patches to three open-source
inference engines (sglang, vLLM, llama.cpp). The
language-library implementations were developed independently
against the wire format specified in this document, validated by
cross-stack benchmarks that send identical token-identifier
inputs across implementations and compare resulting wire bytes
for byte-equality.

The cross-stack bench produces a matrix of (engine × client
language × frame format × content encoding × prompt size) cells;
all cells reach byte-equal outputs across implementations for
fixed inputs at temperature zero. The matrix is published with
each release; the most recent matrix is available from the
project's results directory.

The existence of multiple interoperable implementations from
independent code bases is presented here as informational
implementation experience, in the sense of RFC 2026 §4.1.2.

# Security Considerations

This section addresses security considerations specific to
Codec. It does not replace the general HTTP security
considerations of {{Section 17 of RFC9110}}. Those considerations
continue to apply.

## Binary middlebox blindness

Codec response bodies are binary; security middleware that
performs content inspection by parsing JSON bodies (web
application firewalls, intrusion detection systems) will see
Codec frames as opaque bytes. Operators that rely on body
inspection SHOULD either:

- Deploy Codec-aware middleware that understands the
  MessagePack and length-prefixed Protocol Buffers frame shapes,
  OR
- Terminate Codec at a boundary upstream of the inspection
  appliance (a reverse proxy that translates Codec to
  JSON-SSE on the inspected leg) and accept the cost.

The choice is a deployment decision; this document specifies the
wire shape but cannot mandate operator middleware. Operators
deploying Codec without addressing this consideration risk
content-policy bypass for any policy enforced exclusively by
body-inspection middleware.

## Capability-advertisement trust

The `Codec-Server-Version` response header and the
`/codec/version` endpoint are server-asserted; a misconfigured
or malicious server can advertise a version it does not
implement. Receivers SHOULD NOT use the advertised version as a
security boundary; it is purely a courtesy signal for graceful
degradation. Receivers that need to be
certain the server speaks a given version MUST verify
behaviourally (the server emits the expected frame shape) and
fail the request when behaviour disagrees with the advertised
capability.

## Discovery cache poisoning

The discovery surface at `<origin>/.well-known/codec/` references
tokenizer descriptors, safety policies, and Zstandard
dictionaries by mutable identifier and by content-addressed
sha256 sibling. A man-in-the-middle that controls the network
path to the well-known origin can serve a substituted artefact
under the mutable name.

Mitigations:

- The MUST-HTTPS requirement in {{DISCOVERY}} prevents
  in-flight substitution on the well-known channel itself.
- The Codec response carries the content hash of the in-use
  artefact (for example, `Codec-Zstd-Dict: sha256:<hex>`); the
  client MUST verify the bytes returned by the discovery URL
  match that hash, rejecting on mismatch.

A client that fetches a discovery artefact but does not verify
its hash against the response-header-asserted value SHOULD be
considered non-conformant. Discovery without hash verification
permits the well-known origin to substitute artefacts undetected.

## Frame-size and varint exhaustion

A malicious sender can attempt to exhaust receiver resources by
sending a frame whose 4-byte length prefix names a very large
size, by sending a varint with many continuation bytes, or by
sending a `prompt_ids` array of unbounded length in a request
body.

Mitigations:

- Receivers MUST enforce a configurable maximum frame size
  ({{OOSPEC}}, default RECOMMENDED at 16 MiB).
- Varint decode MUST reject any varint exceeding the byte count
  required to represent the destination integer type (5 bytes
  for `uint32`, 10 bytes for `uint64`). A decoder that loops on
  unbounded varint input is exploitable for resource exhaustion.
- Receivers MUST bound the request-body size at HTTP-server
  configuration time; this document does not specify a value.

## Sentinel-identifier integrity

A server-side tool-call detector identifies tool-call regions in
the model's output by matching against reserved control
identifiers. A model fine-tuned by a third party can in
principle emit those control identifiers in non-tool-call
contexts, causing the detector to surface a `tool_calls` entry
that does not correspond to a structured call.

Receivers SHOULD treat `tool_calls` as a hint requiring independent
validation. Receivers that dispatch on
`tool_calls` SHOULD additionally validate the `arguments_json`
field against the expected schema for the named tool, treating
schema-validation failures as detector false positives.

## Cross-tenant identifier leakage

Token identifiers are vocabulary-specific. A client that
detokenizes a Codec stream against the wrong tokenizer
descriptor produces incorrect text but does not gain access to
content it was not authorized for. The tokenizer descriptor
itself is public. There is no confidentiality requirement on the
identifier sequence beyond what the underlying HTTP authorization
already provides.

# IANA Considerations  {#IANA}

This document requests no IANA action.

The negotiation surface reuses existing registry values from
{{Section 8.4 of RFC9110}} (`Content-Encoding`) and does not
register new content codings.

A future revision of this document MAY request:

- Registration of `application/vnd.codec+msgpack` and
  `application/vnd.codec+protobuf` media types per
  {{Section 14.18 of RFC9110}}.
- Registration of the `Codec-Zstd-Dict`, `Codec-Server-Version`,
  and `Codec-Client-Version` response headers per BCP 90.
- Registration of the `codec` suffix under the well-known URI
  registry per BCP 190.

Until those registrations are made, the tokens listed above are
specified for informational use in this document only; deployments
SHOULD NOT rely on IANA's registry to validate them.

# Privacy Considerations

The wire shape specified in this document carries only token
identifiers. An on-path observer that does not possess
the tokenizer descriptor for the in-use model cannot
detokenize identifiers to text without additional work.

This does NOT constitute confidentiality: a determined observer
with sufficient samples and the public tokenizer descriptor can
reconstruct text from identifiers trivially. The wire format
provides no obfuscation beyond what the network transport
(typically TLS for HTTPS) already provides.

# References

## Normative References

[RFC2119], [RFC7231], [RFC8174], [RFC8259], [RFC8878], [RFC9110],
[RFC9112].

## Informative References

[RFC3552], [RFC7322].

{{MSGPACK}}, {{PROTOBUF}}, {{BROTLI}}, {{POSTEL}} (Postel's
Robustness Principle).

# Acknowledgements

The Codec wire format was developed by the Quasarke project. The
specification benefited from review by independent implementers
of the language libraries enumerated under Implementation
Experience.
