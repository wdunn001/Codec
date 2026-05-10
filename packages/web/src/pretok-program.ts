/**
 * Pre-tokenizer program interpreter.
 *
 * Executes a `pre_tokenizer_program` against an input string, producing
 * the same sequence of pieces that the legacy `pre_tokenizer_pattern`
 * regex would have produced. See spec/PRETOKENIZER_PROGRAM.md for the
 * design rationale and op set.
 *
 * The runtime uses native regex for Unicode class queries (\p{L}, \p{N})
 * — no shipped Unicode tables. C and other regex-less runtimes will
 * supply their own class-membership facility.
 *
 * METASPACE op for SentencePiece is delegated to a tiny inline splitter;
 * the rest of this module only handles GPT-2-family op execution.
 */
import { METASPACE } from './encoder.js';

// ── Op types ────────────────────────────────────────────────────────────────

export interface OpLiteralsCi {
  readonly op: 'literals_ci';
  readonly patterns: readonly string[];
}
/** Case-sensitive literal alternatives — like `literals_ci` but matches
 * case-exact. Used by older OpenAI tokenizers (p50k_base, r50k_base) whose
 * contractions group `'s|'t|'re|'ve|'m|'ll|'d` is not wrapped in `(?i:)`. */
export interface OpLiterals {
  readonly op: 'literals';
  readonly patterns: readonly string[];
}
export interface OpLetters {
  readonly op: 'letters';
  /** Match `[^\r\n\p{L}\p{N}]?\p{L}+` — at most one lead char that's none of
   * those. Mutually exclusive with `lead_space`. */
  readonly lead_other?: boolean;
  /** Match ` ?\p{L}+` — at most one literal-space lead. Used by older OpenAI
   * tokenizers. Mutually exclusive with `lead_other`. */
  readonly lead_space?: boolean;
}
export interface OpNumbers {
  readonly op: 'numbers';
  /** Max digit run length. Omit / 0 for unbounded. */
  readonly max_run?: number;
  /** Match ` ?\p{N}+` (or ` ?\p{N}{1,K}`) — at most one literal-space lead.
   * Used by older OpenAI tokenizers. */
  readonly lead_space?: boolean;
}
export interface OpPunctRun {
  readonly op: 'punct_run';
  readonly lead_space?: boolean;
  readonly trailing_newlines?: boolean;
  /** Override `trailing_newlines` with an explicit charset. Each character
   * in the string is accepted in the trailing run. Used by o200k_base /
   * mistral-nemo which trail on `[\r\n/]` (note the `/`) rather than
   * just `[\r\n]`. */
  readonly trailing_chars?: string;
}
/** Cased-letter run with optional trailing case-insensitive contractions.
 * Used by o200k_base / mistral-nemo, which split words on case boundaries
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
  | OpPunctRun | OpNewlineBlock | OpTrailingWs | OpWsRun | OpMetaspace;

export interface PreTokProgram {
  readonly version: number;
  readonly ops: readonly PreTokOp[];
}

// ── Class predicates (native regex; no Unicode data shipped) ─────────────────

const RE_LETTER = /\p{L}/u;
const RE_NUMBER = /\p{N}/u;
/* The pre-tok regex's `\s` is broader than ASCII space — matches Unicode
 * White_Space. We use the same `\s` semantics native regex provides. */
const RE_WS = /\s/u;
/** "Upper cluster" of the o200k_base / mistral-nemo `letters_cased` op.
 * `\p{Lu}` (uppercase) + `\p{Lt}` (titlecase) + the shared `\p{Lm}` /
 * `\p{Lo}` / `\p{M}` set that's also valid in the lower cluster. */
const RE_LETTER_UPPER = /[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]/u;
/** "Lower cluster" — `\p{Ll}` + the shared modifier / other-letter / mark
 * categories. */
const RE_LETTER_LOWER = /[\p{Ll}\p{Lm}\p{Lo}\p{M}]/u;
const isLetter = (cp: string): boolean => RE_LETTER.test(cp);
const isNumber = (cp: string): boolean => RE_NUMBER.test(cp);
const isWs     = (cp: string): boolean => RE_WS.test(cp);
const isLetterUpper = (cp: string): boolean => RE_LETTER_UPPER.test(cp);
const isLetterLower = (cp: string): boolean => RE_LETTER_LOWER.test(cp);

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
    /* `[^\r\n\p{L}\p{N}]?` — at most one char that's none of those. */
    const { cp, next } = nextCp(s, p);
    if (next > p && cp !== '\r' && cp !== '\n' && !isLetter(cp) && !isNumber(cp)) {
      p = next;
    }
  } else if (op.lead_space) {
    /* ` ?` — at most one literal space. */
    if (s.charCodeAt(p) === 0x20) p += 1;
  }
  /* `\p{L}+` */
  const runStart = p;
  while (p < s.length) {
    const { cp, next } = nextCp(s, p);
    if (!isLetter(cp)) break;
    p = next;
  }
  if (p === runStart) {
    /* No letter run — back out the lead char. */
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
  /* `[^\s\p{L}\p{N}]+` */
  let runStart = p;
  while (p < s.length) {
    const { cp, next } = nextCp(s, p);
    if (isWs(cp) || isLetter(cp) || isNumber(cp)) break;
    p = next;
  }
  if (p === runStart) {
    /* No punct run; the lead space alone doesn't constitute a match. */
    return 0;
  }
  // Trailing chars: prefer explicit `trailing_chars` charset (used by
  // o200k_base / mistral-nemo, which trail on `[\r\n/]`). Fall back to
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
  /* `\s*[\r\n]+` — must contain at least one newline. */
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
   * The regex doesn't actually require the run to reach end-of-input —
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

// ── Interpreter loop ────────────────────────────────────────────────────────

/**
 * Run a pre-tokenizer program over an input string.
 *
 * For metaspace-style programs (SentencePiece), recognize the single-op
 * shortcut and delegate to a dedicated splitter — the GPT-2-family loop
 * below isn't applicable.
 */
export function runPreTokProgram(
  prog: PreTokProgram, text: string,
): string[] {
  // Single-op metaspace shortcut.
  if (prog.ops.length === 1 && prog.ops[0]!.op === 'metaspace_split') {
    return runMetaspace(prog.ops[0] as OpMetaspace, text);
  }

  const out: string[] = [];
  const n = text.length;
  let i = 0;
  outer: while (i < n) {
    for (const op of prog.ops) {
      let span = 0;
      switch (op.op) {
        case 'literals_ci':   span = matchLiteralsCi(op, text, i);  break;
        case 'literals':      span = matchLiterals(op, text, i);    break;
        case 'letters':       span = matchLetters(op, text, i);     break;
        case 'letters_cased': span = matchLettersCased(op, text, i); break;
        case 'numbers':       span = matchNumbers(op, text, i);     break;
        case 'punct_run':     span = matchPunctRun(op, text, i);    break;
        case 'newline_block': span = matchNewlineBlock(op, text, i); break;
        case 'trailing_ws':   span = matchTrailingWs(op, text, i);  break;
        case 'ws_run':        span = matchWsRun(op, text, i);       break;
        case 'metaspace_split':
          /* Mixed programs aren't legal — metaspace is single-op. Skip. */
          continue;
      }
      if (span > 0) {
        out.push(text.slice(i, i + span));
        i += span;
        continue outer;
      }
    }
    /* Defensive fallback: no op matched. Emit one Unicode scalar value
     * and advance. Well-formed programs end with `ws_run` (and any
     * non-ws becomes a `letters`/`numbers`/`punct_run` match), so this
     * branch is unreachable for valid GPT-2-family programs but
     * provides graceful degradation if a pathological input slips in. */
    const { cp, next } = nextCp(text, i);
    out.push(cp);
    i = next;
  }
  return out;
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
