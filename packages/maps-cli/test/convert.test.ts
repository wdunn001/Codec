/**
 * convertHFTokenizer correctness: synthetic fixtures + a real Qwen-2
 * round-trip check (skipped if codec-maps isn't present locally).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  BPETokenizer,
  Detokenizer,
  validateMap,
} from '@codecai/web';

import { convertHFTokenizer, hashMap } from '../src/convert.ts';
import {
  makeByteLevelHF,
  makeMetaspaceHF,
  makePairFormatMergesHF,
  makeSmolLM2LikeHF,
  makeFalconLikeHF,
  makeDeepSeekLikeHF,
  makeUnsupportedPunctuationHF,
  makeUnsupportedSplitBehaviorHF,
  makeMetaspaceInsideSequenceHF,
} from './fixtures.ts';

// ── byte_level conversion ────────────────────────────────────────────────────

test('convertHFTokenizer: byte_level → encoder, vocab, merges, regex preserved', () => {
  const hf = makeByteLevelHF();
  const map = convertHFTokenizer(hf, { id: 'test/byte-level' });
  assert.equal(map.id, 'test/byte-level');
  assert.equal(map.version, '2');
  assert.equal(map.encoder, 'byte_level');
  assert.ok(map.merges && map.merges.length === 5, 'merges preserved');
  assert.match(
    map.pre_tokenizer_pattern ?? '',
    /\\p\{L\}\+/,
    'pre_tokenizer_pattern lifted from Split node',
  );
  assert.equal(map.byte_fallback_start, undefined, 'byte_level has no fallback range');
});

test('convertHFTokenizer: byte_level vocab includes added_tokens with their IDs', () => {
  const hf = makeByteLevelHF();
  const map = convertHFTokenizer(hf, { id: 'test/byte-level' });
  assert.equal(map.vocab?.['<|endoftext|>'], 100);
  assert.equal(map.vocab?.['<|im_start|>'], 101);
  assert.equal(map.special_tokens?.['<|endoftext|>'], 100);
  assert.equal(map.special_tokens?.['<|im_start|>'], 101);
});

test('convertHFTokenizer: byte_level output passes validateMap', () => {
  const map = convertHFTokenizer(makeByteLevelHF(), { id: 'test/byte-level' });
  validateMap(map);
});

test('convertHFTokenizer: byte_level round-trips through BPE+Detokenizer', () => {
  const map = convertHFTokenizer(makeByteLevelHF(), { id: 'test/byte-level' });
  const tok = new BPETokenizer(map);
  const detok = new Detokenizer(map);
  // 'hello world' should encode and decode bit-identically.
  const ids = tok.encode('hello world');
  assert.equal(detok.render(ids), 'hello world');
});

// ── Multi-stage Sequence lowering (the pretok pipeline fix) ────────────────
//
// Each fixture below is a faithful shape-transcription of one of the four
// broken models from the bug report. The old converter collapsed every one
// of these to whichever `Split` node it found first (or nothing, when
// there was none), silently dropping every other stage. The fix walks the
// whole Sequence and lowers each stage in order; see convert.ts's
// `compilePreTokenizerStages` doc comment.

test('convertHFTokenizer: SmolLM2 shape (Digits + ByteLevel) lowers to a v2 program with no legacy pattern', () => {
  const map = convertHFTokenizer(makeSmolLM2LikeHF(), { id: 'test/smollm2-like' });
  assert.equal(map.pre_tokenizer_pattern, undefined, 'two real stages: no single regex is faithful');
  const prog = map.pre_tokenizer_program as unknown as { version: number; stages: Array<{ stage: string }> };
  assert.equal(prog.version, 2);
  assert.deepEqual(prog.stages.map((s) => s.stage), ['digits_isolate', 'alternation']);
  validateMap(map);
});

test('convertHFTokenizer: SmolLM2 shape round-trips through BPE: whitespace run before a digit stays whole', () => {
  const map = convertHFTokenizer(makeSmolLM2LikeHF(), { id: 'test/smollm2-like' });
  const tok = new BPETokenizer(map);
  // "a  1": the Digits stage isolates '1' before ByteLevel runs, so the
  // two-space run lands inside ONE piece ("a  ") instead of being cut at
  // the digit boundary. Assert on piece count via distinct encoded ids
  // rather than decoding: with this fixture's tiny vocab (a, Ġ, ĠĠ, 1..3)
  // the whitespace run "  " has its own vocab entry only as ĠĠ, not Ġ+Ġ,
  // so it only round-trips if the pretok pipeline kept it as one piece.
  const ids = tok.encode('a  1');
  const detok = new Detokenizer(map);
  assert.equal(detok.render(ids), 'a  1');
  // Directly assert the piece count too: 3 vocab ids (a, ĠĠ, 1), not 4
  // (a, Ġ, Ġ, 1).
  assert.equal(ids.length, 3, `expected 3 ids (a, ĠĠ, 1), got ${JSON.stringify(ids)}`);
});

test('convertHFTokenizer: Falcon shape (Punctuation Contiguous + ByteLevel + Digits + digit-triples Split) lowers to a 4-stage v2 program', () => {
  const map = convertHFTokenizer(makeFalconLikeHF(), { id: 'test/falcon-like' });
  assert.equal(map.pre_tokenizer_pattern, undefined);
  const prog = map.pre_tokenizer_program as unknown as { version: number; stages: Array<{ stage: string }> };
  assert.equal(prog.version, 2);
  assert.deepEqual(
    prog.stages.map((s) => s.stage),
    ['punctuation_contiguous', 'alternation', 'digits_isolate', 'digit_triples_isolate'],
  );
  validateMap(map);
});

test('convertHFTokenizer: DeepSeek-V3 shape (bounded digits Split + CJK Split + alternation Split + ByteLevel(use_regex=false)) lowers to a 3-stage v2 program', () => {
  const map = convertHFTokenizer(makeDeepSeekLikeHF(), { id: 'test/deepseek-like' });
  assert.equal(map.pre_tokenizer_pattern, undefined);
  const prog = map.pre_tokenizer_program as unknown as {
    version: number;
    stages: Array<{ stage: string; max_run?: number; ops?: Array<{ op: string }> }>;
  };
  assert.equal(prog.version, 2);
  assert.deepEqual(
    prog.stages.map((s) => s.stage),
    ['digits_isolate', 'cjk_isolate', 'alternation'],
  );
  // The bounded \p{N}{1,3} Split carries its max_run through.
  assert.equal(prog.stages[0]!.max_run, 3);
  // ByteLevel(use_regex=false) contributed no fourth stage: it's a
  // byte-encode-only step, not a splitting step.
  assert.equal(prog.stages.length, 3);
  // The alternation stage's ops are the DeepSeek-specific set: the
  // ASCII-punct-then-letters op the v1 schema couldn't express, a letters
  // op with the l_p_s lead-exclusion class and L_M body, and a punct_run
  // classed on P_S rather than the complement class.
  const alt = prog.stages[2]!;
  assert.deepEqual(
    alt.ops!.map((o) => o.op),
    ['punct_ascii_letters', 'letters', 'punct_run', 'newline_block', 'trailing_ws', 'ws_run'],
  );
  validateMap(map);
});

test('convertHFTokenizer: single-alternation-stage source stays on v1 (no churn for maps this fix did not need to touch)', () => {
  const map = convertHFTokenizer(makeByteLevelHF(), { id: 'test/byte-level' });
  const prog = map.pre_tokenizer_program as unknown as { version: number };
  assert.equal(prog.version, 1, 'a single Split+ByteLevel(false) source should still emit a v1 program');
});

// ── Fail loud: an unrecognised or unsupported shape must throw, not emit
//    an approximation ─────────────────────────────────────────────────────

test('convertHFTokenizer: Punctuation with non-Contiguous behavior throws', () => {
  assert.throws(
    () => convertHFTokenizer(makeUnsupportedPunctuationHF(), { id: 'test/bad-punct' }),
    /Punctuation stage has behavior "Isolated"/,
  );
});

test('convertHFTokenizer: Split with an unsupported behavior throws', () => {
  assert.throws(
    () => convertHFTokenizer(makeUnsupportedSplitBehaviorHF(), { id: 'test/bad-split' }),
    /unrecognised pattern/,
  );
});

test('convertHFTokenizer: Metaspace nested inside a byte_level Sequence throws', () => {
  assert.throws(
    () => convertHFTokenizer(makeMetaspaceInsideSequenceHF(), { id: 'test/bad-metaspace' }),
    /Metaspace nested inside a byte_level Sequence/,
  );
});

// ── metaspace + byte_fallback ───────────────────────────────────────────────

test('convertHFTokenizer: metaspace → encoder + byte_fallback range detected', () => {
  const map = convertHFTokenizer(makeMetaspaceHF(), { id: 'test/metaspace' });
  assert.equal(map.encoder, 'metaspace');
  assert.equal(map.byte_fallback_start, 3);
  assert.equal(map.byte_fallback_end, 258);
  assert.equal(map.pre_tokenizer_pattern, undefined, 'metaspace has no regex');
});

test('convertHFTokenizer: metaspace special_tokens populated from added_tokens', () => {
  const map = convertHFTokenizer(makeMetaspaceHF(), { id: 'test/metaspace' });
  assert.deepEqual(
    map.special_tokens,
    { '<unk>': 0, '<s>': 1, '</s>': 2 },
  );
});

test('convertHFTokenizer: metaspace output passes validateMap', () => {
  const map = convertHFTokenizer(makeMetaspaceHF(), { id: 'test/metaspace' });
  validateMap(map);
});

// ── Edge cases ──────────────────────────────────────────────────────────────

test('convertHFTokenizer: pair-format merges normalised to "left right" strings', () => {
  const map = convertHFTokenizer(makePairFormatMergesHF(), { id: 'test/pair' });
  assert.deepEqual(map.merges, ['a b']);
});

test('convertHFTokenizer: throws on missing model.vocab', () => {
  assert.throws(
    () => convertHFTokenizer({ model: {} } as never, { id: 'broken' }),
    /missing.*model\.vocab/i,
  );
});

test('convertHFTokenizer: vocab_size matches Object.keys(vocab).length after merging added_tokens', () => {
  const map = convertHFTokenizer(makeByteLevelHF(), { id: 'test/byte-level' });
  assert.equal(map.vocab_size, Object.keys(map.vocab ?? {}).length);
});

// ── hashMap ─────────────────────────────────────────────────────────────────

test('hashMap: returns sha256:<64 hex chars>', async () => {
  const map = convertHFTokenizer(makeByteLevelHF(), {
    id: 'test/byte-level',
    publishedAt: '2026-01-01T00:00:00.000Z',
  });
  const hash = await hashMap(map);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
});

test('hashMap: deterministic: same input → same hash', async () => {
  const opts = { id: 'test/byte-level', publishedAt: '2026-01-01T00:00:00.000Z' };
  const a = await hashMap(convertHFTokenizer(makeByteLevelHF(), opts));
  const b = await hashMap(convertHFTokenizer(makeByteLevelHF(), opts));
  assert.equal(a, b);
});

test('hashMap: id change flips the hash', async () => {
  const a = await hashMap(convertHFTokenizer(makeByteLevelHF(), {
    id: 'test/a', publishedAt: '2026-01-01T00:00:00.000Z',
  }));
  const b = await hashMap(convertHFTokenizer(makeByteLevelHF(), {
    id: 'test/b', publishedAt: '2026-01-01T00:00:00.000Z',
  }));
  assert.notEqual(a, b);
});

// ── Real Qwen-2 round-trip (uses codec-maps if checked out locally) ────────

function findQwenSource(): string | null {
  // We don't ship the source HF tokenizer.json: test against the converted
  // codec-maps file as a smoke check that the existing artefact is at least
  // self-consistent (validateMap passes + round-trips through BPE).
  const candidates = [
    'H:/dev/codec-maps/maps/qwen/qwen2.json',
    path.resolve(import.meta.dirname, '../../../../codec-maps/maps/qwen/qwen2.json'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const qwenPath = findQwenSource();

test(
  'real Qwen-2 codec-maps file: validates + round-trips through BPE',
  { skip: !qwenPath && 'codec-maps/qwen2.json not present locally' },
  () => {
    const map = JSON.parse(fs.readFileSync(qwenPath!, 'utf-8'));
    validateMap(map);
    const tok = new BPETokenizer(map);
    const detok = new Detokenizer(map);
    const samples = [
      'Hello, world!',
      'def add(a, b):\n    return a + b',
      '🚀 launch',
      '日本語',
    ];
    for (const s of samples) {
      assert.equal(detok.render(tok.encode(s)), s, `round-trip failed: ${JSON.stringify(s)}`);
    }
  },
);
