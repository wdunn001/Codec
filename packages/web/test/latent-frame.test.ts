/**
 * @codecai/web — latent-frame round-trip tests across all 7 pipelines.
 *
 * Goal: prove the TypeScript port (`src/latent-frame.ts`) is byte-identical
 * to the Python reference (`packages/python/src/codecai/server/latent_frame.py`)
 * at the latent-byte boundary. We exercise both halves in-process — encode
 * with `LatentStreamEncoder`, decode with `LatentStreamDecoder`, assert that
 * the reconstructed tensor matches the input within the per-pipeline
 * tolerance set by the spec (raw = bit-exact; quantizing pipelines = within
 * one quantum of round-trip drift).
 *
 * Conformance against the Python encoder's golden bytes happens at
 * packages/bench/golden/pipelines/<name>/ and is exercised by the bench
 * harness, not here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PIPELINE_NAMES,
  LatentStreamEncoder,
  LatentStreamDecoder,
  encodeLatentHeaderMsgpack,
  encodeLatentFrameMsgpack,
  decodeLatentHeaderMsgpack,
  decodeLatentFrameMsgpack,
  scalesToBytes,
  scalesFromBytes,
  packInt4LowFirst,
  unpackInt4LowFirst,
  computeScales,
  f32ToF16,
  f16ToF32,
  type PipelineName,
} from '../src/latent-frame.js';

// ── Small fixture: 2 channels × 4×4 spatial ─────────────────────────────────
const SHAPE = [2, 4, 4] as const;
const C = SHAPE[0];
const SPATIAL = SHAPE[1] * SHAPE[2];

function makeFixtureLatent(): Float32Array {
  // Two channels with very different scales so per-channel quantization
  // exercises both. Channel 0 ranges roughly [-1, +1]; channel 1 ranges
  // roughly [-0.1, +0.1]. Values chosen to be exactly representable in fp16
  // so the encoder + decoder agree to the bit on quantization grids.
  const out = new Float32Array(C * SPATIAL);
  for (let i = 0; i < SPATIAL; i++) out[i] = (i - SPATIAL / 2) / (SPATIAL / 2);
  for (let i = 0; i < SPATIAL; i++) out[SPATIAL + i] = ((i - SPATIAL / 2) / (SPATIAL / 2)) * 0.1;
  return out;
}

function maxAbsErr(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > m) m = d;
  }
  return m;
}

function staticScalesFor(latent: Float32Array): Float32Array {
  return computeScales(latent, SHAPE);
}

// ── fp16 helpers ────────────────────────────────────────────────────────────

describe('fp16 helpers', () => {
  test('f16ToF32(f32ToF16(x)) round-trips canonical values', () => {
    const cases = [0, 1, -1, 0.5, -0.5, 65504, -65504, 6.103515625e-5];
    for (const x of cases) {
      assert.equal(f16ToF32(f32ToF16(x)), x, `round-trip ${x}`);
    }
  });

  test('scalesToBytes / scalesFromBytes round-trip', () => {
    const s = new Float32Array([0.5, 1.0, 0.0625, 16.0]);
    const bytes = scalesToBytes(s);
    assert.equal(bytes.length, s.length * 2);
    const back = scalesFromBytes(bytes);
    for (let i = 0; i < s.length; i++) assert.equal(back[i], s[i]);
  });
});

// ── int4 packing ────────────────────────────────────────────────────────────

describe('int4 packing', () => {
  test('packInt4LowFirst / unpackInt4LowFirst round-trip even length', () => {
    const v = new Int8Array([0, 1, -1, 7, -7, 3, -3, 5]);
    const packed = packInt4LowFirst(v);
    assert.equal(packed.length, v.length / 2);
    const back = unpackInt4LowFirst(packed, v.length);
    for (let i = 0; i < v.length; i++) assert.equal(back[i], v[i]);
  });

  test('round-trip odd length pads high nibble with 0', () => {
    const v = new Int8Array([3, -3, 7]);
    const packed = packInt4LowFirst(v);
    assert.equal(packed.length, 2);
    const back = unpackInt4LowFirst(packed, v.length);
    for (let i = 0; i < v.length; i++) assert.equal(back[i], v[i]);
  });

  test('low nibble carries the first value', () => {
    // [3, -3] -> low: 3 (0x3), high: -3 -> 0xd (sign-extended). Byte = 0xd3.
    const packed = packInt4LowFirst(new Int8Array([3, -3]));
    assert.equal(packed[0], 0xd3);
  });
});

// ── Pipeline round-trip ─────────────────────────────────────────────────────

describe('pipeline round-trip', () => {
  for (const pipeline of PIPELINE_NAMES) {
    test(`${pipeline}: encoder → decoder reconstructs within tolerance`, () => {
      const latent = makeFixtureLatent();
      const useStaticScales =
        pipeline === 'int8' || pipeline === 'int4';
      const enc = new LatentStreamEncoder({
        latentSpaceId: 'test/round-trip',
        shape: SHAPE,
        dtype: 'fp16',
        pipeline: pipeline as PipelineName,
        staticScales: useStaticScales ? staticScalesFor(latent) : undefined,
      });

      const headerBytes = enc.header();
      const frameBytes = enc.frame(latent, { seq: 0, keyframe: true, done: true });

      const header = decodeLatentHeaderMsgpack(headerBytes);
      const frame = decodeLatentFrameMsgpack(frameBytes);
      assert.equal(header.pipeline, pipeline);
      assert.equal(header.shape.length, SHAPE.length);
      for (let i = 0; i < SHAPE.length; i++) assert.equal(header.shape[i], SHAPE[i]);

      const dec = new LatentStreamDecoder(header);
      const reconstructed = dec.decodeFrame(frame);

      const err = maxAbsErr(latent, reconstructed);
      // Tolerances: raw = bit-exact (within fp16 round-trip);
      // int8 / int8-adaptive / delta+int8 = within (max_channel_scale / 127);
      // int4 / int4-adaptive / delta+int4 = within (max_channel_scale / 7).
      let tolerance: number;
      if (pipeline === 'raw') {
        tolerance = 1e-3;
      } else if (pipeline === 'int8' || pipeline === 'int8-adaptive' || pipeline === 'delta+int8') {
        tolerance = 1.0 / 127 + 1e-4;
      } else {
        tolerance = 1.0 / 7 + 1e-3;
      }
      assert.ok(
        err < tolerance,
        `pipeline ${pipeline}: max abs err ${err} > tolerance ${tolerance}`,
      );
    });
  }

  test('delta+int8: video stream of 3 frames round-trips', () => {
    const enc = new LatentStreamEncoder({
      latentSpaceId: 'test/video',
      shape: SHAPE,
      dtype: 'fp16',
      pipeline: 'delta+int8',
      fps: 24,
      totalFrames: 3,
    });
    const dec = new LatentStreamDecoder(decodeLatentHeaderMsgpack(enc.header()));

    const f0 = makeFixtureLatent();
    const f1 = new Float32Array(f0); for (let i = 0; i < f1.length; i++) f1[i]! += 0.01;
    const f2 = new Float32Array(f0); for (let i = 0; i < f2.length; i++) f2[i]! += 0.02;

    const r0 = dec.decodeFrame(decodeLatentFrameMsgpack(enc.frame(f0, { seq: 0, keyframe: true })));
    const r1 = dec.decodeFrame(decodeLatentFrameMsgpack(enc.frame(f1, { seq: 1, keyframe: false })));
    const r2 = dec.decodeFrame(decodeLatentFrameMsgpack(enc.frame(f2, { seq: 2, keyframe: false, done: true, finishReason: 'ok' })));

    // Each decoded frame within int8 tolerance of the original.
    const tol = 2.0 / 127 + 1e-3; // delta accumulates one quantum of drift.
    assert.ok(maxAbsErr(f0, r0) < tol, 'frame 0 within tol');
    assert.ok(maxAbsErr(f1, r1) < tol, 'frame 1 within tol');
    assert.ok(maxAbsErr(f2, r2) < tol, 'frame 2 within tol');
  });
});

// ── Encoder validation ──────────────────────────────────────────────────────

describe('encoder validation', () => {
  test('rejects unknown pipeline', () => {
    assert.throws(() => new LatentStreamEncoder({
      latentSpaceId: 'x', shape: SHAPE, dtype: 'fp16',
      pipeline: 'bogus' as PipelineName,
    }), /unknown pipeline/);
  });

  test('static-scale pipeline requires staticScales', () => {
    assert.throws(() => new LatentStreamEncoder({
      latentSpaceId: 'x', shape: SHAPE, dtype: 'fp16',
      pipeline: 'int8',
    }), /requires staticScales/);
  });

  test('non-static pipeline rejects staticScales', () => {
    assert.throws(() => new LatentStreamEncoder({
      latentSpaceId: 'x', shape: SHAPE, dtype: 'fp16',
      pipeline: 'int8-adaptive',
      staticScales: new Float32Array([1, 1]),
    }), /doesn't accept staticScales/);
  });

  test('staticScales length must equal shape[0]', () => {
    assert.throws(() => new LatentStreamEncoder({
      latentSpaceId: 'x', shape: SHAPE, dtype: 'fp16',
      pipeline: 'int8',
      staticScales: new Float32Array([1, 1, 1]),
    }), /staticScales must have length/);
  });

  test('seq must be monotonically increasing', () => {
    const enc = new LatentStreamEncoder({
      latentSpaceId: 'x', shape: SHAPE, dtype: 'fp16',
      pipeline: 'int8-adaptive',
    });
    enc.frame(makeFixtureLatent(), { seq: 0, keyframe: true });
    assert.throws(() => enc.frame(makeFixtureLatent(), { seq: 0, keyframe: true }),
      /monotonically increasing/);
  });

  test('delta+int8 first frame must be keyframe', () => {
    const enc = new LatentStreamEncoder({
      latentSpaceId: 'x', shape: SHAPE, dtype: 'fp16',
      pipeline: 'delta+int8',
    });
    assert.throws(() => enc.frame(makeFixtureLatent(), { seq: 0, keyframe: false }),
      /first frame in stream must be keyframe/);
  });
});

// ── msgpack header / frame shape ────────────────────────────────────────────

describe('msgpack header + frame shape', () => {
  test('header carries fps + total_frames + vae_scale_factor when set', () => {
    const bytes = encodeLatentHeaderMsgpack({
      latent_space_id: 'sd-vae-ft-mse',
      shape: [4, 64, 64],
      dtype: 'fp16',
      pipeline: 'int8-adaptive',
      fps: 24,
      total_frames: 120,
      vae_scale_factor: 0.18215,
    });
    const h = decodeLatentHeaderMsgpack(bytes);
    assert.equal(h.fps, 24);
    assert.equal(h.total_frames, 120);
    assert.equal(h.vae_scale_factor, 0.18215);
  });

  test('frame omits finish_reason when not set', () => {
    const bytes = encodeLatentFrameMsgpack({
      data: new Uint8Array([1, 2, 3]),
      seq: 0, keyframe: true, done: false,
    });
    const f = decodeLatentFrameMsgpack(bytes);
    assert.equal(f.finish_reason, undefined);
    assert.deepEqual(Array.from(f.data), [1, 2, 3]);
  });

  test('decoder rejects header with type !== "header"', async () => {
    // Encode raw msgpack that looks like a frame, not a header. The decoder
    // detects the mismatch via the `type` discriminator.
    const { encode } = await import('@msgpack/msgpack');
    const bytes = encode({ type: 'frame', latent_space_id: 'x', shape: SHAPE, dtype: 'fp16', pipeline: 'raw' });
    assert.throws(() => decodeLatentHeaderMsgpack(bytes), /expected type:'header'/);
  });

  test('decoder rejects header missing required fields', async () => {
    // Build a msgpack object that genuinely lacks `dtype` (the encoder
    // would normally set it to undefined which serialises as a key — we
    // bypass the encoder here and emit the bare msgpack ourselves).
    const { encode } = await import('@msgpack/msgpack');
    const bytes = encode({ type: 'header', latent_space_id: 'x', shape: SHAPE, pipeline: 'raw' });
    assert.throws(() => decodeLatentHeaderMsgpack(bytes), /missing required field: dtype/);
  });
});
