/**
 * Bench engine: issues one streaming completion per (path, encoding) and
 * measures wire bytes, decoded tokens, TTFB, total time.
 *
 * Wire-byte measurement: browsers transparently decompress gzip/br/zstd before
 * exposing the body to fetch streams. To get the real network bytes we use
 * the Performance Resource Timing API (`encodedBodySize`) which reports the
 * compressed size as it crossed the wire. Each request gets a unique URL
 * fragment so its entry is unambiguous in the timing buffer.
 */

import { decodeMsgpackStream, decodeProtobufStream, type CodecFrame } from '@codecai/web';

export type StreamFormat = 'json' | 'msgpack' | 'protobuf';
export type AcceptEncoding = 'identity' | 'gzip' | 'br' | 'zstd';

export interface Endpoint {
  /** sglang base URL, e.g. "http://192.168.1.88:30000". */
  url: string;
  model: string;
  prompt: string;
  maxTokens: number;
}

export interface Cell {
  pathLabel: string;
  encoding: AcceptEncoding;
  status: 'pending' | 'running' | 'done' | 'error';
  wireBytes?: number;
  uncompressedBytes?: number;
  tokens?: number;
  bytesPerToken?: number;
  ttfbMs?: number;
  totalMs?: number;
  contentEncoding?: string;
  contentType?: string;
  error?: string;
  /** Decoded text (where reconstructible): primarily for the JSON case. */
  text?: string;
}

export interface Path {
  label: string;
  format: StreamFormat;
  /** `bidirectional` paths use Path B (token IDs in). */
  bidirectional?: boolean;
}

export const PATHS: readonly Path[] = [
  { label: 'JSON-SSE (default)', format: 'json' },
  { label: 'Codec msgpack',       format: 'msgpack' },
  { label: 'Codec protobuf',      format: 'protobuf' },
];

export const ENCODINGS: readonly AcceptEncoding[] = ['identity', 'gzip', 'br', 'zstd'];

export function emptyGrid(): Cell[][] {
  return PATHS.map((p) =>
    ENCODINGS.map((enc): Cell => ({
      pathLabel: p.label,
      encoding: enc,
      status: 'pending',
    })),
  );
}

// ── Wire-byte measurement via Performance API ────────────────────────────────

function measureWireBytes(taggedUrl: string): { encoded?: number; decoded?: number } {
  // Resource Timing entries are FIFO; find the latest matching this URL.
  const entries = performance.getEntriesByName(taggedUrl) as PerformanceResourceTiming[];
  if (entries.length === 0) return {};
  const last = entries[entries.length - 1]!;
  return {
    encoded: last.encodedBodySize || undefined,
    decoded: last.decodedBodySize || undefined,
  };
}

// ── Token counting per format ────────────────────────────────────────────────

/** SSE frames look like `data: {...}\n\n` or `data: [DONE]\n\n`. Each
 * non-DONE frame is one chunk; chunks may carry zero or more tokens. We
 * don't always have token IDs in JSON-SSE mode so we count by
 * approximating: parse `text` or `delta.content` when present and sum
 * approximate tokens by splitting on common boundaries; fall back to
 * frame count. SGLang in stream mode emits one token per data chunk. */
function countTokensJsonSse(decoded: string): { tokens: number; text: string } {
  let tokens = 0;
  let text = '';
  for (const line of decoded.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    tokens++;
    try {
      const obj = JSON.parse(payload);
      const piece =
        obj?.choices?.[0]?.text ??
        obj?.choices?.[0]?.delta?.content ??
        '';
      if (typeof piece === 'string') text += piece;
    } catch {
      /* ignore parse errors */
    }
  }
  return { tokens, text };
}

async function countTokensCodec(stream: ReadableStream<Uint8Array>, format: 'msgpack' | 'protobuf'): Promise<{ tokens: number; ids: number[] }> {
  const decode = format === 'msgpack' ? decodeMsgpackStream : decodeProtobufStream;
  const ids: number[] = [];
  for await (const frame of decode(stream) as AsyncIterable<CodecFrame>) {
    for (const id of frame.ids) ids.push(id);
  }
  return { tokens: ids.length, ids };
}

// ── Core run ──────────────────────────────────────────────────────────────────

export async function runOne(
  endpoint: Endpoint,
  path: Path,
  encoding: AcceptEncoding,
  onUpdate: (patch: Partial<Cell>) => void,
): Promise<void> {
  // Tag the URL with a unique fragment so we can find its Resource Timing entry.
  // SGLang ignores fragments; this is purely a client-side disambiguator.
  const tag = `bench=${path.format}.${encoding}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  const taggedUrl = `${endpoint.url}/v1/completions?${tag}`;

  const body: Record<string, unknown> = {
    model: endpoint.model,
    prompt: endpoint.prompt,
    max_tokens: endpoint.maxTokens,
    stream: true,
    temperature: 0.0,
  };
  if (path.format !== 'json') body.stream_format = path.format;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept-Encoding': encoding,
  };

  onUpdate({ status: 'running' });

  const t0 = performance.now();
  let resp: Response;
  try {
    resp = await fetch(taggedUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    onUpdate({ status: 'error', error: String(e) });
    return;
  }

  if (!resp.ok || !resp.body) {
    onUpdate({
      status: 'error',
      error: `HTTP ${resp.status} ${resp.statusText || ''}`,
    });
    return;
  }

  const contentEncoding = resp.headers.get('Content-Encoding') || 'identity';
  const contentType = resp.headers.get('Content-Type') || '';

  const ttfbMs = performance.now() - t0;

  let tokens = 0;
  let text = '';

  if (path.format === 'json') {
    const decoded = await resp.text();
    const r = countTokensJsonSse(decoded);
    tokens = r.tokens;
    text = r.text;
  } else {
    const r = await countTokensCodec(resp.body, path.format);
    tokens = r.tokens;
  }

  const totalMs = performance.now() - t0;

  // Wait one tick for the Resource Timing entry to settle.
  await new Promise((r) => setTimeout(r, 0));
  const wire = measureWireBytes(taggedUrl);

  onUpdate({
    status: 'done',
    wireBytes: wire.encoded,
    uncompressedBytes: wire.decoded,
    tokens,
    bytesPerToken: tokens > 0 && wire.encoded ? wire.encoded / tokens : undefined,
    ttfbMs,
    totalMs,
    contentEncoding,
    contentType,
    text,
  });
}

export async function runAll(
  endpoint: Endpoint,
  setGrid: (updater: (g: Cell[][]) => Cell[][]) => void,
  onLog: (line: string) => void,
): Promise<void> {
  for (let i = 0; i < PATHS.length; i++) {
    for (let j = 0; j < ENCODINGS.length; j++) {
      const path = PATHS[i]!;
      const enc = ENCODINGS[j]!;
      onLog(`▶ ${path.label} / ${enc}`);
      await runOne(endpoint, path, enc, (patch) => {
        setGrid((g) => {
          const out = g.map((row) => row.slice());
          out[i]![j] = { ...out[i]![j]!, ...patch };
          return out;
        });
      });
      const cell = (await new Promise<Cell>((res) => {
        setGrid((g) => {
          res(g[i]![j]!);
          return g;
        });
      }));
      if (cell.status === 'done') {
        onLog(
          `  ${cell.tokens ?? 0} tokens • ` +
          `wire ${cell.wireBytes ?? '?'} B • ` +
          `B/tok ${cell.bytesPerToken?.toFixed(2) ?? '?'} • ` +
          `total ${cell.totalMs?.toFixed(0)} ms ` +
          `[${cell.contentEncoding}]`
        );
      } else if (cell.status === 'error') {
        onLog(`  ✗ ${cell.error}`);
      }
    }
  }
  onLog('done.');
}
