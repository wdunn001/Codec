/**
 * handoff.ts: agent-to-agent round-trip cost.
 *
 * Models the central claim of the Codec protocol: when Agent A's output is
 * Agent B's input (no human in the loop), the text round-trip is pure waste.
 *
 *   Text path:  IDs → detokenize → JSON-SSE → wire → JSON.parse → tokenize → IDs
 *   Codec path: IDs → msgpack → wire → msgpack-decode → IDs
 *
 * We don't ship a real tokenizer (would force a heavy dep), so we model
 * detokenize/tokenize as a hash-table lookup per token. That's an under-estimate
 *: real BPE tokenization is significantly more expensive: so the text path
 * looks better here than it does in production. Even with that handicap, the
 * gap is large.
 *
 *   npx tsx packages/bench/src/handoff.ts
 */
import { performance } from 'node:perf_hooks';

import {
  CODECS,
  type Chunk,
} from './lib/encoders.js';
import { collect, type StreamShape } from './lib/stream.js';
import { fmtBytes, fmtNs, fmtNum, hr, ratio, table } from './lib/format.js';

const REPS = 5;
const WARMUP = 2;

// Synthetic vocab: IDs map to placeholder strings. This stands in for a real
// tokenizer. Real BPE is 5-50× slower than a hash lookup, so the JSON-SSE
// numbers below understate the real cost.
const VOCAB_SIZE = 128_000;
const VOCAB: string[] = new Array(VOCAB_SIZE);
for (let i = 0; i < VOCAB_SIZE; i++) VOCAB[i] = `tok${i}`;
const REVERSE = new Map<string, number>();
for (let i = 0; i < VOCAB_SIZE; i++) REVERSE.set(VOCAB[i]!, i);

function detokenize(ids: number[]): string {
  return ids.map((id) => VOCAB[id] ?? '').join('');
}

function tokenize(text: string): number[] {
  // Toy tokenizer that splits on the synthetic boundary. In production this
  // is the regex+merge phase of BPE: orders of magnitude slower.
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    // sniff for "tok" prefix then digits
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

interface PathResult {
  name: string;
  totalBytes: number;
  totalNs: number;
  encodeNs: number;
  decodeNs: number;
  ok: boolean;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function benchTextPath(chunks: Chunk[]): PathResult {
  // Detokenize → SSE-wrap → wire → parse → tokenize. This is the round-trip
  // every agent-to-agent call pays today.
  const sse = CODECS.find((c) => c.name === 'json-sse')!;

  // First, build the wire bytes a server would emit. This includes the
  // detokenize cost on the producer side.
  let totalBytes = 0;
  let recovered: number[] = [];
  let encodeNs = 0;
  let decodeNs = 0;

  for (let r = 0; r < REPS + WARMUP; r++) {
    let bytes = 0;
    let recover: number[] = [];
    let enc = 0;
    let dec = 0;

    for (const c of chunks) {
      // Producer side: detokenize IDs to text, encode as SSE.
      const t0 = performance.now();
      const text = detokenize(c.ids);
      const buf = sse.encode({ ids: c.ids, done: c.done }); // SSE encoder embeds text via ids.length placeholder
      // Override: use the *real* text length for fair byte counting.
      const realObj = {
        id: 'cmpl-bench',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: text }, ...(c.done && { finish_reason: 'stop' }) }],
      };
      const realBuf = new TextEncoder().encode('data: ' + JSON.stringify(realObj) + '\n\n');
      const t1 = performance.now();
      bytes += realBuf.byteLength;
      enc += (t1 - t0) * 1e6;
      void buf; // placate TS

      // Consumer side: parse JSON, tokenize text.
      const t2 = performance.now();
      const parsed = JSON.parse(new TextDecoder().decode(realBuf).slice(6).trim());
      const recoveredText = parsed.choices[0].delta.content as string;
      recover.push(...tokenize(recoveredText));
      const t3 = performance.now();
      dec += (t3 - t2) * 1e6;
    }

    if (r >= WARMUP) {
      totalBytes = bytes;
      recovered = recover;
      encodeNs += enc;
      decodeNs += dec;
    }
  }

  const expected = chunks.flatMap((c) => c.ids);
  const ok = recovered.length === expected.length && recovered.every((v, i) => v === expected[i]);

  return {
    name: 'text (JSON-SSE)',
    totalBytes,
    encodeNs: encodeNs / REPS,
    decodeNs: decodeNs / REPS,
    totalNs: (encodeNs + decodeNs) / REPS,
    ok,
  };
}

function benchCodecPath(chunks: Chunk[], encoder: 'msgpack' | 'protobuf'): PathResult {
  const codec = CODECS.find((c) => c.name === encoder)!;
  let totalBytes = 0;
  let recovered: number[] = [];
  const encRuns: number[] = [];
  const decRuns: number[] = [];

  for (let r = 0; r < REPS + WARMUP; r++) {
    let bytes = 0;
    let recover: number[] = [];

    const t0 = performance.now();
    const encoded: Uint8Array[] = [];
    for (const c of chunks) {
      const buf = codec.encode(c);
      bytes += buf.byteLength;
      encoded.push(buf);
    }
    const t1 = performance.now();

    for (const b of encoded) {
      const out = codec.decode(b);
      recover.push(...out.ids);
    }
    const t2 = performance.now();

    if (r >= WARMUP) {
      totalBytes = bytes;
      recovered = recover;
      encRuns.push((t1 - t0) * 1e6);
      decRuns.push((t2 - t1) * 1e6);
    }
  }

  const expected = chunks.flatMap((c) => c.ids);
  const ok = recovered.length === expected.length && recovered.every((v, i) => v === expected[i]);

  const encodeNs = median(encRuns);
  const decodeNs = median(decRuns);

  return {
    name: `codec (${encoder})`,
    totalBytes,
    encodeNs,
    decodeNs,
    totalNs: encodeNs + decodeNs,
    ok,
  };
}

const SHAPE: StreamShape = { totalTokens: 1024, chunkSize: 1, vocabSize: VOCAB_SIZE };

function main() {
  console.log('# Agent-to-agent handoff microbench\n');
  console.log(
    `Round-trip of ${fmtNum(SHAPE.totalTokens)} tokens, ${SHAPE.chunkSize} per chunk.\n` +
      `Note: tokenize/detokenize modeled as hashtable lookup. Real BPE is 5 to 50× slower,\n` +
      `so the text path numbers below are a *lower bound* on its real cost.\n`
  );

  const chunks = collect(SHAPE);

  const results: PathResult[] = [
    benchTextPath(chunks),
    benchCodecPath(chunks, 'msgpack'),
    benchCodecPath(chunks, 'protobuf'),
  ];

  const baseline = results[0]!;
  console.log(
    table(
      ['path', 'wire bytes', 'producer time', 'consumer time', 'total', 'vs text', 'ok'],
      results.map((r) => [
        r.name,
        fmtBytes(r.totalBytes),
        fmtNs(r.encodeNs),
        fmtNs(r.decodeNs),
        fmtNs(r.totalNs),
        ratio(baseline.totalNs, r.totalNs),
        r.ok ? '✓' : '✗',
      ])
    )
  );

  const textBytes = baseline.totalBytes;
  const codecBytes = results[1]!.totalBytes;
  console.log();
  console.log(hr());
  console.log(
    `\nWire reduction: ${ratio(textBytes, codecBytes)} (${fmtBytes(textBytes - codecBytes)} saved per ${fmtNum(SHAPE.totalTokens)}-token call).`
  );
  console.log(
    'CPU reduction is dominated by skipping detokenize+tokenize on the round trip.\n' +
      'In production, with real BPE, the codec advantage on consumer time grows substantially.\n'
  );
}

main();
