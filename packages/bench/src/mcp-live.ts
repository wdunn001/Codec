/**
 * mcp-live.ts: measure MCP wire cost against a live MetaMCP gateway.
 *
 * Phase 1 of the MCP-bench plan: client → metamcp → real mcp-server →
 * metamcp → client. No inference engine in the loop. This isolates
 * the gateway+downstream-MCP cost so the engine bench (mcp-engine.ts,
 * Phase 2) has a clean baseline to subtract from.
 *
 * What it measures, per method (initialize / tools/list / tools/call):
 *   - HTTP request byte count (headers + body)
 *   - HTTP response byte count (raw socket bytes received)
 *   - Wall-clock latency
 *
 * What it compares (matrix per method):
 *   1. json                   baseline; the SDK's default wire
 *   2. msgpack-resp           Codec response; JSON request (cheapest opt-in)
 *   3. msgpack-both           Codec request + response
 *   4. msgpack-both+gzip      Codec request + response + gzip Accept-Encoding
 *   5. msgpack-both+gzip+map  same as (4) plus X-Codec-Map → tool-result text
 *                             content blocks get tokenized to ID arrays
 *                             (the deep-compression layer)
 *
 * Auth: requires a *private* MetaMCP API key (one owned by the user
 * who owns the endpoint). Pass via:
 *
 *   BENCH_MCP_URL=http://192.168.1.88:12008/metamcp/<endpoint>/mcp \
 *   BENCH_MCP_BEARER=sk_mt_… \
 *   tsx packages/bench/src/mcp-live.ts
 *
 * Public API keys against private endpoints get rejected at the
 * MetaMCP middleware with a 403 carrying the exact remedy. We surface
 * that error verbatim and exit cleanly (no traceback noise) so the
 * operator can fix the auth side and re-run.
 *
 * Optional knobs:
 *   BENCH_MCP_MAP_URL    URL of a Codec vocab map (sha256-pinned)
 *   BENCH_MCP_MAP_HASH   sha256 of that map; included in X-Codec-Map
 *   BENCH_MCP_TOOLS      comma-separated tool name allowlist
 *   BENCH_MCP_OUT_DIR    directory for results.json/results.md
 *                        (default: packages/bench/results/<UTC>/mcp/)
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encode as msgpackEncode } from '@msgpack/msgpack';

import { fmtBytes, fmtNs, fmtNum, hr, ratio, table } from './lib/format.js';

// ── Config ────────────────────────────────────────────────────────────────────

const MCP_URL =
  process.env.BENCH_MCP_URL ??
  'http://192.168.1.88:12008/metamcp/openwebui-api/mcp';
const BEARER = process.env.BENCH_MCP_BEARER ?? '';
const MAP_URL = process.env.BENCH_MCP_MAP_URL ?? '';
const MAP_HASH = process.env.BENCH_MCP_MAP_HASH ?? '';
const TOOLS_ALLOWLIST = (process.env.BENCH_MCP_TOOLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STAMP = new Date().toISOString().replace(/:/g, '-').slice(0, 19) + 'Z';
const OUT_DIR =
  process.env.BENCH_MCP_OUT_DIR ??
  join(REPO_ROOT, 'packages', 'bench', 'results', STAMP, 'mcp');

// ── Variants ──────────────────────────────────────────────────────────────────

type Variant =
  | 'json'
  | 'msgpack-resp'
  | 'msgpack-both'
  | 'msgpack-both+gzip'
  | 'msgpack-both+gzip+map';

interface VariantSpec {
  name: Variant;
  /** Whether to encode the request body as msgpack (else JSON). */
  reqMsgpack: boolean;
  /** Whether to ask the response to be msgpack (else JSON). */
  respMsgpack: boolean;
  /** Whether to advertise gzip on the response. */
  gzip: boolean;
  /** Whether to send X-Codec-Map (requires MAP_URL + MAP_HASH set). */
  codecMap: boolean;
}

const VARIANTS: VariantSpec[] = [
  { name: 'json', reqMsgpack: false, respMsgpack: false, gzip: false, codecMap: false },
  { name: 'msgpack-resp', reqMsgpack: false, respMsgpack: true, gzip: false, codecMap: false },
  { name: 'msgpack-both', reqMsgpack: true, respMsgpack: true, gzip: false, codecMap: false },
  { name: 'msgpack-both+gzip', reqMsgpack: true, respMsgpack: true, gzip: true, codecMap: false },
  { name: 'msgpack-both+gzip+map', reqMsgpack: true, respMsgpack: true, gzip: true, codecMap: true },
];

// ── HTTP plumbing (raw socket byte counting) ─────────────────────────────────
//
// fetch() hides the headers from us and gives us the decompressed body.
// That is the wrong measurement: we want the bytes that actually crossed the wire.
// So we use Node's http(s) module and tally headers + body ourselves, with
// decompression deferred until after the count is taken.

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

interface MeasuredResponse {
  status: number;
  /** Raw bytes received over the socket: headers + body. */
  wireBytes: number;
  /** Body bytes only (decompressed if Content-Encoding was set). */
  bodyDecoded: Buffer;
  contentType: string;
  contentEncoding: string;
  ttfbMs: number;
  totalMs: number;
  /** Captured response headers, lowercased keys. */
  headers: Record<string, string>;
}

function send(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
): Promise<MeasuredResponse> {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const t0 = performance.now();
  return new Promise((resolveP, rejectP) => {
    const req = lib.request(
      {
        method,
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        const ttfbMs = performance.now() - t0;
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          bodyBytes += c.byteLength;
        });
        res.on('end', () => {
          const totalMs = performance.now() - t0;
          // Approximate header bytes by re-serializing what we know: the actual
          // wire bytes from the server include the status line + headers. Node
          // doesn't expose a raw counter so we reconstruct.
          const statusLine = `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}\r\n`;
          let headerBytes = Buffer.byteLength(statusLine, 'utf8');
          const lower: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            const value = Array.isArray(v) ? v.join(', ') : (v ?? '');
            headerBytes += Buffer.byteLength(`${k}: ${value}\r\n`, 'utf8');
            lower[k.toLowerCase()] = String(value);
          }
          headerBytes += 2; // trailing \r\n
          const wireBytes = headerBytes + bodyBytes;
          const raw = Buffer.concat(chunks);
          const enc = lower['content-encoding'] ?? '';
          let bodyDecoded = raw;
          try {
            if (enc.includes('gzip')) bodyDecoded = gunzipSync(raw);
            else if (enc.includes('br')) bodyDecoded = brotliDecompressSync(raw);
          } catch (e) {
            // leave as raw if decode fails: caller will see the issue
          }
          resolveP({
            status: res.statusCode ?? 0,
            wireBytes,
            bodyDecoded,
            contentType: lower['content-type'] ?? '',
            contentEncoding: enc,
            ttfbMs,
            totalMs,
            headers: lower,
          });
        });
        res.on('error', rejectP);
      },
    );
    req.on('error', rejectP);
    if (body) req.write(body);
    req.end();
  });
}

// ── Codec frame helpers ──────────────────────────────────────────────────────
//
// Reuse the same wire format as the metamcp Codec layer: each JSON-RPC message
// is one msgpack-encoded frame with a 4-byte BE length prefix. For requests,
// metamcp's express.raw() body parser accepts the inline msgpack bytes WITHOUT
// the length prefix (since HTTP already framed it). Request bodies are
// therefore bare msgpack. For responses, every frame has the prefix; we parse them back into
// JSON-RPC objects to compare with the JSON variant.

function encodeJsonRpcReq(msg: object, variant: VariantSpec): { body: Buffer; contentType: string } {
  if (variant.reqMsgpack) {
    const enc = msgpackEncode(msg, { useBigInt64: false });
    return {
      body: Buffer.from(enc.buffer, enc.byteOffset, enc.byteLength),
      contentType: 'application/x-codec-msgpack',
    };
  }
  return {
    body: Buffer.from(JSON.stringify(msg), 'utf8'),
    contentType: 'application/json',
  };
}

function buildHeaders(variant: VariantSpec, contentType: string, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': contentType,
    Accept: variant.respMsgpack
      ? 'application/x-codec-msgpack'
      : 'application/json, text/event-stream',
  };
  if (BEARER) h['Authorization'] = `Bearer ${BEARER}`;
  if (variant.gzip) h['Accept-Encoding'] = 'gzip';
  if (sessionId) h['mcp-session-id'] = sessionId;
  if (variant.codecMap && MAP_URL && MAP_HASH) {
    h['X-Codec-Map'] = `${MAP_URL};sha256=${MAP_HASH}`;
  }
  return h;
}

/**
 * Parse a Codec response body into one or more JSON-RPC messages.
 * The body is `[len:4 BE][msgpack body]…` repeated.
 */
import { decode as msgpackDecode } from '@msgpack/msgpack';

function parseCodecBody(buf: Buffer): unknown[] {
  const messages: unknown[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    pos += 4;
    if (pos + len > buf.length) break;
    const slice = buf.subarray(pos, pos + len);
    pos += len;
    try {
      messages.push(msgpackDecode(slice));
    } catch {
      // skip frame
    }
  }
  return messages;
}

/**
 * Parse a JSON or SSE body into one or more JSON-RPC messages.
 */
function parseJsonBody(buf: Buffer, contentType: string): unknown[] {
  const text = buf.toString('utf8');
  if (contentType.includes('text/event-stream')) {
    const out: unknown[] = [];
    for (const event of text.split(/\r?\n\r?\n+/)) {
      for (const line of event.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          out.push(JSON.parse(payload));
        } catch {
          /* ignore */
        }
      }
    }
    return out;
  }
  // Single JSON object on the body, or newline-delimited.
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const out: unknown[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* ignore */
    }
  }
  return out;
}

function parseBody(resp: MeasuredResponse): unknown[] {
  if (resp.contentType.includes('application/x-codec-msgpack')) {
    return parseCodecBody(resp.bodyDecoded);
  }
  return parseJsonBody(resp.bodyDecoded, resp.contentType);
}

// ── MCP request flow ─────────────────────────────────────────────────────────

interface CallResult {
  variant: Variant;
  ok: boolean;
  status: number;
  reason?: string;
  reqBytes: number;
  reqBodyBytes: number;
  respWireBytes: number;
  respBodyDecodedBytes: number;
  ttfbMs: number;
  totalMs: number;
  /** Parsed JSON-RPC response messages. */
  messages: unknown[];
}

let nextId = 1;
const newId = () => String(nextId++);

async function call(
  variant: VariantSpec,
  method: string,
  params: unknown,
  sessionId: string | undefined,
): Promise<CallResult> {
  const req = { jsonrpc: '2.0', id: newId(), method, params };
  const { body, contentType } = encodeJsonRpcReq(req, variant);
  const headers = buildHeaders(variant, contentType, sessionId);
  // Approximate the request bytes (request line + headers + body)
  const requestLine = `POST ${new URL(MCP_URL).pathname} HTTP/1.1\r\n`;
  let headerBytes = Buffer.byteLength(requestLine, 'utf8');
  for (const [k, v] of Object.entries(headers)) {
    headerBytes += Buffer.byteLength(`${k}: ${v}\r\n`, 'utf8');
  }
  headerBytes += Buffer.byteLength(`Content-Length: ${body.length}\r\n`, 'utf8');
  headerBytes += 2;
  const reqBytes = headerBytes + body.length;

  try {
    const resp = await send(MCP_URL, 'POST', headers, body);
    const messages = parseBody(resp);
    return {
      variant: variant.name,
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      reqBytes,
      reqBodyBytes: body.length,
      respWireBytes: resp.wireBytes,
      respBodyDecodedBytes: resp.bodyDecoded.length,
      ttfbMs: resp.ttfbMs,
      totalMs: resp.totalMs,
      messages,
      reason: resp.status >= 400 ? resp.bodyDecoded.toString('utf8').slice(0, 240) : undefined,
    };
  } catch (e) {
    return {
      variant: variant.name,
      ok: false,
      status: 0,
      reason: (e as Error).message,
      reqBytes,
      reqBodyBytes: body.length,
      respWireBytes: 0,
      respBodyDecodedBytes: 0,
      ttfbMs: 0,
      totalMs: 0,
      messages: [],
    };
  }
}

// ── Session management ──────────────────────────────────────────────────────
//
// MCP Streamable HTTP requires `initialize` first; the server returns a
// `mcp-session-id` header that subsequent calls must echo. We open one session
// per variant so each variant's bytes include its own session lifetime.

async function openSession(
  variant: VariantSpec,
): Promise<{ sessionId: string; init: CallResult } | { error: string }> {
  const initParams = {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codec-mcp-bench', version: '0.1.0' },
  };
  // initialize: spec requires Accept include both application/json and
  // text/event-stream; the metamcp codec wrapper spoofs the Accept header
  // for the SDK when respMsgpack is set. This still works as a result.
  const r = await call(variant, 'initialize', initParams, undefined);
  if (!r.ok) {
    return { error: `initialize failed: HTTP ${r.status} ${r.reason ?? ''}` };
  }
  // The session id comes back as a header; we exposed it through resp.headers.
  // We need to re-issue the call so we can capture the header. Cleaner: rerun
  // openSession via send() directly?: but call() already did the work.
  // We surface the session-id here by reading the last raw response instead. Easiest fix:
  // do the initialize via send() inline so we keep the headers.
  return { sessionId: '', init: r }; // overwritten below
}

// Inline version that keeps headers around: we need this for the session-id.
async function initializeSession(
  variant: VariantSpec,
): Promise<{ ok: true; sessionId: string; result: CallResult } | { ok: false; error: string }> {
  const req = {
    jsonrpc: '2.0',
    id: newId(),
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codec-mcp-bench', version: '0.1.0' },
    },
  };
  const { body, contentType } = encodeJsonRpcReq(req, variant);
  const headers = buildHeaders(variant, contentType, undefined);
  const requestLine = `POST ${new URL(MCP_URL).pathname} HTTP/1.1\r\n`;
  let headerBytes = Buffer.byteLength(requestLine, 'utf8');
  for (const [k, v] of Object.entries(headers)) {
    headerBytes += Buffer.byteLength(`${k}: ${v}\r\n`, 'utf8');
  }
  headerBytes += Buffer.byteLength(`Content-Length: ${body.length}\r\n`, 'utf8');
  headerBytes += 2;
  const reqBytes = headerBytes + body.length;

  let resp: MeasuredResponse;
  try {
    resp = await send(MCP_URL, 'POST', headers, body);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  if (resp.status < 200 || resp.status >= 300) {
    return {
      ok: false,
      error: `initialize HTTP ${resp.status}: ${resp.bodyDecoded.toString('utf8').slice(0, 240)}`,
    };
  }
  const sessionId = resp.headers['mcp-session-id'] ?? '';
  if (!sessionId) {
    return { ok: false, error: 'initialize: server did not return mcp-session-id header' };
  }
  const messages = parseBody(resp);
  return {
    ok: true,
    sessionId,
    result: {
      variant: variant.name,
      ok: true,
      status: resp.status,
      reqBytes,
      reqBodyBytes: body.length,
      respWireBytes: resp.wireBytes,
      respBodyDecodedBytes: resp.bodyDecoded.length,
      ttfbMs: resp.ttfbMs,
      totalMs: resp.totalMs,
      messages,
    },
  };
}

// ── Probe + tool enumeration ─────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

async function listTools(sessionId: string): Promise<ToolDef[]> {
  const variant = VARIANTS[0]!; // JSON for enumeration
  const r = await call(variant, 'tools/list', {}, sessionId);
  if (!r.ok) throw new Error(`tools/list failed: HTTP ${r.status} ${r.reason ?? ''}`);
  for (const m of r.messages) {
    const result = (m as { result?: { tools?: ToolDef[] } }).result;
    if (result?.tools) return result.tools;
  }
  return [];
}

/** Build a minimal valid `arguments` payload for a tool from its schema.
 *  Filling in required string fields with a tiny prompt. */
function synthArgs(tool: ToolDef): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (!schema?.properties) return {};
  const out: Record<string, unknown> = {};
  const required = schema.required ?? [];
  for (const key of required) {
    const prop = schema.properties[key] as { type?: string } | undefined;
    if (!prop) continue;
    switch (prop.type) {
      case 'string':
        out[key] = key.includes('query') || key.includes('q')
          ? 'test'
          : key.includes('url')
            ? 'https://example.com'
            : 'codec-bench';
        break;
      case 'number':
      case 'integer':
        out[key] = 1;
        break;
      case 'boolean':
        out[key] = false;
        break;
      case 'array':
        out[key] = [];
        break;
      case 'object':
        out[key] = {};
        break;
      default:
        out[key] = null;
    }
  }
  return out;
}

// ── Reporting ────────────────────────────────────────────────────────────────

interface MethodReport {
  method: string;
  toolName?: string;
  rows: CallResult[];
}

function reportTable(report: MethodReport, baselineRespBytes: number): string {
  const rows: string[][] = [];
  for (const r of report.rows) {
    const reduction = r.ok && baselineRespBytes > 0
      ? ratio(baselineRespBytes, r.respWireBytes)
      : 'n/a';
    rows.push([
      r.variant,
      r.ok ? `${r.status}` : `${r.status} ${(r.reason ?? '').slice(0, 40)}`,
      fmtBytes(r.reqBytes),
      fmtBytes(r.respWireBytes),
      reduction,
      fmtNs(r.ttfbMs * 1e6),
      fmtNs(r.totalMs * 1e6),
    ]);
  }
  return table(
    ['variant', 'status', 'req', 'resp (wire)', 'resp vs json', 'TTFB', 'total'],
    rows,
  );
}

function writeReports(reports: MethodReport[], summary: Record<string, unknown>): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const md: string[] = [];
  md.push(`# MCP wire bench: ${STAMP}`);
  md.push('');
  md.push(`Target: \`${MCP_URL}\``);
  md.push(`Vocab map: ${MAP_URL && MAP_HASH ? `\`${MAP_URL}\` (sha256 \`${MAP_HASH.slice(0, 12)}…\`)` : '_not configured (msgpack-both+gzip+map will be skipped)_'}`);
  md.push('');
  for (const r of reports) {
    const baseline = r.rows.find((x) => x.variant === 'json');
    const baseRespBytes = baseline?.ok ? baseline.respWireBytes : 0;
    md.push(`## ${r.method}${r.toolName ? `: \`${r.toolName}\`` : ''}`);
    md.push('');
    md.push(reportTable(r, baseRespBytes));
    md.push('');
  }
  writeFileSync(join(OUT_DIR, 'mcp-live.md'), md.join('\n'), 'utf8');
  writeFileSync(
    join(OUT_DIR, 'mcp-live.json'),
    JSON.stringify({ stamp: STAMP, target: MCP_URL, summary, reports }, null, 2),
    'utf8',
  );
  console.log(`\nWrote ${join(OUT_DIR, 'mcp-live.md')}`);
  console.log(`Wrote ${join(OUT_DIR, 'mcp-live.json')}`);
}

// ── Probe ────────────────────────────────────────────────────────────────────

async function probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!BEARER) {
    return {
      ok: false,
      reason:
        'BENCH_MCP_BEARER not set. Generate a *private* MetaMCP API key (the\n' +
        'one owned by the user who owns the endpoint), then re-run:\n' +
        `  BENCH_MCP_BEARER=sk_mt_… tsx packages/bench/src/mcp-live.ts`,
    };
  }
  // Minimal initialize handshake to see if auth works.
  const r = await initializeSession(VARIANTS[0]!);
  if (r.ok) return { ok: true };
  return { ok: false, reason: r.error };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('# MCP wire bench\n');
  console.log(`Target:  ${MCP_URL}`);
  console.log(`Bearer:  ${BEARER ? BEARER.slice(0, 10) + '…' : '<none>'}`);
  console.log(`MapURL:  ${MAP_URL || '<none>'}`);
  console.log(`MapHash: ${MAP_HASH ? MAP_HASH.slice(0, 12) + '…' : '<none>'}`);
  console.log();

  const p = await probe();
  if (!p.ok) {
    console.log(`Skip: ${p.reason}\n`);
    process.exit(0);
  }

  const variants = VARIANTS.filter((v) => {
    if (v.codecMap && (!MAP_URL || !MAP_HASH)) return false;
    return true;
  });

  // ── initialize ──
  console.log(hr('initialize'));
  console.log();
  const initReports: CallResult[] = [];
  const sessions: Record<Variant, string> = {} as Record<Variant, string>;
  for (const v of variants) {
    const r = await initializeSession(v);
    if (r.ok) {
      sessions[v.name] = r.sessionId;
      initReports.push(r.result);
    } else {
      initReports.push({
        variant: v.name,
        ok: false,
        status: 0,
        reason: r.error.slice(0, 80),
        reqBytes: 0,
        reqBodyBytes: 0,
        respWireBytes: 0,
        respBodyDecodedBytes: 0,
        ttfbMs: 0,
        totalMs: 0,
        messages: [],
      });
    }
  }
  const initBaseline = initReports.find((x) => x.variant === 'json' && x.ok)?.respWireBytes ?? 0;
  console.log(reportTable({ method: 'initialize', rows: initReports }, initBaseline));
  console.log();

  // ── tools/list ──
  console.log(hr('tools/list'));
  console.log();
  const listReports: CallResult[] = [];
  for (const v of variants) {
    const sid = sessions[v.name];
    if (!sid) {
      listReports.push({
        variant: v.name,
        ok: false,
        status: 0,
        reason: 'no session',
        reqBytes: 0,
        reqBodyBytes: 0,
        respWireBytes: 0,
        respBodyDecodedBytes: 0,
        ttfbMs: 0,
        totalMs: 0,
        messages: [],
      });
      continue;
    }
    const r = await call(v, 'tools/list', {}, sid);
    listReports.push(r);
  }
  const listBaseline = listReports.find((x) => x.variant === 'json' && x.ok)?.respWireBytes ?? 0;
  console.log(reportTable({ method: 'tools/list', rows: listReports }, listBaseline));
  console.log();

  // ── tools/call (per tool) ──
  let tools: ToolDef[] = [];
  try {
    const jsonSid = sessions['json'];
    if (jsonSid) tools = await listTools(jsonSid);
  } catch (e) {
    console.log(`tools/list enumeration failed: ${(e as Error).message}\n`);
  }

  if (TOOLS_ALLOWLIST.length) {
    tools = tools.filter((t) => TOOLS_ALLOWLIST.includes(t.name));
  }

  console.log(`Discovered ${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.map((t) => t.name).join(', ') || '<none>'}`);
  console.log();

  const callReports: MethodReport[] = [];
  for (const tool of tools) {
    console.log(hr(`tools/call: ${tool.name}`));
    console.log();
    const args = synthArgs(tool);
    const rows: CallResult[] = [];
    for (const v of variants) {
      const sid = sessions[v.name];
      if (!sid) continue;
      const r = await call(v, 'tools/call', { name: tool.name, arguments: args }, sid);
      rows.push(r);
    }
    const base = rows.find((x) => x.variant === 'json' && x.ok)?.respWireBytes ?? 0;
    console.log(reportTable({ method: 'tools/call', toolName: tool.name, rows }, base));
    console.log();
    callReports.push({ method: 'tools/call', toolName: tool.name, rows });
  }

  // ── Persist ──
  const reports: MethodReport[] = [
    { method: 'initialize', rows: initReports },
    { method: 'tools/list', rows: listReports },
    ...callReports,
  ];
  writeReports(reports, {
    target: MCP_URL,
    bearer_present: !!BEARER,
    map_configured: !!(MAP_URL && MAP_HASH),
    tool_count: tools.length,
    tool_names: tools.map((t) => t.name),
    variants_run: variants.map((v) => v.name),
  });

  console.log(hr('summary'));
  console.log();
  console.log(
    `Phase 1 (no-engine) bench complete. ${reports.length} method group${
      reports.length === 1 ? '' : 's'
    } measured across ${variants.length} variants. The msgpack-resp row\n` +
      `is the cheapest opt-in (clients keep posting JSON, just ask for Codec\n` +
      `back); msgpack-both+gzip is the production-shape lane; +map is the\n` +
      `deep-compression layer that tokenizes tool-result text content into\n` +
      `Codec ID arrays at the gateway boundary.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
