# Codec.Net

**Isomorphic tokenizer + detokenizer for the [Codec](https://github.com/wdunn001/Codec) binary transport protocol — for .NET.**

Decodes streaming token IDs from Codec-compliant servers (vLLM, SGLang) and encodes text into IDs for the bidirectional path. Pure managed code, no native dependencies beyond `MessagePack`.

The functional twin of [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) (browser/Node) and `codecai` (Python). Same tokenizer dialect maps work everywhere.

## Install

```bash
dotnet add package Codec.Net
```

Targets `net8.0`. Works in any .NET 8+ host: ASP.NET Core, Blazor, MAUI, console, Unity 2023+, Function Apps.

## Quick start — decode a stream

```csharp
using Codec;

// 1. Load and pin the dialect map by sha256.
var map = await MapLoader.LoadAsync(new LoadOptions
{
    Url  = "https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json",
    Hash = "sha256:c73972f7a580…",
});

// 2. Stream from a Codec-compliant server.
using var http = new HttpClient();
var requestBody = """
    { "model": "Qwen/Qwen2.5-7B-Instruct",
      "prompt": "Explain entropy.",
      "stream_format": "msgpack",
      "max_tokens": 256 }
    """;
using var req = new HttpRequestMessage(HttpMethod.Post, "http://localhost:8000/v1/completions");
req.Content = new StringContent(requestBody, System.Text.Encoding.UTF8, "application/json");
using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
resp.EnsureSuccessStatusCode();

// 3. Detokenize lazily — only when rendering for a human.
var detok = new Detokenizer(map);
await using var body = await resp.Content.ReadAsStreamAsync();
await foreach (var frame in StreamDecoder.DecodeMsgpackStreamAsync(body))
{
    var text = detok.Render(frame.Ids, new DetokenizeOptions { Partial = !frame.Done });
    Console.Write(text);
}
```

## Quick start — encode text (bidirectional path)

When you want **zero text on the wire in either direction** — agent A's output IDs feeding straight into agent B's input — encode text to IDs locally before sending:

```csharp
var tok = new BPETokenizer(map);
var promptIds = tok.Encode("Explain entropy.");   // pure C# BPE, exact

// Send IDs as a normal OpenAI prompt: int[] (no special endpoint needed).
var body = JsonSerializer.Serialize(new
{
    prompt = promptIds,
    stream_format = "msgpack",
    max_tokens = 256,
});
```

For huge prompts (>50K tokens, e.g. RAG with long context), the dedicated `/v1/completions/codec` endpoint accepts a binary msgpack request body with the same effect. See [PROTOCOL.md](https://github.com/wdunn001/Codec/blob/main/spec/PROTOCOL.md) for both paths.

## API

| Type | Purpose |
|---|---|
| `MapLoader.LoadAsync(opts)` | Fetch + sha256-verify + cache a dialect map |
| `MemoryMapCache` | Default in-memory `IMapCache`. Implement for IDB / KV |
| `TokenizerMap.FromJson(...)` / `Validate(...)` | Parse + schema check |
| `Detokenizer` | Stateful detokenizer: byte_level + metaspace + byte fallback + partial UTF-8 |
| `Detokenizer.Detokenize(map, ids)` | One-shot for non-streaming use |
| `BPETokenizer` | Pure C# BPE: byte_level + metaspace |
| `LongestMatchTokenizer` | Vocab-only fallback for canonical-IR maps |
| `Tokenize.Pick(map)` | Build the right tokenizer for the loaded map |
| `Tokenize.Encode(map, text)` | One-shot helper |
| `StreamDecoder.DecodeMsgpackStreamAsync(stream)` | `Stream` → `IAsyncEnumerable<CodecFrame>` |
| `StreamDecoder.DecodeProtobufStreamAsync(stream)` | Same for length-prefixed protobuf |
| `StreamDecoder.DecodeProtobufFrame(span)` | One-shot frame decoder (no length prefix) |
| `ToolWatcher` | Detect delimited regions (tool calls, reasoning blocks, vision spans) without decoding |
| `Translator`, `TranslatorExtensions.Translate(...)`, `TranslatorExtensions.StaticTranslationTable(...)` | Cross-vocab agent handoff: `ids_A → text → ids_B` with streaming-safe word-boundary buffering |

## Detect tool calls without decoding

Most chat-tuned models delimit tool calls with single-token specials (Qwen `<tool_call>`/`</tool_call>`, Llama 3.1+ `<|python_tag|>`/`<|eom_id|>`, DeepSeek-R1 `<think>`/`</think>`, …). Detecting one is a uint compare in the hot loop — no detokenize, no string allocation:

```csharp
var watcher = new ToolWatcher(map, "<tool_call>", "</tool_call>");

await foreach (var frame in StreamDecoder.DecodeMsgpackStreamAsync(stream)) {
    foreach (var ev in watcher.Feed(frame.Ids)) {
        if (ev.Kind == WatcherEventKind.Passthrough)
            ForwardCodecFrame(nextAgent, ev.Ids);   // no decode
        else
            DispatchTool(JsonDocument.Parse(detok.Render(ev.Ids.Cast<int>().ToArray())));
    }
}
```

Stateful — regions split between network frames buffer until the end marker arrives. Same primitive covers reasoning blocks, multimodal spans, code-interpreter regions — anything delimited by a `(start, end)` special pair.

## Cross-vocab agent handoff

When agent A's output feeds agent B as a prompt and the two models have different vocabs, decode-then-reencode through text — without ever putting text on the wire:

```csharp
var tr = new Translator(qwenMap, llamaMap);

await foreach (var frame in StreamDecoder.DecodeMsgpackStreamAsync(stream)) {
    var llamaIds = tr.Translate(frame.Ids, partial: !frame.Done);
    ForwardCodecFrame(llamaAgent, llamaIds);
}
// tr.Finish() drains the trailing partial-word buffer.
```

Pre-tokenizers split at whitespace, so `Translator` buffers partial words until a safe boundary arrives. For analysis-only use, `TranslatorExtensions.StaticTranslationTable(A, B)` gives a context-free `id_A → ids_B` lookup.

## Correctness

- **Byte-level decode**: every vocab token is a sequence of GPT-2-encoded bytes. The Detokenizer reverses the byte→unicode table and accumulates bytes across tokens until a complete UTF-8 sequence forms. Tested with 3-byte (`€`) and 4-byte (`🚀`) sequences.
- **Metaspace decode**: `▁` becomes space; SentencePiece byte-fallback IDs (`<0x00>`–`<0xFF>`) decoded through the same UTF-8 buffer.
- **Partial sequences across frames**: `Detokenizer` is stateful — call `Render(ids, new DetokenizeOptions { Partial = true })` while frames stream, then `Partial = false` (or default) on the last frame so the buffer flushes. `Reset()` between conversations.
- **BPE merge ordering**: greedy by priority, not left-to-right. Matches HuggingFace tokenizers reference behavior. Test fixture verifies this explicitly.
- **HuggingFace round-trip**: real Qwen-2 (152K vocab, byte_level) round-trips ASCII, code, emoji, multi-script CJK / Latin diacritics. Bit-identical with HF's Rust `tokenizers` library.
- **Hash verification** uses `System.Security.Cryptography.SHA256`. Mismatch throws `TokenizerMapHashMismatchException`.

## Map sources

`MapLoader.LoadAsync` accepts any URL — the sha256 hash is what matters. For curated pre-generated maps:

```
https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/<family>.json
```

14 families covering 70+ aliases — see [`codec-maps`](https://github.com/wdunn001/codec-maps) for the index.

To generate from a HuggingFace `tokenizer.json`:

```bash
npx @codecai/maps-cli build my-org/my-model --id=my-org/my-model
```

## Compression

`MapLoader` enables `AutomaticDecompression` for gzip and brotli on its `HttpClient`, so jsDelivr's `Content-Encoding: br` (3.4× smaller transfers) works transparently. For Codec streaming responses, the server negotiates `Content-Encoding` based on the request's `Accept-Encoding`. Pass `Accept-Encoding: zstd, br, gzip` and the .NET runtime decompresses the response stream before `DecodeMsgpackStreamAsync` ever sees it.

## License

MIT. See [LICENSE](https://github.com/wdunn001/Codec/blob/main/LICENSE).
