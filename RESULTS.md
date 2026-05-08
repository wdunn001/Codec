# Codec — measured results

This top-level file is a pointer. The numbers, methodology, and raw
SCHEMA-v1 result JSONs live below — pick the entry point that matches
what you want.

## Cross-stack matrix (current, 2026-05-08)

The cross-stack run pits **3 inference engines** (sglang, vllm,
llama.cpp) against **6 client languages** (Python, TypeScript, .NET,
Rust, Java, C) on the same prompt + model + hardware, then aggregates
into one machine-generated MATRIX.md.

→ **[`packages/bench/results/2026-05-08T01-15-02Z/MATRIX.md`](packages/bench/results/2026-05-08T01-15-02Z/MATRIX.md)**

Headline numbers from that matrix (Python row, Codec msgpack, 2,048-token reply):

| Engine     | JSON-SSE  | Best Codec        | Reduction  |
|------------|----------:|------------------:|-----------:|
| sglang     | 485.2 KB  | 354 B (dict-zstd) | **1,404×** |
| vllm       | 478.8 KB  | 3.9 KB (gzip)     | **126×**   |
| llama.cpp  | 529.2 KB  | 16 KB (gzip)      | **33×**    |

- Cross-language byte-equality: **24/24 cells unanimous on sglang and llama.cpp** across all 6 client languages. vllm shows 5–10 % chunker drift on its uvicorn proxy.
- TTFB at 2 K tokens (msgpack + gzip, body-byte): llama.cpp 40.7 ms · sglang 45.6 ms · vllm 67.3 ms.

Reproduce the entire matrix end-to-end:

```bash
# requires the wdunn001/codec-{sglang,vllm,llamacpp}:latest containers running
bash packages/bench/scripts/run-all-langs.sh 2026-05-08T01-15-02Z sglang
bash packages/bench/scripts/run-all-langs.sh 2026-05-08T01-15-02Z vllm
bash packages/bench/scripts/run-all-langs.sh 2026-05-08T01-15-02Z llama.cpp
python packages/bench/scripts/aggregate.py 2026-05-08T01-15-02Z
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
