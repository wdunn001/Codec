# Codec changelog

User-facing changes per release. Per-version wire-spec snapshots live
under `spec/versions/v0.X.md`; this file is the narrative.

The list is reverse-chronological. Each entry summarises what a
consumer of the npm / PyPI / NuGet / crates.io / Maven Central /
Docker Hub artifacts sees change between versions.

---

## v0.4 — 2026-05-11

**Theme: safety-policy negotiation as a TLS-style capability axis, plus
the cross-stack docs / bench / versioning infrastructure that makes
this and future cuts auditable.**

### Wire-protocol additions (additive over v0.3; no field removals, no
closed-enum tightening, no canonical-bytes changes)

- `HELLO.accept_safety_policies` — clients declare which policy IDs (or
  `"*"`) they're willing to talk to. New optional field; absent on
  v0.3 clients (server treats as `["*"]`).
- `READY.safety_policy_id` + `READY.safety_policy_hash` — server
  declares the sanitized policy it's enforcing. Both optional;
  absent on v0.3 servers (client falls back to "unknown policy").
- `finish_reason: "policy_violation"` — new enum value on the streaming
  completion frame. v0.3 clients see this as an unknown string and
  treat it as a generic terminal frame.

### New artifacts

- **`@codecai/web-safety`** (`packages/web-safety/`) — optional sibling
  to `@codecai/web`. Ships:
  - Always-on **prefilter** (secrets / PII / Shannon-entropy catch-all,
    framework-free SafetyGate state machine) — catches doomed prompts
    in the browser before they hit the wire.
  - **Classifier registry** with two opt-in classifiers: Prompt Guard
    86M via Transformers.js (default tier), Llama Guard 3 1B via
    codec-web-llm (opt-in WebGPU tier). Same 14-category Llama Guard
    taxonomy as the server-side classifier so policy decisions are
    symmetric across hosts.
  - 62 tests, no host-framework dependency.
- **`spec/safety-policy.schema.json`** — sanitized publishable policy
  descriptor (categories + actions + classifier family + summary
  stats; never operator-internal banned-id lists or thresholds).
- **`.well-known/codec/policies/<id>.json`** discovery + content-
  addressed `sha256/<hex>.json` sibling.
- **`@codecai/maps-cli policies-{validate, sanitize, hash, well-known}`**
  subcommands.

### Cross-language descriptor parity (six clients)

- `SafetyPolicyDescriptor` + `discoverSafetyPolicy` / `load_safety_policy`
  added in every client lib. Canonical-bytes hashing (2-space JSON +
  trailing newline + null-omitted) is byte-identical across TS /
  Python / Rust / .NET / Java / C, so `safety_policy_hash` matches
  across the stack.

### codec-supervisor (the operator side)

- `safety.py`: InternalPolicy + PublishedDescriptor + `sanitize()`
  pipeline. Internal banned-token-ID lists / classifier thresholds /
  multi-token patterns are stripped before publish; the descriptor a
  client sees never contains them.
- `safety_logits.py`: vLLM-compatible `BannedTokenLogitsProcessor`.
- `safety_aho_corasick.py` + `safety_token_matcher.py`: multi-token
  banned-pattern matching over int alphabets (Aho-Corasick over the
  vocab token-id sequence).
- `safety_streaming.py`: delay-k decisioning state machine
  (Streaming Content Monitor / arxiv 2506.09996).
- `safety_classifier.py` + `safety_classifiers/`: pluggable
  `SafetyClassifier` Protocol + registry. Three v1 implementations:
  Llama Guard 3 1B (14-category), ShieldGemma 2B (4-category),
  embedding-space (engine-hidden-state, no detok). Each has a
  generator-DI constructor so tests run without weights.
- `safety_adversarial.py`: TokenBreak / EchoGram / glitch-token
  helpers complementing banned-id lists.
- `admin_safety.py` + `admin/` (React + Vite): authoring UI mounted
  at `/admin/policies/*`. Policy revisions are versioned and
  content-addressed.
- 159 tests, all classifiers test-without-weights via the generator
  injection pattern.

### Tokenizer / BPE corrections

- **BPE special-token pre-scan** in every encoder
  (`@codecai/web`, `codecai`, `codec-rs`, `Codec.Net`, `ai.codec:codec`).
  Before this fix, `BPETokenizer.encode("<|im_start|>...<|im_end|>")`
  on Qwen-2.5 split chat-template delimiters into 6 byte-level
  tokens each (`<`, `|`, `im`, `_start`, `|`, `>`) instead of
  emitting the single atomic vocab ID (151644 / 151645). Affected
  every model with `<|...|>` chat / tool-call / FIM specials —
  Qwen-2 / Qwen-2.5, Llama-3.1+, Phi-3 / Phi-4, DeepSeek, Gemma.
  Bug visible because Qwen-2.5-0.5B is small enough that wrong
  tokenization produces visibly incoherent replies.
- **`(?i:...)` desugar in `@codecai/web/bpe.ts`** — GPT-2-family
  pre-tokenizer patterns use the ES2025 RegExp Pattern Modifiers
  inline-flag group that throws on Chrome <125, iOS Safari <18,
  Firefox <132, Node <23. The encoder now rewrites
  `(?i:abc)` → `(?:[aA][bB][cC])` as the third fallback, so BPE
  encoding works on every shipped mobile-leaning runtime.
- **`pre_tokenizer_program` op-list** — runtime ports added to
  `codec-rs` (new `pretok_program.rs` module) so the Rust BPE works
  on Qwen-2 / Llama-3 / Phi-4 / cl100k_base maps for the first
  time (the `regex` crate doesn't support `(?i:...)` or `\s+(?!\S)`).
- **codec-maps refreshes** (companion repo): all 11 byte_level maps
  now carry `pre_tokenizer_program` field. New ops added: `literals`
  (case-sensitive), `letters.lead_space`, `numbers.lead_space`,
  `letters_cased` (title + upper kinds, with `(?i:)` trailing
  contractions), `punct_run.trailing_chars`. Compiler recognises
  the older-OpenAI shape (p50k_base / r50k_base) and the
  cased-letter shape (o200k_base / mistral-nemo).
- **convert-tiktoken merge derivation fix** in codec-maps: the
  previous `max(rank(left), rank(right))` heuristic picked splits
  that aren't reachable via greedy BPE from initial bytes — so
  vocabulary tokens like `Hello` on o200k_base were *encoded as*
  `["H", "ello"]` instead of `[13225]`. Replaced with Karpathy-style
  greedy-BPE simulation that emits reachable splits. Affected every
  shipped OpenAI tokenizer in codec-maps; now HF-byte-identical.
- **HF Sequence pretokenizer mapping** for smollm2 / falcon /
  deepseek-v3: the BPE merges happen to not bridge the boundaries
  HF's Sequence pretokenizer introduces, so a single regex + program
  produces HF-byte-identical IDs without a schema extension.

### Documentation infrastructure

- **`spec/PROTOCOL.md` restructured** from a 1555-line monolith into
  a 95-line nav index. Per-version snapshots live at
  `spec/versions/v0.{2,3,4}.md`. Each version is a frozen wire-text
  block plus a LIVING `## Open questions (v0.X)` block that evolves
  across releases per the convention in
  `docs/PROTOCOL_VERSION_HISTORY.md`.
- **`docs/RELEASE_CHECKLIST.md`** (12 phases) — formalises the gate
  between feature work and a published cut. Binding from v0.4
  forward.
- **Versioning policy codified** in `spec/versions/v0.4.md`: minor
  versions are wire-additive only; breaking changes require a major
  bump. This was the v0.4 contribution that produced the discipline
  to retroactively audit v0.2 and v0.3 as wire-additive sequences.

### Benchmark surface

- New `packages/bench/scripts/run-all-token-benches.sh` runner +
  6 per-language `token_bench` drivers (Python / TS / Rust / .NET /
  Java / C). Measures encode + decode time over a fixed golden
  corpus per language. Output aggregated into MATRIX.md §X.
- `aggregate.py.fmt_bytes` now emits explicit `b` (byte) suffix on
  bare numeric values — reviewer feedback after the
  2026-05-09T17-09-35Z run flagged unsuffixed integers as confusing.
- Fresh run at `packages/bench/results/2026-05-11T00-12-00Z/`:
  - **24/24 unanimous on all 3 engines** (llama.cpp, sglang, vllm)
    across 6 client languages.
  - sglang 2K-token reduction: **291 b dict-zstd (1,707×)**.

### Wire numbers, v0.3.x → v0.4 (no per-cell change — v0.4 is
wire-additive over v0.3, so the same payloads compress identically;
the additions are protocol-level negotiation, not in-frame data):

| Engine     | v0.3.x best @ 2K | v0.4 best @ 2K |
|---|---:|---:|
| llama.cpp  | 16.1 KB gzip (32.8×) | 16.1 KB gzip (32.8×) |
| sglang     | 291 b dict-zstd (1,707×) | 291 b dict-zstd (1,707×) |
| vllm       | 3,874 b gzip (137×) | 3,874 b gzip (137×) |

Cross-language equality after the BPE special-token fix:
**6/6 byte-identical** on every Codec cell (was 6/6 before too —
the BPE bug affected encode, not the wire-decode path the matrix
measures).

---

## v0.3.4 — 2026-05-09

Latent modality first end-to-end run validated on the lab.

(see `git log v0.3.0..v0.3.4` until this file is back-filled with
narrative entries.)

## v0.3.2 — 2026-05-09

MCP leaf-mode `_meta` wire-shape change. The earlier `_codec_meta`
sibling-content-block form was rejected by the MCP SDK's
ContentBlockSchema; the new per-block `_meta` field carries the
leaf-tokenization payload on existing text content blocks.
`@codecai/mcp-leaf` reader keeps back-compat for both shapes during
the v0.3.x transition window.

## v0.3.0 — earlier in 2026-05

Latent modality added — VAE latents on the wire across seven
[pipelines](spec/PIPELINES.md). First customer-facing version.

## v0.2.x — 2026-04

Initial release surface: text-token modality, msgpack/protobuf
frames, transport-compression negotiation (`identity` / `gzip` /
`br` / `zstd` + `dict-zstd` for sglang).
