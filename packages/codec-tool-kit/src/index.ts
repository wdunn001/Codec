/**
 * codec-tool-kit — build Codec-native tools as bolt-ons.
 *
 * The architectural premise: tools should be independently versioned,
 * deployed, and authored, but speak token IDs natively when the model
 * is one they've pre-built a cache for. The gateway (sglang, vLLM,
 * llama.cpp, MetaMCP) stays a pure token router; the tokenization
 * work is done once at the tool's build time, not on every call.
 *
 * Public surface:
 *   - ToolManifest, validateManifest, findBinding (the contract)
 *   - CodecTool, CodecToolCall, CodecToolResult (the runtime interface)
 *   - precache, renderTemplate, verifyCache (the build-time helper)
 *
 * Tools that ship pre-cached responses for common models pay zero
 * tokenization cost on the hot path — the runtime is a hashtable
 * lookup. Tools without a binding for the active model fall back to
 * text-mode and the gateway tokenizes the result.
 */

export type {
  TokenizerHash,
  ModelBinding,
  ToolManifest,
} from './manifest.js';

export {
  validateManifest,
  findBinding,
} from './manifest.js';

export type {
  CodecToolCall,
  CodecToolResult,
  CodecTool,
} from './tool.js';

export {
  tokensResult,
  textResult,
  errorResult,
} from './tool.js';

export type {
  Tokenizer,
  Fragment,
  ToolCache,
  StaticEntry,
  TemplateEntry,
} from './precache.js';

export {
  precache,
  renderTemplate,
  verifyCache,
} from './precache.js';
