# Bench result schema (v1)

Every benchmark output across all engines and language clients
conforms to this schema. The methodology block is captured once per
(engine, run-id) pair by `capture_methodology.py` and merged into
each per-language result file by that language's demo runner. The
aggregator validates that all rows in a comparison table share the
same methodology fingerprint (excluding `client.*` and `bench_tool.*`
fields, which are expected to differ across language cells).

Files live at:

```
packages/bench/methodology/{run_id}/{engine}.json     # canonical methodology, captured once per engine
packages/bench/methodology/prompts.json               # canonical per-size prompts, identical for every run
packages/bench/results/{run_id}/{engine}/{lang}.json  # one file per (engine, lang) cell
packages/bench/results/{run_id}/MATRIX.md             # aggregated readable matrix
```

`{run_id}` is an ISO-8601-ish UTC stamp like `2026-05-07T14-30-00Z`.
Multiple runs are kept side-by-side; nothing overwrites.

## Top-level shape

```json
{
  "schema_version": "1",
  "methodology": { ... },
  "rows": [ { "size": 64, ... }, { "size": 512, ... }, ... ]
}
```

## `methodology` block — every field mandatory

```jsonc
{
  "schema_version": "1",
  "captured_at": "2026-05-07T14:30:00Z",         // ISO 8601 UTC
  "run_id": "2026-05-07T14-30-00Z",

  "hardware": {
    "host": "lab-box",
    "cpu_model": "AMD Ryzen 9 5950X 16-Core",
    "gpu_model": "NVIDIA GeForce RTX 3090",
    "gpu_count": 1,
    "gpu_driver": "580.142",
    "ram_gb": 128,
    "kernel": "Linux 6.8.0-79-generic"
  },

  "engine": {
    "name": "sglang",                            // sglang | vllm | llama.cpp
    "version": "<server-reported version>",
    "branch": "feat/codec-binary-transport",
    "commit": "<full git sha>",
    "container_image": "lmsysorg/sglang:nightly-...",  // null if not containerized
    "launch_flags": ["--mem-fraction-static", "0.45", ...],
    "endpoint": "http://192.168.1.88:30000",
    "endpoint_kind": "lan",                      // localhost | lan | wan
    "stream_format_supported": ["json", "msgpack", "protobuf"],
    "compression_supported": ["identity", "gzip", "br", "zstd"]
  },

  "model": {
    "id": "Qwen/Qwen2.5-0.5B-Instruct",
    "quantization": "fp16",                      // fp16 | bf16 | q4_k_m | q8_0 | ...
    "tokenizer_sha256": "<hex>",                 // sha256 of tokenizer.json
    "vocab_size": 151936,
    "model_sha256": null                         // best-effort, may be null on weights too large
  },

  "client": {
    "lang": "python",                            // web | python | dotnet | c | rust | java
    "lib_name": "codecai",
    "lib_version": "0.1.0",
    "lib_commit": "<git sha>",
    "runtime": "CPython 3.13.1 / httpx 0.28.1 / msgpack 1.1.0"
  },

  "bench_tool": {
    "name": "demo-python/codec-bench-timed",
    "version": "0.1.0",
    "commit": "<git sha>",
    "reps": 2,
    "warmup_reps": 0,
    "aggregation": "median",
    "ttft_definition":     "wall-clock from request POST to first body byte (canonical) OR first headers byte (legacy cohort) — runner MUST state which",
    "wire_bytes_definition": "raw socket bytes received before any Content-Encoding decompression",
    "total_ms_definition":   "wall-clock from request POST to last byte (after server emits final frame)"
  },

  "workload": {
    "prompts_file": "methodology/prompts.json",
    "prompts_sha256": "<hex>",                   // sha256 of prompts.json
    "stream": true,
    "temperature": 0.0
  },

  "git": {
    "repo_commit": "<sha of the codec repo at run time>",
    "repo_branch": "docs/measured-results",
    "repo_clean": true,                          // were there uncommitted changes?
    "repo_dirty_files": []                       // if not clean, list which files
  },

  "notes": "free-form text. Anything weird that happened during the run. Empty string if nothing.",

  "fingerprint": "<sha256 of this block excluding client.*, bench_tool.*, captured_at, notes, git.repo_dirty_files>"
}
```

### Fingerprint rule

The aggregator computes `sha256` of the methodology dict with these
fields **excluded** from the input (so cells from different languages
or different bench tools can compare cleanly):

- `client.*` — expected to differ per language
- `bench_tool.*` — expected to differ per language
- `captured_at` — wallclock time
- `notes` — free-text
- `git.repo_dirty_files` — file list (the boolean `repo_clean` IS in the fingerprint)

Two rows with the same fingerprint belong in the same comparison
table. Two rows with different fingerprints get **quarantined** —
shown in their own table with a diff section explaining what
diverged. Quarantine never silently drops data.

## `rows` — one entry per measured cell

```jsonc
{
  "size": 64,                                    // requested max_tokens
  "format": "msgpack",                           // json | msgpack | protobuf
  "encoding": "gzip",                            // identity | gzip | br | zstd
  "wire_bytes": 169,                             // median across reps
  "ttft_ms": 11,                                 // median across reps
  "total_ms": 119,                               // median across reps
  "tokens_emitted": 64,                          // sanity check; should equal size
  "rep_wire_bytes": [169, 170],                  // raw per-rep numbers (for spotting outliers)
  "rep_ttft_ms": [11, 12],
  "rep_total_ms": [119, 120],
  "error": null                                  // string if cell failed; row still kept
}
```

## Normative rules for demo runners

1. **MUST** read methodology from `--methodology <path>`. Never invent
   methodology fields.
2. **MUST** populate exactly the `client` and `bench_tool` blocks with
   their own info; **MUST NOT** modify any other methodology field.
3. **MUST** read the per-size prompt from `methodology.workload.prompts_file`
   (which points to `methodology/prompts.json`). The runner does **not** ship its own prompts.
4. **MUST** measure `wire_bytes` as raw socket bytes received *before*
   any Content-Encoding decompression. `tokens_emitted` is decoded
   afterward for sanity.
5. **MUST** measure `ttft_ms` as wall-clock from request POST to **first
   body byte** — the first byte of the HTTP response payload, after
   the response headers have been received. The bench tool's
   `ttft_definition` field MUST state explicitly which moment was
   captured so reviewers can quarantine cohort-mismatched cells.

   The Phase-2 cross-language run surfaced two clean cohorts:

   - **Body-byte TTFB**: Python (`httpx.aiter_raw` first iteration),
     TypeScript (`http.IncomingMessage` first `data` event),
     C (`libcurl` first `WRITEFUNCTION` invocation). These all measure
     wall-clock to the first payload byte and are the canonical
     reading SCHEMA-v1 mandates.
   - **Headers-byte TTFB**: .NET (`HttpClient.SendAsync` with
     `ResponseHeadersRead`), Rust (`reqwest::Client::send().await`),
     Java (`HttpClient.send` return). These return when response
     headers are available, before any body bytes have arrived. They
     are NOT canonical TTFB under SCHEMA-v1. Their numbers are
     correctly recorded but the aggregator routes them into the
     "headers-byte cohort" column rather than the canonical column.

   On non-buffering encodings (identity, gzip, br) headers and first
   body byte arrive in the same TCP segment in practice, so the
   cohorts agree. They diverge sharply on buffered encodings (current
   sglang dict-zstd middleware buffers small responses to
   end-of-stream; headers-byte readers see ~35 ms while body-byte
   readers see total-response time). The aggregator's §4 splits the
   two cohorts so neither is hidden.

   **Migration path for headers-byte clients**: switch the timer to
   start AFTER the headers-future returns and stop at the first
   non-empty body chunk. Each language has an idiomatic equivalent
   (.NET: read `Response.Content` stream first byte; Rust: poll
   `bytes_stream` first item; Java: `BodyHandlers.ofInputStream` first
   `read`). Until those migrations land, recorded numbers stay in the
   headers-byte cohort.

   For HTTP libraries that buffer initial response chunks: use the
   lowest-level read available — e.g. `aiter_raw` in httpx, raw fetch
   reader in browsers, raw `read()` on a socket in C, `WRITEFUNCTION`
   in libcurl.
6. **MUST** emit the unified JSON to stdout or `--out <path>`; **MUST NOT**
   print free-form text on stdout.
7. **SHOULD** run reps as defined in `methodology.bench_tool.reps`.
8. **SHOULD** preserve raw per-rep numbers in `rep_*` arrays so
   reviewers can spot outliers.

## Aggregator behaviour

When building MATRIX.md from a `results/{run_id}/` tree:

1. Load every `*.json` file.
2. Group rows by `(engine, format, encoding, size)`.
3. Within each group, compare methodology fingerprints across the
   language cells.
4. If all fingerprints match → render in the main table.
5. If any fingerprints differ → render the matching subset in the
   main table, then render the diverging cell(s) in a quarantine
   table with the methodology diff inline.
6. Always emit a "Methodology" section at the top citing the
   canonical methodology block and the fingerprint each table uses.
