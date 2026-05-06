# libcodec

**C99 implementation of the [Codec](https://github.com/wdunn001/Codec) binary transport protocol.**

Decodes streaming token IDs from Codec-compliant servers (vLLM, SGLang, llama.cpp) and provides the wire-format primitives for embedding Codec into any C/C++/Rust/Go/Swift project. Pure C99, no external runtime dependencies — vendored SHA-256 (public domain) and jsmn JSON tokenizer (MIT) live alongside the source.

The C twin of [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) (browser/Node), [`Codec.Net`](https://www.nuget.org/packages/Codec.Net) (.NET), and [`codecai`](https://pypi.org/project/codecai/) (Python). Same tokenizer dialect maps work everywhere.

## Why this exists

Real measurements from [`Codec/packages/bench`](https://github.com/wdunn001/Codec/tree/main/packages/bench) (live Ollama qwen2.5):

| Configuration                              | B/token | vs JSON-SSE |
|--------------------------------------------|--------:|------------:|
| JSON-SSE (live Ollama)                     |   186.4 |        1.0× |
| Codec msgpack                              |    16.0 |    **9.6×** |
| Codec protobuf                             |    10.9 |   **14.2×** |
| Codec msgpack + `Content-Encoding: br`     |    2.79 |   **55.2×** |

End-to-end agent-to-agent handoff: **3.6× faster** at 1024 tokens, because both the wire shrinks and the detokenize → JSON → re-tokenize round-trip is eliminated.

For C/C++ servers (llama.cpp, custom inference engines), libcodec is what you link in to ship Codec frames. For C/C++ clients (mobile apps, embedded inference, native UIs), it's what you link in to decode them.

## Install

### CMake `FetchContent` (recommended for embedding)

```cmake
include(FetchContent)
FetchContent_Declare(codec
    GIT_REPOSITORY https://github.com/wdunn001/Codec.git
    GIT_TAG        main                  # or v0.1.0 once tagged
    SOURCE_SUBDIR  packages/c)
FetchContent_MakeAvailable(codec)

target_link_libraries(myapp PRIVATE codec::codec)
```

`FetchContent_Declare` understands `SOURCE_SUBDIR` so you don't pull in the whole multi-language repo for a sub-directory build.

### vcpkg

```bash
vcpkg install codec
```

```cmake
find_package(codec CONFIG REQUIRED)
target_link_libraries(myapp PRIVATE codec::codec)
```

The vcpkg port is provided in `packages/c/vcpkg/ports/codec` and is suitable for upstream PR to [microsoft/vcpkg](https://github.com/microsoft/vcpkg).

### System install via CMake

```bash
cmake -S packages/c -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
sudo cmake --install build
```

Provides `codec-config.cmake`, `codec.pc` (pkg-config), and the headers in `include/codec/codec.h`.

### Build options

| CMake option                      | Default | Purpose                                                   |
|-----------------------------------|---------|-----------------------------------------------------------|
| `CODEC_BUILD_SHARED`              | ON      | Build the shared library (`libcodec.so`/`codec.dll`).      |
| `CODEC_BUILD_STATIC`              | ON      | Build the static library.                                  |
| `CODEC_BUILD_TESTS`               | ON*     | Build the CTest unit suite. *Default ON only at top level. |
| `CODEC_BUILD_EXAMPLES`            | ON*     | Build `stream_decode` + `bench_decode`.                    |
| `CODEC_INSTALL`                   | ON*     | Generate install rules + cmake / pkg-config exports.       |

## Quick start

```c
#include <codec/codec.h>
#include <stdio.h>

int main(void) {
    /* 1. Load a tokenizer dialect map (caller provides JSON bytes). */
    codec_tokenizer_map_t *map = NULL;
    codec_status_t st = codec_map_from_json(json, json_len, &map);
    if (st != CODEC_OK) { fprintf(stderr, "%s\n", codec_status_str(st)); return 1; }

    /* 2. Optionally pin against a sha256. */
    codec_map_verify_sha256(json, json_len, "sha256:c73972f7a580…");

    /* 3. Build a stateful detokenizer. */
    codec_detokenizer_t *detok = NULL;
    codec_detokenizer_new(map, &detok);

    /* 4. Feed an HTTP body (msgpack stream) and pop frames. */
    codec_msgpack_stream_t *stream = NULL;
    codec_msgpack_stream_new(&stream);
    codec_msgpack_stream_feed(stream, http_chunk, http_chunk_len);

    codec_frame_t frame;
    while (codec_msgpack_stream_next(stream, &frame) == CODEC_OK) {
        char *text = NULL; size_t text_len = 0;
        codec_detokenize_opts_t opts = { /*partial=*/!frame.done, /*render_special=*/false };
        codec_detokenizer_render(detok, frame.ids, frame.ids_len, opts, &text, &text_len);
        if (text) { fwrite(text, 1, text_len, stdout); free(text); }
        bool done = frame.done;
        codec_frame_destroy(&frame);
        if (done) break;
    }

    codec_msgpack_stream_free(stream);
    codec_detokenizer_free(detok);
    codec_map_free(map);
    return 0;
}
```

See [`examples/stream_decode.c`](examples/stream_decode.c) for the working end-to-end example (loads a real codec-maps file, encodes a synthetic stream, decodes it back).

## Detect tool calls without decoding

Most current chat-tuned models delimit tool calls with **special tokens** —
single token IDs that mark the start and end of a structured region:

| Model           | Markers (start / end)                        |
|-----------------|----------------------------------------------|
| Llama 3.1+      | `<\|python_tag\|>` / `<\|eom_id\|>`          |
| Qwen 2.5+       | `<tool_call>` / `</tool_call>`               |
| Phi-4           | `<\|tool\|>` / `<\|/tool\|>`                 |
| Mistral-Nemo    | `[TOOL_CALLS]` / `[/TOOL_CALLS]`             |
| DeepSeek-V3     | `<｜tool▁calls▁begin｜>` / `<｜tool▁calls▁end｜>` |

Detecting *that* a tool call happened is therefore a uint32 compare in the
hot loop — no detokenization, no string allocation. `codec_tool_watcher`
maintains the state machine for you and emits two kinds of events: the
captured region's IDs (when start..end completes) and passthrough runs
(everything outside any region). An orchestrator can forward passthrough
IDs straight to the next agent and only decode the body of a tool call
when it actually needs the JSON arguments:

```c
#include <codec/codec.h>

codec_tool_watcher_t *watcher = NULL;
codec_tool_watcher_new(map, "<tool_call>", "</tool_call>", &watcher);

/* Inside your stream loop, per frame: */
codec_watcher_event_t *events; size_t n_events;
codec_tool_watcher_feed(watcher, frame.ids, frame.ids_len, &events, &n_events);

for (size_t i = 0; i < n_events; i++) {
    if (events[i].kind == CODEC_WATCH_PASSTHROUGH) {
        /* Forward as-is to the next agent. No decode cost. */
        forward_codec_frame(next_agent, events[i].ids, events[i].ids_len);
    } else /* CODEC_WATCH_REGION_END */ {
        /* This is the body of a tool call. Decode only if you need
         * the JSON arguments — otherwise just route by tool-call presence. */
        char *json = NULL; size_t json_len = 0;
        codec_detokenize_opts_t o = { /*partial=*/false, /*render_special=*/false };
        codec_detokenizer_render(detok, events[i].ids, events[i].ids_len, o, &json, &json_len);
        dispatch_tool(json);
        free(json);
    }
}
```

The watcher is stateful across feeds — partial tool calls split between
network frames are buffered until the end marker arrives. `inside()`
reports whether a region is currently in flight.

If your model uses *plain text* markers instead of special tokens (older
Mistral, GPT-2-era models), name lookup returns `CODEC_ERR_NOT_FOUND`
and you'll need to detect the marker after detokenization. The map's
`special_tokens` field is the source of truth — if `<tool_call>` is in
there, you can scan for it in binary.

## API surface (full list)

| Symbol                                | Purpose                                                              |
|---------------------------------------|----------------------------------------------------------------------|
| `codec_version()`                     | Returns the library version string.                                  |
| `codec_status_str(s)`                 | Human-readable status name.                                          |
| `codec_buffer_free(buf)`              | Free the bytes in a `codec_buffer_t`.                                |
| `codec_map_from_json(...)`            | Parse + validate a TokenizerMap from JSON bytes.                     |
| `codec_map_free(map)`                 |                                                                      |
| `codec_map_verify_sha256(...)`        | Pin map bytes against an expected hash (constant-time compare).      |
| `codec_map_id` / `_version` / `_vocab_size` / `_encoder` | Read-only accessors.                              |
| `codec_map_special_id(map, name, ...)` | Resolve a special-token name (e.g. `"<tool_call>"`) to its uint32 ID. |
| `codec_tool_watcher_new` / `_free` / `_feed` / `_reset` / `_inside` | Detect delimited regions (tool calls, reasoning blocks, etc.) without decoding. |
| `codec_frame_init` / `_destroy`       | Init/free a `codec_frame_t`.                                         |
| `codec_encode_msgpack` / `_protobuf`  | Encode a frame to a fresh buffer.                                    |
| `codec_decode_msgpack(...)`           | Decode a single complete msgpack frame; reports bytes consumed.      |
| `codec_decode_protobuf_frame(...)`    | Decode a single protobuf frame payload (no length prefix).           |
| `codec_detokenizer_new` / `_free`     | Build/free a stateful detokenizer.                                   |
| `codec_detokenizer_render(...)`       | IDs → UTF-8 text. Stateful across calls when `partial=true`.         |
| `codec_detokenizer_reset(...)`        | Drop pending partial UTF-8 bytes (call between conversations).       |
| `codec_msgpack_stream_*`              | Incremental decoder for msgpack-framed streams.                      |
| `codec_protobuf_stream_*`             | Incremental decoder for length-prefixed protobuf streams.            |

Header is `<codec/codec.h>`. Full Doxygen-style comments documenting every function are in the header.

## Correctness

- **Test suite (CTest, 4 binaries, 22 cases) passes 100%** — frame round-trip both formats, detokenizer with byte_level + metaspace + byte fallback + partial UTF-8 buffering, map parsing + sha256 verification, msgpack stream split-frame reassembly, protobuf chunk-boundary handling.
- **Real Qwen-2 round-trip**: when run with `CODEC_MAPS_QWEN=/path/to/qwen2.json`, decodes the actual 152K-vocab Qwen-2 map and round-trips known token IDs back to text bit-identically.
- **Algorithmic parity** with the polyglot ports: same byte_level / metaspace decode logic, same UTF-8 buffer rules, same hex-decoded sha256 verification — verified by feeding the same fixtures into all four implementations and asserting equal output.

Sample bench (Windows MSVC release build, 100K single-token msgpack frames decoded + detokenized through the real Qwen-2 152K-vocab map):

```
stream: 1,498,841 bytes (14.99 B/token)
decoded 100,000 frames in 6,740 ms
  67,403 ns/frame (decode + detokenize combined, single-threaded, malloc-per-frame)
```

The bench keeps memory allocation deliberately naive (a fresh `codec_frame_t` and rendered string per chunk) to mirror the typical client pattern. Production callers can hold buffers across chunks for higher throughput.

## What's not in v0.1

- **`BPETokenizer` (text → IDs)** — deferred to v0.2. The bidirectional Codec endpoint (sending token-ID prompts) requires client-side BPE, which in C means either (a) a Unicode regex dependency for byte_level (PCRE2), or (b) a hand-rolled regex specialised for the GPT-2-family pre-tokenizer. Both are valid choices but neither is small. The other language ports ship pure-language BPE; libcodec callers who need it today can shell out to a BPE encoder or use the matching Python/JS/.NET client over IPC.
- **HTTP client** — `codec_map_from_json` takes bytes you've already fetched. Use libcurl, libsoup, libfetch, etc. to do the GET. This stays opinion-free about networking.
- **Pre-trained ZSTD dictionaries** (Codec spec §"Future") — the dictionary distribution mechanism is still being designed at the spec level.

## Map sources

`codec_map_from_json` accepts any JSON conforming to the v2 schema. For curated pre-generated maps:

```
https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/<family>.json
```

14 model families covering 70+ aliases — see [`codec-maps`](https://github.com/wdunn001/codec-maps) for the index. Pin by sha256 from the index.

## Layout

```
packages/c/
├── include/codec/codec.h      Public C99 API
├── src/
│   ├── codec_util.c           GPT-2 byte table, hex/UTF-8 helpers
│   ├── codec_frame.c          msgpack + protobuf encode/decode
│   ├── detokenize.c           IDs → text (byte_level + metaspace + byte fallback)
│   ├── map.c                  JSON parsing + sha256 verify (uses jsmn)
│   ├── stream.c               Incremental stream decoders
│   ├── sha256.c / .h          Vendored SHA-256 (public domain)
│   ├── jsmn.h                 Vendored JSON tokenizer (MIT)
│   └── codec_internal.h       Internal-only types
├── test/                      4 CTest executables (frame / detokenize / map / stream)
├── examples/                  stream_decode + bench_decode
├── cmake/                     codec-config.cmake.in + codec.pc.in
└── vcpkg/ports/codec/         Ready-to-PR vcpkg port files
```

## Compatibility

| OS               | Compiler      | Status |
|------------------|---------------|--------|
| Windows 10/11    | MSVC 2022     | ✅ tested |
| Linux            | GCC 9+, Clang 9+ | Should work — pure C99, stdlib-only |
| macOS            | Apple Clang   | Should work — pure C99, stdlib-only |

C99 is the minimum standard. There are no platform-specific intrinsics or syscalls.

## License

MIT — see [LICENSE](https://github.com/wdunn001/Codec/blob/main/LICENSE) at the repo root. Vendored deps:
- `src/sha256.c` — Brad Conte's public domain implementation.
- `src/jsmn.h` — Serge Zaitsev, MIT license.

## Related

- **Codec spec** — [github.com/wdunn001/Codec/spec/PROTOCOL.md](https://github.com/wdunn001/Codec/blob/main/spec/PROTOCOL.md)
- **Tokenizer dialect registry** — [github.com/wdunn001/codec-maps](https://github.com/wdunn001/codec-maps)
- **Sister-language clients** — [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) (TS/JS), [`Codec.Net`](https://www.nuget.org/packages/Codec.Net) (.NET), [`codecai`](https://pypi.org/project/codecai/) (Python).
- **Server PRs** — [vLLM #41765](https://github.com/vllm-project/vllm/pull/41765), [SGLang #24483](https://github.com/sgl-project/sglang/pull/24483), llama.cpp (in flight).
