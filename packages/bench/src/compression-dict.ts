/**
 * compression-dict.ts: measure pre-trained zstd dictionary gain on real
 * (or synthetic) Codec frame streams.
 *
 * Sibling of compression.ts, but with two differences:
 *
 *   1. Input is a *corpus directory* of captured `.bin` files (the output
 *      of capture-codec-samples.py or synth-codec-samples.py), not a
 *      synthetic RNG stream. That's the only way to honestly measure the
 *      payoff of pre-training: the dict has to compress real-shaped traffic.
 *
 *   2. We bin samples into small / medium / large buckets and report mean
 *      bytes per bucket for each of: identity, gzip, no-dict zstd,
 *      with-dict zstd. The headline is the % reduction `with-dict zstd`
 *      gets over `no-dict zstd`: that's the value pre-training adds beyond
 *      what the wire format and shipped middleware already give you.
 *
 * Usage:
 *
 *   tsx packages/bench/src/compression-dict.ts \
 *       --corpus packages/bench/corpora/qwen2.5-synth/msgpack \
 *       --dict   dictionaries/qwen2.5-synth-msgpack-v1.dict \
 *       --label  msgpack-synthetic
 *
 *   # both formats in one go
 *   tsx packages/bench/src/compression-dict.ts \
 *       --corpus-root packages/bench/corpora/qwen2.5-synth \
 *       --dict-root   dictionaries \
 *       --tag         qwen2.5-synth \
 *       --version     v1
 *
 * Requires Node 23+ for native zstd. Tested on Node 25 (the dictionary
 * option lands as a top-level field on the zstdCompressSync options bag,
 * not inside `params`).
 */
import {
  gzipSync,
  brotliCompressSync,
  constants as zlibConstants,
} from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { hrtime } from 'node:process';

// ── Flags ──────────────────────────────────────────────────────────────────

interface Flags {
  corpus?: string;
  dict?: string;
  label?: string;
  corpusRoot?: string;
  dictRoot?: string;
  tag?: string;
  version?: string;
  formats: string[];
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const f: Flags = { formats: ['msgpack', 'protobuf'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    switch (a) {
      case '--corpus':       f.corpus = next(); break;
      case '--dict':         f.dict = next(); break;
      case '--label':        f.label = next(); break;
      case '--corpus-root':  f.corpusRoot = next(); break;
      case '--dict-root':    f.dictRoot = next(); break;
      case '--tag':          f.tag = next(); break;
      case '--version':      f.version = next(); break;
      case '--formats':      f.formats = next()!.split(','); break;
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: tsx compression-dict.ts \\\n' +
          '  --corpus <dir> --dict <file> [--label <name>]\\\n' +
          '  | --corpus-root <dir> --dict-root <dir> --tag <tag> [--version v1] [--formats msgpack,protobuf]\n'
        );
        process.exit(0);
    }
  }
  return f;
}

// ── Native zstd probe (Node 23+) ───────────────────────────────────────────

interface ZstdSyncOpts {
  dictionary?: Buffer;
  params?: Record<number, number>;
}
type ZstdSync = (input: Buffer, opts?: ZstdSyncOpts) => Buffer;

const zlibMod = await import('node:zlib');
const zstdCompressSync = (zlibMod as { zstdCompressSync?: ZstdSync }).zstdCompressSync;
const zstdDecompressSync = (zlibMod as { zstdDecompressSync?: ZstdSync }).zstdDecompressSync;

if (!zstdCompressSync || !zstdDecompressSync) {
  console.error('error: native zstd not available. Need Node 23+.');
  process.exit(1);
}

// Brotli at quality 4, matching compression.ts.
function brotli4(buf: Buffer): Buffer {
  return brotliCompressSync(buf, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
}

// ── Corpus loading ─────────────────────────────────────────────────────────

interface Sample {
  name: string;
  bytes: Buffer;
}

function loadCorpus(dir: string): Sample[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`corpus dir not found: ${dir}`);
  }
  const out: Sample[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.bin')) continue;
    out.push({ name, bytes: readFileSync(join(dir, name)) });
  }
  if (out.length === 0) throw new Error(`no .bin samples in ${dir}`);
  return out;
}

// ── Buckets ────────────────────────────────────────────────────────────────
//
// Bin by raw payload length so the table maps onto the small/medium/large
// labels readers already know from RESULTS.md §1b. Thresholds are byte counts
// at the median of those token-bucket sizes (msgpack-codec at ~3.5 B/token).

interface Bucket {
  label: string;
  // Inclusive lower bound, exclusive upper bound, in bytes of the raw frame.
  loBytes: number;
  hiBytes: number;
}

const BUCKETS: Bucket[] = [
  { label: 'small  (≤  300 B raw)', loBytes: 0,    hiBytes: 300 },
  { label: 'medium (≤ 2500 B raw)', loBytes: 300,  hiBytes: 2500 },
  { label: 'large  (>  2500 B)',    loBytes: 2500, hiBytes: Infinity },
];

function bucketFor(buf: Buffer): Bucket {
  for (const b of BUCKETS) {
    if (buf.length >= b.loBytes && buf.length < b.hiBytes) return b;
  }
  return BUCKETS[BUCKETS.length - 1]!;
}

// ── Timing helpers ─────────────────────────────────────────────────────────
//
// We report two timing flavours:
//
//   1. Encode latency (sync): how long zstdCompressSync takes to produce
//      the entire compressed buffer for one sample. This is the synchronous-
//      TTFB number: it's what the response's first byte is waiting on when
//      the middleware buffers the whole stream and finalises (the pattern
//      RESULTS.md §1d measured at 334× regression for shipped zstd).
//
//   2. Streaming TTFB: using createZstdCompress with chunked input + flush.
//      Time from the first input byte to the first output byte. Models the
//      streaming-zstd-with-periodic-flushes path that the middleware fix
//      will eventually use. Proves dict load itself doesn't add latency.
//
// All timings: median of REPS=5 runs. We do a small JIT warmup before
// measuring so v8 doesn't penalise the first sample.

const REPS = 5;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >>> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1e6;
}

function timeSyncCompress(
  fn: () => Buffer,
  reps: number = REPS,
): number {
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = hrtime.bigint();
    fn();
    samples.push(nsToMs(hrtime.bigint() - t0));
  }
  return median(samples);
}

// Streaming TTFB: feed `sample` to a fresh createZstdCompress in `chunkSize`
// chunks, calling `.flush()` after the first chunk. Return ms from when we
// pushed the first chunk to when the first output byte appeared.
async function timeStreamTtfb(
  sample: Buffer,
  dict: Buffer | null,
  chunkSize: number = 256,
  reps: number = REPS,
): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = await new Promise<number>((resolve, reject) => {
      const opts: Record<string, unknown> = {};
      if (dict) opts.dictionary = dict;
      const stream = (zlibMod as {
        createZstdCompress: (o?: Record<string, unknown>) => NodeJS.ReadWriteStream;
      }).createZstdCompress(opts);

      let firstByteAt: bigint | null = null;
      let pushedAt: bigint | null = null;
      stream.on('data', () => {
        if (firstByteAt === null) firstByteAt = hrtime.bigint();
      });
      stream.on('end', () => {
        if (firstByteAt === null || pushedAt === null) {
          reject(new Error('stream produced no output'));
          return;
        }
        resolve(nsToMs(firstByteAt - pushedAt));
      });
      stream.on('error', reject);

      // Push chunks. Flush after the first chunk to force at least one
      // output frame as early as possible: this is what a streaming
      // middleware does to preserve TTFB.
      let off = 0;
      const pushNext = () => {
        if (off >= sample.length) {
          stream.end();
          return;
        }
        const end = Math.min(off + chunkSize, sample.length);
        const slice = sample.subarray(off, end);
        if (off === 0) pushedAt = hrtime.bigint();
        const ok = stream.write(slice);
        off = end;
        // Flush after the first chunk so a streaming consumer can start
        // decompressing while we keep generating.
        if (off === Math.min(chunkSize, sample.length)) {
          (stream as unknown as { flush: (cb?: () => void) => void }).flush(() => {
            if (ok) setImmediate(pushNext);
          });
        } else if (ok) {
          setImmediate(pushNext);
        } else {
          stream.once('drain', pushNext);
        }
      };
      pushNext();
    });
    samples.push(t);
  }
  return median(samples);
}

// ── Per-sample measurement ─────────────────────────────────────────────────

interface Measurement {
  raw: number;
  gzip: number;
  br: number;
  zstd: number;
  zstdDict: number;
  // ms, median of REPS reps
  msGzip: number;
  msZstd: number;
  msZstdDict: number;
  bucket: Bucket;
}

function measureOne(sample: Buffer, dict: Buffer): Measurement {
  // JIT warmup once per sample so the first rep doesn't dominate the median.
  zstdCompressSync!(sample);
  zstdCompressSync!(sample, { dictionary: dict });
  gzipSync(sample, { level: 6 });

  const raw = sample.length;
  const gzipBuf = gzipSync(sample, { level: 6 });
  const br = brotli4(sample).length;
  const zstdBuf = zstdCompressSync!(sample);
  const dictBuf = zstdCompressSync!(sample, { dictionary: dict });

  // Round-trip check: refuse to publish numbers from a broken pipeline.
  const back = zstdDecompressSync!(dictBuf, { dictionary: dict });
  if (!back.equals(sample)) {
    throw new Error('zstd dict round-trip mismatch: refusing to report');
  }

  // Now timing (median of REPS).
  const msGzip = timeSyncCompress(() => gzipSync(sample, { level: 6 }));
  const msZstd = timeSyncCompress(() => zstdCompressSync!(sample));
  const msZstdDict = timeSyncCompress(() => zstdCompressSync!(sample, { dictionary: dict }));

  return {
    raw,
    gzip: gzipBuf.length,
    br,
    zstd: zstdBuf.length,
    zstdDict: dictBuf.length,
    msGzip,
    msZstd,
    msZstdDict,
    bucket: bucketFor(sample),
  };
}

// ── Aggregation + rendering ────────────────────────────────────────────────

interface BucketAgg {
  bucket: Bucket;
  n: number;
  sumRaw: number;
  sumGzip: number;
  sumBr: number;
  sumZstd: number;
  sumZstdDict: number;
  // ms sums
  sumMsGzip: number;
  sumMsZstd: number;
  sumMsZstdDict: number;
}

function emptyAgg(b: Bucket): BucketAgg {
  return {
    bucket: b, n: 0, sumRaw: 0, sumGzip: 0, sumBr: 0, sumZstd: 0, sumZstdDict: 0,
    sumMsGzip: 0, sumMsZstd: 0, sumMsZstdDict: 0,
  };
}

function fmtMean(sum: number, n: number): string {
  if (n === 0) return ': ';
  const m = sum / n;
  if (m < 1024) return `${m.toFixed(0)} B`;
  return `${(m / 1024).toFixed(1)} KB`;
}

function fmtMs(sum: number, n: number): string {
  if (n === 0) return ': ';
  const m = sum / n;
  if (m < 0.01) return `<0.01 ms`;
  return `${m.toFixed(2)} ms`;
}

function pct(numer: number, denom: number): string {
  if (denom === 0) return ': ';
  return `${((1 - numer / denom) * 100).toFixed(1)}%`;
}

function diffMs(numerSum: number, denomSum: number, n: number): string {
  if (n === 0) return ': ';
  const d = (numerSum - denomSum) / n;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(2)} ms`;
}

function renderTable(label: string, aggs: BucketAgg[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`### ${label}`);
  lines.push('');
  lines.push('**Bytes**: mean compressed size per bucket');
  lines.push('');
  lines.push('| bucket | n | raw | gzip | no-dict zstd | **with-dict zstd** | dict gain vs zstd |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const a of aggs) {
    if (a.n === 0) {
      lines.push(`| ${a.bucket.label} | 0 | n/a | | n/a | | n/a |`);
      continue;
    }
    const dictGain = pct(a.sumZstdDict, a.sumZstd);
    lines.push(
      `| ${a.bucket.label} | ${a.n} | ${fmtMean(a.sumRaw, a.n)} | ` +
      `${fmtMean(a.sumGzip, a.n)} | ${fmtMean(a.sumZstd, a.n)} | ` +
      `**${fmtMean(a.sumZstdDict, a.n)}** | ${dictGain} |`,
    );
  }
  const tot = aggs.reduce<BucketAgg>(
    (acc, a) => ({
      bucket: { label: 'all', loBytes: 0, hiBytes: 0 },
      n: acc.n + a.n,
      sumRaw: acc.sumRaw + a.sumRaw,
      sumGzip: acc.sumGzip + a.sumGzip,
      sumBr: acc.sumBr + a.sumBr,
      sumZstd: acc.sumZstd + a.sumZstd,
      sumZstdDict: acc.sumZstdDict + a.sumZstdDict,
      sumMsGzip: acc.sumMsGzip + a.sumMsGzip,
      sumMsZstd: acc.sumMsZstd + a.sumMsZstd,
      sumMsZstdDict: acc.sumMsZstdDict + a.sumMsZstdDict,
    }),
    emptyAgg({ label: 'all', loBytes: 0, hiBytes: 0 }),
  );
  if (tot.n > 0) {
    lines.push(
      `| **all** | **${tot.n}** | ${fmtMean(tot.sumRaw, tot.n)} | ` +
      `${fmtMean(tot.sumGzip, tot.n)} | ${fmtMean(tot.sumZstd, tot.n)} | ` +
      `**${fmtMean(tot.sumZstdDict, tot.n)}** | **${pct(tot.sumZstdDict, tot.sumZstd)}** |`,
    );
  }

  lines.push('');
  lines.push('**Encode latency (sync TTFB)**: median wall-clock per sample, 5 reps each');
  lines.push('');
  lines.push('| bucket | n | gzip | no-dict zstd | with-dict zstd | dict overhead vs no-dict |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const a of aggs) {
    if (a.n === 0) {
      lines.push(`| ${a.bucket.label} | 0 | n/a | | n/a | |`);
      continue;
    }
    lines.push(
      `| ${a.bucket.label} | ${a.n} | ${fmtMs(a.sumMsGzip, a.n)} | ` +
      `${fmtMs(a.sumMsZstd, a.n)} | ${fmtMs(a.sumMsZstdDict, a.n)} | ` +
      `${diffMs(a.sumMsZstdDict, a.sumMsZstd, a.n)} |`,
    );
  }
  if (tot.n > 0) {
    lines.push(
      `| **all** | **${tot.n}** | ${fmtMs(tot.sumMsGzip, tot.n)} | ` +
      `${fmtMs(tot.sumMsZstd, tot.n)} | ${fmtMs(tot.sumMsZstdDict, tot.n)} | ` +
      `**${diffMs(tot.sumMsZstdDict, tot.sumMsZstd, tot.n)}** |`,
    );
  }
  return lines.join('\n');
}

interface StreamingTtfbAgg {
  n: number;
  sumNoDict: number;
  sumWithDict: number;
}

async function measureStreamingTtfb(
  samples: Sample[],
  dict: Buffer,
  maxSamples: number = 24,
): Promise<StreamingTtfbAgg> {
  // 24 samples × 5 reps = 120 stream lifecycles per format. Enough for a
  // stable median; keeps the bench under a couple seconds.
  const picks: Buffer[] = [];
  // Stratified pick: equal counts from each bucket where possible.
  const byBucket = new Map<string, Sample[]>();
  for (const s of samples) {
    const b = bucketFor(s.bytes).label;
    const arr = byBucket.get(b) ?? [];
    arr.push(s);
    byBucket.set(b, arr);
  }
  const perBucket = Math.max(1, Math.floor(maxSamples / byBucket.size));
  for (const arr of byBucket.values()) {
    for (let i = 0; i < arr.length && picks.length < maxSamples; i += Math.max(1, Math.floor(arr.length / perBucket))) {
      picks.push(arr[i]!.bytes);
    }
  }

  const agg: StreamingTtfbAgg = { n: 0, sumNoDict: 0, sumWithDict: 0 };
  for (const buf of picks) {
    // warm
    await timeStreamTtfb(buf, null, 256, 1);
    await timeStreamTtfb(buf, dict, 256, 1);
    const noDict = await timeStreamTtfb(buf, null);
    const withDict = await timeStreamTtfb(buf, dict);
    agg.n += 1;
    agg.sumNoDict += noDict;
    agg.sumWithDict += withDict;
  }
  return agg;
}

function renderStreamingTtfb(label: string, agg: StreamingTtfbAgg): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`**Streaming TTFB**: ${label}: time from first input chunk to first compressed byte (256 B chunks, flush after first chunk; median over ${REPS} reps × ${agg.n} samples)`);
  lines.push('');
  lines.push('| pipeline | mean TTFB | overhead |');
  lines.push('|---|---:|---:|');
  if (agg.n > 0) {
    const noDict = agg.sumNoDict / agg.n;
    const withDict = agg.sumWithDict / agg.n;
    const delta = withDict - noDict;
    const sign = delta >= 0 ? '+' : '';
    lines.push(`| no-dict zstd (streaming) | ${noDict.toFixed(2)} ms | (baseline) |`);
    lines.push(`| with-dict zstd (streaming) | ${withDict.toFixed(2)} ms | ${sign}${delta.toFixed(2)} ms |`);
  }
  return lines.join('\n');
}

async function runOne(label: string, corpusDir: string, dictPath: string): Promise<string> {
  const samples = loadCorpus(corpusDir);
  const dict = readFileSync(dictPath);
  const aggs: BucketAgg[] = BUCKETS.map(emptyAgg);
  for (const s of samples) {
    const m = measureOne(s.bytes, dict);
    const a = aggs.find((x) => x.bucket.label === m.bucket.label)!;
    a.n += 1;
    a.sumRaw += m.raw;
    a.sumGzip += m.gzip;
    a.sumBr += m.br;
    a.sumZstd += m.zstd;
    a.sumZstdDict += m.zstdDict;
    a.sumMsGzip += m.msGzip;
    a.sumMsZstd += m.msZstd;
    a.sumMsZstdDict += m.msZstdDict;
  }
  const tableOut = renderTable(label, aggs);
  const ttfbAgg = await measureStreamingTtfb(samples, dict);
  const streamOut = renderStreamingTtfb(label, ttfbAgg);
  return tableOut + '\n' + streamOut;
}

// ── Driver ─────────────────────────────────────────────────────────────────

const flags = parseFlags();

console.log('# Pre-trained ZSTD dictionary bench\n');
console.log(
  'Each row aggregates real (captured) or synthesised CodecFrame streams\n' +
  'binned by raw byte size, and reports mean compressed length under each\n' +
  'algorithm. The headline number is the rightmost column: how much smaller\n' +
  'a stream gets when zstd loads the pre-trained dictionary at the start of\n' +
  'the response, vs zstd starting cold. Round-trip is verified per sample :\n' +
  'a mismatch aborts the run.',
);

const tables: string[] = [];

async function main(): Promise<void> {
  const tables: string[] = [];
  if (flags.corpus && flags.dict) {
    const label = flags.label ?? `${basename(flags.corpus)} (dict=${basename(flags.dict)})`;
    tables.push(await runOne(label, flags.corpus, flags.dict));
  } else if (flags.corpusRoot && flags.dictRoot && flags.tag) {
    const ver = flags.version ?? 'v1';
    for (const fmt of flags.formats) {
      const corpusDir = join(flags.corpusRoot, fmt);
      const dictPath = join(flags.dictRoot, `${flags.tag}-${fmt}-${ver}.dict`);
      if (!statSync(corpusDir, { throwIfNoEntry: false })?.isDirectory()) {
        console.error(`  (skipping ${fmt}: ${corpusDir} not found)`);
        continue;
      }
      if (!statSync(dictPath, { throwIfNoEntry: false })?.isFile()) {
        console.error(`  (skipping ${fmt}: ${dictPath} not found: train it first)`);
        continue;
      }
      tables.push(await runOne(`${flags.tag} · ${fmt}`, corpusDir, dictPath));
    }
  } else {
    console.error(
      'error: pass --corpus + --dict (single run) or --corpus-root + --dict-root + --tag (sweep).',
    );
    process.exit(2);
  }

  for (const t of tables) console.log(t);
  console.log('');
}

await main();
