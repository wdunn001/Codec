/**
 * Core leaf-mode implementation.
 *
 * An MCP tool author calls `makeMetaTokenizer({ mapUrl, mapHash })` once at
 * server startup, then `wrapToolCall(result, meta)` on every CallToolResult
 * before returning it. The wrapper inspects every `text` content block and
 * adds a sibling `_codec_meta` block carrying the tokenized IDs. A
 * Codec-aware gateway (metamcp) then detects pre-tokenized output and
 * bypasses its back-compat shim.
 *
 * Block-level shape: see metamcp `codec-content.ts` `hasExistingCodecMeta`:
 *
 *   { type: '_codec_meta', map_id: '<sha256:hex>', ids: number[] }
 *
 * Inserted next to (not in place of) the original `text` block.
 * Non-Codec-aware clients in the same namespace therefore see the
 * result they always have. The contract is additive: leaf-mode is invisible to legacy clients.
 */

import {
  loadMap,
  pickTokenizer,
  type Tokenizer,
  type TokenizerMap,
  type LoadOptions,
} from '@codecai/web';

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * MCP CallToolResult shape (subset). The full type lives in
 * `@modelcontextprotocol/sdk` but we don't depend on that: we only need to
 * read the content array.
 */
export interface CallToolResult {
  content: ContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

/** One content entry in a CallToolResult. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string;[k: string]: unknown }
  | { readonly type: 'image' | 'audio' | 'resource' | string;[k: string]: unknown };

/**
 * @deprecated Pre-v0.3.2 sibling-block shape. Replaced by per-block
 * `_meta['ai.codec/leaf-tokenization']` (see `CODEC_META_KEY` /
 * `CodecMetaPayload`). The MCP SDK rejects custom-typed content
 * blocks at the SERVER (not just the gateway). The sibling-block
 * design crashed time-server itself with -32602 as a result. Kept exported only
 * so the reader-side helper's type guards stay backwards compatible
 * with results emitted by older Codec-aware tools: new tools should
 * use `CODEC_META_KEY` / `CodecMetaPayload`.
 */
export interface CodecMetaBlock {
  readonly type: '_codec_meta';
  readonly map_id: string;
  readonly ids: readonly number[];
  readonly sibling_index?: number;
  readonly [k: string]: unknown;
}

/**
 * Loaded + ready-to-use meta tokenizer. Returned by `makeMetaTokenizer`,
 * passed to every `wrapToolCall` call. Cheap to construct multiple of (the
 * underlying map cache is shared via @codecai/web's `loadMap`).
 */
export interface MetaTokenizer {
  /** sha256 hash of the tokenizer map this instance is bound to. */
  readonly mapHash: string;

  /** Internal tokenizer reference: exposed for callers that want to skip
   *  the wrapToolCall convenience and emit blocks themselves. */
  readonly tokenizer: Tokenizer;

  /** Resolved TokenizerMap for special-token / vocab inspection. */
  readonly map: TokenizerMap;

  /** Encode text → token IDs. Equivalent to `tokenizer.encode(text)`. */
  encode(text: string): number[];
}

// ── Constructor ──────────────────────────────────────────────────────────────

export interface MakeMetaTokenizerOptions
  extends Pick<LoadOptions, 'cache' | 'fetchImpl' | 'signal'> {
  /** URL of the tokenizer map JSON. Must match what the gateway has loaded. */
  mapUrl: string;
  /** Expected sha256 hash. Verified against the fetched bytes. */
  mapHash: string;
  /** Override the cache key. Defaults to the URL plus hash. */
  cacheKey?: string;
}

/**
 * Resolve a tokenizer map and return a meta-tokenizer ready to wrap tool
 * results. Hash is normalised to the `sha256:<hex>` form the gateway-side
 * cache uses, even if the caller passed a bare hex digest.
 *
 *   const meta = await makeMetaTokenizer({
 *     mapUrl: 'https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json',
 *     mapHash: 'sha256:0549cbec…',
 *   });
 */
export async function makeMetaTokenizer(
  opts: MakeMetaTokenizerOptions,
): Promise<MetaTokenizer> {
  // Validate the hash shape BEFORE the network fetch: a malformed hash
  // should fail fast with the validation error. Otherwise it eventually
  // surfaces as "fetch failed" (which is what happens when loadMap's
  // hash-mismatch check fires AFTER the fetch). The test
  // `test/leaf.test.ts → rejects malformed hashes` enforces this contract.
  const normalisedHash = normaliseHash(opts.mapHash);
  const map = await loadMap({
    url: opts.mapUrl,
    hash: normalisedHash,
    cache: opts.cache,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    cacheKey: opts.cacheKey,
  });
  const tokenizer = pickTokenizer(map);
  return {
    mapHash: normalisedHash,
    tokenizer,
    map,
    encode: (text: string) => tokenizer.encode(text),
  };
}

function normaliseHash(input: string): string {
  if (input.startsWith('sha256:')) return input;
  if (/^[0-9a-f]{64}$/i.test(input)) return `sha256:${input.toLowerCase()}`;
  throw new Error(
    `mapHash must be 'sha256:<64 hex chars>' or a bare 64-char hex digest, got ${JSON.stringify(input)}`,
  );
}

// ── Wrapper ──────────────────────────────────────────────────────────────────

/**
 * The MCP-spec namespace key under which a Codec-aware tool stores its
 * pre-tokenized IDs on a TextContent block's `_meta` field.
 *
 * Per the MCP spec, every content block can carry a `_meta:
 * Record<string, unknown>` with namespaced application metadata. We use
 * a single, stable, reverse-DNS-style key that the gateway recognizes.
 *
 * Why per-block `_meta`: the original
 * v0.3 design used a `{ type: '_codec_meta', map_id, ids }` SIBLING
 * block in the content array. The MCP SDK's `ContentBlockSchema` is a
 * discriminated union over `text|image|audio|resource|resource_link`,
 * and the SDK validates outbound results in the SERVER (not just the
 * gateway): so a custom-typed block crashes the time-server itself
 * with -32602 before it ever leaves the process. The per-block `_meta`
 * field is a first-class MCP spec slot that the SDK passes through
 * without complaint, lets the codec metadata travel cleanly, and
 * survives across SDK versions that may add stricter validation.
 */
export const CODEC_META_KEY = 'ai.codec/leaf-tokenization' as const;

/** Per-block meta payload the gateway looks for. */
export interface CodecMetaPayload {
  /** sha256 of the canonical map JSON, prefixed with `sha256:`. */
  readonly map_id: string;
  /** Token IDs tokenized from the sibling text block by the tool. */
  readonly ids: readonly number[];
}

export interface WrapToolCallOptions {
  /**
   * Skip text blocks shorter than this many characters. Default 0 (wrap all).
   * Set to e.g. 32 to avoid the meta-block overhead on very short text where
   * the meta block costs more bytes than tokenization saves.
   */
  minTextLength?: number;
}

/**
 * Annotate every text block in `result.content` with a `_meta` field
 * carrying its Codec tokenization, when the block is at least
 * `minTextLength` characters. Returns a NEW result; the input is not
 * mutated.
 *
 * Wire shape (per text block):
 * ```ts
 * {
 *   type: 'text',
 *   text: '<original text>',
 *   _meta: {
 *     'ai.codec/leaf-tokenization': {
 *       map_id: 'sha256:...',
 *       ids: [123, 456, ...],
 *     }
 *   }
 * }
 * ```
 *
 * Idempotent: if the text block already has a matching tokenization
 * under the same `map_id`, nothing is added: running this twice
 * produces the same tree as once.
 */
export function wrapToolCall(
  result: CallToolResult,
  meta: MetaTokenizer,
  options: WrapToolCallOptions = {},
): CallToolResult {
  const minLen = options.minTextLength ?? 0;
  const newContent: ContentBlock[] = [];

  for (const block of result.content) {
    if (!isTextBlock(block)) {
      newContent.push(block);
      continue;
    }
    if (block.text.length < minLen) {
      newContent.push(block);
      continue;
    }

    // Idempotence: if a matching tokenization is already attached for the
    // same map_id, leave the block untouched.
    const existing = readCodecMetaFromBlock(block);
    if (existing && existing.map_id === meta.mapHash) {
      newContent.push(block);
      continue;
    }

    const ids = meta.encode(block.text);
    const existingMeta =
      (block as { _meta?: Record<string, unknown> })._meta ?? {};
    const augmented = {
      ...block,
      _meta: {
        ...existingMeta,
        [CODEC_META_KEY]: { map_id: meta.mapHash, ids } satisfies CodecMetaPayload,
      },
    };
    newContent.push(augmented as ContentBlock);
  }

  return { ...result, content: newContent };
}

// ── Type guards ──────────────────────────────────────────────────────────────

function isTextBlock(b: unknown): b is { type: 'text'; text: string; _meta?: Record<string, unknown> } {
  return (
    typeof b === 'object' && b !== null &&
    (b as Record<string, unknown>).type === 'text' &&
    typeof (b as Record<string, unknown>).text === 'string'
  );
}

function isCodecMetaPayload(p: unknown): p is CodecMetaPayload {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.map_id === 'string' && Array.isArray(o.ids);
}

/**
 * Read the Codec tokenization off a single content block, if present.
 * Returns `null` if the block isn't a text block, doesn't have `_meta`,
 * or doesn't carry a valid Codec payload.
 */
export function readCodecMetaFromBlock(
  block: unknown,
): CodecMetaPayload | null {
  if (typeof block !== 'object' || block === null) return null;
  const meta = (block as { _meta?: unknown })._meta;
  if (typeof meta !== 'object' || meta === null) return null;
  const payload = (meta as Record<string, unknown>)[CODEC_META_KEY];
  return isCodecMetaPayload(payload) ? payload : null;
}

/**
 * Build a fresh text content block with a Codec tokenization attached.
 * Convenience for callers that build their own content arrays outside
 * of the `wrapToolCall` flow.
 */
export function buildMetaBlock(
  text: string,
  meta: MetaTokenizer,
): { type: 'text'; text: string; _meta: { [K in typeof CODEC_META_KEY]: CodecMetaPayload } } {
  return {
    type: 'text',
    text,
    _meta: {
      [CODEC_META_KEY]: { map_id: meta.mapHash, ids: meta.encode(text) } as CodecMetaPayload,
    } as { [K in typeof CODEC_META_KEY]: CodecMetaPayload },
  };
}
