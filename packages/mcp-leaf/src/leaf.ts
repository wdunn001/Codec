/**
 * Core leaf-mode implementation.
 *
 * An MCP tool author calls `makeMetaTokenizer({ mapUrl, mapHash })` once at
 * server startup, then `wrapToolCall(result, meta)` on every CallToolResult
 * before returning it. The wrapper inspects every `text` content block and
 * adds a sibling `_codec_meta` block carrying the tokenized IDs, so a
 * Codec-aware gateway (metamcp) detects pre-tokenized output and bypasses
 * its back-compat shim.
 *
 * Block-level shape — see metamcp `codec-content.ts` `hasExistingCodecMeta`:
 *
 *   { type: '_codec_meta', map_id: '<sha256:hex>', ids: number[] }
 *
 * Inserted next to (not in place of) the original `text` block, so
 * non-Codec-aware clients in the same namespace see the result they always
 * have. The contract is additive — leaf-mode is invisible to legacy clients.
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
 * `@modelcontextprotocol/sdk` but we don't depend on that — we only need to
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

/** Codec-aware gateways look for these blocks alongside text content. */
export interface CodecMetaBlock {
  readonly type: '_codec_meta';
  /** sha256 hex of the tokenizer map (matches gateway-side cache key). */
  readonly map_id: string;
  /** Token IDs for the sibling `text` block. */
  readonly ids: readonly number[];
  /** Optional 1-based sibling index (the `text` block this meta refers to). */
  readonly sibling_index?: number;
  /** Index signature kept symmetric with ContentBlock so meta blocks can sit
   *  alongside the existing union members in `result.content`. */
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

  /** Internal tokenizer reference — exposed for callers that want to skip
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
  const map = await loadMap({
    url: opts.mapUrl,
    hash: opts.mapHash,
    cache: opts.cache,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    cacheKey: opts.cacheKey,
  });
  const tokenizer = pickTokenizer(map);
  const normalisedHash = normaliseHash(opts.mapHash);
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

export interface WrapToolCallOptions {
  /**
   * Skip text blocks shorter than this many characters. Default 0 (wrap all).
   * Set to e.g. 32 to avoid the meta-block overhead on very short text where
   * the meta block costs more bytes than tokenization saves.
   */
  minTextLength?: number;
}

/**
 * Add `_codec_meta` siblings to every text block in `result.content` whose
 * length is at least `minTextLength` (default 0). Returns a NEW result; the
 * input is not mutated.
 *
 * Idempotent: if a content block is already `_codec_meta`, it's left alone.
 * If a text block already has a `_codec_meta` sibling immediately following
 * it (same map_id), nothing is added — running this twice produces the same
 * tree as running it once.
 */
export function wrapToolCall(
  result: CallToolResult,
  meta: MetaTokenizer,
  options: WrapToolCallOptions = {},
): CallToolResult {
  const minLen = options.minTextLength ?? 0;
  const newContent: ContentBlock[] = [];

  for (let i = 0; i < result.content.length; i++) {
    const block = result.content[i]!;
    newContent.push(block);

    if (!isTextBlock(block)) continue;
    if (block.text.length < minLen) continue;

    // Idempotence: if the next block is a matching meta sibling, don't add
    // another. Tools that wrap twice (e.g. retry with a different layer)
    // produce the same tree as wrapping once.
    const next = result.content[i + 1];
    if (
      isCodecMetaBlock(next) &&
      next.map_id === meta.mapHash &&
      next.sibling_index === undefined
    ) {
      continue;
    }

    const ids = meta.encode(block.text);
    const metaBlock: CodecMetaBlock = {
      type: '_codec_meta',
      map_id: meta.mapHash,
      ids,
    };
    newContent.push(metaBlock);
  }

  return { ...result, content: newContent };
}

// ── Type guards ──────────────────────────────────────────────────────────────

function isTextBlock(b: unknown): b is { type: 'text'; text: string } {
  return (
    typeof b === 'object' && b !== null &&
    (b as Record<string, unknown>).type === 'text' &&
    typeof (b as Record<string, unknown>).text === 'string'
  );
}

function isCodecMetaBlock(b: unknown): b is CodecMetaBlock {
  if (typeof b !== 'object' || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    o.type === '_codec_meta' &&
    typeof o.map_id === 'string' &&
    Array.isArray(o.ids)
  );
}

/**
 * Standalone factory that returns a `_codec_meta` block for a given text +
 * meta tokenizer. Useful for callers that build their own content arrays
 * outside of the wrapToolCall convenience.
 */
export function buildMetaBlock(
  text: string,
  meta: MetaTokenizer,
): CodecMetaBlock {
  return {
    type: '_codec_meta',
    map_id: meta.mapHash,
    ids: meta.encode(text),
  };
}
