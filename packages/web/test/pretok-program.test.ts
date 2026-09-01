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

import { runPreTokProgram, type PreTokProgram } from '../src/pretok-program.ts';
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
