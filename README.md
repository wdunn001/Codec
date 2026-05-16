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

Source-available under [BSL 1.1](LICENSE).

---

## What ships today

> **Latest release: v0.4.1 — protocol-only headline measured end-to-end across 3 engines × 6 clients.**
>
> Codec's wire+compression efficiency, measured on synthetic streams (no engine, no model):
>
> | Token distribution | Best ratio over Codec identity | Best ratio over JSON-SSE identity |
> |---|---:|---:|
> | Uniform random (worst case)         | **4.8×**   | ~50×    |
> | Comma-dominated (50% one ID)        | 6.6×       | ~70×    |
> | Low entropy (50 unique IDs)         | **16.6×**  | ~170×   |
> | Cyclic period 10 (best case)        | **392×**   | ~4,000× |
>
> Engine-output (real model running) ratios are content-dependent and span 135× (vllm) to 3,868× (llama.cpp F16) — see [`packages/bench/RESULTS.md`](packages/bench/RESULTS.md) §1b for the full breakdown.
>
> All three pathways still measured end-to-end:
>
> | Pathway | Wire reduction | Image |
> |---|---:|---|
> | **Text-tokens** (sglang / vLLM / llama.cpp) | see §1 above | `wdunn001/codec-{sglang,vllm,llamacpp}:v0.4.1` |
> | **MCP tool calls** (metamcp + leaf-mode bypass) | **3.6×** on `tools/list` (40 tools) | `wdunn001/codec-metamcp:v0.3.2` + [`codec-time-leaf`](https://hub.docker.com/r/wdunn001/codec-time-leaf) |
> | **Latents** (diffusers / ComfyUI) | **3.9×** int4 vs raw, ~5–10× vs JPEG | `wdunn001/codec-diffusers:v0.3.4` |
>
> The `[Codec][leaf]` log line fires end-to-end. Customer-facing release notes: [What's new](https://codecai.net/changelog/)
> · engineering changelog: [GitHub Releases](https://github.com/wdunn001/Codec/releases)
> · visual diagram of all three pathways: [/protocol-map](https://codecai.net/protocol-map).
>
> **v0.4.1 highlights** — all 6 client packages gain real dict-zstd interop (was Python-only); llama.cpp gains brotli + zstd Content-Encoding (was identity+gzip only); §1 headline split into protocol-only vs engine-output to stop conflating wire efficiency with model behaviour; bench gate hardened to fail on errored cells + track decode-unanimity. See [GitHub Release v0.4.1](https://github.com/wdunn001/Codec/releases/tag/v0.4.1).
>
> **Every v0.4 wire addition is opt-on** ([spec](spec/versions/v0.4.md#capabilities-are-opt-on-at-the-server-two-stage)):
> two-stage enable + enforce, default OFF. A controlled fleet running
> v0.4 code pays zero v0.4 wire cost. A v0.3 client connecting to a
> v0.4 server sees v0.3 wire byte-for-byte (graceful downgrade). Same
> shape as HTTP/HTTPS or CORS — the server chooses; the wire reflects
> the choice. Header bloat thinning ([proposal](docs/WIRE_OVERHEAD_PROPOSAL.md))
> staged for v0.5–0.6.

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
| TypeScript / JS | [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) | npm 0.4.1 | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · pretok-program runtime · `LatentStreamEncoder` / `Decoder` (v0.3) · `tool_calling` block · `SafetyPolicyDescriptor` + `discoverSafetyPolicy` (v0.4) |
| TypeScript / JS | [`@codecai/web-safety`](packages/web-safety) | npm 0.4.1 (v0.4 candidate) | Optional sibling — `scanText` prefilter (secrets/PII regex + Shannon entropy) · `SafetyGate` state machine · `SafetyClassifier` interface + registry · Prompt Guard 86M (Transformers.js) + Llama Guard 3 1B (codec-web-llm) classifiers (v0.4) |
| TypeScript / JS | [`@codecai/web-llm`](packages/web-llm) | npm 0.4.1 (v0.4 candidate) | Optional sibling — `wrapEngine(mlcEngine, { mapId })` turns a browser-local `@mlc-ai/web-llm` (WebGPU) engine into a Codec source. Same `decodeMsgpackStream` from `@codecai/web` consumes from it byte-identically to a remote vLLM / sglang server. Enables peer-to-peer mesh LLM (e.g. Unstable Legion) over WebRTC at Codec's binary frame size (~7% of JSON-SSE on a 500-token completion). |
| Python | [`codecai`](https://pypi.org/project/codecai/) | PyPI 0.4.1 | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · `SafetyPolicyDescriptor` + `discover_safety_policy` (v0.4) |
| .NET | [`Codec.Net`](https://www.nuget.org/packages/Codec.Net) | NuGet 0.4.1 | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · `SafetyPolicyDescriptor` + `SafetyPolicy.{Validate,Hash,Load,Discover}Async` (v0.4) |
| Rust | [`codec-rs`](packages/rust) | crates.io 0.4.1 | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · `SafetyPolicyDescriptor` + `discover_safety_policy` (v0.4, `http` feature) |
| Java | [`ai.codec:codec`](packages/java) | Maven Central 0.4.1 | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · `SafetyPolicyDescriptor` + `SafetyPolicy.{validate,hash,load,discover}` (v0.4) |
| C99 | [`libcodec`](packages/c) | vcpkg / FetchContent 0.4.1 | Detokenizer · ToolWatcher · stream decoders (BPE + Translator pending Unicode tables) · `codec_safety_policy_{from_json,verify_sha256,well_known_url}` (v0.4, parser + URL + hash-verify only — descriptor publishing is in the higher-level languages) |

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
| `br`       | SHOULD | SHOULD | Universal browser support (Chrome 50+, Firefox 44+, Safari 11+). v0.4.1 made brotli the **best small-stream choice** — see table below. |
| `zstd`     | MAY    | MAY    | Best ratio at scale **with a pre-trained dictionary**. Browsers: Chrome 123+, Firefox 126+. |

Browsers handle decompression transparently in `fetch()`, so `@codecai/web` requires zero changes to consume compressed streams.

### Which encoding to pick (measured against v0.4.1 synthetic streams)

Pure-library measurement at 8 sizes × 4 corpora — protocol-only, no engine, no model. See [`packages/bench/results/2026-05-15T20-00-00Z/synthetic/wire.json`](packages/bench/results/2026-05-15T20-00-00Z/synthetic/wire.json) and [`scripts/synthetic_wire_bench.py`](packages/bench/scripts/synthetic_wire_bench.py).

**Best encoding by stream size (msgpack, typical model output — low-entropy 50-unique corpus):**

| stream length (tokens) | best encoding | second        | why                                                                |
|-----------------------:|---------------|---------------|--------------------------------------------------------------------|
| ≤ 16                   | **dict-zstd** | br            | zstd dict's pre-loaded context wins immediately when content matches dict; br close behind |
| 32 – 256               | **br**        | gzip          | brotli's static dictionary beats deflate on small structural payloads; per-chunk flush regression removed in v0.4.1 |
| 512                    | **gzip**      | br            | by 512 tokens gzip's sliding window has caught up; br's per-stream header amortises away |
| 1024 – 2048            | **dict-zstd** | gzip          | for cooperative content, dict-zstd opens a 1.5–2× lead over gzip as the stream grows |

**For uniform-random content** (worst case — no compressible structure):

| stream length | best | runner-up |
|---:|---|---|
| 16  | dict-zstd 122 B | br 126 B |
| 32–2048 | **br wins every size** | gzip a close second |

Brotli is now the *default* small-and-medium-stream choice. dict-zstd is the **growth winner** when (a) the response is structurally repetitive AND (b) a matching trained dictionary is loaded.

**Two important caveats** from the v0.4.1 synthetic-stream data:

1. **TTFT cliff.** zstd buffers the full response before sending the first byte in some middleware stacks. gzip, brotli, and identity all stream chunk-by-chunk. If TTFT matters more than ratio, prefer gzip or br over zstd.
2. **Brotli regression FIXED in v0.4.1.** Pre-v0.4.1, the engine forks' `_compress_brotli` called `flush()` on every chunk, emitting a complete brotli block per chunk and inflating small streams (64-token msgpack: br 1,159 B vs identity 975 B). The per-chunk flush was removed in v0.4.1; brotli now compresses properly across all stream sizes. The "br is a fallback only" guidance pre-v0.4.1 is obsolete.

For most workloads: **gzip remains a safe streaming default**, br is the better choice when both ends support it on streams < 512 tokens, and dict-zstd is the choice for long structurally-repetitive streams where you control both ends + ship a tokenizer-specific dict.

The Pareto front is now `{br, gzip, dict-zstd}` — identity is dominated everywhere except when nothing else negotiates. The `wire-compress` picker's selection logic [should be revisited](packages/wire-compress) against the v0.4.1 numbers; the size-only heuristic doesn't capture brotli's new strength at small sizes.

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

## License

**Source license: [BSL 1.1](LICENSE)** by Quasarke LLC. Free for non-production use and for production use under US $5M annual revenue. Each release auto-converts to Apache-2.0 four years after publication. Commercial terms above the threshold: see [COMMERCIAL.md](COMMERCIAL.md) or contact [licensing@quasarke.com](mailto:licensing@quasarke.com).

**Contributions** are licensed under BSL 1.1 — no separate contributor agreement required.
