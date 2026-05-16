# Cross-stack benchmark matrix — 2026-05-15T20-00-00Z

Auto-generated from `packages/bench/results/2026-05-15T20-00-00Z/{engine}/{lang}.json` by `packages/bench/scripts/aggregate.py`. SCHEMA.md is the source of truth on what each cell measures.

## §1. Headline wire reduction @ 2K tokens

Per engine, best-case Codec compression vs JSON-SSE identity. Python row chosen as the canonical client (others agree byte-identically — see §3).

| Engine | JSON-SSE identity | Codec msgpack + gzip | Codec msgpack + dict-zstd | Codec protobuf + gzip | Codec protobuf + dict-zstd |
|---|---:|---:|---:|---:|---:|
| **llama.cpp** | 529.2 KB | 16.1 KB (32.8×) | 28.5 KB (18.6×) | 16.1 KB (32.9×) | 19.3 KB (27.4×) |
| **sglang** | 484.5 KB | 354 b (1401.4×) | 291 b (1704.8×) | 311 b (1595.1×) | 298 b (1664.7×) |
| **vllm** | 412.9 KB | 4,288 b (98.6×) | 4,401 b (96.1×) | 4,418 b (95.7×) | 5,083 b (83.2×) |

## §2. Cross-language Codec wire-byte equality

For every Codec cell (size × {msgpack,protobuf} × encoding), how many byte-identical reports across the available client languages? **6/6** is the gold standard.

### llama.cpp

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

### sglang

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

### vllm

- **20 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)
- Mismatched cells:
  - size=64 msgpack+zstd: c=237, dotnet=237, java=237, python=237, rust=236, web=237
  - size=512 protobuf+identity: c=5157, dotnet=5157, java=5157, python=5161, rust=5157, web=5157
  - size=2048 msgpack+identity: c=30288, dotnet=30288, java=30294, python=30288, rust=30288, web=30288
  - size=2048 protobuf+br: c=29221, dotnet=29221, java=29221, python=29221, rust=29228, web=29221

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
| 2048 | JSON-SSE | 484.5 KB | 485.2 KB | 485.2 KB | 485.2 KB |
| 2048 | Codec msgpack | 30.0 KB | 354 b | 21.3 KB | 291 b |
| 2048 | Codec protobuf | 20.0 KB | 311 b | 20.3 KB | 298 b |

### vllm

`compression_supported`: `['identity', 'gzip', 'br', 'zstd']`

| size | path | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 16.1 KB | 16.1 KB | 16.1 KB | 16.1 KB |
| 64 | Codec msgpack | 957 b | 253 b | 1,143 b | 237 b |
| 64 | Codec protobuf | 643 b | 251 b | 925 b | 262 b |
| 512 | JSON-SSE | 129.6 KB | 129.7 KB | 129.7 KB | 129.7 KB |
| 512 | Codec msgpack | 7,641 b | 1,299 b | 9,191 b | 1,438 b |
| 512 | Codec protobuf | 5,161 b | 1,346 b | 7,421 b | 1,578 b |
| 2048 | JSON-SSE | 412.9 KB | 518.9 KB | 519.0 KB | 518.9 KB |
| 2048 | Codec msgpack | 29.6 KB | 4,288 b | 35.0 KB | 4,401 b |
| 2048 | Codec protobuf | 20.1 KB | 4,418 b | 28.5 KB | 5,083 b |

## §4. TTFB by client definition cohort

Per the SCHEMA.md TTFB definition split (see §5), clients fall into two cohorts:
- **Body-byte cohort** (Python httpx aiter_raw, TypeScript Node http data event, C libcurl WRITEFUNCTION): TTFB = wall-clock from POST to first body byte
- **Headers-byte cohort** (.NET ResponseHeadersRead, Rust reqwest send().await, Java HttpClient.send): TTFB = wall-clock from POST to headers received

Bodies and headers tend to arrive in the same TCP segment for non-buffered encodings (identity/gzip/br) — both cohorts agree. They diverge sharply on dict-zstd, where the server's chunker buffers small responses to end-of-stream.

### llama.cpp — msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 43.2 | 37.1 |
| 64 | gzip | 38.1 | 36.6 |
| 64 | br | 38.6 | 36.9 |
| 64 | zstd | 37.5 | 38.1 |
| 512 | identity | 37.9 | 38.1 |
| 512 | gzip | 37.9 | 38.2 |
| 512 | br | 38.8 | 37.6 |
| 512 | zstd | 38.9 | 37.7 |
| 2048 | identity | 38.9 | 39.0 |
| 2048 | gzip | 39.5 | 37.0 |
| 2048 | br | 38.9 | 39.1 |
| 2048 | zstd | 40.0 | 39.3 |

### sglang — msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 44.8 | 37.0 |
| 64 | gzip | 45.2 | 36.8 |
| 64 | br | 46.6 | 36.3 |
| 64 | zstd | 148 | 36.4 |
| 512 | identity | 46.2 | 37.0 |
| 512 | gzip | 45.8 | 40.2 |
| 512 | br | 45.8 | 36.6 |
| 512 | zstd | 950 | 36.8 |
| 2048 | identity | 39.9 | 37.2 |
| 2048 | gzip | 46.3 | 37.1 |
| 2048 | br | 46.2 | 43.3 |
| 2048 | zstd | 3912 | 37.0 |

### vllm — msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 72.3 | 52.0 |
| 64 | gzip | 72.4 | 52.0 |
| 64 | br | 72.8 | 42.4 |
| 64 | zstd | 659 | 50.9 |
| 512 | identity | 72.3 | 53.0 |
| 512 | gzip | 72.4 | 52.9 |
| 512 | br | 73.7 | 52.5 |
| 512 | zstd | 4928 | 52.7 |
| 2048 | identity | 73.8 | 53.2 |
| 2048 | gzip | 75.4 | 53.2 |
| 2048 | br | 74.8 | 51.6 |
| 2048 | zstd | 19840 | 42.4 |

## §5. Methodology fingerprints

Every row above came from a SCHEMA-v1 result file with a methodology fingerprint computed over the methodology block excluding `client.*`, `bench_tool.*`, `captured_at`, `notes`, `git.repo_dirty_files`. Rows from different langs share the engine's fingerprint. Mismatches surface in §6 quarantine.

| engine | fingerprint | image | model | compression_supported |
|---|---|---|---|---|
| llama.cpp | `2b689f2f38fd2887…` | `wdunn001/codec-llamacpp@sha256:20d0773c28d44e22b89fe2285cf0aa09b644a02a8c10f3…` | `Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M` | identity, gzip |
| sglang | `f112760e6ee33ce1…` | `wdunn001/codec-sglang@sha256:229a51ede62ccb33cb44d14ecac5653c1927ab2b76729b6f…` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |
| vllm | `9d484a10640b46ae…` | `wdunn001/codec-vllm@sha256:72d929aa019d638965474a860aea03973433bdf679db7edf3d…` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |

## §6. Quarantine

None — every row's methodology fingerprint matched its engine's canonical block.
