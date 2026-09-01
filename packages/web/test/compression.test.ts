import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hashZstdDict,
  selectZstdDictForResponse,
  CodecZstdDictError,
} from '../src/compression.js';

// ── Fixture wiring ──────────────────────────────────────────────────────────
// The dict-zstd-interop fixture is the cross-client conformance bundle: every
// Codec client (TS, Python, Rust, Java, .NET, C) MUST agree on the dict
// hash and the decompressed token sequence. See the fixture manifest:
//   packages/bench/fixtures/dict-zstd-interop/manifest.json

const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), '..', '..', '..');
const FIXTURE_DIR = path.join(
  REPO_ROOT,
  'packages',
  'bench',
  'fixtures',
  'dict-zstd-interop',
);
const DICT_PATH = path.join(FIXTURE_DIR, 'dict.bin');

const EXPECTED_DICT_HASH =
  'sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db';

function readDictBytes(): Uint8Array {
  const buf = fs.readFileSync(DICT_PATH);
  // Return a fresh Uint8Array view; don't share Node's pooled Buffer slab.
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ── hashZstdDict ────────────────────────────────────────────────────────────

test('hashZstdDict matches the fixture manifest hash', async () => {
  const dict = readDictBytes();
  const hash = await hashZstdDict(dict);
  assert.equal(hash, EXPECTED_DICT_HASH);
});

test('hashZstdDict returns the canonical sha256:<64 hex chars> shape', async () => {
  const hash = await hashZstdDict(new Uint8Array([1, 2, 3]));
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
});

test('hashZstdDict empty input is the well-known SHA-256 of empty', async () => {
  const hash = await hashZstdDict(new Uint8Array(0));
  assert.equal(
    hash,
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

// ── selectZstdDictForResponse ───────────────────────────────────────────────

test('selectZstdDictForResponse returns dict bytes on matching zstd response (plain object headers)', async () => {
  const dict = readDictBytes();
  const registry = new Map<string, Uint8Array>([[EXPECTED_DICT_HASH, dict]]);

  const got = selectZstdDictForResponse(
    { 'content-encoding': 'zstd', 'codec-zstd-dict': EXPECTED_DICT_HASH },
    registry,
  );
  assert.ok(got, 'expected dict bytes back, got null');
  assert.equal(got.byteLength, dict.byteLength);
  assert.equal(got, dict, 'should return the same Uint8Array reference from the registry');
});

test('selectZstdDictForResponse honours the Headers Web API (mixed casing)', async () => {
  const dict = readDictBytes();
  const registry = new Map<string, Uint8Array>([[EXPECTED_DICT_HASH, dict]]);

  const h = new Headers();
  h.set('Content-Encoding', 'zstd');
  h.set('Codec-Zstd-Dict', EXPECTED_DICT_HASH);

  const got = selectZstdDictForResponse(h, registry);
  assert.ok(got);
  assert.equal(got.byteLength, dict.byteLength);
});

test('selectZstdDictForResponse plain-dict lookup is case-insensitive', async () => {
  const dict = readDictBytes();
  const registry = new Map<string, Uint8Array>([[EXPECTED_DICT_HASH, dict]]);

  const got = selectZstdDictForResponse(
    { 'Content-Encoding': 'ZSTD', 'Codec-Zstd-Dict': EXPECTED_DICT_HASH },
    registry,
  );
  assert.ok(got);
});

test('selectZstdDictForResponse returns null on identity response', () => {
  const registry = new Map<string, Uint8Array>();
  assert.equal(
    selectZstdDictForResponse({ 'content-encoding': 'identity' }, registry),
    null,
  );
});

test('selectZstdDictForResponse returns null on missing content-encoding header', () => {
  const registry = new Map<string, Uint8Array>();
  assert.equal(selectZstdDictForResponse({}, registry), null);
});

test('selectZstdDictForResponse returns null on gzip response (caller decompresses)', () => {
  const registry = new Map<string, Uint8Array>();
  assert.equal(
    selectZstdDictForResponse({ 'content-encoding': 'gzip' }, registry),
    null,
  );
});

test('selectZstdDictForResponse throws CodecZstdDictError when zstd response is missing the dict header', () => {
  const dict = readDictBytes();
  const registry = new Map<string, Uint8Array>([[EXPECTED_DICT_HASH, dict]]);

  assert.throws(
    () => selectZstdDictForResponse({ 'content-encoding': 'zstd' }, registry),
    (err: unknown) => {
      assert.ok(err instanceof CodecZstdDictError);
      assert.match((err as Error).message, /no Codec-Zstd-Dict header/);
      return true;
    },
  );
});

test('selectZstdDictForResponse throws CodecZstdDictError when the dict header names an unknown hash', () => {
  const dict = readDictBytes();
  const registry = new Map<string, Uint8Array>([[EXPECTED_DICT_HASH, dict]]);

  const unknownHash = 'sha256:' + '0'.repeat(64);
  assert.throws(
    () =>
      selectZstdDictForResponse(
        { 'content-encoding': 'zstd', 'codec-zstd-dict': unknownHash },
        registry,
      ),
    (err: unknown) => {
      assert.ok(err instanceof CodecZstdDictError);
      assert.match((err as Error).message, /isn't loaded locally/);
      return true;
    },
  );
});

test('selectZstdDictForResponse throws on malformed dict header (not sha256:<hex>)', () => {
  const registry = new Map<string, Uint8Array>();
  for (const bad of ['md5:abc', 'sha256:short', 'sha256:' + 'Z'.repeat(64), 'garbage']) {
    assert.throws(
      () =>
        selectZstdDictForResponse(
          { 'content-encoding': 'zstd', 'codec-zstd-dict': bad },
          registry,
        ),
      CodecZstdDictError,
      `expected malformed header ${JSON.stringify(bad)} to throw`,
    );
  }
});

test('selectZstdDictForResponse throws on empty dict header value', () => {
  const registry = new Map<string, Uint8Array>();
  assert.throws(
    () =>
      selectZstdDictForResponse(
        { 'content-encoding': 'zstd', 'codec-zstd-dict': '' },
        registry,
      ),
    CodecZstdDictError,
  );
});

// ── End-to-end fixture decompression (demo-side equivalent) ─────────────────
// The @codecai/web package intentionally does not ship a zstd decompressor
// (browser callers bring their own: DecompressionStream('zstd'),
// @mongodb-js/zstd in Node, etc.). But the dict-zstd-interop fixture is the
// cross-client conformance contract, so we exercise the full path here using
// Node's bundled zlib.zstdDecompress (Node 22.15+ / 23.8+).
//
// On older Node, the test skips with a note: the matrix bench runner in
// packages/demo uses @mongodb-js/zstd directly and is the production path.

import * as zlib from 'node:zlib';

const COMPRESSED_PATH = path.join(FIXTURE_DIR, 'compressed.bin');
const DECOMPRESSED_PATH = path.join(FIXTURE_DIR, 'decompressed.bin');

const hasNodeZstd =
  typeof (zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync ===
  'function';

test('fixture: select + decompress yields byte-identical decompressed.bin', { skip: !hasNodeZstd }, async () => {
  const dict = readDictBytes();
  const registry = new Map<string, Uint8Array>([[EXPECTED_DICT_HASH, dict]]);

  // Step 1: server says zstd + names the dict; we pick it.
  const picked = selectZstdDictForResponse(
    { 'content-encoding': 'zstd', 'codec-zstd-dict': EXPECTED_DICT_HASH },
    registry,
  );
  assert.ok(picked);

  // Step 2: actually decompress with the picked dict and compare bytes.
  const compressed = fs.readFileSync(COMPRESSED_PATH);
  const expected = fs.readFileSync(DECOMPRESSED_PATH);
  // zlib.zstdDecompressSync accepts dict via the `params` option.
  const decompressed = (zlib as unknown as {
    zstdDecompressSync: (
      buf: Buffer,
      opts: { dictionary: Uint8Array },
    ) => Buffer;
  }).zstdDecompressSync(compressed, { dictionary: picked });
  assert.deepEqual(
    Array.from(decompressed),
    Array.from(expected),
    'decompressed bytes must be byte-identical to fixture decompressed.bin',
  );
});

test('fixture: decompressed msgpack frames yield 32 token IDs starting with the manifest sequence', { skip: !hasNodeZstd }, async () => {
  // msgpack lives next door: same dep the rest of @codecai/web uses.
  const { decodeMulti } = await import('@msgpack/msgpack');

  const dict = readDictBytes();
  const compressed = fs.readFileSync(COMPRESSED_PATH);
  const decompressed = (zlib as unknown as {
    zstdDecompressSync: (
      buf: Buffer,
      opts: { dictionary: Uint8Array },
    ) => Buffer;
  }).zstdDecompressSync(compressed, { dictionary: dict });

  const ids: number[] = [];
  for (const frame of decodeMulti(decompressed)) {
    const f = frame as { ids?: unknown };
    if (Array.isArray(f.ids)) {
      for (const id of f.ids) ids.push(id as number);
    }
  }
  assert.equal(ids.length, 32, 'expected 32 token IDs total per manifest.expected_token_count');
  assert.deepEqual(
    ids.slice(0, 10),
    [53365, 1593, 7552, 57218, 5371, 37, 11278, 43, 9909, 2773],
    'first 10 IDs must match manifest.expected_first_10_ids',
  );
});
