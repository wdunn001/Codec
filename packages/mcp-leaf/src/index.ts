/**
 * @codecai/mcp-leaf: MCP-tool-author-side helper for the Codec leaf-mode
 * contract.
 *
 * The architectural target in spec/PROTOCOL.md § Tool-call calling
 * conventions in the map: the tool that produces text knows the tokenizer,
 * so it tokenizes the text once and ships token IDs alongside the original
 * text. A Codec-aware gateway (metamcp) detects the pre-tokenized output
 * and skips its back-compat shim, becoming a transparent ID pipe for the
 * hop. Non-Codec-aware clients on the same namespace see the original text
 * and behave identically to today.
 *
 * Quick start:
 *
 *   import { makeMetaTokenizer, wrapToolCall } from '@codecai/mcp-leaf';
 *
 *   const meta = await makeMetaTokenizer({
 *     mapUrl:  'https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json',
 *     mapHash: 'sha256:62c2f94fcbdb9b49d51632314e64aa65894496bc39751cb90866049657a262ad',
 *   });
 *
 *   // …in your tool handler:
 *   return wrapToolCall(originalResult, meta);
 *
 * The wrapper is idempotent. Running it twice on the same result produces
 * the same tree as running it once.
 */
export {
  makeMetaTokenizer,
  wrapToolCall,
  buildMetaBlock,
  readCodecMetaFromBlock,
  CODEC_META_KEY,
  type CallToolResult,
  type ContentBlock,
  type CodecMetaBlock,
  type CodecMetaPayload,
  type MetaTokenizer,
  type MakeMetaTokenizerOptions,
  type WrapToolCallOptions,
} from './leaf.js';

// Reader side: symmetric helper for clients receiving Codec-aware results.
// See `reader.ts` for usage examples.
export {
  hasCodecMeta,
  findCodecMeta,
  readCodecMeta,
  takeIds,
  stripCodecMeta,
  CodecMetaMapMismatchError,
  type CodecMetaPairing,
} from './reader.js';

// v0.4 version-negotiation primitives re-exported for convenience:
// MCP tool authors that already use @codecai/mcp-leaf get a single
// import surface for the wire-level negotiation too. Canonical impl
// in @codecai/web.
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
