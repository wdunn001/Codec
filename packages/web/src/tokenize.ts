/**
 * Tokenizer — text → IDs. The edge-side encoder.
 *
 * Two implementations ship in this package:
 *
 *   - `BPETokenizer` (in `./bpe.ts`) — exact BPE encoding for byte_level and
 *     metaspace maps. Use this with any v2 map that has `merges` (every map
 *     fetched from `codec-maps` for a real model).
 *
 *   - `LongestMatchTokenizer` (this file) — vocab-only longest-prefix-match.
 *     Correct for canonical-IR / synthetic maps without merges (test
 *     fixtures, simple/closed vocabs).
 *
 * Both implement the `Tokenizer` interface so users can swap freely.
 *
 * The `tokenize()` convenience function picks the right implementation based
 * on the map's contents — if `merges` is present, BPE; otherwise longest match.
 */
import { BPETokenizer } from './bpe.js';
import type { Tokenizer, TokenizerMap } from './types.js';

/**
 * Longest-prefix-match tokenizer. Walks the input left-to-right, at each
 * position emitting the ID of the longest vocab fragment that matches.
 *
 * Suitable for canonical-IR maps and test fixtures. Not BPE-correct for
 * real model vocabs — use `BPETokenizer` for those.
 */
export class LongestMatchTokenizer implements Tokenizer {
  readonly id: string;

  private readonly fragmentToId = new Map<string, number>();
  private readonly maxFragmentLength: number;
  private readonly specialFragmentToId = new Map<string, number>();

  constructor(map: TokenizerMap) {
    this.id = map.id;

    let maxLen = 1;
    // v2 maps: vocab is { fragment: id }
    if (map.vocab) {
      for (const [fragment, id] of Object.entries(map.vocab)) {
        if (!fragment) continue;
        this.fragmentToId.set(fragment, id);
        if (fragment.length > maxLen) maxLen = fragment.length;
      }
    }
    // v1 maps: tokens is { id_string: fragment }
    if (map.tokens) {
      for (const [idStr, fragment] of Object.entries(map.tokens)) {
        if (!fragment) continue;
        const id = Number(idStr);
        this.fragmentToId.set(fragment, id);
        if (fragment.length > maxLen) maxLen = fragment.length;
      }
    }
    this.maxFragmentLength = maxLen;

    for (const [name, id] of Object.entries(map.special_tokens ?? {})) {
      // Accept both raw form (`<|eos|>`) and short form (`eos`).
      this.specialFragmentToId.set(name, id);
      if (!name.startsWith('<')) {
        this.specialFragmentToId.set(`<|${name}|>`, id);
      }
    }
  }

  encode(text: string): number[] {
    const out: number[] = [];
    let pos = 0;
    const n = text.length;

    while (pos < n) {
      // Special tokens win when present.
      let consumed = false;
      for (const [frag, id] of this.specialFragmentToId) {
        if (text.startsWith(frag, pos)) {
          out.push(id);
          pos += frag.length;
          consumed = true;
          break;
        }
      }
      if (consumed) continue;

      const remaining = n - pos;
      const tryUpTo = Math.min(this.maxFragmentLength, remaining);
      let matchedId = -1;
      let matchedLen = 0;
      for (let len = tryUpTo; len >= 1; len--) {
        const candidate = text.slice(pos, pos + len);
        const id = this.fragmentToId.get(candidate);
        if (id !== undefined) {
          matchedId = id;
          matchedLen = len;
          break;
        }
      }

      if (matchedId === -1) {
        out.push(0); // UNK by convention
        pos += 1;
      } else {
        out.push(matchedId);
        pos += matchedLen;
      }
    }
    return out;
  }
}

/**
 * Build the right tokenizer for the map. Uses `BPETokenizer` when the map
 * carries BPE data (vocab + merges + encoder); otherwise falls back to
 * `LongestMatchTokenizer`, which works on any vocab-bearing map.
 */
export function pickTokenizer(map: TokenizerMap): Tokenizer {
  if (BPETokenizer.supports(map)) return new BPETokenizer(map);
  return new LongestMatchTokenizer(map);
}

/** One-shot encode using `pickTokenizer`. */
export function tokenize(map: TokenizerMap, text: string): number[] {
  return pickTokenizer(map).encode(text);
}

// Re-export the Tokenizer interface for external use.
export type { Tokenizer } from './types.js';
