/**
 * latent-live.ts: measure Codec latent-modality wire cost against a live
 * latent-stream server (codec-comfyui or codec-diffusers).
 *
 * Twin of mcp-live.ts for the v0.3 latent modality. Same structure (per-
 * variant matrix → raw socket bytes → SCHEMA-v1 result row), different
 * dimensions:
 *
 *   variants:   format (msgpack | protobuf) × encoding (identity | gzip | zstd)
 *   pipelines:  raw | int8 | int4 | int8-adaptive | int4-adaptive | delta+int8 | delta+int4
 *               (per the latent-space-map's `pipelines[]` list)
 *   fixtures:   from methodology/latent-fixtures.json
 *
 * For text-modality MCP work the variant axis is what we want to compare.
 * For latents, the bigger axis is *pipeline*: the bench's job is to
 * produce the rate-distortion curve (wire bytes vs SSIM) every classical
 * video codec publishes. The same harness records `ttff_ms` (time to first
 * frame), decoder cost (when a decoder is loaded), and perceptual quality
 * (SSIM / PSNR / LPIPS) per cell.
 *
 * Auth + endpoint:
 *
 *   BENCH_LATENT_URL=http://192.168.1.88:8080/v1/images/generations \
 *   BENCH_LATENT_SPACE=stabilityai/sd-vae-ft-mse \
 *   BENCH_LATENT_MAP_URL=https://… \
 *   BENCH_LATENT_MAP_HASH=sha256:… \
 *   tsx packages/bench/src/latent-live.ts
 *
 * Notes on what this DOES and DOES NOT measure today:
 * - DOES: wire_bytes (raw socket bytes received before any
 *   Content-Encoding decompression), ttff_ms (first body chunk arrival:
 *   approximation of "first LatentFrame" since the HTTP server typically
 *   emits header+first-frame in a single TCP segment), total_ms (last
 *   byte). codec_latent_map + codec_zstd_dict header echoes.
 * - DOES NOT (deferred to a sibling perceptual pass): decoder cost
 *   (decode_cold_ms / decode_steady_ms), perceptual quality (ssim /
 *   psnr / lpips). Those need a loaded decoder + golden reference and
 *   live behind `latent-perceptual.ts` which runs against the same
 *   fixtures + pipelines.
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

import { decode as msgpackDecode } from '@msgpack/msgpack';

import { fmtBytes, fmtNs, fmtNum, hr, ratio, table } from './lib/format.js';

// ── Config ────────────────────────────────────────────────────────────────────

const LATENT_URL =
  process.env.BENCH_LATENT_URL ??
  'http://192.168.1.88:8080/v1/images/generations';
const LATENT_SPACE =
  process.env.BENCH_LATENT_SPACE ?? 'stabilityai/sd-vae-ft-mse';
const MAP_URL  = process.env.BENCH_LATENT_MAP_URL  ?? '';
const MAP_HASH = process.env.BENCH_LATENT_MAP_HASH ?? '';
const REPS = Number.parseInt(process.env.BENCH_LATENT_REPS ?? '2', 10);
const FIXTURE_FILTER = (process.env.BENCH_LATENT_FIXTURES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STAMP = new Date().toISOString().replace(/:/g, '-').slice(0, 19) + 'Z';
const OUT_DIR =
  process.env.BENCH_LATENT_OUT_DIR ??
  join(REPO_ROOT, 'packages', 'bench', 'results', STAMP, 'latent');

// ── Variant matrix ──────────────────────────────────────────────────────────

type WireFormat = 'msgpack' | 'protobuf';
type Encoding   = 'identity' | 'gzip' | 'zstd';
type Pipeline   =
  | 'raw' | 'int8' | 'int4'
  | 'int8-adaptive' | 'int4-adaptive'
  | 'delta+int8' | 'delta+int4';

interface VariantSpec {
  format:   WireFormat;
  encoding: Encoding;
  pipeline: Pipeline;
}

/**
 * Default sweep. Phase 6 will narrow this for image-only fixtures (drop the
 * `delta+*` rows) and for fp16-only servers (drop `int4*`). The matrix
 * here is the upper-bound shape every cell row in the result file must
 * conform to.
 */
const DEFAULT_VARIANTS: VariantSpec[] = [
  // Format defaults to msgpack: matches what the engines actually serve in v0.3.
  { format: 'msgpack', encoding: 'identity', pipeline: 'raw' },
  { format: 'msgpack', encoding: 'identity', pipeline: 'int8' },
  { format: 'msgpack', encoding: 'identity', pipeline: 'int4' },
  { format: 'msgpack', encoding: 'identity', pipeline: 'int8-adaptive' },
  { format: 'msgpack', encoding: 'identity', pipeline: 'int4-adaptive' },
  // Compression on top of int8: the production-shape lane that carries
  // the headline wire-byte reduction for static images.
  { format: 'msgpack', encoding: 'gzip', pipeline: 'int8' },
  { format: 'msgpack', encoding: 'zstd', pipeline: 'int8' },
  // Video-only delta variants: fixture filter narrows to video-* keys.
  { format: 'msgpack', encoding: 'zstd', pipeline: 'delta+int8' },
  { format: 'msgpack', encoding: 'zstd', pipeline: 'delta+int4' },
];

interface FixtureSpec {
  key:          string;       // "256" | "512" | "1024" | "video-1s" | …
  kind:         'image' | 'video';
  resolution:   number;
  latent_shape: number[];
  fps?:         number;
  frames?:      number;
  seed:         number;
  prompt:       string;
  steps:        number;
}

function loadFixtures(): FixtureSpec[] {
  const path = join(REPO_ROOT, 'packages/bench/methodology/latent-fixtures.json');
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    fixtures: Record<string, Omit<FixtureSpec, 'key'>>;
  };
  let all = Object.entries(json.fixtures).map(([key, spec]) => ({ key, ...spec }));
  if (FIXTURE_FILTER.length > 0) {
    all = all.filter((f) => FIXTURE_FILTER.includes(f.key));
  }
  return all;
}

function isApplicable(variant: VariantSpec, fixture: FixtureSpec): boolean {
  // delta+* pipelines are video-only. Spec/PIPELINES.md §"Negotiation".
  if (variant.pipeline.startsWith('delta+') && fixture.kind === 'image') return false;
  return true;
}

// ── Cell row shape (matches SCHEMA.md §"Latent modality" rows) ──────────────

interface LatentCell {
  size:               string;       // fixture key
  kind:               'image' | 'video';
  format:             WireFormat;
  encoding:           Encoding;
  pipeline:           Pipeline;
  wire_bytes:         number | null;
  ttff_ms:            number | null;
  total_ms:           number | null;
  frames_emitted:     number | null;
  rep_wire_bytes:     number[];
  rep_ttff_ms:        number[];
  rep_total_ms:       number[];
  // Decoder cost: populated by a sibling perceptual pass when a decoder
  // is loaded; null on parse-only cells (this harness).
  decode_cold_ms:     number | null;
  decode_steady_ms:   number | null;
  decode_peak_mem_mb: number | null;
  // Perceptual quality vs the golden-builder reference: populated by
  // the sibling perceptual pass.
  ssim:               number | null;
  psnr:               number | null;
  lpips:              number | null;
  vmaf:               number | null;
  temporal_ssim:      number | null;
  // Negotiation header echoes: see SCHEMA.md §"Negotiation headers".
  codec_tokenizer_map: string | null;     // null on latent cells
  codec_latent_map:    string | null;
  codec_zstd_dict:     string | null;
  error:              string | null;
}

// ── Request builder ─────────────────────────────────────────────────────────

interface RequestSpec {
  url:     string;
  body:    Buffer;
  headers: Record<string, string>;
}

function buildRequest(variant: VariantSpec, fixture: FixtureSpec): RequestSpec {
  const acceptCodec =
    variant.format === 'msgpack'
      ? 'application/x-codec-msgpack'
      : 'application/x-codec-protobuf';
  const acceptEncoding =
    variant.encoding === 'identity' ? '' : variant.encoding;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: acceptCodec,
  };
  if (acceptEncoding) headers['Accept-Encoding'] = acceptEncoding;
  if (MAP_URL && MAP_HASH) {
    headers['X-Codec-Map'] = `${MAP_URL};sha256=${MAP_HASH.replace(/^sha256:/, '')}`;
  }

  const body = Buffer.from(
    JSON.stringify({
      model: fixture.kind === 'image' ? 'sd1.5' : 'svd',
      prompt: fixture.prompt,
      stream_format: variant.format,
      modality: fixture.kind === 'image' ? 'image-latents' : 'video-latents',
      latent_space: LATENT_SPACE,
      pipeline: variant.pipeline,
      size: `${fixture.resolution}x${fixture.resolution}`,
      steps: fixture.steps,
      seed: fixture.seed,
      ...(fixture.kind === 'video'
        ? { fps: fixture.fps, duration_seconds: (fixture.frames ?? 0) / (fixture.fps ?? 1) }
        : {}),
    }),
    'utf8',
  );

  return { url: LATENT_URL, body, headers };
}

// ── Raw-socket measured response ────────────────────────────────────────────
// Mirrors src/mcp-live.ts's send(): same headers-byte reconstruction trick,
// same gzip/br decompression after the count is taken. Adds ttff_ms (first
// body chunk arrival) which for the latent stream approximates the time to
// first LatentFrame: the typical engine emits the LatentStreamHeader and
// the first LatentFrame in the same TCP segment, so first-body-chunk and
// first-LatentFrame coincide on every server we've measured.

interface MeasuredResponse {
  status: number;
  wireBytes: number;
  bodyDecoded: Buffer;
  contentType: string;
  contentEncoding: string;
  ttfbMs: number;       // first response header byte
  ttffMs: number;       // first response body chunk
  totalMs: number;      // last byte
  headers: Record<string, string>;
}

function send(req: RequestSpec): Promise<MeasuredResponse> {
  const u = new URL(req.url);
  const lib = u.protocol === 'https:' ? https : http;
  const t0 = performance.now();
  return new Promise((resolveP, rejectP) => {
    const r = lib.request(
      {
        method: 'POST',
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { ...req.headers, 'Content-Length': String(req.body.length) },
      },
      (res) => {
        const ttfbMs = performance.now() - t0;
        let ttffMs = -1;
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        res.on('data', (c: Buffer) => {
          if (ttffMs < 0) ttffMs = performance.now() - t0;
          chunks.push(c);
          bodyBytes += c.byteLength;
        });
        res.on('end', () => {
          const totalMs = performance.now() - t0;
          const statusLine = `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}\r\n`;
          let headerBytes = Buffer.byteLength(statusLine, 'utf8');
          const lower: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            const value = Array.isArray(v) ? v.join(', ') : (v ?? '');
            headerBytes += Buffer.byteLength(`${k}: ${value}\r\n`, 'utf8');
            lower[k.toLowerCase()] = String(value);
          }
          headerBytes += 2;
          const wireBytes = headerBytes + bodyBytes;
          const raw = Buffer.concat(chunks);
          const enc = lower['content-encoding'] ?? '';
          let bodyDecoded = raw;
          try {
            if (enc.includes('gzip')) bodyDecoded = gunzipSync(raw);
            else if (enc.includes('br')) bodyDecoded = brotliDecompressSync(raw);
            // zstd: Node 22+ has zlib.zstdDecompressSync; we leave it raw if
            // unavailable (the wire-bytes count is what we care about: the
            // body parse is best-effort for sanity).
          } catch {
            /* leave raw */
          }
          resolveP({
            status: res.statusCode ?? 0,
            wireBytes,
            bodyDecoded,
            contentType: lower['content-type'] ?? '',
            contentEncoding: enc,
            ttfbMs,
            ttffMs: ttffMs >= 0 ? ttffMs : totalMs,
            totalMs,
            headers: lower,
          });
        });
        res.on('error', rejectP);
      },
    );
    r.on('error', rejectP);
    r.write(req.body);
    r.end();
  });
}

// ── Codec frame body parser (count frames, surface header) ──────────────────

interface ParsedBody {
  /** Number of frames in the body: first is the LatentStreamHeader. */
  frameCount: number;
  /** Number of LatentFrames after the header (frameCount - 1). */
  framesEmitted: number;
}

function parseCodecLatentBody(buf: Buffer): ParsedBody {
  let pos = 0;
  let frameCount = 0;
  // Codec wire is `[len:4 BE][msgpack body]…` repeated.
  while (pos + 4 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    pos += 4;
    if (pos + len > buf.length) break;
    const slice = buf.subarray(pos, pos + len);
    pos += len;
    try {
      msgpackDecode(slice);
      frameCount++;
    } catch {
      // skip malformed frame; ttff_ms still reflects when bytes arrived
    }
  }
  return { frameCount, framesEmitted: Math.max(0, frameCount - 1) };
}

// ── runOneCell ──────────────────────────────────────────────────────────────

async function runOneCell(
  variant: VariantSpec,
  fixture: FixtureSpec,
): Promise<LatentCell> {
  const repWire: number[] = [];
  const repTtff: number[] = [];
  const repTotal: number[] = [];
  let lastBody: ParsedBody | null = null;
  let lastResp: MeasuredResponse | null = null;
  let firstError: string | null = null;

  for (let r = 0; r < REPS; r++) {
    try {
      const req = buildRequest(variant, fixture);
      const resp = await send(req);
      if (resp.status < 200 || resp.status >= 300) {
        firstError ??= `HTTP ${resp.status}: ${resp.bodyDecoded.toString('utf8').slice(0, 200)}`;
        continue;
      }
      const parsed = parseCodecLatentBody(resp.bodyDecoded);
      repWire.push(resp.wireBytes);
      repTtff.push(resp.ttffMs);
      repTotal.push(resp.totalMs);
      lastBody = parsed;
      lastResp = resp;
    } catch (e) {
      firstError ??= (e as Error).message;
    }
  }

  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  };

  return {
    size: fixture.key,
    kind: fixture.kind,
    format: variant.format,
    encoding: variant.encoding,
    pipeline: variant.pipeline,
    wire_bytes: median(repWire),
    ttff_ms:    median(repTtff),
    total_ms:   median(repTotal),
    frames_emitted: lastBody?.framesEmitted ?? null,
    rep_wire_bytes: repWire,
    rep_ttff_ms:    repTtff,
    rep_total_ms:   repTotal,
    decode_cold_ms:     null,
    decode_steady_ms:   null,
    decode_peak_mem_mb: null,
    ssim:               null,
    psnr:               null,
    lpips:              null,
    vmaf:               null,
    temporal_ssim:      null,
    codec_tokenizer_map: null,
    codec_latent_map:   lastResp?.headers['codec-latent-map'] ?? null,
    codec_zstd_dict:    lastResp?.headers['codec-zstd-dict'] ?? null,
    error: repWire.length === 0 ? firstError : null,
  };
}

// ── Output writers ──────────────────────────────────────────────────────────

function summaryRows(cells: LatentCell[]): { headers: string[]; rows: string[][] } {
  const headers = [
    'fixture', 'kind', 'pipeline', 'fmt', 'enc',
    'wire_bytes', 'ttff_ms', 'total_ms', 'frames', 'error?',
  ];
  const rows = cells.map((c) => [
    c.size,
    c.kind,
    c.pipeline,
    c.format,
    c.encoding,
    c.wire_bytes !== null ? fmtBytes(c.wire_bytes) : 'n/a',
    c.ttff_ms    !== null ? fmtNum(c.ttff_ms, 1) + ' ms' : 'n/a',
    c.total_ms   !== null ? fmtNum(c.total_ms, 0) + ' ms' : 'n/a',
    c.frames_emitted !== null ? String(c.frames_emitted) : 'n/a',
    c.error ? c.error.slice(0, 60) : '',
  ]);
  return { headers, rows };
}

function writeResults(cells: LatentCell[]) {
  mkdirSync(OUT_DIR, { recursive: true });
  const methodology = {
    schema_version: '1',
    captured_at: new Date().toISOString(),
    run_id: STAMP,
    workload: {
      fixtures_file: 'methodology/latent-fixtures.json',
    },
    modality: {
      kind: 'image-latents',
      latent_space_id: LATENT_SPACE,
    },
    engine: {
      endpoint: LATENT_URL,
    },
    bench_tool: {
      name: 'latent-live.ts',
      version: '0.1.0',
      reps: REPS,
      aggregation: 'median',
      ttff_definition: 'wall-clock from request POST to first response body chunk (approximates first LatentFrame on engines that emit header+frame in one TCP segment)',
      wire_bytes_definition: 'raw socket bytes received before any Content-Encoding decompression',
      total_ms_definition: 'wall-clock from request POST to last byte',
    },
  };
  writeFileSync(
    join(OUT_DIR, 'latent-live.json'),
    JSON.stringify({ schema_version: '1', methodology, rows: cells }, null, 2),
  );

  const sr = summaryRows(cells);
  const md: string[] = [
    `# latent-live results: ${STAMP}\n`,
    `Endpoint: \`${LATENT_URL}\`  ·  latent space: \`${LATENT_SPACE}\``,
    `reps: ${REPS}  ·  cells: ${cells.length}\n`,
    table(sr.headers, sr.rows),
    '',
    hr(),
    `Generated by \`packages/bench/src/latent-live.ts\`. Schema: [bench/methodology/SCHEMA.md](../../methodology/SCHEMA.md) §"Latent modality (v0.3+: additive fields)".`,
  ];
  writeFileSync(join(OUT_DIR, 'latent-live.md'), md.join('\n') + '\n');

  // Headline summary: the wire-bytes ratio against `raw` per fixture.
  const summary: string[] = [
    `# SUMMARY: latent-live ${STAMP}\n`,
    `Endpoint: \`${LATENT_URL}\`  ·  latent space: \`${LATENT_SPACE}\`\n`,
    `## Wire-bytes reduction vs \`raw\` (per fixture)\n`,
  ];
  const byFixture = new Map<string, LatentCell[]>();
  for (const c of cells) {
    if (!byFixture.has(c.size)) byFixture.set(c.size, []);
    byFixture.get(c.size)!.push(c);
  }
  for (const [fixture, group] of byFixture) {
    const rawRow = group.find((c) => c.pipeline === 'raw');
    const baseline = rawRow?.wire_bytes ?? null;
    summary.push(`### Fixture \`${fixture}\``);
    if (baseline === null) {
      summary.push(`(no \`raw\` baseline cell: skipping ratios)\n`);
      continue;
    }
    const fHeaders = ['pipeline', 'enc', 'wire_bytes', 'vs raw'];
    const fRows: string[][] = [];
    for (const c of group) {
      const ratioStr = c.wire_bytes && baseline ? ratio(baseline, c.wire_bytes) : 'n/a';
      fRows.push([
        c.pipeline,
        c.encoding,
        c.wire_bytes !== null ? fmtBytes(c.wire_bytes) : 'n/a',
        ratioStr,
      ]);
    }
    summary.push(table(fHeaders, fRows), '');
  }
  writeFileSync(join(OUT_DIR, 'SUMMARY.md'), summary.join('\n') + '\n');

  console.log(`latent-live: wrote ${cells.length} cells to ${OUT_DIR}`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    console.error('No fixtures matched. Set BENCH_LATENT_FIXTURES=key1,key2 or remove the filter.');
    process.exitCode = 1;
    return;
  }
  console.log(`latent-live: ${fixtures.length} fixtures × applicable variants  ·  endpoint=${LATENT_URL}`);

  const cells: LatentCell[] = [];
  for (const fixture of fixtures) {
    for (const variant of DEFAULT_VARIANTS) {
      if (!isApplicable(variant, fixture)) continue;
      process.stdout.write(`[${fixture.key}/${variant.format}/${variant.encoding}/${variant.pipeline}] `);
      const cell = await runOneCell(variant, fixture);
      if (cell.error) console.log(`ERROR: ${cell.error.slice(0, 80)}`);
      else
        console.log(
          `wire=${cell.wire_bytes !== null ? fmtBytes(cell.wire_bytes) : 'n/a'} ttff=${cell.ttff_ms !== null ? fmtNum(cell.ttff_ms, 0) + 'ms' : 'n/a'}`,
        );
      cells.push(cell);
    }
  }

  writeResults(cells);
  // Suppress unused-import warning at compile time.
  void fmtNs;
}

main().catch((err: unknown) => {
  console.error('latent-live failed:', err);
  process.exitCode = 1;
});
