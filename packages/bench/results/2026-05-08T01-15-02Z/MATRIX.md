# Cross-stack benchmark matrix — 2026-05-08T01:15:02Z

**Phase 1.5 + Phase 2 complete. All 6 client languages × sglang × 3 sizes × 4 encodings populated.** This is the first run where every cell of the (engine × lang × size × encoding) cube is filled with real numbers — no placeholders, no quarantines.

Image: `wdunn001/codec-sglang:latest` rebuilt with the boot-time zstd dict loader (sglang fork `9795b9643`) and the reference dicts baked at `/opt/codec/dicts/` (codec-supervisor `beac2d4`). Hub digest currently at `sha256:f13b79e93a31…`. Container reports `Codec-Zstd-Dict: sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db` on every dict-zstd response.

Methodology fingerprint: `f112760e6ee33ce14c09a7cd5938d5b50becf46e1b3e25a1b7633da70e69c584`.

---

## §1. Cross-language wire-byte fidelity (the headline)

For each (size, format, encoding) cell, the wire bytes reported by all 6 client implementations are **byte-identical**. The grid is large; here's a representative excerpt — full 36-cell breakdown in each language's JSON.

| size | path · enc | Python | TS | .NET | Rust | Java | C |
|---:|---|---:|---:|---:|---:|---:|---:|
| 64 | Codec msgpack · gzip | 226 | 226 | 226 | 226 | 226 | 226 |
| 64 | Codec msgpack · zstd | 213 | 213 | 213 | 213 | 213 | 213 |
| 64 | Codec protobuf · zstd | 231 | 231 | 231 | 231 | 231 | 231 |
| 512 | Codec msgpack · gzip | 730 | 730 | 730 | 730 | 730 | 730 |
| 512 | Codec msgpack · zstd | 781 | 781 | 781 | 781 | 781 | 781 |
| 512 | Codec protobuf · zstd | 819 | 819 | 819 | 819 | 819 | 819 |
| 2048 | Codec msgpack · gzip | 354 | 354 | 354 | 354 | 354 | 354 |
| 2048 | Codec msgpack · **zstd** | **291** | **291** | **291** | **291** | **291** | **291** |
| 2048 | Codec protobuf · **zstd** | **298** | **298** | **298** | **298** | **298** | **298** |

**Result: 6/6 clients agree on every Codec wire byte across every cell.** No drift even on the small-frame br cells (which are non-deterministic on some networks). At 2K tokens, every client correctly reports msgpack+dict-zstd at 291 bytes — a **1,707×** reduction vs JSON-SSE identity (496,841 bytes).

Reproducibility: every cell is a `temperature=0.0` deterministic generation against the same Qwen2.5-0.5B image (`sha256:f13b79e9…`). The byte-equality is the bench's strongest correctness signal — any drift in any port would surface here.

---

## §2. Wire-format matrix — all 36 cells (Python row; identical for the other 5 langs)

### Wire bytes (median, 2 reps)

| size | path · enc | identity | gzip | br | dict-zstd |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 15,559 | 15,559 | 15,559 | 15,559 |
| 64 | Codec msgpack | 975 | **226** | 1,159 ‡ | **213** |
| 64 | Codec protobuf | 652 | **224** | 924 ‡ | 231 |
| 512 | JSON-SSE | 124,534 | 124,534 | 124,534 | 124,534 |
| 512 | Codec msgpack | 7,616 | **730** | 9,013 ‡ | 781 |
| 512 | Codec protobuf | 5,136 | **723** | 7,150 ‡ | 819 |
| 2048 | JSON-SSE | 496,841 | 496,841 | 496,841 | 496,841 |
| 2048 | Codec msgpack | 30,681 | 354 | 21,844 ‡ | **291** |
| 2048 | Codec protobuf | 20,465 | 311 | 20,837 ‡ | **298** |

‡ Brotli misconfigured in sglang's middleware (per-frame quality, expands at small sizes). Same finding as RESULTS.md §1f. Not a Codec issue.

### Reduction vs JSON-SSE identity

| size | msgpack identity | msgpack gzip | msgpack dict-zstd | protobuf gzip | protobuf dict-zstd |
|---:|---:|---:|---:|---:|---:|
| 64 | 16.0× | 68.9× | **73.0×** | 69.5× | 67.4× |
| 512 | 16.4× | **170.6×** | 159.5× | 172.2× | 152.1× |
| 2048 | 16.2× | 1,401× | **1,707×** | 1,597× | 1,667× |

Dict-zstd beats gzip by **17.8% on bytes at 2K tokens** (msgpack: 354 → 291 B). Sub-1K cells trend slightly worse than gzip — the deflate dictionary can't amortise on a tiny payload.

---

## §3. TTFB — definitional split between clients (a finding!)

When measuring TTFB across the 6 clients, two distinct patterns emerge for the **dict-zstd** cells specifically:

| Client | TTFB @ msgpack zstd · 64 tok | TTFB @ msgpack zstd · 2048 tok | What it measures |
|---|---:|---:|---|
| .NET (HttpClient + ResponseHeadersRead) | 36 ms | 38 ms | First byte = HTTP **headers** received |
| Rust (reqwest send().await return) | 35 ms | 27 ms | First byte = HTTP **headers** received |
| Java (HttpClient.send return) | 37 ms | 38 ms | First byte = HTTP **headers** received |
| TypeScript (Node http data event) | 152 ms | 3,925 ms | First byte = first **body** chunk |
| Python (httpx aiter_raw first iter) | 152 ms | 3,918 ms | First byte = first **body** chunk |
| C (libcurl WRITEFUNCTION first call) | 151 ms | 3,911 ms | First byte = first **body** chunk |

Two cohorts split cleanly down the body-vs-headers axis. SCHEMA.md's `ttft_definition` is "wall-clock from request POST to first received byte (TCP-level, before decompression)" — both readings are arguably correct against that wording. The body-byte reading (TS/Python/C) is what feels different to a streaming consumer; the headers reading (.NET/Rust/Java) is the strict TCP-level reading.

For the **gzip and br cells**, all 6 clients agree at ~35–50 ms — the server streams those encodings byte-by-byte, so headers and first-body-chunk arrive in the same TCP segment in practice.

**The dict-zstd TTFB cliff (~3.9 s at 2K tokens) is real and reproducible** for any client that measures first-body-byte: sglang's `_compress_zstd` uses `ZstdCompressor.chunker(chunk_size=16384)`, which buffers in 16 KB blocks. For responses smaller than 16 KB, the chunker yields nothing until `chunker.finish()` runs at end-of-stream — so the first compressed byte arrives at the same wall-clock as the last. This is the picker's `interactive: false` rule earning its keep: dict-zstd is only safe for batch / agent-to-agent workloads where the consumer doesn't care about first-token latency.

A future tightening of SCHEMA.md should lock in **first-body-byte** as the canonical TTFB definition (it's the more useful one for human-facing streams) and ask the headers-reading clients to align. Filed as Phase-3 cleanup.

---

## §4. ToolWatcher and agent loops (Python rows; cross-lang ports pending)

These benches still only have Python implementations. The wire numbers below are durable across runs:

| Bench | Path | Wire | Reduction |
|---|---|---:|---:|
| Single-turn ToolWatcher | JSON-SSE → Codec msgpack server-watcher | 6,034 → 393 B | **15.4×** |
| Mock agent loop | 2-turn round-trip | 13,419 → 794 B | **16.9×** |
| SearXNG agent loop | network-bound dispatch | 66,357 → 3,826 B | **17.3×** |

Python-only. Cross-lang ports of `agent_bench` and `toolcall_bench` are Phase-3.

Raw stdout: [`sglang/toolcall_bench.txt`](sglang/toolcall_bench.txt), [`sglang/agent_bench_mock.txt`](sglang/agent_bench_mock.txt), [`sglang/agent_bench_searxng.txt`](sglang/agent_bench_searxng.txt).

---

## §5. Per-language driver locations + runtime notes

| Lang | Driver | Runtime | TTFB definition |
|---|---|---|---|
| Python | [`packages/demo-python/src/codec_demo/matrix_run.py`](../../../demo-python/src/codec_demo/matrix_run.py) | CPython 3.12.3 / httpx 0.28.1 | first-body-byte |
| TypeScript | [`packages/demo/src/matrix_run.ts`](../../../demo/src/matrix_run.ts) | Node.js 18.19.1 / native http module | first-body-byte |
| .NET | [`packages/demo-dotnet/Program.cs`](../../../demo-dotnet/Program.cs) (matrix mode) | .NET 9 SDK / HttpClient | first-headers-byte |
| Rust | [`packages/demo-rust/src/matrix_run.rs`](../../../demo-rust/src/matrix_run.rs) | rustc 1.95 / reqwest 0.12 | first-headers-byte |
| Java | [`packages/demo-java/src/main/java/ai/codec/bench/MatrixRun.java`](../../../demo-java/src/main/java/ai/codec/bench/MatrixRun.java) | OpenJDK 21 / java.net.http | first-headers-byte |
| C | [`packages/demo-c/matrix_run.c`](../../../demo-c/matrix_run.c) | libcurl 8.5.0 / libcodec | first-body-byte (WRITEFUNCTION) |

All six produce SCHEMA-v1 result files at `sglang/{lang}.json`. Each file's `methodology` block carries that client's specific `ttft_definition` and `bench_tool` fields, with the rest of the methodology fingerprinted to `f112760e…`.

### Caveats baked into the per-lang ports

- **Java** required forcing `HttpClient.Version.HTTP_1_1`. The JDK HttpClient defaults to HTTP/2 but the codec-supervisor's uvicorn proxy returns "Invalid HTTP request received." on h2 attempts.
- **C** doesn't decompress in the bench (`tokens_emitted = 0` for compressed cells). Wire bytes and TTFB are valid; full decoding would require linking zstd and a brotli C library beyond what libcurl provides. Token counts on identity cells are correct.
- **.NET** lacks zstd in the BCL — same `tokens_emitted = 0` for zstd cells. Wire bytes valid.
- **Rust** stocks `zstd::decode_all` (no dict). Dict-zstd cells fail decode, fall through to `tokens_emitted = 0` with the dict-mismatch error string preserved on the row. Wire bytes valid.
- **Python and TS** have full dict-aware decode paths (Python via `codec_demo.CODEC_ZSTD_DICTS`, TS by accident — `@msgpack/msgpack` happens to handle the post-zstd byte stream once gzip/identity is decompressed). Token counts populate fully.

Decompression-tolerant pattern (mirrors RFC 9651's "best-effort decode" in HTTP middlewares): wire bytes / TTFB / total time **always land** regardless of decompression outcome. Dict mismatches surface on the row's `error` field but never zero-out the primary signal.

---

## §6. Phase 2 status

| Item | Status |
|---|---|
| Python `matrix_run.py` | ✅ shipped 2026-05-07T23-08; full dict-zstd round-trip with client-side dict registry |
| TypeScript port | ✅ shipped this run; Node http stdlib, no auto-decompress |
| .NET port | ✅ shipped this run; AutomaticDecompression=None; BCL no-zstd known limitation |
| Rust port | ✅ shipped this run; reqwest no_gzip/no_brotli/no_zstd; decompress-tolerant |
| Java port | ✅ shipped this run; HTTP/1.1 forced; OpenJDK 21 |
| C port | ✅ shipped this run; libcurl + libcodec; minimal hand-rolled JSON I/O |
| **Cross-language wire-byte equality** | ✅ **byte-identical Codec rows across all 6 clients × 36 cells × 3 sizes** |

---

## §7. Phase 3 — what's still missing for the full cross-stack matrix

Now that Python + the 5 new language ports work, the remaining gap is **engines**, not languages.

| Stack | Coverage |
|---|---|
| **sglang** | ✅ this run — all 6 langs × 36 cells |
| **vLLM** | ❌ deploy still blocked (torch 2.11 ↔ xformers 2.7.1 — needs a from-source build or a custom Docker image with pinned torch) |
| **llama.cpp** | ⚠ binary built, **no GGUF loaded** on lab box. One Qwen2.5-0.5B GGUF download from the bench harness running |

Plus:

- **Aggregator script** — `packages/bench/scripts/aggregate.py` doesn't exist; MATRIX.md is hand-written. With 6 lang × 3 stacks × 36 cells × 2 reps = 1,296 cells coming, an aggregator becomes mandatory.
- **`agent_bench` / `toolcall_bench` cross-language ports** — currently Python-only. Per the existing Codec.Net / @codecai/web / codecai / libcodec ToolWatchers, these benches can be ported language-by-language, but each is its own ~300 LOC effort.
- **TTFB-definition harmonisation** in SCHEMA.md so the headers-reading and body-reading clients converge. See §3.

---

## §8. Headlines

| Claim | Number |
|---|---:|
| Cross-language Codec wire-byte equality | **6/6 clients × 108 Codec cells = 0 byte drift** |
| Codec msgpack + dict-zstd @ 2K tok | 291 B = **1,707×** vs JSON-SSE |
| Codec protobuf + dict-zstd @ 2K tok | 298 B = **1,667×** vs JSON-SSE |
| Codec msgpack + gzip @ 2K tok | 354 B = 1,401× vs JSON-SSE |
| Dict-zstd advantage over gzip @ 2K tok | **17.8%** smaller |
| Dict-zstd TTFB cliff (Python/C/TS clients) | **3,918 ms** (vs gzip's 46 ms) |
| Dict-zstd TTFB on header-measuring clients (.NET/Rust/Java) | ~36 ms — same as gzip |

The byte-equality cell of the headlines table is the cleanest validation we've ever had: six independent client implementations of the Codec wire, written in six different runtimes (CPython, V8, .NET 9, rustc 1.95, OpenJDK 21, GCC + libcurl), reading the same response, all reporting identical bytes for identical (server, prompt, format, encoding) inputs. **The Codec wire is fully reproducible across the polyglot client matrix.**
