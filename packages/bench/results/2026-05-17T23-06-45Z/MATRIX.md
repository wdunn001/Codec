# Cross-stack benchmark matrix: 2026-05-17T23-06-45Z

Auto-generated from `packages/bench/results/2026-05-17T23-06-45Z/{engine}/{lang}.json` by `packages/bench/scripts/aggregate.py`. SCHEMA.md is the source of truth on what each cell measures.

## §1. Headline wire reduction: synthetic streams (protocol only)

Pure-library measurement: known token-ID sequences fed through the Codec
encoder + compression pipeline locally, no inference engine, no model. Same
library code every engine uses. Measures protocol efficiency in isolation,
decoupled from how any specific model happens to generate text.

Four token-distribution corpora at 2K tokens, msgpack mode:

| Corpus (token-ID distribution) | identity | gzip | br | dict-zstd | best ratio vs identity |
|---|---:|---:|---:|---:|---:|
| Uniform random (worst case) | 32.3 KB | 7,223 b | 6,957 b | 7,542 b | 4.8× |
| Comma-dominated (50% one ID) | 29.1 KB | 4,482 b | 4,632 b | 5,221 b | 6.6× |
| Low entropy (50 unique IDs) | 26.0 KB | 2,914 b | 3,446 b | 1,606 b | 16.6× |
| Cyclic period 10 (best case) | 26.0 KB | 211 b | 73 b | 68 b | 391.9× |

The honest framing: Codec wire+compression delivers **~4-17× over identity**
on arbitrary-to-typical streams. It reaches **100-400× on structurally-repetitive**
ones. The lower bound (uniform-random) is the floor: there's no content
redundancy to exploit. The wins come from msgpack/protobuf framing alone.
The upper bound (cyclic) is what dict-zstd can do when the content cooperates.

Live model output sits somewhere in this range, depending on what the model
happens to generate: see §1b for engine-specific numbers from this run.

## §1b. Engine-output wire reduction @ 2K tokens (content-dependent)

Per engine, best-case Codec compression vs JSON-SSE identity, measured against
the actual model output. Numbers vary by engine because each engine's specific
sampler/attention path produces slightly different token sequences at T=0, and
those sequences compress differently. For protocol-only efficiency see §1.

Python row chosen as the canonical client (others agree byte-identically: see §3).

| Engine | JSON-SSE identity | Codec msgpack + gzip | Codec msgpack + dict-zstd | Codec protobuf + gzip | Codec protobuf + dict-zstd |
|---|---:|---:|---:|---:|---:|
| **llama.cpp** | 528.8 KB | 16.1 KB (32.8×) | 140 b (3867.9×) | 16.1 KB (32.8×) | 158 b (3427.2×) |
| **sglang** | 485.2 KB | 354 b (1403.5×) | 291 b (1707.4×) | 311 b (1597.6×) | 298 b (1667.3×) |
| **vllm** | 517.8 KB | 3,874 b (136.9×) | 3,925 b (135.1×) | 3,985 b (133.1×) | 4,476 b (118.5×) |

## §2. Cross-language Codec wire-byte equality + decode unanimity

For every Codec cell (size × {msgpack,protobuf} × encoding), the aggregator reports two unanimity scores:

- **wire-unanimous**: clients agree byte-for-byte on what came over the wire (bytes received)
- **decode-unanimous**: clients agree on the decoded token count (bytes received actually parsed back into the same number of token IDs)

**6/6 wire AND 6/6 decode is the gold standard.** A cell that is wire-unanimous but decode-mismatched means the bytes are the same but some clients can't actually parse them: usually a missing dict (dict-zstd interop) or a parser bug. Wire-unanimity alone is misleading; cells where 3/6 clients hit `Dictionary mismatch` errors used to count as "unanimous" until v0.4.1: that gap is the reason this section now has two scores.

### llama.cpp

- **24 / 24 cells wire-unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)
- **24 / 24 cells decode-unanimous** (every client decoded the same token count, none errored)

### sglang

- **24 / 24 cells wire-unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)
- **24 / 24 cells decode-unanimous** (every client decoded the same token count, none errored)

### vllm

- **24 / 24 cells wire-unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)
- **24 / 24 cells decode-unanimous** (every client decoded the same token count, none errored)

## §3. Wire-byte grid per engine (Python row)

Median bytes across reps. Other 5 client languages agree byte-identically on every Codec cell: see §2.

### llama.cpp

`compression_supported`: `['identity', 'gzip', 'br', 'zstd']`

| size | path | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 17.2 KB | 17.2 KB | 17.2 KB | 17.2 KB |
| 64 | Codec msgpack | 987 b | 728 b | 227 b | 218 b |
| 64 | Codec protobuf | 657 b | 694 b | 221 b | 222 b |
| 512 | JSON-SSE | 133.3 KB | 133.3 KB | 133.3 KB | 133.3 KB |
| 512 | Codec msgpack | 7,623 b | 4,972 b | 738 b | 840 b |
| 512 | Codec protobuf | 5,155 b | 4,795 b | 792 b | 919 b |
| 2048 | JSON-SSE | 528.8 KB | 528.8 KB | 528.8 KB | 528.8 KB |
| 2048 | Codec msgpack | 29.7 KB | 16.1 KB | 161 b | 140 b |
| 2048 | Codec protobuf | 19.8 KB | 16.1 KB | 158 b | 158 b |

### sglang

`compression_supported`: `['identity', 'gzip', 'br', 'zstd']`

| size | path | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 15.2 KB | 15.2 KB | 15.2 KB | 15.2 KB |
| 64 | Codec msgpack | 975 b | 226 b | 223 b | 213 b |
| 64 | Codec protobuf | 652 b | 224 b | 222 b | 231 b |
| 512 | JSON-SSE | 121.6 KB | 121.6 KB | 121.6 KB | 121.6 KB |
| 512 | Codec msgpack | 7,616 b | 730 b | 673 b | 781 b |
| 512 | Codec protobuf | 5,136 b | 723 b | 734 b | 819 b |
| 2048 | JSON-SSE | 485.2 KB | 485.2 KB | 485.2 KB | 485.2 KB |
| 2048 | Codec msgpack | 30.0 KB | 354 b | 274 b | 291 b |
| 2048 | Codec protobuf | 20.0 KB | 311 b | 278 b | 298 b |

### vllm

`compression_supported`: `['identity', 'gzip', 'br', 'zstd']`

| size | path | identity | gzip | br | zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 16.3 KB | 16.3 KB | 16.3 KB | 16.3 KB |
| 64 | Codec msgpack | 977 b | 256 b | 238 b | 234 b |
| 64 | Codec protobuf | 654 b | 249 b | 239 b | 246 b |
| 512 | JSON-SSE | 130.0 KB | 130.0 KB | 130.0 KB | 130.0 KB |
| 512 | Codec msgpack | 7,641 b | 1,200 b | 1,138 b | 1,323 b |
| 512 | Codec protobuf | 5,165 b | 1,223 b | 1,244 b | 1,463 b |
| 2048 | JSON-SSE | 517.8 KB | 517.8 KB | 517.8 KB | 517.8 KB |
| 2048 | Codec msgpack | 29.2 KB | 3,874 b | 3,952 b | 3,925 b |
| 2048 | Codec protobuf | 19.8 KB | 3,985 b | 4,244 b | 4,476 b |

## §4. TTFB by client definition cohort

Per the SCHEMA.md TTFB definition split (see §5), clients fall into two cohorts:
- **Body-byte cohort** (Python httpx aiter_raw, TypeScript Node http data event, C libcurl WRITEFUNCTION): TTFB = wall-clock from POST to first body byte
- **Headers-byte cohort** (.NET ResponseHeadersRead, Rust reqwest send().await, Java HttpClient.send): TTFB = wall-clock from POST to headers received

Bodies and headers tend to arrive in the same TCP segment for non-buffered encodings (identity/gzip/br): both cohorts agree. They diverge sharply on dict-zstd, where the server's chunker buffers small responses to end-of-stream.

### llama.cpp: msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 43.5 | 38.6 |
| 64 | gzip | 38.3 | 38.6 |
| 64 | br | 195 | 38.2 |
| 64 | zstd | 195 | 44.4 |
| 512 | identity | 40.6 | 41.4 |
| 512 | gzip | 43.0 | 39.9 |
| 512 | br | 1312 | 40.1 |
| 512 | zstd | 1311 | 40.4 |
| 2048 | identity | 41.4 | 40.7 |
| 2048 | gzip | 44.7 | 40.7 |
| 2048 | br | 5164 | 41.1 |
| 2048 | zstd | 5167 | 41.6 |

### sglang: msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 45.1 | 37.2 |
| 64 | gzip | 44.2 | 36.5 |
| 64 | br | 152 | 36.5 |
| 64 | zstd | 153 | 40.9 |
| 512 | identity | 46.2 | 40.5 |
| 512 | gzip | 47.6 | 37.5 |
| 512 | br | 951 | 36.9 |
| 512 | zstd | 951 | 37.0 |
| 2048 | identity | 45.7 | 37.0 |
| 2048 | gzip | 45.7 | 37.3 |
| 2048 | br | 3919 | 40.9 |
| 2048 | zstd | 3919 | 37.1 |

### vllm: msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 60.2 | 53.5 |
| 64 | gzip | 60.2 | 53.2 |
| 64 | br | 202 | 54.3 |
| 64 | zstd | 200 | 53.5 |
| 512 | identity | 60.2 | 54.0 |
| 512 | gzip | 61.6 | 53.7 |
| 512 | br | 1213 | 53.6 |
| 512 | zstd | 1214 | 53.9 |
| 2048 | identity | 61.4 | 54.8 |
| 2048 | gzip | 61.5 | 54.2 |
| 2048 | br | 4719 | 53.9 |
| 2048 | zstd | 4718 | 54.6 |

## §X. Per-language tokenize / detokenize micro-bench

Cross-language pass over a fixed golden corpus (`packages/bench/golden/qwen2.json`, 35 samples, 929 b text, 287 tokens) against `qwen/qwen2` map, 200 measured reps + 20 warmup, median per-pass time. Each `_total` value is the time to encode/decode the WHOLE corpus once.

| Lang | encode total (ms) | encode tok/sec | decode total (ms) | decode tok/sec | encode p99 | decode p99 |
|---|---:|---:|---:|---:|---:|---:|
| **python** | 0.12 | 2,305,406 /s | 0.31 | 939,642 /s | 0.26 | 0.60 |
| **web** | 0.11 | 2,649,337 /s | 0.33 | 877,577 /s | 0.25 | 1.15 |
| **dotnet** | 0.08 | 3,589,744 /s | 0.11 | 2,594,937 /s | 0.35 | 2.21 |
| **rust** | 0.05 | 5,897,886 /s | 0.03 | 9,830,450 /s | 0.08 | 0.07 |
| **java** | 0.18 | 1,623,042 /s | 0.12 | 2,402,166 /s | 0.85 | 0.50 |
| **c** | n/a | n/a | 0.01 | 22,991,267 /s | n/a | 0.02 |

- **c**: libcodec is detokenize-only; encode_* are null pending C BPE encoder.

## §5. Methodology fingerprints

Every row above came from a SCHEMA-v1 result file with a methodology fingerprint computed over the methodology block excluding `client.*`, `bench_tool.*`, `captured_at`, `notes`, `git.repo_dirty_files`. Rows from different langs share the engine's fingerprint. Mismatches surface in §6 quarantine.

| engine | fingerprint | image | model | compression_supported |
|---|---|---|---|---|
| llama.cpp | `c8ed8d89931ed7e6…` | `None` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |
| sglang | `b639bf5fbf5a2df6…` | `None` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |
| vllm | `4e364ff86faf79d0…` | `None` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |

## §6. Quarantine

None: every row's methodology fingerprint matched its engine's canonical block.
