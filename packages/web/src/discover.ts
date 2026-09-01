/**
 * Map discovery via the `.well-known/codec/` convention.
 *
 * Given an origin and a map ID, fetch the per-map document at
 *
 *     <origin>/.well-known/codec/maps/<id>.json
 *
 * and return a verified TokenizerMap. The document is one of two shapes
 * (the loader auto-detects):
 *
 *   - Pointer: `{ id, url, hash }` referencing the actual map on a CDN.
 *   - Inline:  the full TokenizerMap directly.
 *
 * See `spec/WELL_KNOWN_DISCOVERY.md` for the full convention.
 */
// NOTE: discovery/pointer/map fetches are static-artifact requests and MUST
// carry no custom headers (codec-client-version forces a CORS preflight that
// third-party CDN hosts reject). Integrity comes from pointer hash checks.
import type { MapCache, TokenizerMap } from './types.js';
import { loadMap, validateMap } from './map.js';

/** Fixed base path under which Codec discovery documents live. */
export const WELL_KNOWN_BASE = '/.well-known/codec';

/** Per-map document URL for an origin + id. */
export function wellKnownMapUrl(origin: string, id: string): string {
  return `${stripTrailingSlash(origin)}${WELL_KNOWN_BASE}/maps/${encodeMapId(id)}.json`;
}

/** Index document URL for an origin. */
export function wellKnownIndexUrl(origin: string): string {
  return `${stripTrailingSlash(origin)}${WELL_KNOWN_BASE}/index.json`;
}

const DICT_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Per-dict document URL for an origin + sha256 hash (v0.5+).
 *
 * Accepts either `sha256:<hex>` or bare `<hex>`. Returns
 * `<origin>/.well-known/codec/dicts/<sha256-hex>.zstd`.
 */
export function wellKnownDictUrl(origin: string, hash: string): string {
  const hex = parseDictHash(hash);
  return `${stripTrailingSlash(origin)}${WELL_KNOWN_BASE}/dicts/${hex}.zstd`;
}

function parseDictHash(hashStr: string): string {
  let s = hashStr.trim();
  if (s.startsWith('sha256:')) s = s.slice('sha256:'.length);
  s = s.toLowerCase();
  if (!DICT_HASH_RE.test(s)) {
    throw new ZstdDictDiscoveryError(
      `Invalid dict hash ${JSON.stringify(hashStr)}: expected 'sha256:<64 hex>' or '<64 hex>'`,
    );
  }
  return s;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      '@codecai/web requires a SubtleCrypto implementation (Web Crypto API). ' +
        'Available in browsers, Node 18+, Cloudflare Workers, Deno.',
    );
  }
  const digest = await subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * IDs are lowercase ASCII matching `[a-z0-9._/-]+`. Slashes are preserved as
 * URL path separators. Anything outside that set is rejected â€” discovery is
 * a public, cacheable surface and we don't want exotic encodings creating
 * cache-poisoning ambiguity.
 */
function encodeMapId(id: string): string {
  if (!/^[a-z0-9._/-]+$/.test(id)) {
    throw new MapDiscoveryError(
      `Invalid map id ${JSON.stringify(id)}: must match [a-z0-9._/-]+`,
    );
  }
  if (id.includes('..') || id.startsWith('/') || id.endsWith('/')) {
    throw new MapDiscoveryError(
      `Invalid map id ${JSON.stringify(id)}: path traversal or empty segment`,
    );
  }
  return id;
}

// â”€â”€ Pointer + index document shapes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Pointer document: small file at `.well-known/codec/maps/<id>.json` (Form A). */
export interface MapPointer {
  readonly id: string;
  readonly url: string;
  readonly hash: string;
  readonly published_at?: string;
}

/** Index document: enumerates every map an origin publishes. */
export interface MapIndex {
  readonly codec_version: string;
  readonly maps: ReadonlyArray<MapPointer>;
}

// â”€â”€ Errors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class MapDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapDiscoveryError';
  }
}

export class MapDiscoveryNotFoundError extends MapDiscoveryError {
  constructor(url: string, status: number) {
    super(`No map document at ${url} (HTTP ${status})`);
    this.name = 'MapDiscoveryNotFoundError';
  }
}

/**
 * Raised when `.well-known/codec/dicts/<hex>.zstd` discovery fails (v0.5+).
 *
 * Covers: 404 from the origin, hash mismatch between fetched bytes and the
 * URL's path component, or malformed hash input.
 *
 * The dict-discovery surface is hard-fail by design â€” see
 * `spec/WELL_KNOWN_DISCOVERY.md Â§ Resolution failures`. Silent fallback to
 * identity bytes is what motivated v0.5 in the first place (the v0.4.1
 * sglang COPY-dicts regression).
 */
export class ZstdDictDiscoveryError extends Error {
  readonly url?: string;
  constructor(message: string, url?: string) {
    super(message);
    this.name = 'ZstdDictDiscoveryError';
    this.url = url;
  }
}

export class ZstdDictHashMismatchError extends ZstdDictDiscoveryError {
  readonly expected: string;
  readonly actual: string;
  constructor(url: string, expected: string, actual: string) {
    super(
      `Zstd dict hash mismatch at ${url}\n  expected: ${expected}\n  actual:   ${actual}`,
      url,
    );
    this.name = 'ZstdDictHashMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

// â”€â”€ Detection: pointer vs. inline map â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isPointerShape(obj: unknown): obj is MapPointer {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.url === 'string' &&
    typeof o.hash === 'string' &&
    // Inline maps always carry vocab/tokens; pointers never do.
    o.vocab === undefined &&
    o.tokens === undefined
  );
}

function validatePointer(obj: MapPointer, expectedId: string): void {
  if (obj.id !== expectedId) {
    throw new MapDiscoveryError(
      `Pointer id ${JSON.stringify(obj.id)} does not match requested id ${JSON.stringify(expectedId)}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(obj.url);
  } catch {
    throw new MapDiscoveryError(`Pointer url is not a valid URL: ${obj.url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new MapDiscoveryError(
      `Pointer url must be http(s): got ${parsed.protocol}`,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(obj.hash)) {
    throw new MapDiscoveryError(
      `Pointer hash must be sha256:<64 hex chars>: got ${obj.hash}`,
    );
  }
}

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DiscoverMapOptions {
  /** HTTPS origin of the maintainer publishing the map (e.g. `https://qwen.io`). */
  origin: string;

  /** Codec map ID (e.g. `qwen/qwen2`). */
  id: string;

  /** Pluggable cache, shared with `loadMap`. */
  cache?: MapCache;

  /** AbortSignal forwarded to all underlying fetches. */
  signal?: AbortSignal;

  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve a tokenizer map via the `.well-known/codec/` convention.
 *
 * Fetches `<origin>/.well-known/codec/maps/<id>.json`, then either follows
 * the pointer's `url` + verifies its `hash` (Form A), or validates and
 * returns the inline map directly (Form B).
 *
 *   const map = await discoverMap({
 *     origin: 'https://qwen.io',
 *     id: 'qwen/qwen2',
 *   });
 *
 * Throws `MapDiscoveryNotFoundError` for 404, `MapDiscoveryError` for
 * malformed pointers, and `TokenizerMapHashMismatchError` if the CDN bytes
 * don't match the pointer hash.
 */
export async function discoverMap(opts: DiscoverMapOptions): Promise<TokenizerMap> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new MapDiscoveryError(
      '@codecai/web: no global fetch available. Pass `fetchImpl` or upgrade to Node 18+.',
    );
  }

  const url = wellKnownMapUrl(opts.origin, opts.id);
  const resp = await fetchImpl(url, { signal: opts.signal });
  if (resp.status === 404) {
    throw new MapDiscoveryNotFoundError(url, resp.status);
  }
  if (!resp.ok) {
    throw new MapDiscoveryError(
      `Failed to fetch ${url}: HTTP ${resp.status}`,
    );
  }

  const parsed: unknown = await resp.json();
  if (isPointerShape(parsed)) {
    validatePointer(parsed, opts.id);
    return loadMap({
      url: parsed.url,
      hash: parsed.hash,
      cache: opts.cache,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
      cacheKey: `well-known:${opts.origin}#${opts.id}#${parsed.hash}`,
    });
  }

  // Otherwise: inline TokenizerMap. Validate, sanity-check id, return.
  validateMap(parsed);
  if (parsed.id !== opts.id) {
    throw new MapDiscoveryError(
      `Inline map id ${JSON.stringify(parsed.id)} does not match requested id ${JSON.stringify(opts.id)}`,
    );
  }
  return parsed;
}

export interface DiscoverZstdDictOptions {
  /** HTTPS origin serving the dict (e.g. `https://codec.example`). */
  origin: string;
  /** SHA-256 hash, as `sha256:<hex>` or bare `<hex>`. Used as the URL path component AND as the verifier. */
  hash: string;
  /** AbortSignal forwarded to the underlying fetch. */
  signal?: AbortSignal;
  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve a zstd dictionary via `.well-known/codec/dicts/<hex>.zstd` (v0.5+).
 *
 * Fetches `<origin>/.well-known/codec/dicts/<sha256-hex>.zstd`, verifies the
 * fetched bytes hash to `<hex>`, returns the raw dict bytes. The URL is
 * derived deterministically from the hash â€” there is no mutable per-id form
 * for dictionaries.
 *
 *   const dictBytes = await discoverZstdDict({
 *     origin: 'https://codec.example',
 *     hash:   'sha256:abc123â€¦',  // typically from the tokenizer map's
 *                                // zstd_dictionaries[] entry, or a
 *                                // cohort registry
 *   });
 *
 * Throws `ZstdDictDiscoveryError` for 404 / malformed hash.
 * Throws `ZstdDictHashMismatchError` for byte-tampering (origin served wrong
 * bytes â€” never trust them).
 */
export async function discoverZstdDict(opts: DiscoverZstdDictOptions): Promise<Uint8Array> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new ZstdDictDiscoveryError(
      '@codecai/web: no global fetch available. Pass `fetchImpl` or upgrade to Node 18+.',
    );
  }

  // Validate + normalise hash up front so we don't make a wasted HTTP request.
  const expectedHex = parseDictHash(opts.hash);
  const url = wellKnownDictUrl(opts.origin, opts.hash);

  const resp = await fetchImpl(url, { signal: opts.signal });
  if (resp.status === 404) {
    throw new ZstdDictDiscoveryError(`No zstd dict at ${url} (HTTP 404)`, url);
  }
  if (!resp.ok) {
    throw new ZstdDictDiscoveryError(`Failed to fetch ${url}: HTTP ${resp.status}`, url);
  }
  const body = new Uint8Array(await resp.arrayBuffer());
  const actualHex = await sha256HexBytes(body);
  if (actualHex !== expectedHex) {
    throw new ZstdDictHashMismatchError(url, expectedHex, actualHex);
  }
  return body;
}

export interface DiscoverIndexOptions {
  origin: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the optional `.well-known/codec/index.json` directory document for
 * an origin. Returns the parsed index; throws `MapDiscoveryNotFoundError`
 * if the origin doesn't publish one.
 */
export async function discoverIndex(opts: DiscoverIndexOptions): Promise<MapIndex> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new MapDiscoveryError(
      '@codecai/web: no global fetch available. Pass `fetchImpl` or upgrade to Node 18+.',
    );
  }

  const url = wellKnownIndexUrl(opts.origin);
  const resp = await fetchImpl(url, { signal: opts.signal });
  if (resp.status === 404) {
    throw new MapDiscoveryNotFoundError(url, resp.status);
  }
  if (!resp.ok) {
    throw new MapDiscoveryError(`Failed to fetch ${url}: HTTP ${resp.status}`);
  }

  const parsed: unknown = await resp.json();
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as MapIndex).codec_version !== 'string' ||
    !Array.isArray((parsed as MapIndex).maps)
  ) {
    throw new MapDiscoveryError(`Index at ${url} is not a valid MapIndex document`);
  }
  for (const entry of (parsed as MapIndex).maps) {
    if (!isPointerShape(entry)) {
      throw new MapDiscoveryError(
        `Index entry at ${url} is missing required pointer fields`,
      );
    }
  }
  return parsed as MapIndex;
}
