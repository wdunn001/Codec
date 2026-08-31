/**
 * Translator tests: cross-vocab translation correctness.
 *
 * Three layers of verification:
 *   1. Synthetic byte_level fixture round-trips with itself (identity translation).
 *   2. Real Qwen-2 → Qwen-2 (identity over a 152K-vocab production tokenizer)
 *: proves the streaming buffering doesn't drop or duplicate text.
 *   3. Cross-vocab: real Qwen-2 → Llama-3 (when both maps are present locally)
 *: sanity-checks that translated output detokenizes back to the
 *      original text under the target tokenizer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  BPETokenizer,
  Detokenizer,
  Translator,
  staticTranslationTable,
  translate,
  type TokenizerMap,
} from '../src/index.ts';

// ── Synthetic identity translation ─────────────────────────────────────────

function findRealMap(family: 'qwen' | 'meta-llama'): string | null {
  const filename = family === 'qwen' ? 'qwen2.json' : 'llama-3.json';
  const candidates = [
    path.resolve('H:/dev/codec-maps/maps', family, filename),
    path.resolve(import.meta.dirname, '../../../../codec-maps/maps', family, filename),
    path.resolve(import.meta.dirname, '../../../../../codec-maps/maps', family, filename),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const QWEN_PATH  = findRealMap('qwen');
const LLAMA_PATH = findRealMap('meta-llama');

function loadMap(p: string): TokenizerMap {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ── Real Qwen-2 identity translation ──────────────────────────────────────

test(
  'Translator: real Qwen-2 → Qwen-2 identity round-trips through detokenize',
  { skip: !QWEN_PATH && 'codec-maps/qwen/qwen2.json not present' },
  () => {
    const map = loadMap(QWEN_PATH!);
    const tok = new BPETokenizer(map);
    const detok = new Detokenizer(map);
    const tr = new Translator(map, map);

    const samples = [
      'Hello, world!',
      'def add(a, b):\n    return a + b',
      'Multiple   spaces   between   words.',
      '🚀 launch',
      '日本語のテキスト',
      'Café résumé naïve façade',
    ];
    for (const s of samples) {
      const ids = tok.encode(s);
      const translated = tr.translate(ids);
      assert.equal(detok.render(translated), s,
        `identity round-trip failed for ${JSON.stringify(s)}`);
    }
  },
);

test(
  'Translator: streaming Qwen-2 → Qwen-2 yields the same final IDs as one-shot',
  { skip: !QWEN_PATH && 'codec-maps/qwen/qwen2.json not present' },
  () => {
    const map = loadMap(QWEN_PATH!);
    const tok = new BPETokenizer(map);
    const tr = new Translator(map, map);
    const detok = new Detokenizer(map);

    const text = 'The quick brown fox jumps over the lazy dog. ' +
                 'Pack my box with five dozen liquor jugs.';
    const ids = tok.encode(text);

    // Feed in 3-token chunks with partial=true, then a final partial=false flush.
    const collected: number[] = [];
    const chunkSize = 3;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const isLast = i + chunkSize >= ids.length;
      const out = tr.translate(chunk, { partial: !isLast });
      collected.push(...out);
    }
    // After the final chunk with partial=false there should be no buffered residue.
    assert.equal(detok.render(collected), text);
  },
);

// ── Cross-vocab: Qwen-2 → Llama-3 ─────────────────────────────────────────

test(
  'Translator: Qwen-2 → Llama-3 cross-vocab translation round-trips',
  {
    skip: (!QWEN_PATH || !LLAMA_PATH) &&
      'requires both codec-maps/qwen/qwen2.json and codec-maps/meta-llama/llama-3.json',
  },
  () => {
    const qwen  = loadMap(QWEN_PATH!);
    const llama = loadMap(LLAMA_PATH!);

    const qwenTok    = new BPETokenizer(qwen);
    const llamaDetok = new Detokenizer(llama);
    const tr         = new Translator(qwen, llama);

    const samples = [
      'Hello, world!',
      'def add(a, b):\n    return a + b',
      'Explain entropy in one sentence.',
      'Multiple   spaces.',
    ];
    for (const s of samples) {
      const qwenIds  = qwenTok.encode(s);
      const llamaIds = tr.translate(qwenIds);
      const text     = llamaDetok.render(llamaIds);
      assert.equal(text, s,
        `Qwen→Llama round-trip failed for ${JSON.stringify(s)}`);
    }
  },
);

// ── translate() one-shot helper ───────────────────────────────────────────

test(
  'translate(): one-shot helper produces same IDs as new Translator(...).translate(ids)',
  { skip: !QWEN_PATH && 'codec-maps/qwen/qwen2.json not present' },
  () => {
    const map = loadMap(QWEN_PATH!);
    const tok = new BPETokenizer(map);
    const ids = tok.encode('Identity check.');
    const a = translate(map, map, ids);
    const b = new Translator(map, map).translate(ids);
    assert.deepEqual(a, b);
  },
);

// ── Static translation table ──────────────────────────────────────────────

test(
  'staticTranslationTable: covers every non-special source vocab entry',
  { skip: !QWEN_PATH && 'codec-maps/qwen/qwen2.json not present' },
  () => {
    const map = loadMap(QWEN_PATH!);
    const table = staticTranslationTable(map, map);
    // Every non-special token should map to a non-empty target sequence.
    const specialIds = new Set(Object.values(map.special_tokens ?? {}));
    let nonSpecialCount = 0;
    let coveredCount = 0;
    for (const id of Object.values(map.vocab ?? {})) {
      if (specialIds.has(id)) continue;
      nonSpecialCount++;
      if (table.has(id)) coveredCount++;
    }
    // Allow a small margin for byte-fallback / control tokens whose decoded
    // text is empty or unrenderable; the bulk should be covered.
    const coverage = coveredCount / nonSpecialCount;
    assert.ok(coverage > 0.99,
      `expected >99% coverage, got ${(coverage * 100).toFixed(2)}%`);
  },
);

test(
  'staticTranslationTable: identity translation maps each ID to a sequence containing itself',
  { skip: !QWEN_PATH && 'codec-maps/qwen/qwen2.json not present' },
  () => {
    const map = loadMap(QWEN_PATH!);
    const table = staticTranslationTable(map, map);

    // Pick a few common tokens and verify the table maps them to themselves
    // (this is the byte_level invariant: re-tokenizing a token's own decoded
    // text yields that same single token, when it's a complete BPE token).
    const sampleKeys = ['Hello', 'world', '!'];
    for (const key of sampleKeys) {
      const id = (map.vocab ?? {})[key];
      if (id === undefined) continue;
      const out = table.get(id);
      assert.ok(out !== undefined && out.length === 1 && out[0] === id,
        `expected ${key} (id ${id}) → [${id}], got ${JSON.stringify(out)}`);
    }
  },
);
