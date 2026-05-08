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

- **Wire-native streaming.** Length-prefixed binary frames over plain HTTP, the same wire on every engine in the [cross-stack matrix](packages/bench/results/2026-05-08T01-15-02Z/MATRIX.md). Compression is a layer on top: 67× smaller on a short chat reply, **1,404×** on a 2 K-token agent stream, TTFB within 1 ms of JSON-SSE. *Receipts, not pitch.*
- **Tool-call dispatch without detokenization.** `ToolWatcher` matches reserved control IDs in the raw token stream — single 32-bit compare per token, ~100× faster than detokenize+regex. Lives canonically in the [MetaMCP gateway](https://github.com/wdunn001/codec-supervisor/blob/main/Dockerfile.metamcp) but the primitive works in any inference proxy, agent runtime, or middleware.
- **Cross-vocab agent handoff.** `Translator` carries one model's stream into another's vocabulary via one in-process detokenize/retokenize step. UTF-8 never crosses the wire. Llama-3 → Qwen-2 at 2 K tokens: 30 % less bridge CPU on 15× fewer wire bytes; both paths emit byte-identical Qwen-2 IDs.

Source-available under [BSL 1.1](LICENSE). Patent posture in [PATENTS.md](PATENTS.md).

---

## What ships today

### Spec

| Surface | Where | What it is |
|---|---|---|
| **Wire spec** | [`spec/PROTOCOL.md`](spec/PROTOCOL.md) | v0.2 — msgpack/protobuf frames, transport compression, both endpoint paths |
| **Map schema** | [`spec/tokenizer-map.schema.json`](spec/tokenizer-map.schema.json) | v2.1 — vocab + merges + encoder + optional `pre_tokenizer_program` (regex-free pre-tokenizer for runtimes without `\p{L}` regex) |
| **Pretok program spec** | [`spec/PRETOKENIZER_PROGRAM.md`](spec/PRETOKENIZER_PROGRAM.md) | v1 op-list form the maps-cli compiles regex pre-tokenizers into; unblocks the C BPE encoder |

### Polyglot clients

| Lang | Package | Registry | Surface |
|---|---|---|---|
| TypeScript / JS | [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) | npm 0.4.0 | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders · pretok-program runtime |
| Python | [`codecai`](https://pypi.org/project/codecai/) | PyPI 0.2.0 | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders |
| .NET | [`Codec.Net`](https://www.nuget.org/packages/Codec.Net) | NuGet 0.2.0 | Detokenizer · BPETokenizer · ToolWatcher · Translator · stream decoders |
| C99 | [`libcodec`](packages/c) | vcpkg / FetchContent 0.2.0 | Detokenizer · ToolWatcher · stream decoders (BPE + Translator pending Unicode tables) |

### Tooling and registry

| Surface | Where | What it is |
|---|---|---|
| **Map generator** | [`@codecai/maps-cli`](https://www.npmjs.com/package/@codecai/maps-cli) | npm 0.3.0 — generate maps from HF `tokenizer.json`, plus `translate` / `translation-table` for cross-vocab analysis |
| **Map registry** | [`codec-maps`](https://github.com/wdunn001/codec-maps) | 14 model families / 70+ aliases, served via jsDelivr |

### Inference engines

| Engine | Where | What it is |
|---|---|---|
| **vLLM** | [PR #41765](https://github.com/vllm-project/vllm/pull/41765) | `stream_format` on `/v1/completions` + dedicated `/v1/completions/codec` |
| **SGLang** | [PR #24483](https://github.com/sgl-project/sglang/pull/24483) | Same surface, mirrored into SGLang |
| **llama.cpp** | [PR #22757](https://github.com/ggml-org/llama.cpp/pull/22757) | Same surface in `llama-server` (covers Ollama too) |

### Gateway / control-plane

| Surface | Where | What it is |
|---|---|---|
| **MetaMCP** | [PR #287](https://github.com/metatool-ai/metamcp/pull/287) | Codec wire framing + token-aware tool dispatch at the JSON-RPC seam. Detokenize runs once at the MCP-server boundary; everything upstream stays token-native. Image: `wdunn001/codec-metamcp:latest`. |
| **Pre-built images** | [`wdunn001/codec-supervisor`](https://github.com/wdunn001/codec-supervisor) | One Docker image per engine + the gateway: `codec-sglang`, `codec-vllm`, `codec-llamacpp`, `codec-metamcp`. `docker run` and you're at the wire. |

---

## Measured impact (cross-stack)

All numbers are real measurements from `packages/bench/`. The headline data set is the cross-stack matrix: three real inference engines × six client languages × 36 cells × 3 payload sizes = 648 SCHEMA-v1 result rows, captured against `wdunn001/codec-{sglang,vllm,llamacpp}` containers on RTX 3090 + Qwen2.5-0.5B-Instruct, temperature 0.0. Full table: [`packages/bench/results/2026-05-08T01-15-02Z/MATRIX.md`](packages/bench/results/2026-05-08T01-15-02Z/MATRIX.md).

**Headline at 2 K tokens** (Python row, Codec msgpack):

| Engine | JSON-SSE baseline | Best Codec wire | Reduction | TTFB |
|---|---:|---:|---:|---:|
| sglang | 485 KB | 354 B (dict-zstd) | **1,404×** | 45.6 ms |
| vllm | 479 KB | 3.9 KB (gzip) | **126×** | 67.3 ms |
| llama.cpp | 529 KB | 16 KB (gzip) | **33×** | 40.7 ms |

**Live A/B against sglang main vs PR #24483** (3 wire formats × 4 encodings, same prompt, 64-token completion):

| Path | identity | gzip | br | zstd |
|---|---:|---:|---:|---:|
| JSON-SSE (vanilla main) | 15.2 KB | 15.2 KB | 15.2 KB | 15.2 KB |
| JSON-SSE (PR #24483) | 15.2 KB | 15.2 KB | 15.2 KB | 15.2 KB |
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

These are reproducible. Bench drivers under [`packages/demo-python`](packages/demo-python), [`packages/demo-dotnet`](packages/demo-dotnet), [`packages/demo-c`](packages/demo-c), [`packages/demo-web`](packages/demo-web). Full methodology + raw numbers in [`packages/bench/RESULTS.md`](packages/bench/RESULTS.md).

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

Available in: `@codecai/web` · `codecai` · `Codec.Net` · `libcodec`.

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

Available in: `@codecai/web` · `codecai` · `Codec.Net`. C version pending the Unicode-tables work.

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
  PROTOCOL.md                  wire format, endpoints, compression negotiation
  PRETOKENIZER_PROGRAM.md      v2.1 regex-free pre-tokenizer recipe spec
  tokenizer-map.schema.json    JSON Schema for tokenizer maps
packages/
  web/         @codecai/web         isomorphic detokenizer + BPE tokenizer + ToolWatcher + Translator + pretok runtime
  python/      codecai               Python twin of @codecai/web
  dotnet/      Codec.Net             .NET (net8.0) twin
  c/           libcodec              C99 detokenizer + ToolWatcher (no deps; vcpkg + FetchContent)
  maps-cli/    @codecai/maps-cli     generate maps + cross-vocab translate / translation-table
  bench/       benchmark suite (wire / handoff / live / compression / watcher / translator)
  core/        legacy frame codec (kept for compatibility; @codecai/web supersedes)
  client/      legacy TS client (kept for compatibility)
  demo/        illustrative agent-to-agent demo
article/
  text-is-the-wrong-wire-format.md   the case for Codec
```

Sister repos:

- **[`codec-maps`](https://github.com/wdunn001/codec-maps)** — community registry of dialect maps for 14 model families. Served via jsDelivr.
- **[vLLM PR #41765](https://github.com/vllm-project/vllm/pull/41765)** — server-side encoder, two endpoint paths (`/v1/completions` + `stream_format`, and `/v1/completions/codec` for binary request bodies on huge prompts).
- **[SGLang PR #24483](https://github.com/sgl-project/sglang/pull/24483)** — same surface in SGLang.

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

- ✅ **Cross-stack matrix.** Three engines (sglang, vllm, llama.cpp) × six client languages (TS, Python, .NET, Rust, Java, C) × all 12 wire-format/encoding cells × 3 sizes = 648 SCHEMA-v1 result rows. Same prompt, same model, byte-identical Codec frames per cell on sglang and llama.cpp. Full data in [`packages/bench/results/2026-05-08T01-15-02Z/MATRIX.md`](packages/bench/results/2026-05-08T01-15-02Z/MATRIX.md).
- ✅ **Wire reduction.** sglang 485 KB → 354 B with full Codec stack at 2 K tokens (**1,404×**). vllm 479 KB → 3.9 KB with gzip alone (**126×**). llama.cpp 529 KB → 16 KB with gzip alone (**33×**). TTFB stays within 1 ms of JSON-SSE on the same engines.
- ✅ **Tool-call dispatch on raw IDs.** `ToolWatcher` runs at 0.61 ms / 1 M tokens vs 60.4 ms for detokenize+regex (~100× faster). Available in every client.
- ✅ **Cross-vocab agent handoff.** Llama-3 → Qwen-2 at 2 K tokens: 30 % less bridge CPU, 15.1× smaller wire, byte-identical Qwen-2 output asserted by the bench.
- ✅ **Polyglot clients shipped** — TS, Python, .NET, C all on package registries. Frame format + Detokenizer everywhere; BPE encoder in TS / Python / .NET (C deferred until Unicode tables land).
- ✅ **vLLM / SGLang / llama.cpp PRs open** — same wire surface across all three; engines tested in the cross-stack matrix.
- ✅ **MetaMCP PR open** — gateway-side Codec + token-aware tool dispatch ([`metatool-ai/metamcp#287`](https://github.com/metatool-ai/metamcp/pull/287)). Image: `wdunn001/codec-metamcp:0.2.4`.
- ✅ **Pretok program v2.1** — maps-cli compiles regex pre-tokenizers into a regex-free op list. Equivalence verified on 23 stress inputs against the real Qwen-2 / Llama-3 regexes.
- ✅ **Pre-trained ZSTD dictionaries shipped** — `zstd_dictionaries[]` field on tokenizer maps, training pipeline at `packages/bench/scripts/train-zstd-dict.py`, reference dicts at [`dictionaries/`](dictionaries/). The dict is the **precondition** for zstd being selected at all; `wire-compress` enforces `zstdHasDict` + `zstdEnabled` as twin gates and falls through to gzip otherwise. With both gates open, measured 16–18 % byte reduction over gzip overall and **36–38 % on small streams (≤ 300 B raw)** at a streaming-TTFB cost of **+0.13 ms** vs gzip.

What's still on the roadmap:

- **C BPE encoder + Translator** — needs the pretok program runtime in C plus Unicode `\p{L}` / `\p{N}` interval-list tables (one-shot generator from UCD). The pretok-program work landed specifically to make this tractable.
- **Java client (Maven Central)** — JDK has Unicode regex natively, so the port is straightforward. Queued.
- **Pretok program runtime in Python + .NET** — both have `\p{L}` support today, so the regex path works fine; porting the program runtime gives ~10–30% encode-startup speedup.
- **Server-side dictionary loading** — sglang/vLLM/llama.cpp middleware needs to pick the right dict for the (`tokenizer_id`, `stream_format`) pair before compressing. Dict artifacts and schema are in place; this is the wiring step.
- **Map discovery** — formal registry vs `.well-known` URL convention. Not blocking; clients can pin URLs+hashes today.
- **Session protocol** — persistent connection variant for multiplexing. Stateless HTTP covers the common case.

---

## License + patent posture

**Source license: [BSL 1.1](LICENSE)** by Quasarke LLC. Free for non-production use and for production use under US $5M annual revenue. Each release auto-converts to Apache-2.0 four years after publication. Commercial terms above the threshold: see [COMMERCIAL.md](COMMERCIAL.md) or contact [licensing@quasarke.com](mailto:licensing@quasarke.com).

**Patent posture: [PATENTS.md](PATENTS.md).** Quasarke is pursuing patent protection on certain Codec mechanisms. The wire format, handshake, and content-addressed map distribution described in `spec/PROTOCOL.md` are intended to be made available on royalty-free or FRAND terms to implementers of the spec when patents issue. Adjacent improvements (ToolWatcher, Translator, the dictionary system, `Codec-Zstd-Dict` negotiation) may be commercially licensed separately — a Codec-compliant implementation does not require those modules. Defensive termination clause will apply to any future patent license grant. Full text in `PATENTS.md`.

**Contributions** are licensed under BSL 1.1 plus a non-exclusive, royalty-free grant to Quasarke for inclusion in any future patent license commitment. See `PATENTS.md` § Contributions.
