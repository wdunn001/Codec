/**
 * Codec agent-to-agent demo.
 *
 * Simulates two agents collaborating on a task:
 *   Agent A: researcher, answers a question
 *   Agent B: synthesiser, summarises Agent A's answer
 *
 * Shows the same workflow in two modes:
 *
 *   TEXT MODE: current state of the world
 *     A generates text → text transmitted → B re-tokenises → B generates text
 *
 *   CODEC MODE: token-native transport
 *     A generates token IDs → IDs transmitted → B consumes IDs directly
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx packages/demo/src/agent.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  encodeFrame,
  encodeJsonFrame,
  encodeTokens,
  decodeTokens,
  decodeFrames,
  totalBytes,
  FrameType,
  CODEC_VERSION,
  TOKENS_PER_FRAME,
  type HelloPayload,
  type ReadyPayload,
} from '@codec/core';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
};

const W = 62;
const hr = () => '─'.repeat(W);
const bold = (s: string) => `${c.bold}${s}${c.reset}`;
const dim = (s: string) => `${c.dim}${s}${c.reset}`;
const green = (s: string) => `${c.green}${s}${c.reset}`;
const yellow = (s: string) => `${c.yellow}${s}${c.reset}`;
const red = (s: string) => `${c.red}${s}${c.reset}`;
const cyan = (s: string) => `${c.cyan}${s}${c.reset}`;

function num(n: number) {
  return n.toLocaleString('en-US');
}

// ── Shared setup ──────────────────────────────────────────────────────────────

const AGENT_A_PROMPT =
  'You are a research agent. Answer concisely (around 120 words): ' +
  'Why does detokenising AI output to text and re-tokenising it for the next model in a pipeline waste resources?';

const AGENT_B_SYSTEM =
  'You are a synthesis agent. You receive research notes and produce a single tight paragraph ' +
  'summarising the key finding for a technical audience.';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect a full streaming response and measure raw SSE wire bytes. */
async function streamAndMeasure(
  apiKey: string,
  messages: Anthropic.MessageParam[],
  system?: string
): Promise<{ text: string; outputTokens: number; wireBytes: number; sseEvents: number }> {
  const body: Record<string, unknown> = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    stream: true,
    messages,
  };
  if (system) body.system = system;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }

  let wireBytes = 0;
  let sseEvents = 0;
  let text = '';
  let outputTokens = 0;

  const reader = response.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    wireBytes += value.byteLength;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      sseEvents++;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const ev = JSON.parse(data) as Record<string, unknown>;
        if (ev.type === 'content_block_delta') {
          const d = ev.delta as Record<string, unknown>;
          if (typeof d?.text === 'string') text += d.text;
        }
        if (ev.type === 'message_delta') {
          const u = ev.usage as Record<string, number> | undefined;
          outputTokens = u?.output_tokens ?? outputTokens;
        }
      } catch {
        // skip malformed
      }
    }
  }

  return { text, outputTokens, wireBytes, sseEvents };
}

/** Build a simulated Codec binary stream for N token IDs. */
function buildCodecStream(tokenCount: number): {
  frames: Uint8Array[];
  totalBytes: number;
  sessionOverhead: number;
} {
  const hello: HelloPayload = {
    codec_version: CODEC_VERSION,
    accept_tokenizers: ['claude-haiku-4-5-20251001-v1'],
  };
  const ready: ReadyPayload = {
    codec_version: CODEC_VERSION,
    tokenizer_id: 'claude-haiku-4-5-20251001-v1',
    map_url: 'https://models.codec.ai/maps/claude-haiku-4-5-20251001-v1.json',
    map_hash: 'sha256:abc123',
  };

  const helloFrame = encodeJsonFrame(FrameType.HELLO, hello);
  const readyFrame = encodeJsonFrame(FrameType.READY, ready);
  const sessionOverhead = helloFrame.byteLength + readyFrame.byteLength;

  const ids = Array.from({ length: tokenCount }, (_, i) => 50000 + i);
  const tokenFrames: Uint8Array[] = [];
  for (let i = 0; i < ids.length; i += TOKENS_PER_FRAME) {
    const chunk = ids.slice(i, i + TOKENS_PER_FRAME);
    tokenFrames.push(encodeFrame(FrameType.TOKENS, encodeTokens(chunk)));
  }
  tokenFrames.push(encodeFrame(FrameType.EOS, new Uint8Array(0)));

  const all = [helloFrame, readyFrame, ...tokenFrames];
  return { frames: all, totalBytes: totalBytes(all), sessionOverhead };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(red('Error: ANTHROPIC_API_KEY env var is not set.'));
    process.exit(1);
  }

  console.log('\n' + bold('━'.repeat(W)));
  console.log(bold('  CODEC: Agent-to-Agent Demo'));
  console.log(bold('━'.repeat(W)));
  console.log(dim('\n  Two agents collaborate on a question.'));
  console.log(dim('  Agent A: researcher   |   Agent B: synthesiser\n'));

  // ── Agent A ───────────────────────────────────────────────────────────────

  console.log(cyan(bold('  ▸ Agent A')) + dim(': generating research notes…'));
  const agentA = await streamAndMeasure(apiKey, [{ role: 'user', content: AGENT_A_PROMPT }]);
  console.log(dim('    ' + agentA.text.replace(/\n/g, '\n    ').slice(0, 300) + '…\n'));

  // ── TEXT MODE handoff ─────────────────────────────────────────────────────

  console.log(bold('  TEXT HANDOFF (current API)'));
  console.log(hr());
  console.log(dim('  Agent A → wire → Agent B'));
  console.log(`  Agent A output      : ${num(agentA.outputTokens)} tokens, ${num(agentA.wireBytes)} bytes on wire`);

  // Simulate the text being shipped and Agent B receiving it
  // (the text is already in memory as a string: this represents the cost of
  //  transmitting it and Agent B's tokeniser ingesting it)
  const textHandoffBytes = new TextEncoder().encode(
    JSON.stringify({ role: 'user', content: agentA.text })
  ).byteLength;
  const textRetokenisationOverhead = agentA.outputTokens * 4; // approx cost of re-encoding

  console.log(`  Text payload to B   : ${yellow(num(textHandoffBytes))} bytes`);
  console.log(dim('  Agent B ingests text → tokeniser runs → token IDs produced'));

  process.stdout.write(cyan('  ▸ Agent B') + dim(': synthesising…'));
  const agentB_text = await streamAndMeasure(
    apiKey,
    [
      { role: 'user', content: AGENT_A_PROMPT },
      { role: 'assistant', content: agentA.text },
      { role: 'user', content: 'Now synthesise that into one tight paragraph.' },
    ],
    AGENT_B_SYSTEM
  );
  console.log(dim(' done'));

  const totalTextBytes =
    agentA.wireBytes + textHandoffBytes + agentB_text.wireBytes;

  console.log(`  Agent B output      : ${num(agentB_text.outputTokens)} tokens, ${num(agentB_text.wireBytes)} bytes on wire`);
  console.log(bold(`  Total wire bytes    : ${yellow(num(totalTextBytes))}`));
  console.log();

  // ── CODEC MODE handoff ────────────────────────────────────────────────────

  console.log(bold('  CODEC HANDOFF (token-native)'));
  console.log(hr());
  console.log(dim('  Agent A → binary token frames → Agent B'));

  const codecA = buildCodecStream(agentA.outputTokens);
  console.log(`  Agent A output      : ${num(agentA.outputTokens)} tokens`);
  console.log(`  Codec stream to B   : ${green(num(codecA.totalBytes))} bytes`);
  console.log(dim('  Agent B receives token IDs directly: no detokenisation, no re-tokenisation'));

  // Agent B's codec stream (its own output)
  const codecB = buildCodecStream(agentB_text.outputTokens);
  const totalCodecBytes = codecA.totalBytes + codecB.totalBytes;
  console.log(`  Agent B output      : ${num(agentB_text.outputTokens)} tokens, ${green(num(codecB.totalBytes))} bytes`);
  console.log(bold(`  Total wire bytes    : ${green(num(totalCodecBytes))}`));
  console.log();

  // ── Comparison ────────────────────────────────────────────────────────────

  console.log(bold('  COMPARISON'));
  console.log(hr());

  const saved = totalTextBytes - totalCodecBytes;
  const reductionPct = ((saved / totalTextBytes) * 100).toFixed(1);

  console.log(`  Text mode   : ${yellow(num(totalTextBytes) + ' bytes')}`);
  console.log(`  Codec mode  : ${green(num(totalCodecBytes) + ' bytes')}`);
  console.log(`  Saved       : ${green(num(saved) + ' bytes  (' + reductionPct + '% reduction)')}`);
  console.log();

  const M = 1_000_000;
  const textTB = ((totalTextBytes * M) / 1e12).toFixed(2);
  const codecGB = ((totalCodecBytes * M) / 1e9).toFixed(0);
  const savedTB = ((saved * M) / 1e12).toFixed(2);

  console.log(
    `  At ${num(M)} pipeline runs:`
  );
  console.log(`    Text  : ${yellow(textTB + ' TB')}`);
  console.log(`    Codec : ${green(codecGB + ' GB')}`);
  console.log(`    Saved : ${green(savedTB + ' TB')}`);

  console.log('\n' + bold('━'.repeat(W)) + '\n');

  // Print Agent B's synthesis so the demo isn't just numbers
  console.log(bold('  Agent B synthesis:'));
  console.log(hr());
  console.log('  ' + agentB_text.text.replace(/\n/g, '\n  '));
  console.log('\n' + hr() + '\n');
}

main().catch((err) => {
  console.error(red('\nFatal: ' + String(err)));
  process.exit(1);
});
