/**
 * @codecai/web: latent-frame round-trip tests across all 7 pipelines.
 *
 * Goal: prove the TypeScript port (`src/latent-frame.ts`) is byte-identical
 * to the Python reference (`packages/python/src/codecai/server/latent_frame.py`)
 * at the latent-byte boundary. We exercise both halves in-process: encode
 * with `LatentStreamEncoder`, decode with `LatentStreamDecoder`, assert that
 * the reconstructed tensor matches the input within the per-pipeline
 * tolerance set by the spec (raw = bit-exact; quantizing pipelines = within
 * one quantum of round-trip drift).
 *
 * Conformance against the Python encoder's golden bytes happens at
 * packages/bench/golden/pipelines/<name>/, exercised by the bench
 * harness.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  PIPELINE_NAMES,
  LatentStreamEncoder,
  LatentStreamDecoder,
  ActivationStreamEncoder,
  ActivationStreamDecoder,
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
    // Encode raw msgpack shaped like a frame. The decoder
    // detects the mismatch via the `type` discriminator.
    const { encode } = await import('@msgpack/msgpack');
    const bytes = encode({ type: 'frame', latent_space_id: 'x', shape: SHAPE, dtype: 'fp16', pipeline: 'raw' });
    assert.throws(() => decodeLatentHeaderMsgpack(bytes), /expected type:'header'/);
  });

  test('decoder rejects header missing required fields', async () => {
    // Build a msgpack object that genuinely lacks `dtype` (the encoder
    // would normally set it to undefined which serialises as a key: we
    // bypass the encoder here and emit the bare msgpack ourselves).
    const { encode } = await import('@msgpack/msgpack');
    const bytes = encode({ type: 'header', latent_space_id: 'x', shape: SHAPE, pipeline: 'raw' });
    assert.throws(() => decodeLatentHeaderMsgpack(bytes), /missing required field: dtype/);
  });
});

// ── Activation profile (v0.6+) ──────────────────────────────────────────────
//
// Per-token transformer activations for legion's pipeline-split stage
// protocol. Unlike the video/image latent modality above, tokenCount
// varies per frame (prefill chunks vs single decode tokens). These
// streams use `ActivationStreamEncoder` / `ActivationStreamDecoder`,
// a separate pair from `LatentStreamEncoder` / `LatentStreamDecoder`. See spec/PIPELINES.md
// § Activation profile. Golden fixtures live at
// packages/bench/golden/pipelines/activation/ and freeze the exact bytes
// these classes must keep reproducing.

function makeTokenMajor(tokenCount: number, nEmbd: number, offset = 0): Float32Array {
  // Deterministic, fp16-exact values (small quarter/eighth steps) so fp32
  // and fp16 payloads agree bit-for-bit modulo dtype width.
  const out = new Float32Array(tokenCount * nEmbd);
  for (let t = 0; t < tokenCount; t++) {
    for (let e = 0; e < nEmbd; e++) {
      out[t * nEmbd + e] = (t - tokenCount / 2) * 0.5 + e / 8 + offset;
    }
  }
  return out;
}

describe('activation profile: header round-trip', () => {
  test('header carries profile + nEmbd, omits shape', () => {
    const enc = new ActivationStreamEncoder({
      latentSpaceId: 'legion/pipeline-split/test-model',
      nEmbd: 16,
      dtype: 'fp32',
    });
    const header = decodeLatentHeaderMsgpack(enc.header());
    assert.equal(header.profile, 'activation');
    assert.equal(header.nEmbd, 16);
    assert.equal(header.pipeline, 'raw');
    assert.equal(header.dtype, 'fp32');
    assert.equal(header.shape, undefined);
  });

  test('non-activation header is unaffected: shape still required, profile/nEmbd absent', () => {
    const enc = new LatentStreamEncoder({
      latentSpaceId: 'sd-vae-ft-mse', shape: SHAPE, dtype: 'fp16', pipeline: 'raw',
    });
    const header = decodeLatentHeaderMsgpack(enc.header());
    assert.equal(header.profile, undefined);
    assert.equal(header.nEmbd, undefined);
    assert.deepEqual([...header.shape!], [...SHAPE]);
  });

  test('decodeLatentHeaderMsgpack rejects activation header missing nEmbd', async () => {
    const { encode } = await import('@msgpack/msgpack');
    const bytes = encode({
      type: 'header', latent_space_id: 'x', dtype: 'fp32', pipeline: 'raw', profile: 'activation',
    });
    assert.throws(() => decodeLatentHeaderMsgpack(bytes), /missing required field: nEmbd/);
  });

  test('ActivationStreamDecoder rejects a non-activation header', () => {
    const enc = new LatentStreamEncoder({
      latentSpaceId: 'x', shape: SHAPE, dtype: 'fp16', pipeline: 'raw',
    });
    const header = decodeLatentHeaderMsgpack(enc.header());
    assert.throws(() => new ActivationStreamDecoder(header), /requires header\.profile === 'activation'/);
  });

  test('LatentStreamDecoder rejects an activation header (no fixed shape)', () => {
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd: 8, dtype: 'fp32' });
    const header = decodeLatentHeaderMsgpack(enc.header());
    assert.throws(() => new LatentStreamDecoder(header), /requires header\.shape/);
  });
});

describe('activation profile: frame round-trip', () => {
  test('raw fp32: single decode token (tokenCount=1)', () => {
    const nEmbd = 12;
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd, dtype: 'fp32' });
    const dec = new ActivationStreamDecoder(decodeLatentHeaderMsgpack(enc.header()));

    const activations = makeTokenMajor(1, nEmbd);
    const frameBytes = enc.frame(activations, { seq: 0, keyframe: true, posStart: 7, stageIndex: 2 });
    const frame = decodeLatentFrameMsgpack(frameBytes);
    assert.equal(frame.tokenCount, 1);
    assert.equal(frame.posStart, 7);
    assert.equal(frame.stageIndex, 2);
    assert.equal(frame.tokens, undefined);

    const decoded = dec.decodeFrame(frame);
    assert.equal(decoded.tokenCount, 1);
    assert.equal(decoded.posStart, 7);
    assert.equal(decoded.stageIndex, 2);
    assert.deepEqual(Array.from(decoded.activations), Array.from(activations));
  });

  test('raw fp32: prefill chunk (tokenCount>1) with tokens[] sideband', () => {
    const nEmbd = 6;
    const tokenCount = 5;
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd, dtype: 'fp32' });
    const dec = new ActivationStreamDecoder(decodeLatentHeaderMsgpack(enc.header()));

    const activations = makeTokenMajor(tokenCount, nEmbd);
    const tokens = [11, 22, 33, 44, 55];
    const frameBytes = enc.frame(activations, {
      seq: 0, keyframe: true, done: true, posStart: 0, tokens, stageIndex: 0,
    });
    const decoded = dec.decodeFrame(decodeLatentFrameMsgpack(frameBytes));
    assert.equal(decoded.tokenCount, tokenCount);
    assert.deepEqual(decoded.tokens, tokens);
    assert.equal(decoded.posStart, 0);
    assert.equal(decoded.stageIndex, 0);
    assert.deepEqual(Array.from(decoded.activations), Array.from(activations));
  });

  test('raw fp16: prefill chunk round-trips within fp16 rounding', () => {
    const nEmbd = 8;
    const tokenCount = 4;
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd, dtype: 'fp16' });
    const dec = new ActivationStreamDecoder(decodeLatentHeaderMsgpack(enc.header()));

    const activations = makeTokenMajor(tokenCount, nEmbd);
    const frameBytes = enc.frame(activations, { seq: 0, keyframe: true, posStart: 100, tokens: [1, 2, 3, 4] });
    const decoded = dec.decodeFrame(decodeLatentFrameMsgpack(frameBytes));
    assert.equal(decoded.tokenCount, tokenCount);
    // Fixture values are fp16-exact. This round-trips bit-for-bit.
    assert.deepEqual(Array.from(decoded.activations), Array.from(activations));
  });

  test('varying tokenCount across frames on the same stream (prefill then decode)', () => {
    const nEmbd = 4;
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd, dtype: 'fp32' });
    const dec = new ActivationStreamDecoder(decodeLatentHeaderMsgpack(enc.header()));

    const prefill = makeTokenMajor(6, nEmbd);
    const d0 = dec.decodeFrame(decodeLatentFrameMsgpack(
      enc.frame(prefill, { seq: 0, keyframe: true, posStart: 0, tokens: [1, 2, 3, 4, 5, 6] }),
    ));
    assert.equal(d0.tokenCount, 6);

    const decode1 = makeTokenMajor(1, nEmbd, 1);
    const d1 = dec.decodeFrame(decodeLatentFrameMsgpack(
      enc.frame(decode1, { seq: 1, keyframe: false, posStart: 6 }),
    ));
    assert.equal(d1.tokenCount, 1);
    assert.deepEqual(Array.from(d1.activations), Array.from(decode1));
  });
});

describe('activation profile: error cases', () => {
  test('encoder rejects nEmbd that does not divide activations length', () => {
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd: 5, dtype: 'fp32' });
    assert.throws(
      () => enc.frame(new Float32Array(7), { seq: 0, keyframe: true }),
      /not a multiple of nEmbd/,
    );
  });

  test('encoder rejects tokens[] length mismatch against derived tokenCount', () => {
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd: 4, dtype: 'fp32' });
    assert.throws(
      () => enc.frame(makeTokenMajor(3, 4), { seq: 0, keyframe: true, tokens: [1, 2] }),
      /tokens length 2 does not match derived tokenCount 3/,
    );
  });

  test('decoder rejects frame missing tokenCount', () => {
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd: 4, dtype: 'fp32' });
    const dec = new ActivationStreamDecoder(decodeLatentHeaderMsgpack(enc.header()));
    const bareFrame = decodeLatentFrameMsgpack(encodeLatentFrameMsgpack({
      data: new Uint8Array(16), seq: 0, keyframe: true, done: false,
    }));
    assert.throws(() => dec.decodeFrame(bareFrame), /missing required field: tokenCount/);
  });

  test('decoder rejects payload length mismatch vs tokenCount * nEmbd * dtypeSize', () => {
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd: 4, dtype: 'fp32' });
    const dec = new ActivationStreamDecoder(decodeLatentHeaderMsgpack(enc.header()));
    // tokenCount=2, nEmbd=4, fp32 → expects 32 bytes; hand-craft 16.
    const badFrame = decodeLatentFrameMsgpack(encodeLatentFrameMsgpack({
      data: new Uint8Array(16), seq: 0, keyframe: true, done: false, tokenCount: 2,
    }));
    assert.throws(
      () => dec.decodeFrame(badFrame),
      /payload length 16 does not match tokenCount\(2\) \* nEmbd\(4\) \* dtypeSize = 32/,
    );
  });

  test('decoder rejects tokens[] length mismatch against frame tokenCount', () => {
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd: 4, dtype: 'fp32' });
    const dec = new ActivationStreamDecoder(decodeLatentHeaderMsgpack(enc.header()));
    const frame = decodeLatentFrameMsgpack(encodeLatentFrameMsgpack({
      data: new Uint8Array(32), seq: 0, keyframe: true, done: false, tokenCount: 2, tokens: [1, 2, 3],
    }));
    assert.throws(() => dec.decodeFrame(frame), /tokens length 3 does not match tokenCount 2/);
  });

  test('encoder constructor rejects non-integer / non-positive nEmbd', () => {
    assert.throws(() => new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd: 0, dtype: 'fp32' }),
      /nEmbd must be a positive integer/);
    assert.throws(() => new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd: 2.5, dtype: 'fp32' }),
      /nEmbd must be a positive integer/);
  });

  test('encoder + decoder throw a clear error for unimplemented pipelines (int8 not shipped yet)', () => {
    const enc = new ActivationStreamEncoder({ latentSpaceId: 'x', nEmbd: 4, dtype: 'fp32', pipeline: 'int8' });
    assert.throws(
      () => enc.frame(makeTokenMajor(2, 4), { seq: 0, keyframe: true }),
      /pipeline "int8" is not yet implemented/,
    );
  });
});

describe('activation profile: golden fixtures (packages/bench/golden/pipelines/activation/)', () => {
  const FIXTURE_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'bench', 'golden', 'pipelines', 'activation',
  );

  function loadFixture(name: string): any {
    return JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
  }

  function fromB64(b64: string): Uint8Array {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  const FIXTURE_NAMES = ['raw-fp32-prefill', 'raw-fp32-decode', 'raw-fp16-prefill'];

  for (const name of FIXTURE_NAMES) {
    test(`${name}: frozen header/frame bytes decode to the fixture's metadata`, () => {
      const fx = loadFixture(name);
      const headerBytes = fromB64(fx.header_msgpack_b64);
      const frameBytes = fromB64(fx.frame_msgpack_b64);

      const header = decodeLatentHeaderMsgpack(headerBytes);
      assert.equal(header.profile, 'activation');
      assert.equal(header.nEmbd, fx.nEmbd);
      assert.equal(header.dtype, fx.dtype);
      assert.equal(header.pipeline, fx.pipeline);
      assert.equal(header.latent_space_id, fx.latent_space_id);

      const frame = decodeLatentFrameMsgpack(frameBytes);
      assert.equal(frame.tokenCount, fx.frame_meta.tokenCount);
      assert.equal(frame.posStart, fx.frame_meta.posStart);
      assert.equal(frame.stageIndex, fx.frame_meta.stageIndex);
      assert.deepEqual(frame.tokens, fx.frame_meta.tokens);

      const dec = new ActivationStreamDecoder(header);
      const decoded = dec.decodeFrame(frame);
      const flatExpected = (fx.activations as number[][]).flat();
      assert.deepEqual(Array.from(decoded.activations), flatExpected);
    });

    test(`${name}: re-encoding the fixture's inputs reproduces the frozen bytes exactly`, () => {
      const fx = loadFixture(name);
      const enc = new ActivationStreamEncoder({
        latentSpaceId: fx.latent_space_id,
        nEmbd: fx.nEmbd,
        dtype: fx.dtype,
      });
      const headerBytes = enc.header();
      const activations = Float32Array.from((fx.activations as number[][]).flat());
      const frameBytes = enc.frame(activations, {
        seq: fx.frame_meta.seq,
        keyframe: fx.frame_meta.keyframe,
        done: fx.frame_meta.done,
        posStart: fx.frame_meta.posStart,
        tokens: fx.frame_meta.tokens,
        stageIndex: fx.frame_meta.stageIndex,
      });

      assert.deepEqual(Array.from(headerBytes), Array.from(fromB64(fx.header_msgpack_b64)));
      assert.deepEqual(Array.from(frameBytes), Array.from(fromB64(fx.frame_msgpack_b64)));
    });
  }
});

describe('fp32 payload alignment (regression)', () => {
  test('decodeFrame handles msgpack payloads at non-4-aligned byte offsets', () => {
    // posStart/tokens sideband shifts the bin payload to an arbitrary offset
    // inside the msgpack buffer; the fp32 path must not assume 4-alignment.
    const enc = new ActivationStreamEncoder({
      latentSpaceId: 'activation:alignment-regression',
      nEmbd: 8,
      dtype: 'fp32',
    });
    const header = decodeLatentHeaderMsgpack(enc.header());
    const dec = new ActivationStreamDecoder(header);
    const activations = new Float32Array([1.5, -2.25, 3, 4, 5, 6, 7, 8.125]);
    // Sweep sideband variants so at least one lands the bin payload on a
    // misaligned offset regardless of msgpack key layout.
    for (const opts of [
      { seq: 1, keyframe: true, done: false, posStart: 42 },
      { seq: 2, keyframe: true, done: false, posStart: 42, stageIndex: 0 },
      { seq: 3, keyframe: true, done: false, posStart: 1, tokens: [9], stageIndex: 3 },
      { seq: 4, keyframe: true, done: false },
    ]) {
      const bytes = enc.frame(activations, opts);
      const frame = decodeLatentFrameMsgpack(bytes);
      const out = dec.decodeFrame(frame);
      assert.deepEqual(Array.from(out.activations), Array.from(activations));
    }
  });
});

// ── Truncated / oversized payload rejection (v0.6) ──────────────────────────
//
// The decoder derives the element count from the header's declared `shape`.
// Nothing on the wire forces the frame payload to match that count. Before
// these tests the raw/fp32 path built a `Float32Array` view sized from the
// header alone. A short payload then read past the end of the msgpack bin
// and surfaced neighbouring wire bytes as tensor values.

describe('frame payload length validation', () => {
  function frameWith(data: Uint8Array, extra: Record<string, unknown> = {}) {
    return decodeLatentFrameMsgpack(
      encodeLatentFrameMsgpack({
        data, seq: 0, keyframe: true, done: false, ...extra,
      } as never),
    );
  }

  test('raw/fp32 rejects a payload shorter than the declared shape', () => {
    const header = decodeLatentHeaderMsgpack(
      encodeLatentHeaderMsgpack({
        latent_space_id: 'trunc:fp32', shape: [1, 4], dtype: 'fp32', pipeline: 'raw',
      }),
    );
    const dec = new LatentStreamDecoder(header);
    // 4 declared elements = 16 bytes. Send 4.
    assert.throws(
      () => dec.decodeFrame(frameWith(new Uint8Array([0, 0, 0x80, 0x3f]))),
      /length/i,
    );
  });

  test('raw/fp32 does not surface neighbouring msgpack bytes as values', () => {
    const header = decodeLatentHeaderMsgpack(
      encodeLatentHeaderMsgpack({
        latent_space_id: 'leak:fp32', shape: [1, 4], dtype: 'fp32', pipeline: 'raw',
      }),
    );
    const dec = new LatentStreamDecoder(header);
    // `finish_reason` puts recognisable bytes after the bin payload.
    const frame = frameWith(new Uint8Array([0, 0, 0x80, 0x3f]), {
      finish_reason: 'AAAAAAAAAAAAAAAA',
    });
    assert.equal(frame.data.byteOffset % 4, 0, 'precondition: aligned fast path');
    let out: Float32Array | null = null;
    try { out = dec.decodeFrame(frame); } catch { /* rejecting is the fix */ }
    if (out !== null) {
      assert.fail(`decoded ${out.length} floats from a 4-byte payload: ${Array.from(out)}`);
    }
  });

  test('raw/fp32 rejects a payload longer than the declared shape', () => {
    const header = decodeLatentHeaderMsgpack(
      encodeLatentHeaderMsgpack({
        latent_space_id: 'over:fp32', shape: [1, 2], dtype: 'fp32', pipeline: 'raw',
      }),
    );
    const dec = new LatentStreamDecoder(header);
    assert.throws(() => dec.decodeFrame(frameWith(new Uint8Array(64))), /length/i);
  });

  test('raw/int8 rejects a short payload', () => {
    const header = decodeLatentHeaderMsgpack(
      encodeLatentHeaderMsgpack({
        latent_space_id: 'trunc:int8', shape: [1, 20], dtype: 'int8', pipeline: 'raw',
      }),
    );
    const dec = new LatentStreamDecoder(header);
    assert.throws(() => dec.decodeFrame(frameWith(new Uint8Array(8))), /length/i);
  });

  test('int4 pipeline rejects a short payload', () => {
    const header = decodeLatentHeaderMsgpack(
      encodeLatentHeaderMsgpack({
        latent_space_id: 'trunc:int4', shape: [8, 8], dtype: 'fp16',
        pipeline: 'int4', scales: new Uint8Array(16),
      }),
    );
    const dec = new LatentStreamDecoder(header);
    // 64 declared elements = 32 packed bytes. Send 1.
    assert.throws(() => dec.decodeFrame(frameWith(new Uint8Array([0xff]))), /length/i);
  });

  test('int4-adaptive rejects a payload too short to hold its scales', () => {
    const header = decodeLatentHeaderMsgpack(
      encodeLatentHeaderMsgpack({
        latent_space_id: 'trunc:int4a', shape: [4, 4], dtype: 'fp16',
        pipeline: 'int4-adaptive',
      }),
    );
    const dec = new LatentStreamDecoder(header);
    // C=4 needs 8 scale bytes plus 8 packed bytes. Send 4 total.
    assert.throws(() => dec.decodeFrame(frameWith(new Uint8Array(4))), /length/i);
  });

  test('a 1-byte frame cannot force a large allocation', () => {
    const header = decodeLatentHeaderMsgpack(
      encodeLatentHeaderMsgpack({
        latent_space_id: 'dos:int4', shape: [100000, 1000], dtype: 'fp16',
        pipeline: 'int4', scales: new Uint8Array(200000),
      }),
    );
    const dec = new LatentStreamDecoder(header);
    assert.throws(() => dec.decodeFrame(frameWith(new Uint8Array([0x11]))), /length/i);
  });

  test('unpackInt4LowFirst rejects a buffer too short for expectedLen', () => {
    assert.throws(() => unpackInt4LowFirst(new Uint8Array([0xff]), 64), /length/i);
  });

  test('an empty shape is rejected at construction', () => {
    const header = decodeLatentHeaderMsgpack(
      encodeLatentHeaderMsgpack({
        latent_space_id: 'shape:empty', shape: [], dtype: 'fp32', pipeline: 'raw',
      }),
    );
    assert.throws(() => new LatentStreamDecoder(header), /shape/i);
  });

  test('a non-integer or non-positive shape entry is rejected at construction', () => {
    for (const shape of [[0, 4], [-1, 4], [1.5, 4], [1, Number.NaN]]) {
      const header = decodeLatentHeaderMsgpack(
        encodeLatentHeaderMsgpack({
          latent_space_id: 'shape:bad', shape, dtype: 'fp32', pipeline: 'raw',
        }),
      );
      assert.throws(
        () => new LatentStreamDecoder(header), /shape/i,
        `shape ${JSON.stringify(shape)} should be rejected`,
      );
    }
  });

  test('a well-formed frame still round-trips on every pipeline', () => {
    for (const p of PIPELINE_NAMES) {
      const latent = makeFixtureLatent();
      const staticScales = p === 'int8' || p === 'int4'
        ? computeScales(latent, SHAPE) : undefined;
      const enc = new LatentStreamEncoder({
        latentSpaceId: `ok:${p}`, shape: [...SHAPE], dtype: 'fp16', pipeline: p,
        ...(staticScales ? { staticScales } : {}),
      });
      const header = decodeLatentHeaderMsgpack(enc.header(latent));
      const dec = new LatentStreamDecoder(header);
      const frame = decodeLatentFrameMsgpack(
        enc.frame(latent, { seq: 0, keyframe: true, done: false }),
      );
      const out = dec.decodeFrame(frame);
      assert.equal(out.length, C * SPATIAL, `pipeline ${p} length`);
    }
  });
});
