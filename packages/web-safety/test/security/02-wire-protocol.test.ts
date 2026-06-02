/**
 * 02 — Wire/protocol attack/defense tests.
 *
 * Each test demonstrates one attack class from
 * spec/proposals/v0.6-security/02-wire-protocol-attacks.md plus the defense
 * function that neutralizes it. Tests are transport-independent — they
 * exercise the policy core without requiring a running Codec server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeWithBudget,
  validateFramedLength,
  negotiateCompression,
  CodecDecompressionBudgetExceeded,
  CodecLengthMismatch,
  CodecNegotiationFailure,
} from '../../src/security/index.js';

// ── Decompression bombs ──────────────────────────────────────────────────────

async function* yieldChunks(sizes: number[]): AsyncIterable<Uint8Array> {
  for (const sz of sizes) {
    yield new Uint8Array(sz);
  }
}

test('attack: decompression bomb exceeds budget', async () => {
  // Simulated bomb: tiny compressed input that decodes to 32 MiB across many chunks.
  const chunkSize = 1024 * 1024; // 1 MiB each
  const bombChunks = Array.from({ length: 32 }, () => chunkSize);
  // Sum is 32 MiB; budget is 16 MiB.
  await assert.rejects(
    decodeWithBudget(yieldChunks(bombChunks), 16 * 1024 * 1024),
    (err: unknown) => {
      assert.ok(err instanceof CodecDecompressionBudgetExceeded);
      assert.ok((err as CodecDecompressionBudgetExceeded).seenBytes > 16 * 1024 * 1024);
      return true;
    },
  );
});

test('defense: budgeted decode accepts within budget', async () => {
  // 8 MiB decoded under a 16 MiB budget — should pass.
  const chunkSize = 1024 * 1024;
  const chunks = Array.from({ length: 8 }, () => chunkSize);
  const out = await decodeWithBudget(yieldChunks(chunks), 16 * 1024 * 1024);
  assert.equal(out.byteLength, 8 * 1024 * 1024);
});

test('defense: budget exceeded mid-stream — rejects (does not truncate-and-continue)', async () => {
  // Verify the exception happens AT the budget breach, not after consuming
  // the full bomb. This is the "reject not truncate" posture.
  const yielded: number[] = [];
  async function* trackedChunks(): AsyncIterable<Uint8Array> {
    for (let i = 0; i < 100; i++) {
      yielded.push(i);
      yield new Uint8Array(1024 * 1024); // 1 MiB
    }
  }
  await assert.rejects(decodeWithBudget(trackedChunks(), 4 * 1024 * 1024));
  // Should have yielded only ~5 chunks before bailing (budget 4 MiB + 1 to detect breach).
  assert.ok(yielded.length <= 6, `should bail early, yielded ${yielded.length} chunks`);
  assert.ok(yielded.length < 100, 'must not consume entire bomb stream');
});

// ── Length confusion ─────────────────────────────────────────────────────────

test('attack: declared length mismatches actual frame body', () => {
  const body = new Uint8Array(100);
  // Attacker declares a smaller length than the actual body to bleed bytes
  // into the next frame's parsing scope.
  assert.throws(
    () => validateFramedLength(64, body),
    (err: unknown) => {
      assert.ok(err instanceof CodecLengthMismatch);
      assert.equal((err as CodecLengthMismatch).declared, 64);
      assert.equal((err as CodecLengthMismatch).actual, 100);
      return true;
    },
  );
});

test('defense: matched length passes validation', () => {
  const body = new Uint8Array(128);
  assert.doesNotThrow(() => validateFramedLength(128, body));
});

test('attack: declared length larger than actual body — also rejected', () => {
  const body = new Uint8Array(50);
  // The other direction of length confusion: declared > actual means the
  // parser would over-read into the next frame's header.
  assert.throws(() => validateFramedLength(200, body), CodecLengthMismatch);
});

// ── Compression negotiation downgrade ────────────────────────────────────────

test('attack: server advertises only identity — production tier rejects', () => {
  // Malicious server claims no compression support, forcing identity fallback.
  // Per spec/proposals/v0.6-security/02-wire-protocol-attacks.md §1 +
  // memory feedback_engine_image_dep_verify, this is the worst Codec
  // failure mode and MUST surface loudly in production.
  assert.throws(
    () =>
      negotiateCompression(
        ['dict-zstd', 'zstd', 'br', 'gzip', 'identity'],
        ['identity'],
        'production',
      ),
    (err: unknown) => {
      assert.ok(err instanceof CodecNegotiationFailure);
      return true;
    },
  );
});

test('defense: same scenario in development tier — returns identity with warning', () => {
  const result = negotiateCompression(
    ['dict-zstd', 'zstd', 'br', 'gzip', 'identity'],
    ['identity'],
    'development',
  );
  assert.equal(result.chosen, 'identity');
  assert.ok(result.warning);
  assert.ok(result.warning!.includes('identity'));
});

test('defense: legitimate negotiation prefers strongest mutual compression', () => {
  const { chosen, warning } = negotiateCompression(
    ['gzip', 'br', 'zstd', 'dict-zstd'],
    ['gzip', 'br', 'zstd'],
    'production',
  );
  assert.equal(chosen, 'zstd', 'should pick zstd (highest mutual)');
  assert.equal(warning, undefined);
});

test('defense: no overlap at all — throws negotiation failure', () => {
  assert.throws(
    () => negotiateCompression(['gzip'], ['br'], 'production'),
    CodecNegotiationFailure,
  );
});

test('defense: dict-zstd preferred when both peers support it', () => {
  const { chosen } = negotiateCompression(
    ['identity', 'gzip', 'zstd', 'dict-zstd'],
    ['identity', 'br', 'zstd', 'dict-zstd'],
    'production',
  );
  assert.equal(chosen, 'dict-zstd');
});
