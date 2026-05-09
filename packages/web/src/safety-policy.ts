/**
 * Safety-policy descriptor loading, validation, and discovery.
 *
 * Mirrors the tokenizer-map (`map.ts` / `discover.ts`) shape: validate, hash,
 * fetch, cache, well-known. A `SafetyPolicyDescriptor` is the *sanitized,
 * publishable* document an operator publishes at
 * `.well-known/codec/policies/<id>.json` (or `<hash>.json`) — never the
 * full operator-internal config. See `spec/safety-policy.schema.json`.
 *
 * Used by clients that received `safety_policy_id` + `safety_policy_hash`
 * in `READY` and want to fetch and surface what the server is enforcing.
 */
import type {
  SafetyPolicyCache,
  SafetyPolicyCategory,
  SafetyPolicyDescriptor,
} from './types.js';

// ── Pluggable cache (default: in-memory) ──────────────────────────────────────

export class MemorySafetyPolicyCache implements SafetyPolicyCache {
  private store = new Map<string, SafetyPolicyDescriptor>();
  async get(key: string): Promise<SafetyPolicyDescriptor | undefined> {
    return this.store.get(key);
  }
  async set(key: string, descriptor: SafetyPolicyDescriptor): Promise<void> {
    this.store.set(key, descriptor);
  }
}

const defaultCache: SafetyPolicyCache = new MemorySafetyPolicyCache();

// ── Validation ────────────────────────────────────────────────────────────────
//
// Hand-written shape check, matching `validateMap` in map.ts. We don't pull
// a JSON-Schema validator into the wire path; the contract is small enough
// that an explicit check is honest about what we actually require.

export class SafetyPolicyValidationError extends Error {
  constructor(message: string) {
    super(`SafetyPolicyDescriptor validation failed: ${message}`);
    this.name = 'SafetyPolicyValidationError';
  }
}

const VALID_ACTIONS = new Set<SafetyPolicyCategory['action']>([
  'stop',
  'redact',
  'regenerate',
  'flag',
]);

const VALID_HOSTS = new Set(['server', 'client', 'both']);

const VALID_ENGINE_FEATURES = new Set([
  'logits_processor',
  'hidden_states',
  'sampling_chain',
]);

const CATEGORY_NAME_RE = /^[a-z0-9_-]+$/;

export function validateSafetyPolicy(
  value: unknown,
): asserts value is SafetyPolicyDescriptor {
  if (typeof value !== 'object' || value === null) {
    throw new SafetyPolicyValidationError('not an object');
  }
  const p = value as Record<string, unknown>;

  if (typeof p.id !== 'string' || p.id.length === 0) {
    throw new SafetyPolicyValidationError('id must be a non-empty string');
  }
  if (typeof p.version !== 'string') {
    throw new SafetyPolicyValidationError('version must be a string');
  }

  if (!Array.isArray(p.tokenizers) || p.tokenizers.length === 0) {
    throw new SafetyPolicyValidationError(
      'tokenizers must be a non-empty array of tokenizer ids',
    );
  }
  for (const t of p.tokenizers) {
    if (typeof t !== 'string') {
      throw new SafetyPolicyValidationError(
        'tokenizers entries must be strings',
      );
    }
  }

  if (!Array.isArray(p.categories) || p.categories.length === 0) {
    throw new SafetyPolicyValidationError(
      'categories must be a non-empty array',
    );
  }
  for (const c of p.categories) {
    if (typeof c !== 'object' || c === null) {
      throw new SafetyPolicyValidationError('category entry must be an object');
    }
    const cat = c as Record<string, unknown>;
    if (typeof cat.name !== 'string' || !CATEGORY_NAME_RE.test(cat.name)) {
      throw new SafetyPolicyValidationError(
        `category.name must match ${CATEGORY_NAME_RE} (got ${JSON.stringify(cat.name)})`,
      );
    }
    if (
      typeof cat.action !== 'string' ||
      !VALID_ACTIONS.has(cat.action as SafetyPolicyCategory['action'])
    ) {
      throw new SafetyPolicyValidationError(
        `category.action for ${JSON.stringify(cat.name)} must be one of stop|redact|regenerate|flag`,
      );
    }
    if (cat.description !== undefined && typeof cat.description !== 'string') {
      throw new SafetyPolicyValidationError(
        `category.description for ${JSON.stringify(cat.name)} must be a string when present`,
      );
    }
  }

  if (typeof p.classifier !== 'object' || p.classifier === null) {
    throw new SafetyPolicyValidationError('classifier must be an object');
  }
  const cls = p.classifier as Record<string, unknown>;
  if (typeof cls.family !== 'string' || cls.family.length === 0) {
    throw new SafetyPolicyValidationError(
      'classifier.family must be a non-empty string',
    );
  }
  if (cls.host !== undefined && (typeof cls.host !== 'string' || !VALID_HOSTS.has(cls.host))) {
    throw new SafetyPolicyValidationError(
      `classifier.host must be one of server|client|both (got ${JSON.stringify(cls.host)})`,
    );
  }
  if (cls.requires_engine_features !== undefined) {
    if (!Array.isArray(cls.requires_engine_features)) {
      throw new SafetyPolicyValidationError(
        'classifier.requires_engine_features must be an array',
      );
    }
    for (const f of cls.requires_engine_features) {
      if (typeof f !== 'string' || !VALID_ENGINE_FEATURES.has(f)) {
        throw new SafetyPolicyValidationError(
          `classifier.requires_engine_features entry must be one of logits_processor|hidden_states|sampling_chain (got ${JSON.stringify(f)})`,
        );
      }
    }
  }

  if (p.rules_summary !== undefined) {
    if (typeof p.rules_summary !== 'object' || p.rules_summary === null) {
      throw new SafetyPolicyValidationError('rules_summary must be an object when present');
    }
    const rs = p.rules_summary as Record<string, unknown>;
    for (const key of [
      'banned_token_id_count',
      'regex_pattern_count',
      'grammar_constraint_count',
      'multi_token_pattern_count',
    ] as const) {
      const val = rs[key];
      if (val !== undefined && (typeof val !== 'number' || val < 0 || !Number.isInteger(val))) {
        throw new SafetyPolicyValidationError(
          `rules_summary.${key} must be a non-negative integer when present`,
        );
      }
    }
  }

  if (p.client_hooks !== undefined) {
    if (typeof p.client_hooks !== 'object' || p.client_hooks === null) {
      throw new SafetyPolicyValidationError('client_hooks must be an object when present');
    }
    const ch = p.client_hooks as Record<string, unknown>;
    if (ch.prefilter_categories !== undefined) {
      if (!Array.isArray(ch.prefilter_categories)) {
        throw new SafetyPolicyValidationError(
          'client_hooks.prefilter_categories must be an array of strings',
        );
      }
      for (const c of ch.prefilter_categories) {
        if (typeof c !== 'string') {
          throw new SafetyPolicyValidationError(
            'client_hooks.prefilter_categories entries must be strings',
          );
        }
      }
    }
    if (
      ch.client_classifier_family !== undefined &&
      typeof ch.client_classifier_family !== 'string'
    ) {
      throw new SafetyPolicyValidationError(
        'client_hooks.client_classifier_family must be a string when present',
      );
    }
  }

  if (p.category_registry !== undefined && typeof p.category_registry !== 'string') {
    throw new SafetyPolicyValidationError(
      'category_registry must be a string when present',
    );
  }

  if (p.published_at !== undefined && typeof p.published_at !== 'string') {
    throw new SafetyPolicyValidationError(
      'published_at must be an ISO 8601 string when present',
    );
  }

  if (p.publisher !== undefined) {
    if (typeof p.publisher !== 'object' || p.publisher === null) {
      throw new SafetyPolicyValidationError('publisher must be an object when present');
    }
    const pub = p.publisher as Record<string, unknown>;
    for (const key of ['name', 'url', 'contact'] as const) {
      if (pub[key] !== undefined && typeof pub[key] !== 'string') {
        throw new SafetyPolicyValidationError(
          `publisher.${key} must be a string when present`,
        );
      }
    }
  }
}

// ── Hashing ──────────────────────────────────────────────────────────────────
//
// The published descriptor is content-addressed; the hash of its canonical
// JSON serialization is what `READY.safety_policy_hash` carries. We hash the
// pretty-printed JSON used at publish time (matching `well-known` output) so
// the hash a client receives matches what `policies hash` produced.

export class SafetyPolicyHashMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `SafetyPolicyDescriptor hash mismatch.\n  expected: ${expected}\n  actual:   ${actual}`,
    );
    this.name = 'SafetyPolicyHashMismatchError';
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      '@codecai/web requires a SubtleCrypto implementation (Web Crypto API). ' +
        'Available in browsers, Node 18+, Cloudflare Workers, Deno.',
    );
  }
  const digest = await subtle.digest(
    'SHA-256',
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function parseHash(hash: string): string {
  const colon = hash.indexOf(':');
  if (colon === -1) return hash.toLowerCase();
  const algo = hash.slice(0, colon).toLowerCase();
  if (algo !== 'sha256') {
    throw new Error(`Unsupported hash algorithm: ${algo} (only sha256 supported)`);
  }
  return hash.slice(colon + 1).toLowerCase();
}

/**
 * Canonical sha256 hash of a safety-policy descriptor. Matches what the
 * `codecai-maps policies hash` CLI emits and what servers should publish
 * in `READY.safety_policy_hash`.
 */
export async function hashSafetyPolicy(
  descriptor: SafetyPolicyDescriptor,
): Promise<string> {
  validateSafetyPolicy(descriptor);
  const canonical = JSON.stringify(descriptor, null, 2) + '\n';
  const bytes = new TextEncoder().encode(canonical);
  return `sha256:${await sha256Hex(bytes)}`;
}

// ── Loader ───────────────────────────────────────────────────────────────────

export interface LoadSafetyPolicyOptions {
  url: string;
  /** Expected hash (`sha256:<hex>` or bare `<hex>`). Verified after fetch. */
  hash?: string;
  cache?: SafetyPolicyCache;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  cacheKey?: string;
}

export async function loadSafetyPolicy(
  opts: LoadSafetyPolicyOptions,
): Promise<SafetyPolicyDescriptor> {
  const cache = opts.cache ?? defaultCache;
  const cacheKey = opts.cacheKey ?? `${opts.url}#${opts.hash ?? ''}`;

  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      '@codecai/web: no global fetch available. Pass `fetchImpl` or upgrade to Node 18+.',
    );
  }

  const resp = await fetchImpl(opts.url, { signal: opts.signal });
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch safety policy from ${opts.url}: HTTP ${resp.status}`,
    );
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());

  if (opts.hash) {
    const expected = parseHash(opts.hash);
    const actual = await sha256Hex(bytes);
    if (expected !== actual) {
      throw new SafetyPolicyHashMismatchError(expected, actual);
    }
  }

  const text = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  validateSafetyPolicy(parsed);

  await cache.set(cacheKey, parsed);
  return parsed;
}

// ── Discovery ────────────────────────────────────────────────────────────────

export const POLICY_WELL_KNOWN_BASE = '/.well-known/codec/policies';

/** Per-policy URL by mutable id (e.g. `acme/strict-v3`). */
export function wellKnownPolicyUrl(origin: string, id: string): string {
  return `${stripTrailingSlash(origin)}${POLICY_WELL_KNOWN_BASE}/${encodePolicyId(id)}.json`;
}

/** Content-addressed URL by sha256 hex (no `sha256:` prefix). */
export function wellKnownPolicyHashUrl(origin: string, hashHex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hashHex)) {
    throw new SafetyPolicyDiscoveryError(
      `Invalid policy hash hex: must be 64-char lowercase hex (got ${JSON.stringify(hashHex)})`,
    );
  }
  return `${stripTrailingSlash(origin)}${POLICY_WELL_KNOWN_BASE}/sha256/${hashHex.toLowerCase()}.json`;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function encodePolicyId(id: string): string {
  if (!/^[a-z0-9._/-]+$/.test(id)) {
    throw new SafetyPolicyDiscoveryError(
      `Invalid policy id ${JSON.stringify(id)}: must match [a-z0-9._/-]+`,
    );
  }
  if (id.includes('..') || id.startsWith('/') || id.endsWith('/')) {
    throw new SafetyPolicyDiscoveryError(
      `Invalid policy id ${JSON.stringify(id)}: path traversal or empty segment`,
    );
  }
  return id;
}

/** Pointer document at `.well-known/codec/policies/<id>.json` (Form A). */
export interface SafetyPolicyPointer {
  readonly id: string;
  readonly url: string;
  readonly hash: string;
  readonly published_at?: string;
}

export class SafetyPolicyDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyPolicyDiscoveryError';
  }
}

export class SafetyPolicyDiscoveryNotFoundError extends SafetyPolicyDiscoveryError {
  constructor(url: string, status: number) {
    super(`No safety-policy document at ${url} (HTTP ${status})`);
    this.name = 'SafetyPolicyDiscoveryNotFoundError';
  }
}

function isPointerShape(obj: unknown): obj is SafetyPolicyPointer {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.url === 'string' &&
    typeof o.hash === 'string' &&
    // Inline descriptors always carry `categories`; pointers never do.
    o.categories === undefined
  );
}

function validatePointer(obj: SafetyPolicyPointer, expectedId: string): void {
  if (obj.id !== expectedId) {
    throw new SafetyPolicyDiscoveryError(
      `Pointer id ${JSON.stringify(obj.id)} does not match requested id ${JSON.stringify(expectedId)}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(obj.url);
  } catch {
    throw new SafetyPolicyDiscoveryError(
      `Pointer url is not a valid URL: ${obj.url}`,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SafetyPolicyDiscoveryError(
      `Pointer url must be http(s): got ${parsed.protocol}`,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(obj.hash)) {
    throw new SafetyPolicyDiscoveryError(
      `Pointer hash must be sha256:<64 hex chars>: got ${obj.hash}`,
    );
  }
}

export interface DiscoverSafetyPolicyOptions {
  /** HTTPS origin publishing the policy (e.g. `https://acme.example`). */
  origin: string;
  /** Codec policy id (e.g. `acme/strict-v3`). */
  id: string;
  /**
   * Optional content hash — if provided, the loader prefers the
   * content-addressed `.well-known/codec/policies/sha256/<hex>.json`
   * sibling and verifies the bytes match.
   */
  hash?: string;
  cache?: SafetyPolicyCache;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve a safety-policy descriptor via `.well-known/codec/policies/`.
 *
 * If `hash` is provided, fetches the immutable content-addressed sibling
 * `<origin>/.well-known/codec/policies/sha256/<hex>.json` and verifies the
 * bytes hash matches. Otherwise fetches the mutable per-id document and
 * follows a pointer if present.
 *
 *   const policy = await discoverSafetyPolicy({
 *     origin: 'https://acme.example',
 *     id: 'acme/strict-v3',
 *     hash: 'sha256:abc...',
 *   });
 */
export async function discoverSafetyPolicy(
  opts: DiscoverSafetyPolicyOptions,
): Promise<SafetyPolicyDescriptor> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new SafetyPolicyDiscoveryError(
      '@codecai/web: no global fetch available. Pass `fetchImpl` or upgrade to Node 18+.',
    );
  }

  // Hash present: prefer the immutable sibling. The bytes are the inline
  // descriptor (or a pointer that hashes to its filename's hex — but the
  // recommended layout is inline at the content-addressed path).
  if (opts.hash) {
    const hashHex = parseHash(opts.hash);
    const url = wellKnownPolicyHashUrl(opts.origin, hashHex);
    const resp = await fetchImpl(url, { signal: opts.signal });
    if (resp.status === 404) {
      throw new SafetyPolicyDiscoveryNotFoundError(url, resp.status);
    }
    if (!resp.ok) {
      throw new SafetyPolicyDiscoveryError(
        `Failed to fetch ${url}: HTTP ${resp.status}`,
      );
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const actual = await sha256Hex(bytes);
    if (actual !== hashHex) {
      throw new SafetyPolicyHashMismatchError(hashHex, actual);
    }
    const text = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (isPointerShape(parsed)) {
      validatePointer(parsed, opts.id);
      return loadSafetyPolicy({
        url: parsed.url,
        hash: parsed.hash,
        cache: opts.cache,
        signal: opts.signal,
        fetchImpl: opts.fetchImpl,
        cacheKey: `well-known:${opts.origin}#${opts.id}#${parsed.hash}`,
      });
    }
    validateSafetyPolicy(parsed);
    if (parsed.id !== opts.id) {
      throw new SafetyPolicyDiscoveryError(
        `Inline descriptor id ${JSON.stringify(parsed.id)} does not match requested id ${JSON.stringify(opts.id)}`,
      );
    }
    return parsed;
  }

  // No hash: fetch the mutable per-id document and follow a pointer if present.
  const url = wellKnownPolicyUrl(opts.origin, opts.id);
  const resp = await fetchImpl(url, { signal: opts.signal });
  if (resp.status === 404) {
    throw new SafetyPolicyDiscoveryNotFoundError(url, resp.status);
  }
  if (!resp.ok) {
    throw new SafetyPolicyDiscoveryError(
      `Failed to fetch ${url}: HTTP ${resp.status}`,
    );
  }
  const parsed: unknown = await resp.json();
  if (isPointerShape(parsed)) {
    validatePointer(parsed, opts.id);
    return loadSafetyPolicy({
      url: parsed.url,
      hash: parsed.hash,
      cache: opts.cache,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
      cacheKey: `well-known:${opts.origin}#${opts.id}#${parsed.hash}`,
    });
  }
  validateSafetyPolicy(parsed);
  if (parsed.id !== opts.id) {
    throw new SafetyPolicyDiscoveryError(
      `Inline descriptor id ${JSON.stringify(parsed.id)} does not match requested id ${JSON.stringify(opts.id)}`,
    );
  }
  return parsed;
}
