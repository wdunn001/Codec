/**
 * 03: Indirect prompt injection attack/defense tests.
 *
 * Covers JSON role injection (the canonical f-string-JSON breakout) and
 * chat-template special-token boundary breaks. Both demonstrate the
 * vulnerable pipeline alongside the defense, in the same test.
 *
 * See spec/proposals/v0.6-security/03-indirect-injection.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { sanitizeForCodec } from '../../src/security/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(
  __dirname,
  '../../../bench/fixtures/security/03-indirect-injection',
);

function load(name: string): string {
  return readFileSync(resolve(FIXTURE_ROOT, name), 'utf8');
}

// ── JSON role injection ──────────────────────────────────────────────────────

interface Message {
  role: string;
  content: string;
  [k: string]: unknown;
}
interface Payload {
  model: string;
  messages: Message[];
}

/**
 * Models the *vulnerable* recruiter pipeline: string-builds JSON with the
 * bio interpolated as raw text, then reparses. Bug: no `JSON.stringify` on the
 * bio. Anything inside the bio that's valid JSON syntax breaks out.
 */
function vulnerableFstringPipeline(bio: string): Payload {
  // Models the actual common bug: pipelines escape control characters (so the
  // JSON parses) but DO NOT escape `"` (the bug). That's the gap the
  // role-injection breakout exploits. A pipeline that escapes `"` properly
  // (i.e. `JSON.stringify`) is the defended case below.
  const partiallyEscaped = bio
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .trim();
  const prompt = `{
    "model": "gpt-4o",
    "messages": [
      {"role": "system", "content": "You are a recruiting assistant. Draft brief outreach."},
      {"role": "user", "content": "Candidate bio: ${partiallyEscaped}\\n\\nRole: Senior Engineer\\n\\nDraft an email."}
    ]
  }`;
  return JSON.parse(prompt) as Payload;
}

/**
 * The defended pipeline: uses native object construction (or equivalent
 * `JSON.stringify` on user content). Bio is treated as data.
 */
function defendedPipeline(bio: string): Payload {
  return {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a recruiting assistant. Draft brief outreach.' },
      {
        role: 'user',
        content: `Candidate bio: ${bio}\n\nRole: Senior Engineer\n\nDraft an email.`,
      },
    ],
  };
}

test('attack: JSON role injection produces a hijacked messages array', () => {
  const bio = load('json-role-injection-bio.txt');
  const payload = vulnerableFstringPipeline(bio);

  // The injection should produce MORE than the framework's intended 2 messages.
  assert.ok(
    payload.messages.length > 2,
    `attack should inject extra messages, got ${payload.messages.length}`,
  );

  // The injection's signature: a system message appears AFTER the user message.
  const userIdx = payload.messages.findIndex((m) => m.role === 'user');
  const systemAfterUser = payload.messages
    .slice(userIdx + 1)
    .some((m) => m.role === 'system');
  assert.ok(systemAfterUser, 'injected system message must appear after the user msg');

  // The injected system message should contain the priority-override phrase.
  const injected = payload.messages
    .slice(userIdx + 1)
    .find((m) => m.role === 'system');
  assert.ok(injected);
  assert.ok(
    /PRIORITY OVERRIDE/.test(injected!.content),
    'injected system message should carry the override phrase',
  );
});

test('defense: defended pipeline keeps the messages array intact', () => {
  const bio = load('json-role-injection-bio.txt');
  const payload = defendedPipeline(bio);

  // Exactly 2 messages: system + user: as the framework intended.
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].role, 'user');

  // The bio's JSON-looking content is now INSIDE the user message content
  // as data. Verify the injection phrase is preserved as text.
  assert.ok(
    payload.messages[1].content.includes('PRIORITY OVERRIDE'),
    'attack payload preserved as content (defense did not lose data)',
  );
  // But no extra system message exists.
  const systemCount = payload.messages.filter((m) => m.role === 'system').length;
  assert.equal(systemCount, 1, 'only ONE system message after defense');
});

// ── Chat-template special-token boundary break ───────────────────────────────

test('attack: chat-template-tokens payload contains boundary tokens', () => {
  const payload = load('chat-template-tokens.txt');
  assert.ok(payload.includes('<|im_end|>'));
  assert.ok(payload.includes('<|eot_id|>'));
  assert.ok(payload.includes('<|im_start|>system'));
  assert.ok(payload.includes('[/INST]'));
});

test('defense: sanitizeForCodec strips chat-template tokens', () => {
  const payload = load('chat-template-tokens.txt');
  const { text, removed } = sanitizeForCodec(payload);
  assert.equal(text.includes('<|im_end|>'), false);
  assert.equal(text.includes('<|eot_id|>'), false);
  assert.equal(text.includes('<|im_start|>'), false);
  assert.equal(text.includes('[/INST]'), false);
  assert.equal(text.includes('<end_of_turn>'), false);
  assert.equal(text.includes('</s>'), false);
  assert.ok(removed.chatTemplateTokens >= 6);
  // Legitimate visible content preserved.
  assert.ok(text.includes('systems engineer'));
  assert.ok(text.includes('PRIORITY OVERRIDE'));
});

// ── system-reminder mimicry ──────────────────────────────────────────────────

test('attack: system-reminder mimicry uses the Claude harness pattern', () => {
  const payload = load('system-reminder-mimicry.txt');
  assert.ok(payload.includes('<system-reminder>'));
  assert.ok(/TOP CANDIDATE/.test(payload));
});

test('note: system-reminder mimicry is NOT stripped by sanitizeForCodec (intentional)', () => {
  // sanitizeForCodec strips STRUCTURAL attacks (smuggling, chat-template tokens).
  // The `<system-reminder>` tag is a semantic-level attack that must be handled
  // Legitimate use cases (logging, documentation about prompts) need to
  // round-trip the literal text. The tag is therefore handled at the
  // prompt-assembly layer (wrap in `<untrusted_content>`).
  const payload = load('system-reminder-mimicry.txt');
  const { text } = sanitizeForCodec(payload);
  assert.ok(text.includes('<system-reminder>'), 'tag preserved by sanitizer');
  // The handling defense lives in prompt assembly: see
  // spec/proposals/v0.6-security/03-indirect-injection.md "universal defense pattern".
});
