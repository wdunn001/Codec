// ── Pluggable cache (default: in-memory) ──────────────────────────────────────
export class MemoryMapCache {
    constructor() {
        this.store = new Map();
    }
    async get(key) {
        return this.store.get(key);
    }
    async set(key, map) {
        this.store.set(key, map);
    }
}
const defaultCache = new MemoryMapCache();
// ── Validation ────────────────────────────────────────────────────────────────
//
// Light shape check — we don't pull a full JSON-Schema validator into the wire
// path. The contract is small enough that a hand-written check is honest about
// what we actually require.
export class TokenizerMapValidationError extends Error {
    constructor(message) {
        super(`TokenizerMap validation failed: ${message}`);
        this.name = 'TokenizerMapValidationError';
    }
}
export function validateMap(value) {
    if (typeof value !== 'object' || value === null) {
        throw new TokenizerMapValidationError('not an object');
    }
    const m = value;
    if (typeof m.id !== 'string')
        throw new TokenizerMapValidationError('id must be a string');
    if (typeof m.version !== 'string')
        throw new TokenizerMapValidationError('version must be a string');
    if (typeof m.vocab_size !== 'number' || m.vocab_size < 1)
        throw new TokenizerMapValidationError('vocab_size must be a positive integer');
    if (typeof m.tokens !== 'object' || m.tokens === null)
        throw new TokenizerMapValidationError('tokens must be an object');
    if (m.byte_fallback_start !== undefined &&
        (typeof m.byte_fallback_start !== 'number' || m.byte_fallback_start < 0)) {
        throw new TokenizerMapValidationError('byte_fallback_start must be a non-negative integer');
    }
    if (m.byte_fallback_end !== undefined &&
        (typeof m.byte_fallback_end !== 'number' || m.byte_fallback_end < 0)) {
        throw new TokenizerMapValidationError('byte_fallback_end must be a non-negative integer');
    }
    if ((m.byte_fallback_start === undefined) !==
        (m.byte_fallback_end === undefined)) {
        throw new TokenizerMapValidationError('byte_fallback_start and byte_fallback_end must both be set or both omitted');
    }
}
// ── Hashing (SubtleCrypto — works in browser, Node 18+, Cloudflare, Deno) ─────
export class TokenizerMapHashMismatchError extends Error {
    constructor(expected, actual) {
        super(`TokenizerMap hash mismatch.\n  expected: ${expected}\n  actual:   ${actual}`);
        this.name = 'TokenizerMapHashMismatchError';
    }
}
async function sha256Hex(bytes) {
    // globalThis.crypto.subtle is available everywhere we target.
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('@codecai/web requires a SubtleCrypto implementation (Web Crypto API). ' +
            'Available in browsers, Node 18+, Cloudflare Workers, Deno.');
    }
    const digest = await subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
/** Parse a hash string in the form `sha256:<hex>` or just `<hex>`. */
function parseHash(hash) {
    const colon = hash.indexOf(':');
    if (colon === -1)
        return hash.toLowerCase();
    const algo = hash.slice(0, colon).toLowerCase();
    if (algo !== 'sha256') {
        throw new Error(`Unsupported hash algorithm: ${algo} (only sha256 supported)`);
    }
    return hash.slice(colon + 1).toLowerCase();
}
/**
 * Fetch, verify, and cache a tokenizer map. Cache hits skip the network.
 *
 *   const map = await loadMap({
 *     url: 'https://maps.codec.ai/llama-3.1-8b.json',
 *     hash: 'sha256:abcd…'
 *   });
 */
export async function loadMap(opts) {
    const cache = opts.cache ?? defaultCache;
    const cacheKey = opts.cacheKey ?? `${opts.url}#${opts.hash ?? ''}`;
    const cached = await cache.get(cacheKey);
    if (cached)
        return cached;
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
        throw new Error('@codec/web: no global fetch available. Pass `fetchImpl` or upgrade to Node 18+.');
    }
    const resp = await fetchImpl(opts.url, { signal: opts.signal });
    if (!resp.ok) {
        throw new Error(`Failed to fetch tokenizer map from ${opts.url}: HTTP ${resp.status}`);
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (opts.hash) {
        const expected = parseHash(opts.hash);
        const actual = await sha256Hex(bytes);
        if (expected !== actual)
            throw new TokenizerMapHashMismatchError(expected, actual);
    }
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    validateMap(parsed);
    await cache.set(cacheKey, parsed);
    return parsed;
}
/** Construct a TokenizerMap directly from an object (useful for tests, embeds). */
export function makeMap(spec) {
    validateMap(spec);
    return spec;
}
//# sourceMappingURL=map.js.map