/**
 * Codec benchmark — measures actual wire bytes for a streaming Anthropic API call
 * in text mode, then shows what the same response would cost over Codec binary frames.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx packages/demo/src/benchmark.ts [prompt]
 */

import {
  encodeFrame,
  encodeJsonFrame,
  encodeTokens,
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
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

const W = 58;
const hr = (ch = '─') => ch.repeat(W);
const bold = (s: string) => `${c.bold}${s}${c.reset}`;
const dim = (s: string) => `${c.dim}${s}${c.reset}`;
const green = (s: string) => `${c.green}${s}${c.reset}`;
const yellow = (s: string) => `${c.yellow}${s}${c.reset}`;
const cyan = (s: string) => `${c.cyan}${s}${c.reset}`;
const red = (s: string) => `${c.red}${s}${c.reset}`;

function num(n: number) {
  return n.toLocaleString('en-US');
}

function pct(a: number, b: number) {
  return ((a / b) * 100).toFixed(1) + '%';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(red('Error: ANTHROPIC_API_KEY env var is not set.'));
    process.exit(1);
  }

  const prompt =
    process.argv[2] ??
    'Explain how transformer attention works, in plain language, in about 150 words.';
  const model = 'claude-sonnet-4-6';

  console.log('\n' + bold('━'.repeat(W)));
  console.log(bold(`  CODEC BENCHMARK`));
  console.log(bold(`  Token-native vs Text Transport`));
  console.log(bold('━'.repeat(W)));
  console.log(dim(`\n  Prompt : "${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}"`));
  console.log(dim(`  Model  : ${model}\n`));

  // ── 1. Stream from Anthropic, capture raw SSE bytes ──────────────────────

  process.stdout.write('  Streaming response  ');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(red(`\n  API error ${response.status}: ${err}`));
    process.exit(1);
  }

  let rawWireBytes = 0;
  let sseEventCount = 0;
  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = response.body!.getReader();
  const textDecoder = new TextDecoder();
  let sseBuffer = '';
  let dots = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    rawWireBytes += value.byteLength;
    sseBuffer += textDecoder.decode(value, { stream: true });

    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      sseEventCount++;

      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const ev = JSON.parse(data) as Record<string, unknown>;

        if (ev.type === 'content_block_delta') {
          const delta = ev.delta as Record<string, unknown>;
          if (typeof delta?.text === 'string') {
            fullText += delta.text;
            if (++dots % 8 === 0) process.stdout.write('█');
          }
        }
        if (ev.type === 'message_start') {
          const msg = ev.message as Record<string, unknown>;
          const usage = msg?.usage as Record<string, number> | undefined;
          inputTokens = usage?.input_tokens ?? 0;
        }
        if (ev.type === 'message_delta') {
          const usage = ev.usage as Record<string, number> | undefined;
          outputTokens = usage?.output_tokens ?? 0;
        }
      } catch {
        // ignore malformed events
      }
    }
  }

  console.log(green(' done\n'));

  // ── 2. Build Codec representation ─────────────────────────────────────────
  //
  // We don't have the real token IDs from the API (it doesn't expose them),
  // so we use sequential placeholder IDs. The byte count is identical
  // regardless of the actual ID values: 4 bytes per uint32.
  //
  // In a real Codec deployment the model emits these IDs directly.

  const placeholderIds = Array.from({ length: outputTokens }, (_, i) => 50000 + i);

  // Session handshake frames (one-time per connection, amortised)
  const helloPayload: HelloPayload = {
    codec_version: CODEC_VERSION,
    accept_tokenizers: ['claude-sonnet-4-6-v1', 'cl100k_base'],
  };
  const readyPayload: ReadyPayload = {
    codec_version: CODEC_VERSION,
    tokenizer_id: 'claude-sonnet-4-6-v1',
    map_url: 'https://models.codec.ai/maps/claude-sonnet-4-6-v1.json',
    map_hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };
  const helloFrame = encodeJsonFrame(FrameType.HELLO, helloPayload);
  const readyFrame = encodeJsonFrame(FrameType.READY, readyPayload);
  const sessionOverhead = helloFrame.byteLength + readyFrame.byteLength;

  // Token stream frames
  const tokenFrames: Uint8Array[] = [];
  for (let i = 0; i < placeholderIds.length; i += TOKENS_PER_FRAME) {
    const chunk = placeholderIds.slice(i, i + TOKENS_PER_FRAME);
    tokenFrames.push(encodeFrame(FrameType.TOKENS, encodeTokens(chunk)));
  }

  // EOS frame
  const eosFrame = encodeFrame(FrameType.EOS, new Uint8Array(0));

  const codecStreamBytes = totalBytes(tokenFrames) + eosFrame.byteLength;
  const codecTotalBytes = sessionOverhead + codecStreamBytes;

  // ── 3. Display results ────────────────────────────────────────────────────

  const bptText = (rawWireBytes / outputTokens).toFixed(1);
  const bptCodec = (codecStreamBytes / outputTokens).toFixed(1);
  const reduction = (((rawWireBytes - codecStreamBytes) / rawWireBytes) * 100).toFixed(1);

  console.log(bold('  RESPONSE'));
  console.log(hr());
  console.log(`  Characters   : ${num(fullText.length)}`);
  console.log(`  Input tokens : ${num(inputTokens)}`);
  console.log(`  Output tokens: ${num(outputTokens)}`);

  console.log('\n' + bold('  TEXT TRANSPORT') + dim('  (current API — JSON/SSE over HTTPS)'));
  console.log(hr());
  console.log(`  SSE events   : ${num(sseEventCount)}`);
  console.log(`  Wire bytes   : ${yellow(num(rawWireBytes))}`);
  console.log(`  Bytes/token  : ${yellow(bptText)}`);

  console.log('\n' + bold('  CODEC TRANSPORT') + dim('  (binary token frames)'));
  console.log(hr());
  console.log(`  Session handshake  : ${num(sessionOverhead)} bytes  ${dim('(one-time, amortised)')}`);
  console.log(`  Token frames       : ${num(tokenFrames.length)}`);
  console.log(`  Stream bytes       : ${green(num(codecStreamBytes))}`);
  console.log(`  Bytes/token        : ${green(bptCodec)}`);

  console.log('\n' + bold('  EFFICIENCY GAIN'));
  console.log(hr());
  console.log(`  Wire reduction     : ${green(reduction + '%')} fewer bytes per call`);

  const savedPerCall = rawWireBytes - codecStreamBytes;
  const M = 1_000_000;
  const textAtScale = (rawWireBytes * M) / 1e12;
  const codecAtScale = (codecStreamBytes * M) / 1e9;
  const savedAtScale = (savedPerCall * M) / 1e12;

  console.log(`  Saved per call     : ${num(savedPerCall)} bytes`);
  console.log(
    `  At 1M calls        : ${yellow(textAtScale.toFixed(2) + ' TB')} text  vs  ${green(codecAtScale.toFixed(0) + ' GB')} codec`
  );
  console.log(`  Saved at 1M calls  : ${green(savedAtScale.toFixed(2) + ' TB')}`);

  // ── 4. Agent-to-agent section ─────────────────────────────────────────────

  console.log('\n' + bold('  AGENT-TO-AGENT OVERHEAD'));
  console.log(hr());
  console.log(
    dim('  Text mode:  token IDs → UTF-8 → JSON → wire → JSON → UTF-8 → token IDs')
  );
  console.log(
    `              ${num(outputTokens)} IDs → ${num(rawWireBytes)} bytes → ${num(outputTokens)} IDs`
  );
  console.log(
    `              ${red('round-trip overhead: ' + num(rawWireBytes - outputTokens * 4) + ' bytes (' + pct(rawWireBytes - outputTokens * 4, rawWireBytes) + ')')}`
  );
  console.log();
  console.log(dim('  Codec mode: token IDs → binary frame → wire → token IDs'));
  console.log(
    `              ${num(outputTokens)} IDs → ${num(codecStreamBytes)} bytes → ${num(outputTokens)} IDs`
  );
  console.log(`              ${green('presentation layer never invoked (no human caller)')}`);

  console.log('\n' + bold('━'.repeat(W)) + '\n');
}

main().catch((err) => {
  console.error(red('\nFatal: ' + String(err)));
  process.exit(1);
});
