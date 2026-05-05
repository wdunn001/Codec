/**
 * Codec live demo against a real TGI server.
 *
 * Requires a TGI instance running the Codec PR:
 *   docker run ... ghcr.io/wdunn001/text-generation-inference:codec ...
 *
 * Usage:
 *   TGI_URL=http://localhost:3000 npx tsx packages/demo/src/tgi.ts [prompt]
 */

import { CodecClient } from '@codec/client';

const W = 60;
const hr = () => '─'.repeat(W);
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function num(n: number) {
  return n.toLocaleString('en-US');
}

async function main() {
  const tgiUrl = process.env.TGI_URL;
  if (!tgiUrl) {
    console.error('\x1b[31mError: TGI_URL env var is not set.\x1b[0m');
    console.error('  Example: TGI_URL=http://localhost:3000 npx tsx packages/demo/src/tgi.ts');
    process.exit(1);
  }

  const prompt =
    process.argv[2] ??
    'Explain how transformer attention works in plain language, in about 100 words.';

  const client = new CodecClient(tgiUrl);

  console.log('\n' + bold('━'.repeat(W)));
  console.log(bold('  CODEC LIVE DEMO — Token-native TGI stream'));
  console.log(bold('━'.repeat(W)));
  console.log(dim(`\n  Server : ${tgiUrl}`));
  console.log(dim(`  Prompt : "${prompt.slice(0, 55)}${prompt.length > 55 ? '…' : ''}"\n`));

  // ── 1. Single stream — show raw token IDs ──────────────────────────────────

  console.log(bold('  RAW TOKEN STREAM'));
  console.log(hr());
  process.stdout.write('  IDs: ');

  const ids: number[] = [];
  let byteCount = 0;

  const start = Date.now();

  for await (const frame of client.stream(prompt, { maxNewTokens: 256 })) {
    ids.push(...frame.ids);
    byteCount += frame.ids.length * 4;
    process.stdout.write(frame.ids.join(' ') + ' ');
    if (frame.done) {
      console.log(dim(`\n  finish: ${frame.finish_reason ?? 'unknown'}`));
    }
  }

  const elapsed = Date.now() - start;

  console.log();
  console.log(`  Tokens       : ${num(ids.length)}`);
  console.log(`  Codec bytes  : ${green(num(byteCount))}  ${dim('(' + (byteCount / ids.length).toFixed(1) + ' bytes/token)')}`);
  console.log(`  Time         : ${elapsed}ms  ${dim('(' + (ids.length / (elapsed / 1000)).toFixed(0) + ' tok/s)')}`);

  // ── 2. Compare with what text would have cost ──────────────────────────────

  // A typical SSE event for one token is ~80 bytes of JSON envelope + text
  const estimatedTextBytes = ids.length * 80;
  const saved = estimatedTextBytes - byteCount;
  const reduction = ((saved / estimatedTextBytes) * 100).toFixed(1);

  console.log();
  console.log(bold('  WIRE EFFICIENCY'));
  console.log(hr());
  console.log(`  Text SSE (estimated) : ${yellow(num(estimatedTextBytes))} bytes`);
  console.log(`  Codec binary         : ${green(num(byteCount))} bytes`);
  console.log(`  Saved                : ${green(num(saved) + ' bytes  (' + reduction + '%)')}`);

  // ── 3. Agent handoff demo ──────────────────────────────────────────────────

  console.log();
  console.log(bold('  AGENT-TO-AGENT HANDOFF'));
  console.log(hr());
  console.log(dim('  Agent A generates. Token IDs passed directly to Agent B.'));
  console.log(dim('  No text conversion at any point.\n'));

  const AGENT_A = 'In one sentence, state the main inefficiency in current AI API wire formats.';
  const { agentA, agentB } = await client.agentHandoff(
    AGENT_A,
    (aIds) =>
      `You received ${aIds.length} token IDs from Agent A. ` +
      `Summarise in one sentence what that agent likely said about AI API inefficiency.`,
    { maxNewTokens: 128 }
  );

  console.log(`  Agent A: ${num(agentA.ids.length)} tokens → ${green(num(agentA.stats.byteCount) + ' bytes')}`);
  console.log(`  Agent B: ${num(agentB.ids.length)} tokens → ${green(num(agentB.stats.byteCount) + ' bytes')}`);
  console.log();

  const totalCodec = agentA.stats.byteCount + agentB.stats.byteCount;
  const totalTextEst = (agentA.ids.length + agentB.ids.length) * 80;
  console.log(`  Total codec  : ${green(num(totalCodec) + ' bytes')}`);
  console.log(`  Total text   : ${yellow(num(totalTextEst) + ' bytes  (estimated)')}`);
  console.log(`  Saved        : ${green(num(totalTextEst - totalCodec) + ' bytes')}`);
  console.log(`  Text detokenize/retokenize round-trips : ${green('0')}`);

  console.log('\n' + bold('━'.repeat(W)) + '\n');
}

main().catch((err) => {
  console.error('\x1b[31mFatal: ' + String(err) + '\x1b[0m');
  process.exit(1);
});
