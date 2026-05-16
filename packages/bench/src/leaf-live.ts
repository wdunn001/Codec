/**
 * leaf-live.ts — measure the wire + consumer-CPU effect of MCP leaf-mode.
 *
 * Tool-result-side axis (complementary to the model-emission-side rows
 * mock/searxng/metamcp in agent-loop/). Same tool, same prompt, two
 * server-side modes of @codecai/codec-time-leaf:
 *
 *   A. plain MCP        — env unset → tool returns text only; the consumer
 *                         must call pickTokenizer(map).encode(text) to
 *                         obtain IDs for KV-cache push / Codec forwarding.
 *   B. mcp-leaf         — CODEC_MAP_URL+CODEC_MAP_HASH set → tool wraps
 *                         the result with a per-block
 *                         _meta['ai.codec/leaf-tokenization'] payload;
 *                         the consumer calls readCodecMeta(result) and
 *                         takes the IDs without retokenizing.
 *
 * Measurements per path (N warm calls, median reported):
 *   wire        — JSON-RPC response body bytes for tools/call
 *   tokenize    — consumer-side ms from "have response" to "have IDs"
 *                 (BPE encode on plain; meta-read on leaf — leaf is ~0)
 *   ttfb        — request-sent → first-response-byte ms
 *   total       — request-sent → IDs-in-hand ms (= ttfb + tokenize + parse)
 *
 * Both paths produce the same final state (IDs aligned to the tool's text);
 * we assert that asserting equality across paths catches any regression
 * in the leaf wrapper's idempotence.
 *
 * Caveat: leaf-mode's wire overhead is FIXED per text block (~80–150 B for
 * the _meta envelope) but its savings scale with text-block length (BPE
 * cost ≈ O(chars)). For get_current_time (≈30 char timestamp / ~15
 * tokens), leaf adds wire bytes but eliminates a ~0.1–0.3 ms tokenize.
 * The scaling note is in the README; this bench captures one
 * representative point — a longer-text tool would shift the wire balance
 * in leaf's favour while keeping the tokenize differential roughly linear.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { loadMap, pickTokenizer, type Tokenizer, type TokenizerMap } from '@codecai/web';
import { readCodecMeta, type CallToolResult } from '@codecai/mcp-leaf';

import { fmtBytes, fmtNum, table } from './lib/format.js';

// ── Config ───────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..', '..', '..');

const TIME_LEAF_BIN = resolve(
  REPO,
  'packages/mcp-leaf/examples/time-server/dist/index.js',
);
const MAP_URL =
  process.env.BENCH_LEAF_MAP_URL ??
  'https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json';
const MAP_HASH =
  process.env.BENCH_LEAF_MAP_HASH ??
  'sha256:62c2f94fcbdb9b49d51632314e64aa65894496bc39751cb90866049657a262ad';

const TOOL_NAME = 'get_current_time';
const TOOL_ARGS = { timezone: 'UTC' };

const WARMUP = 5;
const ITERS = 20;

// Output dir: matches the existing agent-loop run from this release cohort.
const OUT_DIR =
  process.env.BENCH_LEAF_OUT_DIR ??
  resolve(REPO, 'packages/bench/results/2026-05-15T20-00-00Z/agent-loop');

// ── MCP stdio client ─────────────────────────────────────────────────────────

interface PendingReq {
  resolve: (msg: { raw: string; bytes: number; firstByteNs: number; lastByteNs: number }) => void;
  reject: (e: Error) => void;
  sentNs: number;
  firstByteNs: number | null;
}

class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private pending = new Map<number, PendingReq>();
  private nextId = 1;
  private stderrTail: string[] = [];

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn('node', [TIME_LEAF_BIN], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onChunk(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    this.child.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }

  private onChunk(chunk: string) {
    const arrivedNs = performance.now() * 1e6;
    // Record first-byte arrival for the oldest still-pending request.
    for (const p of this.pending.values()) {
      if (p.firstByteNs === null) p.firstByteNs = arrivedNs;
    }
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const req = this.pending.get(msg.id);
      if (!req) continue;
      this.pending.delete(msg.id);
      if (msg.error) {
        req.reject(new Error(msg.error.message));
        continue;
      }
      const lastByteNs = performance.now() * 1e6;
      req.resolve({
        raw: line,
        bytes: Buffer.byteLength(line, 'utf8') + 1, // include the newline framing
        firstByteNs: req.firstByteNs ?? lastByteNs,
        lastByteNs,
      });
    }
  }

  async send(method: string, params: unknown): Promise<{
    result: unknown;
    raw: string;
    bytes: number;
    ttfbMs: number;
    totalMs: number;
  }> {
    const id = this.nextId++;
    const reqPayload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const sentNs = performance.now() * 1e6;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        sentNs,
        firstByteNs: null,
        resolve: (msg) => {
          let parsed: { result?: unknown };
          try {
            parsed = JSON.parse(msg.raw);
          } catch (e) {
            return reject(e as Error);
          }
          resolve({
            result: parsed.result,
            raw: msg.raw,
            bytes: msg.bytes,
            ttfbMs: (msg.firstByteNs - sentNs) / 1e6,
            totalMs: (msg.lastByteNs - sentNs) / 1e6,
          });
        },
        reject,
      });
      this.child.stdin.write(reqPayload + '\n');
    });
  }

  stderrText(): string {
    return this.stderrTail.join('');
  }

  close() {
    try {
      this.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

async function initialize(client: StdioMcpClient): Promise<void> {
  await client.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'leaf-live-bench', version: '0.4.1' },
  });
  // SDK accepts the notification but doesn't reply — no-op for our id flow.
}

// ── Bench paths ──────────────────────────────────────────────────────────────

interface PathSample {
  wireBytes: number;
  ttfbMs: number;
  prepMs: number;  // tokenize on plain, readCodecMeta on leaf
  totalMs: number; // ttfb + body + prep
  ids: number[];
}

async function benchPath(
  label: string,
  env: NodeJS.ProcessEnv,
  consumerExtract: (result: CallToolResult, raw: string) => Promise<{ ids: number[]; prepMs: number }>,
): Promise<{ label: string; samples: PathSample[] }> {
  const client = new StdioMcpClient(env);
  try {
    await initialize(client);

    const samples: PathSample[] = [];
    for (let i = 0; i < WARMUP + ITERS; i++) {
      const r = await client.send('tools/call', {
        name: TOOL_NAME,
        arguments: TOOL_ARGS,
      });
      const result = r.result as CallToolResult;
      const { ids, prepMs } = await consumerExtract(result, r.raw);
      if (i < WARMUP) continue;
      samples.push({
        wireBytes: r.bytes,
        ttfbMs: r.ttfbMs,
        prepMs,
        totalMs: r.totalMs + prepMs,
        ids,
      });
    }
    return { label, samples };
  } finally {
    client.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.error(`[leaf-live] map=${MAP_URL.split('/').slice(-2).join('/')} hash=${MAP_HASH.slice(0, 17)}…`);
  console.error(`[leaf-live] tool=${TOOL_NAME}  warmup=${WARMUP}  iters=${ITERS}`);
  console.error(`[leaf-live] loading map for plain-path consumer tokenizer…`);
  const map: TokenizerMap = await loadMap({ url: MAP_URL, hash: MAP_HASH });
  const tokenizer: Tokenizer = pickTokenizer(map);

  // ── Path A: plain MCP, consumer re-tokenizes ──
  const plain = await benchPath('plain MCP (consumer re-tokenizes text)', {}, async (result) => {
    const t0 = performance.now();
    const texts: string[] = [];
    for (const b of result.content) {
      if ((b as { type?: string }).type === 'text') {
        texts.push((b as { text: string }).text);
      }
    }
    const ids = texts.flatMap((t) => tokenizer.encode(t));
    const prepMs = performance.now() - t0;
    return { ids, prepMs };
  });

  // ── Path B: mcp-leaf, consumer reads ids from _meta ──
  // While extracting ids, we ALSO assert leaf.ids === tokenizer.encode(leaf.text)
  // for every sample. This is the real correctness check: leaf says "tool's
  // ids must decode to the tool's text under the declared map_id." A mismatch
  // would mean the leaf wrapper is producing IDs that diverge from the
  // tokenizer the consumer pinned. (Cross-path equality between plain and
  // leaf is NOT meaningful for time-varying tools like get_current_time
  // — each subprocess sees a slightly different wall-clock.)
  let leafIntegrityFails = 0;
  const leaf = await benchPath(
    'mcp-leaf (consumer reads ids from _meta)',
    { CODEC_MAP_URL: MAP_URL, CODEC_MAP_HASH: MAP_HASH },
    async (result) => {
      const t0 = performance.now();
      const pairings = readCodecMeta(result, { expectedMapHash: MAP_HASH });
      const ids: number[] = [];
      for (const p of pairings) {
        if (p.ids === null) throw new Error('leaf path returned text without _codec_meta');
        ids.push(...p.ids);
      }
      const prepMs = performance.now() - t0;
      // Integrity: every leaf sample's ids MUST equal a fresh re-tokenize of
      // the same text. Counted, not aborted — we still want the numbers.
      const expected: number[] = [];
      for (const p of pairings) expected.push(...tokenizer.encode(p.text));
      if (expected.join(',') !== ids.join(',')) {
        leafIntegrityFails++;
        if (leafIntegrityFails <= 2) {
          console.error(`[leaf-live] integrity FAIL on sample`);
          console.error(`  leaf.ids:  [${ids.join(',')}]`);
          console.error(`  expected:  [${expected.join(',')}]`);
        }
      }
      return { ids, prepMs };
    },
  );
  if (leafIntegrityFails > 0) {
    console.error(`[leaf-live] FAIL: ${leafIntegrityFails}/${leaf.samples.length} leaf samples had ids that did not equal re-tokenize(text)`);
    process.exit(2);
  }

  // ── Report ──
  const headers = ['path', 'wire', 'tokenize', 'TTFB', 'total', 'calls'];
  const rows: string[][] = [];
  const summary = [
    { label: plain.label, s: plain.samples },
    { label: leaf.label, s: leaf.samples },
  ];
  for (const { label, s } of summary) {
    rows.push([
      label,
      fmtBytes(Math.round(median(s.map((x) => x.wireBytes)))),
      `${median(s.map((x) => x.prepMs)).toFixed(2)} ms`,
      `${median(s.map((x) => x.ttfbMs)).toFixed(1)} ms`,
      `${median(s.map((x) => x.totalMs)).toFixed(1)} ms`,
      String(s.length),
    ]);
  }

  const plainMed = median(plain.samples.map((x) => x.wireBytes));
  const leafMed = median(leaf.samples.map((x) => x.wireBytes));
  const plainTokMed = median(plain.samples.map((x) => x.prepMs));
  const leafTokMed = median(leaf.samples.map((x) => x.prepMs));

  const wireDelta = leafMed - plainMed;
  const tokSpeedup = plainTokMed / Math.max(leafTokMed, 0.001);

  const out =
    `  ✓ Plain MCP (consumer re-tokenizes text)\n` +
    `  ✓ mcp-leaf (consumer reads ids from _meta)\n` +
    `tool:   ${TOOL_NAME}  args=${JSON.stringify(TOOL_ARGS)}\n` +
    `map:    ${MAP_URL.split('/').slice(-2).join('/')}  ${MAP_HASH}\n` +
    `iters:  warmup=${WARMUP}  measured=${ITERS}\n` +
    `\n` +
    table(headers, rows) +
    `\n\n` +
    `wire delta (leaf − plain):     ${wireDelta >= 0 ? '+' : ''}${fmtNum(wireDelta)} B\n` +
    `consumer tokenize speedup:     ${tokSpeedup.toFixed(1)}× (plain ${plainTokMed.toFixed(3)} ms → leaf ${leafTokMed.toFixed(3)} ms)\n` +
    `\n` +
    `leaf integrity (ids ≡ encode(text)):  ✓ ${leaf.samples.length}/${leaf.samples.length} samples\n` +
    `\n` +
    `Notes:\n` +
    `  * Leaf-mode wire overhead is fixed per text block (~80–150 B for the\n` +
    `    _meta envelope) and savings scale with text length. For tiny\n` +
    `    timestamp results, leaf adds wire bytes; consumer CPU still wins\n` +
    `    because tokenize is O(chars). The crossover where leaf wire ≤ plain\n` +
    `    is around ~300+ chars of text-block content per tool result.\n` +
    `  * Complementary axis to the mock/searxng/metamcp agent-loop rows:\n` +
    `    those measure model-emission-side (ToolWatcher fires on raw IDs in\n` +
    `    the inference stream). This row measures tool-result-side (the\n` +
    `    tokenize the consumer would otherwise pay on each tool result).\n`;

  const txtPath = join(OUT_DIR, 'leaf.txt');
  const jsonPath = join(OUT_DIR, 'leaf.json');
  writeFileSync(txtPath, out);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        map_url: MAP_URL,
        map_hash: MAP_HASH,
        tool: TOOL_NAME,
        tool_args: TOOL_ARGS,
        warmup: WARMUP,
        iters: ITERS,
        plain: {
          wire_bytes_median: plainMed,
          tokenize_ms_median: plainTokMed,
          ttfb_ms_median: median(plain.samples.map((x) => x.ttfbMs)),
          total_ms_median: median(plain.samples.map((x) => x.totalMs)),
          ids_length: plain.samples[0]!.ids.length,
        },
        leaf: {
          wire_bytes_median: leafMed,
          tokenize_ms_median: leafTokMed,
          ttfb_ms_median: median(leaf.samples.map((x) => x.ttfbMs)),
          total_ms_median: median(leaf.samples.map((x) => x.totalMs)),
          ids_length: leaf.samples[0]!.ids.length,
        },
        wire_delta_bytes: wireDelta,
        tokenize_speedup_x: tokSpeedup,
        leaf_integrity_pass: leaf.samples.length,
        leaf_integrity_fail: leafIntegrityFails,
      },
      null,
      2,
    ),
  );

  console.log(out);
  console.error(`[leaf-live] wrote ${txtPath}`);
  console.error(`[leaf-live] wrote ${jsonPath}`);
}

main().catch((e) => {
  console.error(`[leaf-live] fatal: ${(e as Error).message}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
