# Cross-stack benchmark matrix — 2026-05-08T01-15-02Z

Auto-generated from `packages/bench/results/2026-05-08T01-15-02Z/{engine}/{lang}.json` by `packages/bench/scripts/aggregate.py`. SCHEMA.md is the source of truth on what each cell measures.

## §1. Headline wire reduction @ 2K tokens

Per engine, best-case Codec compression vs JSON-SSE identity. Python row chosen as the canonical client (others agree byte-identically — see §3).

| Engine | JSON-SSE identity | Codec msgpack + gzip | Codec msgpack + dict-zstd | Codec protobuf + gzip | Codec protobuf + dict-zstd |
|---|---:|---:|---:|---:|---:|
| **sglang** | 485.2 KB | 354 (1403.5×) | 291 (1707.4×) | 311 (1597.6×) | 298 (1667.3×) |

## §2. Cross-language Codec wire-byte equality

For every Codec cell (size × {msgpack,protobuf} × encoding), how many byte-identical reports across the available client languages? **6/6** is the gold standard.

### sglang

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

## §3. Wire-byte grid per engine (Python row)

Median bytes across reps. Other 5 client languages agree byte-identically on every Codec cell — see §2.

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

## §4. TTFB by client definition cohort

Per the SCHEMA.md TTFB definition split (see §5), clients fall into two cohorts:
- **Body-byte cohort** (Python httpx aiter_raw, TypeScript Node http data event, C libcurl WRITEFUNCTION): TTFB = wall-clock from POST to first body byte
- **Headers-byte cohort** (.NET ResponseHeadersRead, Rust reqwest send().await, Java HttpClient.send): TTFB = wall-clock from POST to headers received

Bodies and headers tend to arrive in the same TCP segment for non-buffered encodings (identity/gzip/br) — both cohorts agree. They diverge sharply on dict-zstd, where the server's chunker buffers small responses to end-of-stream.

### sglang — msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 46.0 | 35.2 |
| 64 | gzip | 44.7 | 35.4 |
| 64 | br | 44.9 | 38.9 |
| 64 | zstd | 152 | 35.3 |
| 512 | identity | 44.2 | 35.8 |
| 512 | gzip | 44.0 | 35.7 |
| 512 | br | 46.9 | 35.7 |
| 512 | zstd | 945 | 40.7 |
| 2048 | identity | 44.6 | 39.8 |
| 2048 | gzip | 45.6 | 36.5 |
| 2048 | br | 45.4 | 36.4 |
| 2048 | zstd | 3918 | 36.2 |

## §5. Methodology fingerprints

Every row above came from a SCHEMA-v1 result file with a methodology fingerprint computed over the methodology block excluding `client.*`, `bench_tool.*`, `captured_at`, `notes`, `git.repo_dirty_files`. Rows from different langs share the engine's fingerprint. Mismatches surface in §6 quarantine.

| engine | fingerprint | image | model | compression_supported |
|---|---|---|---|---|
| sglang | `f112760e6ee33ce1…` | `wdunn001/codec-sglang@sha256:990fe49239f2e22c062b9c518a0ac3632b1e757bc6dbc0b9…` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |

## §6. Quarantine

None — every row's methodology fingerprint matched its engine's canonical block.
