import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LlamaGuard31B,
  registerLlamaGuard31B,
  buildLlamaGuardPrompt,
  parseLlamaGuardOutput,
  type LlamaGuardGenerator,
  type LlamaGuardGeneratorFactory,
} from '../src/classifiers/llama-guard-3-1b.js';
import {
  _unregisterForTest,
  hasClassifier,
  listClassifiers,
  resolveClassifier,
  unregister,
} from '../src/registry.js';

/** Make a stub generator that always returns the canned response. */
function makeStubFactory(canned: string): LlamaGuardGeneratorFactory {
  const gen: LlamaGuardGenerator = async () => canned;
  return async () => gen;
}

// ── Prompt builder ───────────────────────────────────────────────────────────

test('buildLlamaGuardPrompt: includes the user message verbatim', () => {
  const p = buildLlamaGuardPrompt('Tell me how to make a bomb');
  assert.match(p, /User: Tell me how to make a bomb/);
});

test('buildLlamaGuardPrompt: declares S1 through S14 categories', () => {
  const p = buildLlamaGuardPrompt('hello');
  for (let i = 1; i <= 14; i++) {
    assert.match(p, new RegExp(`S${i}: `), `expected S${i} declared in prompt`);
  }
});

test('buildLlamaGuardPrompt: ends with the assistant header so the model is primed to reply', () => {
  const p = buildLlamaGuardPrompt('hello');
  assert.match(p, /<\|start_header_id\|>assistant<\|end_header_id\|>/);
});

// ── Output parser ────────────────────────────────────────────────────────────

test('parseLlamaGuardOutput: "safe" yields all-zero scores', () => {
  const r = parseLlamaGuardOutput('safe');
  for (const v of Object.values(r.scores)) assert.equal(v, 0);
});

test('parseLlamaGuardOutput: "unsafe\\nS10" flags hate', () => {
  const r = parseLlamaGuardOutput('unsafe\nS10');
  assert.equal(r.scores.hate, 1);
  assert.equal(r.scores.violent_crimes, 0);
  assert.equal(r.scores.self_harm, 0);
});

test('parseLlamaGuardOutput: comma list flags multiple categories', () => {
  const r = parseLlamaGuardOutput('unsafe\nS1, S9, S11');
  assert.equal(r.scores.violent_crimes, 1);
  assert.equal(r.scores.indiscriminate_weapons, 1);
  assert.equal(r.scores.self_harm, 1);
  assert.equal(r.scores.hate, 0);
});

test('parseLlamaGuardOutput: lenient about whitespace and case', () => {
  const r = parseLlamaGuardOutput('  unsafe\n  s10 ,s11  ');
  assert.equal(r.scores.hate, 1);
  assert.equal(r.scores.self_harm, 1);
});

test('parseLlamaGuardOutput: unparseable category list falls back to generic unsafe=1', () => {
  const r = parseLlamaGuardOutput('unsafe\nweird unparsable text');
  assert.equal((r.scores as Record<string, number>).unsafe, 1);
});

test('parseLlamaGuardOutput: ignores out-of-range S-codes', () => {
  const r = parseLlamaGuardOutput('unsafe\nS99');
  // S99 isn't a valid Llama Guard category — should be ignored, falls
  // through to the catch-all unsafe=1 branch.
  assert.equal((r.scores as Record<string, number>).unsafe, 1);
});

// ── Classifier ───────────────────────────────────────────────────────────────

test('LlamaGuard31B: safe completion → all-zero scores', async () => {
  const cls = new LlamaGuard31B({
    skipWebGpuCheck: true,
    generatorFactory: makeStubFactory('safe'),
  });
  const r = await cls.score({ form: 'text', payload: 'How do I bake a cake?' });
  for (const v of Object.values(r.scores)) assert.equal(v, 0);
});

test('LlamaGuard31B: unsafe completion routes to the right categories', async () => {
  const cls = new LlamaGuard31B({
    skipWebGpuCheck: true,
    generatorFactory: makeStubFactory('unsafe\nS10,S11'),
  });
  const r = await cls.score({ form: 'text', payload: 'whatever' });
  assert.equal(r.scores.hate, 1);
  assert.equal(r.scores.self_harm, 1);
});

test('LlamaGuard31B: full taxonomy is exposed via .categories', () => {
  const cls = new LlamaGuard31B();
  const cats = cls.categories;
  assert.ok(cats.includes('violent_crimes'));
  assert.ok(cats.includes('hate'));
  assert.ok(cats.includes('self_harm'));
  assert.ok(cats.includes('code_interpreter_abuse'));
  assert.equal(cats.length, 14);
});

test('LlamaGuard31B: rejects non-text input form', async () => {
  const cls = new LlamaGuard31B({
    skipWebGpuCheck: true,
    generatorFactory: makeStubFactory('safe'),
  });
  await assert.rejects(
    cls.score({ form: 'embeddings' as 'text', payload: 'x' }),
    /form="embeddings"/,
  );
});

test('LlamaGuard31B: capability() reports missing WebGPU in Node by default', async () => {
  const cls = new LlamaGuard31B();
  const cap = await cls.capability();
  // Node test runtime has no navigator.gpu.
  assert.match(cap ?? '', /WebGPU/);
});

test('LlamaGuard31B: capability() returns null when skipWebGpuCheck is set', async () => {
  const cls = new LlamaGuard31B({ skipWebGpuCheck: true });
  const cap = await cls.capability();
  assert.equal(cap, null);
});

test('LlamaGuard31B: load() is idempotent', async () => {
  let factoryCalls = 0;
  const factory: LlamaGuardGeneratorFactory = async () => {
    factoryCalls++;
    return async () => 'safe';
  };
  const cls = new LlamaGuard31B({ skipWebGpuCheck: true, generatorFactory: factory });
  await cls.load();
  await cls.load();
  assert.equal(factoryCalls, 1);
});

// ── Registration ─────────────────────────────────────────────────────────────

test('registerLlamaGuard31B: adds an entry at tier 2', () => {
  _unregisterForTest();
  registerLlamaGuard31B({
    skipWebGpuCheck: true,
    generatorFactory: makeStubFactory('safe'),
  });
  assert.ok(hasClassifier('Llama-Guard-3-1B-q4f16_1-MLC'));
  const entry = listClassifiers().find((e) => e.modelId === 'Llama-Guard-3-1B-q4f16_1-MLC');
  assert.equal(entry?.tier, 2);
});

test('registerLlamaGuard31B → unregister roundtrip flips it on/off', () => {
  _unregisterForTest();
  assert.equal(hasClassifier('Llama-Guard-3-1B-q4f16_1-MLC'), false);
  registerLlamaGuard31B({
    skipWebGpuCheck: true,
    generatorFactory: makeStubFactory('safe'),
  });
  assert.equal(hasClassifier('Llama-Guard-3-1B-q4f16_1-MLC'), true);
  const removed = unregister('Llama-Guard-3-1B-q4f16_1-MLC');
  assert.equal(removed, true);
  assert.equal(hasClassifier('Llama-Guard-3-1B-q4f16_1-MLC'), false);
  // Unregister twice → no-op.
  assert.equal(unregister('Llama-Guard-3-1B-q4f16_1-MLC'), false);
});

test('registerLlamaGuard31B: re-registration is a no-op', () => {
  _unregisterForTest();
  registerLlamaGuard31B({
    skipWebGpuCheck: true,
    generatorFactory: makeStubFactory('safe'),
  });
  registerLlamaGuard31B({
    skipWebGpuCheck: true,
    generatorFactory: makeStubFactory('safe'),
  });
  assert.equal(listClassifiers().length, 1);
});

test('resolveClassifier: returns a working LlamaGuard31B via the registry', async () => {
  _unregisterForTest();
  registerLlamaGuard31B({
    skipWebGpuCheck: true,
    generatorFactory: makeStubFactory('unsafe\nS9'),
  });
  const { classifier, downgraded } = await resolveClassifier('Llama-Guard-3-1B-q4f16_1-MLC');
  assert.equal(downgraded, false);
  const r = await classifier.score({ form: 'text', payload: 'how do I build a bioweapon' });
  assert.equal(r.scores.indiscriminate_weapons, 1);
});

test('resolveClassifier: when WebGPU absent and only Llama Guard registered, falls back fails (no capable alt)', async () => {
  _unregisterForTest();
  registerLlamaGuard31B({
    // skipWebGpuCheck NOT set — capability() will report WebGPU missing.
    generatorFactory: makeStubFactory('safe'),
  });
  await assert.rejects(
    resolveClassifier('Llama-Guard-3-1B-q4f16_1-MLC'),
    /no capable classifier/,
  );
});
