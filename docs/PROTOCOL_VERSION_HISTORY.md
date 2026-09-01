# Codec Protocol Version History: convention + carried-forward concerns

This document defines **how each protocol version's concerns and open
questions are tracked over time**. A reader at v0.7 can therefore reconstruct:

1. What v0.2 worried about. Which of those items got resolved by
   v0.3 / v0.4 / v0.5 / etc.
2. What v0.3 introduced as new concerns, what those concerns evolved
   into, and which got resolved later.
3. What v0.4 introduced (safety negotiation), what it resolved from
   v0.3, and what it leaves open for v0.5.
4. The same pattern for every version going forward.

The per-version snapshots in `spec/versions/v0.X.md` are the
*normative* documents (the navigation index at `spec/PROTOCOL.md`
just points at them). **This file is the convention**: how the
per-version sections inside `versions/v0.X.md` are written and
updated.

---

## The convention

### One "Open questions" section per version, never deleted

Every version that ships gets a section at the bottom of its own
`spec/versions/v0.X.md` snapshot: and the same section appears
verbatim in every later version's snapshot too, since each later
snapshot inherits the wire-spec text plus the trailing
open-questions blocks from earlier versions:

```markdown
## Open questions (v0.X)

1. ~~**Item title.**~~ **Resolved.** One-paragraph summary of how
   the item was addressed (typically in a later version), with a
   pointer (`see § ...`) and the version that closed it
   (`closed in v0.Y`).

2. **Item title.** Body.

3. ~~**...**~~ **Resolved.** ...
```

These sections are **append-only across versions**. When v0.Y resolves
an item from v0.X's open questions, the v0.Y release **strikes through
the original question text** and prepends `**Resolved.**` to the body: the question stays in place as historical context.

### One concerns block at the version intro

Each version also gets a brief intro block in its own
`versions/v0.X.md` (the disclaimer + the prose immediately after
it) that describes the *concerns* the version was built to address.
New versions don't rewrite older versions' concerns: the older
text stays in `versions/v0.(X-N).md` so a reader can see what the
project was thinking about at the time.

### What counts as "open"

A question stays open if its resolution would change the wire, the
discovery, the schema, or the interop contract between clients of
different versions. Bugs, perf, and ergonomic-only concerns aren't
tracked here: they live in GitHub issues.

### How a vX.Y release closes items

The `RELEASE_CHECKLIST.md` "Spec + per-version protocol documentation"
gate (§4) requires:

- Items resolved by vX.Y are marked `**Resolved.**` in the older
  version's open-questions section.
- vX.Y gets its own `## Open questions (vX.Y)` block.
- Items deferred to v(X.Y+1) are explicitly named.

Failing to update older sections is the most common drift: maintainers SHOULD scan all prior open-questions sections during the
release-cut and not just append.

---

## Current state of per-version sections (as of v0.5 release-cut)

This is a snapshot. The authoritative version lives in
`spec/versions/v0.X.md` (one file per version); this document
tracks the convention + the lineage across versions.

### v0.2: text modality (initial)

**Concerns:** carry token IDs over the wire in place of UTF-8; defer
detokenization to the presentation layer; let agent-to-agent calls
skip text entirely.

**Open questions resolved by v0.3:**

- **ZSTD dictionaries**: schema + training pipeline shipped in v0.3.
- **Map discovery registry**: `.well-known/codec/maps/<id>.json`
  convention in v0.3.
- **Bidirectional**: `POST /v1/completions/codec` accepts binary
  request bodies in v0.3.
- **Compression**: HTTP `Accept-Encoding`/`Content-Encoding`
  negotiation in v0.3.
- **gRPC vs raw frames**: resolved toward HTTP + MessagePack/Protobuf.
- **Polyglot client coverage**: TS / Python / .NET / C / Rust / Java
  all shipping by end of v0.3.
- **Tool-call detection without decoding**: per-client `ToolWatcher`
  primitive.
- **Cross-vocab agent handoff**: per-client `Translator` primitive.
- **Pre-tokenizer regex dependency**: `pre_tokenizer_program` op-list
  format added in v0.2.1, used from v0.3 onward.

**Open questions still open after v0.4** (carry forward):

- **Batched / parallel streams.** Multi-stream multiplexing
  (HTTP/2-push style) within one connection, for speculative decoding
  outputs. Not addressed by any subsequent version yet.

### v0.3: image + video latent modality

**Concerns:** apply the same "ship native units, defer rendering"
move to image + video VAE latents; negotiate latent space + decoder
+ pipeline through the existing handshake.

**Open questions resolved by v0.4:**

- *(none: v0.4's scope was safety negotiation, orthogonal to
  latent-modality refinement)*

**Open questions still open after v0.4** (carry forward to v0.5):

- **Pipeline registry governance.** Who reviews proposals for new
  pipelines (a sixth beyond `raw / int8 / int4 / delta+int8 /
  delta+int4`); what reference test vectors are required.
- **Trust anchor for `golden/` perceptual conformance.** Across the
  decoder boundary, `golden/` is the trust anchor itself; pinning to
  a frozen `torch+diffusers` Docker image vs. publishing a reference
  container is unresolved.
- **Air-gapped decoder substitution.** How an air-gapped enterprise
  swaps a decoder runtime while honoring the perceptual-conformance
  contract.
- **WebRTC datagram ordering for video.** When `data_channel.ordered:
  false` is acceptable for video latents; what the client renders on
  drop.

(Bench v0.3.x lab numbers in `packages/bench/` reflect what's been
measured against these open items as of release-cut; new measurements
land before the next version closes any of them.)

### v0.4: safety-policy negotiation + explicit versioning policy

**Concerns:**

1. Add safety-policy negotiation as one more axis on the existing
   TLS-style handshake; ship a sanitized published descriptor so
   receivers can audit what's enforced; keep the wire untouched
   otherwise. Pair with operator-side enforcement primitives (banned-
   token logits processor, multi-token Aho-Corasick matcher,
   embedding-space classifier scaffolding, classifier registry).

2. **Codify the protocol versioning policy.** Prior versions
   (v0.2 → v0.3, v0.3 → v0.4) were implicitly additive: every
   `accept_*` axis added to HELLO and every new READY field landed
   as optional. Older clients kept working as a result. The spec had no
   normative rule preventing a future minor version from breaking
   that property, though. v0.4 makes the rule explicit:

   - Minor versions (vX.Y → vX.(Y+1)) MUST be wire-compatible with
     prior minor versions of the same major.
   - Breaking changes (removing wire fields, changing field
     semantics, reassigning frame-type bytes, changing canonical-
     hash bytes, removing closed-enum values) require a major
     version bump (v0.X → v1.0, v1.X → v2.0).
   - Patch versions (vX.Y.Z → vX.Y.(Z+1)) are bug fixes only: no
     new fields, no new frame types.
   - Lives in `spec/versions/v0.4.md` § "Versioning Policy" (added
     in v0.4); enforced via `docs/RELEASE_CHECKLIST.md` §4 gate.

   This is itself a v0.4 contribution: the rule didn't exist
   before it was written down here.

3. **Per-version documentation lifecycle.** This document, the
   `spec/versions/v0.X.md` per-version snapshot files, and the
   per-version `## Open questions (v0.X)` blocks they carry are
   themselves a v0.4 deliverable. Future minor versions inherit
   the convention; future major versions can revise the convention
   itself in their own release-cut.

**Open questions** (target v0.5):

1. **Dedicated `SAFETY_VIOLATION` frame type (0x07).** v0.4 ships
   `finish_reason: "policy_violation"` + (optional, future) metadata
   field as the signaling channel. Open: does real deployment data
   show that signaling is insufficient? If so, the additive frame
   type lands in v0.5 with `{layer, category, action, span_start,
   span_end}` shape.

2. **Engine hidden-state hook for embedding-space classifiers.** The
   `EmbeddingSpaceClassifier` (`codec-supervisor`) capability-fails
   by default because no engine fork yet exposes per-token hidden
   states publicly. Open: which engine ships a stable hidden-states
   callback first (vLLM is the leading candidate); when it lands,
   `register_embedding_space(scorer=...)` becomes the default
   classifier path.

3. **MCP-leaf-mode safety enforcement signaling.** `finish_reason`
   doesn't exist on MCP tool-result blocks. v0.4 documents that the
   redact action operates on `_meta['ai.codec/leaf-tokenization'].ids`
   in the v0.3.2 wire shape, but rejection signaling for a tool
   result that fully fires a stop is reserved for a future additive
   `_meta` key (e.g. `ai.codec/policy-violation`).

4. ~~**Token-ID list authoring tooling.**~~ **Resolved at v0.5.**
   Shipped as `codecai-maps policies-enumerate`. See
   `spec/versions/v0.5.md § "Open questions (v0.5)"` item 4 for the
   resolved-direction note (variant-set v1: verbatim / leading-space /
   leading-newline / lowercase / titlecase / uppercase / trimmed;
   intentionally small so the output stays reviewable by hand).

5. **Cross-tokenizer policy bundling.** A policy bound to multiple
   tokenizers must publish per-tokenizer descriptor variants today
   (`acme/strict-v3-llama3`, `acme/strict-v3-qwen2`, etc.). Is a
   single multi-tokenizer descriptor with per-id sub-blocks worth
   the schema complexity, or does the per-variant pattern stay?

6. **Adversarial-list curation.** `WELL_KNOWN_GLITCH_TOKENS` ships
   empty per-tokenizer placeholders today. Open: who curates
   community lists; what audit trail does a registered list need
   before it's accepted upstream?

### v0.5: efficiency, observability, submission

**Concerns:**

1. **Efficiency cluster**: wire-additive extensions that improve
   per-request CPU + bytes without changing the v0.4 happy path
   byte-for-byte:
   - Delta-varint stream encoding (`stream_format: "msgpack-delta"`
     / `"protobuf-delta"`): chained zigzag varints between adjacent
     ids, ~10 to 15% wire reduction pre-zstd. Stateless framing
     preserved via `base_id` on every frame.
   - GPU-side latent quantize fast path (`gpu_quantize: bool` on
     `LatentStreamEncoderOptions`): when the encoder receives a
     `torch.cuda.Tensor` AND `gpu_quantize=true`, quantize on-device
     before PCIe transfer (~75% bytes saved on int4). Bit-identical
     to the numpy path under the same `quality_thresholds`.
   - Content-aware + per-stack-aware compression picker rewrite: `pick()` now samples response bytes for entropy + uses per-stack
     `ttftRatio` thresholds to drop encodings that buffer; returns a
     typed `reason_code` enum so dashboards can group decisions.

2. **Observability cluster**: make protocol state legible to
   operators:
   - Discoverable ZSTD dictionaries (`.well-known/codec/dicts/<sha>.zstd`): hash-pinned, fetched at engine boot, hard-fail on mismatch.
     Eliminates the v0.4.1 sglang regression class (silent COPY-dicts
     drop → identity bytes).
   - Bolt-on tool dispatcher contract (`@codecai/tool-kit` on the
     client side, `codec_dispatcher.py` on each engine fork). Closes
     the `<tool_call>` → dispatch → reinject loop without ever
     decoding the model's stream to text.
   - Picker coverage bench: verifies every `PickReasonCode` enum
     value is reachable from realistic inputs.

3. **Submission cluster**: graduate Codec from "Quasarke's protocol"
   to "neutrally-stewarded open spec":
   - IETF Internet-Draft via the Independent Submission Stream
     (`docs/submissions/ietf-draft-codec-00.md`).
   - Open Inference Protocol (OIP v2) binary-transport extension
     proposal (`docs/submissions/oip-proposal.md`).
   - Reproducible sustainability artefact
     (`packages/bench/scripts/energy_bench.py` +
     `packages/bench/docs/ENERGY_METHODOLOGY.md`).

**Wire-compatibility audit:** v0.4.1 → v0.5.0 is **non-breaking**
(diff against `spec/versions/v0.4.md` shows only prologue rewrites,
the v0.4-OQ4 strike-through, and additive subsections under "v0.5
amendments"; no removed wire fields, no field-semantics changes, no
reassigned frame-type bytes, no canonical-bytes format changes, no
removed discovery paths, no closed-enum tightening, no previously-
optional field made mandatory).

**Open questions** (target v0.6: see `spec/proposals/v0.6-prompt-dialects.md`):

1. Capability bitmap + OPTIONS-preflight contract (deferred from
   v0.5: needs `spec/CAPS_REGISTRY.md` authored first).
2. Delta-varint base_id carriage (per-frame vs mid-stream refresh).
3. Multi-dict per origin for multi-tenant deployments.
4. GPU-quantize fallback semantics (silent vs raise on non-CUDA).
5. Bolt-on dispatch failure modes (hard-fail / drop+warn /
   degraded text-fallback as default).
6. Picker `reason_code` open vs closed enum across stacks.
7. Bidirectional duplex over HTTP/2 multi-stream vs HTTP/1.1
   dual-stream.
8. ~~TGI integration drop-in compatibility~~ **DROPPED.** Hugging Face
   TGI is treated as a dead project as of 2026-05-17; not in the
   v0.5+ engine cohort. See `[[project-codec-engine-cohort-no-tgi]]`.

---

## Lifecycle summary (visual aid)

```
v0.2 concerns             ─┐
                           ├─→ resolved ────┐
v0.2 open questions       ─┘ (some) by v0.3 │
                                            ├─→ remaining items
                                            │   carry forward
v0.3 concerns + open ─┐                     │   (each version's
                      ├─→ resolved ─┐       │    section never
v0.4 concerns + open ─┘ (some) by   │       │    deleted, just
                       v0.4         ├─→ ────┴── annotated
v0.4 still-open ───────────────────→            with **Resolved.**
                       (target v0.5)            once closed)
```

The point is **lineage preservation**. A future maintainer reading
any `spec/versions/v0.X.md` can trace why every closed open-question
got closed and in which version, without spelunking through git
blame.

---

## Mechanics: where the per-version sections live

- `spec/versions/v0.X.md` (one per version) carries the actual
  `## Open questions (v0.X)` blocks. Each later version's snapshot
  inherits the older versions' open-questions blocks (carried
  forward verbatim, with **Resolved.** annotations updated as
  closures land).
- `spec/PROTOCOL.md` is a thin navigation index pointing at the
  versions/ directory; it is not normative on its own.
- This document (`docs/PROTOCOL_VERSION_HISTORY.md`) describes the
  convention and snapshots the lineage at release-cut.
- `docs/RELEASE_CHECKLIST.md` §4 enforces the convention.

When a future version is cut (say, v0.5):

1. Copy the current latest `spec/versions/v0.4.md` to
   `spec/versions/v0.5.md`. Update the title + disclaimer block.
2. Apply v0.5's additive wire changes inside the new file.
3. **In every existing `versions/v0.X.md`** (v0.2, v0.3, v0.4):
   strike-through + `**Resolved.**` on items v0.5 closes. Older
   files' wire-spec text stays unchanged; only the open-questions
   blocks at the bottom evolve.
4. Append new `## Open questions (v0.5)` section to v0.5.md.
5. Update this document's "Current state" snapshot to reflect the
   new resolutions and add the v0.5 entry.
6. Update `spec/PROTOCOL.md` (the index) to list v0.5 as the new
   "current".
7. The release-issue's §4 checkbox is ticked only when all of the
   above are in sync.
