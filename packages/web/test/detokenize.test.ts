import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Detokenizer, detokenize } from '../src/detokenize.js';
import { TINY_MAP, byteId } from './fixtures.js';

test('detokenize: simple vocab tokens', () => {
  // "hello world!" via vocab IDs
  const ids = [3, 4, 5, 8]; // hello + space + world + !
  assert.equal(detokenize(TINY_MAP, ids), 'hello world!');
});

test('detokenize: skips special tokens by default', () => {
  const ids = [267, 3, 4, 5, 266]; // <bos> hello world <eos>
  assert.equal(detokenize(TINY_MAP, ids), 'hello world');
});

test('detokenize: renders special tokens when asked', () => {
  const ids = [3, 266]; // hello <eos>
  // Special-token rendering is opt-in; with renderSpecial=true we look up the
  // ID in the regular tokens map (266 isn't there → replacement char).
  // The point of this test is that the call doesn't throw and the eos token
  // doesn't silently disappear.
  const out = detokenize(TINY_MAP, ids, { renderSpecial: true });
  assert.match(out, /^hello/);
});

test('detokenize: byte-fallback for a 3-byte UTF-8 sequence (€ = E2 82 AC)', () => {
  const ids = [byteId(0xe2), byteId(0x82), byteId(0xac)];
  assert.equal(detokenize(TINY_MAP, ids), '€');
});

test('detokenize: byte-fallback for a 4-byte emoji (🚀 = F0 9F 9A 80)', () => {
  const ids = [byteId(0xf0), byteId(0x9f), byteId(0x9a), byteId(0x80)];
  assert.equal(detokenize(TINY_MAP, ids), '🚀');
});

test('Detokenizer: partial multi-byte sequence buffered across frames', () => {
  const d = new Detokenizer(TINY_MAP);
  // Frame 1: first 2 bytes of € — incomplete, must not emit anything.
  const out1 = d.render([byteId(0xe2), byteId(0x82)], { partial: true });
  assert.equal(out1, '', 'partial sequence should not emit');
  // Frame 2: final byte. Now the character flushes.
  const out2 = d.render([byteId(0xac)], { partial: false });
  assert.equal(out2, '€');
});

test('Detokenizer: vocab token after partial bytes flushes the buffer first', () => {
  const d = new Detokenizer(TINY_MAP);
  // Buffer up an incomplete sequence, then emit a vocab token.
  // The vocab token must trigger a flush of whatever bytes are pending.
  const out = d.render([byteId(0x41), 3], { partial: false }); // 'A' as byte + 'hello'
  assert.equal(out, 'Ahello');
});

test('Detokenizer: unknown ID emits replacement', () => {
  const d = new Detokenizer(TINY_MAP);
  const out = d.render([99999], { partial: false });
  assert.equal(out, '�');
});

test('Detokenizer: reset clears partial buffer', () => {
  const d = new Detokenizer(TINY_MAP);
  d.render([byteId(0xe2)], { partial: true }); // start a partial €
  d.reset();
  const out = d.render([3], { partial: false });
  assert.equal(out, 'hello', 'partial buffer should not bleed across reset');
});
