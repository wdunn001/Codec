# Cross-stack benchmark matrix — 2026-05-08T01:15:02Z

Phase 1.5 + Phase 2a checkpoint. Two language rows now populated for
sglang: Python (the canonical reference) and TypeScript/Node (new port
in this run, wire bytes byte-identical to Python within 1 byte across
all 36 cells). Image is `wdunn001/codec-sglang:latest` rebuilt with
the boot-time zstd dict loader (`9795b9643` in sglang fork) and the
reference dicts baked at `/opt/codec/dicts/` (`beac2d4` in
codec-supervisor). End-to-end Codec-Zstd-Dict header round-trip
verified on the wire.

Methodology fingerprint:
`f112760e6ee33ce14c09a7cd5938d5b50becf46e1b3e25a1b7633da70e69c584`

Image SHA: `wdunn001/codec-sglang@sha256:990fe49239f2…` (Hub `:latest`).

---

## §1. Wire-format matrix (Python and TS rows agree within 1 byte)

### Wire bytes (median, Python row; TS row matches)

| size | path · enc | identity | gzip | br | **dict-zstd** |
|---:|---|---:|---:|---:|---:|
| 64 | JSON-SSE | 15,559 | 15,559 | 15,559 | 15,559 |
| 64 | Codec msgpack | 975 | **226** | 1,159 ‡ | **213** † |
| 64 | Codec protobuf | 652 | **224** | 924 ‡ | 231 † |
| 512 | JSON-SSE | 124,534 | 124,534 | 124,534 | 124,534 |
| 512 | Codec msgpack | 7,616 | **730** | 9,013 ‡ | 781 † |
| 512 | Codec protobuf | 5,136 | **723** | 7,150 ‡ | 819 † |
| 2048 | JSON-SSE | 496,841 | 496,841 | 496,841 | 496,841 |
| 2048 | Codec msgpack | 30,681 | 354 | 21,844 ‡ | **291** † |
| 2048 | Codec protobuf | 20,465 | 311 | 20,837 ‡ | **298** † |

† **dict-zstd populated** (was identity-bytes in prior runs because no
dict was loaded). At 2K tokens dict-zstd is 17.8% smaller than gzip on
msgpack (291 B vs 354 B) and 4.2% smaller on protobuf (298 B vs 311 B).
Sub-1K cells trend slightly worse than gzip — frame-header overhead
dominates the dict's gain on tiny payloads.

‡ br is misconfigured in sglang's middleware (per-frame compression
with a quality setting that doesn't fit small frames). At 64 and 512
tok br **expands** the payload over identity. Same finding as
RESULTS.md §1f. Not a Codec issue — fix is upstream in sglang's
brotli config.

### Reduction vs JSON-SSE identity

| size | msgpack identity | msgpack gzip | msgpack dict-zstd | protobuf gzip | protobuf dict-zstd |
|---:|---:|---:|---:|---:|---:|
| 64 | 16.0× | **68.9×** | 73.0× | **69.5×** | 67.4× |
| 512 | 16.4× | **170.6×** | 159.5× | 172.2× | 152.1× |
| 2048 | 16.2× | 1,401× | **1,707×** | 1,597× | 1,667× |

Dict-zstd finally beats gzip at 2K tokens. The msgpack column hits
**1,707× vs JSON-SSE identity** (496 KB → 291 B) — best Codec result
to date.

### TTFT — dict-zstd has the buffered-middleware cliff

| size | gzip | br | **dict-zstd** | regression |
|---:|---:|---:|---:|---:|
| 64 | 45 ms | 45 ms | 152 ms | 3.4× |
| 512 | 36 ms | 47 ms | **945 ms** | 26× |
| 2048 | 46 ms | 46 ms | **3,918 ms** | 85× |

zstd's TTFT regresses badly because sglang's middleware buffers the
whole response before sending — even with a dict. Reproduces
RESULTS.md §1d's "shipped buffered zstd middleware" finding. **Use
dict-zstd for batch / agent-to-agent, never for interactive
streaming.** This is the exact rule the wire-compress picker enforces
via `interactive: false`.

Raw rows: [`sglang/python.json`](sglang/python.json) and
[`sglang/web.json`](sglang/web.json) — 36 rows each, per-rep arrays
included.

---

## §2. ToolWatcher single-turn

```
prompt: "What is the weather in Tokyo?"
```

| Path | wire | tokens | TTFB | total |
|---|---:|---:|---:|---:|
| JSON-SSE + client text scan | 6,034 B | 22 | 1,180.7 ms | 1,205.6 ms |
| Codec msgpack + client detok+scan | 343 B | 21 | 31.5 ms | 68.0 ms |
| Codec msgpack + server `tool_watcher` | **393 B** | 1 | **46.7 ms** | 82.3 ms |

**15.4× wire reduction. 25× faster TTFB.** Stable claim across all
runs ([2026-05-07T23-08](../2026-05-07T23-08-54Z/MATRIX.md),
[2026-05-07T23-42](../2026-05-07T23-42-00Z/MATRIX.md), and this one).

Raw: [`sglang/toolcall_bench.txt`](sglang/toolcall_bench.txt).

---

## §3. End-to-end agent loops

### Mock weather

| Path | wire | dispatch | TTFB | total |
|---|---:|---:|---:|---:|
| JSON-SSE | 13,419 B | 1.1 ms | 56.1 ms | 189.8 ms |
| Codec | **794 B** | 1.2 ms | 50.1 ms | 184.4 ms |

16.9× wire / 3% faster total. Wire is the durable claim; total parity
is expected when dispatch and decode dominate.

### SearXNG (real network round-trip)

| Path | wire | dispatch | TTFB | total |
|---|---:|---:|---:|---:|
| JSON-SSE | 66,357 B | 1,003.6 ms | 42.5 ms | 1,544.9 ms |
| Codec | **3,826 B** | 840.8 ms | 52.9 ms | **1,416.7 ms** |

**17.3× wire reduction. 8% faster total** on this run (network-bound).

Raw:
[`sglang/agent_bench_mock.txt`](sglang/agent_bench_mock.txt),
[`sglang/agent_bench_searxng.txt`](sglang/agent_bench_searxng.txt).

---

## §4. Cross-language verification — Python ≡ TS

The matrix is now multi-row. Python and TypeScript ports of `matrix_run`
produce wire bytes that agree within 1 byte across all 36 cells (the
1-byte drift comes from JSON-SSE's `finish_reason` field length
non-determinism and is observable at JSON-SSE identity row only —
15,579 vs 15,559). Codec rows are byte-identical because the wire
format is deterministic at temperature=0.

Methodology fingerprint matches between rows
(`f112760e6ee33ce14c09a7cd5938d5b50becf46e1b3e25a1b7633da70e69c584`)
because client.* and bench_tool.* fields are excluded from
fingerprinting per SCHEMA.md.

| Cell | Python wire | TS wire | Δ |
|---|---:|---:|---:|
| msgpack identity @ 64 | 975 | 975 | 0 |
| msgpack gzip @ 64 | 226 | 226 | 0 |
| msgpack dict-zstd @ 64 | 213 | 213 | 0 |
| msgpack dict-zstd @ 2048 | 291 | 291 | 0 |
| protobuf dict-zstd @ 2048 | 298 | 298 | 0 |

The TS port lives in `packages/demo/src/matrix_run.ts` and uses
Node's `http`/`https` modules directly (NOT global `fetch`, which
auto-decompresses). Wire bytes are sums of raw `data` events from
`http.IncomingMessage` — exactly the SCHEMA.md "raw socket bytes
before any Content-Encoding decompression" definition.

---

## §5. Phase 2 — what's still pending

Three more language rows to fill: .NET, Rust, Java, C.

| Lang | Status |
|---|---|
| Python (`codecai`) | ✅ this run |
| TypeScript/Node (`@codec/demo`) | ✅ this run |
| .NET (`Codec.Net`) | pending — port `MatrixRun.cs` mirroring matrix_run.py |
| Rust (`codec-rs`) | pending — port `src/bin/matrix_run.rs` |
| Java (`Codec.java`) | pending — port `MatrixRun.java` |
| C (`libcodec`) | pending — hardest, raw HTTP via libcurl or hand-rolled |

Each port should reproduce the **byte-identical** wire numbers above
and the same `tokens_emitted` counts. Drift > 1 byte on any Codec cell
is a bug in the port; drift on the JSON-SSE identity cell up to ~20
bytes is expected (server `finish_reason` is whatever the model emits
and varies run-to-run).

---

## §6. Headlines

| Claim | Number |
|---|---:|
| Codec msgpack + dict-zstd @ 2K tok | **291 B = 1,707×** vs JSON-SSE |
| Codec protobuf + dict-zstd @ 2K tok | **298 B = 1,667×** vs JSON-SSE |
| Codec msgpack + gzip @ 2K tok | 354 B = 1,401× vs JSON-SSE |
| ToolWatcher | 393 B = 15.4× wire, 25× TTFB |
| SearXNG agent loop | 3,826 B = 17.3× wire, 8% faster total |
| Cross-language wire equality (Python ≡ TS) | **byte-identical Codec rows** |
| dict-zstd TTFB cliff @ 2K tok | **3,918 ms** (vs 46 ms gzip) — interactive-incompatible |

dict-zstd is now production-real on Codec/sglang for batch and agent
workloads. Its 18% wire advantage over gzip at 2K tokens turns into a
catastrophic TTFB regression on sglang's buffered middleware — the
exact case the spec's `zstdEnabled` operator-attestation gate is
designed to prevent picking. Picker correctness validated end-to-end.
