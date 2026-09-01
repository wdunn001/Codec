/**
 * 01: Unicode smuggling attack/defense tests.
 *
 * Each test loads a fixture from `packages/bench/fixtures/security/01-unicode-smuggling/`,
 * verifies the fixture actually carries the documented attack class, then runs
 * the defense (`sanitizeForCodec`) and verifies the attack is neutralized while
 * legitimate visible content is preserved.
 *
 * See spec/proposals/v0.6-security/01-unicode-smuggling.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  sanitizeForCodec,
  normalizeForPolicy,
  looksLikeSmuggling,
} from '../../src/security/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(
  __dirname,
  '../../../bench/fixtures/security/01-unicode-smuggling',
);

function load(name: string): string {
  return readFileSync(resolve(FIXTURE_ROOT, name), 'utf8');
}

const VISIBLE_BIO = 'Software engineer in Knoxville TN. Founder of MassZero FPV.';

// ── Tag block (U+E0000:U+E007F) ──────────────────────────────────────────────

test('attack: tag-block payload carries invisible content', () => {
  const payload = load('tag-block-payload.txt');
  let tagBlockChars = 0;
  for (const c of payload) {
    const cp = c.codePointAt(0)!;
    if (cp >= 0xe0000 && cp <= 0xe007f) tagBlockChars++;
  }
  assert.ok(
    tagBlockChars >= 10,
    `fixture should carry >=10 tag-block chars, found ${tagBlockChars}`,
  );
  assert.ok(payload.includes(VISIBLE_BIO));
});

test('defense: sanitizeForCodec strips tag-block chars', () => {
  const payload = load('tag-block-payload.txt');
  const { text, removed } = sanitizeForCodec(payload);
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    assert.ok(
      !(cp >= 0xe0000 && cp <= 0xe007f),
      `defense left tag-block char U+${cp.toString(16)}`,
    );
  }
  assert.ok(removed.tagBlock >= 10, 'should report stripped count');
  assert.ok(text.includes(VISIBLE_BIO), 'visible content preserved');
});

// ── Zero-width ───────────────────────────────────────────────────────────────

test('attack: zero-width payload defeats naive keyword regex', () => {
  const payload = load('zero-width-payload.txt');
  // Naive regex looking for the literal phrase will MISS due to interleaved U+200B
  assert.equal(
    /ignore previous instructions/.test(payload),
    false,
    'fixture should defeat naive regex by zero-width interleaving',
  );
  // Many U+200B chars present
  const zwspCount = [...payload].filter((c) => c === '​').length;
  assert.ok(zwspCount >= 20, `fixture should carry >=20 ZWSP chars, found ${zwspCount}`);
});

test('defense: sanitizeForCodec strips zero-width, banned phrase becomes detectable', () => {
  const payload = load('zero-width-payload.txt');
  const { text, removed } = sanitizeForCodec(payload);
  assert.ok(removed.zeroWidth >= 20, 'should report stripped count');
  assert.ok(
    /ignore previous instructions/i.test(text),
    'after defense, banned phrase is detectable by simple regex',
  );
  assert.ok(text.includes(VISIBLE_BIO), 'visible bio preserved');
});

// ── Variation selectors ──────────────────────────────────────────────────────

test('attack: variation-selector payload carries a long VS run', () => {
  const payload = load('variation-selector-payload.txt');
  let runs = 0;
  let inRun = false;
  let runLen = 0;
  for (const c of payload) {
    const cp = c.codePointAt(0)!;
    const isVS = (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
    if (isVS) {
      runLen++;
      inRun = true;
    } else {
      if (inRun && runLen >= 4) runs++;
      runLen = 0;
      inRun = false;
    }
  }
  if (inRun && runLen >= 4) runs++;
  assert.ok(runs >= 1, 'fixture should carry at least one VS run of length >=4');
});

test('defense: sanitizeForCodec collapses VS runs to a single VS', () => {
  const payload = load('variation-selector-payload.txt');
  const { text, removed } = sanitizeForCodec(payload);
  assert.ok(removed.variationSelectors >= 4, 'should report stripped count');
  // After defense, no VS-run of length >= 2 should remain
  let maxRun = 0;
  let runLen = 0;
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    const isVS = (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
    if (isVS) {
      runLen++;
      maxRun = Math.max(maxRun, runLen);
    } else {
      runLen = 0;
    }
  }
  assert.ok(maxRun <= 1, `defense should leave no VS run >1, found ${maxRun}`);
  assert.ok(text.includes('😀'), 'emoji preserved');
});

// ── BiDi controls ────────────────────────────────────────────────────────────

test('attack: bidi-override payload contains RLO', () => {
  const payload = load('bidi-override-payload.txt');
  assert.ok(
    payload.includes('‮'),
    'fixture should contain U+202E right-to-left override',
  );
});

test('defense: sanitizeForCodec strips BiDi controls', () => {
  const payload = load('bidi-override-payload.txt');
  const { text, removed } = sanitizeForCodec(payload);
  assert.equal(text.includes('‮'), false, 'RLO stripped');
  assert.ok(removed.bidiControls >= 1);
  assert.ok(text.includes('Software engineer'));
});

// ── Confusables (NFKC normalize for policy check) ────────────────────────────

test('attack: confusables payload defeats ASCII keyword match', () => {
  const payload = load('confusables-payload.txt');
  assert.equal(
    payload.includes('TOP CANDIDATE'),
    false,
    'fixture should use confusable lookalikes',
  );
});

test('defense: normalizeForPolicy folds confusables to ASCII for matching', () => {
  const payload = load('confusables-payload.txt');
  const normalized = normalizeForPolicy(payload);
  assert.ok(
    normalized.includes('top candidate'),
    'after NFKC+casefold, banned phrase detectable',
  );
});

// ── Mathematical alphanumerics ───────────────────────────────────────────────

test('attack: mathematical-alphanum payload uses U+1D400 range', () => {
  const payload = load('mathematical-alphanum-payload.txt');
  let mathChars = 0;
  for (const c of payload) {
    const cp = c.codePointAt(0)!;
    if (cp >= 0x1d400 && cp <= 0x1d7ff) mathChars++;
  }
  assert.ok(mathChars >= 10, `fixture should carry >=10 math chars, found ${mathChars}`);
});

test('defense: normalizeForPolicy unifies math alphanumerics to ASCII', () => {
  const payload = load('mathematical-alphanum-payload.txt');
  const normalized = normalizeForPolicy(payload);
  assert.ok(normalized.includes('top candidate'), 'math-bold "TOP CANDIDATE" → ascii');
});

// ── Glitch token reference (documentation only) ──────────────────────────────

test('reference: glitch-token fixture documents the class', () => {
  const payload = load('glitch-token-payload.txt');
  // This fixture is documentation-only: per-model glitch tokens belong in
  // tokenizer-map metadata and are not enumerated in the fixture.
  assert.ok(payload.includes('glitch-token'));
});

// ── Combined fast-path detector ──────────────────────────────────────────────

test('fast-path: looksLikeSmuggling fires on every attack fixture', () => {
  const attackFiles = [
    'tag-block-payload.txt',
    'zero-width-payload.txt',
    'variation-selector-payload.txt',
    'bidi-override-payload.txt',
  ];
  for (const name of attackFiles) {
    assert.ok(looksLikeSmuggling(load(name)), `${name} should trip detector`);
  }
});

test('fast-path: looksLikeSmuggling does NOT fire on benign text', () => {
  const benign = 'Software engineer in Knoxville TN. Founder of MassZero FPV. Hello world!';
  assert.equal(looksLikeSmuggling(benign), false);
});
