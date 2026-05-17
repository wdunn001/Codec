/**
 * @codecai/mcp-leaf — leaf-mode wrapper round-trip tests.
 *
 * Uses an inline minimal TokenizerMap so the tests don't depend on a CDN
 * fetch. The encode contract is tested against the LongestMatchTokenizer
 * fallback (no merges in the inline map → identity / unknown coverage),
 * which is enough to verify the wrapper layer's idempotence + shape
 * guarantees.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeMetaTokenizer, wrapToolCall, buildMetaBlock } from '../src/leaf.js';
import { makeMap, MemoryMapCache } from '@codecai/web';

// Fixture — a minimal v2 vocab-only map. The runtime falls back to
// LongestMatchTokenizer when no merges are present, which gives stable
// IDs for any input matching the small vocab.
const MAP_FIXTURE = makeMap({
  id: 'codec-test/leaf',
  version: '2',
  vocab_size: 4,
  vocab: { hello: 0, ' world': 1, '!': 2, '\n': 3 },
});

const MAP_HASH_HEX = 'a'.repeat(64);
const MAP_URL = 'https://example.invalid/leaf-test.json';

async function buildMeta() {
  const cache = new MemoryMapCache();
  // Pre-seed the cache so loadMap doesn't try to fetch.
  await cache.set(`${MAP_URL}#sha256:${MAP_HASH_HEX}`, MAP_FIXTURE);
  return makeMetaTokenizer({
    mapUrl: MAP_URL,
    mapHash: `sha256:${MAP_HASH_HEX}`,
    cache,
  });
}

describe('makeMetaTokenizer', () => {
  it('normalises a bare hex hash to sha256:<hex>', async () => {
    const cache = new MemoryMapCache();
    // makeMetaTokenizer normalises the bare hex to `sha256:<hex>` BEFORE
    // calling loadMap (per bef03a1's "validate before fetch" rule), so
    // loadMap's cacheKey is `${url}#sha256:${hex}` regardless of which
    // form the caller passed. Pre-populate with the normalised key.
    await cache.set(`${MAP_URL}#sha256:${MAP_HASH_HEX}`, MAP_FIXTURE);
    const meta = await makeMetaTokenizer({
      mapUrl: MAP_URL,
      mapHash: MAP_HASH_HEX,
      cache,
    });
    assert.equal(meta.mapHash, `sha256:${MAP_HASH_HEX}`);
  });

  it('rejects malformed hashes', async () => {
    await assert.rejects(
      () => makeMetaTokenizer({
        mapUrl: MAP_URL,
        mapHash: 'not-a-hash',
        cache: new MemoryMapCache(),
      }),
      /must be 'sha256:/,
    );
  });
});

describe('wrapToolCall', () => {
  it('attaches _meta payload to every text block (no sibling blocks)', async () => {
    const meta = await buildMeta();
    const result = {
      content: [
        { type: 'text' as const, text: 'hello world!' },
        { type: 'text' as const, text: 'second block' },
      ],
    };

    const wrapped = wrapToolCall(result, meta);
    // Per-block _meta — no extra sibling blocks. Length stays 2.
    assert.equal(wrapped.content.length, 2);
    assert.equal(wrapped.content[0]!.type, 'text');
    assert.equal(wrapped.content[1]!.type, 'text');

    const block0 = wrapped.content[0] as { _meta?: Record<string, unknown> };
    const payload0 = (block0._meta as Record<string, unknown> | undefined)?.[
      'ai.codec/leaf-tokenization'
    ] as { map_id: string; ids: number[] } | undefined;
    assert.ok(payload0, 'block 0 has codec _meta');
    assert.equal(payload0!.map_id, `sha256:${MAP_HASH_HEX}`);
    assert.ok(Array.isArray(payload0!.ids));

    const block1 = wrapped.content[1] as { _meta?: Record<string, unknown> };
    assert.ok(
      (block1._meta as Record<string, unknown> | undefined)?.[
        'ai.codec/leaf-tokenization'
      ],
      'block 1 has codec _meta',
    );
  });

  it('leaves non-text blocks alone (image, audio, resource)', async () => {
    const meta = await buildMeta();
    const result = {
      content: [
        { type: 'image' as const, data: '<base64>', mimeType: 'image/png' },
        { type: 'audio' as const, data: '<base64>', mimeType: 'audio/mp3' },
        { type: 'resource' as const, uri: 'file:///x' },
      ],
    };
    const wrapped = wrapToolCall(result, meta);
    assert.equal(wrapped.content.length, 3, 'no meta added for non-text content');
    assert.deepEqual(wrapped.content, result.content);
  });

  it('respects minTextLength to skip short text', async () => {
    const meta = await buildMeta();
    const result = {
      content: [
        { type: 'text' as const, text: 'hi' },                    // 2 chars
        { type: 'text' as const, text: 'a longer message here' }, // 21 chars
      ],
    };
    const wrapped = wrapToolCall(result, meta, { minTextLength: 16 });
    assert.equal(wrapped.content.length, 2);
    // Short text: no _meta added.
    assert.equal(
      (wrapped.content[0] as { _meta?: unknown })._meta,
      undefined,
      'short text has no _meta',
    );
    // Long text: _meta with codec payload.
    const long = wrapped.content[1] as { _meta?: Record<string, unknown> };
    assert.ok(
      (long._meta as Record<string, unknown> | undefined)?.[
        'ai.codec/leaf-tokenization'
      ],
      'long text has _meta',
    );
  });

  it('is idempotent — wrapping twice produces the same tree as once', async () => {
    const meta = await buildMeta();
    const result = {
      content: [
        { type: 'text' as const, text: 'hello world!' },
      ],
    };
    const once = wrapToolCall(result, meta);
    const twice = wrapToolCall(once, meta);
    assert.deepEqual(twice.content, once.content);
  });

  it('does not mutate the input', async () => {
    const meta = await buildMeta();
    const result = {
      content: [{ type: 'text' as const, text: 'hello world!' }],
    };
    const before = JSON.parse(JSON.stringify(result));
    wrapToolCall(result, meta);
    assert.deepEqual(result, before, 'input result unchanged');
  });

  it('preserves top-level fields (isError, custom keys)', async () => {
    const meta = await buildMeta();
    const result = {
      content: [{ type: 'text' as const, text: 'oops' }],
      isError: true,
      _trace: 'abc123',
    };
    const wrapped = wrapToolCall(result, meta);
    assert.equal(wrapped.isError, true);
    assert.equal((wrapped as Record<string, unknown>)._trace, 'abc123');
  });

  it('preserves an existing _meta on the text block (merges keys)', async () => {
    const meta = await buildMeta();
    const result = {
      content: [
        { type: 'text' as const, text: 'hello world!', _meta: { 'app/trace': 'abc' } },
      ],
    };
    const wrapped = wrapToolCall(result, meta);
    const block = wrapped.content[0] as { _meta?: Record<string, unknown> };
    assert.equal(block._meta?.['app/trace'], 'abc');
    assert.ok(block._meta?.['ai.codec/leaf-tokenization']);
  });
});

describe('buildMetaBlock', () => {
  it('produces a text block with the codec _meta payload attached', async () => {
    const meta = await buildMeta();
    const block = buildMetaBlock('hello', meta);
    assert.equal(block.type, 'text');
    assert.equal(block.text, 'hello');
    const payload = block._meta['ai.codec/leaf-tokenization'];
    assert.equal(payload.map_id, `sha256:${MAP_HASH_HEX}`);
    assert.ok(Array.isArray(payload.ids));
  });
});
