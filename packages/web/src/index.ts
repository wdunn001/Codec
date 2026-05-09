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
  ToolCallingBlock,
  CodecFrame,
  FinishReason,
  MapCache,
  Tokenizer,
  SafetyPolicyDescriptor,
  SafetyPolicyCategory,
  SafetyPolicyClassifier,
  SafetyPolicyRulesSummary,
  SafetyPolicyClientHooks,
  SafetyPolicyPublisher,
  SafetyPolicyCache,
} from './types.js';

export {
  validateSafetyPolicy,
  hashSafetyPolicy,
  loadSafetyPolicy,
  discoverSafetyPolicy,
  wellKnownPolicyUrl,
  wellKnownPolicyHashUrl,
  POLICY_WELL_KNOWN_BASE,
  MemorySafetyPolicyCache,
  SafetyPolicyValidationError,
  SafetyPolicyHashMismatchError,
  SafetyPolicyDiscoveryError,
  SafetyPolicyDiscoveryNotFoundError,
  type LoadSafetyPolicyOptions,
  type DiscoverSafetyPolicyOptions,
  type SafetyPolicyPointer,
} from './safety-policy.js';

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
  discoverMap,
  discoverIndex,
  wellKnownMapUrl,
  wellKnownIndexUrl,
  WELL_KNOWN_BASE,
  MapDiscoveryError,
  MapDiscoveryNotFoundError,
  type MapPointer,
  type MapIndex,
  type DiscoverMapOptions,
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

// Latent modality (v0.3) — TypeScript twin of
// packages/python/src/codecai/server/latent_frame.py. Forward encoder +
// inverse decoder + msgpack codec for all 7 pipelines (raw / int8 / int4 /
// int8-adaptive / int4-adaptive / delta+int8 / delta+int4). Pin: spec/
// PIPELINES.md is the normative reference; conformance fixtures live at
// packages/bench/golden/pipelines/<name>/.
export {
  PIPELINE_NAMES,
  LatentStreamEncoder,
  LatentStreamDecoder,
  encodeLatentHeaderMsgpack,
  encodeLatentFrameMsgpack,
  decodeLatentHeaderMsgpack,
  decodeLatentFrameMsgpack,
  scalesToBytes,
  scalesFromBytes,
  packInt4LowFirst,
  unpackInt4LowFirst,
  computeScales,
  type PipelineName,
  type LatentDtype,
  type LatentStreamHeader,
  type LatentFrame,
  type LatentStreamEncoderOptions,
} from './latent-frame.js';
