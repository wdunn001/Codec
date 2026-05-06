# codec-demo-python

CLI bench for the Codec wire format. Mirror of `packages/demo-web` (and the .NET / C demos): runs the same prompt across **3 wire formats × 4 compression encodings** against a Codec-enabled sglang server, prints the wire-byte table.

## Install

```bash
pip install -e .
```

(or `uv pip install -e .`)

## Run

```bash
codec-bench --url http://192.168.1.88:30000 \
            --model Qwen/Qwen2.5-0.5B-Instruct \
            --prompt "Explain entropy in one sentence:" \
            --max-tokens 64
```

Output:

```
path                            identity              gzip                br              zstd
--------------------------------------------------------------------------------------------------
JSON-SSE (default)               9.8 KB           4.1 KB            3.4 KB            3.0 KB
Codec msgpack                    1.0 KB             …                …                 …
Codec protobuf                   696 B              …                …                 …

per cell: wire_bytes / tokens / B-per-tok / ttfb / total / ratio-vs-json
  ...
```

## Why this exists

Same-shaped numbers across all four language clients (TS, Python, .NET, C) is the polyglot interop proof: the wire contract is language-agnostic, so the bytes-on-wire don't change between clients.

## Notes

Wire-byte capture: `httpx` decompresses by default, so we wrap its transport with a counter that tallies bytes off the socket before decompression. `Content-Length` falls back if the counter sees zero (unusual for streaming).
