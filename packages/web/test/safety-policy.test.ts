import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSafetyPolicy,
  hashSafetyPolicy,
  loadSafetyPolicy,
  discoverSafetyPolicy,
  wellKnownPolicyUrl,
  wellKnownPolicyHashUrl,
  MemorySafetyPolicyCache,
  SafetyPolicyValidationError,
  SafetyPolicyDiscoveryError,
  SafetyPolicyDiscoveryNotFoundError,
  SafetyPolicyHashMismatchError,
} from '../src/safety-policy.js';
import type { SafetyPolicyDescriptor } from '../src/types.js';

const ORIGIN = 'https://acme.test';

const VALID: SafetyPolicyDescriptor = {
  id: 'acme/strict-v3',
  version: '1',
  tokenizers: ['meta-llama/llama-3'],
  categories: [
    { name: 'secrets', action: 'stop' },
    { name: 'pii', action: 'redact', description: 'Email and phone.' },
  ],
  classifier: {
    family: 'llama-guard-3-1b',
    host: 'server',
    requires_engine_features: ['logits_processor', 'sampling_chain'],
  },
  rules_summary: {
    banned_token_id_count: 4128,
    regex_pattern_count: 47,
  },
  client_hooks: {
    prefilter_categories: ['secrets', 'pii'],
    client_classifier_family: 'prompt-guard-86m',
  },
  published_at: '2026-05-09T00:00:00Z',
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function makeFakeFetch(
  routes: Record<string, string | { status: number; body?: string; bytes?: Uint8Array }>,
): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const route = routes[url];
    if (route === undefined) {
      return new Response(`no route for ${url}`, { status: 404 });
    }
    if (typeof route === 'string') {
      return new Response(route, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (route.bytes) {
      return new Response(route.bytes, {
        status: route.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(route.body ?? '', { status: route.status });
  }) as typeof fetch;
}

// ── Validation ────────────────────────────────────────────────────────────────

test('validateSafetyPolicy accepts a minimal valid descriptor', () => {
  validateSafetyPolicy(VALID);
});

test('validateSafetyPolicy rejects missing required fields', () => {
  assert.throws(() => validateSafetyPolicy({}), SafetyPolicyValidationError);
  assert.throws(
    () => validateSafetyPolicy({ ...VALID, id: '' }),
    SafetyPolicyValidationError,
  );
  assert.throws(
    () => validateSafetyPolicy({ ...VALID, tokenizers: [] }),
    SafetyPolicyValidationError,
  );
  assert.throws(
    () => validateSafetyPolicy({ ...VALID, categories: [] }),
    SafetyPolicyValidationError,
  );
});

test('validateSafetyPolicy rejects bad category names', () => {
  assert.throws(
    () =>
      validateSafetyPolicy({
        ...VALID,
        categories: [{ name: 'BadCaps', action: 'stop' }],
      }),
    SafetyPolicyValidationError,
  );
});

test('validateSafetyPolicy rejects unknown actions', () => {
  assert.throws(
    () =>
      validateSafetyPolicy({
        ...VALID,
        categories: [{ name: 'secrets', action: 'banhammer' }],
      }),
    SafetyPolicyValidationError,
  );
});

test('validateSafetyPolicy rejects negative summary counts', () => {
  assert.throws(
    () =>
      validateSafetyPolicy({
        ...VALID,
        rules_summary: { banned_token_id_count: -5 },
      }),
    SafetyPolicyValidationError,
  );
});

test('validateSafetyPolicy rejects unknown engine features', () => {
  assert.throws(
    () =>
      validateSafetyPolicy({
        ...VALID,
        classifier: {
          family: 'llama-guard-3-1b',
          requires_engine_features: ['weather_api'],
        },
      }),
    SafetyPolicyValidationError,
  );
});

// ── Hash determinism ─────────────────────────────────────────────────────────

test('hashSafetyPolicy is deterministic for identical input', async () => {
  const a = await hashSafetyPolicy(VALID);
  const b = await hashSafetyPolicy(VALID);
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('hashSafetyPolicy differs when category action changes', async () => {
  const a = await hashSafetyPolicy(VALID);
  const b = await hashSafetyPolicy({
    ...VALID,
    categories: [
      { name: 'secrets', action: 'flag' },
      { name: 'pii', action: 'redact', description: 'Email and phone.' },
    ],
  });
  assert.notEqual(a, b);
});

// ── URL builders ─────────────────────────────────────────────────────────────

test('wellKnownPolicyUrl preserves slashes and strips trailing /', () => {
  assert.equal(
    wellKnownPolicyUrl('https://acme.example/', 'acme/strict-v3'),
    'https://acme.example/.well-known/codec/policies/acme/strict-v3.json',
  );
});

test('wellKnownPolicyUrl rejects ids with traversal or wrong charset', () => {
  assert.throws(
    () => wellKnownPolicyUrl('https://acme.example', '../etc'),
    SafetyPolicyDiscoveryError,
  );
  assert.throws(
    () => wellKnownPolicyUrl('https://acme.example', 'Acme/Strict'),
    SafetyPolicyDiscoveryError,
  );
});

test('wellKnownPolicyHashUrl uses the sha256 sibling path', () => {
  const hex = 'a'.repeat(64);
  assert.equal(
    wellKnownPolicyHashUrl('https://acme.example', hex),
    `https://acme.example/.well-known/codec/policies/sha256/${hex}.json`,
  );
});

test('wellKnownPolicyHashUrl rejects malformed hex', () => {
  assert.throws(
    () => wellKnownPolicyHashUrl('https://acme.example', 'not-hex'),
    SafetyPolicyDiscoveryError,
  );
});

// ── Loading ──────────────────────────────────────────────────────────────────

test('loadSafetyPolicy fetches, validates, caches', async () => {
  const url = `${ORIGIN}/policies/acme-strict-v3.json`;
  const cache = new MemorySafetyPolicyCache();
  const fetchImpl = makeFakeFetch({ [url]: JSON.stringify(VALID) });
  const policy = await loadSafetyPolicy({ url, cache, fetchImpl });
  assert.equal(policy.id, VALID.id);
  // Second call hits cache; we can verify by replacing fetchImpl with one that
  // would fail for the same URL.
  const cached = await loadSafetyPolicy({
    url,
    cache,
    fetchImpl: makeFakeFetch({}),
  });
  assert.equal(cached.id, VALID.id);
});

test('loadSafetyPolicy verifies hash on fetch', async () => {
  const url = `${ORIGIN}/policies/acme-strict-v3.json`;
  const goodBody = JSON.stringify(VALID, null, 2) + '\n';
  const goodHash = `sha256:${await sha256Hex(new TextEncoder().encode(goodBody))}`;
  const fetchImpl = makeFakeFetch({ [url]: goodBody });

  const policy = await loadSafetyPolicy({
    url,
    hash: goodHash,
    fetchImpl,
  });
  assert.equal(policy.id, VALID.id);

  const wrongHash = 'sha256:' + 'b'.repeat(64);
  await assert.rejects(
    loadSafetyPolicy({ url, hash: wrongHash, fetchImpl }),
    SafetyPolicyHashMismatchError,
  );
});

// ── Discovery ────────────────────────────────────────────────────────────────

test('discoverSafetyPolicy resolves an inline descriptor at the id path', async () => {
  const url = wellKnownPolicyUrl(ORIGIN, VALID.id);
  const fetchImpl = makeFakeFetch({ [url]: JSON.stringify(VALID) });
  const policy = await discoverSafetyPolicy({ origin: ORIGIN, id: VALID.id, fetchImpl });
  assert.equal(policy.id, VALID.id);
});

test('discoverSafetyPolicy follows a pointer to the actual descriptor', async () => {
  const idUrl = wellKnownPolicyUrl(ORIGIN, VALID.id);
  const cdnUrl = 'https://cdn.example/acme-strict-v3.json';
  const body = JSON.stringify(VALID, null, 2) + '\n';
  const cdnBytes = new TextEncoder().encode(body);
  const cdnHash = `sha256:${await sha256Hex(cdnBytes)}`;
  const pointer = { id: VALID.id, url: cdnUrl, hash: cdnHash };
  const fetchImpl = makeFakeFetch({
    [idUrl]: JSON.stringify(pointer),
    [cdnUrl]: { status: 200, bytes: cdnBytes },
  });
  const policy = await discoverSafetyPolicy({ origin: ORIGIN, id: VALID.id, fetchImpl });
  assert.equal(policy.id, VALID.id);
});

test('discoverSafetyPolicy with hash hits the content-addressed sibling', async () => {
  const body = JSON.stringify(VALID, null, 2) + '\n';
  const bytes = new TextEncoder().encode(body);
  const hashHex = await sha256Hex(bytes);
  const hashUrl = wellKnownPolicyHashUrl(ORIGIN, hashHex);
  const fetchImpl = makeFakeFetch({ [hashUrl]: { status: 200, bytes } });
  const policy = await discoverSafetyPolicy({
    origin: ORIGIN,
    id: VALID.id,
    hash: `sha256:${hashHex}`,
    fetchImpl,
  });
  assert.equal(policy.id, VALID.id);
});

test('discoverSafetyPolicy with hash rejects bytes that do not match', async () => {
  const body = JSON.stringify(VALID, null, 2) + '\n';
  const bytes = new TextEncoder().encode(body);
  const wrongHex = 'c'.repeat(64);
  const hashUrl = wellKnownPolicyHashUrl(ORIGIN, wrongHex);
  const fetchImpl = makeFakeFetch({ [hashUrl]: { status: 200, bytes } });
  await assert.rejects(
    discoverSafetyPolicy({
      origin: ORIGIN,
      id: VALID.id,
      hash: `sha256:${wrongHex}`,
      fetchImpl,
    }),
    SafetyPolicyHashMismatchError,
  );
});

test('discoverSafetyPolicy throws NotFound on 404', async () => {
  const fetchImpl = makeFakeFetch({});
  await assert.rejects(
    discoverSafetyPolicy({ origin: ORIGIN, id: VALID.id, fetchImpl }),
    SafetyPolicyDiscoveryNotFoundError,
  );
});

test('discoverSafetyPolicy rejects inline descriptor whose id does not match', async () => {
  const url = wellKnownPolicyUrl(ORIGIN, VALID.id);
  const fetchImpl = makeFakeFetch({
    [url]: JSON.stringify({ ...VALID, id: 'someone-else/v1' }),
  });
  await assert.rejects(
    discoverSafetyPolicy({ origin: ORIGIN, id: VALID.id, fetchImpl }),
    SafetyPolicyDiscoveryError,
  );
});
