# Cross-stack benchmark matrix — 2026-05-07T23:42:00Z

Re-run after rebuilding `wdunn001/codec-sglang:latest` to pick up the
runtime deps the previous run was missing. Image now ships
`zstandard 0.25.0` + `brotli 1.2.0` so the compression negotiator can
actually advertise br/zstd. **This is the canonical "end user e2e
path" run** — every step from `docker pull` through `bench complete`
went through Hub-published artifacts; no hot-patches.

Supersedes the 2026-05-07T23-08-54Z run (which had `zstandard`/`brotli`
missing from the image, see commit history of
[`codec-supervisor` Dockerfile](https://github.com/wdunn001/codec-supervisor/commit/909f0ab)
and [`wdunn001/sglang`'s `feat/codec-server-side-agent` branch](https://github.com/wdunn001/sglang/commit/65ed3786a)
for the source-of-truth fixes that produced this image).

---

## Methodology fingerprint

Captured via `packages/bench/scripts/capture_methodology.py` with a
live engine probe (server-asserted, not declared in config).

| Field | Value |
|---|---|
| Hardware | RTX 3090 / 5950X-class CPU / 125 GB RAM / Linux 6.8.0-84-generic |
| Engine | sglang via `wdunn001/codec-sglang@sha256:671bc2a2ea50…` (Docker Hub `:latest`) |
| Image rebuilt from | codec-supervisor `909f0ab` ← sglang fork `65ed3786a` (`feat/codec-server-side-agent`) |
| Model | `Qwen/Qwen2.5-0.5B-Instruct` (fp16) |
| Endpoint | `http://localhost:30002` (LAN, supervisor proxy → backend on :30000) |
| `stream_format_supported` (probed) | `json`, `msgpack`, `protobuf` |
| `compression_supported` (probed) | `identity`, `gzip`, `br` |
| zstd absence | **expected** — codec_compression's dict-gate (spec/PROTOCOL.md "Pre-trained ZSTD dictionaries") drops zstd from negotiation when no dict is registered. With deps installed but no dict loaded, the probe correctly omits zstd. |
| Client | `codecai 0.2.0` / CPython 3.12.3 / httpx 0.28.1 / msgpack 1.1.2 |
| Bench tool | `demo-python/codec-demo.matrix_run` 0.1.0 / 2 reps / median |

Raw methodology JSON: [`../../methodology/2026-05-07T23-42-00Z/sglang.json`](../../methodology/2026-05-07T23-42-00Z/sglang.json).

---

## §1. Wire-format matrix (`matrix_run`, 36 cells)

### Wire bytes (median across 2 reps)

| size | path · enc | identity | gzip | br | zstd † |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 15,579 | 15,559 | 15,559 | 15,559 |
| 64 | Codec msgpack | 975 | **226** | 1,159 ‡ | 975 |
| 64 | Codec protobuf | 652 | **224** | 924 ‡ | 652 |
| 512 | JSON-SSE | 124,510 | 124,534 | 124,534 | 124,534 |
| 512 | Codec msgpack | 7,616 | **730** | 9,013 ‡ | 7,616 |
| 512 | Codec protobuf | 5,136 | **723** | 7,150 ‡ | 5,136 |
| 2048 | JSON-SSE | 496,091 | 496,841 | 496,841 | 496,841 |
| 2048 | Codec msgpack | 30,681 | **354** | 21,844 | 30,681 |
| 2048 | Codec protobuf | 20,465 | **311** | 20,837 | 20,465 |

† **zstd cells = identity bytes by design.** No dict has been registered
on this server, so per spec/PROTOCOL.md "Pre-trained ZSTD dictionaries"
the negotiator drops zstd from candidates and an
`Accept-Encoding: zstd`-only request gets back identity. To unlock the
zstd column, an operator needs to load a pre-trained dictionary at
startup via `set_zstd_dict("msgpack", bytes)` /
`set_zstd_dict("protobuf", bytes)` — the reference dicts ship at
[`dictionaries/qwen2.5-{msgpack,protobuf}-v1.dict`](../../../../dictionaries/).
Adding a `CODEC_ZSTD_DICT_*` env var to codec-supervisor that wires
this in at startup is open follow-on work.

‡ **br cells expand at small sizes, marginally helpful at large.** sglang
ships per-frame brotli compression with a default quality that doesn't
fit small-frame Codec workloads — at 64 and 512 tokens the per-block
overhead exceeds the savings, sometimes producing more bytes than
identity. At 2K tokens br is ~1.4× smaller than identity (msgpack 30,681 →
21,844) but still 60× **larger** than gzip's 354 bytes. Reproduces the
"sglang br middleware misconfigured" finding from RESULTS.md §1f. **Not
a Codec protocol issue** — patching sglang's middleware to use a
streaming-aware brotli config (or to disable per-frame compression for
binary streams) would fix it.

### Reduction vs JSON-SSE identity

| size | msgpack identity | msgpack gzip | protobuf identity | protobuf gzip |
|---:|---:|---:|---:|---:|
| 64 | 16.0× | **68.9×** | 23.9× | **69.5×** |
| 512 | 16.3× | **170.6×** | 24.2× | **172.2×** |
| 2048 | 16.2× | **1,401×** | 24.2× | **1,595×** |

Gzip column matches the previous run within noise — the encoding
implementation didn't change, only the runtime deps. The br column is
new (was unavailable in the previous image) and shows the misconfigured
behaviour described above.

### TTFT (median, ms)

All gzip and br cells stream cleanly; total wall-clock is decode-bound
(~525 tok/s on Qwen2.5-0.5B / RTX 3090).

| size | JSON-SSE identity | msgpack+gzip | msgpack+br | protobuf+gzip |
|---:|---:|---:|---:|---:|
| 64 | 60.7 | 51.3 | 44.9 | 46.0 |
| 512 | 46.4 | 45.2 | 45.6 | 44.8 |
| 2048 | 47.7 | 45.5 | 37.8 | 47.6 |

Br preserves TTFT (no buffering) — the only cost is the wire-bytes
malfunction at small sizes. If sglang's br middleware is fixed,
br becomes a viable interactive fallback for clients without gzip
support (Safari/iOS edge cases).

Raw data: [`sglang/python.json`](sglang/python.json) — 36 rows with per-rep arrays.

---

## §2. Single-turn ToolWatcher (`toolcall_bench`)

```
prompt: "What is the weather in Tokyo?"  → model emits
  <tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>
```

| Path | wire | tokens | TTFB | total | calls |
|---|---:|---:|---:|---:|---:|
| JSON-SSE + client text scan | 6,034 B | 22 | 1,155.4 ms | 1,189.0 ms | 1 |
| Codec msgpack + client detok+scan | 343 B | 21 | 51.1 ms | 87.8 ms | (transformers missing †) |
| Codec msgpack + server `tool_watcher` | 393 B | **1** | 47.4 ms | 84.0 ms | 1 |

**Wire reduction**: 6,034 → 393 = **15.4×**. **TTFB**: JSON-SSE
1,155 ms → Codec 47.4 ms = **24× faster first byte**. The
JSON-SSE TTFB is high-variance run-to-run (the previous run measured
2,018 ms; this run 1,155 ms — both far above the Codec path's
consistent ~50 ms).

† Path B requires `transformers` to detokenize the buffered region IDs
client-side. Not in the venv on this run; wire/TTFB are still valid,
the `calls=0` cell is a missing-dep artifact.

Raw stdout: [`sglang/toolcall_bench.txt`](sglang/toolcall_bench.txt).

---

## §3. End-to-end agent loop (`agent_bench`)

### Mock weather tool

```
prompt: "What is the weather in Tokyo?"
```

| Path | wire | dispatch | TTFB | total | calls |
|---|---:|---:|---:|---:|---:|
| JSON-SSE + client scan + dispatch | 13,419 B | 1.1 ms | 68.2 ms | 208.0 ms | 1 |
| Codec msgpack + server tool_watcher + dispatch | **794 B** | 1.2 ms | 48.4 ms | **178.3 ms** | 1 |

**16.9× wire reduction. 14% faster end-to-end.** Matches RESULTS.md §4.

### Real SearXNG (port 8888 lab box, network-bound dispatch)

```
prompt: "Search the web for the latest news about Anthropic Claude."
```

| Path | wire | dispatch | TTFB | total | calls |
|---|---:|---:|---:|---:|---:|
| JSON-SSE + client scan + dispatch | 77,124 B | 3,025.7 ms | 57.4 ms | 3,669.3 ms | 1 |
| Codec msgpack + server tool_watcher + dispatch | **4,121 B** | 1,200.9 ms | 52.4 ms | **1,829.4 ms** | 1 |

**18.7× wire reduction. 50% faster end-to-end** on this run — though
this turn's JSON-SSE dispatch took an unusual 3.0 s vs Codec's 1.2 s.
That's a property of the SearXNG server (probably warmed cache for the
Codec turn vs cold-cache for the JSON-SSE turn), not Codec's doing —
the previous run measured 1.0/1.1 s dispatch on both paths and the
totals nearly tied. **The wire reduction is the durable claim**;
total-time delta on real-tool turns is dominated by the tool, not the
wire.

### MetaMCP — **still skipped this run**

`METAMCP_API_KEY` not set on `vinez`'s shell. Previous run noted the
same. To fill: `export METAMCP_API_KEY=…` before invoking
`agent_bench --prompt "What time is it in Tokyo?"`. Expected ~17.8×
wire per RESULTS.md §6.

Raw stdout: [`sglang/agent_bench_mock.txt`](sglang/agent_bench_mock.txt),
[`sglang/agent_bench_searxng.txt`](sglang/agent_bench_searxng.txt).

---

## §4. What's missing for the full matrix

Same shopping list as the prior run plus a now-unblocked item:

| Stack | Missing language drivers | Server status |
|---|---|---|
| sglang | `web`, `dotnet`, `c`, `rust`, `java` SCHEMA-v1 emitters | ✅ running on :30002 |
| vLLM | All 6 langs | ❌ deploy still blocked (torch 2.11 ↔ xformers 2.7.1) |
| llama.cpp | All 6 langs | ⚠ binary built and merged to fork master, **GGUF not yet loaded on lab box** |

Plus:

- **Tokenizer/detokenizer microbench schema** — needs SCHEMA-v2 (or §5
  extension) and per-lang emitters.
- **E2E + tool-call ports** — currently Python-only (`agent_bench.py`,
  `toolcall_bench.py`).
- **Aggregator script** (`packages/bench/scripts/aggregate.py`) —
  SCHEMA.md describes one; doesn't exist yet. MATRIX.md is still
  hand-written per run.
- **Dict-zstd column** — needs an operator wiring path
  (`CODEC_ZSTD_DICT_MSGPACK`/`_PROTOBUF` env var on codec-supervisor
  that calls `set_zstd_dict()` on sglang startup, OR a supervisor
  `/admin/codec/dicts` endpoint). Once available, re-run §1 with both
  reference dicts loaded and the zstd column will fill.
- **sglang br middleware tuning** — switch from per-frame brotli to a
  streaming-aware config (or disable for Codec content types). Upstream
  fix in sglang, not in this repo.

---

## §5. Headlines

| Claim | Number | vs prior run | Where |
|---|---|---|---|
| Wire reduction msgpack vs JSON-SSE @ 64 tok | **68.9× with gzip** | identical | §1 |
| Wire reduction protobuf vs JSON-SSE @ 64 tok | **69.5× with gzip** | identical | §1 |
| Wire reduction msgpack+gzip @ 2K tok | **1,401×** | identical | §1 |
| Wire reduction protobuf+gzip @ 2K tok | **1,595×** | identical | §1 |
| ToolWatcher wire | **15.4×** | identical | §2 |
| ToolWatcher TTFB vs JSON-SSE | 24× faster | high-variance JSON-SSE side | §2 |
| Mock-tool agent loop | **16.9× wire, 14% faster e2e** | wire identical, total slightly faster | §3 |
| SearXNG agent loop | **18.7× wire** | wire same; total noisier (network-bound) | §3 |
| br middleware misconfigured | confirmed | new — was not measurable on prior image | §1 |

The wire numbers are byte-identical to the previous run because the
encoder is deterministic and the model output is temperature-0
deterministic for the same prompts. Re-running mainly demonstrates
the e2e path now produces real br data (and zstd would, with a
registered dict).

Full per-rep breakdown in [`sglang/python.json`](sglang/python.json).
