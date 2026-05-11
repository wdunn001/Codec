# Cross-stack benchmark matrix — 2026-05-11T00-12-00Z

Auto-generated from `packages/bench/results/2026-05-11T00-12-00Z/{engine}/{lang}.json` by `packages/bench/scripts/aggregate.py`. SCHEMA.md is the source of truth on what each cell measures.

## §1. Headline wire reduction @ 2K tokens

Per engine, best-case Codec compression vs JSON-SSE identity. Python row chosen as the canonical client (others agree byte-identically — see §3).

| Engine | JSON-SSE identity | Codec msgpack + gzip | Codec msgpack + dict-zstd | Codec protobuf + gzip | Codec protobuf + dict-zstd |
|---|---:|---:|---:|---:|---:|
| **llama.cpp** | 529.2 KB | 16.1 KB (32.8×) | 28.5 KB (18.6×) | 16.1 KB (32.9×) | 19.3 KB (27.4×) |
| **sglang** | 485.2 KB | 354 b (1403.5×) | 291 b (1707.4×) | 311 b (1597.6×) | 298 b (1667.3×) |
| **vllm** | 517.8 KB | 3,874 b (136.9×) | 3,925 b (135.1×) | 3,985 b (133.1×) | 4,476 b (118.5×) |

## §2. Cross-language Codec wire-byte equality

For every Codec cell (size × {msgpack,protobuf} × encoding), how many byte-identical reports across the available client languages? **6/6** is the gold standard.

### llama.cpp

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

### sglang

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

### vllm

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

## §3. Wire-byte grid per engine (Python row)

Median bytes across reps. Other 5 client languages agree byte-identically on every Codec cell — see §2.

### llama.cpp

`compression_supported`: `['identity', 'gzip']`

| size | path | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 17.2 KB | 17.2 KB | 17.2 KB | 17.2 KB |
| 64 | Codec msgpack | 989 b | 680 b | 989 b | 989 b |
| 64 | Codec protobuf | 656 b | 641 b | 656 b | 656 b |
| 512 | JSON-SSE | 133.8 KB | 133.7 KB | 133.7 KB | 133.7 KB |
| 512 | Codec msgpack | 7,644 b | 4,990 b | 7,644 b | 7,644 b |
| 512 | Codec protobuf | 5,145 b | 4,883 b | 5,145 b | 5,145 b |
| 2048 | JSON-SSE | 529.2 KB | 528.2 KB | 528.2 KB | 528.2 KB |
| 2048 | Codec msgpack | 28.5 KB | 16.1 KB | 28.5 KB | 28.5 KB |
| 2048 | Codec protobuf | 19.3 KB | 16.1 KB | 19.3 KB | 19.3 KB |

### sglang

`compression_supported`: `['identity', 'gzip', 'br', 'zstd']`

| size | path | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 15.2 KB | 15.2 KB | 15.2 KB | 15.2 KB |
| 64 | Codec msgpack | 975 b | 226 b | 1,159 b | 213 b |
| 64 | Codec protobuf | 652 b | 224 b | 924 b | 231 b |
| 512 | JSON-SSE | 121.6 KB | 121.6 KB | 121.6 KB | 121.6 KB |
| 512 | Codec msgpack | 7,616 b | 730 b | 9,013 b | 781 b |
| 512 | Codec protobuf | 5,136 b | 723 b | 7,150 b | 819 b |
| 2048 | JSON-SSE | 485.2 KB | 485.2 KB | 485.2 KB | 485.2 KB |
| 2048 | Codec msgpack | 30.0 KB | 354 b | 21.3 KB | 291 b |
| 2048 | Codec protobuf | 20.0 KB | 311 b | 20.3 KB | 298 b |

### vllm

`compression_supported`: `['identity', 'gzip', 'br', 'zstd']`

| size | path | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 16.3 KB | 16.3 KB | 16.3 KB | 16.3 KB |
| 64 | Codec msgpack | 977 b | 256 b | 1,166 b | 234 b |
| 64 | Codec protobuf | 654 b | 249 b | 941 b | 246 b |
| 512 | JSON-SSE | 130.0 KB | 130.0 KB | 130.0 KB | 130.0 KB |
| 512 | Codec msgpack | 7,641 b | 1,200 b | 9,157 b | 1,323 b |
| 512 | Codec protobuf | 5,165 b | 1,223 b | 7,386 b | 1,463 b |
| 2048 | JSON-SSE | 517.8 KB | 517.8 KB | 517.8 KB | 517.8 KB |
| 2048 | Codec msgpack | 29.2 KB | 3,874 b | 33.0 KB | 3,925 b |
| 2048 | Codec protobuf | 19.8 KB | 3,985 b | 27.5 KB | 4,476 b |

## §4. TTFB by client definition cohort

Per the SCHEMA.md TTFB definition split (see §5), clients fall into two cohorts:
- **Body-byte cohort** (Python httpx aiter_raw, TypeScript Node http data event, C libcurl WRITEFUNCTION): TTFB = wall-clock from POST to first body byte
- **Headers-byte cohort** (.NET ResponseHeadersRead, Rust reqwest send().await, Java HttpClient.send): TTFB = wall-clock from POST to headers received

Bodies and headers tend to arrive in the same TCP segment for non-buffered encodings (identity/gzip/br) — both cohorts agree. They diverge sharply on dict-zstd, where the server's chunker buffers small responses to end-of-stream.

### llama.cpp — msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 39.4 | 42.8 |
| 64 | gzip | 45.5 | 47.1 |
| 64 | br | 38.6 | 45.7 |
| 64 | zstd | 38.1 | 45.5 |
| 512 | identity | 39.2 | 44.2 |
| 512 | gzip | 45.8 | 44.6 |
| 512 | br | 40.6 | 45.8 |
| 512 | zstd | 39.7 | 43.8 |
| 2048 | identity | 45.3 | 42.6 |
| 2048 | gzip | 39.1 | 39.9 |
| 2048 | br | 45.8 | 39.0 |
| 2048 | zstd | 39.2 | 39.1 |

### sglang — msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 45.0 | 36.2 |
| 64 | gzip | 45.3 | 38.3 |
| 64 | br | 43.6 | 36.3 |
| 64 | zstd | 154 | 35.2 |
| 512 | identity | 47.4 | 35.8 |
| 512 | gzip | 45.5 | 35.9 |
| 512 | br | 44.2 | 40.7 |
| 512 | zstd | 952 | 36.3 |
| 2048 | identity | 45.1 | 36.8 |
| 2048 | gzip | 46.1 | 36.3 |
| 2048 | br | 46.1 | 41.4 |
| 2048 | zstd | 3923 | 36.6 |

### vllm — msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 60.6 | 51.4 |
| 64 | gzip | 59.9 | 51.4 |
| 64 | br | 59.0 | 52.7 |
| 64 | zstd | 211 | 53.0 |
| 512 | identity | 59.9 | 50.5 |
| 512 | gzip | 59.0 | 52.6 |
| 512 | br | 47.3 | 51.7 |
| 512 | zstd | 1401 | 52.2 |
| 2048 | identity | 59.8 | 52.0 |
| 2048 | gzip | 58.9 | 53.9 |
| 2048 | br | 58.4 | 42.0 |
| 2048 | zstd | 5544 | 48.5 |

## §X. Per-language tokenize / detokenize micro-bench

Cross-language pass over a fixed golden corpus (`packages/bench/golden/qwen2.json`, 35 samples, 929 b text, 287 tokens) against `qwen/qwen2` map, 200 measured reps + 20 warmup, median per-pass time. Each `_total` value is the time to encode/decode the WHOLE corpus once.

| Lang | encode total (ms) | encode tok/sec | decode total (ms) | decode tok/sec | encode p99 | decode p99 |
|---|---:|---:|---:|---:|---:|---:|
| **python** | 0.16 | 1,845,208 /s | 0.37 | 775,654 /s | 0.17 | 0.38 |
| **web** | 0.09 | 3,258,957 /s | 0.40 | 726,171 /s | 0.26 | 0.76 |
| **dotnet** | 0.09 | 3,319,838 /s | 0.13 | 2,179,195 /s | 2.15 | 0.23 |
| **rust** | 0.06 | 4,880,122 /s | 0.04 | 7,103,785 /s | 0.08 | 0.05 |
| **java** | 0.22 | 1,291,461 /s | 0.12 | 2,313,304 /s | 0.53 | 0.41 |
| **c** | — | — | 0.02 | 17,346,602 /s | — | 0.02 |

- **c**: libcodec is detokenize-only; encode_* are null pending C BPE encoder.

## §5. Methodology fingerprints

Every row above came from a SCHEMA-v1 result file with a methodology fingerprint computed over the methodology block excluding `client.*`, `bench_tool.*`, `captured_at`, `notes`, `git.repo_dirty_files`. Rows from different langs share the engine's fingerprint. Mismatches surface in §6 quarantine.

| engine | fingerprint | image | model | compression_supported |
|---|---|---|---|---|
| llama.cpp | `2b689f2f38fd2887…` | `wdunn001/codec-llamacpp@sha256:947bcb1ba01e8a89b1be50365b47c1b7afd51fe66662d1…` | `Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M` | identity, gzip |
| sglang | `f112760e6ee33ce1…` | `wdunn001/codec-sglang@sha256:990fe49239f2e22c062b9c518a0ac3632b1e757bc6dbc0b9…` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |
| vllm | `9d484a10640b46ae…` | `wdunn001/codec-vllm@sha256:402b11cdc8409baab0ee264da24855da17894b8d5c1a733daa…` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |

## §6. Quarantine

None — every row's methodology fingerprint matched its engine's canonical block.
