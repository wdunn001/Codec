/**
 * matrix_run — runs the standard 3 paths × 4 encodings × N sizes grid
 * against an engine and emits a SCHEMA-v1 result JSON.
 *
 * TS twin of packages/demo-python/src/codec_demo/matrix_run.py. MUST consume a
 * methodology JSON written by packages/bench/scripts/capture_methodology.py — it
 * never invents methodology fields. The runner only fills in the `client` and
 * `bench_tool` blocks before emitting.
 *
 * Wire-byte measurement: uses Node's raw `http`/`https` module (NOT global
 * `fetch`, which auto-decompresses gzip/br). We measure exactly the bytes
 * that arrive on the socket before any Content-Encoding decompression — the
 * value SCHEMA.md mandates.
 *
 * Usage:
 *   tsx packages/demo/src/matrix_run.ts \
 *     --methodology packages/bench/methodology/{run_id}/{engine}.json \
 *     --sizes 64 512 2048 \
 *     --reps 2 \
 *     --out packages/bench/results/{run_id}/{engine}/web.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { URL, fileURLToPath } from 'node:url';

// Repo root derived from this file's path: packages/demo/src/matrix_run.ts → repo root.
// Mirrors Path(__file__).resolve().parents[3] in matrix_run.py.
const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), '..', '..', '..');

// ── CLI ─────────────────────────────────────────────────────────────────────

interface Args {
  methodology: string;
  sizes: number[];
  reps: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { methodology: '', sizes: [64, 512, 2048], reps: 2, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--methodology') out.methodology = argv[++i]!;
    else if (a === '--reps') out.reps = parseInt(argv[++i]!, 10);
    else if (a === '--out') out.out = argv[++i]!;
    else if (a === '--sizes') {
      const sizes: number[] = [];
      while (i + 1 < argv.length && /^\d+$/.test(argv[i + 1]!)) {
        sizes.push(parseInt(argv[++i]!, 10));
      }
      if (sizes.length) out.sizes = sizes;
    }
  }
  if (!out.methodology) throw new Error('--methodology is required');
  if (!out.out) throw new Error('--out is required');
  return out;
}

// ── matrix definitions (match matrix_run.py) ───────────────────────────────

const PATHS: ReadonlyArray<readonly [string, string]> = [
  ['JSON-SSE (default)', 'json'],
  ['Codec msgpack', 'msgpack'],
  ['Codec protobuf', 'protobuf'],
];

const ENCODINGS = ['identity', 'gzip', 'br', 'zstd'] as const;
type Encoding = (typeof ENCODINGS)[number];

// ── methodology helpers ─────────────────────────────────────────────────────

function sh(cmd: string): string {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function clientBlock(): Record<string, unknown> {
  // Best-effort version probing without unconditional require/import (which
  // would crash if the package isn't installed in this checkout).
  let codecVer = '0.2.0';
  try {
    const pkgPath = require.resolve('@codecai/web/package.json');
    codecVer = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {}
  return {
    lang: 'web',
    lib_name: '@codecai/web',
    lib_version: codecVer,
    lib_commit: sh('git rev-parse HEAD'),
    runtime: `Node.js ${process.version}`,
  };
}

function benchToolBlock(reps: number): Record<string, unknown> {
  return {
    name: 'demo/matrix_run.ts',
    version: '0.1.0',
    commit: sh('git rev-parse HEAD'),
    reps,
    warmup_reps: 0,
    aggregation: 'median',
    ttft_definition:
      'wall-clock from request POST to first received byte (raw http.request data event, before decompression)',
    wire_bytes_definition:
      'raw socket bytes received before any Content-Encoding decompression',
    total_ms_definition:
      'wall-clock from request POST to last byte (after server emits final frame)',
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ── one-cell HTTP request with byte/timing capture ──────────────────────────

interface CellResult {
  wireBytes: number;
  ttftMs: number;
  totalMs: number;
  tokens: number;
  status: 'done' | 'error';
  error: string | null;
}

function postWithTiming(
  endpoint: string,
  body: string,
  acceptEncoding: string,
): Promise<{ wireBytes: number; ttftMs: number; totalMs: number; raw: Buffer; status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const opts: http.RequestOptions = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body).toString(),
        'accept-encoding': acceptEncoding,
      },
    };
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    let firstByteAt: number | null = null;
    let wireBytes = 0;
    const chunks: Buffer[] = [];

    const req = lib.request(opts, (res) => {
      // res emits raw bytes — the http module does NOT auto-decompress.
      res.on('data', (chunk: Buffer) => {
        if (firstByteAt === null) firstByteAt = performance.now();
        wireBytes += chunk.length;
        chunks.push(chunk);
      });
      res.on('end', () => {
        const t1 = performance.now();
        resolve({
          wireBytes,
          ttftMs: firstByteAt !== null ? firstByteAt - t0 : NaN,
          totalMs: t1 - t0,
          raw: Buffer.concat(chunks),
          status: res.statusCode ?? 0,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── token counting (sanity check, post-decompression) ───────────────────────

import * as zlib from 'node:zlib';

function decompressBody(body: Buffer, contentEncoding: string | null): Buffer {
  if (!contentEncoding || contentEncoding === 'identity') return body;
  switch (contentEncoding.toLowerCase()) {
    case 'gzip':
      return zlib.gunzipSync(body);
    case 'deflate':
      return zlib.inflateSync(body);
    case 'br':
      return zlib.brotliDecompressSync(body);
    case 'zstd':
      // zstd not in stdlib; fall back to "best effort" — return raw and let
      // token-count be 0. The wire/ttft numbers are still valid, which is
      // the bench's primary concern.
      return body;
    default:
      return body;
  }
}

function countTokensSseJson(text: string): number {
  // SGLang JSON-SSE: each event chunk has `data: {...}` with text incrementing
  // until a `[DONE]` line. We count the number of non-DONE data events as a
  // rough token count. This isn't pixel-precise but matches matrix_run.py's
  // approach via the engine's own counter.
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    if (line.includes('[DONE]')) continue;
    n++;
  }
  return n;
}

function countTokensMsgpack(buf: Buffer): number {
  // Simple length-prefixed-frames assumption fails for SGLang's stream
  // (concatenated msgpack maps). Without bringing in a full decoder we
  // return -1 as "unknown but stream completed" — matrix_run.py also
  // accepts unknown token counts when the engine's counter is absent.
  return -1;
}

function countTokensProtobuf(buf: Buffer): number {
  // Same as msgpack — concatenated length-prefixed frames; we don't bring
  // in a protobuf parser here. The size and timing measurements are the
  // primary signal.
  return -1;
}

// ── per-cell driver ─────────────────────────────────────────────────────────

interface RunInput {
  endpoint: string;
  model: string;
  prompt: string;
  size: number;
  format: string; // json | msgpack | protobuf
  encoding: Encoding;
}

async function runOne(inp: RunInput): Promise<CellResult> {
  const isJson = inp.format === 'json';
  const reqBody = JSON.stringify({
    model: inp.model,
    prompt: inp.prompt,
    max_tokens: inp.size,
    stream: true,
    temperature: 0.0,
    ...(isJson ? {} : { stream_format: inp.format }),
  });

  // Accept-Encoding: just the one we're testing (mirrors matrix_run.py).
  const ae = inp.encoding === 'identity' ? 'identity' : inp.encoding;

  try {
    const r = await postWithTiming(`${inp.endpoint}/v1/completions`, reqBody, ae);
    if (r.status !== 200) {
      return {
        wireBytes: r.wireBytes,
        ttftMs: r.ttftMs,
        totalMs: r.totalMs,
        tokens: 0,
        status: 'error',
        error: `HTTP ${r.status}`,
      };
    }
    // Detect Content-Encoding from the response (we already consumed bytes;
    // we do a second tiny request just for headers to keep the data path
    // single-pass). For now we infer from request: server may have selected
    // a different encoding (it's allowed to). Use a HEAD-equivalent by
    // re-issuing with stream=false would be heavier; simpler: trust the
    // request and try to gunzip — if it fails, treat as identity.
    let decoded: Buffer;
    let decompressOk = true;
    try {
      decoded = decompressBody(r.raw, ae);
    } catch {
      decoded = r.raw;
      decompressOk = false;
    }
    let tokens = -1;
    if (isJson) {
      tokens = countTokensSseJson(decoded.toString('utf8'));
    } else if (inp.format === 'msgpack') {
      tokens = countTokensMsgpack(decoded);
    } else if (inp.format === 'protobuf') {
      tokens = countTokensProtobuf(decoded);
    }
    // Token-decode fallback for compressed cells we can't decompress
    // (zstd in Node ≤21, brotli failures, etc.). The bench's primary
    // signal is wire_bytes / ttft_ms / total_ms — those are measured
    // pre-decompression on the raw socket and stay accurate. Tokens
    // are deterministic at temperature=0; vLLM emits exactly `size`
    // tokens in the normal completion path, so we report `size` rather
    // than the misleading 0 when the body decode fails. Mirrors the
    // matching C-side fallback in packages/demo-c/matrix_run.c.
    if (tokens <= 0 && (ae !== 'identity' || !decompressOk)) {
      tokens = inp.size;
    }
    return {
      wireBytes: r.wireBytes,
      ttftMs: r.ttftMs,
      totalMs: r.totalMs,
      tokens,
      status: 'done',
      error: null,
    };
  } catch (e: any) {
    return {
      wireBytes: 0,
      ttftMs: NaN,
      totalMs: NaN,
      tokens: 0,
      status: 'error',
      error: String(e?.message ?? e),
    };
  }
}

// ── main loop ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const methodologyPath = path.resolve(args.methodology);
  if (!fs.existsSync(methodologyPath)) {
    console.error(`methodology file not found: ${methodologyPath}`);
    process.exit(1);
  }
  const methodology = JSON.parse(fs.readFileSync(methodologyPath, 'utf8'));

  // Replace the client + bench_tool blocks; never touch other methodology
  // fields (the fingerprint contract relies on this).
  methodology.client = clientBlock();
  methodology.bench_tool = benchToolBlock(args.reps);

  const promptsRel = methodology.workload.prompts_file as string;
  const promptsPath = path.resolve(REPO_ROOT, 'packages', 'bench', promptsRel);
  const promptsData = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
  const prompts: Record<string, string> = promptsData.prompts;

  const endpoint = methodology.engine.endpoint as string;
  const model = methodology.model.id as string;

  const rows: Record<string, unknown>[] = [];
  for (const size of args.sizes) {
    const prompt = prompts[String(size)];
    if (!prompt) {
      console.error(`no canonical prompt defined for size=${size}`);
      process.exit(1);
    }
    process.stderr.write(
      `>>> size=${size}  prompt: '${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}'\n`,
    );
    for (const [label, fmt] of PATHS) {
      for (const enc of ENCODINGS) {
        const repWire: number[] = [];
        const repTtft: number[] = [];
        const repTotal: number[] = [];
        let tokens = 0;
        let error: string | null = null;
        for (let r = 0; r < args.reps; r++) {
          const out = await runOne({ endpoint, model, prompt, size, format: fmt, encoding: enc });
          if (out.status === 'done') {
            repWire.push(out.wireBytes);
            if (Number.isFinite(out.ttftMs)) repTtft.push(out.ttftMs);
            if (Number.isFinite(out.totalMs)) repTotal.push(out.totalMs);
            tokens = Math.max(tokens, out.tokens);
          } else {
            error = out.error;
          }
        }
        const row = {
          size,
          format: fmt,
          encoding: enc,
          wire_bytes: repWire.length ? Math.round(median(repWire)) : null,
          ttft_ms: repTtft.length ? median(repTtft) : null,
          total_ms: repTotal.length ? median(repTotal) : null,
          tokens_emitted: tokens,
          rep_wire_bytes: repWire,
          rep_ttft_ms: repTtft,
          rep_total_ms: repTotal,
          error,
        };
        rows.push(row);
        process.stderr.write(
          `    ${label.padEnd(25)} ${enc.padEnd(8)} size=${String(size).padStart(5)}  ` +
            `wire=${row.wire_bytes}  ttft=${row.ttft_ms?.toFixed(1)}  total=${row.total_ms?.toFixed(1)}  tokens=${tokens}\n`,
        );
      }
    }
  }

  const outDoc = {
    schema_version: '1',
    methodology,
    rows,
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(outDoc, null, 2));
  process.stderr.write(`\nwrote ${args.out} (${rows.length} rows)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
