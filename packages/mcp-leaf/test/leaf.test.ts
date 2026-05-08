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
    await cache.set(`${MAP_URL}#${MAP_HASH_HEX}`, MAP_FIXTURE);
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
  it('appends a _codec_meta sibling to every text block', async () => {
    const meta = await buildMeta();
    const result = {
      content: [
        { type: 'text' as const, text: 'hello world!' },
        { type: 'text' as const, text: 'second block' },
      ],
    };

    const wrapped = wrapToolCall(result, meta);
    assert.equal(wrapped.content.length, 4);
    assert.equal(wrapped.content[0]!.type, 'text');
    assert.equal(wrapped.content[1]!.type, '_codec_meta');
    assert.equal(wrapped.content[2]!.type, 'text');
    assert.equal(wrapped.content[3]!.type, '_codec_meta');

    const meta1 = wrapped.content[1] as { type: string; map_id: string; ids: number[] };
    assert.equal(meta1.map_id, `sha256:${MAP_HASH_HEX}`);
    assert.ok(Array.isArray(meta1.ids));
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
    assert.equal(wrapped.content.length, 3, 'no meta blocks added for non-text content');
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
    // Short text gets no meta sibling; long text does.
    assert.equal(wrapped.content.length, 3);
    assert.equal(wrapped.content[0]!.type, 'text');
    assert.equal(wrapped.content[1]!.type, 'text');
    assert.equal(wrapped.content[2]!.type, '_codec_meta');
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
});

describe('buildMetaBlock', () => {
  it('produces a valid _codec_meta block', async () => {
    const meta = await buildMeta();
    const block = buildMetaBlock('hello', meta);
    assert.equal(block.type, '_codec_meta');
    assert.equal(block.map_id, `sha256:${MAP_HASH_HEX}`);
    assert.ok(Array.isArray(block.ids));
  });
});
