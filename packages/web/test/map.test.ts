import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadMap,
  validateMap,
  MemoryMapCache,
  TokenizerMapValidationError,
  TokenizerMapHashMismatchError,
} from '../src/map.js';
import { TINY_MAP } from './fixtures.js';

test('validateMap: accepts a well-formed map', () => {
  assert.doesNotThrow(() => validateMap(TINY_MAP));
});

test('validateMap: rejects missing id', () => {
  assert.throws(() => validateMap({ version: '1', vocab_size: 1, tokens: {} }), TokenizerMapValidationError);
});

test('validateMap: rejects byte_fallback_start without byte_fallback_end', () => {
  assert.throws(
    () =>
      validateMap({
        id: 'x',
        version: '1',
        vocab_size: 10,
        tokens: {},
        byte_fallback_start: 0,
      }),
    TokenizerMapValidationError
  );
});

test('loadMap: returns a parsed and validated map', async () => {
  const body = JSON.stringify(TINY_MAP);
  const fakeFetch: typeof fetch = async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

  const map = await loadMap({
    url: 'https://example.test/map.json',
    cache: new MemoryMapCache(),
    fetchImpl: fakeFetch,
  });
  assert.equal(map.id, TINY_MAP.id);
  assert.equal(map.vocab_size, TINY_MAP.vocab_size);
});

test('loadMap: cache hit skips the network', async () => {
  const cache = new MemoryMapCache();
  let fetchCalls = 0;
  const fakeFetch: typeof fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify(TINY_MAP));
  };

  await loadMap({ url: 'https://example.test/map.json', cache, fetchImpl: fakeFetch });
  await loadMap({ url: 'https://example.test/map.json', cache, fetchImpl: fakeFetch });

  assert.equal(fetchCalls, 1, 'second loadMap should hit cache');
});

test('loadMap: hash verification accepts matching digest', async () => {
  const body = JSON.stringify(TINY_MAP);
  // Compute the expected digest using the same path the loader uses.
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const expected =
    'sha256:' +
    Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  const fakeFetch: typeof fetch = async () => new Response(body);
  await assert.doesNotReject(
    loadMap({
      url: 'https://example.test/map.json',
      hash: expected,
      cache: new MemoryMapCache(),
      fetchImpl: fakeFetch,
    })
  );
});

test('loadMap: hash mismatch throws', async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify(TINY_MAP));
  await assert.rejects(
    loadMap({
      url: 'https://example.test/map.json',
      hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      cache: new MemoryMapCache(),
      fetchImpl: fakeFetch,
    }),
    TokenizerMapHashMismatchError
  );
});

test('loadMap: HTTP error surfaces as a useful message', async () => {
  const fakeFetch: typeof fetch = async () => new Response('not found', { status: 404 });
  await assert.rejects(
    loadMap({
      url: 'https://example.test/map.json',
      cache: new MemoryMapCache(),
      fetchImpl: fakeFetch,
    }),
    /HTTP 404/
  );
});

test('loadMap sends no custom request headers (stays a CORS simple request)', async () => {
  // Regression: codec-client-version on static-artifact fetches forced a CORS
  // preflight that third-party CDN hosts (jsDelivr) reject. Map/discovery
  // fetches must remain header-free; integrity comes from the hash check.
  let seenInit: RequestInit | undefined;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seenInit = init;
    return new Response(new Uint8Array([0x7b, 0x7d]), { status: 200 });
  }) as typeof fetch;
  try {
    await loadMap({ url: 'https://cdn.example/maps/x.json', fetchImpl });
  } catch {
    // parse failure of the dummy body is fine — we only care about the request
  }
  const headers = new Headers(seenInit?.headers ?? undefined);
  assert.equal([...headers.keys()].length, 0);
});
