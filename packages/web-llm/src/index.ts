/**
 * @codecai/web-llm — local browser-side LLM as a Codec source.
 *
 * Wraps `@mlc-ai/web-llm` (WebGPU inference in the browser) and emits
 * the same Codec msgpack frame stream that vLLM / sglang / llama.cpp
 * containers produce over HTTP. From the consumer's perspective, a
 * local web-llm engine and a remote Codec-aware HTTP server look
 * byte-identical on the wire: the same `@codecai/web` `decodeMsgpackStream`
 * consumes from both.
 *
 * Where this matters: in Unstable Legion (peer-to-peer browser mesh),
 * one peer's local LLM is the "server" for another peer's request.
 * Routing the response back over a WebRTC data channel as Codec frames
 * keeps bandwidth-critical paths binary — a 500-token completion is
 * ~5 KB of Codec msgpack vs ~75 KB of JSON-SSE text. Codec frames are
 * already what `@codecai/web` decodes; nothing else has to change to
 * carry them over RTC.
 *
 * ## Usage
 *
 *   import { CreateMLCEngine } from "@mlc-ai/web-llm";
 *   import { wrapEngine } from "@codecai/web-llm";
 *   import { decodeMsgpackStream } from "@codecai/web";
 *
 *   const engine = await CreateMLCEngine("Qwen2.5-0.5B-Instruct-q4f16_1-MLC");
 *   const codecEngine = wrapEngine(engine, { mapId: "qwen/qwen2" });
 *
 *   // Same shape `decodeMsgpackStream` consumes from an HTTP body.
 *   const stream = codecEngine.completionsStream({
 *     prompt: "Explain entropy.",
 *     max_tokens: 256,
 *   });
 *   for await (const frame of decodeMsgpackStream(stream)) {
 *     // frame.ids: number[], frame.done: boolean, frame.finish_reason?: string
 *   }
 *
 * Or in raw frame-emitter mode (no ReadableStream wrapper):
 *
 *   for await (const frame of codecEngine.frames({ prompt, max_tokens })) {
 *     // frame is a CodecMsgpackFrame
 *   }
 *
 * ## Tokenizer parity
 *
 * The Codec frame contains raw token IDs from the model's tokenizer.
 * Receivers detokenize via `@codecai/web`'s `Detokenizer` against the
 * matching codec-maps entry. The `mapId` passed at wrap time MUST
 * correspond to the actual tokenizer the loaded web-llm model uses —
 * mismatches produce wrong-tokenization output. `@codecai/web-llm`
 * doesn't auto-discover the map (it's a small library, not a smart
 * one); the caller chooses.
 */
import { encode as msgpackEncode } from '@msgpack/msgpack';

// Structural type — we don't import `@mlc-ai/web-llm` at build time
// because it's a runtime-only peer dep. Consumers pass in the engine
// they already constructed.
export interface MlcEngineLike {
  chat: {
    completions: {
      create(req: {
        messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
        stream: true;
        max_tokens?: number;
        temperature?: number;
        top_p?: number;
        stop?: string | string[];
      }): Promise<AsyncIterable<{
        choices: { delta: { content?: string }; finish_reason?: string | null }[];
      }>>;
    };
  };
  /** Optional: the engine's tokenizer if exposed. Some MLC builds export this. */
  getTokenizer?(): {
    encode(text: string): number[] | { tokenIds: number[] };
  };
}

export interface WrapEngineOptions {
  /**
   * Tokenizer-map id this engine's model uses (e.g. `"qwen/qwen2"`).
   * Receivers load the matching map from codec-maps for detokenization.
   */
  mapId: string;
  /**
   * Optional fallback tokenizer when the underlying engine doesn't
   * expose `getTokenizer()`. Required for browser builds of web-llm
   * that don't surface the tokenizer; usually a `BPETokenizer` from
   * `@codecai/web` constructed against the same map id.
   */
  tokenize?: (text: string) => number[];
}

export interface CompletionsRequest {
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  /** Optional system prompt prepended to the chat-completions messages. */
  system?: string;
}

export interface CodecFrame {
  ids: number[];
  done: boolean;
  finish_reason?: string;
}

export interface CodecEngine {
  /**
   * AsyncIterable of Codec frames. Lower-level than `completionsStream`.
   * Each frame holds the token IDs produced by the underlying engine
   * for one chunk; the terminal frame has `done: true` and a
   * `finish_reason`.
   */
  frames(req: CompletionsRequest): AsyncGenerator<CodecFrame, void, void>;

  /**
   * `ReadableStream<Uint8Array>` of Codec msgpack-encoded frames,
   * length-prefix-less (each chunk is one frame's bytes). Drop-in for
   * `decodeMsgpackStream` from `@codecai/web` — the wire format is
   * the same one an HTTP-served vLLM emits.
   */
  completionsStream(req: CompletionsRequest): ReadableStream<Uint8Array>;
}

export function wrapEngine(engine: MlcEngineLike, opts: WrapEngineOptions): CodecEngine {
  const tokenize = pickTokenizer(engine, opts);

  return {
    frames(req) {
      return mlcChunksToFrames(engine, req, tokenize);
    },
    completionsStream(req) {
      const generator = mlcChunksToFrames(engine, req, tokenize);
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await generator.next();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(msgpackEncode(value));
        },
        async cancel() {
          await generator.return();
        },
      });
    },
  };
}

async function* mlcChunksToFrames(
  engine: MlcEngineLike,
  req: CompletionsRequest,
  tokenize: (text: string) => number[],
): AsyncGenerator<CodecFrame, void, void> {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });

  const stream = await engine.chat.completions.create({
    messages,
    stream: true,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stop: req.stop,
  });

  let lastFinishReason: string | undefined;
  let totalEmitted = 0;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta?.content ?? '';
    if (delta.length > 0) {
      const ids = tokenize(delta);
      if (ids.length > 0) {
        totalEmitted += ids.length;
        yield { ids, done: false };
      }
    }
    if (choice.finish_reason) {
      lastFinishReason = choice.finish_reason;
    }
  }

  // Terminal frame — empty ids, done: true, finish_reason from upstream.
  yield {
    ids: [],
    done: true,
    ...(lastFinishReason !== undefined ? { finish_reason: lastFinishReason } : {}),
  };

  // The void return prevents TS from inferring `void` as a yielded type.
  void totalEmitted;
}

function pickTokenizer(
  engine: MlcEngineLike,
  opts: WrapEngineOptions,
): (text: string) => number[] {
  if (opts.tokenize) return opts.tokenize;
  if (engine.getTokenizer) {
    const tok = engine.getTokenizer();
    return (text) => {
      const out = tok.encode(text);
      if (Array.isArray(out)) return out;
      return out.tokenIds;
    };
  }
  throw new Error(
    `@codecai/web-llm: no tokenizer available. ` +
      `Either the underlying engine must expose getTokenizer() ` +
      `or you must pass opts.tokenize (typically a @codecai/web BPETokenizer ` +
      `bound to map id "${opts.mapId}").`,
  );
}
