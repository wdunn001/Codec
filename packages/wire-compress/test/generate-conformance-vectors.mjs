#!/usr/bin/env node
/*
 * generate-conformance-vectors.mjs — produce the cross-language picker
 * vector set from the TS reference implementation.
 *
 * Output: packages/wire-compress/test/conformance-vectors.json
 *
 * The C# (Codec.Net) and C (libcodec) ports replay this set against
 * their own picker; CI fails if any case diverges. See:
 *   - packages/dotnet/test/Codec.Net.Tests/PickerConformanceTests.cs
 *   - packages/c/test/test_wire_picker.c
 *
 * Run from the wire-compress dir:
 *   node test/generate-conformance-vectors.mjs
 *
 * Determinism: the random sample bytes use a seeded PRNG (xorshift32) so
 * the vector file is byte-identical across runs and OSes, which keeps
 * CI fingerprints stable.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { pick, STACK_PROFILES } from '../src/index.ts';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Seeded PRNG so the vector file is reproducible byte-for-byte.
function xorshift32(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5;  s >>>= 0;
    return s;
  };
}

function randomBytes(prng, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = prng() & 0xff;
  return out;
}

function makeLowEntropySample(prng, n) {
  // 95% same byte + 5% noise → entropy << 3.0.
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (prng() % 100) < 5 ? (prng() & 0xff) : 0x41;
  }
  return out;
}

const ACCEPT_HEADERS = [
  null,
  '',
  'identity',
  'gzip',
  'br',
  'zstd',
  'gzip, br',
  'gzip, br, zstd',
  'zstd, gzip, br',
  'br;q=0.5, gzip;q=1.0, zstd;q=0.8',
  'gzip;q=0, zstd;q=1.0',
  'gzip, identity;q=0',
  'br;q=1.0, gzip;q=1.0',
  '*;q=0',
  'gzip;q=1.0, br;q=0.5',
];

const SIZES = [16, 64, 128, 200, 256, 512, 1024, 4096, 8192];

const STACK_NAMES = [undefined, 'default', 'sglang', 'llama.cpp'];

const FLAG_COMBOS = [
  { zstdHasDict: false, zstdEnabled: true },
  { zstdHasDict: true,  zstdEnabled: true },
  { zstdHasDict: true,  zstdEnabled: false },
  { zstdHasDict: false, zstdEnabled: false },
];

const INTERACTIVE = [true, false];

const prng = xorshift32(0xC0DEC517);
const lowEntSample = makeLowEntropySample(prng, 256);
const highEntSample = randomBytes(prng, 256);

const SAMPLE_CASES = [
  { id: 'none',         bytes: null },
  { id: 'low-entropy',  bytes: lowEntSample },
  { id: 'high-entropy', bytes: highEntSample },
];

const vectors = [];
let id = 0;

for (const accept of ACCEPT_HEADERS) {
  for (const size of SIZES) {
    for (const stackName of STACK_NAMES) {
      for (const flags of FLAG_COMBOS) {
        for (const interactive of INTERACTIVE) {
          for (const sample of SAMPLE_CASES) {
            const input = {
              acceptEncoding: accept,
              estimatedSize: size,
              interactive,
              zstdHasDict: flags.zstdHasDict,
              zstdEnabled: flags.zstdEnabled,
              stackProfile: stackName ? STACK_PROFILES[stackName] : undefined,
              sampleBytes: sample.bytes ?? undefined,
            };
            const r = pick(input);
            vectors.push({
              id: id++,
              accept_encoding: accept,
              estimated_size: size,
              interactive,
              zstd_has_dict: flags.zstdHasDict,
              zstd_enabled: flags.zstdEnabled,
              stack_profile: stackName ?? null,
              sample: sample.id,
              expect_encoding: r.encoding,
              expect_reason_code: r.reason_code,
            });
          }
        }
      }
    }
  }
}

// Bundle the two non-empty samples as base64 so cross-language test
// runners can replay byte-identical bytes without re-implementing the
// PRNG.
function b64(u8) {
  return Buffer.from(u8).toString('base64');
}

const out = {
  generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  generator: 'packages/wire-compress/test/generate-conformance-vectors.mjs',
  ts_reference_version: '0.5.0',
  samples: {
    'low-entropy':  b64(lowEntSample),
    'high-entropy': b64(highEntSample),
  },
  count: vectors.length,
  vectors,
};

const outPath = path.join(__dirname, 'conformance-vectors.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${vectors.length} vectors → ${outPath}`);
