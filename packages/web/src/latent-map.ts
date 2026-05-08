/**
 * Latent-space map loading + caching (v0.3+).
 *
 * Mirrors `map.ts` for tokenizer maps. Loads a JSON map from a URL, optionally
 * verifies it against a SHA-256 hash, validates against the v1 LatentSpaceMap
 * shape, and stores it in a pluggable cache. Maps are immutable once
 * published, so cache hits are always valid.
 */
import type {
  LatentSpaceMap,
  LatentSpaceMapCache,
  LatentPipeline,
  LatentDecoder,
  LatentZstdDictionaryEntry,
} from './latent-types.js';

// ── Pluggable cache (default: in-memory) ──────────────────────────────────────

export class MemoryLatentSpaceMapCache implements LatentSpaceMapCache {
  private store = new Map<string, LatentSpaceMap>();
  async get(key: string): Promise<LatentSpaceMap | undefined> {
    return this.store.get(key);
  }
  async set(key: string, map: LatentSpaceMap): Promise<void> {
    this.store.set(key, map);
  }
}

const defaultCache: LatentSpaceMapCache = new MemoryLatentSpaceMapCache();

// ── Validation ────────────────────────────────────────────────────────────────
//
// Hand-written shape check against the v1 LatentSpaceMap contract — same
// approach as validateMap (no JSON-Schema runtime dep on the wire path). The
// canonical schema lives at spec/latent-space-map.schema.json.

export class LatentSpaceMapValidationError extends Error {
  constructor(message: string) {
    super(`LatentSpaceMap validation failed: ${message}`);
    this.name = 'LatentSpaceMapValidationError';
  }
}

const PIPELINE_SET: ReadonlySet<LatentPipeline> = new Set<LatentPipeline>([
  'raw',
  'int8',
  'int4',
  'int8-adaptive',
  'int4-adaptive',
  'delta+int8',
  'delta+int4',
]);

const RUNTIME_SET = new Set([
  'onnx-web',
  'onnx',
  'torch',
  'ggml',
  'wgsl',
  'safetensors-pt',
]);

const LATENT_DTYPE_SET = new Set(['fp32', 'fp16', 'bf16', 'int8', 'int4']);
const DECODER_INPUT_DTYPE_SET = new Set(['fp32', 'fp16', 'bf16']);
const OUTPUT_FORMAT_SET = new Set(['rgb_uint8', 'rgb_fp16', 'bgr_uint8', 'yuv420p_uint8']);
const OUTPUT_DTYPE_SET = new Set(['uint8', 'fp16', 'fp32']);
const FORMAT_SET = new Set(['msgpack', 'protobuf']);

function isHashSha256(s: unknown): s is string {
  return typeof s === 'string' && /^sha256:[0-9a-f]{64}$/.test(s);
}

function isPositiveIntArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every(
    (n) => Number.isInteger(n) && (n as number) >= 1,
  );
}

function validateDecoder(d: unknown, idx: number): asserts d is LatentDecoder {
  if (typeof d !== 'object' || d === null) {
    throw new LatentSpaceMapValidationError(`decoders[${idx}] must be an object`);
  }
  const o = d as Record<string, unknown>;
  if (typeof o.runtime !== 'string' || !RUNTIME_SET.has(o.runtime)) {
    throw new LatentSpaceMapValidationError(
      `decoders[${idx}].runtime must be one of ${[...RUNTIME_SET].join(', ')}, got ${JSON.stringify(o.runtime)}`,
    );
  }
  if (typeof o.url !== 'string' || o.url.length === 0) {
    throw new LatentSpaceMapValidationError(`decoders[${idx}].url must be a non-empty string`);
  }
  if (!isHashSha256(o.hash)) {
    throw new LatentSpaceMapValidationError(
      `decoders[${idx}].hash must match sha256:<64 hex chars>, got ${JSON.stringify(o.hash)}`,
    );
  }
  if (typeof o.size_bytes !== 'number' || !Number.isInteger(o.size_bytes) || o.size_bytes < 1) {
    throw new LatentSpaceMapValidationError(`decoders[${idx}].size_bytes must be a positive integer`);
  }
  if (!isPositiveIntArray(o.input_shape)) {
    throw new LatentSpaceMapValidationError(`decoders[${idx}].input_shape must be a non-empty array of positive integers`);
  }
  if (typeof o.input_dtype !== 'string' || !DECODER_INPUT_DTYPE_SET.has(o.input_dtype)) {
    throw new LatentSpaceMapValidationError(
      `decoders[${idx}].input_dtype must be one of ${[...DECODER_INPUT_DTYPE_SET].join(', ')}`,
    );
  }
  if (typeof o.output !== 'object' || o.output === null) {
    throw new LatentSpaceMapValidationError(`decoders[${idx}].output must be an object`);
  }
  const out = o.output as Record<string, unknown>;
  if (typeof out.format !== 'string' || !OUTPUT_FORMAT_SET.has(out.format)) {
    throw new LatentSpaceMapValidationError(
      `decoders[${idx}].output.format must be one of ${[...OUTPUT_FORMAT_SET].join(', ')}`,
    );
  }
  if (!isPositiveIntArray(out.shape)) {
    throw new LatentSpaceMapValidationError(`decoders[${idx}].output.shape must be a non-empty array of positive integers`);
  }
  if (typeof out.dtype !== 'string' || !OUTPUT_DTYPE_SET.has(out.dtype)) {
    throw new LatentSpaceMapValidationError(
      `decoders[${idx}].output.dtype must be one of ${[...OUTPUT_DTYPE_SET].join(', ')}`,
    );
  }
  if (o.license !== undefined && typeof o.license !== 'string') {
    throw new LatentSpaceMapValidationError(`decoders[${idx}].license must be a string if present`);
  }
}

function validateZstdDict(
  d: unknown,
  idx: number,
  declaredPipelines: ReadonlySet<string>,
): asserts d is LatentZstdDictionaryEntry {
  if (typeof d !== 'object' || d === null) {
    throw new LatentSpaceMapValidationError(`zstd_dictionaries[${idx}] must be an object`);
  }
  const o = d as Record<string, unknown>;
  if (typeof o.format !== 'string' || !FORMAT_SET.has(o.format)) {
    throw new LatentSpaceMapValidationError(
      `zstd_dictionaries[${idx}].format must be "msgpack" or "protobuf"`,
    );
  }
  if (typeof o.pipeline !== 'string' || !PIPELINE_SET.has(o.pipeline as LatentPipeline)) {
    throw new LatentSpaceMapValidationError(
      `zstd_dictionaries[${idx}].pipeline must be a registered pipeline name`,
    );
  }
  if (!declaredPipelines.has(o.pipeline)) {
    throw new LatentSpaceMapValidationError(
      `zstd_dictionaries[${idx}].pipeline ${JSON.stringify(o.pipeline)} is not in this map's pipelines[] list`,
    );
  }
  if (typeof o.url !== 'string' || o.url.length === 0) {
    throw new LatentSpaceMapValidationError(`zstd_dictionaries[${idx}].url must be a non-empty string`);
  }
  if (!isHashSha256(o.hash)) {
    throw new LatentSpaceMapValidationError(
      `zstd_dictionaries[${idx}].hash must match sha256:<64 hex chars>`,
    );
  }
  if (typeof o.size_bytes !== 'number' || !Number.isInteger(o.size_bytes) || o.size_bytes < 1) {
    throw new LatentSpaceMapValidationError(`zstd_dictionaries[${idx}].size_bytes must be a positive integer`);
  }
}

export function validateLatentMap(value: unknown): asserts value is LatentSpaceMap {
  if (typeof value !== 'object' || value === null) {
    throw new LatentSpaceMapValidationError('not an object');
  }
  const m = value as Record<string, unknown>;

  if (typeof m.id !== 'string' || m.id.length === 0) {
    throw new LatentSpaceMapValidationError('id must be a non-empty string');
  }
  if (!/^[a-z0-9._/-]+$/.test(m.id)) {
    throw new LatentSpaceMapValidationError(
      `id ${JSON.stringify(m.id)} must match [a-z0-9._/-]+`,
    );
  }
  if (typeof m.version !== 'string') {
    throw new LatentSpaceMapValidationError('version must be a string');
  }
  if (m.space_kind !== 'vae') {
    throw new LatentSpaceMapValidationError(
      `space_kind must be "vae", got ${JSON.stringify(m.space_kind)}`,
    );
  }
  if (!isPositiveIntArray(m.shape)) {
    throw new LatentSpaceMapValidationError('shape must be a non-empty array of positive integers');
  }
  if (typeof m.dtype !== 'string' || !LATENT_DTYPE_SET.has(m.dtype)) {
    throw new LatentSpaceMapValidationError(
      `dtype must be one of ${[...LATENT_DTYPE_SET].join(', ')}`,
    );
  }
  if (m.vae_scale_factor !== undefined && typeof m.vae_scale_factor !== 'number') {
    throw new LatentSpaceMapValidationError('vae_scale_factor must be a number if present');
  }

  if (!Array.isArray(m.decoders) || m.decoders.length === 0) {
    throw new LatentSpaceMapValidationError('decoders must be a non-empty array');
  }
  m.decoders.forEach((d, i) => validateDecoder(d, i));

  if (!Array.isArray(m.pipelines) || m.pipelines.length === 0) {
    throw new LatentSpaceMapValidationError('pipelines must be a non-empty array');
  }
  for (const [i, p] of m.pipelines.entries()) {
    if (typeof p !== 'string' || !PIPELINE_SET.has(p as LatentPipeline)) {
      throw new LatentSpaceMapValidationError(
        `pipelines[${i}] = ${JSON.stringify(p)} is not a registered pipeline name`,
      );
    }
  }
  if (!m.pipelines.includes('raw')) {
    throw new LatentSpaceMapValidationError(
      'pipelines must include "raw" — the negotiation fallback is mandatory',
    );
  }

  if (m.zstd_dictionaries !== undefined) {
    if (!Array.isArray(m.zstd_dictionaries)) {
      throw new LatentSpaceMapValidationError('zstd_dictionaries must be an array if present');
    }
    const declared = new Set(m.pipelines as string[]);
    m.zstd_dictionaries.forEach((d, i) => validateZstdDict(d, i, declared));
  }

  if (m.video !== undefined) {
    if (typeof m.video !== 'object' || m.video === null) {
      throw new LatentSpaceMapValidationError('video must be an object if present');
    }
    const v = m.video as Record<string, unknown>;
    if (v.default_fps !== undefined && (!Number.isInteger(v.default_fps) || (v.default_fps as number) < 1)) {
      throw new LatentSpaceMapValidationError('video.default_fps must be a positive integer');
    }
    if (v.keyframe_interval !== undefined && (!Number.isInteger(v.keyframe_interval) || (v.keyframe_interval as number) < 1)) {
      throw new LatentSpaceMapValidationError('video.keyframe_interval must be a positive integer');
    }
    if (v.temporal_axis !== undefined && v.temporal_axis !== 'per-frame' && v.temporal_axis !== 'block') {
      throw new LatentSpaceMapValidationError('video.temporal_axis must be "per-frame" or "block"');
    }
  }
}

// ── Hashing ───────────────────────────────────────────────────────────────────

export class LatentSpaceMapHashMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`LatentSpaceMap hash mismatch.\n  expected: ${expected}\n  actual:   ${actual}`);
    this.name = 'LatentSpaceMapHashMismatchError';
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
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await subtle.digest('SHA-256', buf);
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

// ── Loader ────────────────────────────────────────────────────────────────────

export interface LoadLatentMapOptions {
  url: string;
  hash?: string;
  cache?: LatentSpaceMapCache;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  cacheKey?: string;
}

export async function loadLatentMap(opts: LoadLatentMapOptions): Promise<LatentSpaceMap> {
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
    throw new Error(`Failed to fetch latent-space map from ${opts.url}: HTTP ${resp.status}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());

  if (opts.hash) {
    const expected = parseHash(opts.hash);
    const actual = await sha256Hex(bytes);
    if (expected !== actual) throw new LatentSpaceMapHashMismatchError(expected, actual);
  }

  const text = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  validateLatentMap(parsed);

  await cache.set(cacheKey, parsed);
  return parsed;
}

/** Construct a LatentSpaceMap directly from an object (useful for tests, embeds). */
export function makeLatentMap(spec: LatentSpaceMap): LatentSpaceMap {
  validateLatentMap(spec);
  return spec;
}
