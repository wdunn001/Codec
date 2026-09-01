/**
 * Compression overlay benchmark.
 *
 * Measures the additional bytes-per-token reduction when transport
 * compression (gzip / zstd) is layered on top of the Codec wire formats.
 * This is the v0.2 protocol addition: opt-in via Accept-Encoding /
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

// Brotli at quality 4: matches what the server uses for streaming
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
console.log(
  'Sweeps three response sizes (small / medium / large) so you can see how\n' +
    'each compression solution scales. Compression is layered as it would be\n' +
    "at the HTTP layer: a single context for the whole response stream: this\n" +
    'matches what Content-Encoding: gzip/br/zstd does in vLLM and SGLang.\n',
);

if (!zstdCompressSync) {
  console.log('(zstd: not available in this Node: install Node 23+ for native zstd support.)\n');
}

interface Row {
  encoder: string;
  identity: number;
  gzip: number;
  br: number;
  zstd: number | null;
}

interface SweepSize {
  label: string;
  tokens: number;
}

const SWEEP: SweepSize[] = [
  { label: 'small',  tokens: 256 },
  { label: 'medium', tokens: 1024 },
  { label: 'large',  tokens: 8192 },
];

interface Sweep {
  size: SweepSize;
  rows: Row[];
}

const sweeps: Sweep[] = [];

for (const size of SWEEP) {
  const stream = makeStream(size.tokens, 1);
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
  sweeps.push({ size, rows });
}

for (const { size, rows } of sweeps) {
  console.log(`\n## ${size.label}: ${size.tokens.toLocaleString()} tokens, 1 per chunk\n`);
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
    const f = (n: number | null) => (n === null ? '   n/a' : (n / size.tokens).toFixed(2).padStart(6));
    console.log(`| ${r.encoder.padEnd(8)} | ${f(r.identity).padStart(8)} | ${f(r.gzip)} | ${f(r.br)} | ${f(r.zstd)} |`);
  }
}

// ── Cross-size scaling table ───────────────────────────────────────────────
// The headline question: does each (encoder × compression) combo get *better*
// at scale? Show vs-baseline ratio for every cell at every size, side by side.

console.log('\n## Scaling: reduction vs JSON-SSE identity, across sizes\n');
const cols = SWEEP.map((s) => s.label).join(' | ');
const header = `| configuration            | ${cols} |`;
const sep = '|--------------------------|' + SWEEP.map(() => '-----------:').join('|') + '|';
console.log(header);
console.log(sep);

const baselines = new Map<string, number>(
  sweeps.map((s) => [s.size.label, s.rows.find((r) => r.encoder === 'json-sse')!.identity]),
);

const ENCODERS = ['json-sse', 'msgpack', 'protobuf'] as const;
const VARIANTS: { suffix: string; key: keyof Row }[] = [
  { suffix: '',         key: 'identity' },
  { suffix: ' + gzip',  key: 'gzip' },
  { suffix: ' + br',    key: 'br' },
  { suffix: ' + zstd',  key: 'zstd' },
];

for (const enc of ENCODERS) {
  for (const v of VARIANTS) {
    const row: string[] = [];
    let printable = true;
    for (const sw of sweeps) {
      const r = sw.rows.find((x) => x.encoder === enc)!;
      const bytes = r[v.key] as number | null;
      const baseline = baselines.get(sw.size.label)!;
      if (bytes === null) {
        row.push('   n/a    ');
        if (v.key === 'zstd') printable = !!zstdCompressSync;
      } else {
        row.push((`${(baseline / bytes).toFixed(1)}\xd7`).padStart(10));
      }
    }
    if (!printable && v.key === 'zstd') continue;
    console.log(`| ${(enc + v.suffix).padEnd(24)} | ${row.join(' | ')} |`);
  }
}

console.log(
  '\nReading the scaling table:\n' +
    '  - If a row\'s ratio *grows* from small to large, that combo gets relatively\n' +
    '    better with more tokens (compressor amortises framing/header overhead).\n' +
    '  - If a row\'s ratio is *flat*, the stream is already near the entropy floor\n' +
    '    for that encoder: more bytes won\'t help.\n' +
    '  - JSON-SSE+compression has a structural advantage from repeated keys ("data:",\n' +
    '    "id":, etc.). Codec frames are denser, so absolute ratios are smaller :\n' +
    '    but the *bytes/token* number is what hits the wire.\n' +
    '  - zstd dictionaries pre-train on typical token sequences and push Codec\n' +
    '    further at every size: measured 16 to 18% beyond no-dict zstd overall, and\n' +
    '    36 to 38% on small streams, at a streaming-TTFB cost of only +0.13 ms. See\n' +
    '    packages/bench/src/compression-dict.ts and RESULTS.md §1g for the\n' +
    '    dict-zstd bench (run: `npm run compression:dict`).',
);
