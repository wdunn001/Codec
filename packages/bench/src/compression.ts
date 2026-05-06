/**
 * Compression overlay benchmark.
 *
 * Measures the additional bytes-per-token reduction when transport
 * compression (gzip / zstd) is layered on top of the Codec wire formats.
 * This is the v0.2 protocol addition — opt-in via Accept-Encoding /
 * Content-Encoding negotiation.
 *
 * The test mimics what happens at the HTTP layer when a server emits a
 * stream of CodecFrames and an upstream compressor builds one context
 * across the whole stream.
 */
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { CODECS } from './lib/encoders.ts';
import type { Chunk } from './lib/encoders.ts';

// Optional: zstd via Node 23+'s native zlib.zstdCompressSync.
let zstdCompressSync: ((input: Buffer) => Buffer) | null = null;
try {
  const zlib = await import('node:zlib');
  if ((zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync) {
    zstdCompressSync = (zlib as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
  }
} catch {
  /* not available */
}

// Brotli at quality 4 — matches what the server uses for streaming
// (default 11 is 10-50x slower for streams).
function brotli4(buf: Buffer): Buffer {
  return brotliCompressSync(buf, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
}

// ── Sample stream (matches wire.ts: 1024 tokens, 1 per chunk) ───────────────

function makeStream(numTokens: number, chunkSize: number): Chunk[] {
  // Same RNG seed pattern as wire.ts so numbers compare directly.
  let seed = 0xdeadbeef >>> 0;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) & 0x1ffff);
  const out: Chunk[] = [];
  let emitted = 0;
  while (emitted < numTokens) {
    const take = Math.min(chunkSize, numTokens - emitted);
    const ids: number[] = [];
    for (let i = 0; i < take; i++) ids.push(rng());
    emitted += take;
    out.push({
      ids,
      done: emitted >= numTokens,
      finishReason: emitted >= numTokens ? 'eos_token' : undefined,
    });
  }
  return out;
}

function encodeStream(encoderName: 'json-sse' | 'msgpack' | 'protobuf', chunks: Chunk[]): Uint8Array {
  const encoder = CODECS.find((c) => c.name === encoderName);
  if (!encoder) throw new Error(`unknown encoder: ${encoderName}`);
  const parts: Uint8Array[] = [];
  for (const c of chunks) {
    const out = encoder.encode(c);
    if (out instanceof Uint8Array) parts.push(out);
    else parts.push(new TextEncoder().encode(out as string));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    merged.set(p, off);
    off += p.length;
  }
  return merged;
}

function fmt(n: number): string {
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// ── Run ──────────────────────────────────────────────────────────────────────

console.log('# Compression overlay benchmark\n');
console.log('Stream: 1,024 tokens, 1 per chunk (matches wire.ts).\n');
console.log(
  'Compression is layered as it would be at the HTTP layer: a single\n' +
    'context for the whole response stream. This matches what\n' +
    'Content-Encoding: gzip/zstd does in vLLM and SGLang.\n',
);

if (!zstdCompressSync) {
  console.log('(zstd: not available in this Node — install Node 23+ for native zstd support.)\n');
}

const NUM_TOKENS = 1024;
const stream = makeStream(NUM_TOKENS, 1);

interface Row {
  encoder: string;
  identity: number;
  gzip: number;
  br: number;
  zstd: number | null;
}

const rows: Row[] = [];

for (const name of ['json-sse', 'msgpack', 'protobuf'] as const) {
  const encoded = encodeStream(name, stream);
  const buf = Buffer.from(encoded);
  rows.push({
    encoder: name,
    identity: buf.length,
    gzip: gzipSync(buf, { level: 6 }).length,
    br: brotli4(buf).length,
    zstd: zstdCompressSync ? zstdCompressSync(buf).length : null,
  });
}

console.log('| encoder  | identity   | + gzip     | + br       | + zstd     |');
console.log('|----------|------------|------------|------------|------------|');
for (const r of rows) {
  console.log(
    `| ${r.encoder.padEnd(8)} | ${fmt(r.identity).padEnd(10)} | ${fmt(r.gzip).padEnd(10)} | ${fmt(r.br).padEnd(10)} | ${(r.zstd !== null ? fmt(r.zstd) : 'n/a').padEnd(10)} |`,
  );
}

console.log('\nBytes/token:\n');
console.log('| encoder  | identity | + gzip | +  br  | + zstd |');
console.log('|----------|---------:|-------:|-------:|-------:|');
for (const r of rows) {
  const f = (n: number | null) => (n === null ? '   n/a' : (n / NUM_TOKENS).toFixed(2).padStart(6));
  console.log(`| ${r.encoder.padEnd(8)} | ${f(r.identity).padStart(8)} | ${f(r.gzip)} | ${f(r.br)} | ${f(r.zstd)} |`);
}

console.log('\nReduction summary (vs JSON-SSE identity):\n');
const baseline = rows.find((r) => r.encoder === 'json-sse')!.identity;
console.log('| configuration            | bytes/token | vs json-sse |');
console.log('|--------------------------|------------:|------------:|');
for (const r of rows) {
  for (const [suffix, bytes] of [
    ['', r.identity] as [string, number],
    [' + gzip', r.gzip],
    [' + br', r.br],
    ...(r.zstd !== null ? [[' + zstd', r.zstd] as [string, number]] : []),
  ]) {
    const bpt = (bytes / NUM_TOKENS).toFixed(2);
    const ratio = (baseline / bytes).toFixed(1);
    console.log(`| ${(r.encoder + suffix).padEnd(24)} | ${bpt.padStart(11)} | ${(ratio + '\xd7').padStart(11)} |`);
  }
}

console.log(
  '\nNotes:\n' +
    '  - JSON-SSE compresses well because it has lots of repeated keys ("data:", "ids":, etc.).\n' +
    '  - Codec frames have less structural redundancy, so the absolute compression ratio\n' +
    '    is smaller — but the *post-compression* bytes/token is what matters for the wire.\n' +
    '  - zstd dictionaries (future v2 protocol) will push Codec further by pre-training on\n' +
    '    typical token sequences for each model.',
);
