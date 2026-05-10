/**
 * BPE round-trip tests.
 *
 * The strict correctness bar: for any model in our maps directory, encoding
 * a string and then detokenizing the resulting IDs must reproduce the
 * original string. We run this against:
 *
 *   - A synthetic byte_level map (deterministic, no network).
 *   - A synthetic metaspace map.
 *   - The real Qwen-2 map (if available locally) — covers a 152K-vocab
 *     production tokenizer with all the GPT-2 byte-encoding subtleties.
 *
 * For the synthetic maps we also assert exact ID sequences for known inputs
 * so any future regression in the merge engine is caught immediately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BPETokenizer } from '../src/bpe.ts';
import { Detokenizer } from '../src/detokenize.ts';
import { encodeByteLevelChars, METASPACE } from '../src/encoder.ts';
import type { TokenizerMap } from '../src/types.ts';

// ── Synthetic byte_level fixture ─────────────────────────────────────────────
// Tiny vocab covering "hello world" + a few GPT-2-encoded byte chars. Merges
// are crafted so "hello" merges from h+e+l+l+o, and "Ġworld" merges from
// "Ġ" + "world".

function makeByteLevelFixture(): TokenizerMap {
  const G = encodeByteLevelChars(new Uint8Array([0x20])); // space → "Ġ"
  const vocab: Record<string, number> = {
    // Single-byte tokens for ASCII letters used.
    h: 0,
    e: 1,
    l: 2,
    o: 3,
    w: 4,
    r: 5,
    d: 6,
    [G]: 7, // single byte-encoded space
    '!': 8,
    // BPE-merged tokens.
    he: 9,
    hel: 10,
    hell: 11,
    hello: 12,
    wo: 13,
    wor: 14,
    worl: 15,
    world: 16,
    [G + 'world']: 17,
  };
  const merges: string[] = [
    'h e',
    'he l',
    'hel l',
    'hell o',
    'w o',
    'wo r',
    'wor l',
    'worl d',
    G + ' world',
  ];
  return {
    id: 'test/byte_level',
    version: '2',
    vocab_size: Object.keys(vocab).length,
    vocab,
    encoder: 'byte_level',
    merges,
    // Llama-3-style pre-tokenizer (simplified): word + maybe-leading-space.
    pre_tokenizer_pattern: ` ?[A-Za-z]+| ?[^A-Za-z\\s]+|\\s+`,
  };
}

test('BPE byte_level: encodes "hello world!" to expected ID sequence', () => {
  const map = makeByteLevelFixture();
  const tok = new BPETokenizer(map);
  const ids = tok.encode('hello world!');
  // Pre-tokenize: ["hello", " world", "!"]
  // → "hello" merges to id 12
  // → " world" → "Ġworld" merges to id 17
  // → "!" → id 8
  assert.deepEqual(ids, [12, 17, 8]);
});

test('BPE byte_level: round-trips through detokenizer', () => {
  const map = makeByteLevelFixture();
  const tok = new BPETokenizer(map);
  const detok = new Detokenizer(map);
  const text = 'hello world!';
  const out = detok.render(tok.encode(text));
  assert.equal(out, text);
});

test('BPE byte_level: merges greedily by priority, not left-to-right', () => {
  // Build a fixture where the wrong order produces the wrong tokens.
  const G = encodeByteLevelChars(new Uint8Array([0x20]));
  const vocab: Record<string, number> = {
    a: 0, b: 1, c: 2, ab: 3, bc: 4, abc: 5,
  };
  // Merge "b c" first (lower index = higher priority).
  // Greedy left-to-right would produce "ab" + "c" → 3, 2.
  // Priority-correct produces "a" + "bc" → 0, 4.
  const merges = ['b c', 'a b'];
  const map: TokenizerMap = {
    id: 'test/priority', version: '2', vocab_size: 6,
    vocab, encoder: 'byte_level', merges,
    pre_tokenizer_pattern: '\\S+',
  };
  const tok = new BPETokenizer(map);
  assert.deepEqual(tok.encode('abc'), [0, 4]);
});

// ── Synthetic metaspace fixture ──────────────────────────────────────────────

function makeMetaspaceFixture(): TokenizerMap {
  const M = METASPACE; // ▁
  const vocab: Record<string, number> = {
    [M]: 0,
    [M + 'h']: 1,
    [M + 'he']: 2,
    [M + 'hel']: 3,
    [M + 'hello']: 4,
    [M + 'w']: 5,
    [M + 'world']: 6,
    h: 7, e: 8, l: 9, o: 10, w: 11, r: 12, d: 13,
    // SentencePiece byte fallback
    '<0x00>': 14,
    // ... we'd have all 256 in real maps; we only need byte_fallback_start/end
    // set so the BPETokenizer knows it can fall back.
  };
  // Add full byte fallback range (14..269)
  for (let i = 1; i < 256; i++) {
    const hex = i.toString(16).padStart(2, '0').toUpperCase();
    vocab[`<0x${hex}>`] = 14 + i;
  }
  // Each merge is "left right" → the two get fused. BPE starts from individual
  // codepoints, so we need the first merges to fuse ▁ with the next char.
  const merges = [
    `${M} h`,
    `${M}h e`,
    `${M}he l`,
    `${M}hel l`,
    `${M}hell o`,
    `${M} w`,
    `${M}w o`,
    `${M}wo r`,
    `${M}wor l`,
    `${M}worl d`,
  ];
  return {
    id: 'test/metaspace',
    version: '2',
    vocab_size: Object.keys(vocab).length,
    vocab,
    encoder: 'metaspace',
    merges,
    byte_fallback_start: 14,
    byte_fallback_end: 14 + 255,
  };
}

test('BPE metaspace: encodes "hello world" with ▁-prefix', () => {
  const map = makeMetaspaceFixture();
  const tok = new BPETokenizer(map);
  const ids = tok.encode('hello world');
  // Pre-tok: ["▁hello", "▁world"] → [4, 6]
  assert.deepEqual(ids, [4, 6]);
});

test('BPE metaspace: round-trips through detokenizer', () => {
  const map = makeMetaspaceFixture();
  const tok = new BPETokenizer(map);
  const detok = new Detokenizer(map);
  const text = 'hello world';
  // Metaspace round-trips with a leading space artifact since every word
  // gets a ▁ prefix → first word's space is the artifact. Production
  // tokenizers use Strip in the decoder; we render literally.
  const out = detok.render(tok.encode(text));
  assert.equal(out.replace(/^\s+/, ''), text);
});

// ── Real model round-trip (if a fetched map is available) ───────────────────

// Real Qwen map lives in the sibling codec-maps repo. Try a few paths so this
// works whether running from the package, the workspace root, or a worktree.
function findQwenMap(): string | null {
  const candidates = [
    path.resolve(import.meta.dirname, '../../../../codec-maps/maps/qwen/qwen2.json'),
    path.resolve(import.meta.dirname, '../../../../../codec-maps/maps/qwen/qwen2.json'),
    'H:/dev/codec-maps/maps/qwen/qwen2.json',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}
const QWEN_MAP_PATH = findQwenMap();
const haveRealMap = QWEN_MAP_PATH !== null;

test(
  'BPE byte_level: round-trips real Qwen-2 map for ASCII text',
  { skip: !haveRealMap && 'codec-maps/qwen2.json not present locally' },
  () => {
    const map = JSON.parse(fs.readFileSync(QWEN_MAP_PATH!, 'utf-8')) as TokenizerMap;
    const tok = new BPETokenizer(map);
    const detok = new Detokenizer(map);
    const samples = [
      'Hello, world!',
      'Explain entropy in one sentence.',
      'def add(a, b):\n    return a + b',
      'Multiple   spaces   between   words.',
    ];
    for (const s of samples) {
      const ids = tok.encode(s);
      const out = detok.render(ids);
      assert.equal(out, s, `round-trip failed for: ${JSON.stringify(s)}`);
    }
  },
);

test(
  'BPE byte_level: round-trips real Qwen-2 map for unicode (emoji, CJK)',
  { skip: !haveRealMap && 'codec-maps/qwen2.json not present locally' },
  () => {
    const map = JSON.parse(fs.readFileSync(QWEN_MAP_PATH!, 'utf-8')) as TokenizerMap;
    const tok = new BPETokenizer(map);
    const detok = new Detokenizer(map);
    const samples = [
      '🚀 launch',
      '日本語のテキスト',
      'Café résumé naïve',
    ];
    for (const s of samples) {
      const ids = tok.encode(s);
      const out = detok.render(ids);
      assert.equal(out, s, `round-trip failed for: ${JSON.stringify(s)}`);
    }
  },
);

test(
  'BPE byte_level: chat-template and FIM specials emit atomic IDs (HF parity)',
  { skip: !haveRealMap && 'codec-maps/qwen2.json not present locally' },
  () => {
    // Reference IDs from running HuggingFace tokenizers 0.23.1 against
    // Qwen/Qwen2.5-0.5B-Instruct tokenizer.json. The encoder must emit
    // each `<|...|>` delimiter as the single atomic vocab ID, not as a
    // byte-level sequence (`<`, `|`, `im`, `_start`, `|`, `>`).
    const map = JSON.parse(fs.readFileSync(QWEN_MAP_PATH!, 'utf-8')) as TokenizerMap;
    const tok = new BPETokenizer(map);
    assert.deepEqual(
      tok.encode('<|im_start|>user\nWhat is 2+2?<|im_end|>'),
      [151644, 872, 198, 3838, 374, 220, 17, 10, 17, 30, 151645],
    );
    assert.deepEqual(
      tok.encode('<|fim_prefix|>def foo(x):<|fim_suffix|>    return x<|fim_middle|>\n'),
      [151659, 750, 15229, 2075, 1648, 151661, 262, 470, 856, 151660, 198],
    );
    assert.deepEqual(
      tok.encode('<|im_start|>system\nYou are helpful.<|im_end|>\n<|im_start|>user\nHello<|im_end|>'),
      [151644, 8948, 198, 2610, 525, 10950, 13, 151645, 198, 151644, 872, 198, 9707, 151645],
    );
  },
);
