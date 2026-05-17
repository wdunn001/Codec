# Codec — measured results

This top-level file is a pointer. The numbers, methodology, and raw SCHEMA-v1 result JSONs live below — pick the entry point that matches what you want.

## Cross-stack matrix (current, v0.4.1 cohort, 2026-05-15)

The cross-stack run pits **3 inference engines** (sglang, vllm, llama.cpp) against **6 client languages** (Python, TypeScript, .NET, Rust, Java, C) on the same prompt + model + hardware, then aggregates into one machine-generated MATRIX.md.

→ **[`packages/bench/results/2026-05-15T20-00-00Z/MATRIX.md`](packages/bench/results/2026-05-15T20-00-00Z/MATRIX.md)**

### Headline numbers from the v0.4.1 cohort

**§1b engine-output @ 2K tokens, Codec msgpack+dict-zstd, content-dependent:**

| Engine     | JSON-SSE  | Best Codec                       | Reduction  |
|------------|----------:|---------------------------------:|-----------:|
| sglang     | 485.2 KB  | 291 B (msgpack+dict-zstd)        | **1,707×** |
| vllm       | 517.8 KB  | 3.9 KB (msgpack+gzip)            | **137×**   |
| llama.cpp  | 528.8 KB  | 140 B (msgpack+dict-zstd, fp16)  | **3,868×** |

llama.cpp jumped from 33× (v0.4.0, gzip-only) to 3,868× (v0.4.1) after the fork gained brotli + dict-zstd + the `codec_zstd_dict_registry` + the `/codec/schema` endpoint. vllm still gzip-only on its best cell — content-bound at temp=0, not protocol-bound. See `packages/bench/RESULTS.md` §1b for the per-engine breakdown.

**§1 protocol-only synthetic (no engine, no model — pure library):**

| Content distribution                  | Best Codec vs Codec identity |
|---------------------------------------|-----------------------------:|
| Uniform random (worst case)           | **4.8×**                     |
| Comma-dominated (50% one ID)          | **6.6×**                     |
| Low entropy (50 unique IDs)           | **16.6×**                    |
| Cyclic period 10 (best case)          | **391.9×**                   |

Codec's protocol-only contribution is **4.8×–392×** depending on content compressibility. Versus JSON-SSE identity, multiply by ~10× (Codec's msgpack-over-JSON framing advantage): so the JSON-SSE→Codec range spans ~50× to ~4,000×. Live engine output sits inside that range per §1b above.

### What's new in v0.4.1

- **Cross-client dict-zstd interop** — all 6 clients now decode dict-zstd correctly (was Python-only; the other 5 silently produced garbage or errored). Caught by the new decode-unanimity gate.
- **24/24 wire AND 24/24 decode unanimous on every engine** — v0.4.1 added the decode-side check that previously only verified wire bytes.
- **llama.cpp gains brotli + dict-zstd** — was identity+gzip only.
- **Synthetic-stream bench (§1)** — protocol-only measurement decoupled from any specific model's token-generation behaviour.
- **Bench gate hardening** — `aggregate.py` exits non-zero on any errored cell; new engine-acceptance pytest runs 9 protocol probes against any candidate engine image before the cross-stack bench.

- Cross-language byte-equality: **24/24 wire + 24/24 decode unanimous on every engine** (sglang, vllm, llama.cpp).
- TTFB at 2K tokens (msgpack + gzip, body-byte): llama.cpp 40.8 ms · sglang 44.7 ms · vllm 59.0 ms.

Reproduce the entire matrix end-to-end:

```bash
# Requires the wdunn001/codec-{sglang,vllm,llamacpp}:v0.4.1 containers running.
bash packages/bench/scripts/run-all-langs.sh 2026-05-15T20-00-00Z sglang
bash packages/bench/scripts/run-all-langs.sh 2026-05-15T20-00-00Z vllm
bash packages/bench/scripts/run-all-langs.sh 2026-05-15T20-00-00Z llama.cpp
python packages/bench/scripts/synthetic_wire_bench.py 2026-05-15T20-00-00Z  # §1 synthetic
python packages/bench/scripts/aggregate.py 2026-05-15T20-00-00Z
```

## Agent-loop end-to-end (v0.4.1 cohort)

Real two-turn loops with real tool dispatch. Wire numbers measured, not extrapolated; total-time speedups depend on whether the workload is wire-dominant or tool-latency-dominant.

| Tool surface                          | JSON-SSE wire | Codec wire | Wire reduction | Total speedup    |
|---------------------------------------|--------------:|-----------:|---------------:|-----------------:|
| mock `get_weather` (in-process)       | 13,419 B      | 794 B      | **16.9×**      | **8.8×** (1,662 → 189 ms) |
| SearXNG (live web tool)               | 42,302 B      | 2,348 B    | **18.0×**      | **1.65×** (~40% faster: 2,078 → 1,257 ms) |
| MetaMCP gateway (Time MCP)            | 18,072 B      | 1,061 B    | **17.0×**      | ~neutral (210 → 216 ms — tool latency dominates) |
| MCP leaf-mode (tool-result-side, tiny)| 105 B         | 316 B      | +211 bytes (leaf 3× larger on tiny — fixed `_meta` envelope) | **12.4× consumer-CPU speedup** |

Source: [`packages/bench/results/2026-05-15T20-00-00Z/agent-loop/`](packages/bench/results/2026-05-15T20-00-00Z/agent-loop/) (`mock.txt`, `searxng.txt`, `metamcp.txt`, `leaf.txt`, `leaf.json`).

## Detailed single-engine writeup (sglang deep-dive)

Per-cell B/token breakdown, encoding crossover study, ToolWatcher microbench, cross-vocab translator, MCP leaf-mode bench, and the wire-impact study that the sglang and vllm PR descriptions link to:

→ **[`packages/bench/RESULTS.md`](packages/bench/RESULTS.md)** (full v0.4.1 numbers; §10 Headlines table is the index)

## Method

- Schema, fingerprinting, TTFB cohort split: [`packages/bench/methodology/SCHEMA.md`](packages/bench/methodology/SCHEMA.md)
- Methodology blocks per (run_id, engine): [`packages/bench/methodology/`](packages/bench/methodology/)
- Aggregator (hard-fails on errored cells, reports wire + decode unanimity): [`packages/bench/scripts/aggregate.py`](packages/bench/scripts/aggregate.py)
- Synthetic-stream bench (§1 protocol-only): [`packages/bench/scripts/synthetic_wire_bench.py`](packages/bench/scripts/synthetic_wire_bench.py)
- MCP leaf-mode bench: [`packages/bench/src/leaf-live.ts`](packages/bench/src/leaf-live.ts)
- Engine-acceptance pytest (9 protocol probes): [`packages/bench/tests/test_engine_acceptance.py`](packages/bench/tests/test_engine_acceptance.py)
- Per-language matrix runners: [`packages/demo-{python,web,dotnet,rust,java,c}`](packages/)

## Marketing summary

For the consumer-facing version of these numbers (with charts + the cost / accessibility / response-time / power cards), see [codecai.net](https://codecai.net) — its source is [github.com/wdunn001/codec-website](https://github.com/wdunn001/codec-website).
