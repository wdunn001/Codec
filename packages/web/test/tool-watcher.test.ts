/**
 * ToolWatcher tests.
 *
 * Mirrors the C `test_tool_watcher.c` cases plus a "no decode" contract
 * test that uses bogus IDs outside any vocab to prove the watcher never
 * routes through the detokenizer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ToolWatcher,
  ToolWatcherError,
  validateMap,
  type TokenizerMap,
} from '../src/index.ts';

const SYN_MAP_RAW = {
  id: 'test/synth',
  version: '2' as const,
  vocab_size: 100,
  encoder: 'byte_level' as const,
  vocab: { hello: 0, world: 1, '!': 2, foo: 3, bar: 4 },
  special_tokens: { '<tool_call>': 90, '</tool_call>': 91 },
};
validateMap(SYN_MAP_RAW);
const SYN_MAP: TokenizerMap = SYN_MAP_RAW;

const START = 90, END = 91;

test('ToolWatcher: passthrough → region → passthrough', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');
  /* "hello world <tool_call> foo bar </tool_call> hello !" */
  const events = w.feed([0, 1, START, 3, 4, END, 0, 2]);
  assert.equal(events.length, 3);

  assert.equal(events[0]!.kind, 'passthrough');
  assert.deepEqual(events[0]!.ids, [0, 1]);

  assert.equal(events[1]!.kind, 'region');
  assert.deepEqual(events[1]!.ids, [3, 4]);  /* markers excluded */

  assert.equal(events[2]!.kind, 'passthrough');
  assert.deepEqual(events[2]!.ids, [0, 2]);

  assert.equal(w.inside, false);
});

test('ToolWatcher: region split across feeds', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');

  /* Feed 1: "hello <tool_call> foo": region opens but doesn't close. */
  let evs = w.feed([0, START, 3]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, 'passthrough');
  assert.deepEqual(evs[0]!.ids, [0]);
  assert.equal(w.inside, true);

  /* Feed 2: "bar </tool_call> world": closes region, then more text. */
  evs = w.feed([4, END, 1]);
  assert.equal(evs.length, 2);
  assert.equal(evs[0]!.kind, 'region');
  /* Body accumulated across both feeds. */
  assert.deepEqual(evs[0]!.ids, [3, 4]);
  assert.equal(evs[1]!.kind, 'passthrough');
  assert.deepEqual(evs[1]!.ids, [1]);
  assert.equal(w.inside, false);
});

test('ToolWatcher: multiple regions in one feed', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');
  const evs = w.feed([0, START, 3, END, 1, START, 4, END, 2]);
  assert.equal(evs.length, 5);
  assert.equal(evs[0]!.kind, 'passthrough');
  assert.equal(evs[1]!.kind, 'region');
  assert.deepEqual(evs[1]!.ids, [3]);
  assert.equal(evs[2]!.kind, 'passthrough');
  assert.equal(evs[3]!.kind, 'region');
  assert.deepEqual(evs[3]!.ids, [4]);
  assert.equal(evs[4]!.kind, 'passthrough');
});

test('ToolWatcher: stray end marker passes through', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');
  const evs = w.feed([0, END, 1]);
  /* End marker without preceding start: treated as ordinary token. */
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, 'passthrough');
  assert.deepEqual(evs[0]!.ids, [0, END, 1]);
});

test('ToolWatcher: missing special name throws', () => {
  assert.throws(
    () => new ToolWatcher(SYN_MAP, '<not_real>', '</tool_call>'),
    ToolWatcherError);
});

test('ToolWatcher: reset() drops in-flight region', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');
  w.feed([START, 3, 4]);
  assert.equal(w.inside, true);
  w.reset();
  assert.equal(w.inside, false);
  /* Feeding the end marker now should be a stray (no buffered body). */
  const evs = w.feed([END, 1]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, 'passthrough');
  assert.deepEqual(evs[0]!.ids, [END, 1]);
});

/*
 * No-decode contract: mirrors test_watcher_does_not_decode_tokens in
 * the C suite. Use a map with empty vocab and feed token IDs that are
 * outside any reasonable vocab range (and above vocab_size). The
 * watcher must emit them verbatim. Any decode path would either fail
 * the vocab lookup or produce empty strings: either way, bit-for-bit
 * equality on emitted IDs would not hold.
 */
test('ToolWatcher: never decodes: operates on raw IDs', () => {
  const noVocabRaw = {
    id: 'test/no-vocab',
    version: '2' as const,
    vocab_size: 4,
    encoder: 'byte_level' as const,
    vocab: {},
    special_tokens: { '<tool_call>': 90, '</tool_call>': 91 },
  };
  validateMap(noVocabRaw);
  const noVocab: TokenizerMap = noVocabRaw;
  const w = new ToolWatcher(noVocab, '<tool_call>', '</tool_call>');
  /* Big values: well above any plausible vocab. */
  const BIG_A = 0xFFFFFF00, BIG_B = 0xDEADBEEF, BIG_C = 0xCAFEBABE;
  const evs = w.feed([12345, BIG_A, START, BIG_B, BIG_C, END, 99999]);
  assert.equal(evs.length, 3);
  assert.deepEqual(evs[0]!.ids, [12345, BIG_A]);
  assert.deepEqual(evs[1]!.ids, [BIG_B, BIG_C]);  /* body verbatim */
  assert.deepEqual(evs[2]!.ids, [99999]);
});

// ── Real Qwen-2 sanity check (when codec-maps is mounted) ──────────────────

function findQwen2Map(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '../../../codec-maps/maps/qwen/qwen2.json'),
    path.resolve(process.cwd(), '../../codec-maps/maps/qwen/qwen2.json'),
    process.env.CODEC_MAPS_QWEN ?? '',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

test('ToolWatcher: real Qwen-2 map resolves <tool_call> to 151657', { skip: !findQwen2Map() }, () => {
  const p = findQwen2Map()!;
  const map = JSON.parse(fs.readFileSync(p, 'utf-8'));
  validateMap(map);
  /* Qwen-2 ships <tool_call> at 151657, </tool_call> at 151658. */
  assert.equal(map.special_tokens?.['<tool_call>'],  151657);
  assert.equal(map.special_tokens?.['</tool_call>'], 151658);

  const w = new ToolWatcher(map, '<tool_call>', '</tool_call>');
  const evs = w.feed([9707, 151657, 90909, 12345, 67890, 151658, 1101]);
  assert.equal(evs.length, 3);
  assert.equal(evs[0]!.kind, 'passthrough');
  assert.equal(evs[1]!.kind, 'region');
  assert.equal(evs[1]!.ids.length, 3);
  assert.equal(evs[2]!.kind, 'passthrough');
});
