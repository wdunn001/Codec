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
import { gzipSync } from 'node:zlib';
import { CODECS } from './lib/encoders.ts';
import type { Chunk } from './lib/encoders.ts';

// Optional: zstd via the `zstd-napi` package. Skipped gracefully if absent.
let zstdCompressSync: ((input: Buffer) => Buffer) | null = null;
try {
  // Try Node 23+'s native zstd support first.
  const zlib = await import('node:zlib');
  if ((zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync) {
    zstdCompressSync = (zlib as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
  }
} catch {
  /* not available */
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

const rows: { encoder: string; identity: number; gzip: number; zstd: number | null }[] = [];

for (const name of ['json-sse', 'msgpack', 'protobuf'] as const) {
  const encoded = encodeStream(name, stream);
  const buf = Buffer.from(encoded);
  const identity = buf.length;
  const gzip = gzipSync(buf, { level: 6 }).length;
  const zstd = zstdCompressSync ? zstdCompressSync(buf).length : null;
  rows.push({ encoder: name, identity, gzip, zstd });
}

console.log('| encoder  | identity     | + gzip       | + zstd       | identity B/tok | gzip B/tok | zstd B/tok |');
console.log('|----------|--------------|--------------|--------------|----------------|------------|------------|');
for (const r of rows) {
  const idB = (r.identity / NUM_TOKENS).toFixed(2);
  const gzB = (r.gzip / NUM_TOKENS).toFixed(2);
  const zsB = r.zstd !== null ? (r.zstd / NUM_TOKENS).toFixed(2) : 'n/a';
  console.log(
    `| ${r.encoder.padEnd(8)} | ${fmt(r.identity).padEnd(12)} | ${fmt(r.gzip).padEnd(12)} | ${(r.zstd !== null ? fmt(r.zstd) : 'n/a').padEnd(12)} | ${idB.padStart(14)} | ${gzB.padStart(10)} | ${zsB.padStart(10)} |`,
  );
}

console.log('\nReduction summary (vs JSON-SSE identity):\n');
const baseline = rows.find((r) => r.encoder === 'json-sse')!.identity;
console.log('| configuration            | bytes/token | vs json-sse |');
console.log('|--------------------------|-------------|-------------|');
for (const r of rows) {
  const idB = (r.identity / NUM_TOKENS).toFixed(2);
  const gzB = (r.gzip / NUM_TOKENS).toFixed(2);
  const idR = (baseline / r.identity).toFixed(1);
  const gzR = (baseline / r.gzip).toFixed(1);
  console.log(`| ${r.encoder.padEnd(24)} | ${idB.padStart(11)} | ${(idR + '\xd7').padStart(11)} |`);
  console.log(`| ${(r.encoder + ' + gzip').padEnd(24)} | ${gzB.padStart(11)} | ${(gzR + '\xd7').padStart(11)} |`);
  if (r.zstd !== null) {
    const zsB = (r.zstd / NUM_TOKENS).toFixed(2);
    const zsR = (baseline / r.zstd).toFixed(1);
    console.log(`| ${(r.encoder + ' + zstd').padEnd(24)} | ${zsB.padStart(11)} | ${(zsR + '\xd7').padStart(11)} |`);
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
