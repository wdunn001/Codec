# Bench result schema (v1)

Every benchmark output across all engines and language clients
conforms to this schema. The methodology block is captured once per
(engine, run-id) pair by `capture_methodology.py` and merged into
each per-language result file by that language's demo runner. The
aggregator validates that all rows in a comparison table share the
same methodology fingerprint, excluding `client.*` and `bench_tool.*`
fields. Those are expected to differ across language cells.

Files live at:

```
packages/bench/methodology/{run_id}/{engine}.json         # canonical methodology, captured once per engine
packages/bench/methodology/prompts.json                   # canonical per-size text prompts (text-tokens modality)
packages/bench/methodology/latent-fixtures.json           # canonical per-size latent fixtures (image-/video-latents, v0.3+)
packages/bench/results/{run_id}/{engine}/{lang}.json      # one file per (engine, lang) cell
packages/bench/results/{run_id}/MATRIX.md                 # aggregated readable matrix
packages/bench/golden/<latent_space_id>/<fixture>/        # perceptual ground-truth pixels (latent benches only)
packages/bench/corpora/<latent_space_id>-synth/           # captured wire frames, fed to dict trainers
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

## `methodology` block: every field mandatory

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
    "ttft_definition":     "wall-clock from request POST to first body byte (canonical) OR first headers byte (legacy cohort): runner MUST state which",
    "wire_bytes_definition": "raw socket bytes received before any Content-Encoding decompression",
    "total_ms_definition":   "wall-clock from request POST to last byte (after server emits final frame)"
  },

  "workload": {
    // Text modality (v0.2): runner reads per-size prompt from prompts.json.
    // Latent modality (v0.3+): runner reads per-size fixture from latent-fixtures.json.
    // Exactly one of `prompts_file` / `fixtures_file` MUST be set, matched to
    // `modality.kind` below.
    "prompts_file": "methodology/prompts.json",
    "prompts_sha256": "<hex>",                   // sha256 of prompts.json (text modality only)
    "fixtures_file": null,                       // "methodology/latent-fixtures.json" for latent runs
    "fixtures_sha256": null,                     // sha256 of latent-fixtures.json (latent only)
    "stream": true,
    "temperature": 0.0
  },

  // Modality block (v0.3+, additive).
  // Absent OR { "kind": "text-tokens" } means a v0.2-style text run; the
  // aggregator treats absence as kind="text-tokens" so existing result files
  // continue to validate without rewrite.
  "modality": {
    "kind": "image-latents",                     // text-tokens | image-latents | video-latents

    // ── Latent-only fields (omitted when kind == "text-tokens") ─────────
    "latent_space_id":     "stabilityai/sd-vae-ft-mse",
    "latent_space_sha256": "<hex>",              // sha256 of the resolved LatentSpaceMap JSON
    "shape":  [4, 64, 64],                       // per-frame latent shape, channel-first
    "dtype":  "fp16",                            // fp32 | fp16 | bf16 | int8 | int4
    "pipeline": "int8",                          // raw | int8 | int4 | int8-adaptive | int4-adaptive | delta+int8 | delta+int4

    "decoder": {
      "runtime":        "onnx-web",              // onnx-web | onnx | torch | ggml | wgsl | safetensors-pt
      "weights_sha256": "<hex>",
      "weights_bytes":  335000000
    },

    // The perceptual trust anchor. Every latent bench cell records what its
    // SSIM / PSNR / LPIPS numbers were resolved against. Mismatch with the
    // canonical golden image is a fingerprint divergence and quarantines the
    // cell. See packages/bench/golden-builder/.
    "quality_reference": {
      "runtime":           "torch",
      "torch_version":     "2.5.1",
      "diffusers_version": "0.31.0",
      "container_image":   "ghcr.io/wdunn001/codec-golden:torch-2.5.1-diffusers-0.31.0",
      "container_sha256":  "<hex>"               // pinned by digest, NOT by tag
    }
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

- `client.*`: expected to differ per language
- `bench_tool.*`: expected to differ per language
- `captured_at`: wallclock time
- `notes`: free-text
- `git.repo_dirty_files`: file list (the boolean `repo_clean` IS in the fingerprint)
- `modality.decoder.runtime` (v0.3+, latent only): the whole point of
  the runtime-drift bench is to compare ONNX-Web vs torch vs ggml vs
  WGSL on the **same latent bytes**. The runtime field MUST therefore be
  allowed to vary across cells. The decoder's `weights_sha256` stays
  in the fingerprint. Two cells with different runtimes but the
  same weights still compare cleanly as a result.

Two rows with the same fingerprint belong in the same comparison
table. Two rows with different fingerprints get **quarantined**: shown in their own table with a diff section explaining what
diverged. Quarantine never silently drops data.

## `rows`: one entry per measured cell

Text modality (v0.2: unchanged):

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

Latent modality (v0.3+: additive fields). The `format` and `encoding`
columns keep their text-modality meaning (msgpack/protobuf wire mode +
HTTP Content-Encoding). New fields measure the latent-specific cost +
quality axes. Fields whose values are `null` mean only "not measured this
run":

```jsonc
{
  "size": "512",                                 // fixture key from latent-fixtures.json (string,
                                                 //   not int: covers both "512" and "video-1s")
  "format": "msgpack",
  "encoding": "zstd",
  "wire_bytes": 14336,
  "ttft_ms": null,                               // not meaningful for latents: see ttff_ms below
  "ttff_ms": 23,                                 // time to first frame: wall-clock from POST to
                                                 //   first LatentFrame (after LatentStreamHeader).
                                                 //   Replaces ttft_ms semantically for latents.
  "total_ms": 380,                               // wall-clock to stream done
  "frames_emitted": 1,                           // 1 for image, N for video
  "tokens_emitted": null,                        // text-only field; null for latents
  "rep_wire_bytes": [14336, 14352],
  "rep_ttff_ms": [23, 24],
  "rep_total_ms": [380, 384],

  // Decoder cost (only present when the bench runs vae_decode in this cell:
  // i.e. this client has a decoder loaded). Cells running the wire only
  // (parse-only, no decode) leave these null.
  "decode_cold_ms":     840,                     // first decode latency, includes weight load
  "decode_steady_ms":   38,                      // steady-state per-frame decode latency
  "decode_peak_mem_mb": 612,

  // Perceptual quality: measured against packages/bench/golden/<latent_space_id>/<size>/
  // produced by the golden-builder image. Cells without a decoder loaded
  // (parse-only) leave all four null.
  "ssim":  0.9962,                               // higher = better
  "psnr":  41.7,                                 // dB; higher = better
  "lpips": 0.018,                                // lower = better

  // Video-only quality: null for image-latents
  "vmaf":          null,                         // 0 to 100, higher = better
  "temporal_ssim": null,                         // SSIM between adjacent decoded frames; flags flicker

  "error": null
}
```

A cell that measures the wire only (no decoder loaded) is still a
useful cell: `wire_bytes` and `ttff_ms` capture the protocol-level
cost. Cells with a decoder loaded additionally produce the perceptual
columns; those numbers anchor the rate-distortion plots.

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
   body byte**: the first byte of the HTTP response payload, after
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
   body byte arrive in the same TCP segment in practice. The
   cohorts agree as a result. They diverge sharply on buffered encodings (current
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
   lowest-level read available: e.g. `aiter_raw` in httpx, raw fetch
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
2. Group rows by `(modality.kind, engine, format, encoding, size)`.
   Modality is the outer split: text-tokens cells never appear in the
   same table as latent cells, even when fingerprints would otherwise
   match.
3. Within each group, compare methodology fingerprints across the
   language cells.
4. If all fingerprints match → render in the main table.
5. If any fingerprints differ → render the matching subset in the
   main table, then render the diverging cell(s) in a quarantine
   table with the methodology diff inline.
6. Always emit a "Methodology" section at the top citing the
   canonical methodology block and the fingerprint each table uses.

## Synthetic-stream wire bench (v0.4.1+): protocol-only headline

Added after the v0.4.1 post-mortem caught that the engine-output ratios
were **content-dependent** rather than measuring protocol efficiency in
isolation. Two engines fed the same prompt at temperature=0 generate
different token sequences (floating-point non-associativity in CUDA
reductions + sampler/attention divergence), and those sequences compress
differently: producing wildly different headline ratios for what should
have been a protocol comparison.

The synthetic-stream bench fixes this by **never invoking a model**. It
takes known token-ID sequences from a small set of canonical corpora and
runs them through the Codec encoder + compression libraries locally. No
HTTP, no inference engine, no model.

### What the synthetic bench measures

For each corpus × size × {msgpack, protobuf} × {identity, gzip, br, dict-zstd}:

- **wire_bytes**: bytes produced by `encode_stream() + compress_*()`
- **bytes_per_token**: `wire_bytes / n_tokens`

Stored at `results/{run_id}/synthetic/wire.json` with `kind:
"synthetic_wire_bench"`.

### Canonical corpora

| Corpus name                       | Distribution                            | Purpose                              |
|-----------------------------------|------------------------------------------|--------------------------------------|
| `uniform-random-vocab-152064`     | Uniform random in `[0, 152064)`         | Worst case: no content redundancy   |
| `low-entropy-50-unique`           | Uniform from 50 sampled IDs             | Typical mixed-vocab model output     |
| `comma-dominated-50pct`           | One ID 50% of the time, rest random     | Models the "comma/glue token dominates" pattern |
| `cyclic-period-10`                | `[0, 1, ..., 9, 0, 1, ...]`             | Best case: pure structural repetition |

These four cover the realistic compressibility spectrum from "incompressible
random" through "structurally degenerate." Live model output sits somewhere
on this spectrum depending on prompt + model.

### Headline rule

`aggregate.py` §1 renders the synthetic-stream table as the headline
(protocol-only). §1b renders the engine-output cells with a clear
disclaimer that those ratios depend on what each engine's model produces.

The synthetic bench is **mandatory** for any release whose §1 numbers
appear in marketing material: see `docs/RELEASE_CHECKLIST.md` §3.

### Implementation

`packages/bench/scripts/synthetic_wire_bench.py`: pure Python, no
network calls. Uses the same library versions every engine fork uses
(msgpack, brotli, zstandard with the shipped dict files at
`dictionaries/`). Encoder versions are recorded in the output JSON for
reproducibility.

### Latent-specific aggregator outputs (v0.3+)

For runs whose `modality.kind` is `image-latents` or `video-latents`,
the aggregator also emits two plot scripts beyond the text-side
TTFT/total/crossover charts:

- `rate-distortion-{latent_space_id}.png`: wire bytes vs SSIM as the
  pipeline sweeps `raw → int8 → int4 → delta+int8 → delta+int4`. The
  canonical curve every classical video codec publishes; latents
  inherit the visualisation.
- `runtime-drift-{latent_space_id}.png`: pairwise SSIM heatmap across
  decoder runtimes (torch / ONNX-Web / ggml / WGSL) on identical
  latent bytes. Quantifies how far the perceptual contract bends
  across implementations.

Both scripts read the same `results/{run_id}/` tree the matrix builder
does. Cells without `ssim` (parse-only) are excluded from the curves
but still contribute to the wire-cost columns of the main table.

## Negotiation headers (v0.3+)

The response headers below are part of the wire contract and SHOULD be
recorded on every measured cell. They identify the content-addressed
artifacts that produced the response bytes. A bench cell whose recorded
header value doesn't match the artifact the client loaded fails closed
(KV-cache divergence on text, decoder-output divergence on latents): the aggregator quarantines those cells regardless of fingerprint match.

| Header                  | Modality                | Body                                         | Validation                                                                                                                                       |
|-------------------------|-------------------------|----------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| `Codec-Tokenizer-Map`   | text-tokens             | `sha256:<hex>` of the active tokenizer map   | Must equal the sha256 of the map the client loaded via `loadMap` (after the `sha256:` prefix). Mismatch → quarantine.                            |
| `Codec-Latent-Map`      | image-latents / video-latents | `sha256:<hex>` of the active latent-space map | Must equal the sha256 of the latent-space map the client loaded. Mismatch → quarantine.                                                          |
| `Codec-Zstd-Dict`       | any modality (when `Content-Encoding: zstd`) | `sha256:<hex>` of the active dict body | Must equal a dict the client has loaded matching this `(format, pipeline)` pair (latent) or `(format)` (text). Mismatch → wire-format error.     |

### Where they show up in the result row

Every cell row gets three optional string fields next to `wire_bytes`:

```jsonc
{
  "size": "512",
  "format": "msgpack",
  "encoding": "zstd",
  "wire_bytes": 14336,
  // … existing fields …
  "codec_tokenizer_map": null,                   // set on text cells; null on latent cells
  "codec_latent_map":   "sha256:8b3f…",          // set on latent cells; null on text cells
  "codec_zstd_dict":    "sha256:ecc9…"           // set when Content-Encoding == "zstd"
}
```

The aggregator's quarantine pass adds a fourth case beyond fingerprint
divergence: header-value divergence within an otherwise-matching fingerprint.
Cells where `codec_tokenizer_map` (text) or `codec_latent_map` (latent)
varies across language clients are quarantined with a "header divergence"
diff: typically the result of a stale cache on one client, occasionally a
genuine spec violation by the engine.

## MCP-live methodology (v0.3+)

`src/mcp-live.ts` measures the gateway+downstream-MCP wire cost in
isolation (no inference engine in the loop). The variants below are
exercised per JSON-RPC method group; they are NORMATIVE for
the MCP-live cell shape and MUST be reproduced verbatim by any
alternative-language port (none exist yet).

| Variant                  | reqMsgpack | respMsgpack | Accept-Encoding | X-Codec-Map | What it measures                                              |
|--------------------------|:----------:|:-----------:|:----------------:|:-----------:|---------------------------------------------------------------|
| `json`                   |     ✗      |      ✗      |      n/a           |      ✗      | SDK default (the JSON-RPC baseline every other variant beats) |
| `msgpack-resp`           |     ✗      |      ✓      |      n/a           |      ✗      | Cheapest opt-in: response only, request stays JSON            |
| `msgpack-both`           |     ✓      |      ✓      |      n/a           |      ✗      | Symmetric Codec; the default Codec-aware client shape          |
| `msgpack-both+gzip`      |     ✓      |      ✓      |      gzip        |      ✗      | Production-shape lane (compression on top of msgpack)         |
| `msgpack-both+gzip+map`  |     ✓      |      ✓      |      gzip        |      ✓      | Deep-compression lane: tool-call text → ID arrays via the     |
|                          |            |             |                  |             | leaf-mode bypass (gateway sees `_codec_meta` and forwards as is). |

### Method groups

Each variant is exercised against the three JSON-RPC methods every MCP
session uses:

- `initialize`: handshake; minimal payload
- `tools/list`: registry enumeration; medium-large response when many
  tools are mounted
- `tools/call`: actual tool invocation; small request, response
  varies by tool (file-read tools dominate the wire)

Per-(variant, method) cells produce four numbers:

```jsonc
{
  "method":  "tools/list",
  "variant": "msgpack-both+gzip+map",
  "reqBytes":      612,
  "respWireBytes": 5824,                  // raw socket bytes received
  "ttfbMs":        57,
  "totalMs":       195,
  // Cells where variant uses "+map" record the leaf-mode bypass count
  // (incremented on each downstream MCP server that returned _codec_meta).
  "leafBypasses":  3,                     // number of pre-tokenized result blocks the gateway forwarded
  "mapHash":       "sha256:0549cbec…"     // matches Codec-Tokenizer-Map response header
}
```

### Variant-5 (leaf-mode) preconditions

Variant 5 (`msgpack-both+gzip+map`) is meaningful only when at least one
downstream MCP server in the active namespace is Codec-aware. The
canonical workload is `wdunn001/codec-time-leaf:vX.Y.Z` (the reference
Codec-aware MCP server: `get_current_time` + `convert_time` tools
wrapped via `@codecai/mcp-leaf`'s `wrapToolCall`). Without it, the
gateway logs `[Codec][shim]` warnings on every result and variant 5's
numbers regress to variant-4-equivalent (the gateway tokenizes on the
seam rather than forwarding pre-tokenized IDs).

### Result file layout

MCP-live results land under `results/{run_id}/mcp/`:

```
results/{run_id}/mcp/
  mcp-live.json          # all (method × variant) cells + the methodology fingerprint
  mcp-live.md            # human-readable matrix table
  SUMMARY.md             # narrative summary (headline numbers + interpretation)
```

The `methodology` block on these runs has `modality.kind = "mcp-rpc"`
(a sentinel; not an enum value on the v0.3 schema's text/latent split)
and an additional `gateway` block under the engine slot:

```jsonc
{
  "engine": {
    "name": "metamcp",
    "version": "v0.2.8+",
    "branch": "feat/codec-binary-transport",
    "commit": "<full git sha of wdunn001/metamcp at run time>",
    "container_image": "wdunn001/codec-metamcp:vX.Y.Z@sha256:…",
    "endpoint": "http://lab.local:12008/metamcp/<namespace-uuid>/mcp",
    "gateway": {
      "namespace_uuid":      "<uuid>",
      "downstream_servers":  ["mcp-server-time", "codec-time-leaf"],
      "zstd_dict_loaded":    "sha256:ecc9410a…",
      "zstd_dict_size_bytes": 16384
    }
  }
}
```

`engine.name = "metamcp"` is the only MCP-live engine name today; new
gateways add additional values to the closed list as additive
point-release schema changes.

### Aggregator behaviour for MCP-live runs

Beyond the standard fingerprint-grouped matrix, the aggregator emits a
`MCP-WIRE.md` showing each variant's wire-bytes ratio against the `json`
baseline per-method. This is the table the launch What's New entry
quotes: variant 5 / variant 1 ratio is the headline number.
