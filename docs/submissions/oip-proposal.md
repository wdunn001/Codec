# Codec as a Binary-Transport Extension to Open Inference Protocol v2

**Status**: draft proposal, v0.5 submission pass
**Target**: [kserve/open-inference-protocol](https://github.com/kserve/open-inference-protocol)
**Filing path**: GitHub issue + draft PR against `kserve/open-inference-protocol`'s `v2/` tree

## Summary

Open Inference Protocol (OIP) v2 standardises the request/response shape for
inference servers (KServe, NVIDIA Triton, Seldon Core, Hugging Face TGI all
implement it today). The current spec uses JSON for the response body, which
forces the same serialise/parse/tokenise overhead this proposal's parent
project (Codec) was designed to eliminate.

This proposal adds Codec as a wire-format extension to OIP v2: keep OIP's
request shape, swap the response body for Codec frames when both client and
server negotiate it. The extension is layered on the existing OIP
infrastructure with zero breaking changes — a client that doesn't request
Codec sees the same JSON wire OIP serves today.

## What's proposed

### Negotiation

OIP v2 inference endpoints (e.g. `POST /v2/models/{name}/infer`) already
accept a `parameters` object in the request body. We add one optional
parameter:

```json
{
  "id": "request-001",
  "inputs": [...],
  "outputs": [...],
  "parameters": {
    "stream_format": "msgpack"   // or "protobuf" or "msgpack-delta" (v0.5+)
  }
}
```

When `stream_format` is absent, behaviour is unchanged from OIP v2 today
(JSON response). When present and the server supports it, the response body
is Codec-framed.

### Response shape

The OIP v2 response envelope (`{"model_name", "outputs": [...]}`) stays
JSON. Each output element's `data` field, if it's a token-stream output,
gets carried as Codec frames instead of a JSON `data` array.

For streaming responses (which OIP v2 supports via the SSE convention), each
SSE event's payload is one Codec frame instead of a JSON object.

### Discovery

Codec's `.well-known/codec/` surface (tokenizer maps, ZSTD dictionaries,
safety policies) is reused unchanged. OIP servers that opt into Codec
publish their tokenizer maps at the standard well-known paths.

### Implementation effort per OIP-compliant server

| Server                | Estimated effort | Codec patch availability       |
|-----------------------|------------------|--------------------------------|
| **Hugging Face TGI**  | 2-3 weeks         | Fork at `wdunn001/text-generation-inference` (v0.5 candidate, Task #89) |
| **NVIDIA Triton**     | 1-2 weeks         | Not yet started; codec patches model the sglang/vllm work |
| **KServe**            | 1 week            | Layer on top of the framework; OIP-aware client libs auto-pick up |
| **Seldon Core**       | 1 week            | Same as KServe                 |

## Why this is the right substrate

- OIP v2 is the broadest cross-vendor inference standard with active adoption
  in production deployments. Codec needs a standardisation venue beyond
  Quasarke's reference forks; OIP is the natural fit.
- OIP's `parameters` field gives us a negotiation surface without forcing
  a v3 spec bump.
- Reference implementations across 6 languages are already shipping.
- The protocol carries no IP encumbrance (functional spec, see CODEC-SPEC's
  license posture).

## What this isn't

- **Not a replacement for OIP v2 JSON.** The JSON path stays the default;
  Codec is an opt-in axis advertised via `stream_format`.
- **Not a fork.** This proposal is purely additive — clients that don't
  understand `stream_format` see today's behaviour unchanged.
- **Not a wholesale protocol change.** The OIP request envelope, the
  output shape, the SSE convention — all preserved.

## Acceptance criterion for v0.5 cut

Per `spec/proposals/v0.5-scope.md`:

> *the GitHub proposal is open and engaged with by at least one OIP
> maintainer (whether they accept or not).*

The submission path is:

1. Open a GitHub Discussion thread on `kserve/open-inference-protocol`
   titled "Binary transport extension for OIP v2 (Codec)" with this
   document's contents as the opening post.
2. Link from the discussion to the canonical Codec spec at
   `https://github.com/wdunn001/Codec/blob/main/spec/PROTOCOL.md`.
3. If engagement is positive, follow up with a draft PR adding a
   `v2/extensions/codec.md` document to the OIP tree.

## Open questions for the OIP community

1. **Versioning interplay.** OIP v2 doesn't yet have a `Codec-Client-Version`
   equivalent. Should Codec's version negotiation reuse a header, or
   fold into the OIP `parameters` object?
2. **Tokenizer-map discovery.** Codec uses `.well-known/codec/`; OIP
   has no comparable surface today. Should Codec's well-known live
   under `.well-known/oip/` for symmetry with the standard, or stay
   under `.well-known/codec/` for reusability outside OIP?
3. **Conformance test corpus.** Codec ships a cross-stack
   24-cells-per-engine bench fixture; can the OIP conformance suite
   absorb that as the test corpus for the binary axis?
4. **Latent modality (image/video generation).** OIP v2 doesn't yet
   model latent-stream responses. Codec's `LatentStreamHeader` /
   `LatentFrame` extension covers diffusion / video model output;
   does OIP want to absorb that as part of the same extension PR or
   as a separate proposal?

## Status

This document is the **proposal source** that will be filed against
`kserve/open-inference-protocol`. Not yet submitted as of v0.5 cut. The
filing path above is the v0.5 release-checklist deliverable; the
maintainer engagement loop is post-v0.5.

## Acknowledgements

[ TBD — populated post-submission ]
