#!/usr/bin/env node
// =============================================================================
// Codec / scripts/check-no-emdash.mjs
// BUILD GUARD + regression check: fail if any text file contains a forbidden
// dash. HARD PROJECT RULE: never ship an em-dash, en-dash, or horizontal bar
// in user-facing text, docs, commit messages, or code comments. Ported from
// the same-named guard in storyplane-web; see that repo's script for the
// original.
//
// Forbidden code points (this file is deliberately kept ASCII-only so the
// guard never trips on its own source):
//   U+2012 FIGURE DASH        (UTF-8 bytes e2 80 92)
//   U+2013 EN DASH            (UTF-8 bytes e2 80 93)
//   U+2014 EM DASH            (UTF-8 bytes e2 80 94)
//   U+2015 HORIZONTAL BAR     (UTF-8 bytes e2 80 95)
//
// Modes:
//   node scripts/check-no-emdash.mjs            scan every git-tracked text
//                                                file (git ls-files from the
//                                                repo root)
//   node scripts/check-no-emdash.mjs --walk [dir...]
//                                                walk the filesystem instead
//                                                of git (useful inside a
//                                                Docker build stage where
//                                                git / .git is not present).
//                                                Default dir is the current
//                                                working directory.
//
// Known trap (recorded from the storyplane-web deploy): this guard only sees
// what `git ls-files` returns, i.e. files already tracked at the point it
// runs. A pre-commit hook invocation can miss a file added in the same commit
// if the hook runs before `git add` finishes staging it. Running this guard
// in CI against a full post-checkout clone (as the accompanying
// .github/workflows/lint-prose.yml does) sidesteps that: CI always sees the
// complete tracked tree for the commit under test, so nothing new can slip
// through the way it can past a pre-commit hook.
//
// Exit 0 when clean, exit 1 (with path:line:col + snippet + total) on any hit.
// =============================================================================
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { relative, join, basename, extname } from 'node:path';

const FORBIDDEN = {
  0x2012: 'U+2012 FIGURE DASH',
  0x2013: 'U+2013 EN DASH',
  0x2014: 'U+2014 EM DASH',
  0x2015: 'U+2015 HORIZONTAL BAR',
};

// Directories never scanned (huge, third-party, generated, or virtualenv).
const SKIP_DIRS = new Set([
  '.git', '.venv', 'venv', 'node_modules', 'dist', 'build', 'target',
  'coverage', '.astro', '.vite', 'bin', 'obj', '__pycache__', '.pytest_cache',
  '.mypy_cache', 'vcpkg_installed', '_deps',
]);
// Directories skipped only as path *substrings* below the repo root, for
// spots that are generated but live under an otherwise-scanned tree.
const SKIP_PATH_SUBSTRINGS = [
  '/packages/demo-c/build/',
  '/packages/bench/results/', // timestamped bench run snapshots: generated
  '/coverage/tmp/',
];
// Files never scanned (dependency lockfiles are machine-generated).
const SKIP_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock',
]);
// Test fixture files whose exact bytes are load-bearing golden/reference
// data rather than prose we authored; changing them would change what a
// test asserts, not just how it reads.
const SKIP_EXACT_FILES = new Set([
  'packages/bench/golden/qwen2.json',
]);
// Extensions treated as binary without inspection.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.wasm', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.pdf', '.zip', '.gz', '.tar', '.mp4', '.mov', '.mp3', '.wav',
  '.jar', '.class', '.pyc', '.nupkg', '.dict',
]);

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Cheap ASCII-safe pre-filter: every forbidden dash begins with UTF-8 byte 0xE2.
function mightContainDash(buf) {
  return buf.includes(0xe2);
}

function listWalk(roots) {
  const out = [];
  const stack = roots.length ? [...roots] : ['.'];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(basename(p))) continue;
      for (const name of readdirSync(p)) stack.push(join(p, name));
    } else if (st.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function listGit() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const raw = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  return raw.split('\0').filter(Boolean).map((f) => join(root, f));
}

const argv = process.argv.slice(2);
let files;
const walkIdx = argv.indexOf('--walk');
if (walkIdx !== -1) {
  files = listWalk(argv.slice(walkIdx + 1));
} else {
  try {
    files = listGit();
  } catch {
    // No git available: fall back to walking the current directory.
    files = listWalk([]);
  }
}

let hits = 0;
let scanned = 0;
for (const file of files) {
  const normalized = file.split('\\').join('/');
  // Directory-component skip applies uniformly whether the file list came
  // from `git ls-files` or from a filesystem walk: a tracked `.venv/` or
  // `dist/` (both real cases in this repo) must never reach the scanner
  // just because it happens to be checked in.
  if (normalized.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
  if (SKIP_PATH_SUBSTRINGS.some((s) => normalized.includes(s))) continue;
  if (SKIP_FILES.has(basename(file))) continue;
  if (BINARY_EXT.has(extname(file).toLowerCase())) continue;
  const rel0 = relative(process.cwd(), file).split('\\').join('/');
  if (SKIP_EXACT_FILES.has(rel0)) continue;
  let buf;
  try { buf = readFileSync(file); } catch { continue; }
  if (isProbablyBinary(buf)) continue;
  scanned++;
  if (!mightContainDash(buf)) continue;
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    for (let col = 0; col < line.length; col++) {
      const cp = line.codePointAt(col);
      if (FORBIDDEN[cp]) {
        hits++;
        const rel = relative(process.cwd(), file) || file;
        const snippet = line.trim().slice(0, 160);
        console.error(`${rel}:${ln + 1}:${col + 1}  ${FORBIDDEN[cp]}\n    ${snippet}`);
      }
    }
  }
}

if (hits > 0) {
  console.error(`\nno-emdash guard FAILED: ${hits} forbidden dash${hits === 1 ? '' : 'es'} in ${scanned} scanned files.`);
  console.error('Replace em-dash / en-dash with a period, comma, colon, parentheses, or a plain "-" inside a compound word.');
  process.exit(1);
}

console.log(`no-emdash guard OK: 0 forbidden dashes in ${scanned} text files.`);
process.exit(0);
