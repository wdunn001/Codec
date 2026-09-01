import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LongestMatchTokenizer, tokenize } from '../src/tokenize.js';
import { detokenize } from '../src/detokenize.js';
import { TINY_MAP } from './fixtures.js';

test('tokenize: longest-match wins over shorter prefixes', () => {
  // 'h'=1, 'he'=2, 'hello'=3: must pick 3
  const ids = tokenize(TINY_MAP, 'hello');
  assert.deepEqual(ids, [3]);
});

test('tokenize: round-trips through detokenize for vocab-covered text', () => {
  const text = 'hello world!';
  const ids = tokenize(TINY_MAP, text);
  assert.equal(detokenize(TINY_MAP, ids), text);
});

test('tokenize: special-token marker syntax produces the special ID', () => {
  const ids = tokenize(TINY_MAP, '<|eos|>');
  assert.deepEqual(ids, [266]);
});

test('tokenize: combines vocab tokens with special markers', () => {
  const ids = tokenize(TINY_MAP, '<|bos|>hello<|eos|>');
  assert.deepEqual(ids, [267, 3, 266]);
});

test('LongestMatchTokenizer: id matches map id', () => {
  const t = new LongestMatchTokenizer(TINY_MAP);
  assert.equal(t.id, TINY_MAP.id);
});

test('tokenize: unknown char emits UNK (id 0)', () => {
  // 'Q' is not in the vocab; should fall through to UNK.
  const ids = tokenize(TINY_MAP, 'Q');
  assert.deepEqual(ids, [0]);
});
