# Cross-stack benchmark matrix: 2026-05-09T17-09-35Z

Auto-generated from `packages/bench/results/2026-05-09T17-09-35Z/{engine}/{lang}.json` by `packages/bench/scripts/aggregate.py`. SCHEMA.md is the source of truth on what each cell measures.

## §1. Headline wire reduction @ 2K tokens

Per engine, best-case Codec compression vs JSON-SSE identity. Python row chosen as the canonical client (others agree byte-identically: see §3).

| Engine | JSON-SSE identity | Codec msgpack + gzip | Codec msgpack + dict-zstd | Codec protobuf + gzip | Codec protobuf + dict-zstd |
|---|---:|---:|---:|---:|---:|
| **llama.cpp** | 529.2 KB | 16.1 KB (32.8×) | 28.5 KB (18.6×) | 16.1 KB (32.9×) | 19.3 KB (27.4×) |
| **sglang** | 485.2 KB | 354 (1403.5×) | 291 (1707.4×) | 311 (1597.6×) | 298 (1667.3×) |
| **vllm** | 517.8 KB | 3,874 (136.9×) | 3,925 (135.1×) | 3,985 (133.1×) | 4,476 (118.5×) |

## §2. Cross-language Codec wire-byte equality

For every Codec cell (size × {msgpack,protobuf} × encoding), how many byte-identical reports across the available client languages? **6/6** is the gold standard.

### llama.cpp

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

### sglang

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

### vllm

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

## §3. Wire-byte grid per engine (Python row)

Median bytes across reps. Other 5 client languages agree byte-identically on every Codec cell: see §2.

### llama.cpp

`compression_supported`: `['identity', 'gzip']`

| size | path | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 17.2 KB | 17.2 KB | 17.2 KB | 17.2 KB |
| 64 | Codec msgpack | 989 | 680 | 989 | 989 |
| 64 | Codec protobuf | 656 | 641 | 656 | 656 |
| 512 | JSON-SSE | 133.8 KB | 133.7 KB | 133.7 KB | 133.7 KB |
| 512 | Codec msgpack | 7,644 | 4,990 | 7,644 | 7,644 |
| 512 | Codec protobuf | 5,145 | 4,883 | 5,145 | 5,145 |
| 2048 | JSON-SSE | 529.2 KB | 528.2 KB | 528.2 KB | 528.2 KB |
| 2048 | Codec msgpack | 28.5 KB | 16.1 KB | 28.5 KB | 28.5 KB |
| 2048 | Codec protobuf | 19.3 KB | 16.1 KB | 19.3 KB | 19.3 KB |

### sglang

`compression_supported`: `['identity', 'gzip', 'br', 'zstd']`

| size | path | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 15.2 KB | 15.2 KB | 15.2 KB | 15.2 KB |
| 64 | Codec msgpack | 975 | 226 | 1,159 | 213 |
| 64 | Codec protobuf | 652 | 224 | 924 | 231 |
| 512 | JSON-SSE | 121.6 KB | 121.6 KB | 121.6 KB | 121.6 KB |
| 512 | Codec msgpack | 7,616 | 730 | 9,013 | 781 |
| 512 | Codec protobuf | 5,136 | 723 | 7,150 | 819 |
| 2048 | JSON-SSE | 485.2 KB | 485.2 KB | 485.2 KB | 485.2 KB |
| 2048 | Codec msgpack | 30.0 KB | 354 | 21.3 KB | 291 |
| 2048 | Codec protobuf | 20.0 KB | 311 | 20.3 KB | 298 |

### vllm

`compression_supported`: `['identity', 'gzip', 'br', 'zstd']`

| size | path | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 16.3 KB | 16.3 KB | 16.3 KB | 16.3 KB |
| 64 | Codec msgpack | 977 | 256 | 1,166 | 234 |
| 64 | Codec protobuf | 654 | 249 | 941 | 246 |
| 512 | JSON-SSE | 130.0 KB | 130.0 KB | 130.0 KB | 130.0 KB |
| 512 | Codec msgpack | 7,641 | 1,200 | 9,157 | 1,323 |
| 512 | Codec protobuf | 5,165 | 1,223 | 7,386 | 1,463 |
| 2048 | JSON-SSE | 517.8 KB | 517.8 KB | 517.8 KB | 517.8 KB |
| 2048 | Codec msgpack | 29.2 KB | 3,874 | 33.0 KB | 3,925 |
| 2048 | Codec protobuf | 19.8 KB | 3,985 | 27.5 KB | 4,476 |

## §4. TTFB by client definition cohort

Per the SCHEMA.md TTFB definition split (see §5), clients fall into two cohorts:
- **Body-byte cohort** (Python httpx aiter_raw, TypeScript Node http data event, C libcurl WRITEFUNCTION): TTFB = wall-clock from POST to first body byte
- **Headers-byte cohort** (.NET ResponseHeadersRead, Rust reqwest send().await, Java HttpClient.send): TTFB = wall-clock from POST to headers received

Bodies and headers tend to arrive in the same TCP segment for non-buffered encodings (identity/gzip/br): both cohorts agree. They diverge sharply on dict-zstd, where the server's chunker buffers small responses to end-of-stream.

### llama.cpp: msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 36.4 | 36.9 |
| 64 | gzip | 38.2 | 41.2 |
| 64 | br | 42.2 | 38.3 |
| 64 | zstd | 37.6 | 36.5 |
| 512 | identity | 39.6 | 38.1 |
| 512 | gzip | 30.9 | 38.3 |
| 512 | br | 39.7 | 37.7 |
| 512 | zstd | 44.8 | 40.1 |
| 2048 | identity | 37.6 | 40.7 |
| 2048 | gzip | 40.8 | 39.2 |
| 2048 | br | 39.7 | 40.1 |
| 2048 | zstd | 40.1 | 31.4 |

### sglang: msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 46.1 | 35.4 |
| 64 | gzip | 43.8 | 37.5 |
| 64 | br | 37.0 | 35.3 |
| 64 | zstd | 152 | 35.3 |
| 512 | identity | 44.0 | 35.4 |
| 512 | gzip | 44.9 | 35.8 |
| 512 | br | 41.8 | 40.1 |
| 512 | zstd | 953 | 36.0 |
| 2048 | identity | 44.8 | 36.7 |
| 2048 | gzip | 44.7 | 36.9 |
| 2048 | br | 45.5 | 36.2 |
| 2048 | zstd | 3921 | 36.2 |

### vllm: msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 59.1 | 51.2 |
| 64 | gzip | 58.8 | 52.0 |
| 64 | br | 57.2 | 41.3 |
| 64 | zstd | 189 | 48.4 |
| 512 | identity | 59.1 | 51.3 |
| 512 | gzip | 57.8 | 51.5 |
| 512 | br | 59.0 | 51.4 |
| 512 | zstd | 1125 | 51.8 |
| 2048 | identity | 60.3 | 52.5 |
| 2048 | gzip | 59.0 | 51.3 |
| 2048 | br | 58.6 | 52.1 |
| 2048 | zstd | 4362 | 51.1 |

## §5. Methodology fingerprints

Every row above came from a SCHEMA-v1 result file with a methodology fingerprint computed over the methodology block excluding `client.*`, `bench_tool.*`, `captured_at`, `notes`, `git.repo_dirty_files`. Rows from different langs share the engine's fingerprint. Mismatches surface in §6 quarantine.

| engine | fingerprint | image | model | compression_supported |
|---|---|---|---|---|
| llama.cpp | `2b689f2f38fd2887…` | `wdunn001/codec-llamacpp@sha256:947bcb1ba01e8a89b1be50365b47c1b7afd51fe66662d1…` | `Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M` | identity, gzip |
| sglang | `f112760e6ee33ce1…` | `wdunn001/codec-sglang@sha256:990fe49239f2e22c062b9c518a0ac3632b1e757bc6dbc0b9…` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |
| vllm | `9d484a10640b46ae…` | `wdunn001/codec-vllm@sha256:402b11cdc8409baab0ee264da24855da17894b8d5c1a733daa…` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |

## §6. Quarantine

None: every row's methodology fingerprint matched its engine's canonical block.
