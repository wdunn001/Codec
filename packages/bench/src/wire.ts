/**
 * wire.ts: pure encode/decode microbench. No network, no model.
 *
 * For each (encoder × stream-shape) pair, measures:
 *   - total wire bytes
 *   - amortized bytes per token
 *   - encode time per chunk (ns)
 *   - decode time per chunk (ns)
 *
 * Reproducible: deterministic seed + warmup + median over N reps.
 *
 *   npx tsx packages/bench/src/wire.ts
 */
import { performance } from 'node:perf_hooks';

import { CODECS, type Codec, type Chunk } from './lib/encoders.js';
import { collect, type StreamShape } from './lib/stream.js';
import { fmtBytes, fmtNs, fmtNum, hr, ratio, table } from './lib/format.js';

const REPS = 7;
const WARMUP = 2;

interface Result {
  encoder: string;
  shape: string;
  totalBytes: number;
  bytesPerToken: number;
  encodeNsPerChunk: number;
  decodeNsPerChunk: number;
  ok: boolean; // round-trip semantic check
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function benchOne(codec: Codec, chunks: Chunk[]): Result {
  // Round-trip semantic check on the first chunk so we catch encode/decode
  // regressions before we report bogus timings. JSON-SSE is lossy by design
  // (text → IDs is approximate) so we skip the equality check there.
  const sample = chunks[0]!;
  const roundTrip = codec.decode(codec.encode(sample));
  const ok =
    codec.name === 'json-sse'
      ? roundTrip.ids.length > 0
      : roundTrip.ids.length === sample.ids.length &&
        roundTrip.ids.every((v, i) => v === sample.ids[i]);

  // Wire bytes: encode every chunk once, sum the lengths.
  const encoded: Uint8Array[] = chunks.map((c) => codec.encode(c));
  const totalBytes = encoded.reduce((s, b) => s + b.byteLength, 0);
  const totalTokens = chunks.reduce((s, c) => s + c.ids.length, 0);

  // Encode timing (median over reps after warmup).
  const encodeRuns: number[] = [];
  for (let r = 0; r < REPS + WARMUP; r++) {
    const t0 = performance.now();
    for (const c of chunks) codec.encode(c);
    const t1 = performance.now();
    if (r >= WARMUP) encodeRuns.push((t1 - t0) * 1e6); // ms → ns
  }
  const encodeNsTotal = median(encodeRuns);

  // Decode timing (same protocol).
  const decodeRuns: number[] = [];
  for (let r = 0; r < REPS + WARMUP; r++) {
    const t0 = performance.now();
    for (const b of encoded) codec.decode(b);
    const t1 = performance.now();
    if (r >= WARMUP) decodeRuns.push((t1 - t0) * 1e6);
  }
  const decodeNsTotal = median(decodeRuns);

  return {
    encoder: codec.name,
    shape: '',
    totalBytes,
    bytesPerToken: totalBytes / totalTokens,
    encodeNsPerChunk: encodeNsTotal / chunks.length,
    decodeNsPerChunk: decodeNsTotal / chunks.length,
    ok,
  };
}

const SHAPES: StreamShape[] = [
  // Realistic LLM streaming workloads. chunk_size=1 is the OpenAI/vLLM default;
  // chunk_size=8 matches some batched servers.
  { totalTokens: 256, chunkSize: 1, vocabSize: 128_000 },
  { totalTokens: 1024, chunkSize: 1, vocabSize: 128_000 },
  { totalTokens: 4096, chunkSize: 1, vocabSize: 128_000 },
  { totalTokens: 4096, chunkSize: 8, vocabSize: 128_000 },
];

function shapeLabel(s: StreamShape): string {
  return `${fmtNum(s.totalTokens)}t / ${s.chunkSize}/chunk`;
}

function main() {
  console.log('# Wire microbench\n');
  console.log(`Reps: ${REPS} (after ${WARMUP} warmup) · seed: 0xdeadbeef\n`);

  for (const shape of SHAPES) {
    const chunks = collect(shape);
    const results: Result[] = CODECS.map((codec) => ({
      ...benchOne(codec, chunks),
      shape: shapeLabel(shape),
    }));

    console.log(hr(shapeLabel(shape)));
    console.log();
    const baseline = results.find((r) => r.encoder === 'json-sse')!;
    console.log(
      table(
        ['encoder', 'wire bytes', 'B/token', 'vs json-sse', 'encode/chunk', 'decode/chunk', 'ok'],
        results.map((r) => [
          r.encoder,
          fmtBytes(r.totalBytes),
          r.bytesPerToken.toFixed(2),
          ratio(baseline.totalBytes, r.totalBytes),
          fmtNs(r.encodeNsPerChunk),
          fmtNs(r.decodeNsPerChunk),
          r.ok ? '✓' : '✗',
        ])
      )
    );
    console.log();
  }

  console.log(hr());
  console.log(
    '\nReading the table: "vs json-sse" shows how much smaller this encoder is than the\n' +
      'JSON-SSE incumbent. raw is the theoretical floor (4 B/token, no framing). msgpack\n' +
      'and protobuf are the actual Codec wire modes: anything close to raw is good.\n'
  );
}

main();
