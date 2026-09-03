# libcodec

**C99 implementation of the [Codec](https://github.com/wdunn001/Codec) binary transport protocol.**

Decodes streaming token IDs from Codec-compliant servers (vLLM, SGLang, llama.cpp) and provides the wire-format primitives for embedding Codec into any C/C++/Rust/Go/Swift project. Pure C99, no external runtime dependencies: vendored SHA-256 (public domain) and jsmn JSON tokenizer (MIT) live alongside the source.

The C twin of [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) (browser/Node), [`Codec.Net`](https://www.nuget.org/packages/Codec.Net) (.NET), and [`codecai`](https://pypi.org/project/codecai/) (Python). Same tokenizer dialect maps work everywhere.

## Why this exists

Real measurements from [`Codec/packages/bench`](https://github.com/wdunn001/Codec/tree/main/packages/bench) (live Ollama qwen2.5):

| Configuration                              | B/token | vs JSON-SSE |
|--------------------------------------------|--------:|------------:|
| JSON-SSE (live Ollama)                     |   186.4 |        1.0× |
| Codec msgpack                              |    16.0 |    **9.6×** |
| Codec protobuf                             |    10.9 |   **14.2×** |
| Codec msgpack + `Content-Encoding: br`     |    2.79 |   **55.2×** |

End-to-end agent-to-agent handoff: **3.6× faster** at 1024 tokens. Both the wire shrinks and the detokenize → JSON → re-tokenize round-trip is eliminated.

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

**Which library `codec::codec` gives you.** `codec::codec` is an alias for the shared target whenever the shared target was built. It falls back to the static target only when the shared target was not built. `find_package(codec CONFIG)` runs before any FetchContent fallback in a downstream consumer's default `AUTO` mode. `vcpkg install codec` builds shared-only on a dynamic-linkage triplet. Vcpkg's default triplet on Windows uses dynamic linkage. A consumer following this exact vcpkg route gets `codec::codec` resolved straight to the shared library. That resolution carries no automatic preference for the static target. The shared library exports its full public API through the `CODEC_API` macro defined in `codec.h`. That macro covers `codec.h`, `codec_safety_policy.h`, `codec_version_signaling.h`, and `codec_compression.h`. A checkout without that macro produces a shared library with an empty dynamic symbol table. On that checkout, this vcpkg route hits undefined-reference errors at link time the instant a consumer calls any `codec_*` function. The static path works fine on that same checkout. If you see undefined references against `libcodec.so` or `codec.dll`, confirm your checkout defines `CODEC_API` in `include/codec/codec.h`. Confirm it also applies that macro to every public declaration in the four headers above.

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

## Forwarding IDs to another model (agent-to-agent, same vocab)

When the next consumer of this stream is another model on the same vocab: agent → agent, orchestrator → planner, model → tool that re-feeds the model: you do NOT need a `codec_detokenizer_t` at all. Forward `frame.ids` directly:

```c
/* No detokenizer constructed: zero UTF-8 reassembly, zero BPE-merge work. */
codec_msgpack_stream_t *stream = NULL;
codec_msgpack_stream_new(&stream);
codec_msgpack_stream_feed(stream, http_chunk, http_chunk_len);

codec_frame_t frame;
while (codec_msgpack_stream_next(stream, &frame) == CODEC_OK) {
    forward_codec_frame(next_agent, frame.ids, frame.ids_len, frame.done);
    bool done = frame.done;
    codec_frame_destroy(&frame);
    if (done) break;
}
codec_msgpack_stream_free(stream);
```

This is the **hot-loop fast path** for agent mesh code. Skipping `codec_detokenizer_render(...)` saves significant CPU on heavy reply streams (no string allocation, no partial-UTF-8 buffering, no metaspace decode). And on `libcodec` builds with `CODEC_WITH_BPE_ENCODER=OFF` the agent-to-agent path is the **only** path that works: `codec_bpe_encoder_new` / `codec_translator_new` return `CODEC_ERR_NOT_BUILT` in that configuration, but the decode/forward loop above does not depend on either.

## Detect tool calls without decoding

Most current chat-tuned models delimit tool calls with **special tokens**: single token IDs that mark the start and end of a structured region:

| Model           | Markers (start / end)                        |
|-----------------|----------------------------------------------|
| Llama 3.1+      | `<\|python_tag\|>` / `<\|eom_id\|>`          |
| Qwen 2.5+       | `<tool_call>` / `</tool_call>`               |
| Phi-4           | `<\|tool\|>` / `<\|/tool\|>`                 |
| Mistral-Nemo    | `[TOOL_CALLS]` / `[/TOOL_CALLS]`             |
| DeepSeek-V3     | `<｜tool▁calls▁begin｜>` / `<｜tool▁calls▁end｜>` |

Detecting *that* a tool call happened is therefore a uint32 compare in the
hot loop: no detokenization, no string allocation. `codec_tool_watcher`
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
         * the JSON arguments: otherwise just route by tool-call presence. */
        char *json = NULL; size_t json_len = 0;
        codec_detokenize_opts_t o = { /*partial=*/false, /*render_special=*/false };
        codec_detokenizer_render(detok, events[i].ids, events[i].ids_len, o, &json, &json_len);
        dispatch_tool(json);
        free(json);
    }
}
```

The watcher is stateful across feeds: partial tool calls split between
network frames are buffered until the end marker arrives. `inside()`
reports whether a region is currently in flight.

If your model uses *plain text* markers in place of special tokens (older
Mistral, GPT-2-era models), name lookup returns `CODEC_ERR_NOT_FOUND`
and you'll need to detect the marker after detokenization. The map's
`special_tokens` field is the source of truth: if `<tool_call>` is in
there, you can scan for it in binary.

### What the watcher does and doesn't touch

The watcher's contract is "uint32 in, uint32 out": it never invokes
the detokenizer, never allocates a string, never looks at the vocab.
The only fields of the map it reads are the two `special_tokens`
entries you name in `_new`.

Concretely:

| Behavior                                                | Watcher    |
|---------------------------------------------------------|------------|
| Reads `map.vocab`                                       | No         |
| Reads `map.merges` / encoder config                     | No         |
| Calls `codec_detokenize*`                               | No         |
| Allocates strings                                       | No         |
| Allocates buffers                                       | Only the captured region body, reused across feeds |
| Modifies the input `ids` array                          | No         |
| Returned `PASSTHROUGH` ids pointer                      | Aliases the caller's input buffer (zero-copy) |
| Returned `REGION_END` ids pointer                       | Owned by the watcher; valid until next `feed()` or `free()` |

This is enforced by `test_watcher_does_not_decode_tokens` in
[`test/test_tool_watcher.c`](test/test_tool_watcher.c). That test feeds the
watcher a map whose `vocab` is empty and `vocab_size` is `4`,
using token IDs at `0xFFFFFF00`, `0xDEADBEEF`, `0xCAFEBABE`, etc. Any
implementation that decoded: or even narrowed through a string
round-trip: would fail the bit-for-bit equality checks on the emitted
event IDs and the pointer-aliasing checks on `PASSTHROUGH` events.

### Failure modes

| # | Scenario | What the watcher does | What the caller must do |
|---|----------|-----------------------|-------------------------|
| 1 | Malformed JSON inside the markers | Emits `REGION_END` with the buffered IDs as if everything's fine: the watcher doesn't know about JSON | Decode the IDs, attempt `JSON.parse`, return error to the model |
| 2 | Tool name doesn't exist in your registry | Same: watcher's job ends at the bytes | Caller looks up the name and returns "function not found" to the model |
| 3 | Tool execution fails | Watcher already done | Caller's normal error handling |
| 4 | Stray end marker (no preceding start) | Passes through as a regular ID: orchestrator forwards it as-is. Tested. | Probably nothing: most clients won't notice. If you want to detect server bugs, log when an end-marker ID appears outside an active region. |
| 5 | Nested start (`<tool_call>…<tool_call>…`) | Inner `<tool_call>` ignored; everything until first `</tool_call>` is the body. Subsequent `</tool_call>` becomes a stray end (case 4). | If your model genuinely emits nested calls, you'd want a stack-based watcher. Most don't. |
| 6 | Start marker but `done=true` arrives before end marker: truncated mid-region | Currently silently buffers, then frees the buffer when the watcher is freed. **This is the bad one.** | Today: nothing helpful. The bytes are gone. A `_finish()` API surfacing them as `CODEC_WATCH_TRUNCATED` is on the v0.2.1 roadmap. |
| 7 | Multiple regions back-to-back | Each gets its own `REGION_END` event, in order | Process them sequentially |

### Performance

The watcher's hot loop is a single `uint32` compare against two cached
IDs plus an occasional `memcpy` into the region buffer. Detokenize, in
contrast, does a vocab lookup and UTF-8 string construction per token.
The gap is large.

Measured on the included `bench_watcher` example (Windows 11, MSVC
Release, single core, synthetic byte-level map, 1M tokens, 5% inside
regions, 1024-token chunks):

| Path                               | ns/token | Mtok/s | 1M tokens |
|------------------------------------|---------:|-------:|----------:|
| `codec_tool_watcher_feed`          |     0.61 |   1648 |   0.61 ms |
| `codec_detokenizer_render` (same stream) |    60.4 |     16 |  60.4 ms |
| **Speedup**                        |          |        | **~100×** |

For an orchestrator routing tokens between two agents at 1M tokens/sec,
the watcher's detection cost is sub-millisecond per second of stream.
That's small enough to enable tool-call detection on every frame
without a measurable hit to throughput.

To reproduce:

```bash
cmake --build build --config Release --target bench_watcher
./build/examples/Release/bench_watcher [num_tokens] [region_density] [chunk]
```

The bench is self-contained (synthetic map embedded in the binary):
it runs without any external map file.

### Acting on a detected tool call

The watcher tells you *that* a tool call happened and hands you the
body IDs. Turning that into an actual function invocation is three
steps. None of them require Codec primitives: the whole point of the
watcher is to give you the body once, in one place. You can plug
it into whatever dispatch infrastructure you already have.

```c
/* 1. Decode the body into JSON.
 *    Tool-call bodies in Llama-3 / Qwen-2.5 / Phi-4 / etc. are emitted
 *    as JSON like: {"name":"get_weather","arguments":{"city":"Tokyo"}}
 *    A separate detokenizer (constructed once, reused across calls)
 *    renders the IDs back to UTF-8. */
codec_detokenize_opts_t o = { /*partial=*/false, /*render_special=*/false };
char  *json     = NULL;
size_t json_len = 0;
codec_detokenizer_render(detok, ev.ids, ev.ids_len, o, &json, &json_len);

/* 2. Parse + dispatch. libcodec already vendors jsmn (used internally
 *    for map parsing): you can reuse it, or pull in cJSON / yyjson /
 *    whatever your project standardizes on. The sketch below uses a
 *    fictional helpers tool_call_parse() / tool_registry_invoke() that
 *    wrap whatever JSON library + function table you have. */
tool_call_t call = {0};
if (!tool_call_parse(json, json_len, &call)) {
    /* Failure mode #1: malformed JSON. Send "invalid_arguments" back
     * to the model and let it retry. */
    send_tool_error(orch, "invalid_arguments", json);
    free(json);
    return;
}

const tool_t *t = tool_registry_lookup(reg, call.name);
if (!t) {
    /* Failure mode #2: function not found. Same idea: model gets the
     * error and (usually) recovers. */
    send_tool_error(orch, "unknown_function", call.name);
} else {
    char *result = NULL;
    int rc = t->invoke(t->ctx, call.arguments_json, &result);
    if (rc != 0) {
        /* Failure mode #3: tool execution failed. */
        send_tool_error(orch, "execution_failed", result);
    } else {
        /* 3. Feed the result back to the model as a "tool" role
         *    message. The exact format is model-specific: Llama-3 and
         *    Qwen-2.5 use slightly different wrapper templates: but
         *    it's always a small JSON snippet you append to the next
         *    prompt and re-tokenize on the way in. */
        orch_append_tool_result(orch, call.name, result);
        free(result);
    }
}
free(json);
tool_call_free(&call);
```

A few things worth knowing while wiring this up:

- **The detokenizer is not the watcher's dependency, it's yours.** You
  only need `codec_detokenizer_t` if you actually intend to *execute*
  the call. An orchestrator that just routes tool calls between agents
  (A's tool call → B as a prompt fragment) can re-encode `ev.ids`
  through the next agent's tokenizer via cross-vocab translation and
  skip detokenize entirely.
- **Construct the detokenizer once.** `codec_detokenizer_new` parses
  the vocab and builds an `id → bytes` table. Don't rebuild it per
  region: keep one alongside the watcher for the lifetime of the
  session.
- **Keep the body around until you've replied.** `ev.ids` points into
  the watcher's internal buffer and is invalidated by the next
  `codec_tool_watcher_feed` call. If your dispatch is async, copy the
  IDs out of `ev.ids` before returning to the read loop, or render to
  JSON synchronously and let your async layer own the string.
- **Multiple tool calls per turn happen.** A single `feed()` can return
  multiple `REGION_END` events (case 7 in the failure-modes table).
  Process them in order; each is independent.

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
| `codec_hash_zstd_dict(bytes, len, out_hex)` | Hash dict bytes to canonical `sha256:<hex>` form.              |
| `codec_select_zstd_dict_for_response(...)` | Match a response's `Codec-Zstd-Dict` header against loaded dicts. |
| `codec_well_known_dict_url(origin, hash, out_url, len)` (v0.5) | Build `<origin>/.well-known/codec/dicts/<sha>.zstd`. URL builder only: libcodec is HTTP-agnostic; caller does the fetch. |
| `codec_verify_zstd_dict_bytes(bytes, len, expected_hash)` (v0.5) | After fetching dict bytes with your HTTP stack of choice, verify they hash to the expected sha256 before feeding into libzstd. Hard-fails on mismatch (`CODEC_ERR_HASH_MISMATCH`). |

Header is `<codec/codec.h>`. Full Doxygen-style comments documenting every function are in the header.

## Correctness

- **Test suite (CTest, 4 binaries, 22 cases) passes 100%**: frame round-trip both formats, detokenizer with byte_level + metaspace + byte fallback + partial UTF-8 buffering, map parsing + sha256 verification, msgpack stream split-frame reassembly, protobuf chunk-boundary handling.
- **Real Qwen-2 round-trip**: when run with `CODEC_MAPS_QWEN=/path/to/qwen2.json`, decodes the actual 152K-vocab Qwen-2 map and round-trips known token IDs back to text bit-identically.
- **Algorithmic parity** with the polyglot ports: same byte_level / metaspace decode logic, same UTF-8 buffer rules, same hex-decoded sha256 verification: verified by feeding the same fixtures into all four implementations and asserting equal output.

Sample bench (Windows MSVC release build, 100K single-token msgpack frames decoded + detokenized through the real Qwen-2 152K-vocab map):

```
stream: 1,498,841 bytes (14.99 B/token)
decoded 100,000 frames in 6,740 ms
  67,403 ns/frame (decode + detokenize combined, single-threaded, malloc-per-frame)
```

The bench keeps memory allocation deliberately naive (a fresh `codec_frame_t` and rendered string per chunk) to mirror the typical client pattern. Production callers can hold buffers across chunks for higher throughput.

## What's shipped (and what's deliberately not)

**Shipped** (bit-identical to the higher-level bindings, verified against the cross-stack matrix):

- `Detokenizer` (IDs → UTF-8)
- **`BPEEncoder` (text → IDs)**: `codec_bpe_encoder_new` / `codec_bpe_encode` / `codec_bpe_encoder_free`. Byte-level + metaspace pre-tokenizers, both supported. Pretok runs on the [pretokenizer-program runtime](../../spec/PRETOKENIZER_PROGRAM.md) (no PCRE2 dependency: Unicode `\p{L}` / `\p{N}` queries go through generated tables in `codec_unicode_tables.c`). Round-trips against the real Qwen-2 tokenizer fixture under `test/test_bpe.c`.
- `Translator` (cross-vocab `ids_A → utf-8 → ids_B`): `codec_translator_new` / `_translate` / `_finish` / `_free`. Streaming-safe (buffers to whitespace before flushing BPE).
- `ToolWatcher` (control-ID region detection)
- Wire frame encode + decode (msgpack + protobuf)
- Compression (gzip / brotli / dict-zstd via system libs)
- Safety-policy parser + sha256 verify + well-known URL builder

**Optional at build time** (size-strip for embedded / IoT):

The BPE encoder + Translator + pretok runtime + Unicode tables are ~25 KB of object code that most embedded callers never need. Decode-only consumers (firmware that consumes responses, IoT endpoints that ship pre-cached IDs via the [`@codecai/tool-kit`](../codec-tool-kit/) pattern, observers/middleware that route raw token streams without BPE) can drop them at configure time:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=MinSizeRel -DCODEC_WITH_BPE_ENCODER=OFF
```

Result: ~25 KB lighter static lib on x86-64 (more like 15-30 KB on Cortex-M / Xtensa / RISC-V depending on toolchain). The public-API symbols still link: they return `CODEC_ERR_NOT_BUILT` consistently: so consumer code doesn't need any `#ifdef` guards. Calling `codec_bpe_encode` / `codec_translator_translate` / `codec_pretok_run_program` on a decode-only build produces a clean runtime error.

**Deliberately not in scope**:

- **HTTP client**: `codec_map_from_json` takes bytes you've already fetched. Use libcurl, libsoup, libfetch, etc. to do the GET. This stays opinion-free about networking.
- **Safety-policy descriptor publishing**: server-side concern; lives in the higher-level languages (Python / .NET / TS). C has parse + hash + URL only.

## Map sources

`codec_map_from_json` accepts any JSON conforming to the v2 schema. For curated pre-generated maps:

```
https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/<family>.json
```

14 model families covering 70+ aliases: see [`codec-maps`](https://github.com/wdunn001/codec-maps) for the index. Pin by sha256 from the index.

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
| Linux            | GCC 9+, Clang 9+ | Should work: pure C99, stdlib-only |
| macOS            | Apple Clang   | Should work: pure C99, stdlib-only |

C99 is the minimum standard. There are no platform-specific intrinsics or syscalls.

## License

MIT: see [LICENSE](https://github.com/wdunn001/Codec/blob/main/LICENSE) at the repo root. Vendored deps:
- `src/sha256.c`: Brad Conte's public domain implementation.
- `src/jsmn.h`: Serge Zaitsev, MIT license.

## Related

- **Codec spec**: [github.com/wdunn001/Codec/spec/PROTOCOL.md](https://github.com/wdunn001/Codec/blob/main/spec/PROTOCOL.md)
- **Tokenizer dialect registry**: [github.com/wdunn001/codec-maps](https://github.com/wdunn001/codec-maps)
- **Sister-language clients**: [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) (TS/JS), [`Codec.Net`](https://www.nuget.org/packages/Codec.Net) (.NET), [`codecai`](https://pypi.org/project/codecai/) (Python).
- **Server PRs**: [vLLM #41765](https://github.com/vllm-project/vllm/pull/41765), [SGLang #24483](https://github.com/sgl-project/sglang/pull/24483), llama.cpp (in flight).
