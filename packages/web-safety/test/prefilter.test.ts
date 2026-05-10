import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanText, redactMatches } from '../src/prefilter.js';

// ── Vendor-anchored secret detection ─────────────────────────────────────────

test('detects an AWS access key', () => {
  const matches = scanText('my key is AKIAIOSFODNN7EXAMPLE for s3');
  const m = matches.find((x) => x.rule === 'aws_access_key');
  assert.ok(m, 'expected an aws_access_key match');
  assert.equal(m!.value, 'AKIAIOSFODNN7EXAMPLE');
  assert.equal(m!.category, 'secrets');
  assert.equal(m!.confidence, 1.0);
});

test('detects a GitHub PAT (ghp_)', () => {
  // 36-char body matches GitHub's PAT format.
  const matches = scanText('token=ghp_abcdef0123456789ABCDEF0123456789ABcd and stop');
  const m = matches.find((x) => x.rule === 'github_pat');
  assert.ok(m);
  assert.equal(m!.category, 'secrets');
});

test('detects an OpenAI key', () => {
  const matches = scanText('OPENAI_API_KEY=sk-proj-abcdef0123456789ABCDEF0123');
  const m = matches.find((x) => x.rule === 'openai_key');
  assert.ok(m);
});

test('detects an Anthropic key', () => {
  const matches = scanText('Authorization: Bearer sk-ant-abcdef0123456789ABCDEF');
  const m = matches.find((x) => x.rule === 'anthropic_key');
  assert.ok(m);
});

test('detects an SSH private key header', () => {
  const matches = scanText(
    'paste:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk...',
  );
  const m = matches.find((x) => x.rule === 'ssh_private_key');
  assert.ok(m);
  assert.equal(m!.confidence, 1.0);
});

test('detects a JWT-shaped token', () => {
  const matches = scanText(
    'jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  );
  const m = matches.find((x) => x.rule === 'jwt');
  assert.ok(m);
});

// ── PII ──────────────────────────────────────────────────────────────────────

test('detects an email address', () => {
  const matches = scanText('contact me at user@example.com please');
  const m = matches.find((x) => x.rule === 'email');
  assert.ok(m);
  assert.equal(m!.value, 'user@example.com');
  assert.equal(m!.category, 'pii');
});

test('detects a US phone number', () => {
  const matches = scanText('call 415-555-2671 today', { minConfidence: 0.5 });
  const m = matches.find((x) => x.rule === 'phone_us');
  assert.ok(m);
});

test('detects a Luhn-valid credit-card-like sequence', () => {
  // 4242 4242 4242 4242 is Stripe's test card and Luhn-valid.
  const matches = scanText('card 4242 4242 4242 4242 declined', { minConfidence: 0.5 });
  const m = matches.find((x) => x.rule === 'credit_card_candidate');
  assert.ok(m, 'expected a Luhn-valid credit card to be detected');
});

test('rejects non-Luhn credit-card-shaped digits', () => {
  // 1234 5678 9012 3456 is NOT Luhn-valid.
  const matches = scanText('order 1234 5678 9012 3456 placed', { minConfidence: 0.5 });
  const ccs = matches.filter((x) => x.rule === 'credit_card_candidate');
  assert.equal(ccs.length, 0);
});

// ── High-entropy catch-all ───────────────────────────────────────────────────

test('flags a high-entropy base64-ish run', () => {
  const matches = scanText(
    'opaque token: aB3$dE5gH7iK9lM1nO3pQ5rS7tU9vW1xY3zA5bC7dE9fG (continuing)',
  );
  // The "$" inside breaks the run — pick a cleaner base64 case.
  const cleaner = scanText(
    'opaque token: AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp012345 next',
  );
  const m = cleaner.find((x) => x.rule === 'entropy_base64');
  assert.ok(m);
  assert.equal(m!.category, 'high_entropy');
  // Suppress the unused matches reference.
  void matches;
});

test('does NOT flag low-entropy short text', () => {
  const matches = scanText('this is a normal sentence that should not match anything');
  assert.equal(matches.length, 0);
});

test('respects categories option (only secrets)', () => {
  const matches = scanText('email me@example.com and AKIAIOSFODNN7EXAMPLE', {
    categories: ['secrets'],
  });
  assert.ok(matches.every((m) => m.category === 'secrets'));
  assert.ok(matches.some((m) => m.rule === 'aws_access_key'));
});

test('respects minConfidence option', () => {
  const lower = scanText('phone 415-555-2671', { minConfidence: 0.5 });
  const higher = scanText('phone 415-555-2671', { minConfidence: 0.95 });
  assert.ok(lower.length > 0);
  assert.equal(higher.length, 0);
});

// ── Dedup / overlap ──────────────────────────────────────────────────────────

test('does not double-report a vendor key as both regex and entropy', () => {
  // AKIA key would normally match the entropy_base64 rule too; the matcher
  // must suppress the entropy hit when a more-specific rule covers it.
  const matches = scanText('aws AKIAIOSFODNN7EXAMPLE');
  const ruleSet = new Set(matches.map((m) => m.rule));
  assert.ok(ruleSet.has('aws_access_key'));
  assert.ok(!ruleSet.has('entropy_base64'));
});

// ── Redaction ────────────────────────────────────────────────────────────────

test('redactMatches replaces matched spans with [REDACTED:<rule>]', () => {
  const input = 'aws=AKIAIOSFODNN7EXAMPLE email=user@example.com';
  const matches = scanText(input);
  const { redacted, count } = redactMatches(input, matches);
  assert.ok(redacted.includes('[REDACTED:aws_access_key]'));
  assert.ok(redacted.includes('[REDACTED:email]'));
  assert.equal(count, 2);
  assert.ok(!redacted.includes('AKIA'));
  assert.ok(!redacted.includes('user@example.com'));
});

test('redactMatches with no matches is a no-op', () => {
  const { redacted, count } = redactMatches('hello world', []);
  assert.equal(redacted, 'hello world');
  assert.equal(count, 0);
});
