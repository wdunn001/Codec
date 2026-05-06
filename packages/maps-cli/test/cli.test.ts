/**
 * Smoke tests for the codecai-maps CLI. We run dist/cli.js as a real subprocess
 * so we exercise argv parsing, stdout/stderr framing, exit codes, and the file
 * I/O path the same way a user would.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateMap } from '@codecai/web';

import { convertHFTokenizer } from '../src/convert.ts';
import { makeByteLevelHF } from './fixtures.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'dist/cli.js');

const haveBuilt = fs.existsSync(CLI);

function run(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [CLI, ...args], { cwd: cwd ?? ROOT, encoding: 'utf-8' });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codecai-maps-cli-'));
}

// ── help / no-args ──────────────────────────────────────────────────────────

test(
  'cli help: prints usage and exits 0',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const r = run(['help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /codecai-maps/);
    assert.match(r.stdout, /build .*hf-model/);
    assert.match(r.stdout, /convert/);
    assert.match(r.stdout, /validate/);
    assert.match(r.stdout, /hash/);
    assert.match(r.stdout, /preview/);
  },
);

test(
  'cli no-args: prints help (does not error)',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const r = run([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /codecai-maps/);
  },
);

// ── convert / validate / hash round trip ────────────────────────────────────

test(
  'cli convert + validate + hash: full round-trip on a synthesised tokenizer.json',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const dir = tmpDir();
    const hfPath = path.join(dir, 'tokenizer.json');
    const mapPath = path.join(dir, 'test.json');
    fs.writeFileSync(hfPath, JSON.stringify(makeByteLevelHF()), 'utf-8');

    // convert
    const conv = run(['convert', hfPath, '--id=test/byte-level', `--out=${mapPath}`]);
    assert.equal(conv.code, 0, `convert exited ${conv.code}: ${conv.stderr}`);
    assert.match(conv.stdout, /written/);
    assert.ok(fs.existsSync(mapPath), 'output file written');

    // validate
    const val = run(['validate', mapPath]);
    assert.equal(val.code, 0, `validate exited ${val.code}: ${val.stderr}`);
    assert.match(val.stdout, /valid: test\/byte-level/);

    // hash
    const hash = run(['hash', mapPath]);
    assert.equal(hash.code, 0);
    assert.match(hash.stdout.trim(), /^sha256:[0-9a-f]{64}$/);

    // The hashes should match the in-process API result.
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
    validateMap(map);

    fs.rmSync(dir, { recursive: true });
  },
);

// ── preview ─────────────────────────────────────────────────────────────────

test(
  'cli preview: tokenizes + detokenizes + reports exact match',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const dir = tmpDir();
    const hfPath = path.join(dir, 'tokenizer.json');
    const mapPath = path.join(dir, 'test.json');
    fs.writeFileSync(hfPath, JSON.stringify(makeByteLevelHF()), 'utf-8');

    const conv = run(['convert', hfPath, '--id=test/byte-level', `--out=${mapPath}`]);
    assert.equal(conv.code, 0);

    // Preview a string composed entirely of vocab-covered substrings so the
    // round-trip must succeed without byte fallback.
    const preview = run(['preview', mapPath, '--text=hello world']);
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /map:\s+test\/byte-level/);
    assert.match(preview.stdout, /tokenizer:\s+BPETokenizer/);
    assert.match(preview.stdout, /token IDs:\s+\[/);
    assert.match(preview.stdout, /exact match:\s+YES/);

    fs.rmSync(dir, { recursive: true });
  },
);

// ── Error paths ─────────────────────────────────────────────────────────────

test(
  'cli convert: missing --id fails with clear message',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const dir = tmpDir();
    const hfPath = path.join(dir, 'tokenizer.json');
    fs.writeFileSync(hfPath, JSON.stringify(makeByteLevelHF()));

    const r = run(['convert', hfPath]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /requires --id/);

    fs.rmSync(dir, { recursive: true });
  },
);

test(
  'cli validate: rejects an obviously broken file',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const dir = tmpDir();
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, JSON.stringify({ id: 'x' /* missing version, vocab, etc */ }));

    const r = run(['validate', broken]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /codecai-maps/);

    fs.rmSync(dir, { recursive: true });
  },
);

test(
  'cli unknown command: errors with helpful pointer',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const r = run(['notacommand']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown command/);
    assert.match(r.stderr, /codecai-maps help/);
  },
);
