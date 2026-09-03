/**
 * Pre-tokenizer program interpreter.
 *
 * Executes a `pre_tokenizer_program` against an input string, producing
 * the same sequence of pieces that the model's real HuggingFace
 * pre-tokenizer would have produced. See spec/PRETOKENIZER_PROGRAM.md for
 * the design rationale and op set.
 *
 * Two program shapes are supported:
 *
 *   - v1 (`{ version: 1, ops: [...] }`): a single flat list of ops tried in
 *     priority order at every cursor position. This is the whole program
 *     for GPT-2-family tokenizers whose HuggingFace pre_tokenizer reduces
 *     to one alternation regex (Qwen, Llama-3/4, Phi-4, o200k, mistral-
 *     nemo, ...), and for SentencePiece metaspace tokenizers via the
 *     single-op `metaspace_split` shortcut.
 *   - v2 (`{ version: 2, stages: [...] }`): an ordered list of STAGES, each
 *     applied to every piece produced by the stage before it (`flatMap`,
 *     exactly mirroring HuggingFace's `Sequence` pre-tokenizer). Required
 *     for sources whose real pre-tokenizer is a Sequence of more than one
 *     kind of stage: SmolLM2 (`Digits` then `ByteLevel`), Falcon
 *     (`Punctuation` then `ByteLevel` then `Digits` then a bounded-digit
 *     `Split`), DeepSeek-V3/R1 (`Split` for digit runs, `Split` for CJK
 *     runs, `Split` for the main alternation). A v1 program cannot express
 *     any of these: collapsing a multi-stage Sequence into one flat
 *     alternation is exactly the bug this version fixes. See
 *     packages/maps-cli/src/convert.ts for the HuggingFace → stages
 *     compiler.
 *
 * The runtime uses native regex for Unicode class queries (\p{L}, \p{N},
 * \p{M}, \p{P}, \p{S}): no shipped Unicode tables. C and other regex-less
 * runtimes supply their own class-membership facility.
 *
 * METASPACE is delegated to a tiny inline splitter; the rest of this module
 * only handles GPT-2-family op/stage execution.
 */
import { METASPACE } from './encoder.js';

// ── Op types (used inside an `alternation` stage, or directly as v1 ops) ────

export interface OpLiteralsCi {
  readonly op: 'literals_ci';
  readonly patterns: readonly string[];
}
/** Case-sensitive literal alternatives: like `literals_ci` but matches
 * case-exact. Used by older OpenAI tokenizers (p50k_base, r50k_base) whose
 * contractions group `'s|'t|'re|'ve|'m|'ll|'d` is not wrapped in `(?i:)`,
 * and by the fixed internal regex `ByteLevel(use_regex=true)` runs when no
 * preceding `Split` stage already handled the text. */
export interface OpLiterals {
  readonly op: 'literals';
  readonly patterns: readonly string[];
}
export interface OpLetters {
  readonly op: 'letters';
  /** Match `[^\r\n\p{L}\p{N}]?\p{L}+` (or the `lead_other_class: 'l_p_s'`
   * variant below): at most one lead char that's none of those. Mutually
   * exclusive with `lead_space`. */
  readonly lead_other?: boolean;
  /** Match ` ?\p{L}+`: at most one literal-space lead. Used by older OpenAI
   * tokenizers. Mutually exclusive with `lead_other`. */
  readonly lead_space?: boolean;
  /** Which class `lead_other` excludes. `'l_n'` (default, and the only
   * value ever shipped before this field existed) excludes `\r`, `\n`,
   * `\p{L}`, `\p{N}`. `'l_p_s'` excludes `\r`, `\n`, `\p{L}`, `\p{P}`,
   * `\p{S}` instead: DeepSeek-V3's third `Split` stage uses this, so a
   * digit or a bare symbol at the lead position is NOT excluded there
   * (only letters, punctuation and other symbols are). Ignored unless
   * `lead_other` is true. */
  readonly lead_other_class?: 'l_n' | 'l_p_s';
  /** Letter-run body class. `'L'` (default, and the only value ever
   * shipped before this field existed) is `\p{L}+`. `'L_M'` is
   * `[\p{L}\p{M}]+`: letters plus combining marks, so a base letter with a
   * combining accent stays one piece instead of splitting the mark off.
   * DeepSeek-V3's third `Split` stage uses this. */
  readonly body?: 'L' | 'L_M';
}
export interface OpNumbers {
  readonly op: 'numbers';
  /** Max digit run length. Omit / 0 for unbounded. */
  readonly max_run?: number;
  /** Match ` ?\p{N}+` (or ` ?\p{N}{1,K}`): at most one literal-space lead.
   * Used by older OpenAI tokenizers. */
  readonly lead_space?: boolean;
}
export interface OpPunctRun {
  readonly op: 'punct_run';
  readonly lead_space?: boolean;
  readonly trailing_newlines?: boolean;
  /** Override `trailing_newlines` with an explicit charset. Each character
   * in the string is accepted in the trailing run. o200k_base /
   * mistral-nemo trailing runs use `[\r\n/]` (note the `/`). */
  readonly trailing_chars?: string;
  /** Run-body class. `'not_ws_L_N'` (default, and the only value ever
   * shipped before this field existed) is `[^\s\p{L}\p{N}]+`: the GPT-2-
   * family complement class. `'p_s'` is `[\p{P}\p{S}]+`: DeepSeek-V3's
   * third `Split` stage names its punctuation/symbol class explicitly
   * rather than by complement, which excludes combining marks and any
   * other leftover category the complement class would otherwise sweep
   * in. */
  readonly charset?: 'not_ws_L_N' | 'p_s';
}
/** One ASCII punctuation character followed by one or more ASCII letters:
 * `[!-\/:-@\[-\`{-~][A-Za-z]+`. This is DeepSeek-V3's third `Split` stage's
 * FIRST alternative, tried before the general letters/punct branches so a
 * token like `'m` in code (an apostrophe glued to identifier letters) comes
 * out as one piece instead of splitting at the apostrophe. No existing op
 * could express this: it is neither a punctuation run (it requires trailing
 * ASCII letters, not more punctuation) nor a letters run (it requires a
 * leading ASCII punctuation character, not an arbitrary lead-other char). */
export interface OpPunctAsciiLetters {
  readonly op: 'punct_ascii_letters';
}
/** Cased-letter run with optional trailing case-insensitive contractions.
 * Used by o200k_base / mistral-nemo. Both split words on case boundaries
 * (e.g. "MyCamelCase" → ["My", "Camel", "Case"]).
 *
 *   kind: "title"  →  [Lu Lt Lm Lo M]* [Ll Lm Lo M]+   (zero-or-more upper, then 1+ lower)
 *   kind: "upper"  →  [Lu Lt Lm Lo M]+ [Ll Lm Lo M]*   (one-or-more upper, then 0+ lower)
 *
 * `lead_other: true` prepends `[^\r\n\p{L}\p{N}]?` (the conventional GPT-2
 * lead-other guard). `trailing_ci`, when set, is the same as the legacy
 * `literals_ci` ASCII case-fold semantics. */
export interface OpLettersCased {
  readonly op: 'letters_cased';
  readonly kind: 'title' | 'upper';
  readonly lead_other?: boolean;
  readonly trailing_ci?: readonly string[];
}
export interface OpNewlineBlock { readonly op: 'newline_block' }
export interface OpTrailingWs   { readonly op: 'trailing_ws' }
export interface OpWsRun        { readonly op: 'ws_run' }
export interface OpMetaspace {
  readonly op: 'metaspace_split';
  readonly prefix_first?: boolean;
}

export type PreTokOp =
  | OpLiteralsCi | OpLiterals | OpLetters | OpLettersCased | OpNumbers
  | OpPunctRun | OpPunctAsciiLetters | OpNewlineBlock | OpTrailingWs
  | OpWsRun | OpMetaspace;

// ── v2 stage types ───────────────────────────────────────────────────────
//
// Each stage transforms the FULL current list of pieces via flatMap: every
// existing piece is fed through the stage independently and the results
// are concatenated in order. This mirrors HuggingFace's `Sequence`
// pre-tokenizer exactly: each sub-pretokenizer runs over every span the
// previous ones already produced.

export interface StageDigitsIsolate {
  readonly stage: 'digits_isolate';
  /** `'individual'`: every digit becomes its own piece (HuggingFace
   * `Digits(individual_digits=true)`, SmolLM2). `'grouped'`: consecutive
   * digits stay together as one piece, chunked to `max_run` when set
   * (HuggingFace `Digits(individual_digits=false)`, Falcon; or a `Split`
   * on `\p{N}{1,K}`/`\p{N}+` with `Isolated` behavior, DeepSeek-V3's first
   * stage with `max_run: 3`). */
  readonly mode: 'individual' | 'grouped';
  /** Only meaningful when `mode: 'grouped'`. Omit for unbounded. */
  readonly max_run?: number;
}
/** HuggingFace `Split("[0-9][0-9][0-9]", Isolated)`: Falcon's fourth
 * stage. Exact non-overlapping windows of 3 ASCII digits, scanned
 * left-to-right; a run of digits not itself a multiple of 3 leaves a
 * remainder that stays ungrouped (part of the surrounding non-match
 * span), it is NOT itself chunked. This is deliberately distinct from
 * `digits_isolate`'s `max_run`, which chunks a `\p{N}` RUN into pieces of
 * at most K digits with no remainder left behind: `[0-9][0-9][0-9]` only
 * ever produces exactly-3-digit pieces or leaves digits alone. */
export interface StageDigitTriplesIsolate {
  readonly stage: 'digit_triples_isolate';
}
/** HuggingFace `Punctuation(Contiguous)`. Classifies each character as
 * ASCII-punctuation-or-`\p{P}` versus everything else, and groups maximal
 * runs of the same classification into one piece each (not one piece per
 * character). Falcon's first stage. */
export interface StagePunctuationContiguous {
  readonly stage: 'punctuation_contiguous';
}
/** HuggingFace `Split([一-龥぀-ゟ゠-ヿ]+, Isolated)`: DeepSeek-V3's second
 * stage. Isolates maximal runs of CJK Unified Ideographs (the model's own
 * literal range, U+4E00-U+9FA5: NOT the full Unicode block, which runs to
 * U+9FFF), Hiragana (U+3040-U+309F) and Katakana (U+30A0-U+30FF) as their
 * own pieces, so a CJK run never merges with adjacent Latin text or a
 * preceding space. */
export interface StageCjkIsolate {
  readonly stage: 'cjk_isolate';
}
/** The GPT-2-style "try every op in priority order, take the first
 * non-empty match, advance" scanner, scoped to one stage. This is what a
 * `ByteLevel(use_regex=true)` stage always runs (its internal regex is a
 * HuggingFace-crate constant, never a per-model value), and what a `Split`
 * stage runs when its regex is one of the recognised exhaustive
 * alternation shapes (GPT-2-family, the older OpenAI shape, the
 * o200k/mistral-nemo cased-letter shape, or DeepSeek-V3's third-stage
 * shape). */
export interface StageAlternation {
  readonly stage: 'alternation';
  readonly ops: readonly PreTokOp[];
}

export type PreTokStage =
  | StageDigitsIsolate | StageDigitTriplesIsolate | StagePunctuationContiguous
  | StageCjkIsolate | StageAlternation;

export interface PreTokProgramV1 {
  readonly version: 1;
  readonly ops: readonly PreTokOp[];
}
export interface PreTokProgramV2 {
  readonly version: 2;
  readonly stages: readonly PreTokStage[];
}
export type PreTokProgram = PreTokProgramV1 | PreTokProgramV2;

// ── Class predicates (native regex; no Unicode data shipped) ─────────────────

const RE_LETTER = /\p{L}/u;
const RE_NUMBER = /\p{N}/u;
const RE_MARK   = /\p{M}/u;
const RE_PUNCT  = /\p{P}/u;
const RE_SYMBOL = /\p{S}/u;
/* The pre-tok regex's `\s` is Unicode White_Space. See
 * spec/PRETOKENIZER_PROGRAM.md § Class membership.
 *
 * This must NOT be JavaScript's native `/\s/u`. That is a different set.
 * Native `\s` excludes U+0085 NEXT LINE. That code point is neither a line
 * terminator nor category Zs. Native `\s` also includes U+FEFF ZERO WIDTH
 * NO-BREAK SPACE. Unicode does not classify that one as White_Space either.
 * The C runtime's table in packages/c/src/codec_unicode_tables.c and Rust's
 * `regex` crate both use \p{White_Space} exactly. Using native `\s` here
 * split the same input differently in TypeScript than in every other
 * implementation. That breaks the byte-equivalence the whole format rests
 * on. A differential run of the Qwen-2 program over 10316 inputs disagreed
 * with C on 1074 of them.
 *
 * The property escape tracks the engine's Unicode version. That is what the
 * spec asks for: the tables belong to the runtime; the map stays free of
 * them. */
const RE_WS = /\p{White_Space}/u;
/** "Upper cluster" of the o200k_base / mistral-nemo `letters_cased` op.
 * `\p{Lu}` (uppercase) + `\p{Lt}` (titlecase) + the shared `\p{Lm}` /
 * `\p{Lo}` / `\p{M}` set that's also valid in the lower cluster. */
const RE_LETTER_UPPER = /[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]/u;
/** "Lower cluster": `\p{Ll}` + the shared modifier / other-letter / mark
 * categories. */
const RE_LETTER_LOWER = /[\p{Ll}\p{Lm}\p{Lo}\p{M}]/u;
/** ASCII punctuation, `[!-\/:-@\[-\`{-~]`: the 32 chars HuggingFace's
 * `is_ascii_punctuation` accepts. Shared by `punct_ascii_letters` and
 * `punctuation_contiguous`. */
const RE_ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
const isLetter = (cp: string): boolean => RE_LETTER.test(cp);
const isNumber = (cp: string): boolean => RE_NUMBER.test(cp);
const isMark   = (cp: string): boolean => RE_MARK.test(cp);
const isPunct  = (cp: string): boolean => RE_PUNCT.test(cp);
const isSymbol = (cp: string): boolean => RE_SYMBOL.test(cp);
const isWs     = (cp: string): boolean => RE_WS.test(cp);
const isLetterUpper = (cp: string): boolean => RE_LETTER_UPPER.test(cp);
const isLetterLower = (cp: string): boolean => RE_LETTER_LOWER.test(cp);
const isAsciiPunct  = (cp: string): boolean => RE_ASCII_PUNCT.test(cp);

/** Returns the next code point at index `i` and the index after it. */
function nextCp(s: string, i: number): { cp: string; next: number } {
  const code = s.codePointAt(i)!;
  const cp   = String.fromCodePoint(code);
  return { cp, next: i + cp.length };
}

// ── Per-op matchers ─────────────────────────────────────────────────────────
//
// Each matcher returns the number of UTF-16 code units consumed at
// position `i`, or 0 if it doesn't match. The interpreter loop then
// emits that span and advances.

function matchLiteralsCi(op: OpLiteralsCi, s: string, i: number): number {
  let best = 0;
  for (const p of op.patterns) {
    if (p.length <= best) continue;
    if (i + p.length > s.length) continue;
    let ok = true;
    for (let k = 0; k < p.length; k++) {
      const a = s.charCodeAt(i + k);
      const b = p.charCodeAt(k);
      if (a === b) continue;
      // ASCII case fold
      if (a >= 65 && a <= 90  && a + 32 === b) continue;
      if (a >= 97 && a <= 122 && a - 32 === b) continue;
      ok = false; break;
    }
    if (ok) best = p.length;
  }
  return best;
}

function matchLiterals(op: OpLiterals, s: string, i: number): number {
  let best = 0;
  for (const p of op.patterns) {
    if (p.length <= best) continue;
    if (i + p.length > s.length) continue;
    let ok = true;
    for (let k = 0; k < p.length; k++) {
      if (s.charCodeAt(i + k) !== p.charCodeAt(k)) { ok = false; break; }
    }
    if (ok) best = p.length;
  }
  return best;
}

function matchLetters(op: OpLetters, s: string, i: number): number {
  let p = i;
  if (op.lead_other) {
    /* `[^\r\n\p{L}\p{N}]?` (default `lead_other_class: 'l_n'`), or
     * `[^\r\n\p{L}\p{P}\p{S}]?` for `lead_other_class: 'l_p_s'`: at most
     * one char that's none of the excluded classes. */
    const { cp, next } = nextCp(s, p);
    const excluded = next > p && cp !== '\r' && cp !== '\n' && !isLetter(cp) && (
      op.lead_other_class === 'l_p_s' ? (!isPunct(cp) && !isSymbol(cp)) : !isNumber(cp)
    );
    if (excluded) p = next;
  } else if (op.lead_space) {
    /* ` ?`: at most one literal space. */
    if (s.charCodeAt(p) === 0x20) p += 1;
  }
  /* `\p{L}+` (default `body: 'L'`), or `[\p{L}\p{M}]+` for `body: 'L_M'`. */
  const runStart = p;
  const bodyOk = op.body === 'L_M'
    ? (cp: string): boolean => isLetter(cp) || isMark(cp)
    : isLetter;
  while (p < s.length) {
    const { cp, next } = nextCp(s, p);
    if (!bodyOk(cp)) break;
    p = next;
  }
  if (p === runStart) {
    /* No letter run: back out the lead char. */
    return 0;
  }
  return p - i;
}

function matchNumbers(op: OpNumbers, s: string, i: number): number {
  let p = i;
  if (op.lead_space && s.charCodeAt(p) === 0x20) p += 1;
  const runStart = p;
  let count = 0;
  const max = op.max_run && op.max_run > 0 ? op.max_run : Infinity;
  while (p < s.length && count < max) {
    const { cp, next } = nextCp(s, p);
    if (!isNumber(cp)) break;
    p = next;
    count++;
  }
  if (p === runStart) return 0;
  return p - i;
}

function matchPunctRun(op: OpPunctRun, s: string, i: number): number {
  let p = i;
  if (op.lead_space) {
    if (s.charCodeAt(p) === 0x20) p += 1;
  }
  /* `[^\s\p{L}\p{N}]+` (default `charset: 'not_ws_L_N'`), or
   * `[\p{P}\p{S}]+` for `charset: 'p_s'`. */
  const runStart = p;
  const inRun = op.charset === 'p_s'
    ? (cp: string): boolean => isPunct(cp) || isSymbol(cp)
    : (cp: string): boolean => !isWs(cp) && !isLetter(cp) && !isNumber(cp);
  while (p < s.length) {
    const { cp, next } = nextCp(s, p);
    if (!inRun(cp)) break;
    p = next;
  }
  if (p === runStart) {
    /* No punct run; the lead space alone doesn't constitute a match. */
    return 0;
  }
  // Trailing chars: prefer explicit `trailing_chars` charset (o200k_base /
  // mistral-nemo trailing runs use `[\r\n/]`). Fall back to
  // the legacy `trailing_newlines: true` boolean → `\r\n`.
  if (op.trailing_chars !== undefined) {
    while (p < s.length && op.trailing_chars.indexOf(s.charAt(p)) >= 0) {
      p++;
    }
  } else if (op.trailing_newlines) {
    while (p < s.length) {
      const c = s.charCodeAt(p);
      if (c === 0x0A || c === 0x0D) p++;
      else break;
    }
  }
  return p - i;
}

/** `[!-\/:-@\[-\`{-~][A-Za-z]+`: one ASCII punctuation char, then 1+ ASCII
 * letters. ASCII punctuation is always a single UTF-16 code unit, so no
 * surrogate-pair handling is needed for the lead char. */
function matchPunctAsciiLetters(_op: OpPunctAsciiLetters, s: string, i: number): number {
  if (i >= s.length) return 0;
  if (!isAsciiPunct(s[i]!)) return 0;
  let p = i + 1;
  const runStart = p;
  while (p < s.length) {
    const c = s.charCodeAt(p);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) break;
    p++;
  }
  if (p === runStart) return 0; // need at least one ASCII letter
  return p - i;
}

function matchLettersCased(op: OpLettersCased, s: string, i: number): number {
  let p = i;
  if (op.lead_other) {
    const { cp, next } = nextCp(s, p);
    if (next > p && cp !== '\r' && cp !== '\n' && !isLetter(cp) && !isNumber(cp)) {
      p = next;
    }
  }

  // Greedily consume prefix-set chars and record each step as a candidate
  // suffix-start checkpoint. Lm/Lo/M are in BOTH sets so the longest
  // match may need to backtrack one or more chars from the greedy run
  // to let the suffix consume them. We try suffix from each checkpoint
  // longest-first; first match wins.
  const checkpoints: number[] = [p];
  while (p < s.length) {
    const { cp, next } = nextCp(s, p);
    if (!isLetterUpper(cp)) break;
    p = next;
    checkpoints.push(p);
  }

  const minPrefix = op.kind === 'upper' ? 1 : 0;
  const minSuffix = op.kind === 'title' ? 1 : 0;

  for (let k = checkpoints.length - 1; k >= 0; k--) {
    if (k < minPrefix) break; // not enough prefix chars, regardless of suffix
    let q = checkpoints[k]!;
    let suffixCount = 0;
    while (q < s.length) {
      const { cp, next } = nextCp(s, q);
      if (!isLetterLower(cp)) break;
      q = next;
      suffixCount++;
    }
    if (suffixCount < minSuffix) continue;

    // Optional case-insensitive trailing contractions, longest match wins.
    if (op.trailing_ci && op.trailing_ci.length > 0) {
      let best = 0;
      for (const pat of op.trailing_ci) {
        if (pat.length <= best || q + pat.length > s.length) continue;
        let ok = true;
        for (let m = 0; m < pat.length; m++) {
          const a = s.charCodeAt(q + m);
          const b = pat.charCodeAt(m);
          if (a === b) continue;
          if (a >= 65 && a <= 90  && a + 32 === b) continue;
          if (a >= 97 && a <= 122 && a - 32 === b) continue;
          ok = false; break;
        }
        if (ok) best = pat.length;
      }
      q += best;
    }

    return q - i;
  }
  return 0;
}

function matchNewlineBlock(_op: OpNewlineBlock, s: string, i: number): number {
  /* `\s*[\r\n]+`: must contain at least one newline. */
  let p = i;
  let lastNonNl = p;
  /* Greedy \s* */
  while (p < s.length) {
    const { cp, next } = nextCp(s, p);
    if (!isWs(cp)) break;
    if (cp !== '\r' && cp !== '\n') lastNonNl = next;
    p = next;
  }
  /* Now back up to the start of the trailing [\r\n]+ run. */
  /* The regex form `\s*[\r\n]+` gobbles \s* greedily, then requires a
   * newline at the position after it. Standard regex implementations
   * backtrack the \s* to find a newline-anchor. We replicate by
   * scanning forward: find the last index ≤ p that contains a newline,
   * and require at least one. */
  /* Scan from the original i: find first newline, consume everything
   * up through the contiguous newline run. */
  let firstNl = -1;
  for (let q = i; q < p; q++) {
    const c = s.charCodeAt(q);
    if (c === 0x0A || c === 0x0D) { firstNl = q; break; }
  }
  if (firstNl < 0) return 0;
  /* We need to consume [\s* up through final newline run]. The match
   * spans from i through the last contiguous run of newlines that
   * starts somewhere within [firstNl, p). Since regex `\s*[\r\n]+` is
   * the same as "all whitespace ending in a newline", we trim back any
   * trailing non-newline whitespace from p. */
  let q = p;
  while (q > firstNl) {
    const c = s.charCodeAt(q - 1);
    if (c === 0x0A || c === 0x0D) break;
    q--;
  }
  return q - i;
  void lastNonNl;
}

function matchTrailingWs(_op: OpTrailingWs, s: string, i: number): number {
  /* `\s+(?!\S)` with backtracking semantics.
   *
   * The regex doesn't actually require the run to reach end-of-input:
   * it requires the character AFTER the matched span to not be \S
   * (non-whitespace). Since whitespace itself satisfies `not \S`, the
   * regex engine backs off `\s+` until either the run ends at EOI
   * (whole run matches) or the position after the match is whitespace
   * (one code point shorter than the maximal run). The longest viable
   * match is therefore:
   *   - whole run, if run ends at EOI
   *   - run length minus the final whitespace code point, if it ends
   *     at non-whitespace
   * Returns 0 when there's no match (single-cp run followed by \S, or
   * not whitespace at all).
   */
  let p = i;
  while (p < s.length) {
    const { cp, next } = nextCp(s, p);
    if (!isWs(cp)) break;
    p = next;
  }
  if (p === i) return 0;           // not whitespace at all
  if (p === s.length) return p - i; // run reaches EOI → match whole run

  // Followed by non-whitespace. Truncate before the LAST whitespace
  // code point in the run.
  let q = i;
  let lastStart = i;
  while (q < p) {
    lastStart = q;
    q = nextCp(s, q).next;
  }
  return lastStart - i;            // 0 if run was a single code point
}

function matchWsRun(_op: OpWsRun, s: string, i: number): number {
  let p = i;
  while (p < s.length) {
    const { cp, next } = nextCp(s, p);
    if (!isWs(cp)) break;
    p = next;
  }
  return p - i;
}

// ── Alternation scanner (v1 whole-program loop, and the v2 `alternation`
//    stage) ────────────────────────────────────────────────────────────────

/** Try every op in `ops`, in priority order, at position `i`. Returns the
 * first non-empty match's span, or 0 if none match. */
function tryOpsAt(ops: readonly PreTokOp[], text: string, i: number): number {
  for (const op of ops) {
    switch (op.op) {
      case 'literals_ci':         { const s = matchLiteralsCi(op, text, i);      if (s > 0) return s; break; }
      case 'literals':            { const s = matchLiterals(op, text, i);        if (s > 0) return s; break; }
      case 'letters':             { const s = matchLetters(op, text, i);         if (s > 0) return s; break; }
      case 'letters_cased':       { const s = matchLettersCased(op, text, i);    if (s > 0) return s; break; }
      case 'numbers':             { const s = matchNumbers(op, text, i);         if (s > 0) return s; break; }
      case 'punct_run':           { const s = matchPunctRun(op, text, i);        if (s > 0) return s; break; }
      case 'punct_ascii_letters': { const s = matchPunctAsciiLetters(op, text, i); if (s > 0) return s; break; }
      case 'newline_block':       { const s = matchNewlineBlock(op, text, i);    if (s > 0) return s; break; }
      case 'trailing_ws':         { const s = matchTrailingWs(op, text, i);      if (s > 0) return s; break; }
      case 'ws_run':              { const s = matchWsRun(op, text, i);           if (s > 0) return s; break; }
      case 'metaspace_split':
        /* Mixed programs aren't legal: metaspace is single-op (v1) and
         * never appears inside an `alternation` stage (v2). Skip. */
        break;
    }
  }
  return 0;
}

/**
 * Try every op in `ops`, in priority order, at each cursor position;
 * consume the first non-empty match and advance. This is the whole v1
 * program's execution model, and one v2 `alternation` stage's execution
 * model (scoped to a single input piece rather than the whole original
 * text).
 *
 * When NO op matches at a position, this is `Split(..., Isolated)` GAP
 * behavior: consume the maximal run of consecutive non-matching positions
 * as ONE piece, verbatim, rather than shattering it one Unicode scalar at
 * a time. For a GPT-2-family op list running directly over raw text (v1
 * programs, and a v2 `alternation` stage that is the program's only
 * stage), this list is exhaustive over every Unicode scalar value and the
 * branch is unreachable. It becomes reachable, and matters, once an
 * earlier v2 stage has already stripped a character class this
 * alternation's ops were never meant to see: DeepSeek-V3's third stage
 * receives whole digit-run and CJK-run pieces from the two stages before
 * it, and its own ops have no digit or CJK branch at all (those stages
 * already isolated them). Shattering such a piece one scalar at a time,
 * the way the OLD single-loop interpreter effectively did by construction
 * (it only ever saw raw unprocessed text), is exactly the kind of silent
 * wrong-shaped output this format exists to prevent: it would turn a
 * three-digit piece "123" into three separate one-digit pieces instead of
 * passing it through untouched.
 */
function runAlternationOps(ops: readonly PreTokOp[], text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const span = tryOpsAt(ops, text, i);
    if (span > 0) {
      out.push(text.slice(i, i + span));
      i += span;
      continue;
    }
    let j = nextCp(text, i).next;
    while (j < n && tryOpsAt(ops, text, j) === 0) {
      j = nextCp(text, j).next;
    }
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

// ── v2 stage executors ──────────────────────────────────────────────────────

function stageDigitsIsolate(op: StageDigitsIsolate, piece: string): string[] {
  const out: string[] = [];
  let buf = '';
  let numBuf = '';
  let numCount = 0;
  const max = op.max_run && op.max_run > 0 ? op.max_run : Infinity;
  for (const cp of piece) {
    if (isNumber(cp)) {
      if (buf) { out.push(buf); buf = ''; }
      if (op.mode === 'individual') {
        out.push(cp);
      } else {
        if (numCount >= max) { out.push(numBuf); numBuf = ''; numCount = 0; }
        numBuf += cp;
        numCount++;
      }
    } else {
      if (numBuf) { out.push(numBuf); numBuf = ''; numCount = 0; }
      buf += cp;
    }
  }
  if (numBuf) out.push(numBuf);
  if (buf) out.push(buf);
  return out;
}

function isAsciiDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

/** Exact non-overlapping windows of 3 ASCII digits, scanned left-to-right.
 * ASCII digits are always a single UTF-16 code unit, so plain indexing is
 * safe here (no surrogate-pair concern). */
function stageDigitTriplesIsolate(piece: string): string[] {
  const out: string[] = [];
  const n = piece.length;
  let last = 0;
  let i = 0;
  while (i + 3 <= n) {
    if (isAsciiDigit(piece[i]!) && isAsciiDigit(piece[i + 1]!) && isAsciiDigit(piece[i + 2]!)) {
      if (i > last) out.push(piece.slice(last, i));
      out.push(piece.slice(i, i + 3));
      i += 3;
      last = i;
    } else {
      i += 1;
    }
  }
  if (last < n) out.push(piece.slice(last));
  return out;
}

function stagePunctuationContiguous(piece: string): string[] {
  const out: string[] = [];
  let buf = '';
  let pBuf = '';
  for (const cp of piece) {
    if (isAsciiPunct(cp) || isPunct(cp)) {
      if (buf) { out.push(buf); buf = ''; }
      pBuf += cp;
    } else {
      if (pBuf) { out.push(pBuf); pBuf = ''; }
      buf += cp;
    }
  }
  if (pBuf) out.push(pBuf);
  if (buf) out.push(buf);
  return out;
}

/** DeepSeek-V3's literal CJK ranges: U+4E00-U+9FA5 (its own bound, short of
 * the full CJK Unified Ideographs block at U+9FFF), Hiragana U+3040-U+309F,
 * Katakana U+30A0-U+30FF. */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x4E00, 0x9FA5],
  [0x3040, 0x309F],
  [0x30A0, 0x30FF],
];

function isCjk(cp: string): boolean {
  const code = cp.codePointAt(0)!;
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

function stageCjkIsolate(piece: string): string[] {
  const out: string[] = [];
  const n = piece.length;
  let last = 0;
  let i = 0;
  while (i < n) {
    const { cp, next } = nextCp(piece, i);
    if (isCjk(cp)) {
      if (i > last) out.push(piece.slice(last, i));
      let j = next;
      while (j < n) {
        const step = nextCp(piece, j);
        if (!isCjk(step.cp)) break;
        j = step.next;
      }
      out.push(piece.slice(i, j));
      i = j;
      last = j;
    } else {
      i = next;
    }
  }
  if (last < n) out.push(piece.slice(last));
  return out;
}

function runStage(stage: PreTokStage, piece: string): string[] {
  switch (stage.stage) {
    case 'digits_isolate':         return stageDigitsIsolate(stage, piece);
    case 'digit_triples_isolate':  return stageDigitTriplesIsolate(piece);
    case 'punctuation_contiguous': return stagePunctuationContiguous(piece);
    case 'cjk_isolate':            return stageCjkIsolate(piece);
    case 'alternation':            return runAlternationOps(stage.ops, piece);
  }
}

// ── Interpreter entry point ─────────────────────────────────────────────────

/**
 * Run a pre-tokenizer program over an input string.
 *
 * v1 programs run as a single alternation scan over the whole text (with
 * the single-op metaspace shortcut handled first). v2 programs run each
 * stage over the piece list produced by the stage before it, mirroring
 * HuggingFace's `Sequence` pre-tokenizer.
 */
export function runPreTokProgram(prog: PreTokProgram, text: string): string[] {
  if (prog.version === 1) {
    // Single-op metaspace shortcut.
    if (prog.ops.length === 1 && prog.ops[0]!.op === 'metaspace_split') {
      return runMetaspace(prog.ops[0] as OpMetaspace, text);
    }
    return runAlternationOps(prog.ops, text);
  }
  if (prog.version === 2) {
    let pieces: string[] = [text];
    for (const stage of prog.stages) {
      pieces = pieces.flatMap((p) => runStage(stage, p));
    }
    return pieces.filter((p) => p.length > 0);
  }
  // Unknown version: refuse to guess at execution semantics. A newer
  // program version may use stage/op kinds this interpreter has never
  // heard of; silently running it as v1 or v2 risks emitting a
  // plausible-looking but wrong split, which is exactly the failure mode
  // this format exists to prevent. See spec/PRETOKENIZER_PROGRAM.md §
  // Versioning.
  const v = (prog as { version: unknown }).version;
  throw new Error(
    `runPreTokProgram: unsupported pre_tokenizer_program version ${JSON.stringify(v)}. ` +
      'This client understands versions 1 and 2. Upgrade the client to use this map.',
  );
}

function runMetaspace(op: OpMetaspace, text: string): string[] {
  const out: string[] = [];
  const trimmed = text.replace(/[ \t]+/g, ' ');
  const parts = trimmed.split(/(\s)/).filter((p) => p.length > 0);
  let isFirst = true;
  for (const p of parts) {
    if (p === ' ') { isFirst = false; continue; }
    if (op.prefix_first && isFirst) {
      out.push(p);
    } else {
      out.push(METASPACE + p);
    }
    isFirst = false;
  }
  return out;
}
