/**
 * @codecai/web: isomorphic tokenizer + detokenizer for the Codec binary
 * transport protocol.
 *
 * Loads per-model tokenizer dialect maps, tokenizes text at the edge before
 * transport, and detokenizes IDs to text only when a human is going to read
 * them. Agent-to-agent calls skip detokenization entirely: text never
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
 *   // send `ids` over the wire as msgpack/protobuf: never text.
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
  discoverZstdDict,
  wellKnownMapUrl,
  wellKnownIndexUrl,
  wellKnownDictUrl,
  WELL_KNOWN_BASE,
  MapDiscoveryError,
  MapDiscoveryNotFoundError,
  ZstdDictDiscoveryError,
  ZstdDictHashMismatchError,
  type MapPointer,
  type MapIndex,
  type DiscoverMapOptions,
  type DiscoverIndexOptions,
  type DiscoverZstdDictOptions,
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
  DEFAULT_REGION_CAP,
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

// Codec-Zstd-Dict client-side contract (v0.2+). Match a response's
// declared dict hash to a loaded dict before decompressing; fail fast on
// mismatch. See spec/versions/v0.4.md §Codec-Zstd-Dict response header.
export {
  hashZstdDict,
  selectZstdDictForResponse,
  CodecZstdDictError,
  type ResponseHeadersLike,
} from './compression.js';

// v0.4 version negotiation: opt-on, graceful-downgrade wire contract.
// See spec/versions/v0.4.md § Version Compatibility Signaling.
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
} from './version-signaling.js';

export {
  runPreTokProgram,
  type PreTokOp,
  type PreTokProgram,
} from './pretok-program.js';

// Latent modality (v0.3): TypeScript twin of
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

// Activation profile (v0.6+): additive to the latent modality above.
// Per-token transformer activations for legion's pipeline-split stage
// protocol (token-major [tokenCount x nEmbd], tokenCount varies per
// frame). Pin: spec/PIPELINES.md § Activation profile.
export {
  ActivationStreamEncoder,
  ActivationStreamDecoder,
  type LatentProfile,
  type ActivationStreamEncoderOptions,
  type ActivationFrameOptions,
  type ActivationFrameData,
} from './latent-frame.js';
