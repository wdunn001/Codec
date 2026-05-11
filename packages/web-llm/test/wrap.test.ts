/**
 * @codecai/web-llm smoke tests.
 *
 * The package shape is small (it's a thin transform): structural-typed
 * adapter from MLC-style chat-completion chunks to Codec msgpack frames.
 * These tests exercise the transform end-to-end with a fake `MlcEngineLike`
 * implementation so we don't need a WebGPU runtime or a real model:
 *
 *   1. frames() emits one CodecFrame per non-empty delta, plus a terminal
 *      frame with done: true.
 *   2. The token IDs are produced by the provided `tokenize` callback.
 *   3. finish_reason from the upstream chunk surfaces on the terminal frame.
 *   4. completionsStream() returns a ReadableStream<Uint8Array> whose chunks
 *      msgpack-decode back to the same CodecFrame objects.
 *   5. pickTokenizer() falls back to engine.getTokenizer() when no override
 *      is passed.
 *   6. pickTokenizer() throws a useful error when neither path is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decode as msgpackDecode } from '@msgpack/msgpack';

import { wrapEngine, type MlcEngineLike, type CodecFrame } from '../src/index.ts';

// ── Fake MLC engine ──────────────────────────────────────────────────────────

function fakeEngine(chunks: { delta: string; finish_reason?: string }[]): MlcEngineLike {
  return {
    chat: {
      completions: {
        async create() {
          return (async function* () {
            for (const c of chunks) {
              yield {
                choices: [
                  {
                    delta: { content: c.delta },
                    finish_reason: c.finish_reason ?? null,
                  },
                ],
              };
            }
          })();
        },
      },
    },
  };
}

// Deterministic toy tokenizer: one ID per UTF-16 code unit. Good enough for
// asserting that ids are produced and that the right text was fed in.
const codeUnitTokenize = (text: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i));
  return out;
};

// ── Tests ────────────────────────────────────────────────────────────────────

test('frames(): one frame per non-empty delta + terminal done frame', async () => {
  const engine = fakeEngine([
    { delta: 'he' },
    { delta: 'llo' },
    { delta: '', finish_reason: 'stop' },
  ]);
  const codec = wrapEngine(engine, { mapId: 'test/map', tokenize: codeUnitTokenize });

  const seen: CodecFrame[] = [];
  for await (const f of codec.frames({ prompt: 'hi' })) seen.push(f);

  assert.equal(seen.length, 3, 'expected 2 data frames + 1 terminal frame');
  assert.deepEqual(seen[0]?.ids, codeUnitTokenize('he'));
  assert.equal(seen[0]?.done, false);
  assert.deepEqual(seen[1]?.ids, codeUnitTokenize('llo'));
  assert.equal(seen[1]?.done, false);
  assert.deepEqual(seen[2]?.ids, []);
  assert.equal(seen[2]?.done, true);
  assert.equal(seen[2]?.finish_reason, 'stop');
});

test('frames(): empty-content chunks do not emit a frame', async () => {
  const engine = fakeEngine([
    { delta: 'x' },
    { delta: '' }, // pure heartbeat — should be skipped
    { delta: 'y' },
    { delta: '', finish_reason: 'length' },
  ]);
  const codec = wrapEngine(engine, { mapId: 'test/map', tokenize: codeUnitTokenize });

  const seen: CodecFrame[] = [];
  for await (const f of codec.frames({ prompt: 'p' })) seen.push(f);

  assert.equal(seen.length, 3, 'two data frames + one terminal');
  assert.deepEqual(seen[0]?.ids, codeUnitTokenize('x'));
  assert.deepEqual(seen[1]?.ids, codeUnitTokenize('y'));
  assert.equal(seen[2]?.finish_reason, 'length');
});

test('completionsStream(): chunks msgpack-decode back to frames', async () => {
  const engine = fakeEngine([
    { delta: 'abc' },
    { delta: 'def', finish_reason: 'stop' },
  ]);
  const codec = wrapEngine(engine, { mapId: 'test/map', tokenize: codeUnitTokenize });
  const stream = codec.completionsStream({ prompt: 'p' });

  const reader = stream.getReader();
  const decoded: CodecFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    decoded.push(msgpackDecode(value) as CodecFrame);
  }

  assert.equal(decoded.length, 3);
  assert.deepEqual(decoded[0]?.ids, codeUnitTokenize('abc'));
  assert.deepEqual(decoded[1]?.ids, codeUnitTokenize('def'));
  assert.equal(decoded[2]?.done, true);
  assert.equal(decoded[2]?.finish_reason, 'stop');
});

test('pickTokenizer(): uses engine.getTokenizer when no override passed', async () => {
  const engineWithTok: MlcEngineLike = {
    ...fakeEngine([{ delta: 'z', finish_reason: 'stop' }]),
    getTokenizer() {
      return {
        encode(text: string) {
          // Mark with offset so we can tell this path was taken.
          return [9000, ...codeUnitTokenize(text)];
        },
      };
    },
  };
  const codec = wrapEngine(engineWithTok, { mapId: 'test/map' });
  const seen: CodecFrame[] = [];
  for await (const f of codec.frames({ prompt: 'p' })) seen.push(f);
  assert.equal(seen[0]?.ids[0], 9000, 'engine.getTokenizer should have been invoked');
});

test('pickTokenizer(): throws when neither override nor engine tokenizer present', () => {
  const engine = fakeEngine([{ delta: 'q' }]);
  assert.throws(
    () => wrapEngine(engine, { mapId: 'test/map' }),
    /no tokenizer available/,
  );
});

test('frames(): system prompt is passed through as a system message', async () => {
  let observedMessages: { role: string; content: string }[] = [];
  const engine: MlcEngineLike = {
    chat: {
      completions: {
        async create(req) {
          observedMessages = req.messages;
          return (async function* () {
            yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
          })();
        },
      },
    },
  };
  const codec = wrapEngine(engine, { mapId: 'test/map', tokenize: codeUnitTokenize });
  for await (const _ of codec.frames({ prompt: 'hello', system: 'be terse' })) {
    void _;
  }
  assert.equal(observedMessages[0]?.role, 'system');
  assert.equal(observedMessages[0]?.content, 'be terse');
  assert.equal(observedMessages[1]?.role, 'user');
  assert.equal(observedMessages[1]?.content, 'hello');
});
