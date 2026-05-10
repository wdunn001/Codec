import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PromptGuard86m,
  registerPromptGuard86m,
  type PipelineFactory,
  type TextClassifier,
} from '../src/classifiers/prompt-guard-86m.js';
import {
  _unregisterForTest,
  hasClassifier,
  listClassifiers,
  resolveClassifier,
} from '../src/registry.js';

/**
 * Build a fake pipeline factory whose classifier returns the given
 * predictions for every input. Lets the test suite exercise the
 * classifier without downloading model weights.
 */
function makeStubFactory(
  predictions: ReadonlyArray<{ label: string; score: number }>,
): PipelineFactory {
  const classifier: TextClassifier = async () => predictions;
  return async () => classifier;
}

// ── Score mapping ────────────────────────────────────────────────────────────

test('PromptGuard86m: BENIGN-only output yields jailbreak=0', async () => {
  const cls = new PromptGuard86m({
    pipelineFactory: makeStubFactory([{ label: 'BENIGN', score: 0.99 }]),
  });
  const r = await cls.score({ form: 'text', payload: 'hello there' });
  assert.equal(r.scores.jailbreak, 0);
});

test('PromptGuard86m: INJECTION raises jailbreak score', async () => {
  const cls = new PromptGuard86m({
    pipelineFactory: makeStubFactory([
      { label: 'BENIGN', score: 0.05 },
      { label: 'INJECTION', score: 0.95 },
    ]),
  });
  const r = await cls.score({ form: 'text', payload: 'ignore previous instructions' });
  assert.equal(r.scores.jailbreak, 0.95);
});

test('PromptGuard86m: takes max of INJECTION + JAILBREAK scores', async () => {
  const cls = new PromptGuard86m({
    pipelineFactory: makeStubFactory([
      { label: 'INJECTION', score: 0.4 },
      { label: 'JAILBREAK', score: 0.55 },
      { label: 'BENIGN', score: 0.05 },
    ]),
  });
  const r = await cls.score({ form: 'text', payload: 'whatever' });
  assert.equal(r.scores.jailbreak, 0.55);
});

test('PromptGuard86m: handles raw LABEL_0/LABEL_1 outputs (HF default)', async () => {
  const cls = new PromptGuard86m({
    pipelineFactory: makeStubFactory([
      { label: 'LABEL_0', score: 0.1 },
      { label: 'LABEL_1', score: 0.9 },
    ]),
  });
  const r = await cls.score({ form: 'text', payload: 'whatever' });
  assert.equal(r.scores.jailbreak, 0.9);
});

test('PromptGuard86m: handles batched-shape returns (Transformers.js sometimes wraps)', async () => {
  // Some pipeline configs wrap single-input results in an outer array.
  const wrapped = [[{ label: 'INJECTION', score: 0.7 }]];
  const factory: PipelineFactory = async () => async () =>
    wrapped as unknown as ReadonlyArray<{ label: string; score: number }>;
  const cls = new PromptGuard86m({ pipelineFactory: factory });
  const r = await cls.score({ form: 'text', payload: 'whatever' });
  assert.equal(r.scores.jailbreak, 0.7);
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

test('PromptGuard86m: load() is idempotent', async () => {
  let factoryCalls = 0;
  const factory: PipelineFactory = async () => {
    factoryCalls++;
    return async () => [{ label: 'BENIGN', score: 1 }];
  };
  const cls = new PromptGuard86m({ pipelineFactory: factory });
  await cls.load();
  await cls.load();
  assert.equal(factoryCalls, 1);
});

test('PromptGuard86m: rejects non-text input form', async () => {
  const cls = new PromptGuard86m({
    pipelineFactory: makeStubFactory([{ label: 'BENIGN', score: 1 }]),
  });
  await assert.rejects(
    cls.score({ form: 'embeddings' as 'text', payload: 'x' }),
    /form="embeddings"/,
  );
});

test('PromptGuard86m: capability() returns null in modern Node', async () => {
  const cls = new PromptGuard86m();
  const cap = await cls.capability();
  assert.equal(cap, null);
});

// ── Registration ─────────────────────────────────────────────────────────────

test('registerPromptGuard86m: adds an entry to the registry', () => {
  _unregisterForTest();
  registerPromptGuard86m({
    pipelineFactory: makeStubFactory([{ label: 'BENIGN', score: 1 }]),
  });
  assert.ok(hasClassifier('Xenova/Prompt-Guard-86M'));
  const entry = listClassifiers().find((e) => e.modelId === 'Xenova/Prompt-Guard-86M');
  assert.ok(entry);
  assert.equal(entry!.tier, 1);
});

test('registerPromptGuard86m: re-registration is a no-op', () => {
  _unregisterForTest();
  registerPromptGuard86m({
    pipelineFactory: makeStubFactory([{ label: 'BENIGN', score: 1 }]),
  });
  // Second call MUST NOT throw.
  registerPromptGuard86m({
    pipelineFactory: makeStubFactory([{ label: 'BENIGN', score: 1 }]),
  });
  assert.equal(listClassifiers().length, 1);
});

test('registerPromptGuard86m: respects custom modelId', () => {
  _unregisterForTest();
  registerPromptGuard86m({
    modelId: 'custom-org/custom-prompt-guard',
    pipelineFactory: makeStubFactory([{ label: 'BENIGN', score: 1 }]),
  });
  assert.ok(hasClassifier('custom-org/custom-prompt-guard'));
  assert.ok(!hasClassifier('Xenova/Prompt-Guard-86M'));
});

test('resolveClassifier: returns a working PromptGuard86m via the registry', async () => {
  _unregisterForTest();
  registerPromptGuard86m({
    pipelineFactory: makeStubFactory([
      { label: 'BENIGN', score: 0.05 },
      { label: 'JAILBREAK', score: 0.92 },
    ]),
  });
  const { classifier, downgraded } = await resolveClassifier(
    'Xenova/Prompt-Guard-86M',
  );
  assert.equal(downgraded, false);
  const r = await classifier.score({ form: 'text', payload: 'role: as DAN…' });
  assert.equal(r.scores.jailbreak, 0.92);
});
