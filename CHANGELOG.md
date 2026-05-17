# Codec changelog

User-facing changes per release. Per-version wire-spec snapshots live
under `spec/versions/v0.X.md`; this file is the narrative.

The list is reverse-chronological. Each entry summarises what a
consumer of the npm / PyPI / NuGet / crates.io / Maven Central /
Docker Hub artifacts sees change between versions.

---

## Unreleased — libcodec size-strip option + `@codecai/tool-kit` setup (2026-05-17)

### libcodec: optional BPE encoder for embedded / IoT builds

New CMake option `CODEC_WITH_BPE_ENCODER` (default ON) lets embedded / IoT consumers drop the BPE encoder + Translator + pretok-program runtime + Unicode tables at build time. Decode-only firmware, observers/middleware that route raw token streams, and tools built on the `@codecai/tool-kit` pre-cached pattern never call runtime BPE — for them the ~25 KB of compiled code + data is dead weight.

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=MinSizeRel -DCODEC_WITH_BPE_ENCODER=OFF
```

- libcodec.a: **128,278 → 103,178 bytes** on x86-64 Linux Release (~25 KB lighter). Cortex-M / Xtensa / RISC-V cross-compiles save proportionally more after `-Os` strips Unicode tables.
- Decode-side API surface (Detokenizer, ToolWatcher, stream decoders, frame codec, compression, safety-policy) unchanged.
- Public-API symbols for the dropped surface still link — `codec_bpe_encoder_new` / `codec_bpe_encode` / `codec_translator_new` / `codec_translator_translate` / `codec_translator_finish` / `codec_pretok_run_program` / `codec_pretok_run_metaspace` and their `_free` counterparts return `CODEC_ERR_NOT_BUILT` (new in `codec_status_t`) so consumer code doesn't need `#ifdef` guards.
- BPE / Translator / pretok tests skipped from the test suite when the option is OFF; tests pass at 12/12 ON and 9/9 OFF.
- `codec_status_t` gains `CODEC_ERR_NOT_BUILT = -10` (additive — existing callers see an `int` they didn't recognize, treat as generic error).
- CMakeLists version bumped 0.4.0 → 0.4.1 (was a stale leftover).

### Docs honesty pass on libcodec

User asked "why is libcodec decode only" — answer was it isn't, hadn't been for a while; I'd been quoting a stale README section. Fixed `packages/c/README.md` and the root README polyglot-clients table to correctly list `Detokenizer · BPEEncoder · ToolWatcher · Translator · stream decoders · pretok-program runtime (no PCRE2, generated Unicode tables)` for the C99 row. Roadmap items "C BPE encoder + Translator" dropped — they shipped.

### @codecai/tool-kit setup



Companion: setup pass on the codec-tool-kit package which had been scaffolded earlier but never integrated into the family:

- **Renamed** `codec-tool-kit` → `@codecai/tool-kit` for consistency with the rest of the @codecai/* family.
- **Bumped** to `0.4.1` to join the family at the current cohort version.
- **Added** to the `publish-npm.yml` workflow alongside web, web-safety, web-llm, maps-cli, mcp-leaf — same idempotent skip-if-version-exists guard.
- **Built reference tool**: `packages/codec-tool-kit/examples/time-tool/` (`@codecai/codec-time-tool` on npm) — runnable bolt-on with manifest + build-time precache script + runtime + CLI demo + tests (4/4 pass). Returns the current UTC time as pre-cached token IDs, demonstrating the gateway-pays-nothing pattern end-to-end. Companion to `codec-time-leaf` (which demonstrates the leaf-mode wrap pattern for existing MCP servers).
- **Workspace** registered the new example as a workspace member.
- **Docs**:
  - codec-website: new `/docs/codec-tool-kit/` page mirroring the `/docs/codec-leaf/` format
  - codec-website: `/protocol-map/` MCP tool-calls section now explains both SDKs side-by-side (leaf wraps existing servers, tool-kit authors new ones)
  - root README updated: `codec-tool-kit` → `@codecai/tool-kit` references; example tool linked alongside

SDK tests stay green (16/16). Reference tool tests green (4/4). No spec changes; no wire changes. Just promotes a scaffolded package to a published, referenced, working family member.

---

## v0.4.1 — 2026-05-16

**Theme: protocol-only honesty + cross-client dict-zstd interop + bench gate hardening.**

A patch release that closes three correctness gaps the v0.4.0 cross-stack
matrix had been silently papering over: (a) the §1 headline ratio
conflated protocol efficiency with model-output behaviour; (b) only Python
actually decoded dict-zstd responses, the other 5 clients silently
produced garbage; (c) the bench's unanimity check only inspected wire
bytes, not whether anything decoded. Each of these is now fixed AND
defended by regression tests so the next release can't re-introduce them.

### Wire-protocol changes

**None — v0.4.1 is wire-additive over v0.4 and decodes byte-identically
on every v0.4 client.** A v0.4 server emits the exact same frames it did
at v0.4.0; v0.4.1 client improvements are purely consumer-side fidelity
(handling dict-zstd correctly that v0.4 clients silently mishandled).

### Client packages — dict-zstd interop landed across the family

Before v0.4.1, only `codecai` (Python) actually decoded Codec's dict-zstd
responses. The other 5 clients either silently returned the compressed
bytes (TS/Web, C) or errored loudly (Rust, Java, .NET). The bench's
wire-byte unanimity check missed this because it only verified the
clients *received* the same bytes, not that they *decoded* the same
tokens. v0.4.1 ships real dict-zstd support in all 6 clients:

- **`@codecai/web` 0.4.1** — new `compression.ts` (`hashZstdDict`,
  `selectZstdDictForResponse`, `CodecZstdDictError`) matching Python's
  API shape. Demo bench client uses Node 22.15+ built-in
  `zlib.zstdDecompressSync({dictionary})` (no new npm dependency).
- **`codec-rs` 0.4.1** — new `compression` module + 17 unit + integration
  tests against the shared interop fixture; demo bench wires through
  `zstd::stream::Decoder::with_dictionary`.
- **`Codec.Net` 0.4.1** — new `Compression.cs` + 18 tests; demo uses
  `ZstdSharp.Port` for portable pure-C# dict decompression.
- **`ai.codec:codec` 0.4.1** — new `Compression.java` +
  `CodecZstdDictError`; demo uses `zstd-jni` `ZstdDictDecompress`.
  *Local build only — Maven Central publish deferred to a follow-up.*
- **`libcodec` 0.4.1** — new `codec_compression.{c,hpp}` + 12 tests +
  CMake integration; demo links libzstd via `pkg-config`.
- **`@codecai/mcp-leaf` 0.4.1** — fixed an unrelated hash-validation
  ordering bug that was masking the validation error behind a fetch
  failure in CI.

Every client's dict-zstd test loads the same fixture
(`packages/bench/fixtures/dict-zstd-interop/`, captured from a real
`codec-sglang:v0.4.1` zstd response) and asserts byte-identical
decompression + msgpack round-trip yielding the same 32 token IDs.
Cross-client interop now provable in CI, not just hoped for.

### Engine forks

- **`wdunn001/llama.cpp`** gains brotli + zstd `Content-Encoding`
  (was identity + gzip only). New `tools/server/codec_zstd_dict_registry.{hpp,cpp}`
  loads dict bytes from `CODEC_ZSTD_DICT_*_PATH` env at startup +
  hash-verifies. New `codec_brotli_streamer` + `codec_zstd_streamer`
  classes in `server-http.cpp` mirror sglang's Python encoders, including
  the no-per-chunk-flush fix. Negotiator in `server-context.cpp` honors
  spec preference order zstd > br > gzip > identity with dict-gate +
  emits `Codec-Zstd-Dict: sha256:<hex>` on every zstd response.
  `GET /codec/schema` endpoint also added (was missing from the C++ port).
- **`wdunn001/sglang` + `wdunn001/vllm`** — fixed
  `_compress_brotli`'s per-chunk `flush()` that was inflating small
  streams (64-token msgpack: 1,159 B vs 975 B identity). Removed; brotli
  now compresses correctly across all stream sizes. New
  `test_codec_compression.py` (7 tests) guards the regression.

### Bench infrastructure

- **Synthetic-stream wire bench** (`packages/bench/scripts/synthetic_wire_bench.py`)
  — pure-library wire measurement. 8 sizes × 4 corpora × 4 encodings;
  no engine, no model. The new §1 headline in MATRIX.md/RESULTS.md.
  Honest range: ~4-17× over identity on typical streams, 100-400× on
  structurally-repetitive ones.
- **Aggregator gate hardening** — `aggregate.py` now (a) exits non-zero
  on any cell with a non-empty `error` field, (b) reports both
  wire-unanimous AND decode-unanimous counts in §2. The old wire-only
  check let cells where 3/6 clients errored on decode get reported as
  "unanimous" (because their wire bytes happened to match).
- **Engine-image acceptance gate** (`packages/bench/tests/test_engine_acceptance.py`)
  — 9 protocol probes (`/codec/schema`, spec preference-order
  compression negotiation, `Codec-Zstd-Dict` header presence,
  detokenize-bypass) that run BEFORE `run-all-langs.sh` invokes the
  bench. Catches the "image was built from a stale Dockerfile"
  regression class in ~15s instead of via the bench's headline
  aggregator.

### supervisor + release checklist

- **`codec-supervisor`** logs WARNING at startup if `brotli` or
  `zstandard` Python modules fail to import (catches v0.4.1's
  stale-Dockerfile regression class loudly).
- **`docs/RELEASE_CHECKLIST.md` §3** mandates synthetic-stream bench
  before cross-stack bench + the engine acceptance gate before
  invoking `run-all-langs.sh`.
- **New `packages/bench/methodology/SCHEMA.md` § Synthetic-stream wire
  bench** documents the methodology.

### Bench numbers (v0.4.1 reruns)

| Surface                                    | Headline                                                  |
|--------------------------------------------|-----------------------------------------------------------|
| §1 protocol-only (msgpack, 2K, by content) | uniform 4.8× / comma-dom 6.6× / low-ent 16.6× / cyclic 392× |
| §1b engine-output @ 2K msgpack+dict-zstd   | sglang 1,707× / vllm 137× / llama.cpp fp16 3,868×        |
| Cross-vocab translator (2K, Llama-3→Qwen-2)| 15.1× wire (Codec msgpack+gzip vs JSON-SSE+gzip)         |
| Agent loop (mock get_weather)              | 16.9× wire / 8.8× total latency                          |
| Agent loop (SearXNG live)                  | 18.0× / 1.65×                                             |
| Agent loop (MetaMCP Time MCP)              | 17.0× / ~neutral                                          |
| MCP leaf-mode (tool-result-side)           | tiny result (~30 char timestamp): **+211 B wire**, **12.4× consumer-CPU speedup** (0.052 ms → 0.004 ms); leaf wire scales linearly with text-block length, crossover ~300+ chars |
| ToolWatcher microbench                     | 481 Mtok/s vs detokenize 18 Mtok/s → 26.7× speedup       |
| Decode unanimity across 6 clients × 3 eng. | **24/24 wire AND 24/24 decode unanimous on every engine** |

### Docker Hub publishes

All 7 engine images at `v0.4.1`:
- `wdunn001/codec-{sglang,vllm,llamacpp}:v0.4.1` (lab builds, pushed manually)
- `wdunn001/codec-{comfyui,diffusers,metamcp,time-leaf}:v0.4.1` (codec-supervisor release.yml)

### Package publishes

- npm: `@codecai/web` 0.4.1, `@codecai/web-safety` 0.4.1, `@codecai/maps-cli` 0.4.1, `@codecai/web-llm` 0.4.1, `@codecai/mcp-leaf` 0.4.1
- PyPI: `codecai` 0.4.1
- crates.io: `codec-rs` 0.4.1
- NuGet: `Codec.Net` 0.4.1
- Maven Central: deferred (library JAR built + tested locally; publish revisits at v0.4.2)

### Spec proposals (for v0.5)

Two design docs added to `spec/proposals/`:
- `v0.5-prompt-dialects.md` — per-concept opportunistic substitution
  dictionaries at the language layer (concept → cheapest model-understood
  representation; e.g. emoji, CJK char, math symbol, abbreviation), as
  the third stackable compression layer alongside Codec's framing and
  dict-zstd wire layers.
- `packages/bench/docs/COMPRESSIBLE_PROMPTS.md` — prompt-engineering
  patterns that produce naturally compressible model output (structured
  schemas, vocabulary locks, restate-then-answer, tabular formats).

Both filed as v0.5 / v0.6 candidates.

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
