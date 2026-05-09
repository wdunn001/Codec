/**
 * latent-live.ts — measure Codec latent-modality wire cost against a live
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
 * For latents, the bigger axis is *pipeline* — the bench's job is to
 * produce the rate-distortion curve (wire bytes vs SSIM) every classical
 * video codec publishes. The same harness records `ttff_ms` (time to first
 * frame), decoder cost (when a decoder is loaded), and perceptual quality
 * (SSIM / PSNR / LPIPS) per cell.
 *
 * Auth + endpoint: similar to mcp-live but for the latent server.
 *
 *   BENCH_LATENT_URL=http://192.168.1.88:8080/v1/images/generations \
 *   BENCH_LATENT_SPACE=stabilityai/sd-vae-ft-mse \
 *   BENCH_LATENT_MAP_URL=https://… \
 *   BENCH_LATENT_MAP_HASH=sha256:… \
 *   tsx packages/bench/src/latent-live.ts
 *
 * Stub status:
 *   This file lays out the matrix and the request shape. Phase 6 of the
 *   v0.3 release plan wires it through to the diffusers + comfyui
 *   servers, runs the corpus capture (capture-latent-samples.py), trains
 *   the per-pipeline zstd dicts (train-zstd-dict-latents.py), and lands
 *   results under packages/bench/results/<UTC>/latent/. The harness in
 *   this file is the entry point for all of that.
 *
 * Why a stub: we cannot land golden-builder + the full perceptual gate
 * without a GPU + the diffusers/comfyui images already published, and
 * those depend on Phase 3's CI workflow first turning green. The stub
 * unblocks Phase 6 by pinning the wire shape, the cell row schema, and
 * the variant matrix so the runner is a fill-in-the-blanks job.
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fmtBytes, fmtNs, fmtNum, hr, ratio, table } from './lib/format.js';

// ── Config ────────────────────────────────────────────────────────────────────

const LATENT_URL =
  process.env.BENCH_LATENT_URL ??
  'http://192.168.1.88:8080/v1/images/generations';
const LATENT_SPACE =
  process.env.BENCH_LATENT_SPACE ?? 'stabilityai/sd-vae-ft-mse';
const MAP_URL  = process.env.BENCH_LATENT_MAP_URL  ?? '';
const MAP_HASH = process.env.BENCH_LATENT_MAP_HASH ?? '';

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
  // Format defaults to msgpack — matches what the engines actually serve in v0.3.
  { format: 'msgpack', encoding: 'identity', pipeline: 'raw' },
  { format: 'msgpack', encoding: 'identity', pipeline: 'int8' },
  { format: 'msgpack', encoding: 'identity', pipeline: 'int4' },
  { format: 'msgpack', encoding: 'identity', pipeline: 'int8-adaptive' },
  { format: 'msgpack', encoding: 'identity', pipeline: 'int4-adaptive' },
  // Compression on top of int8 — the production-shape lane that carries
  // the headline wire-byte reduction for static images.
  { format: 'msgpack', encoding: 'gzip', pipeline: 'int8' },
  { format: 'msgpack', encoding: 'zstd', pipeline: 'int8' },
  // Video-only delta variants — fixture filter narrows to video-* keys.
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
  return Object.entries(json.fixtures).map(([key, spec]) => ({ key, ...spec }));
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
  // Decoder cost — populated by the runner when a decoder is loaded;
  // null on parse-only cells.
  decode_cold_ms:     number | null;
  decode_steady_ms:   number | null;
  decode_peak_mem_mb: number | null;
  // Perceptual quality vs the golden-builder reference — populated when
  // a decoder is loaded.
  ssim:               number | null;
  psnr:               number | null;
  lpips:              number | null;
  vmaf:               number | null;
  temporal_ssim:      number | null;
  // Negotiation header echoes — see SCHEMA.md §"Negotiation headers".
  codec_tokenizer_map: string | null;     // null on latent cells
  codec_latent_map:    string | null;
  codec_zstd_dict:     string | null;
  error:              string | null;
}

// ── Request builder ─────────────────────────────────────────────────────────

interface RequestSpec {
  url:     string;
  body:    string;
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

  const body = JSON.stringify({
    model: fixture.kind === 'image' ? 'sd1.5' : 'svd',
    prompt: fixture.prompt,
    stream_format: variant.format,
    modality: fixture.kind === 'image' ? 'image-latents' : 'video-latents',
    latent_space: LATENT_SPACE,
    pipeline: variant.pipeline,
    size: `${fixture.resolution}x${fixture.resolution}`,
    steps: fixture.steps,
    seed: fixture.seed,
    ...(fixture.kind === 'video' ? { fps: fixture.fps, duration_seconds: (fixture.frames ?? 0) / (fixture.fps ?? 1) } : {}),
  });

  return { url: LATENT_URL, body, headers };
}

// ── Stub runner ─────────────────────────────────────────────────────────────

/**
 * Phase 6 implements the actual loop:
 *   for fixture in loadFixtures():
 *     for variant in DEFAULT_VARIANTS where isApplicable(variant, fixture):
 *       cell = await runOneCell(variant, fixture);
 *       cells.push(cell);
 *
 *   const matrix = buildMatrix(cells);
 *   writeFileSync(`${OUT_DIR}/latent-live.json`, JSON.stringify({ methodology, rows: cells }, null, 2));
 *   writeFileSync(`${OUT_DIR}/latent-live.md`,   matrix.markdown);
 *   writeFileSync(`${OUT_DIR}/SUMMARY.md`,       narrativeSummary(matrix));
 *
 * Each cell run measures raw socket bytes (no Content-Encoding decompression
 * — same rule as mcp-live.ts), wall-clock to first LatentFrame after the
 * LatentStreamHeader (ttff_ms), and total wall-clock. Decoder loading is
 * out-of-scope for the wire harness — a separate "latent-perceptual.ts"
 * pass loads a decoder and computes ssim/psnr/lpips against the golden-
 * builder reference, then back-fills the perceptual columns.
 *
 * For now this file logs its planned matrix so an operator can verify the
 * shape before Phase 6 wiring lands.
 */
async function main() {
  const fixtures = loadFixtures();
  const planned: { variant: VariantSpec; fixture: FixtureSpec }[] = [];
  for (const fixture of fixtures) {
    for (const variant of DEFAULT_VARIANTS) {
      if (isApplicable(variant, fixture)) planned.push({ variant, fixture });
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const planPath = join(OUT_DIR, 'PLAN.md');
  const lines: string[] = [
    `# latent-live planned matrix\n`,
    `Endpoint: ${LATENT_URL}`,
    `Latent space: ${LATENT_SPACE}`,
    `Map: ${MAP_URL || '(unset)'}  hash: ${MAP_HASH || '(unset)'}`,
    `Fixtures loaded: ${fixtures.length}`,
    `Cells planned:   ${planned.length}\n`,
    `| fixture | kind  | format  | encoding | pipeline       |`,
    `|---------|-------|---------|----------|----------------|`,
  ];
  for (const { fixture, variant } of planned) {
    lines.push(
      `| ${fixture.key.padEnd(7)} | ${fixture.kind.padEnd(5)} | ${variant.format.padEnd(7)} | ${variant.encoding.padEnd(8)} | ${variant.pipeline.padEnd(14)} |`,
    );
  }
  writeFileSync(planPath, lines.join('\n') + '\n');
  console.log(`latent-live (stub): wrote planned matrix to ${planPath}`);
  console.log(`Next: implement runOneCell() to actually exercise the endpoint (Phase 6 of the v0.3 release plan).`);
  // Suppress unused-import warnings at compile time.
  void fmtBytes; void fmtNs; void fmtNum; void hr; void ratio; void table;
  void buildRequest;
  void ({} as LatentCell);
}

main().catch((err: unknown) => {
  console.error('latent-live failed:', err);
  process.exitCode = 1;
});
