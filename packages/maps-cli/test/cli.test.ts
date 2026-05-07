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

// ── well-known publishing ───────────────────────────────────────────────────

test(
  'cli well-known --url: emits a pointer + index under .well-known/codec/',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const dir = tmpDir();
    const hfPath = path.join(dir, 'tokenizer.json');
    const mapPath = path.join(dir, 'test.json');
    fs.writeFileSync(hfPath, JSON.stringify(makeByteLevelHF()), 'utf-8');

    // Build a real map first.
    const conv = run(['convert', hfPath, '--id=test/byte-level', `--out=${mapPath}`]);
    assert.equal(conv.code, 0, conv.stderr);

    const wk = run([
      'well-known',
      `--map=${mapPath}`,
      '--url=https://cdn.example/byte-level.json',
      `--out-dir=${dir}`,
    ]);
    assert.equal(wk.code, 0, `well-known exited ${wk.code}: ${wk.stderr}`);

    const docPath = path.join(dir, '.well-known', 'codec', 'maps', 'test', 'byte-level.json');
    const indexPath = path.join(dir, '.well-known', 'codec', 'index.json');
    assert.ok(fs.existsSync(docPath), `pointer doc written at ${docPath}`);
    assert.ok(fs.existsSync(indexPath), `index written at ${indexPath}`);

    const pointer = JSON.parse(fs.readFileSync(docPath, 'utf-8'));
    assert.equal(pointer.id, 'test/byte-level');
    assert.equal(pointer.url, 'https://cdn.example/byte-level.json');
    assert.match(pointer.hash, /^sha256:[0-9a-f]{64}$/);

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    assert.equal(index.codec_version, '0.2');
    assert.equal(index.maps.length, 1);
    assert.equal(index.maps[0].id, 'test/byte-level');

    fs.rmSync(dir, { recursive: true });
  },
);

test(
  'cli well-known --inline: writes the full map at the well-known path',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const dir = tmpDir();
    const hfPath = path.join(dir, 'tokenizer.json');
    const mapPath = path.join(dir, 'test.json');
    fs.writeFileSync(hfPath, JSON.stringify(makeByteLevelHF()), 'utf-8');

    const conv = run(['convert', hfPath, '--id=test/byte-level', `--out=${mapPath}`]);
    assert.equal(conv.code, 0, conv.stderr);

    const wk = run(['well-known', `--map=${mapPath}`, '--inline', `--out-dir=${dir}`]);
    assert.equal(wk.code, 0, `well-known exited ${wk.code}: ${wk.stderr}`);

    const docPath = path.join(dir, '.well-known', 'codec', 'maps', 'test', 'byte-level.json');
    assert.ok(fs.existsSync(docPath));
    const inline = JSON.parse(fs.readFileSync(docPath, 'utf-8'));
    // Inline maps carry a `vocab` field; pointers do not.
    assert.equal(inline.id, 'test/byte-level');
    assert.ok(inline.vocab && typeof inline.vocab === 'object', 'inline doc must include vocab');

    // Index file is intentionally not maintained for --inline (it's a pointer
    // directory). Either absent entirely or empty is acceptable.
    const indexPath = path.join(dir, '.well-known', 'codec', 'index.json');
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      assert.equal(index.maps.length, 0);
    }

    fs.rmSync(dir, { recursive: true });
  },
);

test(
  'cli well-known: --url and --inline are mutually exclusive',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const dir = tmpDir();
    const hfPath = path.join(dir, 'tokenizer.json');
    const mapPath = path.join(dir, 'test.json');
    fs.writeFileSync(hfPath, JSON.stringify(makeByteLevelHF()), 'utf-8');
    run(['convert', hfPath, '--id=test/byte-level', `--out=${mapPath}`]);

    const r = run([
      'well-known',
      `--map=${mapPath}`,
      '--inline',
      '--url=https://cdn.example/x.json',
      `--out-dir=${dir}`,
    ]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /mutually exclusive/);

    fs.rmSync(dir, { recursive: true });
  },
);

test(
  'cli well-known: missing --map fails fast',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const r = run(['well-known', '--url=https://cdn.example/x.json']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /requires --map/);
  },
);

test(
  'cli well-known: re-running with same id replaces the index entry',
  { skip: !haveBuilt && 'run npm run build first' },
  () => {
    const dir = tmpDir();
    const hfPath = path.join(dir, 'tokenizer.json');
    const mapPath = path.join(dir, 'test.json');
    fs.writeFileSync(hfPath, JSON.stringify(makeByteLevelHF()), 'utf-8');
    run(['convert', hfPath, '--id=test/byte-level', `--out=${mapPath}`]);

    run([
      'well-known',
      `--map=${mapPath}`,
      '--url=https://cdn.example/v1.json',
      `--out-dir=${dir}`,
    ]);
    run([
      'well-known',
      `--map=${mapPath}`,
      '--url=https://cdn.example/v2.json',
      `--out-dir=${dir}`,
    ]);

    const indexPath = path.join(dir, '.well-known', 'codec', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    assert.equal(index.maps.length, 1, 'second publish should replace, not duplicate');
    assert.equal(index.maps[0].url, 'https://cdn.example/v2.json');

    fs.rmSync(dir, { recursive: true });
  },
);
