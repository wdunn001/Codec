import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverMap,
  discoverIndex,
  wellKnownMapUrl,
  wellKnownIndexUrl,
  MapDiscoveryError,
  MapDiscoveryNotFoundError,
} from '../src/discover.js';
import {
  MemoryMapCache,
  TokenizerMapHashMismatchError,
} from '../src/map.js';
import { TINY_MAP } from './fixtures.js';

const ORIGIN = 'https://qwen.test';
const TINY_ID = TINY_MAP.id; // 'test-tiny-v1'

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function makeFakeFetch(
  routes: Record<string, string | { status: number; body?: string }>,
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
    return new Response(route.body ?? '', { status: route.status });
  }) as typeof fetch;
}

// ── URL builders ────────────────────────────────────────────────────────────

test('wellKnownMapUrl builds the standard path with id slashes preserved', () => {
  assert.equal(
    wellKnownMapUrl('https://qwen.io', 'qwen/qwen2'),
    'https://qwen.io/.well-known/codec/maps/qwen/qwen2.json',
  );
});

test('wellKnownMapUrl strips trailing slash from origin', () => {
  assert.equal(
    wellKnownMapUrl('https://qwen.io/', 'qwen/qwen2'),
    'https://qwen.io/.well-known/codec/maps/qwen/qwen2.json',
  );
});

test('wellKnownIndexUrl points at index.json', () => {
  assert.equal(
    wellKnownIndexUrl('https://qwen.io'),
    'https://qwen.io/.well-known/codec/index.json',
  );
});

test('wellKnownMapUrl rejects ids with path traversal', () => {
  assert.throws(() => wellKnownMapUrl('https://qwen.io', '../etc'), MapDiscoveryError);
  assert.throws(() => wellKnownMapUrl('https://qwen.io', '/abs'), MapDiscoveryError);
  assert.throws(() => wellKnownMapUrl('https://qwen.io', 'trailing/'), MapDiscoveryError);
});

test('wellKnownMapUrl rejects ids outside the [a-z0-9._/-] charset', () => {
  assert.throws(() => wellKnownMapUrl('https://qwen.io', 'Qwen/Qwen2'), MapDiscoveryError);
  assert.throws(() => wellKnownMapUrl('https://qwen.io', 'qwen qwen2'), MapDiscoveryError);
});

// ── Inline-map discovery (Form B) ──────────────────────────────────────────

test('discoverMap: inline TokenizerMap is validated and returned', async () => {
  const inline = JSON.stringify(TINY_MAP);
  const fakeFetch = makeFakeFetch({
    [wellKnownMapUrl(ORIGIN, TINY_ID)]: inline,
  });

  const map = await discoverMap({
    origin: ORIGIN,
    id: TINY_ID,
    fetchImpl: fakeFetch,
    cache: new MemoryMapCache(),
  });
  assert.equal(map.id, TINY_ID);
  assert.equal(map.vocab_size, TINY_MAP.vocab_size);
});

test('discoverMap: inline map id mismatch is rejected', async () => {
  const inline = JSON.stringify({ ...TINY_MAP, id: 'something-else' });
  const fakeFetch = makeFakeFetch({
    [wellKnownMapUrl(ORIGIN, TINY_ID)]: inline,
  });
  await assert.rejects(
    discoverMap({ origin: ORIGIN, id: TINY_ID, fetchImpl: fakeFetch }),
    MapDiscoveryError,
  );
});

// ── Pointer discovery (Form A) ─────────────────────────────────────────────

test('discoverMap: pointer is followed and bytes verified by hash', async () => {
  const cdnUrl = 'https://cdn.example.test/qwen2.json';
  const mapBody = JSON.stringify(TINY_MAP);
  const expectedHash = `sha256:${await sha256Hex(new TextEncoder().encode(mapBody))}`;
  const pointer = JSON.stringify({ id: TINY_ID, url: cdnUrl, hash: expectedHash });

  const fakeFetch = makeFakeFetch({
    [wellKnownMapUrl(ORIGIN, TINY_ID)]: pointer,
    [cdnUrl]: mapBody,
  });

  const map = await discoverMap({
    origin: ORIGIN,
    id: TINY_ID,
    fetchImpl: fakeFetch,
    cache: new MemoryMapCache(),
  });
  assert.equal(map.id, TINY_ID);
});

test('discoverMap: pointer with mismatched hash throws TokenizerMapHashMismatchError', async () => {
  const cdnUrl = 'https://cdn.example.test/qwen2.json';
  const mapBody = JSON.stringify(TINY_MAP);
  const wrongHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  const pointer = JSON.stringify({ id: TINY_ID, url: cdnUrl, hash: wrongHash });

  const fakeFetch = makeFakeFetch({
    [wellKnownMapUrl(ORIGIN, TINY_ID)]: pointer,
    [cdnUrl]: mapBody,
  });

  await assert.rejects(
    discoverMap({
      origin: ORIGIN,
      id: TINY_ID,
      fetchImpl: fakeFetch,
      cache: new MemoryMapCache(),
    }),
    TokenizerMapHashMismatchError,
  );
});

test('discoverMap: pointer id mismatch is rejected before fetching CDN', async () => {
  const cdnUrl = 'https://cdn.example.test/qwen2.json';
  const pointer = JSON.stringify({
    id: 'wrong-id',
    url: cdnUrl,
    hash: 'sha256:' + 'a'.repeat(64),
  });
  let cdnFetched = false;
  const fakeFetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === wellKnownMapUrl(ORIGIN, TINY_ID)) {
      return new Response(pointer);
    }
    if (url === cdnUrl) {
      cdnFetched = true;
      return new Response(JSON.stringify(TINY_MAP));
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  await assert.rejects(
    discoverMap({ origin: ORIGIN, id: TINY_ID, fetchImpl: fakeFetch }),
    MapDiscoveryError,
  );
  assert.equal(cdnFetched, false, 'CDN must not be touched when pointer id mismatches');
});

test('discoverMap: pointer with malformed hash is rejected', async () => {
  const pointer = JSON.stringify({
    id: TINY_ID,
    url: 'https://cdn.example.test/qwen2.json',
    hash: 'md5:abcd', // unsupported algo
  });
  const fakeFetch = makeFakeFetch({ [wellKnownMapUrl(ORIGIN, TINY_ID)]: pointer });
  await assert.rejects(
    discoverMap({ origin: ORIGIN, id: TINY_ID, fetchImpl: fakeFetch }),
    /sha256/,
  );
});

test('discoverMap: 404 surfaces as MapDiscoveryNotFoundError', async () => {
  const fakeFetch = makeFakeFetch({
    [wellKnownMapUrl(ORIGIN, TINY_ID)]: { status: 404, body: 'not found' },
  });
  await assert.rejects(
    discoverMap({ origin: ORIGIN, id: TINY_ID, fetchImpl: fakeFetch }),
    MapDiscoveryNotFoundError,
  );
});

test('discoverMap: cache hit on second call skips network', async () => {
  const cdnUrl = 'https://cdn.example.test/qwen2.json';
  const mapBody = JSON.stringify(TINY_MAP);
  const expectedHash = `sha256:${await sha256Hex(new TextEncoder().encode(mapBody))}`;
  const pointer = JSON.stringify({ id: TINY_ID, url: cdnUrl, hash: expectedHash });

  const cache = new MemoryMapCache();
  let cdnFetches = 0;
  const fakeFetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === wellKnownMapUrl(ORIGIN, TINY_ID)) return new Response(pointer);
    if (url === cdnUrl) {
      cdnFetches++;
      return new Response(mapBody);
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  await discoverMap({ origin: ORIGIN, id: TINY_ID, fetchImpl: fakeFetch, cache });
  await discoverMap({ origin: ORIGIN, id: TINY_ID, fetchImpl: fakeFetch, cache });
  assert.equal(cdnFetches, 1, 'second call should hit the cache');
});

// ── Index discovery ───────────────────────────────────────────────────────

test('discoverIndex: returns the parsed index document', async () => {
  const index = {
    codec_version: '0.2',
    maps: [
      {
        id: 'qwen/qwen2',
        url: 'https://cdn.example.test/qwen2.json',
        hash: 'sha256:' + 'a'.repeat(64),
      },
    ],
  };
  const fakeFetch = makeFakeFetch({
    [wellKnownIndexUrl(ORIGIN)]: JSON.stringify(index),
  });
  const got = await discoverIndex({ origin: ORIGIN, fetchImpl: fakeFetch });
  assert.equal(got.codec_version, '0.2');
  assert.equal(got.maps.length, 1);
  assert.equal(got.maps[0]!.id, 'qwen/qwen2');
});

test('discoverIndex: 404 surfaces as MapDiscoveryNotFoundError', async () => {
  const fakeFetch = makeFakeFetch({
    [wellKnownIndexUrl(ORIGIN)]: { status: 404 },
  });
  await assert.rejects(
    discoverIndex({ origin: ORIGIN, fetchImpl: fakeFetch }),
    MapDiscoveryNotFoundError,
  );
});

test('discoverIndex: malformed entries are rejected', async () => {
  const bad = {
    codec_version: '0.2',
    maps: [{ id: 'x' /* missing url + hash */ }],
  };
  const fakeFetch = makeFakeFetch({
    [wellKnownIndexUrl(ORIGIN)]: JSON.stringify(bad),
  });
  await assert.rejects(
    discoverIndex({ origin: ORIGIN, fetchImpl: fakeFetch }),
    MapDiscoveryError,
  );
});
