import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SafetyGate } from '../src/gate.js';

test('SafetyGate.check returns clean for innocuous input', () => {
  const gate = new SafetyGate();
  const d = gate.check('Hello, how are you today?');
  assert.equal(d.kind, 'clean');
});

test('SafetyGate.check returns blocked for input containing a known secret', () => {
  const gate = new SafetyGate();
  const d = gate.check('here it is: AKIAIOSFODNN7EXAMPLE');
  assert.equal(d.kind, 'blocked');
  if (d.kind === 'blocked') {
    assert.ok(d.matches.length >= 1);
    assert.ok(d.categories.includes('secrets'));
  }
});

test('SafetyGate.apply(redact) returns a send resolution with redacted text', () => {
  const gate = new SafetyGate();
  const d = gate.check('aws=AKIAIOSFODNN7EXAMPLE email=user@example.com');
  assert.equal(d.kind, 'blocked');
  if (d.kind !== 'blocked') return;
  const r = gate.apply(d, { kind: 'redact' });
  assert.equal(r.kind, 'send');
  if (r.kind === 'send') {
    assert.ok(r.redacted);
    assert.equal(r.redactedCount, 2);
    assert.ok(!r.text.includes('AKIA'));
  }
});

test('SafetyGate.apply(send_anyway) returns the original text', () => {
  const gate = new SafetyGate();
  const d = gate.check('AKIAIOSFODNN7EXAMPLE');
  assert.equal(d.kind, 'blocked');
  if (d.kind !== 'blocked') return;
  const r = gate.apply(d, { kind: 'send_anyway' });
  assert.equal(r.kind, 'send');
  if (r.kind === 'send') {
    assert.equal(r.text, 'AKIAIOSFODNN7EXAMPLE');
    assert.equal(r.redacted, false);
  }
});

test('SafetyGate.apply(cancel) returns cancel', () => {
  const gate = new SafetyGate();
  const d = gate.check('AKIAIOSFODNN7EXAMPLE');
  assert.equal(d.kind, 'blocked');
  if (d.kind !== 'blocked') return;
  const r = gate.apply(d, { kind: 'cancel' });
  assert.equal(r.kind, 'cancel');
});

test('SafetyGate.audit hook receives clean / blocked / redacted events', () => {
  const events: string[] = [];
  const gate = new SafetyGate({
    audit: (e) => events.push(e.kind),
  });
  gate.check('hello world'); // clean
  const d = gate.check('aws=AKIAIOSFODNN7EXAMPLE'); // blocked
  if (d.kind === 'blocked') {
    gate.apply(d, { kind: 'redact' }); // redacted
  }
  assert.deepEqual(events, ['clean', 'blocked', 'redacted']);
});
