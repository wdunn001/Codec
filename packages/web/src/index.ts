/**
 * @codec/web — isomorphic edge tokenizer + lazy detokenizer for the Codec
 * binary transport protocol.
 *
 * The presentation layer for Codec. Loads per-model tokenizer maps, tokenizes
 * text at the edge before transport, and detokenizes IDs to text only when a
 * human is going to read them. Agent-to-agent calls skip detokenization
 * entirely — text never enters the transport at all.
 *
 * Works in browsers, Node 18+, Cloudflare Workers, Deno, Bun. No Node-only
 * imports. No transitive heavyweight dependencies.
 *
 * Quick start:
 *
 *   import { loadMap, Detokenizer, decodeStream } from '@codec/web';
 *
 *   const map = await loadMap({
 *     url: 'https://maps.codec.ai/llama-3.1-8b.json',
 *     hash: 'sha256:…',
 *   });
 *
 *   const detok = new Detokenizer(map);
 *   const resp = await fetch(serverUrl, { … });
 *   for await (const frame of decodeStream(resp.body!)) {
 *     // frame.ids is the raw token output — never converted unless you ask.
 *     output.append(detok.render(frame.ids, { partial: !frame.done }));
 *   }
 */
export type { TokenizerMap, CodecFrame, MapCache } from './types.js';

export {
  loadMap,
  makeMap,
  validateMap,
  MemoryMapCache,
  TokenizerMapValidationError,
  TokenizerMapHashMismatchError,
  type LoadOptions,
} from './map.js';

export {
  Detokenizer,
  detokenize,
  type DetokenizeOptions,
} from './detokenize.js';

export {
  LongestMatchTokenizer,
  tokenize,
  type Tokenizer,
} from './tokenize.js';

export {
  decodeStream,
  decodeMsgpackStream,
  decodeProtobufStream,
  decodeProtobufFrame,
} from './stream.js';
