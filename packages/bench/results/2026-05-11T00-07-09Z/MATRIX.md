# Cross-stack benchmark matrix — 2026-05-11T00-07-09Z

Auto-generated from `packages/bench/results/2026-05-11T00-07-09Z/{engine}/{lang}.json` by `packages/bench/scripts/aggregate.py`. SCHEMA.md is the source of truth on what each cell measures.

## §X. Per-language tokenize / detokenize micro-bench

Cross-language pass over a fixed golden corpus (`packages/bench/golden/qwen2.json`, 35 samples, 929 b text, 287 tokens) against `qwen/qwen2` map, 200 measured reps + 20 warmup, median per-pass time. Each `_total` value is the time to encode/decode the WHOLE corpus once.

| Lang | encode total (ms) | encode tok/sec | decode total (ms) | decode tok/sec | encode p99 | decode p99 |
|---|---:|---:|---:|---:|---:|---:|
| **python** | 0.12 | 2,353,993 /s | 0.30 | 963,045 /s | 0.25 | 0.58 |
| **web** | 0.06 | 4,470,301 /s | 0.20 | 1,441,190 /s | 0.24 | 0.69 |
| **dotnet** | 0.06 | 5,017,483 /s | 0.08 | 3,470,375 /s | 0.15 | 2.24 |
| **rust** | 0.05 | 5,982,906 /s | 0.03 | 9,763,399 /s | 0.13 | 0.08 |
| **java** | 0.14 | 2,117,027 /s | 0.12 | 2,315,739 /s | 0.69 | 0.45 |
| **c** | — | — | 0.01 | 24,822,653 /s | — | 0.02 |

- **c**: libcodec is detokenize-only; encode_* are null pending C BPE encoder.
