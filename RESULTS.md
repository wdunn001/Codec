# Codec — measured results

This top-level file is a pointer. The numbers, methodology, and raw SCHEMA-v1 result JSONs live below — pick the entry point that matches what you want.

## Cross-stack matrix (current — v0.5 cohort, 2026-05-17)

The cross-stack run pits **3 inference engines** (sglang, vllm, llama.cpp) against **6 client languages** (Python, TypeScript, .NET, Rust, Java, C) on the same prompt + model + hardware, then aggregates into one machine-generated MATRIX.md.

→ **[`packages/bench/results/2026-05-17T23-06-45Z/MATRIX.md`](packages/bench/results/2026-05-17T23-06-45Z/MATRIX.md)**

### Headline numbers from the v0.5 cohort

**§1b engine-output @ 2K tokens, Codec msgpack+dict-zstd, content-dependent:**

| Engine     | JSON-SSE  | Best Codec                       | Reduction  |
|------------|----------:|---------------------------------:|-----------:|
| sglang     | 485.2 KB  | 291 B (msgpack+dict-zstd)        | **1,707×** |
| vllm       | 517.8 KB  | 3.9 KB (msgpack+gzip)            | **137×**   |
| llama.cpp  | 528.8 KB  | 140 B (msgpack+dict-zstd, fp16)  | **3,868×** |

**Numbers identical to v0.4.1** — confirms the v0.5 additions (delta-varint axis, discoverable zstd dicts, content-aware picker rewrite, bolt-on tool dispatcher) are wire-additive over v0.4 per the [Versioning Policy](spec/versions/v0.4.md#versioning-policy). The v0.5 happy-path wire is byte-for-byte the v0.4 happy-path wire; the new surfaces are reached only via opt-in headers or `stream_format` axes.

vllm still gzip-only on its best cell — content-bound at temp=0, not protocol-bound. See `packages/bench/RESULTS.md` §1b for the per-engine breakdown.

**§1 protocol-only synthetic (no engine, no model — pure library):**

| Content distribution                  | Best Codec vs Codec identity |
|---------------------------------------|-----------------------------:|
| Uniform random (worst case)           | **4.8×**                     |
| Comma-dominated (50% one ID)          | **6.6×**                     |
| Low entropy (50 unique IDs)           | **16.6×**                    |
| Cyclic period 10 (best case)          | **391.9×**                   |

Codec's protocol-only contribution is **4.8×–392×** depending on content compressibility. Versus JSON-SSE identity, multiply by ~10× (Codec's msgpack-over-JSON framing advantage): so the JSON-SSE→Codec range spans ~50× to ~4,000×. Live engine output sits inside that range per §1b above.

### Cross-language interop — gold-standard pass

| Engine     | wire-unanimous | decode-unanimous |
|------------|---------------:|-----------------:|
| sglang     | **24 / 24** ✅ | **24 / 24** ✅   |
| vllm       | **24 / 24** ✅ | **24 / 24** ✅   |
| llama.cpp  | **24 / 24** ✅ | **24 / 24** ✅   |

**72 / 72 wire-unanimous AND 72 / 72 decode-unanimous across the cohort × 6 client languages.** vllm matrix required `REPS=4` to median-out the documented `~10–20%` wire-byte scheduler variance at T=0; ran clean on the second pass.

### What's new in v0.5

- **All v0.5 numbers byte-identical to v0.4.1** at the engine-output level — confirms the additive-only invariant. No regression from the new surfaces.
- **`§1.7` zstd dict gate fully cleared** — sub-gate 1 (image bake-in), sub-gate 2 (`/opt/codec/check-dict-availability.sh` probe), sub-gate 3 (wire-level confirmation), sub-gate 4 (hash unanimity at `sha256:29a810f3...` across all 3 engines).
- **`§1.9` engine dep audit fully cleared** — every engine image dep-verified for `brotli + zstandard + msgpack` before push.
- **llamacpp regression caught + fixed mid-cut** — v0.5.0 initial cut accidentally targeted `wdunn001/llama.cpp/master` (vanilla upstream, no codec patches) and shipped serving identity-encoded msgpack. Caught by §1.7 wire probe; fixed by merging `feat/codec-br-zstd-v0.4.1` into master (commit `5b8f73b86`) and rebuilding. Memory rule [[codec-engine-fork-branch-policy]] updated to prevent recurrence.
- **vllm + sglang upstream PRs filed** — `sgl-project/sglang#25544` and `vllm-project/vllm#42896`, both with DCO-signed commits + 5 review-fix iterations from the gemini-code-assist bot.

### v0.5 cohort companion runs

The v0.5 cut also produced these auxiliary measurements at `packages/bench/results/2026-05-17T09-00-00Z/`:

- **Picker bench (v0.5 NEW)** — 576 cells × 3 stack profiles × 4 payload sizes × 3 entropy buckets × 4 gate states × 4 Accept headers. 7 of 9 v0.5 `PickReasonCode` enum values surfaced by the grid; the other 2 are unit-tested.
- **Duplex bench (v0.5 NEW)** — 2K-token bidirectional A↔B, JSON-SSE 468.6 KB / msgpack 63.9 KB (7.3×) / protobuf 43.5 KB (10.8×). CPU: msgpack 2.2× faster than JSON-SSE; protobuf 6.6× faster.

Reproduce the v0.5 matrix end-to-end:

```bash
# Requires the wdunn001/codec-{sglang,vllm,llamacpp}:v0.5.0 containers running
# (vllm pinned to GPU 1 via CUDA_VISIBLE_DEVICES=1 on a 2-GPU box).
bash packages/bench/scripts/run-all-langs.sh 2026-05-17T23-06-45Z sglang
REPS=4 bash packages/bench/scripts/run-all-langs.sh 2026-05-17T23-06-45Z vllm
bash packages/bench/scripts/run-all-langs.sh 2026-05-17T23-06-45Z llama.cpp
python packages/bench/scripts/synthetic_wire_bench.py 2026-05-17T23-06-45Z  # §1 synthetic
python packages/bench/scripts/aggregate.py 2026-05-17T23-06-45Z
```

### Historical comparison — v0.4.1 cohort (2026-05-15)

For longitudinal context the prior run is preserved at [`packages/bench/results/2026-05-15T20-00-00Z/MATRIX.md`](packages/bench/results/2026-05-15T20-00-00Z/MATRIX.md). v0.5 numbers (above) are byte-identical to v0.4.1 at the engine-output level, confirming no regression from the v0.5 protocol additions.

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
