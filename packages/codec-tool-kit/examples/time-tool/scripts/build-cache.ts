#!/usr/bin/env tsx
/**
 * Build-time cache compiler for codec-time-tool.
 *
 * Walks the manifest's `models[]` and, for each one, tokenizes the
 * static response fragments + template skeleton once. Writes a compact
 * JSON cache per model into ./cache/.
 *
 * The runtime in src/index.ts then loads the cache, verifies the
 * tokenizer hash against the gateway's active model, and emits
 * response token IDs by memcpy: never tokenizing on the hot path.
 *
 * Real deployments would plug in @huggingface/tokenizers, tiktoken,
 * sentencepiece, or whatever the model's native tokenizer is. This
 * reference script ships with a stub tokenizer (deterministic
 * char-bucket hash) so the cache file builds without pulling in a
 * heavy ML dependency just for a demo. Replace the `stubTokenizer`
 * with your real one: the rest of the pattern is unchanged.
 */
import { precache, type Fragment, type Tokenizer } from '@codecai/tool-kit/precache';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

// ── Stub tokenizer ────────────────────────────────────────────────
// Deterministic but fake: assigns a stable uint32 per character chunk.
// Replace with a real BPE tokenizer in production. The cache file
// shape is identical; only the actual ID values change.
function stubTokenizer(modelId: string): Tokenizer {
  // Trivial char-pair hash → uint32 in the typical vocab range.
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
  // Tokenizer hash: in production = sha256 of the tokenizer file.
  // Here = stable hash of modelId so the cache is reproducible.
  const hash = (): string => {
    let h = 5381;
    for (const c of modelId) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
    return `sha256:${h.toString(16).padStart(64, '0')}`;
  };
  return { encode, hash };
}

// ── Fragments this tool emits ─────────────────────────────────────
// The whole tool only ever produces a few shapes. Every one of them
// gets pre-tokenized once here so the runtime path is pure memcpy.
const fragments: Fragment[] = [
  // Human-format prefix/suffix
  { id: 'human-prefix', kind: 'static', text: 'It is currently ' },
  { id: 'human-suffix', kind: 'static', text: ' UTC.' },
  // Human-format template with HH:MM:SS slot
  { id: 'human-line', kind: 'template', text: 'It is currently {time} UTC.' },
  // ISO-format template
  { id: 'iso-line', kind: 'template', text: '{date}T{time}Z' },
  // Common error shapes
  { id: 'err-bad-format', kind: 'static', text: 'Error: format must be "iso" or "human".' },
];

// ── Build cache per supported model ───────────────────────────────
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const cacheDir = join(ROOT, 'cache');
mkdirSync(cacheDir, { recursive: true });

for (const model of manifest.models) {
  const tokenizer = stubTokenizer(model.modelId);
  const cache = precache({ fragments, tokenizer });

  // Patch the manifest's recorded hash to match the (stub) tokenizer's
  // actual hash. In production you'd refuse to write if these diverge
  //: the manifest's hash is the trust anchor that the gateway checks.
  const manifestPath = join(ROOT, 'manifest.json');
  model.tokenizerHash = cache.tokenizerHash;

  const outFile = join(ROOT, model.cacheFile);
  writeFileSync(outFile, JSON.stringify(cache, null, 2));
  console.log(`built ${model.cacheFile} (${cache.tokenizerHash.slice(0, 19)}…)`);

  // Update manifest with hash patch
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

console.log(`cache built for ${manifest.models.length} model(s)`);
