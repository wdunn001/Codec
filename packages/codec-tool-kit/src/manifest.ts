/**
 * Codec tool manifest spec — the contract a bolt-on tool publishes so a
 * gateway (sglang, vLLM, MetaMCP, etc.) knows what it speaks and which
 * model token vocabularies it has pre-cached.
 *
 * The manifest is JSON. A tool ships exactly one of these alongside its
 * implementation. The gateway reads it once at registration time; after
 * that the only thing that crosses the wire is token IDs.
 */

/**
 * SHA-256 hex of the model's tokenizer.json (or equivalent vocab+merges
 * file). Used to verify a tool's pre-cached token IDs are valid for the
 * model the gateway is currently serving — if the hashes don't match,
 * the cache is stale and the tool falls back to text-mode (or refuses to
 * run, depending on policy).
 */
export type TokenizerHash = string;

/**
 * A model-specific block in the manifest. Each describes one (model,
 * tokenizer) pair the tool has pre-built caches for.
 */
export interface ModelBinding {
  /** Hugging Face model id, e.g. "Qwen/Qwen2.5-0.5B-Instruct". */
  modelId: string;
  /** SHA-256 of the tokenizer file used to build the cache. */
  tokenizerHash: TokenizerHash;
  /**
   * Path (relative to the manifest) of the precompiled cache file for
   * this model. The cache is whatever shape the tool's implementation
   * needs — for most tools it's a JSON array of "common response
   * fragments" mapped to their token-ID sequences for this model.
   */
  cacheFile: string;
}

/**
 * The full tool manifest. Lives at the root of every Codec tool package.
 */
export interface ToolManifest {
  /** Manifest schema version. Currently always "1". */
  schema: '1';
  /** Tool's stable name. Must be unique within a gateway's namespace. */
  name: string;
  /** Tool's package version (semver). */
  version: string;
  /** One-line human-readable description. Shown in tool catalogs. */
  description: string;
  /**
   * JSON-Schema for the tool's argument object. This is how the model
   * is told *what to call*. The schema text itself stays at the
   * gateway — only the resulting tool-call's argument *values* travel
   * as tokens to the tool.
   */
  argumentsSchema: object;
  /** Model bindings — at least one. */
  models: ModelBinding[];
  /** Optional: maintainer contact / repo URL. */
  homepage?: string;
}

/**
 * Validate a manifest object. Returns null if valid, otherwise an error
 * message describing the first thing that's wrong. Doesn't validate the
 * cache files (that's `loadCache`'s job).
 */
export function validateManifest(m: unknown): string | null {
  if (!m || typeof m !== 'object') return 'manifest must be an object';
  const obj = m as Record<string, unknown>;
  if (obj.schema !== '1') return `unsupported schema version: ${String(obj.schema)}`;
  if (typeof obj.name !== 'string' || !obj.name.length) return 'missing or empty `name`';
  if (typeof obj.version !== 'string') return 'missing `version`';
  if (typeof obj.description !== 'string') return 'missing `description`';
  if (!obj.argumentsSchema || typeof obj.argumentsSchema !== 'object')
    return 'missing or invalid `argumentsSchema`';
  if (!Array.isArray(obj.models) || obj.models.length === 0)
    return '`models` must be a non-empty array';
  for (let i = 0; i < obj.models.length; i++) {
    const mb = obj.models[i] as Record<string, unknown>;
    if (typeof mb.modelId !== 'string') return `models[${i}].modelId missing`;
    if (typeof mb.tokenizerHash !== 'string') return `models[${i}].tokenizerHash missing`;
    if (typeof mb.cacheFile !== 'string') return `models[${i}].cacheFile missing`;
    if (!/^[a-f0-9]{64}$/i.test(mb.tokenizerHash))
      return `models[${i}].tokenizerHash must be SHA-256 hex (64 chars)`;
  }
  return null;
}

/**
 * Look up the binding for a given model in a manifest. Returns null if
 * the manifest doesn't support that model — the gateway should then
 * either skip this tool, fall back to a text-mode call, or reject the
 * request, depending on its policy.
 */
export function findBinding(m: ToolManifest, modelId: string): ModelBinding | null {
  return m.models.find((b) => b.modelId === modelId) ?? null;
}
