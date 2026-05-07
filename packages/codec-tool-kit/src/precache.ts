/**
 * Build-time tokenizer cache compiler.
 *
 * The architectural value of bolt-on Codec tools comes from doing the
 * tokenizer work **at build time, not runtime**. A tool author lists
 * the response fragments their tool emits (templates, common values,
 * unit suffixes, etc.) and `precache()` walks the supported model
 * list, tokenises every fragment with each model's tokenizer, and
 * writes a compact JSON cache file per model.
 *
 * At runtime, the tool's hot path is a hashtable lookup, not a BPE
 * tokenisation. That's the whole point — the gateway pays nothing,
 * the tool pays nothing, and the result tokens are just memcpy'd into
 * the generation context.
 *
 * This file deliberately doesn't bundle a tokenizer. We expose a
 * minimal `Tokenizer` interface and let the tool author pass in their
 * preferred implementation (huggingface tokenizers, tiktoken,
 * sentencepiece, the codecai BPE) — whatever's convenient at build
 * time. Keeps this package zero-dep.
 */

import type { TokenizerHash } from './manifest.js';

/**
 * Minimal tokenizer interface. Plug in any implementation at build
 * time. Both functions are synchronous because precache is a build
 * step, not a hot path.
 */
export interface Tokenizer {
  /** Tokenize a string to model-specific IDs. */
  encode(text: string): number[];
  /** SHA-256 hex of the tokenizer file (or any stable identity hash). */
  hash(): TokenizerHash;
}

/**
 * A fragment to pre-cache. Two flavours:
 *
 * - `static`: literal text → token IDs. For fixed prefixes/suffixes
 *   ("It is currently ", " UTC", " degrees"). Hot-path: hashtable
 *   lookup.
 *
 * - `template`: text with `{slots}` → broken into static prefixes,
 *   slot positions, and static suffixes. The tool fills slots at
 *   runtime, encoding only the slot values (often just digits and
 *   punctuation) and concatenating with the cached parts. Most useful
 *   for time/numeric/units output.
 */
export type Fragment =
  | { id: string; kind: 'static'; text: string }
  | { id: string; kind: 'template'; text: string };

/**
 * The cache shape written to disk. One file per (tool, model) pair.
 */
export interface ToolCache {
  /** SHA-256 of the tokenizer this cache was built against. */
  tokenizerHash: TokenizerHash;
  /** Fragment id → token IDs (for static) or template parts (for template). */
  fragments: Record<string, StaticEntry | TemplateEntry>;
}

export interface StaticEntry {
  kind: 'static';
  ids: number[];
}

export interface TemplateEntry {
  kind: 'template';
  /**
   * Each entry is either { ids: number[] } (a literal piece) or
   * { slot: string } (the slot's name, the tool supplies these at
   * runtime). The runtime concatenates these in order.
   */
  parts: ({ ids: number[] } | { slot: string })[];
}

/**
 * Compile a fragment list into a per-model cache.
 *
 * Example:
 *
 *   const cache = precache({
 *     fragments: [
 *       { id: 'time-prefix',  kind: 'static',   text: 'It is currently ' },
 *       { id: 'time-suffix',  kind: 'static',   text: ' UTC.' },
 *       { id: 'weather-line', kind: 'template', text: '{city}: {temp}°F' },
 *     ],
 *     tokenizer: huggingfaceTokenizer,
 *   });
 *   // cache.fragments['time-prefix'].ids === [4181, 374, 5042, 220, ...]
 *   // cache.fragments['weather-line'].parts === [
 *   //   { slot: 'city' },
 *   //   { ids: [25, 220] },        // ": "
 *   //   { slot: 'temp' },
 *   //   { ids: [37, 9492] },       // "°F"
 *   // ]
 *
 * Slots are the only thing the tool tokenises at runtime. Everything
 * else is a memcpy.
 */
export function precache(opts: { fragments: Fragment[]; tokenizer: Tokenizer }): ToolCache {
  const { fragments, tokenizer } = opts;
  const out: ToolCache = {
    tokenizerHash: tokenizer.hash(),
    fragments: {},
  };

  for (const frag of fragments) {
    if (frag.kind === 'static') {
      out.fragments[frag.id] = { kind: 'static', ids: tokenizer.encode(frag.text) };
      continue;
    }
    // template: split on {slot} markers
    const parts: TemplateEntry['parts'] = [];
    const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(frag.text)) !== null) {
      if (m.index > last) {
        const literal = frag.text.slice(last, m.index);
        parts.push({ ids: tokenizer.encode(literal) });
      }
      parts.push({ slot: m[1]! });
      last = re.lastIndex;
    }
    if (last < frag.text.length) {
      parts.push({ ids: tokenizer.encode(frag.text.slice(last)) });
    }
    out.fragments[frag.id] = { kind: 'template', parts };
  }

  return out;
}

/**
 * Render a template entry at runtime by filling slots. The tool
 * tokenises *only* the slot values (typically digits, single words),
 * everything else is cached.
 *
 * Pass a tokenizer for the slot values themselves. Most tools can
 * lazy-load this on cold start; on the hot path the tokenizer only
 * sees small slot strings.
 */
export function renderTemplate(
  entry: TemplateEntry,
  slots: Record<string, string>,
  tokenizer: Tokenizer,
): number[] {
  const out: number[] = [];
  for (const part of entry.parts) {
    if ('ids' in part) {
      out.push(...part.ids);
    } else {
      const value = slots[part.slot];
      if (value === undefined) {
        throw new Error(`renderTemplate: missing slot "${part.slot}"`);
      }
      out.push(...tokenizer.encode(value));
    }
  }
  return out;
}

/**
 * Verify that a runtime cache matches the active model's tokenizer.
 * Tool runtimes call this once on cold start; mismatches mean the
 * cache is stale and the tool should fall back to text-mode (or
 * refuse the request, depending on policy).
 */
export function verifyCache(cache: ToolCache, expectedHash: TokenizerHash): boolean {
  return cache.tokenizerHash.toLowerCase() === expectedHash.toLowerCase();
}
