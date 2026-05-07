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

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * IDs are lowercase ASCII matching `[a-z0-9._/-]+`. Slashes are preserved as
 * URL path separators. Anything outside that set is rejected — discovery is
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

// ── Pointer + index document shapes ───────────────────────────────────────────

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

// ── Errors ────────────────────────────────────────────────────────────────────

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

// ── Detection: pointer vs. inline map ─────────────────────────────────────────

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

// ── Public API ────────────────────────────────────────────────────────────────

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
