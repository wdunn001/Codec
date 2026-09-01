/**
 * @codecai/web-llm: Codec-aware browser LLM runtime.
 *
 * Wraps the patched `wdunn001/web-llm` fork
 * (`github:wdunn001/web-llm#feat/codec-binary-transport`) and exposes
 * its `stream_format: "raw"` mode as the ergonomic
 * `engine.streamFrames(prompt, onFrame)` API. The host does **no**
 * tokenization or detokenization on the wire path:
 *
 *   - The MLC engine's generate loop samples token IDs from logits.
 *   - The patched fork yields those IDs directly in `CodecFrame`
 *     objects.
 *   - This wrapper passes the frames through verbatim: the consumer
 *     ships them via WebRTC / HTTP / BroadcastChannel / whatever.
 *
 * Consumers that need UTF-8 (for display) detokenize at their own
 * edge using `@codecai/web`'s `Detokenizer` + the appropriate
 * tokenizer map fetched from `.well-known/codec/`. The wire never
 * carries text.
 *
 * ## Usage
 *
 *   import { CreateMLCEngine } from "@mlc-ai/web-llm";
 *   import { wrapEngine } from "@codecai/web-llm";
 *
 *   const engine = await CreateMLCEngine("Qwen2.5-0.5B-Instruct-q4f16_1-MLC");
 *   const codec = wrapEngine(engine, { mapId: "qwen/qwen2" });
 *
 *   // Frame-by-frame consumption (typical):
 *   await codec.streamFrames("Explain entropy.", (frame) => {
 *     peer.sendFrame(frame);            // ship over WebRTC, raw IDs
 *     localDetok.render(frame.ids);     // edge-detokenize for self-display
 *   });
 *
 *   // Or, for HTTP-style consumers, a ReadableStream<Uint8Array>:
 *   const body = codec.completionsStream({ prompt: "Explain entropy." });
 *   for await (const frame of decodeMsgpackStream(body)) { ... }
 *
 * ## Why peer-dep on a specific fork
 *
 * Upstream `@mlc-ai/web-llm` 0.2.x's `chat.completions.create` only
 * exposes detokenized text deltas: the generate loop calls
 * `engine.tokenizer.decode(token_id)` per step and the IDs are lost.
 * The patched fork adds `stream_format: "raw" | "msgpack"` which
 * bypasses that decode, yielding the IDs directly. Until upstream
 * merges that patch, `@codecai/web-llm` pins the fork as its
 * dependency.
 */
import { encode as msgpackEncode } from '@msgpack/msgpack';
import {
  CreateMLCEngine as _CreateMLCEngine,
  prebuiltAppConfig as _prebuiltAppConfig,
} from '@mlc-ai/web-llm';
import type {
  AppConfig,
  CodecFrame,
  MLCEngine,
  MLCEngineConfig,
  MLCEngineInterface,
} from '@mlc-ai/web-llm';

// Re-exports: consumers go through @codecai/web-llm for the engine,
// the app config, the types. They never have to type the bare
// `@mlc-ai/web-llm` import: that's a fork-vs-upstream detail this
// package abstracts over. NPM resolves `@mlc-ai/web-llm` to the
// patched `wdunn001/web-llm` fork pinned in our package.json.
// `CreateMLCEngine` here therefore ships the `stream_format: "raw"` patch.
export const CreateMLCEngine = _CreateMLCEngine;
export const prebuiltAppConfig = _prebuiltAppConfig;
export type {
  AppConfig,
  CodecFrame,
  MLCEngine,
  MLCEngineConfig,
  MLCEngineInterface,
};

// v0.4 version-negotiation primitives re-exported for convenience:
// a browser app that wraps a local MLC engine often also talks to a
// remote Codec server (mesh / hybrid); having both surfaces from one
// import keeps the call sites tidy. Canonical impl in @codecai/web.
export {
  CODEC_CLIENT_VERSION,
  CODEC_CLIENT_VERSION_HEADER,
  CODEC_MIN_VERSION_HEADER,
  CODEC_REQUIRED_FEATURES_HEADER,
  withCodecClientVersion,
  parseVersionRequired,
  discoverVersionPolicy,
  CodecVersionRequiredError,
  type CodecVersionRequiredBody,
  type CodecVersionPolicyDocument,
  type DiscoverVersionPolicyOptions,
} from '@codecai/web';

/**
 * Structural type for an MLC engine that supports `stream_format: "raw"`.
 * Matches the patched wdunn001/web-llm fork's `MLCEngine.chat.completions`
 * shape. Captured as an interface so the wrapper doesn't depend on the
 * fork's exact runtime type at consumer-build time.
 */
export interface CodecCapableEngine {
  chat: {
    completions: {
      create(req: {
        messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
        stream: true;
        stream_format?: 'raw' | 'msgpack';
        max_tokens?: number;
        temperature?: number;
        top_p?: number;
        stop?: string | string[];
      }): Promise<AsyncIterable<CodecFrame | Uint8Array>>;
    };
  };
}

export interface WrapEngineOptions {
  /**
   * Tokenizer-map id this engine's model uses (e.g. `"qwen/qwen2"`).
   * Metadata only: the wrapper does NOT use it to tokenize anything.
   * Consumers downstream (other peers, this peer's own UI) load the
   * matching map for edge detokenization.
   */
  mapId: string;
  /**
   * Default max tokens for `streamFrames` / `completionsStream` when the
   * caller doesn't pass one. Optional; underlying engine has its own default.
   */
  defaultMaxTokens?: number;
}

export interface CompletionsRequest {
  prompt: string;
  /** Optional system prompt prepended to the chat-completions messages. */
  system?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
}

export interface CodecEngine {
  /** The mapId passed at wrap time: informational, surfaced for receivers. */
  readonly mapId: string;
  /**
   * Stream raw `CodecFrame` objects from the engine. The callback fires
   * once per frame as the engine emits them: exactly what
   * `stream_format: "raw"` produces. Terminal frame has `done: true`.
   */
  streamFrames(
    req: CompletionsRequest,
    onFrame: (frame: CodecFrame) => void,
  ): Promise<void>;
  /**
   * Same content, but exposed as `AsyncGenerator<CodecFrame>` for
   * pull-style consumption.
   */
  frames(req: CompletionsRequest): AsyncGenerator<CodecFrame, void, void>;
  /**
   * `ReadableStream<Uint8Array>` of msgpack-encoded frames: drop-in for
   * `@codecai/web`'s `decodeMsgpackStream`. Same bytes an HTTP-served
   * Codec server emits. A consumer reading from this stream is
   * therefore byte-identical to one reading from a remote engine.
   */
  completionsStream(req: CompletionsRequest): ReadableStream<Uint8Array>;
}

export function wrapEngine(
  engine: MLCEngine | CodecCapableEngine,
  opts: WrapEngineOptions,
): CodecEngine {
  const eng = engine as CodecCapableEngine;

  async function* run(
    req: CompletionsRequest,
  ): AsyncGenerator<CodecFrame, void, void> {
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });

    const stream = await eng.chat.completions.create({
      messages,
      stream: true,
      stream_format: 'raw',
      max_tokens: req.max_tokens ?? opts.defaultMaxTokens,
      temperature: req.temperature,
      top_p: req.top_p,
      stop: req.stop,
    });

    for await (const item of stream) {
      // With stream_format:"raw" the fork yields CodecFrame objects.
      // The Uint8Array branch is for "msgpack" mode which we don't use
      // here (we want object form so the wrapper can choose encoding).
      if (item instanceof Uint8Array) continue;
      yield item;
    }
  }

  return {
    mapId: opts.mapId,
    async streamFrames(req, onFrame) {
      for await (const frame of run(req)) onFrame(frame);
    },
    frames(req) {
      return run(req);
    },
    completionsStream(req) {
      const gen = run(req);
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await gen.next();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(msgpackEncode(value));
        },
        async cancel() {
          await gen.return();
        },
      });
    },
  };
}
