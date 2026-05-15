import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverServerPolicy,
  type MandatedServerPolicy,
} from '../src/server-policy.js';

const ORIGIN = 'https://server.test';

function fakeFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ── Unrestricted vs mandated paths ─────────────────────────────────────────

test('discoverServerPolicy returns unrestricted on 404 well-known', async () => {
  const fetchImpl = fakeFetch(() => new Response('', { status: 404 }));
  const state = await discoverServerPolicy({ origin: ORIGIN, fetchImpl });
  assert.equal(state.kind, 'unrestricted');
});

test('discoverServerPolicy returns mandates-v04 when server publishes well-known', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(
      {
        minimum_version: '0.4',
        required_features: ['safety-policy-enforcement'],
        deployment_id: 'acme-prod',
        docs_url: 'https://codecai.net/docs/version-negotiation/',
      },
      200,
    ),
  );
  const state = await discoverServerPolicy({ origin: ORIGIN, fetchImpl });
  assert.equal(state.kind, 'mandates-v04');
  const m = state as MandatedServerPolicy;
  assert.equal(m.minimumVersion, '0.4');
  assert.deepEqual([...m.requiredFeatures], ['safety-policy-enforcement']);
  assert.equal(m.deploymentId, 'acme-prod');
  assert.equal(m.enforcesSafetyPolicy, true);
});

test('discoverServerPolicy reflects enforcesSafetyPolicy=false when feature absent', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(
      { minimum_version: '0.4', required_features: [] },
      200,
    ),
  );
  const state = await discoverServerPolicy({ origin: ORIGIN, fetchImpl });
  const m = state as MandatedServerPolicy;
  assert.equal(m.kind, 'mandates-v04');
  assert.equal(m.enforcesSafetyPolicy, false);
});

test('discoverServerPolicy bubbles up 5xx from version-policy fetch', async () => {
  const fetchImpl = fakeFetch(
    () => new Response('boom', { status: 502 }),
  );
  await assert.rejects(
    () => discoverServerPolicy({ origin: ORIGIN, fetchImpl }),
    /HTTP 502/,
  );
});

// ── Matrix: which feature lists trigger which flags ────────────────────────

const FEATURE_CASES = [
  {
    name: 'no-features',
    required: [],
    expectsSafety: false,
  },
  {
    name: 'safety-only',
    required: ['safety-policy-enforcement'],
    expectsSafety: true,
  },
  {
    name: 'classifier-only',
    required: ['mandatory-classifier'],
    expectsSafety: false,
  },
  {
    name: 'safety-and-classifier',
    required: ['safety-policy-enforcement', 'mandatory-classifier'],
    expectsSafety: true,
  },
  {
    name: 'future-unknown-feature',
    required: ['some-future-feature-this-client-does-not-know'],
    expectsSafety: false,
  },
];

for (const c of FEATURE_CASES) {
  test(`feature matrix: required=${c.name} → enforcesSafetyPolicy=${c.expectsSafety}`, async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(
        { minimum_version: '0.4', required_features: c.required },
        200,
      ),
    );
    const state = await discoverServerPolicy({ origin: ORIGIN, fetchImpl });
    assert.equal(state.kind, 'mandates-v04');
    const m = state as MandatedServerPolicy;
    assert.equal(m.enforcesSafetyPolicy, c.expectsSafety);
    assert.deepEqual([...m.requiredFeatures], c.required);
  });
}
