# Codec — measured results

This top-level file is a pointer. The numbers, methodology, and raw
SCHEMA-v1 result JSONs live below — pick the entry point that matches
what you want.

## Cross-stack matrix (current, 2026-05-09)

The cross-stack run pits **3 inference engines** (sglang, vllm,
llama.cpp) against **6 client languages** (Python, TypeScript, .NET,
Rust, Java, C) on the same prompt + model + hardware, then aggregates
into one machine-generated MATRIX.md.

→ **[`packages/bench/results/2026-05-09T17-09-35Z/MATRIX.md`](packages/bench/results/2026-05-09T17-09-35Z/MATRIX.md)**

Headline numbers from that matrix (Python row, Codec msgpack, 2,048-token reply):

| Engine     | JSON-SSE  | Best Codec              | Reduction  |
|------------|----------:|------------------------:|-----------:|
| sglang     | 485.2 KB  | 291 B (msgpack+dict-zstd) | **1,707×** |
| vllm       | 517.8 KB  | 3.9 KB (msgpack+gzip)     | **137×**   |
| llama.cpp  | 529.2 KB  | 16.1 KB (msgpack+gzip)    | **33×**    |

- Cross-language byte-equality: **24/24 Codec cells unanimous on every engine** across all 6 client languages — sglang, vllm, llama.cpp. The earlier vllm "0/24" post-mortem (§7 of the 2026-05-08 MATRIX) is fully resolved by the C/TS token-decode patch + REPS≥2.
- TTFB at 2 K tokens (msgpack + gzip, body-byte): llama.cpp 40.8 ms · sglang 44.7 ms · vllm 59.0 ms.

Reproduce the entire matrix end-to-end:

```bash
# requires the wdunn001/codec-{sglang,vllm,llamacpp}:latest containers running
bash packages/bench/scripts/run-all-langs.sh 2026-05-09T17-09-35Z sglang
bash packages/bench/scripts/run-all-langs.sh 2026-05-09T17-09-35Z vllm
bash packages/bench/scripts/run-all-langs.sh 2026-05-09T17-09-35Z llama.cpp
python packages/bench/scripts/aggregate.py 2026-05-09T17-09-35Z
```

## Detailed single-engine writeup (sglang deep-dive)

Per-cell B/token breakdown, encoding crossover study, ToolWatcher microbench, and the wire-impact study that the sglang and vllm PR descriptions link to:

→ **[`packages/bench/RESULTS.md`](packages/bench/RESULTS.md)**

## Method

- Schema, fingerprinting, TTFB cohort split: [`packages/bench/methodology/SCHEMA.md`](packages/bench/methodology/SCHEMA.md)
- Methodology blocks per (run_id, engine): [`packages/bench/methodology/`](packages/bench/methodology/)
- Aggregator: [`packages/bench/scripts/aggregate.py`](packages/bench/scripts/aggregate.py)
- Per-language matrix runners: [`packages/demo-{python,web,dotnet,rust,java,c}`](packages/)

## Marketing summary

For the consumer-facing version of these numbers (with charts), see [codecai.net](https://codecai.net) — its source is [github.com/wdunn001/codec-website](https://github.com/wdunn001/codec-website).
