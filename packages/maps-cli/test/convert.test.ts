/**
 * convertHFTokenizer correctness — synthetic fixtures + a real Qwen-2
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
    / \?\[A-Za-z\]\+/,
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

test('hashMap: deterministic — same input → same hash', async () => {
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
  // We don't ship the source HF tokenizer.json — test against the converted
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
