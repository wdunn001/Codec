/**
 * live.ts: measure real wire cost against a live OpenAI-compatible server.
 *
 * Default target: Ollama at http://192.168.1.88:11434. Override via env:
 *   BENCH_URL=http://localhost:8000 BENCH_MODEL=qwen2.5:latest npx tsx packages/bench/src/live.ts
 *
 * What it measures:
 *   - Total bytes received over HTTP (raw socket bytes)
 *   - Time-to-first-token (TTFT)
 *   - Total wall-clock time, tokens/sec
 *   - Token count from the server's usage report (or estimated from text)
 *
 * What it projects (using the measured token count):
 *   - Codec msgpack wire bytes (real frames, computed from the token IDs)
 *   - Codec protobuf wire bytes
 *
 * Why projection: most servers (Ollama, OpenAI, Anthropic) don't expose token
 * IDs over the wire: the whole reason Codec exists is that the text-path
 * doesn't preserve them. So we measure what the incumbent costs and compute
 * what Codec would cost given the same token count. Server-side encode CPU
 * is measured separately by the wire microbench.
 *
 * If the server is unreachable, this exits cleanly with a skip notice rather
 * than failing: keeps CI happy when nobody's running a model locally.
 */
import { performance } from 'node:perf_hooks';

import { encodeMsgpack, encodeProtobuf } from './lib/encoders.js';
import { fmtBytes, fmtNs, fmtNum, hr, ratio, table } from './lib/format.js';

const BASE_URL = process.env.BENCH_URL ?? 'http://192.168.1.88:11434';
const MODEL = process.env.BENCH_MODEL ?? 'qwen2.5:latest';
const PROMPT =
  process.env.BENCH_PROMPT ??
  'Explain how transformer attention works in plain language, in about 200 words.';

// Single-size mode (back-compat) vs. sweep mode. Set BENCH_SWEEP=1 to run
// small/medium/large in sequence so you can see how compression scales.
const SWEEP_MODE = process.env.BENCH_SWEEP === '1' || process.env.BENCH_SWEEP === 'true';
const MAX_TOKENS = Number(process.env.BENCH_MAX_TOKENS ?? '256');
const SWEEP_SIZES: Array<{ label: string; max: number }> = [
  { label: 'small',  max: Number(process.env.BENCH_SMALL  ?? '64') },
  { label: 'medium', max: Number(process.env.BENCH_MEDIUM ?? '512') },
  { label: 'large',  max: Number(process.env.BENCH_LARGE  ?? '2048') },
];

interface LiveResult {
  ok: boolean;
  reason?: string;
  wireBytes: number;
  sseEvents: number;
  ttftMs: number;
  totalMs: number;
  outputTokens: number;
  text: string;
}

async function probe(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function streamCompletion(maxTokens: number = MAX_TOKENS): Promise<LiveResult> {
  const t0 = performance.now();
  const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });

  if (!resp.ok || !resp.body) {
    return {
      ok: false,
      reason: `HTTP ${resp.status}: ${await resp.text().catch(() => '')}`,
      wireBytes: 0,
      sseEvents: 0,
      ttftMs: 0,
      totalMs: 0,
      outputTokens: 0,
      text: '',
    };
  }

  let wireBytes = 0;
  let sseEvents = 0;
  let ttftMs = 0;
  let text = '';
  let outputTokens = 0;

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttftMs === 0) ttftMs = performance.now() - t0;
    wireBytes += value.byteLength;
    buffer += dec.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      sseEvents++;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const ev = JSON.parse(data);
        const delta = ev.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') text += delta;
        // Ollama emits a final chunk with usage:
        if (ev.usage?.completion_tokens) outputTokens = ev.usage.completion_tokens;
      } catch {
        /* ignore */
      }
    }
  }

  const totalMs = performance.now() - t0;
  // Fallback: estimate tokens if usage wasn't reported. ~4 chars/token is the
  // standard rule of thumb for English; close enough for projection math.
  if (outputTokens === 0) outputTokens = Math.max(1, Math.round(text.length / 4));

  return { ok: true, wireBytes, sseEvents, ttftMs, totalMs, outputTokens, text };
}

function projectCodecBytes(tokenCount: number, chunkSize = 1) {
  // Build the same chunks a Codec server would emit and measure their length.
  // IDs are placeholder: byte cost only depends on count and value range.
  const chunks: { ids: number[]; done: boolean; finishReason?: string }[] = [];
  let emitted = 0;
  while (emitted < tokenCount) {
    const take = Math.min(chunkSize, tokenCount - emitted);
    const ids = Array.from({ length: take }, (_, i) => 50_000 + emitted + i);
    emitted += take;
    chunks.push({ ids, done: emitted === tokenCount, finishReason: emitted === tokenCount ? 'stop' : undefined });
  }
  let msgpackBytes = 0;
  let protobufBytes = 0;
  for (const c of chunks) {
    msgpackBytes += encodeMsgpack(c).byteLength;
    protobufBytes += encodeProtobuf(c).byteLength;
  }
  return { msgpackBytes, protobufBytes };
}

async function main() {
  console.log('# Live wire bench\n');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Model:  ${MODEL}`);
  console.log(`Prompt: "${PROMPT.slice(0, 60)}${PROMPT.length > 60 ? '…' : ''}"`);
  console.log();

  if (!(await probe())) {
    console.log(
      `Skip: server not reachable at ${BASE_URL}. Set BENCH_URL to point\n` +
        `at any OpenAI-compatible streaming endpoint (Ollama, vLLM, …).\n`
    );
    process.exit(0);
  }

  if (SWEEP_MODE) {
    console.log(hr('sweep: small / medium / large'));
    console.log();
    interface SweepRow {
      label: string;
      tokens: number;
      sseBytes: number;
      msgpackBytes: number;
      protobufBytes: number;
    }
    const sweepRows: SweepRow[] = [];
    for (const sz of SWEEP_SIZES) {
      const rr = await streamCompletion(sz.max);
      if (!rr.ok) {
        console.log(`Failed (${sz.label}, max=${sz.max}): ${rr.reason}\n`);
        continue;
      }
      const proj = projectCodecBytes(rr.outputTokens, 1);
      sweepRows.push({
        label: sz.label,
        tokens: rr.outputTokens,
        sseBytes: rr.wireBytes,
        msgpackBytes: proj.msgpackBytes,
        protobufBytes: proj.protobufBytes,
      });
    }
    console.log(
      table(
        ['size', 'tokens', 'json-sse', 'msgpack', 'msgpack vs sse', 'protobuf', 'protobuf vs sse'],
        sweepRows.map((r) => [
          r.label,
          fmtNum(r.tokens),
          fmtBytes(r.sseBytes),
          fmtBytes(r.msgpackBytes),
          ratio(r.sseBytes, r.msgpackBytes),
          fmtBytes(r.protobufBytes),
          ratio(r.sseBytes, r.protobufBytes),
        ]),
      ),
    );
    console.log();
    console.log(
      `Reading the sweep: msgpack/protobuf ratios should grow with token count\n` +
        `because JSON-SSE per-event framing overhead is amortized over more events,\n` +
        `but Codec's framing is constant-per-token. The "vs sse" columns are the\n` +
        `headline: how much smaller Codec is at each size.\n`,
    );
    return;
  }

  const r = await streamCompletion();
  if (!r.ok) {
    console.log(`Failed: ${r.reason}\n`);
    process.exit(1);
  }

  const projected = projectCodecBytes(r.outputTokens, 1);

  console.log(hr('measured (JSON-SSE)'));
  console.log();
  console.log(
    table(
      ['metric', 'value'],
      [
        ['output tokens', fmtNum(r.outputTokens)],
        ['SSE events', fmtNum(r.sseEvents)],
        ['wire bytes', fmtBytes(r.wireBytes)],
        ['bytes/token', (r.wireBytes / r.outputTokens).toFixed(2)],
        ['TTFT', fmtNs(r.ttftMs * 1e6)],
        ['total time', fmtNs(r.totalMs * 1e6)],
        ['tokens/sec', fmtNum(r.outputTokens / (r.totalMs / 1000), 1)],
      ]
    )
  );
  console.log();
  console.log(hr('projected (Codec): same token count, real frame encoding'));
  console.log();
  console.log(
    table(
      ['encoder', 'wire bytes', 'B/token', 'reduction vs JSON-SSE'],
      [
        [
          'json-sse (measured)',
          fmtBytes(r.wireBytes),
          (r.wireBytes / r.outputTokens).toFixed(2),
          'n/a',
        ],
        [
          'msgpack (Codec)',
          fmtBytes(projected.msgpackBytes),
          (projected.msgpackBytes / r.outputTokens).toFixed(2),
          ratio(r.wireBytes, projected.msgpackBytes),
        ],
        [
          'protobuf (Codec)',
          fmtBytes(projected.protobufBytes),
          (projected.protobufBytes / r.outputTokens).toFixed(2),
          ratio(r.wireBytes, projected.protobufBytes),
        ],
      ]
    )
  );
  console.log();
  console.log(hr());
  console.log(
    `\nNote: TTFT and tokens/sec are model-bound and unchanged by Codec: the wire is\n` +
      `not the bottleneck on a single connection. The Codec advantage shows up at\n` +
      `(a) per-byte gateway/proxy cost, (b) concurrent-session memory, and (c) agent\n` +
      `handoffs where the text round-trip is pure waste. See handoff.ts for (c).\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
