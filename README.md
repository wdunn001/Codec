# Codec

**A control-plane primitive for AI inference.**

Codec is the substrate that lets gateways, routers, agents, tool dispatchers, and observers operate on raw token IDs end-to-end. No detokenize on the hot path. No JSON-parse per token. No UTF-8 round-trip at every hop. Compression and wire reduction are byproducts of the framing — what you actually buy is the ability to run the inference layer like infrastructure.

```
Today's stack:   model → uint32 IDs → UTF-8 → JSON/SSE → wire → JSON → UTF-8 → uint32 IDs → model
                                       └── detokenize/retokenize at every hop ──┘
Codec stack:     model → uint32 IDs → binary frames → wire → uint32 IDs → model
                                       └── text only at the edges that need it ──┘
```

Three primitives fall out of the layering:

- **Wire-native streaming.** Length-prefixed binary frames over plain HTTP, the same wire on every engine in the [cross-stack matrix](packages/bench/results/2026-05-09T17-09-35Z/MATRIX.md). Compression is a layer on top: 71× smaller on a short chat reply, **1,707×** on a 2 K-token agent stream (msgpack + dict-zstd), TTFB within 1 ms of JSON-SSE. *Receipts, not pitch.*
- **Tool-call dispatch without detokenization.** `ToolWatcher` matches reserved control IDs in the raw token stream — single 32-bit compare per token, ~100× faster than detokenize+regex. Lives canonically in the [MetaMCP gateway](https://github.com/wdunn001/codec-supervisor/blob/main/Dockerfile.metamcp) but the primitive works in any inference proxy, agent runtime, or middleware.
- **Cross-vocab agent handoff.** `Translator` carries one model's stream into another's vocabulary via one in-process detokenize/retokenize step. UTF-8 never crosses the wire. Llama-3 → Qwen-2 at 2 K tokens: 30 % less bridge CPU on 15× fewer wire bytes; both paths emit byte-identical Qwen-2 IDs.

Source-available under [BSL 1.1](LICENSE). Patent posture in [PATENTS.md](PATENTS.md).

---

## What ships today

> **Latest release: v0.3.x — all three pathways measured end-to-end on the lab.**
>
> | Pathway | Wire reduction | Image |
> |---|---:|---|
> | **Text-tokens** (sglang / vLLM / llama.cpp) | **13–18×** vs JSON-SSE | `wdunn001/codec-{sglang,vllm,llamacpp}:latest` |
> | **MCP tool calls** (metamcp + leaf-mode bypass) | **3.6×** on `tools/list` (40 tools) | `wdunn001/codec-metamcp:v0.3.2` + [`codec-time-leaf`](https://hub.docker.com/r/wdunn001/codec-time-leaf) |
> | **Latents** (diffusers / ComfyUI) | **3.9×** int4 vs raw, ~5–10× vs JPEG | `wdunn001/codec-diffusers:v0.3.4` |
>
> The `[Codec][leaf]` log line fires end-to-end — the architectural target
> (gateway as transparent ID pipe, tokenizer at the leaf) is observable on real
> wire traffic. Customer-facing release notes: [What's new](https://codecai.net/changelog/)
> · engineering changelog: [GitHub Releases](https://github.com/wdunn001/Codec/releases)
> · visual diagram of all three pathways: [/protocol-map](https://codecai.net/protocol-map).
>
> **v0.4 in flight** — safety-policy negotiation as a TLS-style
> capability axis + per-version documentation framework + the
> formal [versioning policy](spec/versions/v0.4.md#versioning-policy)
> — minor versions are wire-additive; breaking changes require a
> major bump. Six client languages ship descriptor-parity. Operator-
> side enforcement primitives (banned-token logits processor,
> multi-token Aho-Corasick matcher, embedding-space classifier
> scaffolding, classifier registry, delay-k streaming decisioning)
> live in [`codec-supervisor`](https://github.com/wdunn001/codec-supervisor).
> Publish gated on [the release checklist](docs/RELEASE_CHECKLIST.md).

### Spec

| Surface | Where | What it is |
|---|---|---|
| **Wire spec (index)** | [`spec/PROTOCOL.md`](spec/PROTOCOL.md) | Navigation index — lists each shipped version + companion docs |
| **— v0.4** | [`spec/versions/v0.4.md`](spec/versions/v0.4.md) | Latest. v0.3 surface + safety-policy negotiation + versioning policy |
| **— v0.3** | [`spec/versions/v0.3.md`](spec/versions/v0.3.md) | v0.2 surface + image/video latent modality |
| **— v0.2** | [`spec/versions/v0.2.md`](spec/versions/v0.2.md) | Initial — text-token modality, msgpack/protobuf frames |
| **Map schema (text)** | [`spec/tokenizer-map.schema.json`](spec/tokenizer-map.schema.json) | v2.1 — vocab + merges + encoder + optional `pre_tokenizer_program` + `tool_calling` block (auto-derived from chat templates) |
| **Map schema (latent)** | [`spec/latent-space-map.schema.json`](spec/latent-space-map.schema.json) | v0.3 — latent-space identity, shape/dtype, `vae_scale_factor`, accepted pipelines, decoder reference, per-pipeline zstd dicts |
| **Safety policy schema** | [`spec/safety-policy.schema.json`](spec/safety-policy.schema.json) | v0.4 — sanitized publishable descriptor (categories + actions + classifier family + summary stats; never operator-internal banned-id lists or thresholds) |
| **Pretok program spec** | [`spec/PRETOKENIZER_PROGRAM.md`](spec/PRETOKENIZER_PROGRAM.md) | v1 op-list form the maps-cli compiles regex pre-tokenizers into; unblocks the C BPE encoder |
| **Pipelines spec** | [`spec/PIPELINES.md`](spec/PIPELINES.md) | v0.3 — normative forward + inverse math for the 7 latent transforms (raw / int8 / int4 / int8-adaptive / int4-adaptive / delta+int8 / delta+int4) |
| **Release checklist** | [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) | v0.4 — gate every release passes through (validation → coverage → benches → docs → READMEs → website → tags → publishes) |
| **Version history convention** | [`docs/PROTOCOL_VERSION_HISTORY.md`](docs/PROTOCOL_VERSION_HISTORY.md) | v0.4 — how per-version `## Open questions (v0.X)` sections evolve across releases |

### Polyglot clients

Six reference implementations, byte-identical Codec frames per cell across all of them on the [cross-stack matrix](packages/bench/results/2026-05-09T17-09-35Z/MATRIX.md) — sglang, vllm, and llama.cpp all report 24/24 unanimous on every Codec cell.

| Lang | Package | Registry | Surface |
|---|---|---|---|
| TypeScript / JS | [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) | npm 0.4.0 | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · pretok-program runtime · `LatentStreamEncoder` / `Decoder` (v0.3) · `tool_calling` block · `SafetyPolicyDescriptor` + `discoverSafetyPolicy` (v0.4) |
| TypeScript / JS | [`@codecai/web-safety`](packages/web-safety) | npm 0.4.0 (v0.4 candidate) | Optional sibling — `scanText` prefilter (secrets/PII regex + Shannon entropy) · `SafetyGate` state machine · `SafetyClassifier` interface + registry · Prompt Guard 86M (Transformers.js) + Llama Guard 3 1B (codec-web-llm) classifiers (v0.4) |
| Python | [`codecai`](https://pypi.org/project/codecai/) | PyPI 0.1.0 (local 0.2.0) | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · `SafetyPolicyDescriptor` + `discover_safety_policy` (v0.4) |
| .NET | [`Codec.Net`](https://www.nuget.org/packages/Codec.Net) | NuGet 0.1.0 (local 0.2.0) | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · `SafetyPolicyDescriptor` + `SafetyPolicy.{Validate,Hash,Load,Discover}Async` (v0.4) |
| Rust | [`codec-rs`](packages/rust) | local 0.1.0 (crates.io publish queued) | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · `SafetyPolicyDescriptor` + `discover_safety_policy` (v0.4, `http` feature) |
| Java | [`ai.codec:codec`](packages/java) | local 0.1.0 (Maven Central publish queued) | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · `SafetyPolicyDescriptor` + `SafetyPolicy.{validate,hash,load,discover}` (v0.4) |
| C99 | [`libcodec`](packages/c) | vcpkg / FetchContent 0.2.0 | Detokenizer · ToolWatcher · stream decoders (BPE + Translator pending Unicode tables) · `codec_safety_policy_{from_json,verify_sha256,well_known_url}` (v0.4, parser + URL + hash-verify only — descriptor publishing is in the higher-level languages) |

### Tooling and registry

| Surface | Where | What it is |
|---|---|---|
| **Map generator** | [`@codecai/maps-cli`](https://www.npmjs.com/package/@codecai/maps-cli) | npm 0.3.0 — generate maps from HF `tokenizer.json`, plus `translate` / `translation-table` for cross-vocab analysis; v0.4 adds `policies-{validate,hash,sanitize,well-known}` subcommands for safety-policy descriptors |
| **Map registry** | [`codec-maps`](https://github.com/wdunn001/codec-maps) | 14 model families / 70+ aliases, served via jsDelivr |
| **Safety supervisor** | [`codec-supervisor`](https://github.com/wdunn001/codec-supervisor) (v0.4 admin app + classifier registry, in flight) | Operator-side policy admin (FastAPI REST at `/admin/policies/*` + Vite/React admin UI), per-policy `BannedTokenLogitsProcessor`, multi-token Aho-Corasick matcher, Llama Guard 3 1B + ShieldGemma 2B classifier sidecars (optional `classifiers` extra), embedding-space classifier scaffolding |

### Inference engines

| Engine | Where | Modality | What it is |
|---|---|---|---|
| **vLLM** | [`wdunn001/codec-vllm`](https://hub.docker.com/r/wdunn001/codec-vllm) (Docker) | text | `stream_format` on `/v1/completions` + dedicated `/v1/completions/codec` |
| **SGLang** | [`wdunn001/codec-sglang`](https://hub.docker.com/r/wdunn001/codec-sglang) (Docker) | text | Same surface, mirrored into SGLang |
| **llama.cpp** | [`wdunn001/codec-llamacpp`](https://hub.docker.com/r/wdunn001/codec-llamacpp) (Docker) | text | Same surface in `llama-server` (covers Ollama too) |
| **ComfyUI** | [`wdunn001/ComfyUI`](https://github.com/wdunn001/ComfyUI/tree/feat/codec-latent-transport) (fork) | latent (v0.3) | VAE latents on the wire; image + video. Image: [`wdunn001/codec-comfyui`](https://hub.docker.com/r/wdunn001/codec-comfyui). |
| **diffusers** | [`wdunn001/diffusers`](https://github.com/wdunn001/diffusers/tree/feat/codec-latent-transport) (fork) | latent (v0.3) | Reference latent server + bench/golden perceptual-conformance reference. Image: [`wdunn001/codec-diffusers`](https://hub.docker.com/r/wdunn001/codec-diffusers). |

### Gateway / control-plane

| Surface | Where | What it is |
|---|---|---|
| **MetaMCP** | [`wdunn001/codec-metamcp`](https://hub.docker.com/r/wdunn001/codec-metamcp) (Docker) | Codec wire framing + token-aware tool dispatch at the JSON-RPC seam. v0.3.2+ ships the leaf-mode bypass for Codec-aware tools — recognizes the per-block `_meta['ai.codec/leaf-tokenization']` payload, forwards IDs verbatim, fires `[Codec][leaf]` log. Also loads the MCP-shaped zstd dict at startup. Image: `wdunn001/codec-metamcp:latest` (v0.3.2 currently). |
| **mcp-leaf** | [`@codecai/mcp-leaf`](https://www.npmjs.com/package/@codecai/mcp-leaf) | Tool-author-side helper for the leaf-mode contract. `wrapToolCall(result, meta)` annotates each text block with the per-block `_meta` payload the gateway recognizes; `readCodecMeta(result)` is the receive-side companion (accepts both v0.3.2+ `_meta` shape and the v0.3.0/v0.3.1 legacy sibling-block shape). |
| **codec-time-leaf** | [`wdunn001/codec-time-leaf`](https://hub.docker.com/r/wdunn001/codec-time-leaf) (Docker) + [`@codecai/codec-time-leaf`](https://www.npmjs.com/package/@codecai/codec-time-leaf) (npm) | Reference Codec-aware MCP server (canonical demo of leaf mode). `get_current_time` + `convert_time` tools. |
| **Pre-built images** | [`wdunn001/codec-supervisor`](https://github.com/wdunn001/codec-supervisor) | One Docker image per engine + the gateway: `codec-sglang`, `codec-vllm`, `codec-llamacpp`, `codec-metamcp`, `codec-comfyui` (v0.3), `codec-diffusers` (v0.3), `codec-time-leaf` (v0.3). Released on `v*` tags via the supervisor's `release.yml` workflow. |

---

## Measured impact (cross-stack)

All numbers are real measurements from `packages/bench/`. The headline data set is the cross-stack matrix: three real inference engines × six client languages × 36 cells × 3 payload sizes = 648 SCHEMA-v1 result rows, captured against `wdunn001/codec-{sglang,vllm,llamacpp}` containers on RTX 3090 + Qwen2.5-0.5B-Instruct, temperature 0.0. Full table: [`packages/bench/results/2026-05-09T17-09-35Z/MATRIX.md`](packages/bench/results/2026-05-09T17-09-35Z/MATRIX.md).

**Headline at 2 K tokens** (Python row, Codec msgpack):

| Engine | JSON-SSE baseline | Best Codec wire | Reduction | TTFB |
|---|---:|---:|---:|---:|
| sglang | 485 KB | 291 B (msgpack+dict-zstd) | **1,707×** | 44.7 ms |
| vllm | 518 KB | 3.9 KB (msgpack+gzip) | **137×** | 59.0 ms |
| llama.cpp | 529 KB | 16 KB (msgpack+gzip) | **33×** | 40.8 ms |

**Live A/B against sglang upstream vs Codec patches** (3 wire formats × 4 encodings, same prompt, 64-token completion):

| Path | identity | gzip | br | zstd |
|---|---:|---:|---:|---:|
| JSON-SSE (vanilla upstream) | 15.2 KB | 15.2 KB | 15.2 KB | 15.2 KB |
| JSON-SSE (Codec-patched) | 15.2 KB | 15.2 KB | 15.2 KB | 15.2 KB |
| Codec msgpack | **16.0×** | **68.8×** | 13.4× | 61.5× |
| Codec protobuf | **23.9×** | **69.5×** | 16.8× | 57.4× |

**Per-token cost: 243 B/tok JSON-SSE → 3.5 B/tok Codec + gzip.**

**Polyglot interop** — same wire decoded by Python, .NET, C, and Web clients; wire bytes match exactly across all four. (One `.NET` zstd cell skips because BCL doesn't ship a zstd decompressor; the wire-byte count still matches.)

**End-to-end agent loop** — full two-turn round-trip (prompt → model emits tool call → dispatch → tool result fed back → final answer):

| Tool | JSON-SSE wire | Codec wire | Reduction | JSON total | Codec total | Speedup |
|---|---:|---:|---:|---:|---:|---:|
| mock `get_weather` | 13.7 KB | 809 B | **16.9×** | 134 ms | 124 ms | 1.08× |
| **SearXNG** (live web) | 61.9 KB | 3.4 KB | **18.2×** | 2426 ms | 1954 ms | **1.24×** |
| **MetaMCP** (Time MCP) | 19.6 KB | 1.1 KB | **17.8×** | 686 ms | 551 ms | **1.24×** |

**ToolWatcher CPU microbench** (libcodec, C99, 1M synthetic tokens):

| Path | ns/token | Mtok/s |
|---|---:|---:|
| `codec_tool_watcher_feed` | 0.61 | 1,648 |
| `codec_detokenizer_render` | 60.4 | 16.6 |
| **Speedup** | | **~100×** |

These are reproducible. Bench drivers under [`packages/demo-python`](packages/demo-python), [`packages/demo-dotnet`](packages/demo-dotnet), [`packages/demo-rust`](packages/demo-rust), [`packages/demo-java`](packages/demo-java), [`packages/demo-c`](packages/demo-c), [`packages/demo-web`](packages/demo-web). The cross-stack matrix runner is [`packages/bench/scripts/run-all-langs.sh`](packages/bench/scripts/run-all-langs.sh) and the aggregator is [`packages/bench/scripts/aggregate.py`](packages/bench/scripts/aggregate.py). Full methodology + raw numbers in [`packages/bench/RESULTS.md`](packages/bench/RESULTS.md) and the [cross-stack MATRIX.md](packages/bench/results/2026-05-09T17-09-35Z/MATRIX.md).

---

## What you can do with raw token IDs

Once tokens stay binary the whole way through, primitives that used to require text round-trips collapse into trivial uint32 work. Two ship in every client today:

### `ToolWatcher` — detect tool calls without decoding

Most chat-tuned models delimit tool calls (and reasoning blocks, vision spans, sandbox regions, channel headers) with single-token specials — `<tool_call>` / `</tool_call>` for Qwen 2.5+, `<|python_tag|>` / `<|eom_id|>` for Llama 3.1+, `<think>` / `</think>` for DeepSeek-R1. Detecting *that* a tool call happened is therefore a uint32 compare in the hot loop:

```ts
const watcher = new ToolWatcher(map, '<tool_call>', '</tool_call>');
for await (const frame of decodeStream(resp.body!)) {
  for (const ev of watcher.feed(frame.ids)) {
    if (ev.kind === 'passthrough') forward(nextAgent, ev.ids);  // no decode
    else                            dispatchTool(JSON.parse(detok.render(ev.ids)));
  }
}
```

The watcher never touches the vocab, never allocates a string. ~100× faster than detokenizing the same stream (microbench in `packages/c/examples/bench_watcher.c`). Same primitive covers reasoning blocks, multimodal spans, code-interpreter regions — anything delimited by a `(start, end)` special pair.

Available in: `@codecai/web` · `codecai` · `Codec.Net` · `codec-rs` · `ai.codec:codec` (Java) · `libcodec`.

### `Translator` — cross-vocab agent handoff

When agent A's output feeds agent B as a prompt and the two models have different vocabs, decode-then-reencode through text — *but never put text on the wire*:

```ts
const tr = new Translator(qwenMap, llamaMap);
for await (const frame of decodeStream(resp.body!)) {
  const llamaIds = tr.translate(frame.ids, { partial: !frame.done });
  forward(llamaAgent, llamaIds);
}
```

The text intermediate is purely local. Stateful word-boundary buffering so streaming chunks don't split BPE merges mid-word. Includes a `staticTranslationTable(A, B)` for context-free analysis (vocab overlap, cost estimation).

Available in: `@codecai/web` · `codecai` · `Codec.Net` · `codec-rs` · `ai.codec:codec` (Java). C version pending the Unicode-tables work. The cross-vocab handoff has its own bench cell — measured 30 % less bridge CPU + 15× smaller wire on a Llama-3 → Qwen-2 round-trip at 2 K tokens, byte-identical Qwen-2 output asserted; data in [`packages/bench/results/2026-05-08T01-15-02Z/translator/`](packages/bench/results/2026-05-08T01-15-02Z/translator).

---

## Quick start (browser/Node client)

```bash
npm install @codecai/web
```

```ts
import { loadMap, Detokenizer, decodeStream } from '@codecai/web';

const map = await loadMap({
  url:  'https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json',
  hash: 'sha256:c73972f7a580…',
});
const detok = new Detokenizer(map);

const resp = await fetch('http://localhost:8000/v1/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'Qwen/Qwen2.5-7B-Instruct',
    prompt: 'Explain entropy.',
    stream_format: 'msgpack',
    max_tokens: 256,
  }),
});

for await (const frame of decodeStream(resp.body!, 'msgpack')) {
  output.append(detok.render(frame.ids, { partial: !frame.done }));
}
```

For agent-to-agent (zero text on the wire in either direction):

```ts
import { BPETokenizer } from '@codecai/web';

const tok = new BPETokenizer(map);
const promptIds = tok.encode(userInput);   // pure-JS BPE, exact

await fetch('http://localhost:8000/v1/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: promptIds,                      // OpenAI accepts int[] here
    stream_format: 'msgpack',
    max_tokens: 128,
  }),
});
```

---

## Repository layout

```
spec/
  PROTOCOL.md                       wire format, endpoints, compression negotiation, leaf-mode contract, latent modality
  PRETOKENIZER_PROGRAM.md           v2.1 regex-free pre-tokenizer recipe spec
  PIPELINES.md                      v0.3 latent transport pipelines (forward + inverse math, conformance fixtures)
  tokenizer-map.schema.json         JSON Schema for tokenizer maps (v2.1, with tool_calling block)
  latent-space-map.schema.json      JSON Schema for v0.3 latent-space maps
  WELL_KNOWN_DISCOVERY.md           .well-known/codec/ map publishing protocol
packages/
  web/             @codecai/web                       isomorphic detokenizer + BPE tokenizer + ToolWatcher + Translator + pretok runtime + LatentStreamEncoder/Decoder
  python/          codecai                            Python twin of @codecai/web; codecai.server submodule carries the latent forward encoder
  dotnet/          Codec.Net                          .NET (net8.0) twin
  rust/            codec-rs                           Rust twin (crates.io publish queued)
  java/            ai.codec:codec                     Java twin (Maven Central publish queued)
  c/               libcodec                           C99 detokenizer + ToolWatcher (no deps; vcpkg + FetchContent)
  maps-cli/        @codecai/maps-cli                  generate maps + cross-vocab translate / translation-table; tool_calling auto-derivation
  mcp-leaf/        @codecai/mcp-leaf                  MCP tool-author SDK — wrapToolCall (writer) + readCodecMeta (reader) for the leaf-mode bypass
    examples/time-server/                              reference Codec-aware MCP server (codec-time-leaf), shipped to npm + Docker Hub
  bench/           benchmark suite                    cross-stack matrix · wire / handoff / live / mcp-live / latent-live / compression / watcher / translator
  wire-compress/   standalone Accept-Encoding picker  (zero-dep, framework-agnostic)
  codec-tool-kit/  SDK for Codec-native bolt-on tools (cached IDs in / cached IDs out)
  demo-{web,python,dotnet,rust,java,c}                per-language demo runners
  demo/            high-level agent-to-agent walkthrough
  core/            legacy frame codec                 (kept for compatibility; @codecai/web supersedes)
  client/          legacy TS client                   (kept for compatibility)
dictionaries/      pre-trained zstd dictionaries for the Codec wire (per (vocab, format) for text; per (latent_space, format, pipeline) for v0.3 latents)
article/
  text-is-the-wrong-wire-format.md   the case for Codec
PATENTS.md         patent posture
LICENSE            BSL 1.1 (auto-Apache-2.0 four years post-publication)
COMMERCIAL.md      commercial licensing terms above the $5M threshold
```

Sister repos:

- **[`codec-maps`](https://github.com/wdunn001/codec-maps)** — pre-generated tokenizer dialect maps for common models (Llama, Qwen, Mistral, Phi, Gemma, DeepSeek, Falcon, SmolLM2, Codestral, etc.). Open registry — anyone with a HuggingFace `tokenizer.json` can `npx @codecai/maps-cli generate <tokenizer.json>` and ship a map for their model without waiting on a registry PR. Served via jsDelivr.
- **[`codec-supervisor`](https://github.com/wdunn001/codec-supervisor)** — pre-built Docker images for the four engine + gateway integrations (`codec-sglang`, `codec-vllm`, `codec-llamacpp`, `codec-metamcp`). `docker run` and you're at the wire.
- **[`codec-website`](https://github.com/wdunn001/codec-website)** — source for [codecai.net](https://codecai.net), the marketing + docs front door.
- **[`wdunn001/vllm`](https://github.com/wdunn001/vllm)** — server-side Codec patches: two endpoint paths (`/v1/completions` + `stream_format`, and `/v1/completions/codec` for binary request bodies on huge prompts). Shipped as [`wdunn001/codec-vllm`](https://hub.docker.com/r/wdunn001/codec-vllm).
- **[`wdunn001/sglang`](https://github.com/wdunn001/sglang)** — same surface in SGLang. Shipped as [`wdunn001/codec-sglang`](https://hub.docker.com/r/wdunn001/codec-sglang).
- **[`wdunn001/llama.cpp`](https://github.com/wdunn001/llama.cpp)** — same surface in `llama-server`. Shipped as [`wdunn001/codec-llamacpp`](https://hub.docker.com/r/wdunn001/codec-llamacpp).
- **[`wdunn001/metamcp`](https://github.com/wdunn001/metamcp)** — gateway-side Codec + token-aware tool dispatch at the JSON-RPC seam. Shipped as [`wdunn001/codec-metamcp`](https://hub.docker.com/r/wdunn001/codec-metamcp).

---

## Endpoint design (two paths, same wire)

The Codec server adds three things to an OpenAI-compatible API:

```
POST /v1/completions        + stream_format=msgpack|protobuf   ← Path A: binary out, JSON in
POST /v1/completions/codec                                      ← Path B: binary in + binary out
GET  /codec/schema                                              ← .proto schema
```

**Path A is required.** It works for any prompt size and is the default for browser clients. The request body is plain JSON — `prompt: int[]` already standard in OpenAI's spec.

**Path B is optional.** It accepts `application/x-msgpack` or `application/x-protobuf` request bodies, saving 2–3× bandwidth on huge prompts (>50K tokens) where the JSON `[int, int, ...]` array balloons. Same streaming output as Path A.

Both produce identical wire output. Pick whichever fits your client.

---

## Transport compression (negotiated)

Codec supports optional compression of the response stream via standard HTTP `Accept-Encoding` / `Content-Encoding`. Negotiation is opt-in (PKCE-style) — clients advertise what they support, servers respond with whatever overlap exists, identity is the universal fallback.

| Encoding   | Server | Client | Notes                                          |
|------------|--------|--------|------------------------------------------------|
| `identity` | MUST   | MUST   | The fallback. Always works.                    |
| `gzip`     | SHOULD | SHOULD | Stdlib in every language. Universal browser support. |
| `zstd`     | MAY    | MAY    | Best ratio at scale. Browsers: Chrome 123+, Firefox 126+. |
| `br`       | MAY    | MAY    | Fallback only. Universal browser support (Safari, iOS, older Firefox) covers the gap until zstd ships everywhere. |

Browsers handle decompression transparently in `fetch()`, so `@codecai/web` requires zero changes to consume compressed streams.

### Which encoding to pick (measured threshold)

A fine-grained sweep at 8 sizes (16 → 2,048 tokens, see `RESULTS.md` §1c) gives a clean rule of thumb on the PR-branch sglang server with Qwen2.5-0.5B-Instruct:

![Encoding crossover by response size](packages/bench/docs/crossover-summary.png)

| stream length     | best encoding | why                                                                          |
|-------------------|---------------|------------------------------------------------------------------------------|
| **≤ 128 tokens**  | **gzip**      | tiny deflate header beats zstd's frame header on payloads under ~150 tokens  |
| **128 – 256**     | zstd if available, else gzip | within 10% of each other, both within reach of optimal                |
| **≥ 256 tokens**  | **zstd**      | Huffman + dictionary keep amortising as the stream grows (562× vs JSON-SSE at 2K) |

**Two important caveats from the timed-sweep data** (single run, fixed prompt, all 12 cells, median of reps — at 2K tokens):

| encoding | wire reduction vs JSON-SSE | TTFT @ 2K | streams? | notes |
|---|---:|---:|:---:|---|
| gzip | **705×–765×** | 11 ms | ✓ | universal default for streaming |
| zstd | **990×–997×** | 3,684 ms | ✗ (buffers) | best ratio, agent/batch only |
| br | 23× | 11 ms | ✓ | sglang's br middleware barely compresses Codec frames — sometimes *expands* them (protobuf · br at 2K = 20.2 KB, vs identity 18.9 KB). Streams cleanly, but no real wire savings on this stack today. |
| identity | 17×–25× | 11 ms | ✓ | last-resort fallback |

1. **TTFT cliff.** zstd buffers the full response before sending the first byte. gzip, brotli, and identity all stream chunk-by-chunk. Only zstd has the cliff.
2. **Brotli isn't compressing.** sglang's br middleware on Codec streams is delivering near-zero compression at scale — barely better than identity, sometimes worse. This is a sglang configuration issue (likely per-frame compression with a quality setting that doesn't fit small-frame workloads), not a fundamental br limitation. Until that's patched upstream, br is in the negotiated set as a fallback only.

For human-facing streams (chat, code completion) **use gzip** — it streams *and* delivers 700×+ wire reduction. zstd's full ratio is only safe for agent-to-agent and batch workloads where TTFT doesn't matter. The picker's `interactive: true` mode (the default) enforces this — see [`RESULTS.md` §1d](packages/bench/RESULTS.md) for the chart and full numbers.

#### A single number to rank by: **bytes × TTFT** (interactive) and **bytes** (batch)

To compare encodings holistically you can multiply the two: `bytes × TTFT` is the "byte-milliseconds you pay before the user sees something" — a composite efficiency score normalised to JSON-SSE identity = 1.0×. The two regimes give two different rankings:

| metric | best at 2K tok | second | also-rans |
|---|---|---|---|
| **Interactive (bytes × TTFT)** | gzip — **722-855×** better than JSON-SSE | identity Codec — 18-25× | br — 25× &nbsp;·&nbsp; **zstd — only 3×** (TTFT cliff) |
| **Batch (bytes only)** | zstd — **1014-1021×** | gzip — 722-784× | br — 23× &nbsp;·&nbsp; identity — 17-25× |

The Pareto front for both metrics is `{gzip, zstd}` — br and identity are dominated everywhere. That's why the `wire-compress` picker has exactly one knob (`interactive: boolean`).

**Brotli is a fallback tier, not a competitor.** On streaming small-frame workloads brotli's per-block overhead doesn't amortise, so when gzip *or* zstd is available the picker chooses one of those instead. But brotli has wider client coverage than zstd — Safari, iOS, older Firefox all ship br but not zstd — so it remains a critical fallback when neither modern encoder is supported. Identity is the universal floor; the picker only chooses it when nothing else negotiates.

### Reference implementation: [`wire-compress`](packages/wire-compress)

The encoding-picker logic is shipped as a standalone, framework-agnostic package — `packages/wire-compress`. Zero dependencies, ~5 KB. Drop it in any HTTP server (Express, Fastify, Hono, Workers, Bun, Deno):

```ts
import { pick } from 'wire-compress';

const choice = pick({
  acceptEncoding: req.headers['accept-encoding'],
  estimatedSize: 1024,                  // tokens or bytes
});
res.setHeader('Content-Encoding', choice.encoding);
```

Works for any bursty small-frame streaming workload (SSE, gRPC-Web text, log streams, telemetry) — not just Codec.

### Bolt-on tools: [`codec-tool-kit`](packages/codec-tool-kit)

Tools should remain modular — independently versioned, deployed, and authored, hosted in their own repos. `codec-tool-kit` is the SDK for building Codec-native bolt-ons that pre-cache the tokenizer at build time so the gateway stays a pure token router.

```ts
import { precache } from 'codec-tool-kit/precache';

// Build time: tokenize once, ship the cache.
const cache = precache({
  fragments: [
    { id: 'iso-prefix',  kind: 'static',   text: 'The current time is ' },
    { id: 'iso-suffix',  kind: 'static',   text: ' UTC.' },
    { id: 'human-tpl',   kind: 'template', text: 'It is {hours}:{minutes} on {day}.' },
  ],
  tokenizer,
});
```

```ts
import { type CodecTool, tokensResult, renderTemplate } from 'codec-tool-kit';

// Runtime hot path: cached IDs in, cached IDs out — gateway sees no text.
export const tool: CodecTool = {
  manifest,
  async handle(call) {
    const args = decodeArgs(call.argumentIds);
    const ids = renderTemplate(cache.fragments['human-tpl'], {...}, smallTokenizer);
    return tokensResult(call.callId, ids);
  },
};
```

See [`packages/codec-tool-kit/README.md`](packages/codec-tool-kit/) for the full architecture and `RESULTS.md §1e` for why bolt-ons beat in-process MCP dispatch.

---

## Run the benchmarks

```bash
npm install
npm run bench:wire          # encoder microbench (~5s)
npm run bench:handoff       # agent round-trip (~5s)
npm run bench:compression   # gzip/zstd overlay (~5s)

# Live measurement against any OpenAI-compat server:
BENCH_URL=http://localhost:8000 BENCH_MODEL=qwen2.5:latest npm run bench:live
```

All bench output is deterministic given a fixed RNG seed. If a number in this README looks off, regenerate it from `packages/bench` and PR a fix — these are claims about software, not vibes.

---

## Status

What's validated end-to-end:

- ✅ **Cross-stack matrix.** Three engines (sglang, vllm, llama.cpp) × six client languages (TS, Python, .NET, Rust, Java, C) × all 12 wire-format/encoding cells × 3 sizes = 648 SCHEMA-v1 result rows. Same prompt, same model, byte-identical Codec frames per cell on every engine. Full data in [`packages/bench/results/2026-05-09T17-09-35Z/MATRIX.md`](packages/bench/results/2026-05-09T17-09-35Z/MATRIX.md).
- ✅ **Wire reduction.** sglang 485 KB → 291 B with full Codec stack at 2 K tokens (**1,707×**). vllm 518 KB → 3.9 KB with gzip alone (**137×**). llama.cpp 529 KB → 16 KB with gzip alone (**33×**). TTFB stays within 1 ms of JSON-SSE on the same engines.
- ✅ **Tool-call dispatch on raw IDs.** `ToolWatcher` runs at 0.61 ms / 1 M tokens vs 60.4 ms for detokenize+regex (~100× faster). Available in every client.
- ✅ **Cross-vocab agent handoff.** Llama-3 → Qwen-2 at 2 K tokens: 30 % less bridge CPU, 15.1× smaller wire, byte-identical Qwen-2 output asserted by the bench.
- ✅ **Polyglot clients shipped** — TS / Python / .NET / Rust / Java / C all built and tested in the matrix. Three on public registries today (`@codecai/web` on npm, `codecai` on PyPI, `Codec.Net` on NuGet); Rust + Java built locally with crates.io / Maven Central publishes queued. Frame format + Detokenizer + ToolWatcher + Translator + BPE encoder in TS / Python / .NET / Rust / Java; C has Detokenizer + ToolWatcher (BPE + Translator deferred until Unicode tables land).
- ✅ **vLLM / SGLang / llama.cpp PRs open** — same wire surface across all three; engines tested in the cross-stack matrix.
- ✅ **MetaMCP PR open** — gateway-side Codec + token-aware tool dispatch ([`metatool-ai/metamcp#287`](https://github.com/metatool-ai/metamcp/pull/287)). Image: `wdunn001/codec-metamcp:0.2.4`.
- ✅ **Pretok program v2.1** — maps-cli compiles regex pre-tokenizers into a regex-free op list. Equivalence verified on 23 stress inputs against the real Qwen-2 / Llama-3 regexes.
- ✅ **Pre-trained ZSTD dictionaries shipped** — `zstd_dictionaries[]` field on tokenizer maps, training pipeline at `packages/bench/scripts/train-zstd-dict.py`, reference dicts at [`dictionaries/`](dictionaries/). The dict is the **precondition** for zstd being selected at all; `wire-compress` enforces `zstdHasDict` + `zstdEnabled` as twin gates and falls through to gzip otherwise. With both gates open, measured 16–18 % byte reduction over gzip overall and **36–38 % on small streams (≤ 300 B raw)** at a streaming-TTFB cost of **+0.13 ms** vs gzip.

What's still on the roadmap:

- **Public-registry publishes for Rust + Java** — `codec-rs` to crates.io and `ai.codec:codec` to Maven Central. Both built and matrix-tested locally; the publish step is mechanical (CI workflow + signing key).
- **C BPE encoder + Translator** — needs the pretok program runtime in C plus Unicode `\p{L}` / `\p{N}` interval-list tables (one-shot generator from UCD). The pretok-program work landed specifically to make this tractable.
- **Pretok program runtime in Python + .NET** — both have `\p{L}` support today, so the regex path works fine; porting the program runtime gives ~10–30 % encode-startup speedup.
- **Server-side dictionary loading** — sglang's `codec_compression.py` ships dict-zstd; the vllm fork has dicts pre-baked but the lifespan loader hook is in flight. llama.cpp's libcpp-httplib transport ships gzip only. Dict artifacts and schema are in place; the engine-side wiring is the next PR.
- **Streaming chunked tokenization at the MetaMCP gateway** — today MCP `tools/call` results are tokenized whole at the response seam. Streaming chunks (incremental tokenize as the underlying tool produces text) is the next gateway PR; until then long file-read tools hold the response until completion before re-emitting Codec frames.
- **Map discovery** — formal registry vs `.well-known` URL convention. Not blocking; clients can pin URLs + hashes today.
- **Session protocol** — persistent connection variant for multiplexing. Stateless HTTP covers the common case.

---

## License + patent posture

**Source license: [BSL 1.1](LICENSE)** by Quasarke LLC. Free for non-production use and for production use under US $5M annual revenue. Each release auto-converts to Apache-2.0 four years after publication. Commercial terms above the threshold: see [COMMERCIAL.md](COMMERCIAL.md) or contact [licensing@quasarke.com](mailto:licensing@quasarke.com).

**Patent posture: [PATENTS.md](PATENTS.md).** Quasarke is pursuing patent protection on certain Codec mechanisms. The wire format, handshake, and content-addressed map distribution described in `spec/PROTOCOL.md` are intended to be made available on royalty-free or FRAND terms to implementers of the spec when patents issue. Adjacent improvements (ToolWatcher, Translator, the dictionary system, `Codec-Zstd-Dict` negotiation) may be commercially licensed separately — a Codec-compliant implementation does not require those modules. Defensive termination clause will apply to any future patent license grant. Full text in `PATENTS.md`.

**Contributions** are licensed under BSL 1.1 plus a non-exclusive, royalty-free grant to Quasarke for inclusion in any future patent license commitment. See `PATENTS.md` § Contributions.
