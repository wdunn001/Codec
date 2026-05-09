/**
 * @codecai/mcp-leaf — reader-side tests.
 *
 * Verifies the symmetry contract: a result produced by `wrapToolCall`
 * round-trips through the reader (`readCodecMeta` / `takeIds`) without
 * re-tokenizing, with proper map-hash mismatch detection and stripping.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeMetaTokenizer, wrapToolCall } from '../src/leaf.js';
import {
  hasCodecMeta,
  findCodecMeta,
  readCodecMeta,
  takeIds,
  stripCodecMeta,
  CodecMetaMapMismatchError,
} from '../src/reader.js';
import type { CallToolResult } from '../src/leaf.js';
import { makeMap, MemoryMapCache } from '@codecai/web';

const MAP_FIXTURE = makeMap({
  id: 'codec-test/reader',
  version: '2',
  vocab_size: 4,
  vocab: { hello: 0, ' world': 1, '!': 2, '\n': 3 },
});

const MAP_HASH_HEX = 'b'.repeat(64);
const MAP_HASH_FULL = `sha256:${MAP_HASH_HEX}`;
const MAP_URL = 'https://example.invalid/reader-test.json';

async function buildMeta() {
  const cache = new MemoryMapCache();
  // Pre-seed under the same key shape `loadMap` derives: `<url>#<hash>`.
  await cache.set(`${MAP_URL}#${MAP_HASH_FULL}`, MAP_FIXTURE);
  return makeMetaTokenizer({
    mapUrl: MAP_URL,
    mapHash: MAP_HASH_FULL,
    cache,
  });
}

describe('mcp-leaf reader', () => {
  it('hasCodecMeta finds wrapped meta and ignores plain results', async () => {
    const meta = await buildMeta();
    const plain: CallToolResult = {
      content: [{ type: 'text', text: 'hello' }],
    };
    assert.equal(hasCodecMeta(plain), false);
    const wrapped = wrapToolCall(plain, meta);
    assert.equal(hasCodecMeta(wrapped), true);
  });

  it('round-trips ids written by wrapToolCall without re-tokenization', async () => {
    const meta = await buildMeta();
    const wrapped = wrapToolCall(
      { content: [{ type: 'text', text: 'hello' }] },
      meta,
    );
    const ids = takeIds(wrapped);
    assert.equal(ids.length, 1);
    assert.deepEqual(ids[0], meta.encode('hello'));
  });

  it('readCodecMeta aligns one entry per text block, in order', async () => {
    const meta = await buildMeta();
    const wrapped = wrapToolCall(
      {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'hello' },
        ],
      },
      meta,
    );
    const pairings = readCodecMeta(wrapped);
    assert.equal(pairings.length, 2);
    assert.equal(pairings[0]!.text, 'hello');
    assert.equal(pairings[1]!.text, 'hello');
    assert.equal(pairings[0]!.mapId, MAP_HASH_FULL);
    assert.equal(pairings[1]!.mapId, MAP_HASH_FULL);
    assert.deepEqual(pairings[0]!.ids, meta.encode('hello'));
    assert.deepEqual(pairings[1]!.ids, meta.encode('hello'));
  });

  it('returns null ids when a text block has no meta sibling', () => {
    const result: CallToolResult = {
      content: [{ type: 'text', text: 'hello' }],
    };
    const pairings = readCodecMeta(result);
    assert.equal(pairings.length, 1);
    assert.equal(pairings[0]!.ids, null);
    assert.equal(pairings[0]!.mapId, null);
  });

  it('throws on map-hash mismatch with expectedMapHash set', async () => {
    const meta = await buildMeta();
    const wrapped = wrapToolCall(
      { content: [{ type: 'text', text: 'hello' }] },
      meta,
    );
    assert.throws(
      () => readCodecMeta(wrapped, { expectedMapHash: 'sha256:' + 'c'.repeat(64) }),
      CodecMetaMapMismatchError,
    );
    // No throw when the expected hash matches (with or without prefix).
    readCodecMeta(wrapped, { expectedMapHash: MAP_HASH_FULL });
    readCodecMeta(wrapped, { expectedMapHash: MAP_HASH_HEX });
  });

  it('findCodecMeta returns the adjacent meta or null', async () => {
    const meta = await buildMeta();
    const wrapped = wrapToolCall(
      { content: [{ type: 'text', text: 'hello' }] },
      meta,
    );
    assert.notEqual(findCodecMeta(wrapped, 0), null);
    // Index past the end:
    assert.equal(findCodecMeta(wrapped, 99), null);
  });

  it('stripCodecMeta removes meta blocks and leaves the rest untouched', async () => {
    const meta = await buildMeta();
    const wrapped = wrapToolCall(
      {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      },
      meta,
    );
    assert.equal(wrapped.content.length, 3); // text + meta + image
    const stripped = stripCodecMeta(wrapped);
    assert.equal(stripped.content.length, 2);
    assert.equal((stripped.content[0] as { type: string }).type, 'text');
    assert.equal((stripped.content[1] as { type: string }).type, 'image');
    // Original unchanged.
    assert.equal(wrapped.content.length, 3);
  });

  it('stripCodecMeta is a no-op identity when no meta is present', () => {
    const plain: CallToolResult = {
      content: [{ type: 'text', text: 'hello' }],
    };
    const out = stripCodecMeta(plain);
    assert.equal(out, plain);
  });
});
