# codec-bench (Java)

CLI bench for the Codec wire format. Mirror of `packages/demo-web` (TypeScript), `packages/demo-python`, `packages/demo-dotnet`, `packages/demo-c`, `packages/demo-rust`. Runs the same prompt across **3 wire formats × 4 compression encodings** against a Codec-enabled sglang / vLLM / llama.cpp server, prints the wire-byte table.

## Build

Requires JDK 17+ and Maven 3.9+. The codec library must be installed to your local Maven repo first:

```bash
cd packages/java && mvn -B -DskipTests install
cd ../demo-java && mvn -B package
```

## Run

```bash
java -jar packages/demo-java/target/codec-bench.jar \
    --url http://192.168.1.88:30000 \
    --model Qwen/Qwen2.5-0.5B-Instruct \
    --prompt "Explain entropy in one sentence:" \
    --max-tokens 64
```

Output:

```
path                               identity              gzip                br              zstd
-------------------------------------------------------------------------------------------------
JSON-SSE (default)                  15.2 KB           15.2 KB           15.2 KB           15.2 KB
Codec msgpack                         975 B             226 B            1.1 KB             253 B
Codec protobuf                        652 B             224 B             924 B             271 B

per cell: wire_bytes / tokens / B-per-tok / ttfb / total / ratio-vs-json
  ...
  Codec msgpack             gzip          226 B    64 tok     3.5 B/tok     4 ms TTFB   120 ms total   68.8x
  Codec protobuf            gzip          224 B    64 tok     3.5 B/tok     4 ms TTFB   120 ms total   69.5x
```

## Why this exists

Same-shaped numbers across all language clients (TS, Python, .NET, C, Rust, Java) is the polyglot interop proof: the wire contract is language-agnostic, so the bytes-on-wire don't change between clients. Verified against Qwen/Qwen2.5-0.5B-Instruct on `codec-sglang` (token-native binary transport + server-side ToolWatcher) — Java emits the same `975 B` / `652 B` identity-msgpack / identity-protobuf as every other client.

## Notes

- Wire-byte capture: JDK's `java.net.http.HttpClient` does not auto-decompress, so the bytes off the socket are the bytes we count. Decompression is done in-process for token counting (`GZIPInputStream`, `BrotliInputStream`, `ZstdInputStream`).
- The bench uses `ai.codec.StreamDecoder.decodeMsgpackStream` / `decodeProtobufStream` from the `codec` library to count Codec-format tokens; JSON-SSE tokens are line-counted.
