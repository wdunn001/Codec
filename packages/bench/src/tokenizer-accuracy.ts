/**
 * Tokenizer accuracy bench.
 *
 * Validates that @codecai/web's pure-JS BPE produces the SAME token IDs as
 * the HuggingFace `tokenizers` Rust library for the same input text and
 * tokenizer map. The HF library is the reference implementation — it's
 * literally what produced our maps in the first place — so this is the
 * gold standard for "is our BPE correct against the live model."
 *
 * Tokenization is deterministic, so no seed is needed. If our IDs match
 * HF's IDs for every test string, then a request `prompt: tok.encode(text)`
 * sent over the bidirectional Codec endpoint is bit-equivalent to a
 * request `prompt: text` decoded by the server's tokenizer.
 *
 * Usage:
 *   1. python scripts/gen-golden-ids.py Qwen/Qwen2.5-7B-Instruct \
 *        --out golden/qwen2.json
 *   2. tsx src/tokenizer-accuracy.ts
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BPETokenizer,
  Detokenizer,
  validateMap,
  type TokenizerMap,
} from '@codecai/web';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

interface GoldenFile {
  model: string;
  tokenizer_lib: string;
  add_special_tokens: boolean;
  samples: Array<{ text: string; ids: number[] }>;
}

interface MismatchRow {
  text: string;
  ours: number[];
  reference: number[];
  divergeAt: number;
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function divergeIndex(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function fmtTextPreview(s: string, max = 60): string {
  const escaped = s.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return escaped.length <= max ? escaped : escaped.slice(0, max - 1) + '…';
}

// ── Run ──────────────────────────────────────────────────────────────────────

interface Suite {
  name: string;
  mapPath: string;
  goldenPath: string;
}

const suites: Suite[] = [
  {
    name: 'qwen/qwen2 (Qwen2.5-7B-Instruct)',
    mapPath: resolve('H:/dev/codec-maps/maps/qwen/qwen2.json'),
    goldenPath: resolve(ROOT, 'golden/qwen2.json'),
  },
];

console.log('# Tokenizer accuracy benchmark\n');
console.log(
  'For each map, encodes a corpus of test strings with @codecai/web BPE\n' +
    'and compares to ground truth from the HuggingFace tokenizers library\n' +
    '(the reference implementation our maps are derived from).\n',
);

let suitesRun = 0;
let suitesPassed = 0;

for (const suite of suites) {
  console.log(`── ${suite.name} ${'─'.repeat(Math.max(0, 70 - suite.name.length))}`);

  let map: TokenizerMap;
  let golden: GoldenFile;
  try {
    map = loadJson<TokenizerMap>(suite.mapPath);
    validateMap(map);
    golden = loadJson<GoldenFile>(suite.goldenPath);
  } catch (e) {
    console.log(`  ⚠ skipped: ${(e as Error).message}\n`);
    continue;
  }

  suitesRun++;
  const tok = new BPETokenizer(map);
  const detok = new Detokenizer(map);

  const mismatches: MismatchRow[] = [];
  const detokMismatches: Array<{ text: string; got: string }> = [];
  let exactCount = 0;
  let detokOkCount = 0;

  const startEncode = performance.now();
  const allEncoded: number[][] = [];
  for (const sample of golden.samples) {
    const ours = tok.encode(sample.text);
    allEncoded.push(ours);
    if (arraysEqual(ours, sample.ids)) {
      exactCount++;
    } else {
      mismatches.push({
        text: sample.text,
        ours,
        reference: sample.ids,
        divergeAt: divergeIndex(ours, sample.ids),
      });
    }
  }
  const encodeMs = performance.now() - startEncode;

  // Round-trip check using HF reference IDs (decoupled from our encode).
  const startDecode = performance.now();
  for (const sample of golden.samples) {
    const got = detok.render(sample.ids);
    if (got === sample.text) {
      detokOkCount++;
    } else {
      detokMismatches.push({ text: sample.text, got });
    }
  }
  const decodeMs = performance.now() - startDecode;

  const total = golden.samples.length;
  const encMatchPct = ((exactCount / total) * 100).toFixed(1);
  const decMatchPct = ((detokOkCount / total) * 100).toFixed(1);
  console.log(`  samples              ${total}`);
  console.log(`  encode exact-match   ${exactCount}/${total} (${encMatchPct}%)`);
  console.log(`  decode round-trip    ${detokOkCount}/${total} (${decMatchPct}%)`);
  console.log(`  encode total time    ${encodeMs.toFixed(1)} ms`);
  console.log(`  decode total time    ${decodeMs.toFixed(1)} ms`);

  if (mismatches.length > 0) {
    console.log(`\n  encode mismatches (showing first 5 of ${mismatches.length}):`);
    for (const m of mismatches.slice(0, 5)) {
      console.log(`    text   "${fmtTextPreview(m.text)}"`);
      console.log(
        `    ours   [${m.ours.slice(0, 8).join(', ')}${m.ours.length > 8 ? ', …' : ''}] (len ${m.ours.length})`,
      );
      console.log(
        `    ref    [${m.reference.slice(0, 8).join(', ')}${m.reference.length > 8 ? ', …' : ''}] (len ${m.reference.length})`,
      );
      console.log(`    diverges at index ${m.divergeAt}`);
    }
  }
  if (detokMismatches.length > 0) {
    console.log(`\n  decode mismatches (showing first 5 of ${detokMismatches.length}):`);
    for (const m of detokMismatches.slice(0, 5)) {
      console.log(`    expected "${fmtTextPreview(m.text)}"`);
      console.log(`    got      "${fmtTextPreview(m.got)}"`);
    }
  }

  if (mismatches.length === 0 && detokMismatches.length === 0) {
    suitesPassed++;
    console.log('  ✓ exact match for all samples\n');
  } else {
    console.log('  ✗ divergence detected\n');
  }
}

console.log('─'.repeat(72));
console.log(`\nSuites: ${suitesPassed}/${suitesRun} passed.`);
if (suitesRun === 0) {
  console.log(
    '\nNo suites ran. To produce golden files:\n' +
      '  pip install tokenizers\n' +
      '  python scripts/gen-golden-ids.py Qwen/Qwen2.5-7B-Instruct \\\n' +
      '      --out golden/qwen2.json\n',
  );
}

if (suitesRun > 0 && suitesPassed < suitesRun) {
  process.exit(1);
}
