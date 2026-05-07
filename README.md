# Codec

**Token-native binary transport for AI APIs.**

AI models speak token IDs internally — 32-bit integers drawn from a fixed vocabulary. Current APIs convert those IDs to UTF-8, wrap them in JSON, and ship that over HTTPS. The wire carries 150–190 bytes per token (measured). The model emitted a 4-byte integer.

Codec fixes the layer boundary. Token IDs stay token IDs until a human actually needs to read them.

```
Current:  model → uint32 IDs → UTF-8 → JSON/SSE → wire → JSON → UTF-8 → uint32 IDs → model
Codec:    model → uint32 IDs → binary frames → wire → uint32 IDs → model
```

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

### Servers

| Surface | Where | What it is |
|---|---|---|
| **vLLM** | [PR #41765](https://github.com/vllm-project/vllm/pull/41765) | `stream_format` on `/v1/completions` + dedicated `/v1/completions/codec` |
| **SGLang** | [PR #24483](https://github.com/sgl-project/sglang/pull/24483) | Same surface, mirrored into SGLang |
| **llama.cpp** | [PR #22757](https://github.com/ggml-org/llama.cpp/pull/22757) | Same surface in `llama-server` (covers Ollama too) |

---

## Measured wire impact

All numbers below are real measurements from `packages/bench` and the polyglot demo suite — captured against a live sglang server (Codec PR #24483 + ToolWatcher PR #24557) on Qwen/Qwen2.5-0.5B-Instruct, RTX 3090, deterministic at temperature 0.0. Full report: [`packages/bench/RESULTS.md`](packages/bench/RESULTS.md).

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
| `zstd`     | MAY    | MAY    | Best ratio. Browsers: Chrome 123+, Firefox 126+. |
| `br`       | —      | —      | Not recommended. Per-block overhead exceeds savings on small Codec frames. |

Browsers handle decompression transparently in `fetch()`, so `@codecai/web` requires zero changes to consume compressed streams.

### Which encoding to pick (measured threshold)

A fine-grained sweep at 8 sizes (16 → 2,048 tokens, see `RESULTS.md` §1c) gives a clean rule of thumb on the PR-branch sglang server with Qwen2.5-0.5B-Instruct:

| stream length     | best encoding | why                                                                          |
|-------------------|---------------|------------------------------------------------------------------------------|
| **≤ 128 tokens**  | **gzip**      | tiny deflate header beats zstd's frame header on payloads under ~150 tokens  |
| **≥ 256 tokens**  | **zstd**      | Huffman + dictionary keep amortising as the stream grows (562× vs JSON-SSE at 2K) |

A simpler one-rule policy that gets ~95% of the win: **always zstd**. At worst it costs ~10% more bytes than gzip on the smallest payloads (≤32 tokens), and it wins by 1.6× on large payloads. The extra bytes on small responses are noise; the savings on large ones are real.

**Brotli loses at every size we measured for streaming Codec frames.** Don't ship it on this workload — each CodecFrame is ~10-25 B and br's per-block overhead never amortises. Brotli is built for static web assets, not streaming token frames. **Identity also loses at every size we measured**, including 16 tokens (compressed is ≥2× smaller even there).

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

- ✅ **Wire format correctness.** Round-trip equivalence for msgpack and protobuf, tested at every chunk size.
- ✅ **9.6–17× reduction.** Measured uncompressed; ~45× with `Content-Encoding: zstd`.
- ✅ **3.6× handoff speedup.** End-to-end agent round-trip with eliminated detokenize/tokenize.
- ✅ **Pure-language BPE.** Bit-identical to HuggingFace's reference tokenizer for Qwen-2 (152K vocab) across ASCII / code / emoji / CJK in `@codecai/web`, `codecai`, and `Codec.Net`.
- ✅ **Polyglot clients shipped** — TS, Python, .NET, C all on package registries. Frame format + Detokenizer everywhere; BPE encoder in TS / Python / .NET (C deferred until Unicode tables land).
- ✅ **ToolWatcher** — every client detects tool-call regions in token-ID streams without decoding (~100× faster than detokenize on the same stream).
- ✅ **Translator** — every client except C does cross-vocab agent handoff (Qwen-2 → Llama-3 round-trip verified bit-identical to source text).
- ✅ **Pretok program v2.1** — maps-cli compiles regex pre-tokenizers into a regex-free op list. Equivalence verified on 23 stress inputs against the real Qwen-2 / Llama-3 regexes.
- ✅ **vLLM PR open** with binary streaming + bidirectional codec endpoint + zstd/gzip negotiation.
- ✅ **SGLang PR open** with the same surface.
- ✅ **llama.cpp PR open** — binary streaming for `llama-server` (covers Ollama).

What's still on the roadmap:

- **C BPE encoder + Translator** — needs the pretok program runtime in C plus Unicode `\p{L}` / `\p{N}` interval-list tables (one-shot generator from UCD). The pretok-program work landed specifically to make this tractable.
- **Java client (Maven Central)** — JDK has Unicode regex natively, so the port is straightforward. Queued.
- **Pretok program runtime in Python + .NET** — both have `\p{L}` support today, so the regex path works fine; porting the program runtime gives ~10–30% encode-startup speedup.
- **Pre-trained ZSTD dictionaries** declared alongside tokenizer maps. Estimated ~30% beyond zstd identity for typical streams.
- **Map discovery** — formal registry vs `.well-known` URL convention. Not blocking; clients can pin URLs+hashes today.
- **Session protocol** — persistent connection variant for multiplexing. Stateless HTTP covers the common case.

---

## License

MIT. See [LICENSE](LICENSE).
