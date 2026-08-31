import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

describe('codec-time-tool', () => {
  test('cache exists for the default model', () => {
    const cacheFile = join(ROOT, 'cache', 'qwen25-0.5b-instruct.json');
    assert.ok(existsSync(cacheFile), 'cache should be built before tests: run `npm run build:cache`');
  });

  test('CLI returns response IDs for iso format', () => {
    const result = spawnSync('node', ['dist/index.js', 'iso'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CODEC_MODEL_ID: 'Qwen/Qwen2.5-0.5B-Instruct' },
    });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /format:\s+iso/);
    assert.match(result.stdout, /response IDs \(\d+\)/);
  });

  test('CLI returns response IDs for human format', () => {
    const result = spawnSync('node', ['dist/index.js', 'human'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CODEC_MODEL_ID: 'Qwen/Qwen2.5-0.5B-Instruct' },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /format:\s+human/);
  });

  test('CLI refuses on unknown model (no binding)', () => {
    const result = spawnSync('node', ['dist/index.js'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CODEC_MODEL_ID: 'unknown-model-xyz' },
    });
    assert.notEqual(result.status, 0, 'should fail when no binding for active model');
    assert.match(result.stderr, /no cache for model/);
  });
});
