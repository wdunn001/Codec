/**
 * convert.ts — HuggingFace tokenizer.json → CodecTokenizerMap.
 *
 * The library half of `@codecai/maps-cli`. Use it programmatically:
 *
 *   import { convertHFTokenizer } from '@codecai/maps-cli/convert';
 *   const map = convertHFTokenizer(hfJson, { id: 'my-org/my-model' });
 *
 * Or via the CLI: `codecai-maps build <model-id>` (see ./cli.ts).
 *
 * Output schema is the v2 `TokenizerMap` from `@codecai/web` — same JSON
 * shape used by `loadMap()` in browsers. Maps generated here can be hosted
 * anywhere (jsDelivr from a public repo, your own CDN, Hugging Face,
 * S3, …) and pinned by sha256 hash.
 */

import type { TokenizerMap, LatentSpaceMap } from '@codecai/web';
import { compilePreTokenizerRegex, metaspaceProgram } from './compile-pretok.js';

// ── HuggingFace tokenizer.json shape ────────────────────────────────────────

interface HFNode {
  type: string;
  pattern?: { Regex?: string; String?: string };
  pretokenizers?: HFNode[];
  decoders?: HFNode[];
  replacement?: string;
}

export interface HFTokenizerJson {
  model: {
    type: string;
    vocab: Record<string, number>;
    merges?: string[] | Array<[string, string]>;
    byte_fallback?: boolean;
  };
  added_tokens: Array<{
    id: number;
    content: string;
    special: boolean;
  }>;
  pre_tokenizer?: HFNode | null;
  decoder?: HFNode | null;
}

export interface ConvertOptions {
  /**
   * Stable, globally unique tokenizer ID. Convention: lowercase
   * `org/model-family` (e.g. `meta-llama/llama-3`).
   */
  id: string;
  /** Schema version. Defaults to `"2"`. */
  version?: string;
  /** ISO timestamp. Defaults to `new Date().toISOString()`. */
  publishedAt?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findInTree(node: HFNode | null | undefined, type: string): HFNode | null {
  if (!node) return null;
  if (node.type === type) return node;
  const children = node.pretokenizers ?? node.decoders;
  if (children) {
    for (const child of children) {
      const found = findInTree(child, type);
      if (found) return found;
    }
  }
  return null;
}

function detectEncoder(hf: HFTokenizerJson): 'byte_level' | 'metaspace' | undefined {
  if (findInTree(hf.decoder, 'ByteLevel') || findInTree(hf.pre_tokenizer, 'ByteLevel')) {
    return 'byte_level';
  }
  if (findInTree(hf.decoder, 'Metaspace') || findInTree(hf.pre_tokenizer, 'Metaspace')) {
    return 'metaspace';
  }
  if (hf.model.byte_fallback) return 'metaspace';
  return undefined;
}

function extractPreTokenizerPattern(hf: HFTokenizerJson): string | undefined {
  const split = findInTree(hf.pre_tokenizer, 'Split');
  return split?.pattern?.Regex;
}

function normalizeMerges(hf: HFTokenizerJson): string[] | undefined {
  const m = hf.model.merges;
  if (!m || m.length === 0) return undefined;
  if (Array.isArray(m[0])) {
    return (m as Array<[string, string]>).map((pair) => `${pair[0]} ${pair[1]}`);
  }
  return m as string[];
}

const BYTE_FALLBACK_RE = /^<0x([0-9A-Fa-f]{2})>$/;

// ── Core conversion ──────────────────────────────────────────────────────────

/**
 * Convert a HuggingFace `tokenizer.json` (parsed JSON object) into a Codec
 * `TokenizerMap`. Pure function — no I/O.
 *
 * Throws `Error` if the input doesn't look like a HuggingFace tokenizer.json.
 */
export function convertHFTokenizer(
  hf: HFTokenizerJson,
  opts: ConvertOptions,
): TokenizerMap {
  if (!hf?.model?.vocab) {
    throw new Error(
      'convertHFTokenizer: input is missing `model.vocab`. ' +
        'Expected a HuggingFace tokenizer.json object.',
    );
  }

  const encoder = detectEncoder(hf);
  const merges = normalizeMerges(hf);
  const pre_tokenizer_pattern =
    encoder === 'byte_level' ? extractPreTokenizerPattern(hf) : undefined;

  const vocab: Record<string, number> = { ...hf.model.vocab };
  const special_tokens: Record<string, number> = {};
  for (const t of hf.added_tokens ?? []) {
    vocab[t.content] = t.id;
    if (t.special) special_tokens[t.content] = t.id;
  }

  let byte_fallback_start: number | undefined;
  let byte_fallback_end: number | undefined;
  if (encoder === 'metaspace' || hf.model.byte_fallback) {
    const byteIds = new Map<number, number>();
    for (const [token, id] of Object.entries(vocab)) {
      const m = token.match(BYTE_FALLBACK_RE);
      if (m) byteIds.set(parseInt(m[1]!, 16), id);
    }
    if (byteIds.size === 256) {
      byte_fallback_start = byteIds.get(0)!;
      byte_fallback_end = byteIds.get(255)!;
    }
  }

  const result: TokenizerMap = {
    id: opts.id,
    version: opts.version ?? '2',
    vocab_size: Object.keys(vocab).length,
    vocab,
    published_at: opts.publishedAt ?? new Date().toISOString(),
  };

  // Build with `as` casts since TokenizerMap fields are readonly.
  if (encoder) (result as { encoder?: string }).encoder = encoder;
  if (merges) (result as { merges?: string[] }).merges = merges;
  if (pre_tokenizer_pattern)
    (result as { pre_tokenizer_pattern?: string }).pre_tokenizer_pattern =
      pre_tokenizer_pattern;

  // Compile the regex into a v2.1 pre_tokenizer_program when the regex
  // is one we recognise. Old clients ignore the field; new clients
  // (and the C runtime once it lands) skip the regex engine entirely.
  // For metaspace encoders, emit the metaspace_split shortcut directly.
  if (encoder === 'byte_level' && pre_tokenizer_pattern) {
    const prog = compilePreTokenizerRegex(pre_tokenizer_pattern);
    if (prog) {
      (result as { pre_tokenizer_program?: typeof prog }).pre_tokenizer_program = prog;
    }
  } else if (encoder === 'metaspace') {
    const prog = metaspaceProgram();
    (result as { pre_tokenizer_program?: typeof prog }).pre_tokenizer_program = prog;
  }
  if (byte_fallback_start !== undefined) {
    (result as { byte_fallback_start?: number }).byte_fallback_start = byte_fallback_start;
    (result as { byte_fallback_end?: number }).byte_fallback_end = byte_fallback_end;
  }
  if (Object.keys(special_tokens).length > 0) {
    (result as { special_tokens?: Record<string, number> }).special_tokens = special_tokens;
  }

  return result;
}

// ── Convenience: fetch from HuggingFace and convert ──────────────────────────

export interface FetchAndConvertOptions extends ConvertOptions {
  /** HuggingFace model ID, e.g. `Qwen/Qwen2.5-7B-Instruct`. */
  hfModel: string;
  /** HuggingFace API token, for gated models. */
  hfToken?: string;
  /** Override the URL (e.g. for a mirror). */
  url?: string;
}

/**
 * Fetch a tokenizer.json from HuggingFace and convert it. Useful for one-off
 * generation; for bulk conversion across many models, fetch the JSON yourself
 * and call `convertHFTokenizer` directly.
 */
export async function fetchAndConvert(
  opts: FetchAndConvertOptions,
): Promise<TokenizerMap> {
  const url =
    opts.url ?? `https://huggingface.co/${opts.hfModel}/resolve/main/tokenizer.json`;
  const headers: Record<string, string> = {
    'User-Agent': '@codecai/maps-cli',
  };
  if (opts.hfToken) headers.Authorization = `Bearer ${opts.hfToken}`;

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(
      `fetchAndConvert: HTTP ${resp.status} for ${url}` +
        (resp.status === 401 ? ' (gated model — pass hfToken)' : ''),
    );
  }
  const hf = (await resp.json()) as HFTokenizerJson;
  return convertHFTokenizer(hf, opts);
}

// ── sha256 helper ────────────────────────────────────────────────────────────

/**
 * Compute the canonical sha256 hash of a TokenizerMap. Use this when
 * publishing a map so consumers can pin against it via
 * `loadMap({ url, hash })`.
 */
export async function hashMap(map: TokenizerMap): Promise<string> {
  return hashJsonDocument(map);
}

/**
 * Compute the canonical sha256 hash of a LatentSpaceMap. Use this when
 * publishing a latent-space map so consumers can pin against it via
 * `loadLatentMap({ url, hash })`. Same canonical form as `hashMap`
 * (2-space pretty-printed JSON, UTF-8) so a single emitter produces the
 * bytes both server and client agree on.
 */
export async function hashLatentMap(map: LatentSpaceMap): Promise<string> {
  return hashJsonDocument(map);
}

async function hashJsonDocument(doc: object): Promise<string> {
  const json = JSON.stringify(doc, null, 2);
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}
