/**
 * convert-tiktoken.ts — OpenAI tiktoken `.tiktoken` files → Codec v2 TokenizerMap.
 *
 * The OpenAI tokenizers used by the GPT-3.5 / GPT-4 / GPT-4o / o-series
 * model families ship as `.tiktoken` files on the OpenAI public CDN.
 * The vocab + BPE merges are open and MIT-licensed via tiktoken — only
 * the model weights themselves are closed. So Codec can produce a
 * tokenizer-map for these vocabularies without depending on an HF
 * tokenizer.json mirror.
 *
 * Format: each line of a `.tiktoken` file is
 *
 *     <base64-encoded-BPE-merge-bytes> <rank>
 *
 * where rank is the integer token ID. Single-byte entries occupy
 * scattered ranks (NOT 0-255 — tiktoken trains BPE on raw bytes, not on
 * a fixed base alphabet, so single bytes get whatever rank the trainer
 * assigned). Special tokens are NOT in the .tiktoken file; they're
 * baked into the encoding's Python definition. We hardcode them here
 * per the four production encodings.
 *
 * Output is the same v2 TokenizerMap shape used by `convertHFTokenizer`
 * — same vocab/encoder/merges/pre_tokenizer_pattern/special_tokens
 * fields, same byte_level encoder behaviour, same downstream contract.
 *
 * Programmatic API:
 *
 *   import { convertTiktoken, ENCODINGS } from '@codecai/maps-cli/convert-tiktoken';
 *   const buf = await readFile('cl100k_base.tiktoken');
 *   const map = convertTiktoken(buf, { id: 'openai/cl100k_base', encoding: 'cl100k_base' });
 *
 * Or via the CLI: `codecai-maps tiktoken cl100k_base.tiktoken --id=openai/cl100k_base
 *                  --encoding=cl100k_base`.
 */

import type { TokenizerMap } from '@codecai/web';
import { encodeByteLevelChars } from '@codecai/web';

// ── Known encodings ──────────────────────────────────────────────────────────

/** Production tiktoken encodings + their public CDN URLs and special tokens. */
export interface TiktokenEncodingSpec {
  /** Encoding name as registered with tiktoken (cl100k_base, o200k_base, ...). */
  readonly name: string;
  /** OpenAI public-CDN URL for the .tiktoken file. */
  readonly url: string;
  /** Pre-tokenizer regex pattern. Lifted verbatim from the tiktoken Python source. */
  readonly pattern: string;
  /** Special tokens baked into the encoding (not present in the .tiktoken file). */
  readonly specialTokens: Readonly<Record<string, number>>;
  /** Models that use this encoding (informational; canonical truth is `tiktoken`). */
  readonly models: readonly string[];
}

/**
 * Pattern for cl100k_base + o200k_base + p50k_base + r50k_base.
 *
 * cl100k_base / o200k_base use a `(?i:…)` group that's a JavaScript
 * inline-flag regex group landed in V8 13+ (Node 24+). Earlier Node
 * versions need an alternative pattern compiled via the
 * pre_tokenizer_program (v2.1) op list — same approach as the Codec
 * maps for byte-level Llama / Qwen.
 */
const PAT_CL100K =
  "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

const PAT_O200K =
  "[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

const PAT_P50K =
  "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+";

// p50k_base and r50k_base share the same pattern.
const PAT_R50K = PAT_P50K;

/**
 * Special tokens for cl100k_base. The `<|endoftext|>` token is mandatory
 * across all OpenAI encodings. The fim_* tokens enable "fill in the
 * middle" prompting on the Codex-family models.
 */
const SPECIAL_CL100K: Record<string, number> = {
  '<|endoftext|>':   100257,
  '<|fim_prefix|>':  100258,
  '<|fim_middle|>':  100259,
  '<|fim_suffix|>':  100260,
  '<|endofprompt|>': 100276,
};

/**
 * Special tokens for o200k_base (GPT-4o family). The o-series models
 * use a smaller special-token set than cl100k.
 */
const SPECIAL_O200K: Record<string, number> = {
  '<|endoftext|>':   199999,
  '<|endofprompt|>': 200018,
};

/** p50k_base + p50k_edit — Codex family + edit variant. */
const SPECIAL_P50K_BASE: Record<string, number> = { '<|endoftext|>': 50256 };
const SPECIAL_P50K_EDIT: Record<string, number> = {
  '<|endoftext|>':  50256,
  '<|fim_prefix|>': 50281,
  '<|fim_middle|>': 50282,
  '<|fim_suffix|>': 50283,
};

/** r50k_base — gpt-2-era encodings (text-davinci-002 etc.). */
const SPECIAL_R50K: Record<string, number> = { '<|endoftext|>': 50256 };

const TIKTOKEN_CDN = 'https://openaipublic.blob.core.windows.net/encodings';

export const ENCODINGS: Readonly<Record<string, TiktokenEncodingSpec>> = {
  cl100k_base: {
    name: 'cl100k_base',
    url: `${TIKTOKEN_CDN}/cl100k_base.tiktoken`,
    pattern: PAT_CL100K,
    specialTokens: SPECIAL_CL100K,
    models: [
      'gpt-4',
      'gpt-4-turbo',
      'gpt-4-32k',
      'gpt-3.5-turbo',
      'text-embedding-ada-002',
    ],
  },
  o200k_base: {
    name: 'o200k_base',
    url: `${TIKTOKEN_CDN}/o200k_base.tiktoken`,
    pattern: PAT_O200K,
    specialTokens: SPECIAL_O200K,
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'o1',
      'o1-mini',
      'o3',
      'o3-mini',
      'o4-mini',
    ],
  },
  p50k_base: {
    name: 'p50k_base',
    url: `${TIKTOKEN_CDN}/p50k_base.tiktoken`,
    pattern: PAT_P50K,
    specialTokens: SPECIAL_P50K_BASE,
    models: ['code-davinci-002', 'text-davinci-002', 'text-davinci-003'],
  },
  p50k_edit: {
    name: 'p50k_edit',
    url: `${TIKTOKEN_CDN}/p50k_base.tiktoken`,   // same merges file
    pattern: PAT_P50K,
    specialTokens: SPECIAL_P50K_EDIT,
    models: ['text-davinci-edit-001', 'code-davinci-edit-001'],
  },
  r50k_base: {
    name: 'r50k_base',
    url: `${TIKTOKEN_CDN}/r50k_base.tiktoken`,
    pattern: PAT_R50K,
    specialTokens: SPECIAL_R50K,
    models: ['gpt-3', 'davinci', 'curie', 'babbage', 'ada'],
  },
};

// ── Parsing the .tiktoken file ───────────────────────────────────────────────

/**
 * Parse the contents of a `.tiktoken` file.
 *
 * Each non-empty line is `<base64-bytes> <rank>`. Returns a map keyed by
 * the GPT-2-byte-encoded unicode form (Ġ-prefixed, etc.) with rank as
 * the value — the same shape the Codec v2 vocab field expects.
 */
export function parseTiktokenFile(rawBytes: Uint8Array | Buffer): Map<string, number> {
  const text = new TextDecoder('utf-8').decode(rawBytes);
  const vocab = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    const b64 = line.slice(0, sp);
    const rank = Number(line.slice(sp + 1).trim());
    if (!Number.isInteger(rank)) continue;
    const bytes = base64Decode(b64);
    const token = encodeByteLevelChars(bytes);
    vocab.set(token, rank);
  }
  return vocab;
}

function base64Decode(b64: string): Uint8Array {
  // Buffer is available in Node + edge runtimes; fall back to atob for
  // pure-browser callers.
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Merge derivation ─────────────────────────────────────────────────────────

/**
 * Reconstruct BPE merges from a rank-ordered vocab. tiktoken doesn't
 * ship merges separately — it ships the final `mergeable_ranks` map and
 * lets the encoder re-derive merges at training/inference time. We need
 * the merge list explicitly for Codec's BPETokenizer.
 *
 * Algorithm: for each multi-character token in rank order, find the
 * unique split (left, right) where both halves exist in the vocab with
 * lower rank. When multiple splits qualify, pick the one whose
 * higher-ranked half is lowest — the BPE step that actually produced
 * this token would have been the lowest-rank pair available at that
 * step.
 *
 * The resulting merge list is correct for inference (the BPETokenizer's
 * encode loop produces the same token IDs as tiktoken). The order of
 * the list matches rank order, which is also the priority order for
 * BPETokenizer's greedy merge pass.
 */
export function deriveMergesFromRanks(vocab: Map<string, number>): string[] {
  const sorted = [...vocab.entries()].sort((a, b) => a[1] - b[1]);
  const merges: string[] = [];
  for (const [token, rank] of sorted) {
    if (token.length < 2) continue;  // base byte
    let best: [string, string] | null = null;
    let bestPairRank = Infinity;
    for (let i = 1; i < token.length; i++) {
      const left = token.slice(0, i);
      const right = token.slice(i);
      const lr = vocab.get(left);
      const rr = vocab.get(right);
      if (lr === undefined || rr === undefined) continue;
      if (lr >= rank || rr >= rank) continue;
      const pairRank = Math.max(lr, rr);
      if (pairRank < bestPairRank) {
        best = [left, right];
        bestPairRank = pairRank;
      }
    }
    if (best) merges.push(`${best[0]} ${best[1]}`);
  }
  return merges;
}

// ── Public converter ─────────────────────────────────────────────────────────

export interface ConvertTiktokenOptions {
  /** Stable, globally unique map ID. Convention: `openai/<encoding>`. */
  id: string;
  /** One of the keys in ENCODINGS, OR a custom spec for a non-standard encoding. */
  encoding: keyof typeof ENCODINGS | TiktokenEncodingSpec;
  /** Schema version. Defaults to "2". */
  version?: string;
  /** ISO timestamp. Defaults to `new Date().toISOString()`. */
  publishedAt?: string;
}

/**
 * Convert a raw `.tiktoken` file body to a Codec v2 TokenizerMap.
 *
 * The result is byte-for-byte the same shape `convertHFTokenizer`
 * produces for an HF tokenizer.json — same fields, same encoder family,
 * same merge list semantics. Downstream consumers (`@codecai/web`,
 * `codec-supervisor`, the bench harness) can't distinguish a
 * tiktoken-derived map from an HF-derived one.
 */
export function convertTiktoken(
  rawBytes: Uint8Array | Buffer,
  opts: ConvertTiktokenOptions,
): TokenizerMap {
  const spec: TiktokenEncodingSpec =
    typeof opts.encoding === 'string' ? ENCODINGS[opts.encoding]! : opts.encoding;
  if (!spec) {
    throw new Error(
      `unknown tiktoken encoding ${JSON.stringify(opts.encoding)}; ` +
        `known: ${Object.keys(ENCODINGS).join(', ')}`,
    );
  }

  // 1. Parse .tiktoken → vocab keyed by byte-level unicode form.
  const vocab = parseTiktokenFile(rawBytes);

  // 2. Add special tokens. They're NOT in the .tiktoken file but ARE in
  //    the encoding's contract; the Detokenizer needs to know them.
  const specialTokens: Record<string, number> = {};
  for (const [name, id] of Object.entries(spec.specialTokens)) {
    specialTokens[name] = id;
    // Promote into vocab so the lookup paths see them:
    vocab.set(name, id);
  }

  // 3. Derive merges from rank order. The BPE merges aren't stored
  //    separately by tiktoken — only the final ranks are.
  const merges = deriveMergesFromRanks(vocab);

  const map: TokenizerMap = {
    id: opts.id,
    version: opts.version ?? '2',
    vocab_size: vocab.size,
    vocab: Object.fromEntries(vocab),
    encoder: 'byte_level',
    merges,
    pre_tokenizer_pattern: spec.pattern,
    special_tokens: specialTokens,
    published_at: opts.publishedAt ?? new Date().toISOString(),
  };
  return map;
}

/**
 * Convenience: fetch the .tiktoken file from the OpenAI public CDN and
 * convert it in one call. Useful for codec-maps regen scripts; the CLI
 * uses this for `codecai-maps tiktoken --fetch <encoding>`.
 */
export async function fetchAndConvertTiktoken(
  encoding: keyof typeof ENCODINGS,
  opts: { id: string; fetchImpl?: typeof fetch } = { id: '' },
): Promise<TokenizerMap> {
  const spec = ENCODINGS[encoding];
  if (!spec) {
    throw new Error(`unknown tiktoken encoding ${JSON.stringify(encoding)}`);
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const resp = await fetchImpl(spec.url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${spec.url}`);
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  return convertTiktoken(buf, {
    id: opts.id || `openai/${encoding}`,
    encoding,
  });
}
