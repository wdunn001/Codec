/**
 * @codecai/web-llm smoke tests.
 *
 * The wrapper around the patched fork is small: when the engine
 * supports `stream_format: "raw"`, we just pass through `CodecFrame`
 * objects. Tests use a fake engine that mimics the fork's shape so we
 * don't need WebGPU.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decode as msgpackDecode } from '@msgpack/msgpack';

import { wrapEngine, type CodecCapableEngine, type CodecFrame } from '../src/index.ts';

// ── Fake patched fork ────────────────────────────────────────────────────────

function fakeFork(frames: CodecFrame[]): CodecCapableEngine {
  return {
    chat: {
      completions: {
        async create(req) {
          assert.equal(
            req.stream_format,
            'raw',
            'wrapper must pass stream_format:"raw"',
          );
          return (async function* () {
            for (const f of frames) yield f;
          })();
        },
      },
    },
  };
}

const SAMPLE_FRAMES: CodecFrame[] = [
  { ids: [1, 2, 3] as number[], done: false },
  { ids: [4, 5] as number[], done: false },
  { ids: [] as number[], done: true, finish_reason: 'stop' },
] as unknown as CodecFrame[];

// ── Tests ────────────────────────────────────────────────────────────────────

test('streamFrames: passes through CodecFrames verbatim', async () => {
  const engine = fakeFork(SAMPLE_FRAMES);
  const codec = wrapEngine(engine, { mapId: 'qwen/qwen2' });

  const seen: CodecFrame[] = [];
  await codec.streamFrames({ prompt: 'hi' }, (f) => seen.push(f));

  assert.equal(seen.length, 3);
  assert.deepEqual(seen, SAMPLE_FRAMES);
});

test('frames(): async-iterable form yields the same frames', async () => {
  const engine = fakeFork(SAMPLE_FRAMES);
  const codec = wrapEngine(engine, { mapId: 'qwen/qwen2' });

  const seen: CodecFrame[] = [];
  for await (const f of codec.frames({ prompt: 'p' })) seen.push(f);
  assert.deepEqual(seen, SAMPLE_FRAMES);
});

test('completionsStream(): chunks msgpack-decode back to frames', async () => {
  const engine = fakeFork(SAMPLE_FRAMES);
  const codec = wrapEngine(engine, { mapId: 'qwen/qwen2' });

  const reader = codec.completionsStream({ prompt: 'p' }).getReader();
  const decoded: CodecFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    decoded.push(msgpackDecode(value) as CodecFrame);
  }
  assert.deepEqual(decoded, SAMPLE_FRAMES);
});

test('system + user messages threaded through to engine.chat.completions', async () => {
  let observed: { role: string; content: string }[] = [];
  const engine: CodecCapableEngine = {
    chat: {
      completions: {
        async create(req) {
          observed = req.messages;
          assert.equal(req.stream_format, 'raw');
          return (async function* () {
            yield {
              ids: [42] as number[],
              done: true,
              finish_reason: 'stop',
            } as unknown as CodecFrame;
          })();
        },
      },
    },
  };
  const codec = wrapEngine(engine, { mapId: 'qwen/qwen2' });
  await codec.streamFrames({ prompt: 'hello', system: 'be terse' }, () => undefined);

  assert.equal(observed[0]?.role, 'system');
  assert.equal(observed[0]?.content, 'be terse');
  assert.equal(observed[1]?.role, 'user');
  assert.equal(observed[1]?.content, 'hello');
});

test('Uint8Array (msgpack-mode) items are filtered out of object stream', async () => {
  // Fork yields Uint8Array when stream_format:"msgpack"; we request "raw"
  // but defensively skip any Uint8Array that slips through.
  const mixed: Array<CodecFrame | Uint8Array> = [
    { ids: [10] as number[], done: false } as unknown as CodecFrame,
    new Uint8Array([0x80]),
    { ids: [] as number[], done: true } as unknown as CodecFrame,
  ];
  const engine: CodecCapableEngine = {
    chat: {
      completions: {
        async create() {
          return (async function* () {
            for (const x of mixed) yield x;
          })();
        },
      },
    },
  };
  const codec = wrapEngine(engine, { mapId: 'qwen/qwen2' });
  const seen: CodecFrame[] = [];
  await codec.streamFrames({ prompt: 'p' }, (f) => seen.push(f));
  assert.equal(seen.length, 2, 'Uint8Array element should have been filtered');
});
