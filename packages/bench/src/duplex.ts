/**
 * duplex.ts: bidirectional model↔model handoff cost.
 *
 * v0.5 task #88. Extends the existing single-direction handoff bench to
 * the two-direction duplex case: Agent A and Agent B exchange streams
 * simultaneously, each detokenizing the other's output and re-tokenising
 * it back into its own context.
 *
 * Why duplex matters separately from single-direction:
 *
 *   - Per-direction handoff cost is already covered by handoff.ts. The
 *     CPU + wire cost is symmetric so the JSON path's overhead doubles
 *     under duplex, while the Codec path's overhead also doubles (no
 *     savings from compression-across-directions).
 *   - Real agent meshes are duplex (orchestrator ⇄ tool-server,
 *     planner ⇄ executor, two-LLM ensemble voting). Counting them as
 *     single-direction under-counts what these workloads actually pay.
 *   - The ENERGY_METHODOLOGY.md heavy-agent compound assumes ~8 wire
 *     round-trips per visible reply; ~3-4 of those are duplex by nature.
 *     This bench produces the realistic number.
 *
 *   npx tsx packages/bench/src/duplex.ts
 *   npx tsx packages/bench/src/duplex.ts --tokens=2048 --reps=10
 *   npx tsx packages/bench/src/duplex.ts \\
 *       --output=packages/bench/results/<UTC>/duplex.json
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { CODECS, type Chunk } from './lib/encoders.js';
import { collect, type StreamShape } from './lib/stream.js';
import { fmtBytes, fmtNs, hr, ratio, table } from './lib/format.js';

// ── CLI parsing ────────────────────────────────────────────────────────────

interface CliArgs {
  tokens: number;
  chunkSize: number;
  vocabSize: number;
  reps: number;
  warmup: number;
  output?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    tokens: 1024,
    chunkSize: 1,
    vocabSize: 128_000,
    reps: 5,
    warmup: 2,
  };
  for (const arg of argv) {
    if (arg.startsWith('--tokens=')) args.tokens = Number(arg.slice('--tokens='.length));
    else if (arg.startsWith('--chunk=')) args.chunkSize = Number(arg.slice('--chunk='.length));
    else if (arg.startsWith('--vocab=')) args.vocabSize = Number(arg.slice('--vocab='.length));
    else if (arg.startsWith('--reps=')) args.reps = Number(arg.slice('--reps='.length));
    else if (arg.startsWith('--warmup=')) args.warmup = Number(arg.slice('--warmup='.length));
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
  }
  return args;
}

// ── Synthetic vocab: same shape as handoff.ts ─────────────────────────────

const VOCAB_SIZE = 128_000;
const VOCAB: string[] = new Array(VOCAB_SIZE);
for (let i = 0; i < VOCAB_SIZE; i++) VOCAB[i] = `tok${i}`;
const REVERSE = new Map<string, number>();
for (let i = 0; i < VOCAB_SIZE; i++) REVERSE.set(VOCAB[i]!, i);

function detokenize(ids: number[]): string {
  return ids.map((id) => VOCAB[id] ?? '').join('');
}

function tokenize(text: string): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('tok', i)) {
      let j = i + 3;
      while (j < text.length && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
      const id = REVERSE.get(text.slice(i, j));
      if (id !== undefined) {
        out.push(id);
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

// ── Per-codec duplex measurement ───────────────────────────────────────────

interface DuplexMeasurement {
  /** Total wire bytes A→B + B→A combined. */
  wireBytes: number;
  /** Per-direction wire bytes (symmetric for synthetic case). */
  perDirectionWireBytes: number;
  /** Total CPU time on both endpoints' encoders + decoders + tokenize. */
  cpuNs: number;
}

/**
 * Run one duplex round-trip:
 *   - A streams its chunks → B decodes them
 *   - B streams its chunks → A decodes them
 * For the JSON-SSE path, each consumer detokenizes the wire content and
 * re-tokenizes back to IDs (the agent-mesh overhead Codec eliminates).
 * For the Codec paths, IDs flow through both ways without text reassembly.
 */
function runDuplexOnce(
  codec: typeof CODECS[number],
  aChunks: Chunk[],
  bChunks: Chunk[],
): DuplexMeasurement {
  const t0 = performance.now();
  let totalBytes = 0;

  // Direction A→B
  for (const c of aChunks) {
    if (codec.name === 'json-sse') {
      // Producer A: detokenize IDs to text + wrap as SSE
      const text = detokenize(c.ids);
      const obj = {
        id: 'cmpl-bench-a',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: text }, ...(c.done && { finish_reason: 'stop' }) }],
      };
      const buf = new TextEncoder().encode('data: ' + JSON.stringify(obj) + '\n\n');
      totalBytes += buf.byteLength;
      // Consumer B: parse + re-tokenize
      const parsed = JSON.parse(new TextDecoder().decode(buf).slice(6).trim());
      tokenize(parsed.choices[0].delta.content);
    } else {
      const buf = codec.encode(c);
      totalBytes += buf.byteLength;
      codec.decode(buf);
    }
  }

  // Direction B→A
  for (const c of bChunks) {
    if (codec.name === 'json-sse') {
      const text = detokenize(c.ids);
      const obj = {
        id: 'cmpl-bench-b',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: text }, ...(c.done && { finish_reason: 'stop' }) }],
      };
      const buf = new TextEncoder().encode('data: ' + JSON.stringify(obj) + '\n\n');
      totalBytes += buf.byteLength;
      const parsed = JSON.parse(new TextDecoder().decode(buf).slice(6).trim());
      tokenize(parsed.choices[0].delta.content);
    } else {
      const buf = codec.encode(c);
      totalBytes += buf.byteLength;
      codec.decode(buf);
    }
  }

  const t1 = performance.now();
  return {
    wireBytes: totalBytes,
    perDirectionWireBytes: Math.round(totalBytes / 2),
    cpuNs: Math.round((t1 - t0) * 1e6),
  };
}

function runRepeated(
  codec: typeof CODECS[number],
  aChunks: Chunk[],
  bChunks: Chunk[],
  reps: number,
  warmup: number,
): DuplexMeasurement {
  for (let i = 0; i < warmup; i++) runDuplexOnce(codec, aChunks, bChunks);
  let totalCpuNs = 0;
  let wireBytes = 0;
  let perDirWire = 0;
  for (let i = 0; i < reps; i++) {
    const m = runDuplexOnce(codec, aChunks, bChunks);
    totalCpuNs += m.cpuNs;
    wireBytes = m.wireBytes;
    perDirWire = m.perDirectionWireBytes;
  }
  return {
    wireBytes,
    perDirectionWireBytes: perDirWire,
    cpuNs: Math.round(totalCpuNs / reps),
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const shape: StreamShape = {
    totalTokens: args.tokens,
    chunkSize: args.chunkSize,
    vocabSize: args.vocabSize,
  };

  hr();
  console.log(
    `duplex bench: ${args.tokens} tokens/direction, chunk=${args.chunkSize}, `
      + `vocab=${args.vocabSize}, ${args.reps} reps (warmup ${args.warmup})`,
  );
  hr();

  // Two independent streams (different seeds so the bidirectional channel
  // doesn't accidentally double-count a single sequence's wire bytes).
  const aChunks: Chunk[] = collect(shape, 0xdeadbeef).map((c) => ({
    ids: c.ids,
    done: c.done,
  }));
  const bChunks: Chunk[] = collect(shape, 0xfeedface).map((c) => ({
    ids: c.ids,
    done: c.done,
  }));

  // Measure each codec the encoders library exposes.
  const cells = CODECS.filter((c) => c.name !== 'raw').map((c) => ({
    codec: c.name,
    measurement: runRepeated(c, aChunks, bChunks, args.reps, args.warmup),
  }));

  const baseline = cells.find((c) => c.codec === 'json-sse')!;
  const rows = cells.map((c) => [
    c.codec,
    fmtBytes(c.measurement.wireBytes),
    fmtBytes(c.measurement.perDirectionWireBytes),
    fmtNs(c.measurement.cpuNs),
    c === baseline ? '1.0×' : ratio(baseline.measurement.wireBytes, c.measurement.wireBytes),
    c === baseline ? '1.0×' : ratio(baseline.measurement.cpuNs, c.measurement.cpuNs),
  ]);
  console.log(
    table(
      ['codec', 'duplex wire', 'per-dir wire', 'duplex CPU', 'wire ratio', 'CPU ratio'],
      rows,
    ),
  );
  hr();
  console.log(`Duplex notes:`);
  console.log(
    `  - Wire bytes are 2× per-direction (no compression context shared across directions)`,
  );
  console.log(
    `  - CPU on JSON-SSE is 2× single-direction handoff.ts (detokenize + re-tokenize on both endpoints, both directions)`,
  );
  console.log(
    `  - CPU on Codec is 2× single-direction encode + 2× decode (no detokenize/tokenize either direction)`,
  );
  console.log(
    `  - The JSON↔Codec ratio is preserved under duplex (both paths double); the absolute gap doubles too`,
  );
  hr();

  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    const result = {
      schema_version: '1',
      kind: 'duplex_bench',
      mode: 'synthetic',
      params: {
        tokens_per_direction: args.tokens,
        chunk_size: args.chunkSize,
        vocab_size: args.vocabSize,
        reps: args.reps,
        warmup: args.warmup,
      },
      cells: cells.map((c) => ({
        codec: c.codec,
        wire_bytes_total: c.measurement.wireBytes,
        wire_bytes_per_direction: c.measurement.perDirectionWireBytes,
        cpu_ns: c.measurement.cpuNs,
      })),
      ratios_vs_json_sse: cells
        .filter((c) => c.codec !== 'json-sse')
        .map((c) => ({
          codec: c.codec,
          wire_reduction: baseline.measurement.wireBytes / c.measurement.wireBytes,
          cpu_reduction: baseline.measurement.cpuNs / c.measurement.cpuNs,
        })),
    };
    writeFileSync(args.output, JSON.stringify(result, null, 2) + '\n', 'utf-8');
    console.log(`✓ wrote ${args.output}`);
  }
}

main();
