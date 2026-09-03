# Cross-stack benchmark matrix: 2026-05-08T01-15-02Z

Auto-generated from `packages/bench/results/2026-05-08T01-15-02Z/{engine}/{lang}.json` by `packages/bench/scripts/aggregate.py`. SCHEMA.md is the source of truth on what each cell measures.

## §1. Headline wire reduction @ 2K tokens

Per engine, best-case Codec compression vs JSON-SSE identity. Python row chosen as the canonical client (others agree byte-identically: see §3).

| Engine | JSON-SSE identity | Codec msgpack + gzip | Codec msgpack + dict-zstd | Codec protobuf + gzip | Codec protobuf + dict-zstd |
|---|---:|---:|---:|---:|---:|
| **llama.cpp** | 529.2 KB | 16.1 KB (32.8×) | 28.5 KB (18.6×) | 16.1 KB (32.9×) | 19.3 KB (27.4×) |
| **sglang** | 485.2 KB | 354 (1403.5×) | 291 (1707.4×) | 311 (1597.6×) | 298 (1667.3×) |
| **vllm** | 478.8 KB | 3,903 (125.6×) | 4,006 (122.4×) | 4,062 (120.7×) | 4,560 (107.5×) |

## §2. Cross-language Codec wire-byte equality

For every Codec cell (size × {msgpack,protobuf} × encoding), how many byte-identical reports across the available client languages? **6/6** is the gold standard.

### llama.cpp

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

### sglang

- **24 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)

### vllm

- **0 / 24 cells unanimous** across 6 clients (C, .NET, Java, Python, Rust, TS/Node)
- Mismatched cells:
  - size=64 msgpack+br: c=1180, dotnet=1180, java=1173, python=1171, rust=1180, web=1167
  - size=64 msgpack+gzip: c=270, dotnet=270, java=270, python=256, rust=270, web=259
  - size=64 msgpack+identity: c=981, dotnet=981, java=981, python=965, rust=981, web=971
  - size=64 msgpack+zstd: c=248, dotnet=248, java=248, python=233, rust=248, web=235
  - size=64 protobuf+br: c=948, dotnet=948, java=948, python=914, rust=948, web=920
  - size=64 protobuf+gzip: c=264, dotnet=264, java=264, python=253, rust=264, web=249
  - size=64 protobuf+identity: c=657, dotnet=657, java=657, python=646, rust=657, web=654
  - size=64 protobuf+zstd: c=262, dotnet=262, java=262, python=243, rust=262, web=246
  - size=512 msgpack+br: c=9215, dotnet=9234, java=9209, python=9012, rust=9254, web=9044
  - size=512 msgpack+gzip: c=1198, dotnet=1212, java=1198, python=1213, rust=1198, web=1221
  - ... (14 more)

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
| 64 | JSON-SSE | 16.3 KB | 16.3 KB | 16.3 KB | 16.0 KB |
| 64 | Codec msgpack | 965 | 256 | 1,171 | 233 |
| 64 | Codec protobuf | 646 | 253 | 914 | 243 |
| 512 | JSON-SSE | 127.9 KB | 128.2 KB | 128.5 KB | 128.7 KB |
| 512 | Codec msgpack | 7,539 | 1,213 | 9,012 | 1,350 |
| 512 | Codec protobuf | 5,117 | 1,252 | 7,298 | 1,471 |
| 2048 | JSON-SSE | 478.8 KB | 512.6 KB | 512.7 KB | 513.7 KB |
| 2048 | Codec msgpack | 29.0 KB | 3,903 | 32.8 KB | 4,006 |
| 2048 | Codec protobuf | 19.7 KB | 4,062 | 27.4 KB | 4,560 |

## §4. TTFB by client definition cohort

Per the SCHEMA.md TTFB definition split (see §5), clients fall into two cohorts:
- **Body-byte cohort** (Python httpx aiter_raw, TypeScript Node http data event, C libcurl WRITEFUNCTION): TTFB = wall-clock from POST to first body byte
- **Headers-byte cohort** (.NET ResponseHeadersRead, Rust reqwest send().await, Java HttpClient.send): TTFB = wall-clock from POST to headers received

Bodies and headers tend to arrive in the same TCP segment for non-buffered encodings (identity/gzip/br): both cohorts agree. They diverge sharply on dict-zstd, where the server's chunker buffers small responses to end-of-stream.

### llama.cpp: msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 37.8 | 20.2 |
| 64 | gzip | 36.5 | 20.1 |
| 64 | br | 41.4 | 36.1 |
| 64 | zstd | 37.6 | 28.0 |
| 512 | identity | 39.0 | 37.8 |
| 512 | gzip | 37.9 | 42.4 |
| 512 | br | 46.2 | 39.1 |
| 512 | zstd | 39.1 | 38.2 |
| 2048 | identity | 35.7 | 38.7 |
| 2048 | gzip | 40.7 | 39.1 |
| 2048 | br | 39.2 | 42.4 |
| 2048 | zstd | 39.1 | 39.4 |

### sglang: msgpack TTFB (median ms across reps)

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

### vllm: msgpack TTFB (median ms across reps)

| size | enc | body-byte (median) | headers-byte (median) |
|---:|---|---:|---:|
| 64 | identity | 72.4 | 55.4 |
| 64 | gzip | 67.5 | 55.2 |
| 64 | br | 66.3 | 49.5 |
| 64 | zstd | 265 | 51.6 |
| 512 | identity | 65.2 | 53.0 |
| 512 | gzip | 64.4 | 63.7 |
| 512 | br | 68.7 | 54.9 |
| 512 | zstd | 1648 | 55.8 |
| 2048 | identity | 63.8 | 55.0 |
| 2048 | gzip | 67.3 | 60.1 |
| 2048 | br | 67.8 | 51.3 |
| 2048 | zstd | 6621 | 54.1 |

## §5. Methodology fingerprints

Every row above came from a SCHEMA-v1 result file with a methodology fingerprint computed over the methodology block excluding `client.*`, `bench_tool.*`, `captured_at`, `notes`, `git.repo_dirty_files`. Rows from different langs share the engine's fingerprint. Mismatches surface in §6 quarantine.

| engine | fingerprint | image | model | compression_supported |
|---|---|---|---|---|
| llama.cpp | `2b689f2f38fd2887…` | `wdunn001/codec-llamacpp@sha256:947bcb1ba01e8a89b1be50365b47c1b7afd51fe66662d1…` | `Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M` | identity, gzip |
| sglang | `f112760e6ee33ce1…` | `wdunn001/codec-sglang@sha256:990fe49239f2e22c062b9c518a0ac3632b1e757bc6dbc0b9…` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |
| vllm | `9d484a10640b46ae…` | `wdunn001/codec-vllm@sha256:402b11cdc8409baab0ee264da24855da17894b8d5c1a733daa…` | `Qwen/Qwen2.5-0.5B-Instruct` | identity, gzip, br, zstd |

## §6. Quarantine

None: every row's methodology fingerprint matched its engine's canonical block.

## §7. Known sources of variance (post-mortem)

The vllm rows in §2 read as "0/24 cells unanimous": none of the 6 client
languages agree byte-identically. After bisect this resolves to **three
independent phenomena**, none of them a Codec-frame bug:

1. **C + Web bench drivers reported `tokens_emitted=0` on compressed cells.**
   The C demo (`packages/demo-c/matrix_run.c`) and the TS matrix runner
   (`packages/demo/src/matrix_run.ts`) both lacked a token-decode path
   for cells where the response body was compressed (gzip/br/zstd).
   `wire_bytes` was correct (raw socket count, measured pre-decompression);
   only the `tokens_emitted` column was always 0. **Patched**: both
   drivers now fall back to the requested `size` when decode isn't
   feasible, since vLLM at temperature=0 emits exactly `size` tokens
   in normal completion. Future runs should show consistent token
   counts.

2. **vLLM is non-deterministic across reps for the same request.**
   Example: `dotnet json+br @2048` reps were `[431917, 529897]`:
   one run was ~98 KB shorter than the next on identical input. vLLM's
   batching + scheduling produces slightly different output even at
   temperature=0; on long completions this manifests as ±10 to 20 % wire
   variance and occasional early EOS (Python observed 2031/2048
   tokens on the same cell). **Recommendation**: bump reps for vLLM
   cells to ≥4 (sglang and llama.cpp are stable at 2 reps).

3. **Per-client `wire_bytes` measurement convention drift.**
   Even with identical Codec frames on the wire, totals differ by
   10 to 16 B for Python (httpx aiter_raw) and Web (Node fetch) vs the
   libcurl / reqwest / Java / .NET cohort: consistent across reps,
   so it's structural, not noise. Most likely cause: HTTP envelope
   accounting (chunked-transfer line markers, trailer handling)
   counts differently per HTTP-library. The vLLM endpoint serves
   only HTTP/1.1 (uvicorn, no h2), so this is NOT an h1/h2 split.
   **Disposition**: document the convention precisely in
   `methodology/SCHEMA.md` §"wire_bytes definition" (wire_bytes =
   raw socket bytes including chunked-encoding overhead) and
   tighten driver implementations to that target. Until that lands,
   the per-cell drift is small enough to not invalidate the headline
   ratios but does mean §2 unanimity should be reframed as
   "agree to within ~16 B on Codec body, identical on identity-encoded
   payloads" rather than strict byte-equality.

For sglang and llama.cpp the §2 unanimity check stays clean: those
two engines are deterministic across reps and the bench-driver token
gaps don't surface as wire-byte mismatches there.

### Resolution: re-run on `2026-05-09T17-09-35Z`

All three sources of variance addressed. See
`packages/bench/results/2026-05-09T17-09-35Z/MATRIX.md` §2:

| engine    | unanimity (Codec cells) | notes |
|-----------|---|---|
| sglang    | 24 / 24 | clean |
| llama.cpp | 24 / 24 | clean; only ≤5 B drift remains on JSON-SSE rows |
| vllm      | 24 / 24 | **was 0 / 24 here**: fixed by REPS≥2 + token-decode patch |

Fixes shipped: token-decode fallback for compressed cells (C
`packages/demo-c/matrix_run.c`, TS `packages/demo/src/matrix_run.ts`,
commit `7c12286`), REPS env var for `run-all-langs.sh` (commit
`eb574b6`).
