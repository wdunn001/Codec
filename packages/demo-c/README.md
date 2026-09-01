# codec-bench (C)

CLI bench for the Codec wire format. Mirror of `packages/demo-web` (TypeScript), `packages/demo-python`, and `packages/demo-dotnet`. Same prompt across **3 wire formats × 4 compression encodings**, prints the wire-byte table.

## Build

Linux / macOS:

```bash
sudo apt install libcurl4-openssl-dev cmake build-essential   # Debian/Ubuntu
# or: brew install curl cmake                                  # macOS
cmake -S . -B build
cmake --build build
```

Windows (vcpkg):

```bash
vcpkg install curl
cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build build --config Release
```

## Run

```bash
./build/codec-bench --url http://192.168.1.88:30000 \
                    --model Qwen/Qwen2.5-0.5B-Instruct \
                    --prompt "Explain entropy in one sentence:" \
                    --max-tokens 64
```

Output mirrors the other demos: same shape, same numbers within noise. That's the polyglot interop proof.

## Notes

- Wire bytes come from libcurl's `CURLINFO_SIZE_DOWNLOAD_T`. That reports the bytes that crossed the socket. We don't ask libcurl to auto-decompress (`CURLOPT_ACCEPT_ENCODING` left unset). The body buffer is the raw stream as a result: exactly what libcodec wants for binary decode. JSON-SSE bodies are equally readable as plain text.
- `--max-tokens` should match what you use in the other demos so the per-token numbers compare cleanly.
