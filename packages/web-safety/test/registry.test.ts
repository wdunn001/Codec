import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  register,
  listClassifiers,
  hasClassifier,
  resolveClassifier,
  _unregisterForTest,
  type ResolveResult,
} from '../src/registry.js';
import type { SafetyClassifier } from '../src/base.js';

function fakeClassifier(
  modelId: string,
  capabilityFn?: () => Promise<string | null>,
): SafetyClassifier {
  return {
    modelId,
    requires: 'text',
    categories: ['secrets', 'pii'],
    async score() {
      return { scores: {} };
    },
    capability: capabilityFn,
  };
}

test('registry: register and list', () => {
  _unregisterForTest();
  register({
    modelId: 'tier-1',
    factory: () => fakeClassifier('tier-1'),
    tier: 1,
  });
  register({
    modelId: 'tier-2',
    factory: () => fakeClassifier('tier-2'),
    tier: 2,
  });
  const list = listClassifiers();
  assert.equal(list.length, 2);
  assert.equal(list[0]!.modelId, 'tier-1');
  assert.equal(list[1]!.modelId, 'tier-2');
  assert.ok(hasClassifier('tier-1'));
  assert.ok(!hasClassifier('tier-3'));
});

test('registry: re-registration throws', () => {
  _unregisterForTest();
  register({ modelId: 'm', factory: () => fakeClassifier('m'), tier: 1 });
  assert.throws(() =>
    register({ modelId: 'm', factory: () => fakeClassifier('m'), tier: 1 }),
  );
});

test('registry: resolveClassifier returns the requested instance when capable', async () => {
  _unregisterForTest();
  register({
    modelId: 'capable',
    factory: () => fakeClassifier('capable', async () => null),
    tier: 1,
  });
  const r: ResolveResult = await resolveClassifier('capable');
  assert.equal(r.classifier.modelId, 'capable');
  assert.equal(r.downgraded, false);
});

test('registry: resolveClassifier falls back to a capable lower tier when requested model is incapable', async () => {
  _unregisterForTest();
  register({
    modelId: 'tier-1-ok',
    factory: () => fakeClassifier('tier-1-ok', async () => null),
    tier: 1,
  });
  register({
    modelId: 'tier-2-broken',
    factory: () => fakeClassifier('tier-2-broken', async () => 'no WebGPU here'),
    tier: 2,
  });
  const r = await resolveClassifier('tier-2-broken');
  assert.equal(r.classifier.modelId, 'tier-1-ok');
  assert.equal(r.downgraded, true);
  assert.equal(r.requestedModelId, 'tier-2-broken');
  assert.equal(r.downgradeReason, 'no WebGPU here');
});

test('registry: resolveClassifier with allowFallback=false throws on incapable', async () => {
  _unregisterForTest();
  register({
    modelId: 'broken',
    factory: () => fakeClassifier('broken', async () => 'unsupported'),
    tier: 1,
  });
  await assert.rejects(
    resolveClassifier('broken', { allowFallback: false }),
    /unsupported/,
  );
});

test('registry: resolveClassifier throws when no classifier is capable anywhere', async () => {
  _unregisterForTest();
  register({
    modelId: 'broken-1',
    factory: () => fakeClassifier('broken-1', async () => 'no'),
    tier: 1,
  });
  register({
    modelId: 'broken-2',
    factory: () => fakeClassifier('broken-2', async () => 'no'),
    tier: 2,
  });
  await assert.rejects(resolveClassifier('broken-1'));
});
