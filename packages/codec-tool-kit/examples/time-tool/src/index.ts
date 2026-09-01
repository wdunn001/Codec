#!/usr/bin/env node
/**
 * codec-time-tool: reference Codec-native bolt-on tool.
 *
 * Demonstrates the @codecai/tool-kit pattern end-to-end:
 *   1. Load the precompiled cache (built by scripts/build-cache.ts)
 *   2. Verify the cache's tokenizer hash matches the gateway's active model
 *   3. On each call, look up the relevant fragment(s) by id
 *   4. Return response token IDs: no tokenize on the hot path
 *
 * The whole tool is a hashtable lookup. Even the template-rendered
 * "It is currently 14:23:55 UTC." response tokenizes only the digit
 * slot ("14:23:55"); everything else is cached.
 *
 * Run modes:
 *   - As a CLI demo (default):   node dist/index.js
 *   - As a stdio tool server:    pipe JSON-RPC tool/call requests to stdin
 *   - As a library: import { handleCall } and wire it into your own dispatcher
 *
 * Production deployments would also implement the bolt-on wire format
 * (gateway ↔ tool, msgpack/protobuf framed): that contract lives in
 * spec/PROTOCOL.md § Tool-call calling conventions and is unchanged
 * from the in-process MCP path; only the transport switches to a
 * tool-author-hosted HTTP/unix-socket endpoint.
 */
import { findBinding, validateManifest, type ToolManifest } from '@codecai/tool-kit';
import {
  renderTemplate,
  verifyCache,
  type Tokenizer,
  type ToolCache,
  type TemplateEntry,
  type StaticEntry,
} from '@codecai/tool-kit/precache';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname); // examples/time-tool

// Stub slot tokenizer: same shape as the build-time one. Production
// would load the real tokenizer here. This is the only place the tool
// pays runtime tokenization. It only sees slot values (digits,
// dates): typically <20 chars total per call.
function stubTokenizer(modelId: string): Tokenizer {
  const encode = (text: string): number[] => {
    const ids: number[] = [];
    for (let i = 0; i < text.length; i += 2) {
      const a = text.charCodeAt(i);
      const b = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      const h = (a * 1009 + b * 31 + modelId.length) >>> 0;
      ids.push(h % 150_000);
    }
    return ids;
  };
  const hash = (): string => {
    let h = 5381;
    for (const c of modelId) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
    return `sha256:${h.toString(16).padStart(64, '0')}`;
  };
  return { encode, hash };
}

// Load manifest + the cache for the active model. Production tools
// receive `modelId` from the gateway as part of the bolt-on handshake.
const manifest: ToolManifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
validateManifest(manifest);

const activeModelId = process.env.CODEC_MODEL_ID ?? 'Qwen/Qwen2.5-0.5B-Instruct';
const binding = findBinding(manifest, activeModelId);
if (!binding) {
  console.error(`[codec-time-tool] no cache for model ${activeModelId}: would fall back to text mode`);
  process.exit(1);
}

const cache: ToolCache = JSON.parse(readFileSync(join(ROOT, binding.cacheFile), 'utf8'));
const tokenizer = stubTokenizer(activeModelId);
if (!verifyCache(cache, tokenizer.hash())) {
  console.error('[codec-time-tool] cache tokenizer hash mismatch: refusing to start');
  process.exit(2);
}

// ── Tool runtime ─────────────────────────────────────────────────

export interface TimeArgs {
  format?: 'iso' | 'human';
}

/**
 * Handle one tool call. Returns the response as response token IDs
 * (pre-cached + slot-only runtime tokenize). In production this is
 * called from the bolt-on transport handler (HTTP or unix socket);
 * here it's exposed directly so tests can poke it.
 */
export function handleCall(args: TimeArgs): number[] {
  const format = args.format ?? 'iso';
  const now = new Date();
  const iso = now.toISOString();

  if (format === 'iso') {
    const tpl = cache.fragments['iso-line'] as TemplateEntry;
    return renderTemplate(tpl, {
      date: iso.slice(0, 10),   // 2026-05-17
      time: iso.slice(11, 19),  // 02:30:15
    }, tokenizer);
  }

  if (format === 'human') {
    const tpl = cache.fragments['human-line'] as TemplateEntry;
    return renderTemplate(tpl, {
      time: iso.slice(11, 19),  // 02:30:15
    }, tokenizer);
  }

  // Bad format → static error response (zero runtime tokenization)
  return (cache.fragments['err-bad-format'] as StaticEntry).ids;
}

// ── CLI demo ─────────────────────────────────────────────────────
// Runs whenever this file is executed (always: it's the `bin` entry).
// To use as a library, import { handleCall } from the package instead
// of running the bin.
const cliFormat = (process.argv[2] as 'iso' | 'human' | undefined) ?? 'iso';
const cliIds = handleCall({ format: cliFormat });
console.log(`model:       ${activeModelId}`);
console.log(`format:      ${cliFormat}`);
console.log(`response IDs (${cliIds.length}): [${cliIds.slice(0, 16).join(',')}${cliIds.length > 16 ? ', …' : ''}]`);
console.log(`(would be memcpy'd into the model's generation context: no detokenize, no JSON envelope)`);
