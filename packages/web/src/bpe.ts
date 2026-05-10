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
   * Special-token scanner. Built from `map.special_tokens` plus any token in
   * `map.vocab` whose surface form looks like a delimiter (`<|...|>`). HF's
   * reference tokenizer splits input on added/special tokens BEFORE running
   * BPE — emit each match as the atomic vocab ID, BPE the surrounding text.
   * Required for chat templates (`<|im_start|>...<|im_end|>`), tool-call
   * delimiters, FIM markers, etc. to round-trip with HF.
   */
  private readonly specialIds: ReadonlyMap<string, number>;
  private readonly specialRegex: RegExp | null;

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
        // Try `'gv'` first (Unicode-sets mode, ES2025), then `'gu'`,
        // then a desugared form. The `(?i:...)` inline-flag group used
        // by every GPT-2-family pre-tokenizer (qwen2, llama-3, phi-4,
        // tiktoken cl100k/o200k, …) is the ES2025 RegExp Pattern
        // Modifiers feature: Chrome <125 (June 2024), iOS Safari <18,
        // Firefox <132, and Node <23 all throw on it. The desugar
        // fallback rewrites `(?i:abc)` → `(?:[aA][bB][cC])` so encoding
        // works on those runtimes. Maps with `pre_tokenizer_program`
        // bypass this path entirely.
        this.preTokRegex = compilePreTokRegexWithFallback(
          map.pre_tokenizer_pattern,
          map.id,
        );
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

    // Build the special-token scanner. We accept entries from
    // `map.special_tokens` (the canonical source) AND any vocab key that
    // looks like a delimiter (`<|...|>` or `<...>`). Older maps shipped
    // before a chat-template revision may carry the delimiters in `vocab`
    // but not in `special_tokens` — without the vocab-key fallback, those
    // would still tokenise byte-by-byte. Length-descending order makes
    // the regex match the longest delimiter at any position.
    const specialIds = new Map<string, number>();
    for (const [name, id] of Object.entries(map.special_tokens ?? {})) {
      specialIds.set(name, id);
    }
    for (const [tok, id] of vocab) {
      if (specialIds.has(tok)) continue;
      // Heuristic: `<|body|>` where body is non-empty and identifier-like.
      // Every shipped chat-template tokenizer uses this shape (Qwen,
      // Llama-3, Phi-3/4, DeepSeek, Mistral-Nemo, Gemma). The body
      // constraint excludes pathological vocab BPE tokens like `<|>` in
      // Falcon (id 61799) that happen to share the start/end pair.
      if (isDelimiterShape(tok)) specialIds.set(tok, id);
    }
    this.specialIds = specialIds;
    if (specialIds.size > 0) {
      const escaped = Array.from(specialIds.keys())
        .sort((a, b) => b.length - a.length)
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      this.specialRegex = new RegExp(escaped.join('|'), 'g');
    } else {
      this.specialRegex = null;
    }
  }

  /** Encode text → token IDs. */
  encode(text: string): number[] {
    if (text.length === 0) return [];

    // First pass: split on special tokens. Each special is emitted as its
    // single atomic vocab ID; the gaps between specials are BPE-encoded
    // normally. Mirrors HuggingFace's added-token splitter — without this,
    // `<|im_start|>` would tokenize as 6 byte-level tokens instead of one
    // ID, breaking chat-template round-trips on Qwen/Llama-3/Phi/etc.
    if (this.specialRegex !== null) {
      const out: number[] = [];
      this.specialRegex.lastIndex = 0;
      let cursor = 0;
      let m: RegExpExecArray | null;
      while ((m = this.specialRegex.exec(text)) !== null) {
        if (m.index > cursor) this.encodeChunk(text.slice(cursor, m.index), out);
        out.push(this.specialIds.get(m[0])!);
        cursor = m.index + m[0].length;
        if (m[0].length === 0) this.specialRegex.lastIndex++;
      }
      if (cursor < text.length) this.encodeChunk(text.slice(cursor), out);
      return out;
    }

    const ids: number[] = [];
    this.encodeChunk(text, ids);
    return ids;
  }

  /** BPE-encode a chunk of plain text into `out`. */
  private encodeChunk(text: string, out: number[]): void {
    if (text.length === 0) return;
    const pieces = this.preTokenize(text);
    for (const piece of pieces) {
      const cached = this.cache.get(piece);
      if (cached !== undefined) {
        for (let i = 0; i < cached.length; i++) out.push(cached[i]!);
        continue;
      }
      const encoded = this.encodePieceToVocabSpace(piece);
      const merged = this.applyBPE(encoded);
      const pieceIds = this.lookup(merged);
      this.cache.set(piece, pieceIds);
      for (let i = 0; i < pieceIds.length; i++) out.push(pieceIds[i]!);
    }
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

// ── pre-tokenizer regex compilation with runtime-fallback ──────────────────

/**
 * Compile a `pre_tokenizer_pattern` to a RegExp across the runtime matrix
 * we ship to. Three escalating attempts:
 *
 *   1. `'gv'` (Unicode-sets, ES2024) — preferred for newer maps.
 *   2. `'gu'` (Unicode, ES2018) — covers maps that don't need set notation.
 *   3. Desugar `(?i:...)` inline-flag groups, then retry `'gu'`.
 *
 * The third step is what unblocks older runtimes: Chrome <125, iOS Safari
 * <18, Firefox <132, and Node <23 all throw on the ES2025 RegExp Pattern
 * Modifiers syntax that every GPT-2-family pre-tokenizer uses for its
 * contractions group. Desugaring rewrites it to a portable form.
 *
 * Maps that carry `pre_tokenizer_program` skip this path entirely.
 */
export function compilePreTokRegexWithFallback(
  pattern: string,
  mapId: string,
): RegExp {
  // 1. gv (Unicode-sets)
  try {
    return new RegExp(pattern, 'gv');
  } catch { /* fall through */ }

  // 2. gu (Unicode)
  try {
    return new RegExp(pattern, 'gu');
  } catch { /* fall through */ }

  // 3. Desugar `(?i:...)` and retry with `gu`. If the runtime still
  //    rejects, throw with a clear error pointing at the durable fix.
  const desugared = desugarInlineFlagGroups(pattern);
  try {
    return new RegExp(desugared, 'gu');
  } catch (err) {
    throw new Error(
      `BPETokenizer: cannot compile pre_tokenizer_pattern for "${mapId}" ` +
        `on this runtime even after desugaring inline-flag groups. ` +
        `Original error: ${(err as Error).message}. ` +
        `Durable fix: regenerate the map with \`codecai-maps build\` so it ` +
        `carries a \`pre_tokenizer_program\` and skips the regex path.`,
    );
  }
}

/**
 * Match `<|body|>` where `body` is non-empty and identifier-like
 * (letters/digits/`_`/`-`). Catches every shipped chat-template and
 * tool-call delimiter while excluding pathological vocab BPE tokens
 * like Falcon's `<|>` (id 61799) that share the start/end pair.
 */
function isDelimiterShape(tok: string): boolean {
  if (tok.length <= 4) return false;
  if (!tok.startsWith('<|') || !tok.endsWith('|>')) return false;
  const body = tok.slice(2, -2);
  return /^[A-Za-z0-9_-]+$/.test(body);
}

/**
 * Rewrite `(?i:body)` → `(?:body')` where `body'` replaces every cased
 * letter `x` with `[xX]`. Used to make GPT-2-family contractions groups
 * compile on runtimes without ES2025 RegExp Pattern Modifiers.
 *
 * Limitations (acceptable for tokenizer pre-tokenizers, which never
 * exercise these shapes):
 *   - assumes the body has no nested groups or unescaped `)`.
 *   - leaves character classes `[...]` and escapes `\x` alone — only
 *     bare letters are expanded.
 */
export function desugarInlineFlagGroups(pattern: string): string {
  return pattern.replace(/\(\?i:([^)]*)\)/g, (_, body: string) => {
    let out = '';
    let i = 0;
    while (i < body.length) {
      const ch = body[i]!;
      if (ch === '\\' && i + 1 < body.length) {
        // Pass `\x` escapes through unchanged.
        out += ch + body[i + 1];
        i += 2;
        continue;
      }
      if (ch === '[') {
        // Pass character classes through; expanding cased letters inside
        // them would change semantics (a `[a-z]` range is not `[aA-zZ]`).
        const end = body.indexOf(']', i);
        if (end === -1) { out += body.slice(i); break; }
        out += body.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      const upper = ch.toUpperCase();
      const lower = ch.toLowerCase();
      if (upper !== lower) {
        out += '[' + lower + upper + ']';
      } else {
        out += ch;
      }
      i++;
    }
    return '(?:' + out + ')';
  });
}
