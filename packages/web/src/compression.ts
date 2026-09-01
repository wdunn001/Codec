/**
 * Client-side helpers for the Codec compression contract.
 *
 * Pairs with the server-side `codec_compression` modules in sglang/vLLM:
 * the server emits `Codec-Zstd-Dict: sha256:<hex>` on every zstd
 * response, the client validates that header against locally-loaded dicts
 * before decompressing. See spec/versions/v0.4.md
 * "Codec-Zstd-Dict response header" for the full contract.
 *
 * The actual zstd decompression is intentionally out of scope here:
 * browsers will soon ship native `DecompressionStream('zstd')`, Node has
 * `@mongodb-js/zstd` / `zstd-codec` / `fzstd`, and any non-trivial caller
 * already has its own HTTP plumbing. This module just gives you the small
 * piece that's specific to Codec: matching a response's declared dict
 * hash to the dict you've loaded.
 *
 * TypeScript twin of `packages/python/src/codecai/compression.py`.
 */
import type { } from './types.js'; // keep alongside other modules for tree-shake consistency

/**
 * Raised when the server's `Codec-Zstd-Dict` header doesn't match any
 * dict the client has loaded, or is missing on a zstd response.
 *
 * A wrong-dict decompression would produce garbage bytes that downstream
 * msgpack/protobuf parsers would misinterpret: fail fast instead.
 */
export class CodecZstdDictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecZstdDictError';
  }
}

/**
 * Compute the canonical `Codec-Zstd-Dict` hash for `dictBytes`.
 *
 * Returns `sha256:<lowercase hex>`: same shape as the server-side header
 * value and the `hash` field in tokenizer-map `zstd_dictionaries[]`
 * entries.
 *
 * Async because we use Web Crypto's `SubtleCrypto.digest`, which is the
 * isomorphic hash API available in browsers, Node 18+, Cloudflare
 * Workers, and Deno (matches the rest of `@codecai/web`).
 */
export async function hashZstdDict(dictBytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      '@codecai/web requires a SubtleCrypto implementation (Web Crypto API). ' +
        'Available in browsers, Node 18+, Cloudflare Workers, Deno.',
    );
  }
  const digest = await subtle.digest(
    'SHA-256',
    dictBytes.buffer.slice(
      dictBytes.byteOffset,
      dictBytes.byteOffset + dictBytes.byteLength,
    ) as ArrayBuffer,
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

/**
 * Header source accepted by `selectZstdDictForResponse`. Either a
 * standard `Headers` instance (from `fetch` responses) or a plain object
 * keyed by header name. For plain objects, lookup is case-insensitive.
 */
export type ResponseHeadersLike = Headers | Record<string, string>;

function lookupHeader(headers: ResponseHeadersLike, name: string): string | null {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name);
  }
  const dict = headers as Record<string, string>;
  if (name in dict) return dict[name] ?? null;
  const lower = name.toLowerCase();
  for (const k of Object.keys(dict)) {
    if (k.toLowerCase() === lower) return dict[k] ?? null;
  }
  return null;
}

/**
 * Pick the zstd dict to decompress this response with.
 *
 * @param responseHeaders Headers from the HTTP response. Either a
 *   `Headers` instance (from `fetch`) or a plain object (case-insensitive
 *   lookup either way).
 * @param loadedDicts `Map<sha256_hash, dict_bytes>`: the dicts the
 *   client has loaded locally. Hashes follow the same `sha256:<hex>`
 *   format the server emits.
 *
 * @returns
 *   - The matching dict's bytes when the response is
 *     `Content-Encoding: zstd` and the server's `Codec-Zstd-Dict` header
 *     points at a loaded dict.
 *   - `null` when the response isn't zstd (caller should pass through
 *     identity / let `fetch` auto-decompress gzip/br).
 *
 * @throws CodecZstdDictError when the response is zstd but:
 *   - The `Codec-Zstd-Dict` header is missing (per spec, the server
 *     MUST emit it on every zstd response).
 *   - The header names a hash we haven't loaded: caller should fetch
 *     the dict from the tokenizer map's `zstd_dictionaries[]` entry
 *     whose `hash` matches, or retry the request with
 *     `Accept-Encoding: gzip` to downgrade to a no-dict path.
 *   - The header is malformed (not `sha256:<64 hex chars>`).
 */
export function selectZstdDictForResponse(
  responseHeaders: ResponseHeadersLike,
  loadedDicts: Map<string, Uint8Array>,
): Uint8Array | null {
  const enc = lookupHeader(responseHeaders, 'content-encoding');
  if (enc === null || enc.trim().toLowerCase() !== 'zstd') {
    // Caller's HTTP stack handles gzip/br/identity transparently.
    return null;
  }

  const declaredRaw = lookupHeader(responseHeaders, 'codec-zstd-dict');
  if (declaredRaw === null || declaredRaw.length === 0) {
    throw new CodecZstdDictError(
      'Response is Content-Encoding: zstd but no Codec-Zstd-Dict header ' +
        'was present. Per spec/versions/v0.4.md the server MUST name the ' +
        'dict it used. Refusing to guess.',
    );
  }
  const declared = declaredRaw.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(declared)) {
    throw new CodecZstdDictError(
      `Malformed Codec-Zstd-Dict value: ${JSON.stringify(declared)}. ` +
        "Expected 'sha256:<64 lowercase hex chars>'.",
    );
  }

  const bytes = loadedDicts.get(declared);
  if (!bytes) {
    throw new CodecZstdDictError(
      `Server used zstd dict ${declared} but it isn't loaded locally. ` +
        "Fetch it from the tokenizer map's zstd_dictionaries[] entry " +
        '(the entry whose hash matches), or send Accept-Encoding: gzip ' +
        'to downgrade.',
    );
  }
  return bytes;
}
