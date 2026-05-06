import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode as msgpackEncode } from '@msgpack/msgpack';

import { decodeMsgpackStream, decodeProtobufStream, decodeProtobufFrame } from '../src/stream.js';

/** Build a ReadableStream that yields the given Uint8Array chunks in order. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── msgpack ───────────────────────────────────────────────────────────────────

test('decodeMsgpackStream: yields frames in order and stops at done', async () => {
  const frames = [
    msgpackEncode({ ids: [1, 2, 3], done: false }),
    msgpackEncode({ ids: [4, 5], done: false }),
    msgpackEncode({ ids: [6], done: true, finish_reason: 'stop' }),
  ].map((b) => new Uint8Array(b));

  const stream = streamOf([concat(frames)]);
  const collected: { ids: number[]; done: boolean; finish_reason?: string }[] = [];
  for await (const f of decodeMsgpackStream(stream)) {
    collected.push({ ids: [...f.ids], done: f.done, finish_reason: f.finish_reason });
  }
  assert.equal(collected.length, 3);
  assert.deepEqual(collected[0]!.ids, [1, 2, 3]);
  assert.deepEqual(collected[2]!.ids, [6]);
  assert.equal(collected[2]!.done, true);
  assert.equal(collected[2]!.finish_reason, 'stop');
});

test('decodeMsgpackStream: handles frame split across chunk boundaries', async () => {
  const buf = new Uint8Array(msgpackEncode({ ids: [42, 43, 44], done: true }));
  // Split the single msgpack object across two stream chunks — the decoder
  // must reassemble it.
  const split = Math.floor(buf.length / 2);
  const stream = streamOf([buf.subarray(0, split), buf.subarray(split)]);

  const collected: number[][] = [];
  for await (const f of decodeMsgpackStream(stream)) collected.push([...f.ids]);
  assert.deepEqual(collected, [[42, 43, 44]]);
});

// ── protobuf ──────────────────────────────────────────────────────────────────

/** Build the wire bytes that vllm/entrypoints/codec_frame.py emits. */
function encodeProtobufFrame(ids: number[], done: boolean, finishReason?: string): Uint8Array {
  const parts: number[] = [];
  const varint = (n: number) => {
    const out: number[] = [];
    while (true) {
      const bits = n & 0x7f;
      n >>>= 7;
      if (n === 0) {
        out.push(bits);
        break;
      }
      out.push(bits | 0x80);
    }
    return out;
  };
  if (ids.length > 0) {
    const packed: number[] = [];
    for (const id of ids) packed.push(...varint(id));
    parts.push(0x0a, ...varint(packed.length), ...packed);
  }
  parts.push(0x10, done ? 1 : 0);
  if (finishReason) {
    const enc = new TextEncoder().encode(finishReason);
    parts.push(0x1a, ...varint(enc.length), ...enc);
  }
  const out = new Uint8Array(4 + parts.length);
  new DataView(out.buffer).setUint32(0, parts.length, false);
  out.set(parts, 4);
  return out;
}

test('decodeProtobufFrame: round-trips a frame with all fields', () => {
  const wire = encodeProtobufFrame([100, 200, 300], true, 'length');
  // Strip 4-byte length prefix to feed the per-frame decoder directly.
  const payload = wire.subarray(4);
  const frame = decodeProtobufFrame(payload);
  assert.deepEqual(frame.ids, [100, 200, 300]);
  assert.equal(frame.done, true);
  assert.equal(frame.finish_reason, 'length');
});

test('decodeProtobufStream: reassembles frames split across chunks', async () => {
  const wire = concat([
    encodeProtobufFrame([1, 2], false),
    encodeProtobufFrame([3, 4], false),
    encodeProtobufFrame([5], true, 'stop'),
  ]);
  // Split the concatenated wire into 7-byte chunks so frames straddle reads.
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < wire.length; i += 7) chunks.push(wire.subarray(i, Math.min(i + 7, wire.length)));

  const collected: number[][] = [];
  for await (const f of decodeProtobufStream(streamOf(chunks))) collected.push([...f.ids]);
  assert.deepEqual(collected, [[1, 2], [3, 4], [5]]);
});

test('decodeProtobufStream: throws on truncated frame', async () => {
  const wire = encodeProtobufFrame([1, 2, 3], true);
  const truncated = wire.subarray(0, wire.length - 2);
  await assert.rejects(async () => {
    for await (const _ of decodeProtobufStream(streamOf([truncated]))) {
      void _;
    }
  }, /ended mid-frame/);
});
