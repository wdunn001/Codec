/**
 * Pre-tokenizer program tests.
 *
 * Two layers:
 *   1. Direct interpreter unit tests on synthetic inputs, asserting the
 *      op set behaves as documented in spec/PRETOKENIZER_PROGRAM.md.
 *   2. **Equivalence with the regex** on real maps: for any input
 *      string, running the compiled program must produce the same
 *      sequence of pieces as compiling and running the corresponding
 *      `pre_tokenizer_pattern`. This is the core spec property.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runPreTokProgram, type PreTokProgram, type PreTokOp } from '../src/pretok-program.ts';
import { compilePreTokRegexWithFallback } from '../src/bpe.ts';
import {
  compilePreTokenizerRegex,
  metaspaceProgram,
} from '../../maps-cli/src/compile-pretok.ts';

// ── Direct interpreter unit tests ───────────────────────────────────────────

const QWEN_LIKE: PreTokProgram = {
  version: 1,
  ops: [
    { op: 'literals_ci', patterns: ["'s","'t","'re","'ve","'m","'ll","'d"] },
    { op: 'letters', lead_other: true },
    { op: 'numbers' },
    { op: 'punct_run', lead_space: true, trailing_newlines: true },
    { op: 'newline_block' },
    { op: 'trailing_ws' },
    { op: 'ws_run' },
  ],
};

test('pretok program: simple ASCII sentence', () => {
  // Llama-3-style: leading space attaches to the next letter run via
  // `[^\r\n\p{L}\p{N}]?\p{L}+`. So "Hello world!" splits into
  // ["Hello", " world", "!"]: note the space attached to "world".
  const out = runPreTokProgram(QWEN_LIKE, 'Hello world!');
  assert.deepEqual(out, ['Hello', ' world', '!']);
});

test('pretok program: contractions are case-insensitive', () => {
  assert.deepEqual(
    runPreTokProgram(QWEN_LIKE, "It's"),
    ['It', "'s"]);
  assert.deepEqual(
    runPreTokProgram(QWEN_LIKE, "It'S"),
    ['It', "'S"]);  // CI match keeps the original casing
});

test('pretok program: digits run (Qwen-style: 1 digit per piece)', () => {
  // Qwen-2 regex is `\p{N}` (no quantifier): one digit per regex
  // iteration. Digit runs therefore come out one digit at a time. Match the
  // canonical regex behavior precisely.
  const qwen: PreTokProgram = {
    version: 1,
    ops: [
      ...QWEN_LIKE.ops.slice(0, 2),
      { op: 'numbers', max_run: 1 },
      ...QWEN_LIKE.ops.slice(3),
    ],
  };
  assert.deepEqual(
    runPreTokProgram(qwen, 'abc12345'),
    ['abc', '1', '2', '3', '4', '5']);
});

test('pretok program: digits bounded (Llama-3 style)', () => {
  const llama: PreTokProgram = {
    version: 1,
    ops: [
      ...QWEN_LIKE.ops.slice(0, 2),
      { op: 'numbers', max_run: 3 },
      ...QWEN_LIKE.ops.slice(3),
    ],
  };
  // "12345" → ["123", "45"] under max_run: 3
  assert.deepEqual(
    runPreTokProgram(llama, '12345'),
    ['123', '45']);
});

test('pretok program: punctuation run with trailing newline', () => {
  // " !!!\n\n" → punct_run takes " !!!\n\n" as one piece
  // (lead_space + [^\s\p{L}\p{N}]+ + [\r\n]*)
  // Then nothing left.
  const out = runPreTokProgram(QWEN_LIKE, 'hi !!!\n');
  assert.deepEqual(out, ['hi', ' !!!\n']);
});

test('pretok program: trailing whitespace at EOI matches trailing_ws', () => {
  // "hi   " → ["hi", "   "] where "   " comes from trailing_ws
  const out = runPreTokProgram(QWEN_LIKE, 'hi   ');
  assert.deepEqual(out, ['hi', '   ']);
});

test('pretok program: emoji and CJK are letters via \\p{L}', () => {
  // CJK ideographs are \p{L}o (Letter, other): should match "letters" op.
  const out = runPreTokProgram(QWEN_LIKE, '日本語');
  assert.deepEqual(out, ['日本語']);
});

test('pretok program: metaspace splits and prefixes ▁', () => {
  const prog = metaspaceProgram();
  assert.deepEqual(
    runPreTokProgram(prog, 'Hello world'),
    ['▁Hello', '▁world']);
});

test('pretok program: metaspace prefix_first leaves first piece bare', () => {
  const prog = metaspaceProgram({ prefix_first: true });
  assert.deepEqual(
    runPreTokProgram(prog, 'Hello world'),
    ['Hello', '▁world']);
});

// ── v2 multi-stage programs ──────────────────────────────────────────────────
//
// Each fixture below is a faithful hand-transcription of one broken
// model's real HuggingFace Sequence (see packages/maps-cli/src/convert.ts
// § compilePreTokenizerStages and spec/PRETOKENIZER_PROGRAM.md § v2). The
// end-to-end numbers against the real golden/stress/real corpora live in
// packages/maps-cli/test/convert-pretok-corpora.test.ts; these are the
// small, hand-picked constructs the bug report called out by name.

const BYTE_LEVEL_DEFAULT_OPS: PreTokOp[] = [
  { op: 'literals', patterns: ["'s", "'t", "'re", "'ve", "'m", "'ll", "'d"] },
  { op: 'letters', lead_space: true },
  { op: 'numbers', lead_space: true },
  { op: 'punct_run', lead_space: true },
  { op: 'trailing_ws' },
  { op: 'ws_run' },
];

test('pretok program v2: SmolLM2 shape (Digits individual, then ByteLevel): whitespace run before a digit stays whole', () => {
  // The exact failing construct from the bug report: a 2+ code-point
  // whitespace run immediately followed by a digit. The v1 lowering cut at
  // the digit before ByteLevel ran, so the run landed on a piece boundary
  // and came out as two single spaces instead of one two-space piece.
  const prog: PreTokProgram = {
    version: 2,
    stages: [
      { stage: 'digits_isolate', mode: 'individual' },
      { stage: 'alternation', ops: BYTE_LEVEL_DEFAULT_OPS },
    ],
  };
  assert.deepEqual(runPreTokProgram(prog, 'a  1'), ['a', '  ', '1']);
});

test('pretok program v2: Falcon shape (Punctuation Contiguous, ByteLevel, Digits, digit-triples)', () => {
  const prog: PreTokProgram = {
    version: 2,
    stages: [
      { stage: 'punctuation_contiguous' },
      { stage: 'alternation', ops: BYTE_LEVEL_DEFAULT_OPS },
      { stage: 'digits_isolate', mode: 'grouped' },
      { stage: 'digit_triples_isolate' },
    ],
  };
  // The failing construct: whitespace run then punctuation glued to a
  // letter. Punctuation(Contiguous) groups the whole leading run (letter +
  // spaces are both "non-punct") before the punct char, then ByteLevel
  // splits that group on its own.
  assert.deepEqual(runPreTokProgram(prog, 'a  .b'), ['a', '  ', '.', 'b']);
  // Falcon's digit-triple chunking: a 5-digit run becomes a 3-digit piece
  // and a 2-digit remainder, not five single digits.
  assert.deepEqual(runPreTokProgram(prog, '12345'), ['123', '45']);
});

test('pretok program v2: DeepSeek-V3 shape (bounded digit isolate, CJK isolate, alternation)', () => {
  const prog: PreTokProgram = {
    version: 2,
    stages: [
      { stage: 'digits_isolate', mode: 'grouped', max_run: 3 },
      { stage: 'cjk_isolate' },
      {
        stage: 'alternation',
        ops: [
          { op: 'punct_ascii_letters' },
          { op: 'letters', lead_other: true, lead_other_class: 'l_p_s', body: 'L_M' },
          { op: 'punct_run', lead_space: true, trailing_newlines: true, charset: 'p_s' },
          { op: 'newline_block' },
          { op: 'trailing_ws' },
          { op: 'ws_run' },
        ],
      },
    ],
  };
  // Digit runs longer than 3 chunk at the isolate stage, same shape as
  // Falcon's digit-triples but via the bounded \p{N}{1,3} Split instead.
  assert.deepEqual(runPreTokProgram(prog, '12345'), ['123', '45']);
  // CJK isolates before the alternation ever sees it: it never merges with
  // adjacent Latin text.
  assert.deepEqual(runPreTokProgram(prog, '日本語abc'), ['日本語', 'abc']);
  // The ASCII-punct-then-letters alternative the v1 op schema couldn't
  // express at all: an apostrophe glued to identifier letters, e.g. code
  // like `'m` in Python's `sys.platform == 'linux'`, stays one piece
  // (`punct_ascii_letters` only consumes ASCII LETTERS after the lead
  // punct char, so the closing quote is its own piece, via `punct_run`).
  assert.deepEqual(runPreTokProgram(prog, "'linux'"), ["'linux", "'"]);
  // A digit directly followed by a letter never reaches the alternation
  // stage as one span here: the digits_isolate stage runs FIRST and
  // always pulls the digit out on its own, regardless of what follows it.
  // (The letters op's lead_other_class 'l_p_s' CAN admit a digit as its
  // lead character in isolation, see the standalone alternation-stage
  // test below; it just never gets the chance to in this pipeline.)
  assert.deepEqual(runPreTokProgram(prog, '1x'), ['1', 'x']);
  // body: 'L_M' keeps a base letter and its combining mark together: a
  // decomposed "é" (e + combining acute, U+0301) stays one piece instead
  // of splitting the mark off, which is what the L-only body would do.
  assert.deepEqual(runPreTokProgram(prog, 'éx'), ['éx']);
});

test('pretok program v2: alternation stage gap semantics: an unmatched span is one piece, not shattered per scalar', () => {
  // DeepSeek-V3's third-stage ops have no digit branch at all (digits were
  // already isolated by an earlier stage). A pure-digit piece reaching
  // this stage directly (bypassing the digit-isolate stage, to test the
  // alternation executor in isolation) must come out as ONE piece. That is
  // Split(..., Isolated) gap semantics: an unmatched span is emitted
  // verbatim, exactly like a gap between two regex matches.
  const ops: PreTokOp[] = [
    { op: 'punct_ascii_letters' },
    { op: 'letters', lead_other: true, lead_other_class: 'l_p_s', body: 'L_M' },
    { op: 'punct_run', lead_space: true, trailing_newlines: true, charset: 'p_s' },
    { op: 'newline_block' },
    { op: 'trailing_ws' },
    { op: 'ws_run' },
  ];
  const prog: PreTokProgram = { version: 2, stages: [{ stage: 'alternation', ops }] };
  assert.deepEqual(runPreTokProgram(prog, '123'), ['123']);
  // Mixed: a gap in the middle of otherwise-matching content stays one
  // piece, and matching resumes correctly right after it. (A digit run
  // directly followed by a letter, not by whitespace, would instead be
  // swept into the NEXT match via the letters op's lead_other_class
  // 'l_p_s' admitting a digit lead: see the '1x' case in the DeepSeek-V3
  // shape test above. Trailing whitespace after the run keeps this case a
  // clean, unambiguous gap.)
  assert.deepEqual(runPreTokProgram(prog, 'ab123 cd'), ['ab', '123', ' cd']);
  // A digit directly followed by a letter, with no digits_isolate stage
  // ahead of this one to intercept it: lead_other_class 'l_p_s' admits
  // the digit as the letters run's lead character (only L/P/S are
  // excluded, not N, unlike the default 'l_n' variant which would exclude
  // it), so the whole thing is one piece.
  assert.deepEqual(runPreTokProgram(prog, '1x'), ['1x']);
});

test('pretok program: unsupported version throws instead of silently mis-executing', () => {
  const prog = { version: 3, stages: [] } as unknown as PreTokProgram;
  assert.throws(() => runPreTokProgram(prog, 'hello'), /version 3/);
});

// ── digits_isolate stage ─────────────────────────────────────────────────────

test('digits_isolate: individual mode emits one piece per digit', () => {
  const prog: PreTokProgram = { version: 2, stages: [{ stage: 'digits_isolate', mode: 'individual' }] };
  assert.deepEqual(runPreTokProgram(prog, 'ab123cd'), ['ab', '1', '2', '3', 'cd']);
});

test('digits_isolate: grouped mode with no max_run keeps a whole digit run together', () => {
  const prog: PreTokProgram = { version: 2, stages: [{ stage: 'digits_isolate', mode: 'grouped' }] };
  assert.deepEqual(runPreTokProgram(prog, 'ab123456cd'), ['ab', '123456', 'cd']);
});

test('digits_isolate: grouped mode with max_run chunks a long run', () => {
  const prog: PreTokProgram = { version: 2, stages: [{ stage: 'digits_isolate', mode: 'grouped', max_run: 3 }] };
  assert.deepEqual(runPreTokProgram(prog, '1234567'), ['123', '456', '7']);
});

// ── digit_triples_isolate stage ──────────────────────────────────────────────

test('digit_triples_isolate: exact 3-digit windows, remainder stays ungrouped', () => {
  const prog: PreTokProgram = { version: 2, stages: [{ stage: 'digit_triples_isolate' }] };
  assert.deepEqual(runPreTokProgram(prog, '1234567'), ['123', '456', '7']);
  // A run shorter than 3 is never isolated at all.
  assert.deepEqual(runPreTokProgram(prog, 'ab12cd'), ['ab12cd']);
});

// ── punctuation_contiguous stage ─────────────────────────────────────────────

test('punctuation_contiguous: groups maximal runs, not one piece per character', () => {
  const prog: PreTokProgram = { version: 2, stages: [{ stage: 'punctuation_contiguous' }] };
  assert.deepEqual(runPreTokProgram(prog, 'a!!!b'), ['a', '!!!', 'b']);
  // Whitespace is non-punct, same classification as letters: it stays
  // grouped with adjacent letters rather than forming its own run.
  assert.deepEqual(runPreTokProgram(prog, 'a  .b'), ['a  ', '.', 'b']);
});

// ── cjk_isolate stage ─────────────────────────────────────────────────────────

test('cjk_isolate: isolates CJK/Hiragana/Katakana runs from adjacent Latin text', () => {
  const prog: PreTokProgram = { version: 2, stages: [{ stage: 'cjk_isolate' }] };
  assert.deepEqual(runPreTokProgram(prog, 'abc日本語def'), ['abc', '日本語', 'def']);
  // A leading space does not merge into the CJK run.
  assert.deepEqual(runPreTokProgram(prog, ' 日本語'), [' ', '日本語']);
});

// ── Compiler tests ──────────────────────────────────────────────────────────

const QWEN_REGEX =
  "(?i:'s|'t|'re|'ve|'m|'ll|'d)" +
  "|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+" +
  "|\\p{N}" +
  "| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*" +
  "|\\s*[\\r\\n]+" +
  "|\\s+(?!\\S)" +
  "|\\s+";

const LLAMA_REGEX =
  "(?i:'s|'t|'re|'ve|'m|'ll|'d)" +
  "|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+" +
  "|\\p{N}{1,3}" +
  "| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*" +
  "|\\s*[\\r\\n]+" +
  "|\\s+(?!\\S)" +
  "|\\s+";

test('compiler: Qwen-2 regex compiles to single-digit numbers op', () => {
  const prog = compilePreTokenizerRegex(QWEN_REGEX);
  assert.notEqual(prog, null);
  assert.equal(prog!.ops.length, 7);
  assert.equal(prog!.ops[2]!.op, 'numbers');
  // Bare `\p{N}` (no quantifier) → one digit per piece.
  assert.equal((prog!.ops[2] as { max_run?: number }).max_run, 1);
});

test('compiler: Llama-3 regex compiles with max_run=3', () => {
  const prog = compilePreTokenizerRegex(LLAMA_REGEX);
  assert.notEqual(prog, null);
  assert.equal((prog!.ops[2] as { max_run?: number }).max_run, 3);
});

test('compiler: unknown regex returns null', () => {
  assert.equal(compilePreTokenizerRegex('[a-z]+|\\d+'), null);
  assert.equal(compilePreTokenizerRegex(''), null);
});

// ── Equivalence: program output must equal regex output ─────────────────────

const STRESS_INPUTS = [
  '',
  'a',
  'Hello world',
  'Hello, world!',
  "It's a test.",
  'abc123def456',
  '   leading spaces',
  'trailing spaces   ',
  'multi   spaces',
  'tab\there',
  'newline\nhere',
  'paragraph\n\nbreak',
  'CRLF\r\nstyle',
  'punct!!!run???',
  ' leading punct: foo',
  'mixed日本語text',
  '🚀 emoji 🎉',
  '日本語のテスト',
  'Numbers 12345 in middle',
  '  \n\n  whitespace + newline',
  'a'.repeat(100),
  '---divider---',
  'unicode_ⅷ_numerals',
];

function runRegex(re: string, input: string): string[] {
  // The patterns under test use ES2025 `(?i:...)` inline-flag groups which
  // not every runtime supports: go through the same fallback ladder that
  // BPETokenizer uses (gv → gu → desugared gu) so this equivalence test
  // exercises whichever code path the runtime actually takes.
  const r = compilePreTokRegexWithFallback(re, 'test-equivalence');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = r.exec(input)) !== null) {
    if (m[0].length > 0) out.push(m[0]);
    if (m.index === r.lastIndex) r.lastIndex++;
  }
  return out;
}

test('equivalence: Qwen-2 program ≡ Qwen-2 regex on stress inputs', () => {
  const prog = compilePreTokenizerRegex(QWEN_REGEX)!;
  for (const input of STRESS_INPUTS) {
    const fromProg = runPreTokProgram(prog, input);
    const fromRe   = runRegex(QWEN_REGEX, input);
    assert.deepEqual(fromProg, fromRe, `input: ${JSON.stringify(input)}`);
  }
});

test('equivalence: Llama-3 program ≡ Llama-3 regex on stress inputs', () => {
  const prog = compilePreTokenizerRegex(LLAMA_REGEX)!;
  for (const input of STRESS_INPUTS) {
    const fromProg = runPreTokProgram(prog, input);
    const fromRe   = runRegex(LLAMA_REGEX, input);
    assert.deepEqual(fromProg, fromRe, `input: ${JSON.stringify(input)}`);
  }
});

// ── Equivalence on real published map regex ─────────────────────────────────

function findQwen2(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '../../../codec-maps/maps/qwen/qwen2.json'),
    path.resolve(process.cwd(), '../../codec-maps/maps/qwen/qwen2.json'),
    process.env.CODEC_MAPS_QWEN ?? '',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

test('equivalence: real Qwen-2 map regex compiles + matches on stress inputs',
  { skip: !findQwen2() }, () => {
    const map = JSON.parse(fs.readFileSync(findQwen2()!, 'utf-8'));
    const re = map.pre_tokenizer_pattern as string;
    assert.ok(re, 'real qwen2 map should carry pre_tokenizer_pattern');

    const prog = compilePreTokenizerRegex(re);
    assert.notEqual(prog, null,
      `compiler should recognise the published Qwen-2 regex: ${re}`);

    for (const input of STRESS_INPUTS) {
      const fromProg = runPreTokProgram(prog!, input);
      const fromRe   = runRegex(re, input);
      assert.deepEqual(fromProg, fromRe, `input: ${JSON.stringify(input)}`);
    }
  });


// ── `\s` must mean \p{White_Space} ───────────────────────────────────────
//
// spec/PRETOKENIZER_PROGRAM.md § Class membership pins the whitespace class:
//
//   `\s` means `\p{White_Space}` plus the ASCII whitespace fallbacks
//
// JavaScript's native `\s` is a different set. It excludes U+0085 NEXT LINE.
// That code point is neither a line terminator nor category Zs. It also
// includes U+FEFF ZERO WIDTH NO-BREAK SPACE. Unicode does not classify
// that one as White_Space either. The C runtime's table
// (packages/c/src/codec_unicode_tables.c) and Rust's `regex` crate both
// use \p{White_Space} exactly. Relying on native `\s` here made the
// TypeScript pieces differ from every other implementation on those two
// code points. A differential run of this same Qwen-like program
// over 10316 inputs disagreed with the C runtime on 1074 of them.
//
// The oracle below is the literal Unicode White_Space list. It cannot
// drift with whatever the implementation happens to use.

/** Unicode White_Space=Yes, transcribed from UCD PropList. */
const WHITE_SPACE_CODE_POINTS = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000,
];

/** Zero-width or invisible characters that are NOT White_Space. */
const NOT_WHITE_SPACE_CODE_POINTS = [0xfeff, 0x200b, 0x180e, 0x2060, 0x00ad];

/**
 * Probe the interpreter's whitespace predicate for one code point.
 *
 * With the Qwen-like program, `punct_run` stops at CP when CP is whitespace.
 * The input `a<CP>!` therefore splits three ways in that case. When CP is
 * not whitespace, `punct_run` absorbs it together with the `!` and there
 * are two pieces.
 */
function treatsAsWhitespace(cp: number): boolean {
  const pieces = runPreTokProgram(QWEN_LIKE, `a${String.fromCodePoint(cp)}!`);
  return pieces.length === 3;
}

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

test('pretok program: whitespace class is exactly Unicode White_Space', () => {
  for (const cp of WHITE_SPACE_CODE_POINTS) {
    if (cp === 0x20) continue; // punct_run's lead_space consumes it either way
    assert.equal(treatsAsWhitespace(cp), true,
      `${hex(cp)} is White_Space and must split`);
  }
  for (const cp of NOT_WHITE_SPACE_CODE_POINTS) {
    assert.equal(treatsAsWhitespace(cp), false,
      `${hex(cp)} is not White_Space and must not split`);
  }
});

test('pretok program: U+0085 NEXT LINE is whitespace', () => {
  // Confirmed against the C runtime. That produces ['a', '', '!'].
  assert.deepEqual(runPreTokProgram(QWEN_LIKE, 'a!'), ['a', '', '!']);
});

test('pretok program: U+FEFF is not whitespace', () => {
  // Confirmed against the C runtime. That produces ['a', '﻿!'].
  assert.deepEqual(runPreTokProgram(QWEN_LIKE, 'a﻿!'), ['a', '﻿!']);
});

test('pretok program: ws_run groups a mixed White_Space run as C does', () => {
  // Input is a, U+0085, U+2009 THIN SPACE, U+0020, b. The C runtime emits
  // the pieces 61 / c285e28089 / 2062. U+0085 therefore belongs to the run.
  assert.deepEqual(
    runPreTokProgram(QWEN_LIKE, 'a  b'),
    ['a', ' ', ' b'],
  );
});

test('pretok program: trailing_ws treats U+0085 as part of the run', () => {
  // C emits ['a', ''] for this input.
  assert.deepEqual(
    runPreTokProgram(QWEN_LIKE, 'a'),
    ['a', ''],
  );
});
