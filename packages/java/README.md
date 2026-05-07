# Codec for Java

**Isomorphic tokenizer + detokenizer for the [Codec](https://github.com/wdunn001/Codec) binary transport protocol — for Java 17+.**

Decodes streaming token IDs from Codec-compliant servers (vLLM, SGLang) and encodes text into IDs for the bidirectional path. Pure Java, dependencies are Jackson (JSON) and msgpack-core (MessagePack frames). Protobuf is hand-rolled — the schema is three fields, no need to drag in `protobuf-java`.

The functional twin of [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) (browser/Node), [`codecai`](https://pypi.org/project/codecai/) (Python), and [`Codec.Net`](https://www.nuget.org/packages/Codec.Net) (.NET). Same tokenizer dialect maps work everywhere.

## Install

Maven:

```xml
<dependency>
  <groupId>io.github.wdunn001</groupId>
  <artifactId>codec</artifactId>
  <version>0.1.0</version>
</dependency>
```

Gradle:

```kotlin
implementation("io.github.wdunn001:codec:0.1.0")
```

Targets Java 17. Works in any Java 17+ host: server, Android (Java 17 desugaring), Spring, Quarkus.

## Quick start — decode a stream

```java
import ai.codec.*;
import java.net.URI;
import java.net.http.*;
import java.util.Iterator;

// 1. Load and pin the dialect map by sha256.
TokenizerMap map = MapLoader.load(LoadOptions.builder()
    .url("https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json")
    .hash("sha256:c73972f7a580...")
    .build());

// 2. Stream from a Codec-compliant server.
HttpClient http = HttpClient.newHttpClient();
HttpRequest req = HttpRequest.newBuilder(URI.create("http://localhost:8000/v1/completions"))
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString("""
        { "model": "Qwen/Qwen2.5-7B-Instruct",
          "prompt": "Explain entropy.",
          "stream_format": "msgpack",
          "max_tokens": 256 }"""))
    .build();

HttpResponse<java.io.InputStream> resp = http.send(req, HttpResponse.BodyHandlers.ofInputStream());

// 3. Detokenize lazily — only when rendering for a human.
Detokenizer detok = new Detokenizer(map);
Iterator<CodecFrame> frames = StreamDecoder.decodeMsgpackStream(resp.body());
while (frames.hasNext()) {
    CodecFrame frame = frames.next();
    String text = detok.render(frame.ids(), DetokenizeOptions.partial(!frame.done()));
    System.out.print(text);
}
```

## Quick start — encode text (bidirectional path)

When you want **zero text on the wire in either direction** — agent A's output IDs feeding straight into agent B's input — encode text to IDs locally before sending:

```java
BPETokenizer tok = new BPETokenizer(map);
int[] promptIds = tok.encode("Explain entropy.");   // pure Java BPE, exact

// Send IDs as a normal OpenAI prompt: int[] (no special endpoint needed).
String body = """
    { "prompt": %s,
      "stream_format": "msgpack",
      "max_tokens": 256 }""".formatted(java.util.Arrays.toString(promptIds));
```

For huge prompts (>50K tokens, e.g. RAG with long context), the dedicated `/v1/completions/codec` endpoint accepts a binary msgpack request body with the same effect. See [PROTOCOL.md](https://github.com/wdunn001/Codec/blob/main/spec/PROTOCOL.md) for both paths.

## API

| Type | Purpose |
|---|---|
| `MapLoader.load(opts)` / `loadAsync` | Fetch + sha256-verify + cache a dialect map |
| `InMemoryMapCache` | Default in-memory `MapCache`. Implement for IDB / KV / disk |
| `TokenizerMap.fromJson(...)` / `validate(...)` | Parse + schema check |
| `TokenizerMap.verifySha256(bytes, hash)` | Standalone hash check (utility) |
| `Detokenizer` | Stateful detokenizer: byte_level + metaspace + byte fallback + partial UTF-8 |
| `Detokenizer.detokenize(map, ids)` | One-shot for non-streaming use |
| `BPETokenizer` | Pure-Java BPE: byte_level + metaspace |
| `LongestMatchTokenizer` | Vocab-only fallback for canonical-IR maps |
| `Tokenize.pick(map)` | Build the right tokenizer for the loaded map |
| `Tokenize.encode(map, text)` | One-shot helper |
| `StreamDecoder.decodeMsgpackStream(in)` | `InputStream` → `Iterator<CodecFrame>` |
| `StreamDecoder.decodeProtobufStream(in)` | Same for length-prefixed protobuf |
| `StreamDecoder.decodeProtobufFrame(bytes)` | One-shot frame decoder (no length prefix) |
| `StreamDecoder.publishMsgpack(in)` | `Flow.Publisher<CodecFrame>` for reactive callers |
| `ToolWatcher` | Detect delimited regions (tool calls, reasoning blocks, vision spans) without decoding |
| `Translator`, `Translator.translate(...)`, `Translator.staticTranslationTable(...)` | Cross-vocab agent handoff: `ids_A → text → ids_B` with streaming-safe word-boundary buffering |

## Detect tool calls without decoding

Most chat-tuned models delimit tool calls with single-token specials (Qwen `<tool_call>`/`</tool_call>`, Llama 3.1+ `<|python_tag|>`/`<|eom_id|>`, DeepSeek-R1 `<think>`/`</think>`, ...). Detecting one is a `long` compare in the hot loop — no detokenize, no string allocation:

```java
ToolWatcher watcher = new ToolWatcher(map, "<tool_call>", "</tool_call>");

Iterator<CodecFrame> frames = StreamDecoder.decodeMsgpackStream(body);
while (frames.hasNext()) {
    CodecFrame frame = frames.next();
    for (WatcherEvent ev : watcher.feed(frame.ids())) {
        if (ev.getKind() == WatcherEventKind.PASSTHROUGH) {
            forwardCodecFrame(nextAgent, ev.getIds());   // no decode
        } else {
            int[] regionIds = toIntArray(ev.getIds());
            dispatchTool(detok.render(regionIds));
        }
    }
}
```

Stateful — regions split between network frames buffer until the end marker arrives. Same primitive covers reasoning blocks, multimodal spans, code-interpreter regions — anything delimited by a `(start, end)` special pair.

IDs are stored as `long` because Java has no native unsigned 32-bit type and the protocol uses uint32 token IDs that can exceed `Integer.MAX_VALUE` in vocabularies that use the high bit.

## Cross-vocab agent handoff

When agent A's output feeds agent B as a prompt and the two models have different vocabs, decode-then-reencode through text — without ever putting text on the wire:

```java
Translator tr = new Translator(qwenMap, llamaMap);

while (frames.hasNext()) {
    CodecFrame frame = frames.next();
    int[] llamaIds = tr.translate(frame.ids(), !frame.done());
    forwardCodecFrame(llamaAgent, llamaIds);
}
int[] tail = tr.finish();   // drains the trailing partial-word buffer
```

Pre-tokenizers split at whitespace, so `Translator` buffers partial words until a safe boundary arrives. For analysis-only use, `Translator.staticTranslationTable(A, B)` gives a context-free `id_A → ids_B` lookup.

## Correctness

- **Byte-level decode**: every vocab token is a sequence of GPT-2-encoded bytes. The Detokenizer reverses the byte→unicode table and accumulates bytes across tokens until a complete UTF-8 sequence forms. Tested with 3-byte (`€`) and 4-byte (`🚀`) sequences.
- **Metaspace decode**: `▁` becomes space; SentencePiece byte-fallback IDs (`<0x00>`–`<0xFF>`) decoded through the same UTF-8 buffer.
- **Partial sequences across frames**: `Detokenizer` is stateful — call `render(ids, DetokenizeOptions.partial(true))` while frames stream, then `partial(false)` (or default) on the last frame so the buffer flushes. `reset()` between conversations.
- **BPE merge ordering**: greedy by priority, not left-to-right. Matches HuggingFace `tokenizers` reference behavior. Test fixture verifies this explicitly with `[a b c]` + merges `["b c", "a b"]`: priority-correct yields `[0, 4]` (= `a` + `bc`); naive left-to-right would yield `[3, 2]` (= `ab` + `c`).
- **HuggingFace round-trip**: real Qwen-2 (152K vocab, byte_level) round-trips ASCII, code, emoji, multi-script CJK / Latin diacritics. Bit-identical with HF's Rust `tokenizers` library — same data, same BPE algorithm, same byte→unicode table.
- **Hash verification** uses `java.security.MessageDigest` (built-in). Mismatch throws `TokenizerMapHashMismatchException`.

## Map sources

`MapLoader.load` accepts any URL — the sha256 hash is what matters. For curated pre-generated maps:

```
https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/<family>.json
```

14 families covering 70+ aliases — see [`codec-maps`](https://github.com/wdunn001/codec-maps) for the index.

To generate from a HuggingFace `tokenizer.json`:

```bash
npx @codecai/maps-cli build my-org/my-model --id=my-org/my-model
```

## Compression

`MapLoader` requests `Accept-Encoding: gzip` and decompresses transparently when the server uses it. The JDK's `HttpClient` doesn't natively decompress brotli/zstd, so for those the request omits them and falls back to identity.

For Codec streaming responses, the server negotiates `Content-Encoding` based on the request's `Accept-Encoding`. If you want brotli/zstd on the streaming body, wrap your `InputStream` with the appropriate library (e.g. `org.brotli.dec.BrotliInputStream`) before handing it to `StreamDecoder`.

## Build

```bash
mvn -B test
```

Targets Java 17 with `maven.compiler.release=17`. Uses `junit-jupiter` 5.10+ for tests. Release artifacts (sources jar, javadoc jar, GPG signatures, OSSRH staging) are produced by the `release` profile:

```bash
mvn -B -Prelease deploy
```

## License

MIT. See [LICENSE](https://github.com/wdunn001/Codec/blob/main/LICENSE).
