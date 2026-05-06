/**
 * Tokenizer map loading + caching.
 *
 * Loads a JSON map from a URL, optionally verifies it against a SHA-256 hash
 * (the form `READY` frames declare), and stores it in a pluggable cache. Maps
 * are immutable once published, so cache hits are always valid.
 *
 * The default cache is in-memory. Browsers can wrap the Cache API; Node can
 * back it with the filesystem; edge runtimes can use KV.
 */
import type { MapCache, TokenizerMap } from './types.js';

// ── Pluggable cache (default: in-memory) ──────────────────────────────────────

export class MemoryMapCache implements MapCache {
  private store = new Map<string, TokenizerMap>();
  async get(key: string): Promise<TokenizerMap | undefined> {
    return this.store.get(key);
  }
  async set(key: string, map: TokenizerMap): Promise<void> {
    this.store.set(key, map);
  }
}

const defaultCache: MapCache = new MemoryMapCache();

// ── Validation ────────────────────────────────────────────────────────────────
//
// Light shape check — we don't pull a full JSON-Schema validator into the wire
// path. The contract is small enough that a hand-written check is honest about
// what we actually require.

export class TokenizerMapValidationError extends Error {
  constructor(message: string) {
    super(`TokenizerMap validation failed: ${message}`);
    this.name = 'TokenizerMapValidationError';
  }
}

export function validateMap(value: unknown): asserts value is TokenizerMap {
  if (typeof value !== 'object' || value === null) {
    throw new TokenizerMapValidationError('not an object');
  }
  const m = value as Record<string, unknown>;
  if (typeof m.id !== 'string') throw new TokenizerMapValidationError('id must be a string');
  if (typeof m.version !== 'string')
    throw new TokenizerMapValidationError('version must be a string');
  if (typeof m.vocab_size !== 'number' || m.vocab_size < 1)
    throw new TokenizerMapValidationError('vocab_size must be a positive integer');
  // v2 maps have `vocab`; v1 maps have `tokens`. At least one is required.
  const hasVocab = typeof m.vocab === 'object' && m.vocab !== null;
  const hasTokens = typeof m.tokens === 'object' && m.tokens !== null;
  if (!hasVocab && !hasTokens) {
    throw new TokenizerMapValidationError('one of `vocab` (v2) or `tokens` (v1) is required');
  }
  if (m.encoder !== undefined && m.encoder !== 'byte_level' && m.encoder !== 'metaspace') {
    throw new TokenizerMapValidationError(
      `encoder must be "byte_level" or "metaspace" if present, got ${JSON.stringify(m.encoder)}`,
    );
  }
  if (m.merges !== undefined && !Array.isArray(m.merges)) {
    throw new TokenizerMapValidationError('merges must be an array of strings');
  }
  if (
    m.byte_fallback_start !== undefined &&
    (typeof m.byte_fallback_start !== 'number' || m.byte_fallback_start < 0)
  ) {
    throw new TokenizerMapValidationError('byte_fallback_start must be a non-negative integer');
  }
  if (
    m.byte_fallback_end !== undefined &&
    (typeof m.byte_fallback_end !== 'number' || m.byte_fallback_end < 0)
  ) {
    throw new TokenizerMapValidationError('byte_fallback_end must be a non-negative integer');
  }
  if (
    (m.byte_fallback_start === undefined) !==
    (m.byte_fallback_end === undefined)
  ) {
    throw new TokenizerMapValidationError(
      'byte_fallback_start and byte_fallback_end must both be set or both omitted'
    );
  }
}

// ── Hashing (SubtleCrypto — works in browser, Node 18+, Cloudflare, Deno) ─────

export class TokenizerMapHashMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`TokenizerMap hash mismatch.\n  expected: ${expected}\n  actual:   ${actual}`);
    this.name = 'TokenizerMapHashMismatchError';
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // globalThis.crypto.subtle is available everywhere we target.
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      '@codecai/web requires a SubtleCrypto implementation (Web Crypto API). ' +
        'Available in browsers, Node 18+, Cloudflare Workers, Deno.'
    );
  }
  const digest = await subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Parse a hash string in the form `sha256:<hex>` or just `<hex>`. */
function parseHash(hash: string): string {
  const colon = hash.indexOf(':');
  if (colon === -1) return hash.toLowerCase();
  const algo = hash.slice(0, colon).toLowerCase();
  if (algo !== 'sha256') {
    throw new Error(`Unsupported hash algorithm: ${algo} (only sha256 supported)`);
  }
  return hash.slice(colon + 1).toLowerCase();
}

// ── Loader ────────────────────────────────────────────────────────────────────

export interface LoadOptions {
  /** URL to fetch the map from. */
  url: string;
  /**
   * Optional SHA-256 hex digest to verify the fetched map against.
   * Accepts `sha256:<hex>` or bare `<hex>`. If omitted, no verification.
   */
  hash?: string;
  /** Pluggable cache. Defaults to a process-wide in-memory cache. */
  cache?: MapCache;
  /** AbortSignal for the fetch. */
  signal?: AbortSignal;
  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Cache key. Defaults to the URL plus hash. Override if you want to share
   * cached maps across URLs (e.g. CDN failover).
   */
  cacheKey?: string;
}

/**
 * Fetch, verify, and cache a tokenizer map. Cache hits skip the network.
 *
 *   const map = await loadMap({
 *     url: 'https://maps.codec.ai/llama-3.1-8b.json',
 *     hash: 'sha256:abcd…'
 *   });
 */
export async function loadMap(opts: LoadOptions): Promise<TokenizerMap> {
  const cache = opts.cache ?? defaultCache;
  const cacheKey = opts.cacheKey ?? `${opts.url}#${opts.hash ?? ''}`;

  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      '@codec/web: no global fetch available. Pass `fetchImpl` or upgrade to Node 18+.'
    );
  }

  const resp = await fetchImpl(opts.url, { signal: opts.signal });
  if (!resp.ok) {
    throw new Error(`Failed to fetch tokenizer map from ${opts.url}: HTTP ${resp.status}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());

  if (opts.hash) {
    const expected = parseHash(opts.hash);
    const actual = await sha256Hex(bytes);
    if (expected !== actual) throw new TokenizerMapHashMismatchError(expected, actual);
  }

  const text = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  validateMap(parsed);

  await cache.set(cacheKey, parsed);
  return parsed;
}

/** Construct a TokenizerMap directly from an object (useful for tests, embeds). */
export function makeMap(spec: TokenizerMap): TokenizerMap {
  validateMap(spec);
  return spec;
}
