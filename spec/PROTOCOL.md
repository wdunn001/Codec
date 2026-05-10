# Codec Protocol Specification

This file is a **navigation index**. The actual per-version specs live
under [`spec/versions/`](./versions/). The latest version is currently
**v0.4**.

If you're implementing a Codec client or server today, read
[**versions/v0.4.md**](./versions/v0.4.md) — it's wire-compatible with
every earlier minor of this major (v0.2, v0.3) per the
[Versioning Policy](./versions/v0.4.md#versioning-policy) codified in
v0.4.

## Versions

- [**v0.4 (current)**](./versions/v0.4.md) — safety-policy
  negotiation as a TLS-style capability axis on the existing
  HELLO/READY shape; sanitized published descriptors at
  `.well-known/codec/policies/<id>.json` with content-addressed
  siblings; `finish_reason: "policy_violation"`; explicit
  versioning policy (no breaking changes in minor versions; major
  bump required for breakage); per-version documentation framework.
  Pairs with operator-side enforcement primitives (banned-token
  logits processor, multi-token Aho-Corasick matcher,
  embedding-space classifier scaffolding, classifier registry,
  delay-k streaming decisioning) shipped in `codec-supervisor`.
- [**v0.3**](./versions/v0.3.md) — image + video latent modality.
  `LatentStreamHeader` + `LatentFrame` frame types over the same
  msgpack/protobuf wire modes. Latent-space maps with paired VAE
  decoder references + transform-pipeline list (raw, int8, int4,
  int8-adaptive, int4-adaptive, delta+int8, delta+int4). Trained
  zstd dictionaries keyed by `(format, pipeline)`. Future Session
  Protocol with HELLO/READY frame types specified.
- [**v0.2**](./versions/v0.2.md) — text-token modality (initial).
  `CodecFrame` over MessagePack or Protobuf. Bidirectional
  `POST /v1/completions/codec` accepts binary token IDs in the
  request body. Tokenizer maps + `.well-known/codec/maps/`
  decentralised discovery. Per-client primitives: `ToolWatcher`
  for tool-call detection without detokenizing, `Translator` for
  cross-vocab agent handoff. Pre-tokenizer op-list runtime
  (v2.1, additive) for environments without PCRE2.

## Companion documents

- [**`spec/PIPELINES.md`**](./PIPELINES.md) — bit-level math for
  the seven latent transform pipelines (referenced by v0.3+).
- [**`spec/PRETOKENIZER_PROGRAM.md`**](./PRETOKENIZER_PROGRAM.md) —
  pretokenizer op list (referenced by v0.2+ via `tokenizer-map`'s
  optional `pre_tokenizer_program` field).
- [**`spec/WELL_KNOWN_DISCOVERY.md`**](./WELL_KNOWN_DISCOVERY.md) —
  the `.well-known/codec/` URL convention. Extended in each
  modality-introducing version: `maps/` (v0.2), `latents/` (v0.3),
  `policies/` (v0.4).
- [**`docs/PROTOCOL_VERSION_HISTORY.md`**](../docs/PROTOCOL_VERSION_HISTORY.md) —
  how each version's "Open questions" lifecycle works; lineage of
  resolutions across versions.
- [**`docs/RELEASE_CHECKLIST.md`**](../docs/RELEASE_CHECKLIST.md) —
  the gate every release passes through; §4 enforces the
  versioning policy via per-spec-file diff audit.

## Schemas + canonical examples

- [`tokenizer-map.schema.json`](./tokenizer-map.schema.json) — v0.2,
  carries the BPE vocab + merges + pretok program + tool-calling
  block.
- [`latent-space-map.schema.json`](./latent-space-map.schema.json) —
  v0.3, carries the latent shape + dtype + decoder reference +
  pipelines list + zstd dicts.
- [`safety-policy.schema.json`](./safety-policy.schema.json) — v0.4,
  the *sanitized published* descriptor (categories + actions +
  classifier family + summary stats; never operator-internal
  banned-id lists or thresholds).
- [`examples/example-safety-policy.json`](./examples/example-safety-policy.json) —
  canonical v0.4 descriptor, round-trips through
  `@codecai/maps-cli policies-{validate,hash,well-known}` and the
  matching subcommands in every other client (Python, Rust, .NET,
  Java, libcodec).

## Why a per-version index exists

The wire surface evolves additively across minor versions of the
same major. A v0.2 client must work against a v0.4 server (the
server only sends fields v0.2 understands when v0.2 negotiates), and
a v0.4 client must tolerate a v0.2 server (older fields absent).

The per-version snapshots make this concrete: each `versions/v0.X.md`
is the spec a v0.X implementer needs, with no "future" content
mixed in. Open-questions sections inside each snapshot are
*living* — they get marked **Resolved.** as later versions close
items, but the wire-format text in each version's body is frozen.

When v0.5 ships, this index gains a "v0.5 (current)" entry,
`versions/v0.5.md` is created (typically by copying the prior
current and applying the new additive changes), and the prior
`versions/v0.4.md` keeps its content unchanged — except for items
v0.5 resolves in v0.4's open-questions section.
