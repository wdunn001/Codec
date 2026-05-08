/**
 * @codecai/web — isomorphic tokenizer + detokenizer for the Codec binary
 * transport protocol.
 *
 * Loads per-model tokenizer dialect maps, tokenizes text at the edge before
 * transport, and detokenizes IDs to text only when a human is going to read
 * them. Agent-to-agent calls skip detokenization entirely — text never
 * enters the transport at all.
 *
 * Works in browsers, Node 18+, Cloudflare Workers, Deno, Bun. No Node-only
 * imports. No transitive heavyweight dependencies.
 *
 * Quick start (decoding a stream):
 *
 *   import { loadMap, Detokenizer, decodeStream } from '@codecai/web';
 *
 *   const map = await loadMap({
 *     url: 'https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/meta-llama/llama-3.json',
 *     hash: 'sha256:…',
 *   });
 *   const detok = new Detokenizer(map);
 *   for await (const frame of decodeStream(resp.body!)) {
 *     output.append(detok.render(frame.ids, { partial: !frame.done }));
 *   }
 *
 * Quick start (encoding text for the bidirectional endpoint):
 *
 *   import { BPETokenizer } from '@codecai/web';
 *   const tok = new BPETokenizer(map);
 *   const ids = tok.encode('Explain entropy.');
 *   // send `ids` over the wire as msgpack/protobuf — never text.
 */
export type {
  TokenizerMap,
  CodecFrame,
  MapCache,
  Tokenizer,
} from './types.js';

export type {
  LatentSpaceMap,
  LatentSpaceMapCache,
  LatentPipeline,
  LatentDecoderRuntime,
  LatentDecoder,
  LatentZstdDictionaryEntry,
  LatentVideoMetadata,
} from './latent-types.js';

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
  loadLatentMap,
  makeLatentMap,
  validateLatentMap,
  MemoryLatentSpaceMapCache,
  LatentSpaceMapValidationError,
  LatentSpaceMapHashMismatchError,
  type LoadLatentMapOptions,
} from './latent-map.js';

export {
  discoverMap,
  discoverLatentSpace,
  discoverIndex,
  wellKnownMapUrl,
  wellKnownLatentSpaceUrl,
  wellKnownIndexUrl,
  WELL_KNOWN_BASE,
  MapDiscoveryError,
  MapDiscoveryNotFoundError,
  type MapPointer,
  type LatentSpacePointer,
  type MapIndex,
  type DiscoverMapOptions,
  type DiscoverLatentSpaceOptions,
  type DiscoverIndexOptions,
} from './discover.js';

export {
  Detokenizer,
  detokenize,
  type DetokenizeOptions,
} from './detokenize.js';

export {
  LongestMatchTokenizer,
  tokenize,
  pickTokenizer,
} from './tokenize.js';

export {
  Translator,
  translate,
  staticTranslationTable,
  type TranslateOptions,
} from './translate.js';

export {
  ToolWatcher,
  ToolWatcherError,
  type WatcherEvent,
} from './tool-watcher.js';

export {
  BPETokenizer,
  bpeEncode,
} from './bpe.js';

export {
  BYTE_TO_CHAR,
  CHAR_TO_BYTE,
  decodeByteLevelToken,
  encodeByteLevelChars,
  METASPACE,
} from './encoder.js';

export {
  decodeStream,
  decodeMsgpackStream,
  decodeProtobufStream,
  decodeProtobufFrame,
} from './stream.js';

export {
  runPreTokProgram,
  type PreTokOp,
  type PreTokProgram,
} from './pretok-program.js';
