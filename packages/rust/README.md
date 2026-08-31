# codec-rs

**Isomorphic tokenizer + detokenizer for the [Codec](https://github.com/wdunn001/Codec) binary transport protocol: for Rust.**

Decodes streaming token IDs from Codec-compliant servers (vLLM, SGLang) and encodes text into IDs for the bidirectional path. Pure Rust, with optional `reqwest` for the map loader and optional `tokio` for async stream decoding.

The functional twin of [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) (browser/Node), [`codecai`](https://pypi.org/project/codecai/) (Python), and [`Codec.Net`](https://www.nuget.org/packages/Codec.Net) (.NET). Same tokenizer dialect maps work everywhere.

## Install

```toml
# Cargo.toml
[dependencies]
codec-rs = "0.1"
# or, with async streams + map loader:
codec-rs = { version = "0.1", features = ["tokio", "http"] }
```

```bash
cargo add codec-rs
# async:
cargo add codec-rs --features tokio
```

Edition 2021. Stable Rust 1.75+. The `http` feature is on by default; disable it (`default-features = false`) if you want the core types without `reqwest`.

## Quick start: decode a stream (sync)

```rust
use codec_rs::{decode_msgpack_stream, Detokenizer, DetokenizeOptions, MapLoader, LoadOptions};

# fn main() -> Result<(), Box<dyn std::error::Error>> {
// 1. Load and pin the dialect map by sha256.
let map = MapLoader::load_blocking(LoadOptions {
    url: "https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json".into(),
    hash: Some("sha256:c73972f7a580…".into()),
    ..Default::default()
})?;

// 2. Stream from a Codec-compliant server.
let resp = reqwest::blocking::Client::new()
    .post("http://localhost:8000/v1/completions")
    .json(&serde_json::json!({
        "model": "Qwen/Qwen2.5-7B-Instruct",
        "prompt": "Explain entropy.",
        "stream_format": "msgpack",
        "max_tokens": 256
    }))
    .send()?;

// 3. Detokenize lazily: only when rendering for a human.
let mut detok = Detokenizer::new(&map);
for frame in decode_msgpack_stream(resp) {
    let frame = frame?;
    let opts = DetokenizeOptions { partial: !frame.done, render_special: false };
    print!("{}", detok.render(&frame.ids, opts));
}
# Ok(()) }
```

## Forwarding IDs to another model (agent-to-agent, same vocab)

When the next consumer of this stream is another model on the same vocab: agent → agent, orchestrator → planner, model → tool that re-feeds the model: you do NOT need a `Detokenizer` at all. Forward `frame.ids` directly:

```rust,ignore
// No Detokenizer constructed: zero UTF-8 reassembly, zero BPE-merge work.
for frame in decode_msgpack_stream(resp) {
    let frame = frame?;
    forward_codec_frame(next_agent, &frame.ids, frame.done);  // pass &[u32] straight on
}
```

This is the **hot-loop fast path** for agent mesh code. Skipping `detok.render(...)` saves ~10-20% client CPU on heavy reply streams (no `String` allocation, no partial-UTF-8 buffering, no metaspace decode). For cross-vocab handoff use [`Translator`](#cross-vocab-agent-handoff): that case still needs the byte-level path because the two vocabs disagree.

## Quick start: decode a stream (async)

Behind the `tokio` feature flag, the same logic runs over `tokio::io::AsyncRead`:

```rust,ignore
use codec_rs::stream::r#async::decode_msgpack_stream_async;
use codec_rs::{Detokenizer, DetokenizeOptions, MapLoader, LoadOptions};
use futures_util::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let map = MapLoader::load(LoadOptions {
        url: "https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json".into(),
        hash: Some("sha256:c73972f7a580…".into()),
        ..Default::default()
    }).await?;

    let resp = reqwest::Client::new()
        .post("http://localhost:8000/v1/completions")
        .json(&serde_json::json!({
            "prompt": "Explain entropy.",
            "stream_format": "msgpack",
        }))
        .send().await?;

    // Adapt `bytes::Bytes` chunks to AsyncRead via `tokio_util::io::StreamReader` if needed,
    // or use `resp.bytes_stream()` with your own glue.
    let body = tokio_util::io::StreamReader::new(
        resp.bytes_stream().map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)))
    );
    let mut detok = Detokenizer::new(&map);
    let stream = decode_msgpack_stream_async(body);
    tokio::pin!(stream);
    while let Some(frame) = stream.next().await {
        let frame = frame?;
        let opts = DetokenizeOptions { partial: !frame.done, render_special: false };
        print!("{}", detok.render(&frame.ids, opts));
    }
    Ok(())
}
```

## Quick start: encode text (bidirectional path)

When you want **zero text on the wire in either direction**: agent A's output IDs feeding straight into agent B's input: encode text to IDs locally before sending:

```rust,ignore
use codec_rs::{Tokenize, TokenizerMap};

let map = TokenizerMap::from_json(json_bytes)?;
let tok = Tokenize::pick(&map);
let prompt_ids: Vec<u32> = tok.encode("Explain entropy.");

// Send IDs as a normal OpenAI prompt: int[] (no special endpoint needed).
let body = serde_json::json!({
    "prompt": prompt_ids,
    "stream_format": "msgpack",
    "max_tokens": 256,
});
```

For huge prompts (>50K tokens, e.g. RAG with long context), the dedicated `/v1/completions/codec` endpoint accepts a binary msgpack request body with the same effect. See [PROTOCOL.md](https://github.com/wdunn001/Codec/blob/main/spec/PROTOCOL.md) for both paths.

## API

| Type | Purpose |
|---|---|
| `MapLoader::load_blocking(opts)` / `MapLoader::load(opts).await` | Fetch + sha256-verify + cache a dialect map |
| `discover_zstd_dict_blocking(origin, hash)` / `discover_zstd_dict(origin, hash).await` (v0.5) | Resolve a zstd dict at `.well-known/codec/dicts/<sha256-hex>.zstd`. Hash-pin-verified against the URL's path component; hard-fails on 404 / mismatch (no silent fallback). `well_known_dict_url` builds the URL on its own for callers using a custom HTTP stack. |
| `MemoryMapCache` / `MapCache` trait | Default in-memory cache; implement for Redis / disk / IDB |
| `TokenizerMap::from_json(...)` / `TokenizerMap::validate(...)` | Parse + schema check |
| `TokenizerMap::verify_sha256(bytes, expected)` | Standalone sha256 verify |
| `Detokenizer` | Stateful: byte_level + metaspace + byte fallback + partial UTF-8 |
| `Detokenizer::detokenize(map, ids, render_special)` | One-shot for non-streaming use |
| `BPETokenizer` | Pure-Rust BPE: byte_level + metaspace |
| `LongestMatchTokenizer` | Vocab-only fallback for canonical-IR maps |
| `Tokenize::pick(&map)` | Build the right tokenizer for the loaded map |
| `Tokenize::encode(&map, text)` | One-shot helper |
| `decode_msgpack_stream(read)` | `Read` → `Iterator<Item = Result<CodecFrame>>` |
| `decode_protobuf_stream(read)` | Same for length-prefixed protobuf |
| `decode_protobuf_frame(span)` | One-shot frame decoder (no length prefix) |
| `stream::async::decode_msgpack_stream_async(...)` | Async variant (feature `tokio`), returns `Stream<Item = Result<CodecFrame>>` |
| `stream::async::decode_protobuf_stream_async(...)` | Same for protobuf |
| `ToolWatcher` | Detect delimited regions (tool calls, reasoning blocks, vision spans) without decoding |
| `Translator` / `translate_one_shot` / `static_translation_table` | Cross-vocab agent handoff: `ids_A → text → ids_B` with streaming-safe word-boundary buffering |

## Detect tool calls without decoding

Most chat-tuned models delimit tool calls with single-token specials (Qwen `<tool_call>`/`</tool_call>`, Llama 3.1+ `<|python_tag|>`/`<|eom_id|>`, DeepSeek-R1 `<think>`/`</think>`, …). Detecting one is a `u32` compare in the hot loop: no detokenize, no string allocation:

```rust,ignore
use codec_rs::{decode_msgpack_stream, ToolWatcher, WatcherEventKind};

let mut watcher = ToolWatcher::new(&map, "<tool_call>", "</tool_call>")?;
for frame in decode_msgpack_stream(stream) {
    let frame = frame?;
    for ev in watcher.feed(&frame.ids) {
        match ev.kind {
            WatcherEventKind::Passthrough => forward_codec_frame(next_agent, &ev.ids), // no decode
            WatcherEventKind::Region => dispatch_tool(&detok.render(&ev.ids, Default::default())),
        }
    }
}
```

Stateful: regions split between network frames buffer until the end marker arrives. Same primitive covers reasoning blocks, multimodal spans, code-interpreter regions: anything delimited by a `(start, end)` special pair.

## Cross-vocab agent handoff

When agent A's output feeds agent B as a prompt and the two models have different vocabs, decode-then-reencode through text: without ever putting text on the wire:

```rust,ignore
use codec_rs::Translator;

let mut tr = Translator::new(&qwen_map, &llama_map);
for frame in decode_msgpack_stream(stream) {
    let frame = frame?;
    let llama_ids = tr.translate(&frame.ids, !frame.done);
    forward_codec_frame(llama_agent, &llama_ids);
}
// tr.finish() drains the trailing partial-word buffer.
let drain = tr.finish();
```

Pre-tokenizers split at whitespace. `Translator` buffers partial words until a safe boundary arrives as a result. For analysis-only use, `static_translation_table(&from, &to)` gives a context-free `id_A → ids_B` lookup.

## Correctness

- **Byte-level decode**: every vocab token is a sequence of GPT-2-encoded bytes. The Detokenizer reverses the byte→unicode table and accumulates bytes across tokens until a complete UTF-8 sequence forms. Tested with 3-byte (`€`) and 4-byte (`🚀`) sequences.
- **Metaspace decode**: `▁` becomes space; SentencePiece byte-fallback IDs (`<0x00>`:`<0xFF>`) decoded through the same UTF-8 buffer.
- **Partial sequences across frames**: `Detokenizer` is stateful: call `render(ids, DetokenizeOptions { partial: true, .. })` while frames stream, then `partial: false` on the last frame so the buffer flushes. `reset()` between conversations.
- **BPE merge ordering**: greedy by priority rather than left-to-right. Matches HuggingFace tokenizers reference behavior. Test fixture verifies this explicitly (`tests/bpe_tests.rs::merges_greedily_by_priority_not_left_to_right`).
- **Hash verification** uses `sha2::Sha256`. Mismatch returns `LoadError::HashMismatch` (no panic).

## Map sources

`MapLoader::load_blocking` / `MapLoader::load` accept any URL: the sha256 hash is what matters. For curated pre-generated maps:

```
https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/<family>.json
```

14 families covering 70+ aliases: see [`codec-maps`](https://github.com/wdunn001/codec-maps) for the index.

To generate from a HuggingFace `tokenizer.json`:

```bash
npx @codecai/maps-cli build my-org/my-model --id=my-org/my-model
```

## Compression

`MapLoader` enables transparent decompression for gzip and brotli on its `reqwest` client. jsDelivr's `Content-Encoding: br` (3.4× smaller transfers) works out of the box as a result. For Codec streaming responses, the server negotiates `Content-Encoding` based on the request's `Accept-Encoding`; have your `reqwest` client request `Accept-Encoding: zstd, br, gzip` and the response stream is decompressed before any decoder sees it.

## Feature flags

| Feature | Default | What it enables |
|---|:---:|---|
| `http` | yes | `MapLoader` (sync + async) via `reqwest` with rustls |
| `tokio` | no | `stream::async::*` async-stream decoders for any `tokio::io::AsyncRead` |

Disable defaults to drop `reqwest`:

```toml
codec-rs = { version = "0.1", default-features = false }
```

## License

MIT. See [LICENSE](https://github.com/wdunn001/Codec/blob/main/LICENSE).
