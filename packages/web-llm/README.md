# @codecai/web-llm

**A browser-side LLM as a Codec source.** Wraps `@mlc-ai/web-llm`
(WebGPU inference in the browser) and emits the same Codec msgpack
frame stream that vLLM / sglang / llama.cpp containers produce over
HTTP. From a consumer's perspective, a local web-llm engine and a
remote Codec-aware HTTP server look **byte-identical on the wire**: the same `@codecai/web` `decodeMsgpackStream` consumes from both.

New in Codec v0.4, paired with
[Unstable Legion](https://github.com/wdunn001/unstable-legion): the
peer-to-peer browser-AI mesh that exchanges these frames over WebRTC
data channels.

## Why

Codec's wire format is **transport-agnostic**. Codec msgpack frames
already flow:

- **HTTP streaming** from a vLLM / sglang / llama.cpp container,
  consumed by `decodeMsgpackStream` against a `Response.body`.
- **HTTP streaming** of VAE latent frames from a Codec-aware
  ComfyUI / diffusers fork.
- **WebRTC data channel** of latent frames from the same forks when
  routed through a Codec-over-RTC relay (already shipping for the
  image-gen pathways).

The text-token modality needed one more piece: a **producer** of
those frames in the browser. That's this package. With it, a
peer-to-peer browser mesh can route LLM completions between tabs
using the existing Codec wire format: no new sub-protocol.

The bandwidth math (500-token completion over a typical Trystero
BitTorrent relay):

| Path                     | Bytes     | Headroom on a 50 KB/s budget |
|--------------------------|----------:|----------------------------:|
| JSON-SSE text            |  ~75 KB   | < 1 concurrent stream       |
| Codec msgpack identity   |  ~5 KB    | ~10 concurrent streams      |
| Codec msgpack + zstd     |  ~500 B   | ~100 concurrent streams     |

The compressed-Codec path is what makes a browser-AI mesh viable
on the BitTorrent / IPFS / Nostr / MQTT relays Trystero uses.

## Install

```bash
npm install @codecai/web-llm @codecai/web @mlc-ai/web-llm
```

`@mlc-ai/web-llm` is a peer dep: install the version your bundler
prefers (>= 0.2.x).

## Usage

### As a Codec source for the standard `@codecai/web` decoder

```ts
import { CreateMLCEngine } from "@mlc-ai/web-llm";
import { wrapEngine } from "@codecai/web-llm";
import { decodeMsgpackStream, BPETokenizer, loadMap } from "@codecai/web";

// 1. Load the engine and the matching tokenizer map.
const engine = await CreateMLCEngine("Qwen2.5-0.5B-Instruct-q4f16_1-MLC");
const map = await loadMap({
  url:  "https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json",
  hash: "sha256:62c2f94fcbdb9b49d51632314e64aa65894496bc39751cb90866049657a262ad",
});
const tok = new BPETokenizer(map);

// 2. Wrap. The Codec engine emits the same frames an HTTP server does.
const codecEngine = wrapEngine(engine, {
  mapId: "qwen/qwen2",
  tokenize: (text) => tok.encode(text),
});

// 3. Stream completions through the same `decodeMsgpackStream` you'd use
//    against a remote sglang server.
const stream = codecEngine.completionsStream({
  prompt: "Explain entropy in one sentence.",
  max_tokens: 256,
});

for await (const frame of decodeMsgpackStream(stream)) {
  // frame.ids: number[], frame.done: boolean, frame.finish_reason?: string
}
```

### Raw frame iteration (skip the `ReadableStream`)

```ts
for await (const frame of codecEngine.frames({ prompt, max_tokens: 256 })) {
  // Forward `frame.ids` somewhere: another peer, a detokenizer, a tool watcher.
}
```

### Routing frames over WebRTC

Pair with [Unstable Legion's mesh peer](https://github.com/wdunn001/unstable-legion):

```ts
import { joinMesh } from "@unstable-legion/core";
import { joinRoom } from "trystero/torrent";

const peer = joinMesh({
  joinRoom,
  trysteroConfig: { appId: "unstable-legion-demo" },
  roomId: "my-public-room",
  cap: { /* MeshPeerCap */ },
});

// Stream this peer's local LLM output to a requesting peer.
for await (const frame of codecEngine.frames({ prompt: incomingRequest, max_tokens: 512 })) {
  await peer.sendFrame(frame, requestingPeerId);
}
```

Receiving side just decodes the frame and detokenizes: same code path
that consumes an HTTP-served vLLM stream.

## Tokenizer parity

The Codec frame carries raw token IDs from the model's tokenizer.
Receivers detokenize via `@codecai/web`'s `Detokenizer` against the
matching `codec-maps` entry. **The `mapId` you pass to `wrapEngine`
MUST correspond to the actual tokenizer the loaded web-llm model
uses**: mismatches produce wrong tokenization on the consumer side.

This package doesn't auto-discover the map: it's a small library
rather than a smart one. The standard mapping for the common web-llm models:

| web-llm model id (excerpt)                | codec-maps `mapId`     |
|-------------------------------------------|------------------------|
| `Qwen2.5-*-Instruct-q4f16_1-MLC`          | `qwen/qwen2`           |
| `Llama-3.1-*-Instruct-q4f16_1-MLC`        | `meta-llama/llama-3`   |
| `Phi-3.5-mini-instruct-q4f16_1-MLC`       | `microsoft/phi-3`      |
| `Mistral-Nemo-Instruct-2407-q4f16_1-MLC`  | `mistralai/mistral-nemo` |
| `Hermes-3-Llama-3.2-3B-q4f16_1-MLC`       | `meta-llama/llama-3`   |
| `gemma-2-2b-it-q4f16_1-MLC`               | `google/gemma-2`       |

## Status

v0.4 baseline. The `chat.completions.create` streaming path is wired;
non-streaming + tool-use paths are followups.

## See also

- [Codec spec](https://github.com/wdunn001/Codec): the wire format.
- [`@codecai/web`](https://www.npmjs.com/package/@codecai/web): the decoder.
- [`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm): the WebGPU
  inference engine this package wraps.
- [`wdunn001/web-llm`](https://github.com/wdunn001/web-llm): Codec-aware
  fork (adds opt-in `stream_format: 'msgpack'` to skip the wrap+rewrap
  cost when caller has a Codec-compatible consumer).
- [Unstable Legion](https://github.com/wdunn001/unstable-legion): the
  peer-to-peer browser mesh that consumes these frames over WebRTC.

## License

[BSL-1.1](LICENSE).
