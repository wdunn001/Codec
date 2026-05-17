# Codec — measured results

This top-level file is a pointer. The numbers, methodology, and raw SCHEMA-v1 result JSONs live below — pick the entry point that matches what you want.

## v0.5 cohort (partial; protocol-only + bench-harness runs, 2026-05-17)

The v0.5 release runs landed in `packages/bench/results/2026-05-17T09-00-00Z/`. **§1b cross-stack engine-output cells are NOT YET POPULATED for v0.5** — they require the `wdunn001/codec-{sglang,vllm,llamacpp,tgi}:v0.5.0` images, which are scoped in `docs/engine-fork-tasks/v0.5-rollout.md` but haven't been built + pushed yet. Operator action gates that step.

What's captured for v0.5 from this session's bench runs:

- **§1 synthetic protocol-only** at `results/2026-05-17T09-00-00Z/synthetic/wire.json` (256 cells × 4 corpora × 4 sizes × 4 encodings × 2 formats):

  | Content distribution at 2048 tokens   | Codec identity | Best Codec                     | Reduction |
  |----------------------------------------|---------------:|--------------------------------|----------:|
  | Uniform random (worst case)            | 33,118 B       | 6,828 B (protobuf+gzip)        |   **4.9×**|
  | Comma-dominated (50% one ID)           | 29,790 B       | 4,354 B (protobuf+gzip)        |   **6.8×**|
  | Low entropy (50 unique IDs)            | 26,648 B       | 1,595 B (protobuf+zstd)        |  **16.7×**|
  | Cyclic period 10 (best case)           | 26,648 B       |    51 B (protobuf+br)          | **522.5×**|

- **Picker bench (v0.5 NEW)** at `results/2026-05-17T09-00-00Z/picker/coverage.json`: 576 cells × 3 stack profiles × 4 payload sizes × 3 entropy buckets × 4 gate states × 4 Accept headers. 7 of 9 v0.5 `PickReasonCode` enum values surfaced by the grid; the other 2 are unit-tested.
- **Duplex bench (v0.5 NEW)** at `results/2026-05-17T09-00-00Z/duplex.json`: 2K-token bidirectional A↔B, JSON-SSE 468.6 KB / msgpack 63.9 KB (7.3×) / protobuf 43.5 KB (10.8×). CPU: msgpack 2.2× faster than JSON-SSE; protobuf 6.6× faster.
- **Energy bench (v0.5 NEW)** at `results/2026-05-17T09-00-00Z/energy/`: per-hop / per-request / worldwide-aggregate budgets generated from the published per-byte cost table. At heavy-agent compound (8 round-trips): ~380 mJ/request JSON-SSE vs ~1.5 mJ/request Codec → ~250× non-GPU energy reduction. Annual at 5B requests/day = ~192 MWh saved ≈ ~15 US-cars/yr CO2-equivalent.

## Cross-stack matrix (last full run, v0.4.1 cohort, 2026-05-15)

The cross-stack run pits **3 inference engines** (sglang, vllm, llama.cpp) against **6 client languages** (Python, TypeScript, .NET, Rust, Java, C) on the same prompt + model + hardware, then aggregates into one machine-generated MATRIX.md. The v0.5 equivalent is pending the RC engine-image builds; refer to the v0.4.1 row until then.

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
