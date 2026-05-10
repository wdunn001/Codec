/**
 * Pre-tokenizer regex → program compiler.
 *
 * Recognizes the known pre-tokenizer regex shapes used by the major
 * tokenizer families and emits a `pre_tokenizer_program` that the
 * runtime interpreter can execute without a regex engine. See
 * spec/PRETOKENIZER_PROGRAM.md for the spec.
 *
 * The compiler is intentionally conservative: it pattern-matches a
 * known set of regexes (canonicalized whitespace), and returns
 * `null` for anything else. Maps for unrecognised tokenizers keep
 * `pre_tokenizer_pattern` only — old behavior preserved.
 *
 * The tradeoff: a hand-rolled regex parser would let us handle
 * arbitrary tokenizer regexes, but the regex flavour is ad-hoc per
 * model family and most just clone Llama-3 / Qwen / DeepSeek anyway.
 * Pattern matching the canonical forms gets us 99%+ coverage with no
 * parser maintenance burden.
 */

export type PreTokOp =
  | { op: 'literals_ci'; patterns: string[] }
  | { op: 'literals'; patterns: string[] }
  | { op: 'letters'; lead_other?: boolean; lead_space?: boolean }
  | { op: 'numbers'; max_run?: number; lead_space?: boolean }
  | { op: 'punct_run'; lead_space?: boolean; trailing_newlines?: boolean }
  | { op: 'newline_block' }
  | { op: 'trailing_ws' }
  | { op: 'ws_run' }
  | { op: 'metaspace_split'; prefix_first?: boolean };

export interface PreTokProgram {
  version: number;
  ops: PreTokOp[];
}

/**
 * Compile a pre-tokenizer regex string into a program. Returns `null`
 * if the regex is not one of the recognised canonical forms.
 *
 * Recognised forms (all GPT-2-family with optional digit-run cap):
 *
 *   (?i:'s|'t|'re|'ve|'m|'ll|'d)
 *     |[^\r\n\p{L}\p{N}]?\p{L}+
 *     |\p{N}{1,K}?            // K omitted = unbounded
 *     | ?[^\s\p{L}\p{N}]+[\r\n]*
 *     |\s*[\r\n]+
 *     |\s+(?!\S)
 *     |\s+
 */
export function compilePreTokenizerRegex(regex: string): PreTokProgram | null {
  // Normalise whitespace and any escape variants.
  const r = canonicalize(regex);

  // Try the older OpenAI shape first (p50k_base, r50k_base): case-
  // sensitive literal contractions, ` ?\p{L}+`, ` ?\p{N}+`, ` ?[^...]`,
  // trailing_ws, ws_run. Distinguishable from the GPT-2 canonical shape
  // by the absence of a `(?i:...)` group and the lead-space variants on
  // letters/numbers.
  const oldOpenAi = tryCompileOldOpenAi(r);
  if (oldOpenAi) return oldOpenAi;

  // GPT-2-family alternation. We split on top-level `|` (the regex has no
  // nested groups that would contain unescaped `|` aside from the
  // contractions group, which is `(?i:...)` and we handle it specially).
  const parts = splitTopLevelAlt(r);
  if (parts.length < 7 || parts.length > 8) return null;

  const ops: PreTokOp[] = [];

  // 1. (?i:'s|'t|'re|'ve|'m|'ll|'d) — contractions
  const contractions = parseContractionsGroup(parts[0]!);
  if (!contractions) return null;
  ops.push({ op: 'literals_ci', patterns: contractions });

  // 2. [^\r\n\p{L}\p{N}]?\p{L}+ — letters with optional non-letter lead
  if (!matchEq(parts[1]!, ['[^\\r\\n\\p{L}\\p{N}]?\\p{L}+'])) return null;
  ops.push({ op: 'letters', lead_other: true });

  // 3. \p{N} (single-digit, Qwen-style) or \p{N}{1,K} (Llama-3) or \p{N}+ (unbounded)
  //    `\p{N}` with no quantifier matches ONE digit per regex iteration —
  //    the engine then re-enters the alternation, so digit runs come out
  //    one digit at a time. We model that as max_run=1.
  const nMatch = parts[2]!.match(/^\\p\{N\}(?:(\+)|\{1,(\d+)\}\??)?$/);
  if (!nMatch) return null;
  let maxRun: number;
  if (nMatch[1] === '+') maxRun = 0;             // unbounded
  else if (nMatch[2]) maxRun = parseInt(nMatch[2], 10);
  else maxRun = 1;                                // bare \p{N} → one digit
  ops.push(maxRun > 0 ? { op: 'numbers', max_run: maxRun } : { op: 'numbers' });

  // 4.  ?[^\s\p{L}\p{N}]+[\r\n]* — punct run with leading space + trailing newlines
  if (!matchEq(parts[3]!, [' ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*'])) return null;
  ops.push({ op: 'punct_run', lead_space: true, trailing_newlines: true });

  // 5. \s*[\r\n]+
  if (!matchEq(parts[4]!, ['\\s*[\\r\\n]+'])) return null;
  ops.push({ op: 'newline_block' });

  // 6. \s+(?!\S)
  if (!matchEq(parts[5]!, ['\\s+(?!\\S)'])) return null;
  ops.push({ op: 'trailing_ws' });

  // 7. \s+ (catchall)
  if (!matchEq(parts[6]!, ['\\s+'])) return null;
  ops.push({ op: 'ws_run' });

  // Some maps emit a trailing capture group around the whole regex,
  // which appears as an empty alt at the end. Tolerate.
  if (parts.length === 8 && parts[7]!.length > 0) return null;

  return { version: 1, ops };
}

/**
 * Build a metaspace program. Used directly for SentencePiece-family
 * encoders since they don't have a regex `pre_tokenizer_pattern`.
 */
export function metaspaceProgram(opts: { prefix_first?: boolean } = {}): PreTokProgram {
  const op: PreTokOp = { op: 'metaspace_split' };
  if (opts.prefix_first) op.prefix_first = true;
  return { version: 1, ops: [op] };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function canonicalize(s: string): string {
  // Strip surrounding parentheses if the entire regex is parenthesized
  // exactly once. Some HF tokenizer.json files wrap the alternation.
  let r = s;
  if (r.startsWith('(') && r.endsWith(')') && balancedTopLevel(r.slice(1, -1))) {
    r = r.slice(1, -1);
  }
  return r;
}

function balancedTopLevel(s: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) { i++; continue; }
    if (!inClass && c === '[') inClass = true;
    else if (inClass && c === ']') inClass = false;
    else if (!inClass && c === '(') depth++;
    else if (!inClass && c === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function splitTopLevelAlt(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) { i++; continue; }
    if (!inClass && c === '[') inClass = true;
    else if (inClass && c === ']') inClass = false;
    else if (!inClass && c === '(') depth++;
    else if (!inClass && c === ')') depth--;
    else if (!inClass && depth === 0 && c === '|') {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function parseContractionsGroup(s: string): string[] | null {
  // Accept (?i:p1|p2|...) or (?:(?i:p1|p2|...)) shapes.
  let m = s.match(/^\(\?i:(.+)\)$/);
  if (!m) m = s.match(/^\(\?:\(\?i:(.+)\)\)$/);
  if (!m) return null;
  const inner = m[1]!;
  const parts = splitTopLevelAlt(inner);
  // All parts must be plain literals (no regex metachars).
  for (const p of parts) {
    if (/[\\\[\](){}^$.*+?|]/.test(p)) return null;
  }
  return parts;
}

function matchEq(actual: string, candidates: string[]): boolean {
  return candidates.includes(actual);
}

/**
 * Recognise the older OpenAI shape used by `p50k_base`, `p50k_edit`, and
 * `r50k_base` — the pre-tokenizer that `ByteLevel.use_regex: true` invokes
 * internally before the (?i:) inline-flag group was added in cl100k_base.
 *
 *   's|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+
 *
 * Top-level alts: 7 contractions (literal, case-sensitive) + 5 rules
 * (letters_lead_space, numbers_lead_space, punct_lead_space, trailing_ws,
 * ws_run) = 12 parts. The earlier GPT-2 alt-form has 7-8 parts because its
 * contractions are wrapped in `(?i:...)` as a single alt.
 */
function tryCompileOldOpenAi(r: string): PreTokProgram | null {
  const parts = splitTopLevelAlt(r);
  if (parts.length !== 12) return null;

  // 1-7. Plain literal contractions, in canonical order.
  const expectedContractions = ["'s", "'t", "'re", "'ve", "'m", "'ll", "'d"];
  for (let i = 0; i < 7; i++) {
    if (parts[i] !== expectedContractions[i]) return null;
  }

  // 8. ` ?\p{L}+`
  if (!matchEq(parts[7]!, [' ?\\p{L}+'])) return null;
  // 9. ` ?\p{N}+`
  if (!matchEq(parts[8]!, [' ?\\p{N}+'])) return null;
  // 10. ` ?[^\s\p{L}\p{N}]+`
  if (!matchEq(parts[9]!, [' ?[^\\s\\p{L}\\p{N}]+'])) return null;
  // 11. `\s+(?!\S)`
  if (!matchEq(parts[10]!, ['\\s+(?!\\S)'])) return null;
  // 12. `\s+`
  if (!matchEq(parts[11]!, ['\\s+'])) return null;

  return {
    version: 1,
    ops: [
      { op: 'literals', patterns: [...expectedContractions] },
      { op: 'letters', lead_space: true },
      { op: 'numbers', lead_space: true },
      { op: 'punct_run', lead_space: true },
      { op: 'trailing_ws' },
      { op: 'ws_run' },
    ],
  };
}
