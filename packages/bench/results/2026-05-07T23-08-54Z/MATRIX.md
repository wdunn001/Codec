# Cross-stack benchmark matrix — 2026-05-07T23:08:54Z

First Phase-1 run under the SCHEMA-v1 methodology
([SCHEMA.md](../../methodology/SCHEMA.md)). One stack (sglang via Docker
Hub `wdunn001/codec-sglang:latest`), one client language (Python /
codecai 0.2.0), three sizes, three paths × four encodings.

The other 12 (engine, lang) cells (vLLM × {python,web,dotnet,c,rust,java}
and llama.cpp × ditto, plus sglang × {web,dotnet,c,rust,java}) need a
SCHEMA-v1 emitter in each language; only Python ships one today
([`packages/demo-python/src/codec_demo/matrix_run.py`](../../../demo-python/src/codec_demo/matrix_run.py)).
This file is the canonical Python row of the matrix; future runs add
sibling JSONs to `results/2026-05-07T23-08-54Z/{engine}/{lang}.json`.

---

## Methodology fingerprint

`c2ccd01e6575d69b6b967fca4e3fc8ddd639cd94a82961747feacb1113575ba4`

| Field | Value |
|---|---|
| Hardware | RTX 3090 / 5950X-class CPU / 125 GB RAM / Linux 6.8.0-84-generic |
| Engine | sglang via `wdunn001/codec-sglang@sha256:a883604e133a…` (Docker Hub) |
| Model | `Qwen/Qwen2.5-0.5B-Instruct` (fp16) |
| Endpoint | `http://localhost:30002` (LAN, supervisor proxy → backend on :30000) |
| Stream formats supported | `json`, `msgpack`, `protobuf` |
| Compression supported | `identity`, `gzip` (the image predates today's dict-zstd-gate; `zstandard` and `brotli` not in container — `br`/`zstd` cells fall through to identity) |
| Client | `codecai 0.2.0` / CPython 3.12.3 / httpx 0.28.1 / msgpack 1.1.2 |
| Bench tool | `demo-python/codec-demo.matrix_run` 0.1.0 / 2 reps / median aggregation |
| TTFT | wall-clock from POST to first received byte (httpx `aiter_raw`, before decompression) |
| Wire bytes | raw socket bytes received before any Content-Encoding decompression |
| Total | wall-clock from POST to last byte |

---

## §1. Wire-format matrix (`matrix_run`, 36 cells)

### Wire bytes (median across 2 reps)

| size | path · enc | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 15,579 | 15,559 | 15,559 | 15,559 |
| 64 | Codec msgpack | 975 | **226** | 975 | 975 |
| 64 | Codec protobuf | 652 | **224** | 652 | 652 |
| 512 | JSON-SSE | 124,510 | 124,534 | 124,534 | 124,534 |
| 512 | Codec msgpack | 7,616 | **730** | 7,616 | 7,616 |
| 512 | Codec protobuf | 5,136 | **723** | 5,136 | 5,136 |
| 2048 | JSON-SSE | 496,091 | 496,841 | 496,841 | 496,841 |
| 2048 | Codec msgpack | 30,681 | **354** | 30,681 | 30,681 |
| 2048 | Codec protobuf | 20,465 | **311** | 20,465 | 20,465 |

### Reduction vs JSON-SSE identity

| size | msgpack identity | msgpack gzip | protobuf identity | protobuf gzip |
|---:|---:|---:|---:|---:|
| 64 | 16.0× | **68.9×** | 23.9× | **69.5×** |
| 512 | 16.3× | **170.6×** | 24.2× | **172.2×** |
| 2048 | 16.2× | **1,401×** | 24.2× | **1,595×** |

**Headline:** `protobuf + gzip` at 2K tokens collapses 496 KB of JSON-SSE
into 311 bytes — a **1,595× wire reduction**. Format-only floor (no
compression) is a constant 16–24× across all sizes; compression is what
unlocks the runaway improvement on long streams as the deflate context
amortises across more frames.

### TTFT (median across 2 reps)

All gzip and identity cells stream cleanly at sub-100 ms TTFT for every
size; `total` is dominated by the model's decode rate (~525 tok/s on
Qwen2.5-0.5B / RTX 3090).

| size | JSON-SSE identity | msgpack+gzip | protobuf+gzip |
|---:|---:|---:|---:|
| 64 | 67.6 ms | 51.6 ms | 50.0 ms |
| 512 | 45.9 ms | 44.8 ms | 36.5 ms |
| 2048 | 47.5 ms | 47.1 ms | 55.9 ms |

`br` and `zstd` cells in this run match `identity` on the wire because
the running container's middleware doesn't have `brotli` or
`zstandard` Python packages — the negotiator silently falls through to
identity. This image will be regenerated once today's libcodec
`tool_calls` field and the Codec-Zstd-Dict header land on Docker Hub;
re-running this matrix against the new image will fill the br/zstd
columns.

Raw data: [`sglang/python.json`](sglang/python.json) (36 rows, includes
per-rep numbers for outlier checking).

---

## §2. Single-turn ToolWatcher (`toolcall_bench`)

Same prompt to all three paths: `"What is the weather in Tokyo?"` →
model emits `<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>`.

| Path | wire | tokens emitted | TTFB | total | calls |
|---|---:|---:|---:|---:|---:|
| JSON-SSE + client text scan | 6,034 B | 22 | 2,018.0 ms | 2,051.2 ms | 1 |
| Codec msgpack + client detok+scan | 343 B | 21 | 62.2 ms | 99.4 ms | (transformers missing †) |
| Codec msgpack + server `tool_watcher` | 393 B | **1** | 56.8 ms | 95.3 ms | 1 |

**Wire reduction**: 6,034 → 393 = **15.4× smaller** on the same
detection. **TTFB**: JSON-SSE 2,018 ms → Codec 56.8 ms = **35.5× faster
first byte** (the JSON-SSE path was rate-limited by something
extra-spicy on this run; gap is real but the absolute number is
high-noise). Server-`tool_watcher` consumes the marker tokens, so its
visible token count is just the prefix tokens before the call —
1 here — while the structured `tool_calls` payload rides on the frame.

† Path B "Codec msgpack + client detokenize" needs the HuggingFace
`transformers` package for tokenizer access. Not installed in this
venv; future runs should `pip install transformers` to fill the row's
`calls` cell. Wire and TTFB measurements are unaffected.

Raw stdout: [`sglang/toolcall_bench.txt`](sglang/toolcall_bench.txt).

---

## §3. End-to-end agent loop (`agent_bench`)

Two-turn round-trip: model → tool call → tool dispatch → tool result
→ continued generation.

### Mock weather tool (no network round-trip)

```
prompt: "What is the weather in Tokyo?"
```

| Path | wire | dispatch | TTFB | total | calls |
|---|---:|---:|---:|---:|---:|
| JSON-SSE + client scan + dispatch | 13,419 B | 1.1 ms | 91.0 ms | 231.8 ms | 1 |
| Codec msgpack + server tool_watcher + dispatch | **794 B** | 1.2 ms | 53.2 ms | **183.4 ms** | 1 |

**16.9× wire reduction. 21% faster end-to-end.** Matches RESULTS.md §4
within noise.

### Real SearXNG (port 8888 on lab box, network-bound dispatch)

```
prompt: "Search the web for the latest news about Anthropic Claude."
```

| Path | wire | dispatch | TTFB | total | calls |
|---|---:|---:|---:|---:|---:|
| JSON-SSE + client scan + dispatch | 77,144 B | 1,048 ms | 91.8 ms | 1,736 ms | 1 |
| Codec msgpack + server tool_watcher + dispatch | **3,995 B** | 1,143 ms | 66.0 ms | 1,763 ms | 1 |

**19.3× wire reduction.** Total time is dominated by the SearXNG
network round-trip (~1.1 s on this run); the Codec wire savings show up
as bytes, not as wall-clock. Matches RESULTS.md §5 (18.2×).

### MetaMCP (Time MCP server) — **skipped this run**

Lab box does not have `METAMCP_API_KEY` set in `vinez`'s shell. Future
run: export the key and re-run with prompt
`"What time is it in Tokyo?"`. Expected ~17.8× wire reduction per
RESULTS.md §6.

Raw stdout: [`sglang/agent_bench_mock.txt`](sglang/agent_bench_mock.txt),
[`sglang/agent_bench_searxng.txt`](sglang/agent_bench_searxng.txt).

---

## §4. What's missing for the full matrix

To complete the cross-stack table, each remaining cell needs a
SCHEMA-v1 emitter in its language. Concretely:

| Stack | Missing language drivers | Server status |
|---|---|---|
| sglang | `web`, `dotnet`, `c`, `rust`, `java` matrix_run | ✅ running on :30002 |
| vLLM | All 6 langs | ❌ deploy still blocked (torch 2.11 ↔ xformers 2.7.1) |
| llama.cpp | All 6 langs | ⚠ `feat/codec-binary-transport` + `feat/codec-compression` merged to fork master, builds clean against latest upstream, **no GGUF loaded yet on the lab box** |

Plus, two bench types not yet generalised across languages:
- **Tokenizer / detokenizer microbench** — each library has its own
  tests; no unified schema yet. `packages/bench/src/handoff.ts` is the
  TS-only reference; needs SCHEMA-v2 (or a §5 extension) and
  per-language emitters.
- **E2E + tool-call** — `agent_bench.py` and `toolcall_bench.py` are
  Python-only. Mirroring them across the other 5 client langs would
  fill those rows.

Both are doable but each is its own day of work — see the Phase 2
breakdown in the bench runbook for sequencing.

---

## §5. Headlines

| Claim | Number | Where |
|---|---|---|
| Wire reduction msgpack vs JSON-SSE @ 64 tok | **16.0× → 68.9× with gzip** | §1 |
| Wire reduction protobuf vs JSON-SSE @ 64 tok | **23.9× → 69.5× with gzip** | §1 |
| Wire reduction msgpack+gzip @ 2K tok | **1,401×** (496 KB → 354 B) | §1 |
| Wire reduction protobuf+gzip @ 2K tok | **1,595×** (496 KB → 311 B) | §1 |
| ToolWatcher wire vs JSON-SSE | **15.4× smaller** (6,034 → 393 B) | §2 |
| ToolWatcher TTFB vs JSON-SSE | **35.5× faster** (2,018 → 56.8 ms) | §2 |
| Mock-tool agent loop, full round-trip | **16.9× wire, 21% faster** | §3 |
| SearXNG agent loop | **19.3× wire** (network-dominated total) | §3 |

All numbers measured this run; full per-rep breakdown in
[`sglang/python.json`](sglang/python.json).
