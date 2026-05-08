/**
 * BPETokenizer — pure JS BPE encoder. Text → token IDs.
 *
 * Required for the bidirectional Codec endpoint: when a human types into a
 * chat box, the client tokenizes locally so input goes over the wire as
 * uint32 IDs (not text), preserving the ~95% wire reduction for both sides.
 *
 * Algorithm (for both byte_level and metaspace BPE):
 *
 *   1. Pre-tokenize. Split input text into pieces.
 *        byte_level: apply the Unicode regex from `pre_tokenizer_pattern`
 *                    (model-specific; e.g. Llama-3 splits on word/whitespace
 *                    boundaries with contraction handling).
 *        metaspace:  split on ASCII whitespace; prefix the first piece (or
 *                    every piece for `prepend_scheme: always`) with ▁.
 *
 *   2. Encode each piece to the vocab's character space.
 *        byte_level: UTF-8 encode the piece, map each byte through the
 *                    GPT-2 byte→unicode table.
 *        metaspace:  text already lives in vocab space — replace spaces
 *                    inside the piece with ▁ and we're done.
 *
 *   3. Apply BPE merges. Start with each codepoint as its own token; greedily
 *      merge the highest-priority pair (lowest merge index) repeatedly until
 *      no rules apply. This matches HuggingFace's reference implementation.
 *
 *   4. Look up final tokens in `vocab`. Tokens not in the vocab are emitted
 *      via byte fallback if available (metaspace), otherwise dropped (this
 *      shouldn't happen for byte_level since every byte is in the vocab).
 *
 * Pure JS, no wasm, no native deps. ~200 lines.
 */
import { encodeByteLevelChars, METASPACE } from './encoder.js';
import { runPreTokProgram, type PreTokProgram } from './pretok-program.js';
import type { Tokenizer, TokenizerMap } from './types.js';

export class BPETokenizer implements Tokenizer {
  readonly id: string;
  private readonly map: TokenizerMap;
  private readonly vocab: ReadonlyMap<string, number>;
  /** "left right" → priority (lower wins). */
  private readonly mergeRanks: ReadonlyMap<string, number>;
  private readonly preTokRegex: RegExp | null;
  private readonly preTokProgram: PreTokProgram | null;
  private readonly encoder: 'byte_level' | 'metaspace';
  private readonly byteFallbackStart: number;
  private readonly cache = new Map<string, number[]>();

  /**
   * Returns true if `map` carries the data BPETokenizer needs (vocab, merges,
   * a supported encoder). When false, callers should fall back to
   * LongestMatchTokenizer — the top-level `tokenize()` helper does this
   * automatically, and `pickTokenizer(map)` returns the right one.
   */
  static supports(map: TokenizerMap): boolean {
    return Boolean(
      map.vocab &&
        map.merges && map.merges.length > 0 &&
        (map.encoder === 'byte_level' || map.encoder === 'metaspace'),
    );
  }

  constructor(map: TokenizerMap) {
    if (!BPETokenizer.supports(map)) {
      throw new Error(
        `BPETokenizer: map "${map.id}" lacks vocab/merges/encoder. ` +
          `Use BPETokenizer.supports(map) to check first, or call ` +
          `tokenize(map, text) which falls back to LongestMatchTokenizer.`,
      );
    }

    // After supports() check above, these are guaranteed present.
    const mapVocab = map.vocab!;
    const mapMerges = map.merges!;
    const mapEncoder = map.encoder as 'byte_level' | 'metaspace';

    this.id = map.id;
    this.map = map;
    this.encoder = mapEncoder;
    this.byteFallbackStart = map.byte_fallback_start ?? -1;

    // Build vocab as a Map for fast lookup.
    const vocab = new Map<string, number>();
    for (const [tok, id] of Object.entries(mapVocab)) vocab.set(tok, id);
    this.vocab = vocab;

    // Build merge ranks. HuggingFace stores merges in priority order — index
    // 0 has highest priority. Each merge is "left right".
    const ranks = new Map<string, number>();
    for (let i = 0; i < mapMerges.length; i++) {
      ranks.set(mapMerges[i]!, i);
    }
    this.mergeRanks = ranks;

    // Pre-tokenizer: prefer the compiled program when present, otherwise
    // fall back to the legacy regex. Programs are required for any client
    // without a Unicode regex engine (libcodec/C); the regex remains
    // useful for compatibility and as a fallback for unrecognised
    // tokenizer families that the maps-cli compiler couldn't lower.
    if (this.encoder === 'byte_level') {
      if (map.pre_tokenizer_program && map.pre_tokenizer_program.ops?.length) {
        this.preTokProgram = map.pre_tokenizer_program as unknown as PreTokProgram;
        this.preTokRegex = null;
      } else if (map.pre_tokenizer_pattern) {
        // Try the `'gv'` flag first — Unicode-sets mode, supports
        // ES2025 inline-flag groups like `(?i:...)` that some
        // pre-tokenizer patterns (e.g. qwen2's contraction handler)
        // depend on. Fall back to legacy `'gu'` when the runtime's
        // V8 is too old for `v` flag, OR when the pattern uses
        // syntax that's valid under `u` but not under the stricter
        // `v` (some character class escapes differ). Either flag
        // alone is wrong for some maps; the try/catch is the
        // straightforward way to cover both.
        try {
          this.preTokRegex = new RegExp(map.pre_tokenizer_pattern, 'gv');
        } catch {
          this.preTokRegex = new RegExp(map.pre_tokenizer_pattern, 'gu');
        }
        this.preTokProgram = null;
      } else {
        throw new Error(
          `BPETokenizer: byte_level map "${map.id}" missing both ` +
            `pre_tokenizer_program and pre_tokenizer_pattern.`,
        );
      }
    } else {
      this.preTokRegex = null;
      this.preTokProgram = null;
    }
  }

  /** Encode text → token IDs. */
  encode(text: string): number[] {
    if (text.length === 0) return [];
    const pieces = this.preTokenize(text);
    const ids: number[] = [];
    for (const piece of pieces) {
      const cached = this.cache.get(piece);
      if (cached !== undefined) {
        for (let i = 0; i < cached.length; i++) ids.push(cached[i]!);
        continue;
      }
      const encoded = this.encodePieceToVocabSpace(piece);
      const merged = this.applyBPE(encoded);
      const pieceIds = this.lookup(merged);
      this.cache.set(piece, pieceIds);
      for (let i = 0; i < pieceIds.length; i++) ids.push(pieceIds[i]!);
    }
    return ids;
  }

  // ── Pre-tokenization ──────────────────────────────────────────────────────

  private preTokenize(text: string): string[] {
    if (this.encoder === 'byte_level') {
      if (this.preTokProgram) {
        return runPreTokProgram(this.preTokProgram, text);
      }
      // Reset regex state and collect non-empty matches.
      const re = this.preTokRegex!;
      re.lastIndex = 0;
      const out: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length > 0) out.push(m[0]);
        if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
      }
      return out;
    }

    // Metaspace: split on whitespace, prepend ▁ to each piece. This matches
    // SentencePiece's behavior with `prepend_scheme: "always"`. For
    // `prepend_scheme: "first"` the difference only matters at the very start
    // of input; we approximate the common case correctly.
    const out: string[] = [];
    const trimmed = text.replace(/[ \t]+/g, ' ');
    // Treat a leading space as part of the first word.
    const parts = trimmed.split(/(\s)/).filter((p) => p.length > 0);
    for (const p of parts) {
      if (p === ' ') continue;
      out.push(METASPACE + p);
    }
    return out;
  }

  // ── Step 2: encode piece → vocab character space ─────────────────────────

  private encodePieceToVocabSpace(piece: string): string[] {
    if (this.encoder === 'byte_level') {
      const bytes = new TextEncoder().encode(piece);
      const encoded = encodeByteLevelChars(bytes);
      // Each codepoint of `encoded` is one initial BPE token.
      return [...encoded];
    }
    // Metaspace: the piece is already in vocab-space (▁ prefix). Each
    // codepoint of the piece is one initial BPE token.
    return [...piece];
  }

  // ── Step 3: BPE merges ────────────────────────────────────────────────────

  private applyBPE(tokens: string[]): string[] {
    if (tokens.length < 2) return tokens;

    let parts = tokens.slice();
    while (true) {
      // Find the lowest-rank (highest-priority) mergeable pair.
      let bestIdx = -1;
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i] + ' ' + parts[i + 1];
        const r = this.mergeRanks.get(key);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;

      // Merge ALL non-overlapping occurrences of that pair in one pass —
      // this matches HuggingFace's behavior and runs in linear time per
      // outer iteration.
      const left = parts[bestIdx]!;
      const right = parts[bestIdx + 1]!;
      const merged = left + right;
      const next: string[] = [];
      let i = 0;
      while (i < parts.length) {
        if (i < parts.length - 1 && parts[i] === left && parts[i + 1] === right) {
          next.push(merged);
          i += 2;
        } else {
          next.push(parts[i]!);
          i += 1;
        }
      }
      parts = next;
    }

    return parts;
  }

  // ── Step 4: vocab lookup with byte fallback ──────────────────────────────

  private lookup(tokens: string[]): number[] {
    const ids: number[] = [];
    for (const tok of tokens) {
      const id = this.vocab.get(tok);
      if (id !== undefined) {
        ids.push(id);
        continue;
      }
      // Byte fallback (metaspace + SentencePiece byte_fallback): emit the
      // raw UTF-8 bytes of the token as byte-fallback IDs.
      if (this.byteFallbackStart >= 0) {
        const bytes = new TextEncoder().encode(tok);
        for (let i = 0; i < bytes.length; i++) {
          ids.push(this.byteFallbackStart + bytes[i]!);
        }
      }
      // For byte_level this branch is unreachable in well-formed input — every
      // byte has a vocab entry — so we silently drop. (Defensive: should never
      // happen for valid maps and well-formed UTF-8 input.)
    }
    return ids;
  }
}

/** Convenience one-shot encoder. */
export function bpeEncode(map: TokenizerMap, text: string): number[] {
  return new BPETokenizer(map).encode(text);
}
