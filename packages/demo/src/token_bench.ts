/**
 * Per-language tokenize/detokenize micro-benchmark — TypeScript / Node.
 *
 * Cross-language companion of `codec_demo.token_bench` (Python),
 * `demo-rust/src/bin/token_bench.rs`, etc. See the Python file's
 * top-of-file docstring for the output schema and rationale.
 *
 * Usage:
 *   npx tsx src/token_bench.ts \\
 *     --map ../../codec-maps/maps/qwen/qwen2.json \\
 *     --corpus ../bench/golden/qwen2.json \\
 *     --reps 200 \\
 *     --out ../bench/results/<run-id>/token/web.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { argv, exit } from 'node:process';

import { BPETokenizer, Detokenizer, type TokenizerMap, validateMap } from '@codecai/web';

interface Args {
  mapPath: string;
  corpusPath: string;
  reps: number;
  warmup: number;
  outPath: string;
}

function parseArgs(): Args {
  const args = argv.slice(2);
  const get = (key: string, required = true): string | undefined => {
    const i = args.findIndex((a) => a === `--${key}`);
    if (i < 0 || i === args.length - 1) {
      if (required) {
        console.error(`missing --${key}`);
        exit(2);
      }
      return undefined;
    }
    return args[i + 1];
  };
  return {
    mapPath: get('map')!,
    corpusPath: get('corpus')!,
    reps: parseInt(get('reps', false) ?? '200', 10),
    warmup: parseInt(get('warmup', false) ?? '20', 10),
    outPath: get('out')!,
  };
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round((pct / 100) * (sorted.length - 1))),
  );
  return sorted[idx]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function sha256(bytes: Buffer): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function libVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, '../../web/package.json'),
        'utf-8',
      ),
    );
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function main(): number {
  const args = parseArgs();

  const mapBytes = fs.readFileSync(args.mapPath);
  const mapJson = JSON.parse(mapBytes.toString('utf-8')) as unknown;
  validateMap(mapJson);
  const map = mapJson as TokenizerMap;

  const corpusBytes = fs.readFileSync(args.corpusPath);
  const corpus = JSON.parse(corpusBytes.toString('utf-8')) as {
    samples: { text: string; ids: number[] }[];
  };
  if (!corpus.samples?.length) {
    console.error(`corpus ${args.corpusPath!} has no samples`);
    return 1;
  }

  const tok = new BPETokenizer(map);
  const detok = new Detokenizer(map);

  const texts = corpus.samples.map((s) => s.text);
  const refIds = corpus.samples.map((s) => s.ids.slice());
  const totalTextBytes = texts.reduce(
    (acc, t) => acc + Buffer.byteLength(t, 'utf-8'),
    0,
  );
  const totalTokens = refIds.reduce((acc, ids) => acc + ids.length, 0);

  // Warmup
  for (let r = 0; r < args.warmup; r++) {
    for (const t of texts) tok.encode(t);
    for (const ids of refIds) detok.render(ids);
  }

  const encodeMs: number[] = [];
  const decodeMs: number[] = [];
  for (let r = 0; r < args.reps; r++) {
    const t0 = performance.now();
    for (const t of texts) tok.encode(t);
    encodeMs.push(performance.now() - t0);

    const t1 = performance.now();
    for (const ids of refIds) detok.render(ids);
    decodeMs.push(performance.now() - t1);
  }

  const encodeMed = median(encodeMs);
  const decodeMed = median(decodeMs);

  const result = {
    schema_version: '1',
    kind: 'token_bench',
    captured_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    client: {
      lang: 'typescript',
      lib_name: '@codecai/web',
      lib_version: libVersion(),
      runtime: `Node.js ${process.version}`,
    },
    map: {
      id: map.id,
      vocab_size: map.vocab_size,
      sha256: sha256(mapBytes),
    },
    corpus: {
      path: args.corpusPath,
      sha256: sha256(corpusBytes),
      samples: corpus.samples.length,
      total_text_bytes: totalTextBytes,
      total_tokens: totalTokens,
    },
    reps: args.reps,
    warmup_reps: args.warmup,
    encode_ms_total_median: encodeMed,
    encode_ms_total_p99: percentile(encodeMs, 99),
    decode_ms_total_median: decodeMed,
    decode_ms_total_p99: percentile(decodeMs, 99),
    encode_tokens_per_sec: encodeMed > 0 ? (totalTokens / encodeMed) * 1000 : null,
    decode_tokens_per_sec: decodeMed > 0 ? (totalTokens / decodeMed) * 1000 : null,
  };

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, JSON.stringify(result, null, 2));

  const encStr = result.encode_tokens_per_sec?.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
  const decStr = result.decode_tokens_per_sec?.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
  console.error(
    `  web     encode=${encodeMed.toFixed(2).padStart(6)} ms (${encStr} tok/s)  ` +
      `decode=${decodeMed.toFixed(2).padStart(6)} ms (${decStr} tok/s)  → ${args.outPath}`,
  );
  return 0;
}

exit(main());
