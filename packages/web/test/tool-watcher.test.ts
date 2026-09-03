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
  DEFAULT_REGION_CAP,
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

// ── Ordering: interleaved events in stream order (defect 3) ────────────────
//
// [a, S, X, E, b, S, Y, E, c] must produce five ORDERED events:
// passthrough(a) / region(X) / passthrough(b) / region(Y) / passthrough(c).
// This is the exact shape every language's watcher must agree on.

test('ToolWatcher: ordering matches the defect-3 example', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');
  const a = 0, b = 1, c = 2, x = 3, y = 4; // hello, world, !, foo, bar
  const evs = w.feed([a, START, x, END, b, START, y, END, c]);
  assert.equal(evs.length, 5);
  assert.equal(evs[0]!.kind, 'passthrough');
  assert.deepEqual(evs[0]!.ids, [a]);
  assert.equal(evs[1]!.kind, 'region');
  assert.deepEqual(evs[1]!.ids, [x]);
  assert.equal(evs[2]!.kind, 'passthrough');
  assert.deepEqual(evs[2]!.ids, [b]);
  assert.equal(evs[3]!.kind, 'region');
  assert.deepEqual(evs[3]!.ids, [y]);
  assert.equal(evs[4]!.kind, 'passthrough');
  assert.deepEqual(evs[4]!.ids, [c]);
});

// ── Nested start markers (defect 5) ─────────────────────────────────────────

test('ToolWatcher: nested start is dropped from the body but observable', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');
  // S 0 S 1 E 2 -> nested_start / region([0,1]) / passthrough([2])
  const evs = w.feed([START, 0, START, 1, END, 2]);
  assert.equal(evs.length, 3);
  assert.equal(evs[0]!.kind, 'nested_start');
  assert.deepEqual(evs[0]!.ids, [START]);
  assert.equal(evs[1]!.kind, 'region');
  assert.deepEqual(evs[1]!.ids, [0, 1]);
  assert.equal(evs[2]!.kind, 'passthrough');
  assert.deepEqual(evs[2]!.ids, [2]);
});

// ── Truncation: end() while inside a region (defect 1) ──────────────────────
//
// An unterminated region (stream ends mid tool-call, e.g. the model hit
// its length limit) used to be silently dropped: no event, no signal,
// indistinguishable from a model that never called a tool. end() must
// report it, carrying the finish reason so a length stop is distinguishable
// from a malformed emission.

test('ToolWatcher: end() emits truncated with the finish reason', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');
  let evs = w.feed([0, START, 3, 4]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, 'passthrough');
  assert.equal(w.inside, true);

  evs = w.end('length');
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, 'truncated');
  assert.deepEqual(evs[0]!.ids, [3, 4]);
  assert.equal((evs[0] as { finishReason: string | null }).finishReason, 'length');
  assert.equal(w.inside, false);

  // A second end() call is a no-op: nothing left in flight.
  assert.deepEqual(w.end('length'), []);
});

test('ToolWatcher: end() reports an empty body when the stream ends right after start', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');
  w.feed([START]);
  assert.equal(w.inside, true);

  const evs = w.end(); // no finish reason known
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, 'truncated');
  assert.deepEqual(evs[0]!.ids, []);
  assert.equal((evs[0] as { finishReason: string | null }).finishReason, null);
});

test('ToolWatcher: end() outside a region emits nothing', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');
  w.feed([START, 3, END, 4]);
  assert.equal(w.inside, false);
  assert.deepEqual(w.end('stop'), []);
});

// ── Overflow: region buffer cap (defect 2) ──────────────────────────────────
//
// The region buffer used to grow without bound: a client that can make
// the model emit a start marker without a matching end marker could grow
// it to the entire remaining generation. The cap must be enforced and the
// overflow must be a defined, observable event, not a silent truncation.

test('ToolWatcher: region cap defaults and is settable', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>');
  assert.equal(w.regionCap, DEFAULT_REGION_CAP);

  w.setRegionCap(3);
  assert.equal(w.regionCap, 3);

  // 0 resets to the default rather than becoming an unusable cap.
  w.setRegionCap(0);
  assert.equal(w.regionCap, DEFAULT_REGION_CAP);

  const w2 = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>', 3);
  assert.equal(w2.regionCap, 3);
});

test('ToolWatcher: overflow fires once at the cap, then resyncs on the end marker', () => {
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>', 3);
  // Region body is 5 tokens long against a cap of 3: must overflow once,
  // with exactly the first 3 tokens, and must NOT also emit a region
  // event for the same region when the end marker eventually arrives.
  const evs = w.feed([START, 1, 2, 3, 4, 5, END, 9]);
  assert.equal(evs.length, 2);
  assert.equal(evs[0]!.kind, 'overflow');
  assert.deepEqual(evs[0]!.ids, [1, 2, 3]);
  assert.equal(evs[1]!.kind, 'passthrough');
  assert.deepEqual(evs[1]!.ids, [9]);
  assert.equal(w.inside, false);
});

test('ToolWatcher: overflow then truncated reports both', () => {
  // A region that overflows and then never sees an end marker must
  // report BOTH: the overflow (memory bound hit) and the truncation
  // (stream ended without a close). They are orthogonal signals.
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>', 2);
  let evs = w.feed([START, 1, 2, 3, 4]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, 'overflow');
  assert.deepEqual(evs[0]!.ids, [1, 2]);

  evs = w.end('length');
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, 'truncated');
  assert.deepEqual(evs[0]!.ids, [1, 2]);
});

test('ToolWatcher: a region exactly at the cap does not overflow', () => {
  // Off-by-one check: a region whose body is exactly `cap` tokens must
  // close cleanly as `region`, not as `overflow`.
  const w = new ToolWatcher(SYN_MAP, '<tool_call>', '</tool_call>', 3);
  const evs = w.feed([START, 1, 2, 3, END]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, 'region');
  assert.deepEqual(evs[0]!.ids, [1, 2, 3]);
});

// ── Fixture-driven conformance cases ────────────────────────────────────────
//
// packages/tool-watcher-conformance/fixtures/tool-watcher-events.json is the
// cross-language source of truth for the event contract: every Codec
// ToolWatcher implementation must reproduce it exactly. Every case there
// runs here too, so this file can't silently fall out of sync with it.

interface FixtureEvent {
  kind: string;
  ids: number[];
  finish_reason?: string | null;
}
interface FixtureCase {
  name: string;
  region_cap: number | null;
  feeds: number[][];
  end: { finish_reason: string | null } | null;
  events: FixtureEvent[];
}
interface Fixture {
  start_id: number;
  end_id: number;
  cases: FixtureCase[];
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname, '../../tool-watcher-conformance/fixtures/tool-watcher-events.json');
const fixture: Fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));

const fixtureMapRaw = {
  id: 'test/fixture',
  version: '2' as const,
  vocab_size: 100,
  encoder: 'byte_level' as const,
  vocab: {},
  special_tokens: { '<start>': fixture.start_id, '<end>': fixture.end_id },
};
validateMap(fixtureMapRaw);
const FIXTURE_MAP: TokenizerMap = fixtureMapRaw;

for (const c of fixture.cases) {
  test(`fixture: ${c.name}`, () => {
    const w = new ToolWatcher(FIXTURE_MAP, '<start>', '<end>', c.region_cap ?? DEFAULT_REGION_CAP);
    const actual: Array<{ kind: string; ids: number[]; finish_reason?: string | null }> = [];
    for (const feedIds of c.feeds) {
      for (const ev of w.feed(feedIds)) {
        const entry: { kind: string; ids: number[]; finish_reason?: string | null } =
          { kind: ev.kind, ids: [...ev.ids] };
        if (ev.kind === 'truncated') entry.finish_reason = ev.finishReason;
        actual.push(entry);
      }
    }
    if (c.end) {
      for (const ev of w.end(c.end.finish_reason)) {
        const entry: { kind: string; ids: number[]; finish_reason?: string | null } =
          { kind: ev.kind, ids: [...ev.ids] };
        if (ev.kind === 'truncated') entry.finish_reason = ev.finishReason;
        actual.push(entry);
      }
    }
    const expected = c.events.map(e => {
      const entry: { kind: string; ids: number[]; finish_reason?: string | null } =
        { kind: e.kind, ids: e.ids };
      if (e.kind === 'truncated') entry.finish_reason = e.finish_reason ?? null;
      return entry;
    });
    assert.deepEqual(actual, expected);
  });
}

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
