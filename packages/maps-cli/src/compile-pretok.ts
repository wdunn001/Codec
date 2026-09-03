/**
 * Pre-tokenizer regex/stage → program compiler.
 *
 * Recognizes the known pre-tokenizer shapes used by the major tokenizer
 * families and emits a `pre_tokenizer_program` that the runtime interpreter
 * (packages/web/src/pretok-program.ts) can execute without a regex engine.
 * See spec/PRETOKENIZER_PROGRAM.md for the spec.
 *
 * Two entry points:
 *
 *   - `compilePreTokenizerRegex(regex)`: a single flat alternation regex →
 *     a v1 `{ version: 1, ops: [...] }` program. Used for tokenizers whose
 *     HuggingFace pre_tokenizer is (or reduces to) exactly one alternation
 *     regex.
 *   - `compileAlternationOps(regex)`: the same recognizer, returning just
 *     the `ops` array (no version wrapper). Used by convert.ts to build one
 *     `alternation` STAGE inside a v2 multi-stage program, when the source
 *     HuggingFace pre_tokenizer is a `Sequence` of more than one kind of
 *     stage (Digits, Punctuation, CJK-range Split, ...) and a flat v1
 *     program cannot represent it faithfully.
 *
 * Both are intentionally conservative: they pattern-match a known set of
 * regex shapes (canonicalized whitespace), and return `null` for anything
 * else. convert.ts turns a `null` here into a loud failure rather than a
 * silent approximation: see its module doc comment.
 *
 * The tradeoff: a hand-rolled regex parser would let us handle arbitrary
 * tokenizer regexes, but the regex flavour is ad-hoc per model family and
 * most just clone Llama-3 / Qwen / DeepSeek anyway. Pattern matching the
 * canonical forms gets us wide coverage with no parser maintenance burden.
 */

export type PreTokOp =
  | { op: 'literals_ci'; patterns: string[] }
  | { op: 'literals'; patterns: string[] }
  | {
      op: 'letters';
      lead_other?: boolean;
      lead_space?: boolean;
      lead_other_class?: 'l_n' | 'l_p_s';
      body?: 'L' | 'L_M';
    }
  | { op: 'letters_cased'; kind: 'title' | 'upper'; lead_other?: boolean; trailing_ci?: string[] }
  | { op: 'numbers'; max_run?: number; lead_space?: boolean }
  | {
      op: 'punct_run';
      lead_space?: boolean;
      trailing_newlines?: boolean;
      trailing_chars?: string;
      charset?: 'not_ws_L_N' | 'p_s';
    }
  | { op: 'punct_ascii_letters' }
  | { op: 'newline_block' }
  | { op: 'trailing_ws' }
  | { op: 'ws_run' }
  | { op: 'metaspace_split'; prefix_first?: boolean };

export type PreTokStage =
  | { stage: 'digits_isolate'; mode: 'individual' | 'grouped'; max_run?: number }
  | { stage: 'digit_triples_isolate' }
  | { stage: 'punctuation_contiguous' }
  | { stage: 'cjk_isolate' }
  | { stage: 'alternation'; ops: PreTokOp[] };

export interface PreTokProgramV1 {
  version: 1;
  ops: PreTokOp[];
}
export interface PreTokProgramV2 {
  version: 2;
  stages: PreTokStage[];
}
export type PreTokProgram = PreTokProgramV1 | PreTokProgramV2;

/**
 * The fixed op sequence for `ByteLevel(use_regex=true)`. HuggingFace's
 * `ByteLevel` pre-tokenizer never reads a pattern from tokenizer.json for
 * this: its internal regex is a crate constant,
 * `'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+`
 * (case-SENSITIVE contractions, no `(?i:)` group: the same shape the older
 * OpenAI tokenizers p50k_base/r50k_base ship as their whole pattern). Every
 * model with `ByteLevel(use_regex=true)` in its Sequence runs this exact
 * scan, independent of any Split node's own regex.
 */
export const BYTE_LEVEL_DEFAULT_OPS: PreTokOp[] = [
  { op: 'literals', patterns: ["'s", "'t", "'re", "'ve", "'m", "'ll", "'d"] },
  { op: 'letters', lead_space: true },
  { op: 'numbers', lead_space: true },
  { op: 'punct_run', lead_space: true },
  { op: 'trailing_ws' },
  { op: 'ws_run' },
];

/** The regex string equivalent of `BYTE_LEVEL_DEFAULT_OPS`, for the legacy
 * `pre_tokenizer_pattern` field when a lone `ByteLevel(use_regex=true)`
 * stage (no preceding Split) is the map's only real pre-tokenizer stage. */
export const BYTE_LEVEL_DEFAULT_REGEX =
  "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+";

/**
 * Compile a pre-tokenizer regex string into a v1 program. Returns `null`
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
  const ops = compileAlternationOps(regex);
  return ops ? { version: 1, ops } : null;
}

/**
 * The same regex-shape recognizer as `compilePreTokenizerRegex`, returning
 * a bare `ops` array (for embedding inside a v2 `alternation` stage) rather
 * than a wrapped v1 program. Returns `null` on an unrecognised shape.
 */
export function compileAlternationOps(regex: string): PreTokOp[] | null {
  const r = canonicalize(regex);

  // Try the older OpenAI shape first (p50k_base, r50k_base, and any
  // ByteLevel(use_regex=true) stage): case-sensitive literal contractions,
  // ` ?\p{L}+`, ` ?\p{N}+`, ` ?[^...]`, trailing_ws, ws_run. Distinguishable
  // from the GPT-2 canonical shape by the absence of a `(?i:...)` group and
  // the lead-space variants on letters/numbers.
  const oldOpenAi = tryCompileOldOpenAi(r);
  if (oldOpenAi) return oldOpenAi;

  // Cased-letter form: two `[Lu Lt Lm Lo M]` / `[Ll Lm Lo M]` letter
  // branches with optional `(?i:'s|...)?` suffix per branch. Used by
  // o200k_base and mistral-nemo. The contractions suffix is per-branch
  // and OPTIONAL, distinguishing this from older tokenizer shapes.
  const cased = tryCompileCasedLetters(r);
  if (cased) return cased;

  // DeepSeek-V3's third Split stage: ASCII-punct-then-letters, a lead-
  // other letters branch that excludes L/P/S instead of L/N and admits
  // combining marks in the body, a punct_run classed on P/S instead of
  // the complement class, then the usual newline/trailing/ws trio.
  const deepseek = tryCompileDeepSeekStage3(r);
  if (deepseek) return deepseek;

  // GPT-2-family alternation. We split on top-level `|` (the regex has no
  // nested groups that would contain unescaped `|` aside from the
  // contractions group, which is `(?i:...)` and we handle it specially).
  const parts = splitTopLevelAlt(r);
  if (parts.length < 7 || parts.length > 8) return null;

  const ops: PreTokOp[] = [];

  // 1. (?i:'s|'t|'re|'ve|'m|'ll|'d): contractions
  const contractions = parseContractionsGroup(parts[0]!);
  if (!contractions) return null;
  ops.push({ op: 'literals_ci', patterns: contractions });

  // 2. [^\r\n\p{L}\p{N}]?\p{L}+: letters with optional non-letter lead
  if (!matchEq(parts[1]!, ['[^\\r\\n\\p{L}\\p{N}]?\\p{L}+'])) return null;
  ops.push({ op: 'letters', lead_other: true });

  // 3. \p{N} (single-digit, Qwen-style) or \p{N}{1,K} (Llama-3) or \p{N}+ (unbounded)
  const maxRun = parseNumberQuantifier(parts[2]!);
  if (maxRun === null) return null;
  ops.push(maxRun > 0 ? { op: 'numbers', max_run: maxRun } : { op: 'numbers' });

  // 4.  ?[^\s\p{L}\p{N}]+[\r\n]*: punct run with leading space + trailing newlines
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

  return ops;
}

/**
 * Build a metaspace program. Used directly for SentencePiece-family
 * encoders since they don't have a regex `pre_tokenizer_pattern`.
 */
export function metaspaceProgram(opts: { prefix_first?: boolean } = {}): PreTokProgramV1 {
  const op: PreTokOp = { op: 'metaspace_split' };
  if (opts.prefix_first) op.prefix_first = true;
  return { version: 1, ops: [op] };
}

// ── v2 stage-shape recognizers ───────────────────────────────────────────
//
// Each narrow HuggingFace `Split` regex shape below has exactly one
// faithful stage-op lowering. Anything outside these shapes (and outside
// `compileAlternationOps` above) returns `null`; convert.ts turns that into
// a loud failure.

/**
 * `\p{N}{1,K}` or `\p{N}+` or bare `\p{N}`: a digit-run isolator, used
 * either as HuggingFace's dedicated `Digits` pre-tokenizer type or as a
 * `Split` node with this exact pattern and `Isolated` behavior (DeepSeek-
 * V3's first stage, `\p{N}{1,3}`). Returns the `max_run` to embed in a
 * `digits_isolate` stage (0 = unbounded), or `null` if the pattern isn't
 * this shape.
 */
export function recognizeDigitsRunRegex(pattern: string): number | null {
  return parseNumberQuantifier(canonicalize(pattern));
}

/**
 * DeepSeek-V3's second stage: `Split([一-龥぀-ゟ゠-ヿ]+, Isolated)`. Exact
 * literal match only: this is the model's own CJK/Hiragana/Katakana range
 * triple, not a general "does this regex look CJK-ish" heuristic.
 */
export function isCjkIsolateRegex(pattern: string): boolean {
  return canonicalize(pattern) === '[一-龥぀-ゟ゠-ヿ]+';
}

/**
 * Falcon's fourth stage: `Split([0-9][0-9][0-9], Isolated)`. Exact literal
 * match only.
 */
export function isDigitTriplesRegex(pattern: string): boolean {
  return canonicalize(pattern) === '[0-9][0-9][0-9]';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function canonicalize(s: string): string {
  // Some HF tokenizer.json files serialize a regex's `\r`/`\n` class
  // members as the JSON control-char escapes `\r`/`\n` (which JSON.parse
  // turns into an actual CR/LF byte in the resulting string) rather than
  // the JSON double-backslash escapes `\\r`/`\\n` (which JSON.parse turns
  // into the two literal characters backslash-r / backslash-n: what a
  // regex source string needs `\r`/`\n` to look like). Both spellings
  // compile to the same regex ("exclude a carriage return" / "exclude a
  // line feed" either way), but every shape recognizer below compares
  // against literal `\\r`/`\\n` two-character strings. DeepSeek-V3/R1's
  // third Split stage ships the raw-control-char spelling; normalise it
  // to the two-character form up front so every recognizer sees one
  // consistent shape regardless of which style a given source used.
  let r = s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');

  // Strip surrounding parentheses if the entire regex is parenthesized
  // exactly once. Some HF tokenizer.json files wrap the alternation.
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
 * Parse a `\p{N}` digit-quantifier branch: bare `\p{N}` (one digit per
 * match → max_run 1), `\p{N}+` (unbounded → 0), or `\p{N}{1,K}` (bounded →
 * K). Returns `null` if `s` isn't this shape.
 */
function parseNumberQuantifier(s: string): number | null {
  const m = s.match(/^\\p\{N\}(?:(\+)|\{1,(\d+)\}\??)?$/);
  if (!m) return null;
  if (m[1] === '+') return 0;
  if (m[2]) return parseInt(m[2], 10);
  return 1;
}

/**
 * Recognise the older OpenAI shape used by `p50k_base`, `p50k_edit`, and
 * `r50k_base`: the pre-tokenizer that `ByteLevel.use_regex: true` invokes
 * internally before the (?i:) inline-flag group was added in cl100k_base.
 *
 *   's|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+
 *
 * Top-level alts: 7 contractions (literal, case-sensitive) + 5 rules
 * (letters_lead_space, numbers_lead_space, punct_lead_space, trailing_ws,
 * ws_run) = 12 parts. The earlier GPT-2 alt-form has 7-8 parts because its
 * contractions are wrapped in `(?i:...)` as a single alt.
 */
function tryCompileOldOpenAi(r: string): PreTokOp[] | null {
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

  return BYTE_LEVEL_DEFAULT_OPS.map(cloneOp);
}

/**
 * Recognise the cased-letter shape used by `o200k_base` and
 * `mistralai/mistral-nemo`. Both regexes have:
 *
 *   - 2 cased-letter branches (title-then-lower / upper-then-lower)
 *     with optional `(?i:'s|...)?` contractions suffix per branch
 *   - `\p{N}{1,K}` or `\p{N}` (single digit) numbers branch
 *   - ` ?[^\s\p{L}\p{N}]+[\r\n/]*` punct_run with trailing `[\r\n/]`
 *   - `\s*[\r\n]+`, `\s+(?!\S)`, `\s+`
 *
 * 7 top-level alts. The two letter branches start with the same
 * `[^\r\n\p{L}\p{N}]?` lead-other guard.
 */
function tryCompileCasedLetters(r: string): PreTokOp[] | null {
  const parts = splitTopLevelAlt(r);
  if (parts.length !== 7) return null;

  // 1. Title kind: [^...]? [Lu Lt Lm Lo M]* [Ll Lm Lo M]+ (?i:'s|...)?
  const titleCi = parseCasedLetterBranch(parts[0]!, 'title');
  if (titleCi === null) return null;

  // 2. Upper kind: [^...]? [Lu Lt Lm Lo M]+ [Ll Lm Lo M]* (?i:'s|...)?
  const upperCi = parseCasedLetterBranch(parts[1]!, 'upper');
  if (upperCi === null) return null;

  // Both branches must agree on whether they carry trailing_ci (the
  // o200k_base case) or not (the mistral-nemo case).
  if ((titleCi.length > 0) !== (upperCi.length > 0)) return null;

  // 3. Numbers: `\p{N}{1,K}`, `\p{N}+`, or bare `\p{N}` (single digit).
  const maxRun = parseNumberQuantifier(parts[2]!);
  if (maxRun === null) return null;

  // 4. Punct run with lead-space and trailing `[\r\n/]*`.
  if (!matchEq(parts[3]!, [' ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*'])) return null;

  // 5-7. newline_block, trailing_ws, ws_run.
  if (!matchEq(parts[4]!, ['\\s*[\\r\\n]+'])) return null;
  if (!matchEq(parts[5]!, ['\\s+(?!\\S)'])) return null;
  if (!matchEq(parts[6]!, ['\\s+'])) return null;

  const titleOp: PreTokOp = { op: 'letters_cased', kind: 'title', lead_other: true };
  const upperOp: PreTokOp = { op: 'letters_cased', kind: 'upper', lead_other: true };
  if (titleCi.length > 0) (titleOp as { trailing_ci?: string[] }).trailing_ci = titleCi;
  if (upperCi.length > 0) (upperOp as { trailing_ci?: string[] }).trailing_ci = upperCi;

  const numbersOp: PreTokOp = maxRun > 0
    ? { op: 'numbers', max_run: maxRun }
    : { op: 'numbers' };

  return [
    titleOp,
    upperOp,
    numbersOp,
    { op: 'punct_run', lead_space: true, trailing_chars: '\r\n/' },
    { op: 'newline_block' },
    { op: 'trailing_ws' },
    { op: 'ws_run' },
  ];
}

/**
 * Recognise DeepSeek-V3/R1's third Split stage:
 *
 *   ['!"#$%&()*+,\-./:;<=>?@\[\\\]^_`{|}~][A-Za-z]+
 *     |[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+
 *     | ?[\p{P}\p{S}]+[\r\n]*
 *     |\s*[\r\n]+
 *     |\s+(?!\S)
 *     |\s+
 *
 * 6 top-level alts. Distinguishing features versus the main GPT-2-family
 * shape: the FIRST alternative (ASCII-punct-then-letters, tried before the
 * lead-other letters branch) has no equivalent in any other recognised
 * shape; the letters branch excludes `\p{P}\p{S}` instead of `\p{N}` at the
 * lead and admits `\p{M}` in the body; the punct branch is classed on
 * `\p{P}\p{S}` explicitly instead of the `[^\s\p{L}\p{N}]` complement.
 */
function tryCompileDeepSeekStage3(r: string): PreTokOp[] | null {
  const parts = splitTopLevelAlt(r);
  if (parts.length !== 6) return null;

  if (!matchEq(parts[0]!, ["[!\"#$%&'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+"])) return null;
  if (!matchEq(parts[1]!, ['[^\\r\\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+'])) return null;
  if (!matchEq(parts[2]!, [' ?[\\p{P}\\p{S}]+[\\r\\n]*'])) return null;
  if (!matchEq(parts[3]!, ['\\s*[\\r\\n]+'])) return null;
  if (!matchEq(parts[4]!, ['\\s+(?!\\S)'])) return null;
  if (!matchEq(parts[5]!, ['\\s+'])) return null;

  return [
    { op: 'punct_ascii_letters' },
    { op: 'letters', lead_other: true, lead_other_class: 'l_p_s', body: 'L_M' },
    { op: 'punct_run', lead_space: true, trailing_newlines: true, charset: 'p_s' },
    { op: 'newline_block' },
    { op: 'trailing_ws' },
    { op: 'ws_run' },
  ];
}

/**
 * Parse one cased-letter branch. Returns the contraction list (empty when
 * no `(?i:...)?` suffix is present), or null if the shape doesn't match.
 *
 *   title kind:
 *     [^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:p1|p2|...)?
 *   upper kind:
 *     [^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:p1|p2|...)?
 */
function parseCasedLetterBranch(s: string, kind: 'title' | 'upper'): string[] | null {
  const LEAD  = '\\[\\^\\\\r\\\\n\\\\p\\{L\\}\\\\p\\{N\\}\\]\\?'; // [^\r\n\p{L}\p{N}]?
  const UPPER = '\\[\\\\p\\{Lu\\}\\\\p\\{Lt\\}\\\\p\\{Lm\\}\\\\p\\{Lo\\}\\\\p\\{M\\}\\]';
  const LOWER = '\\[\\\\p\\{Ll\\}\\\\p\\{Lm\\}\\\\p\\{Lo\\}\\\\p\\{M\\}\\]';
  const upperQ = kind === 'title' ? '\\*' : '\\+';
  const lowerQ = kind === 'title' ? '\\+' : '\\*';
  const prefix = `^${LEAD}${UPPER}${upperQ}${LOWER}${lowerQ}`;

  const m = new RegExp(prefix + '(.*)$').exec(s);
  if (!m) return null;
  const rest = m[1]!;
  if (rest === '') return [];

  // Optional trailing `(?i:p1|p2|...)?`.
  const ciMatch = /^\(\?i:(.+)\)\?$/.exec(rest);
  if (!ciMatch) return null;
  const inner = ciMatch[1]!;
  const patterns = splitTopLevelAlt(inner);
  for (const p of patterns) {
    if (/[\\\[\](){}^$.*+?|]/.test(p)) return null;
  }
  return patterns;
}

function cloneOp(op: PreTokOp): PreTokOp {
  return { ...op };
}
