/**
 * Codec latent-modality frame encoding (v0.3+).
 *
 * TypeScript twin of `packages/python/src/codecai/server/latent_frame.py`.
 * Same wire shape, same pipeline math, same conformance fixtures
 * (`packages/bench/golden/pipelines/<name>/`). The Python file is the
 * canonical reference encoder; this module is its byte-for-byte twin
 * for browser + Node + edge runtimes.
 *
 * Wire format (msgpack):
 *   Header — first frame in the response body:
 *     { type: 'header',
 *       latent_space_id: string, shape: number[], dtype: string,
 *       pipeline: string,
 *       scales?: Uint8Array, fps?: number,
 *       total_frames?: number, vae_scale_factor?: number }
 *   Frame  — every subsequent frame:
 *     { data: Uint8Array, seq: number, keyframe: boolean,
 *       done: boolean, finish_reason?: string }
 *
 * Pipeline math is pinned in spec/PIPELINES.md. This module implements
 * forward (server-side) AND inverse (client-side) for all seven
 * pipelines. The protobuf encoder is intentionally NOT ported in this
 * pass — msgpack is the primary v0.3 wire format and the protobuf side
 * is a straight follow-up against the same Python reference.
 */

import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

// ── Pipeline registry (mirrors PIPELINE_NAMES in latent_frame.py) ───────────

export const PIPELINE_NAMES = [
  'raw',
  'int8',
  'int4',
  'int8-adaptive',
  'int4-adaptive',
  'delta+int8',
  'delta+int4',
] as const;

export type PipelineName = (typeof PIPELINE_NAMES)[number];

const STATIC_SCALE_PIPELINES = new Set<PipelineName>(['int8', 'int4']);
const ADAPTIVE_SCALE_PIPELINES = new Set<PipelineName>([
  'int8-adaptive', 'int4-adaptive', 'delta+int8', 'delta+int4',
]);
const DELTA_PIPELINES = new Set<PipelineName>(['delta+int8', 'delta+int4']);
const INT4_PIPELINES = new Set<PipelineName>([
  'int4', 'int4-adaptive', 'delta+int4',
]);

export type LatentDtype = 'fp32' | 'fp16' | 'bf16' | 'int8' | 'int4';

// ── Public types ────────────────────────────────────────────────────────────

/** Every latent stream begins with exactly one header. */
export interface LatentStreamHeader {
  readonly latent_space_id: string;
  readonly shape: readonly number[];
  readonly dtype: LatentDtype;
  readonly pipeline: PipelineName;
  /** Static-scale pipelines only: fp16 LE bytes of length 2*C. */
  readonly scales?: Uint8Array;
  readonly fps?: number;
  readonly total_frames?: number;
  readonly vae_scale_factor?: number;
}

/** Every frame after the header. */
export interface LatentFrame {
  readonly data: Uint8Array;
  readonly seq: number;
  readonly keyframe: boolean;
  readonly done: boolean;
  readonly finish_reason?: string;
}

// ── fp16 helpers (no native JS support — pack via DataView) ─────────────────

/**
 * Pack one fp32 number into a uint16 IEEE 754 fp16 representation. Round-half-
 * to-even, full subnormal/Inf/NaN handling. Matches numpy's float16
 * conversion bit-for-bit on common inputs (modulo platform-specific NaN
 * payload bits, which msgpack ships opaquely as bytes anyway).
 */
function f32ToF16(value: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = value;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const expo = ((x >>> 23) & 0xff) - (127 - 15);
  const mant = x & 0x7fffff;

  if (expo >= 0x1f) {
    // Inf or NaN → fp16 Inf or quiet NaN. Preserve mantissa truthiness.
    return sign | 0x7c00 | (mant ? 0x0200 : 0);
  }
  if (expo <= 0) {
    // Subnormal or zero. Shift mantissa right by (1 - expo); add hidden 1
    // back when expo > -10 (otherwise it underflows to 0).
    if (expo < -10) return sign;
    const m = (mant | 0x800000) >>> (1 - expo);
    // Round-half-to-even: add 0x1000 if next bit is 1 AND (sticky OR even).
    const round = m & 0x1fff;
    let result = m >>> 13;
    if (round > 0x1000 || (round === 0x1000 && (result & 1))) result++;
    return sign | result;
  }
  // Normal range. Pack expo + mantissa, then round-half-to-even.
  const round = mant & 0x1fff;
  let h = sign | (expo << 10) | (mant >>> 13);
  if (round > 0x1000 || (round === 0x1000 && (h & 1))) h++;
  return h;
}

function f16ToF32(u16: number): number {
  const sign = (u16 & 0x8000) >>> 15;
  const expo = (u16 & 0x7c00) >>> 10;
  const mant = u16 & 0x03ff;
  if (expo === 0) {
    if (mant === 0) return sign ? -0 : 0;
    // Subnormal: 2^-14 * (mant / 1024)
    return (sign ? -1 : 1) * Math.pow(2, -14) * (mant / 1024);
  }
  if (expo === 0x1f) {
    if (mant === 0) return sign ? -Infinity : Infinity;
    return NaN;
  }
  // Normal: (-1)^s * 2^(expo-15) * (1 + mant/1024)
  return (sign ? -1 : 1) * Math.pow(2, expo - 15) * (1 + mant / 1024);
}

/** Encode a Float32Array of per-channel scales as C × 2 LE fp16 bytes. */
export function scalesToBytes(scales: Float32Array): Uint8Array {
  const out = new Uint8Array(scales.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < scales.length; i++) {
    view.setUint16(i * 2, f32ToF16(scales[i]!), true /* little-endian */);
  }
  return out;
}

/** Decode C × 2 LE fp16 bytes into a Float32Array of length C. */
export function scalesFromBytes(bytes: Uint8Array): Float32Array {
  if (bytes.length % 2 !== 0) {
    throw new Error(`scales byte length must be even (got ${bytes.length})`);
  }
  const C = bytes.length / 2;
  const out = new Float32Array(C);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < C; i++) {
    out[i] = f16ToF32(view.getUint16(i * 2, true));
  }
  return out;
}

// ── Pipeline math (mirrors latent_frame.py forward path) ────────────────────

/**
 * Per-channel max(abs) over the spatial axes. Returns Float32Array of length C.
 * Caller guarantees latent.shape[0] = C and the rest is the spatial volume.
 */
export function computeScales(latent: Float32Array, shape: readonly number[]): Float32Array {
  const C = shape[0]!;
  const spatial = shape.slice(1).reduce((a, b) => a * b, 1);
  const out = new Float32Array(C);
  for (let c = 0; c < C; c++) {
    let m = 0;
    const off = c * spatial;
    for (let i = 0; i < spatial; i++) {
      const a = Math.abs(latent[off + i]!);
      if (a > m) m = a;
    }
    // Round to fp16 precision so the wire-side scales match the encoder.
    out[c] = f16ToF32(f32ToF16(m));
  }
  return out;
}

/**
 * Round-half-to-even (IEEE 754 roundTiesToEven), matching Python's
 * `numpy.rint`. JS's Math.round is round-half-away-from-zero, so we
 * implement it explicitly here.
 */
function rintTowardEven(x: number): number {
  const fl = Math.floor(x);
  const diff = x - fl;
  if (diff < 0.5) return fl;
  if (diff > 0.5) return fl + 1;
  return fl % 2 === 0 ? fl : fl + 1;
}

function quantizeSymmetric(
  latent: Float32Array, shape: readonly number[],
  scales: Float32Array, maxQ: number,
): Int8Array {
  const C = shape[0]!;
  const spatial = shape.slice(1).reduce((a, b) => a * b, 1);
  const out = new Int8Array(latent.length);
  for (let c = 0; c < C; c++) {
    const s = scales[c]!;
    const off = c * spatial;
    if (s === 0) continue;
    const inv = maxQ / s;
    for (let i = 0; i < spatial; i++) {
      const q = rintTowardEven(latent[off + i]! * inv);
      const clamped = q > maxQ ? maxQ : q < -maxQ ? -maxQ : q;
      out[off + i] = clamped;
    }
  }
  return out;
}

function quantizeInt8(latent: Float32Array, shape: readonly number[], scales: Float32Array): Int8Array {
  return quantizeSymmetric(latent, shape, scales, 127);
}

function quantizeInt4(latent: Float32Array, shape: readonly number[], scales: Float32Array): Int8Array {
  return quantizeSymmetric(latent, shape, scales, 7);
}

/**
 * Pack int4 values (each in [-7, +7]) two-per-byte, low nibble first.
 * The low nibble of byte k holds values[2k]; the high nibble holds
 * values[2k+1]. A trailing odd value zero-pads the high nibble.
 */
export function packInt4LowFirst(values: Int8Array): Uint8Array {
  const n = values.length;
  const padded = n % 2 === 1 ? n + 1 : n;
  const out = new Uint8Array(padded / 2);
  for (let k = 0; k < out.length; k++) {
    const lo = (values[2 * k] ?? 0) & 0x0f;
    const hi = (values[2 * k + 1] ?? 0) & 0x0f;
    out[k] = lo | (hi << 4);
  }
  return out;
}

/**
 * Inverse of `packInt4LowFirst`. The caller must know how many values were
 * packed (`expectedLen`) so a trailing odd-byte zero pad doesn't get
 * exposed as a stray value. Each nibble is decoded as a two's-complement
 * int4 in the range [-8, +7]; under the Codec saturating quantizer the
 * realised range is [-7, +7].
 */
export function unpackInt4LowFirst(bytes: Uint8Array, expectedLen: number): Int8Array {
  const out = new Int8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    const byte = bytes[i >>> 1]!;
    const nib = (i & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
    // Sign-extend from int4 → int8.
    out[i] = nib & 0x08 ? nib | 0xf0 : nib;
  }
  return out;
}

function saturatingDiff(a: Int8Array, b: Int8Array, maxQ: number): Int8Array {
  if (a.length !== b.length) {
    throw new Error(`saturatingDiff length mismatch: ${a.length} vs ${b.length}`);
  }
  const out = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    out[i] = d > maxQ ? maxQ : d < -maxQ ? -maxQ : d;
  }
  return out;
}

function saturatingAdd(a: Int8Array, b: Int8Array, maxQ: number): Int8Array {
  if (a.length !== b.length) {
    throw new Error(`saturatingAdd length mismatch: ${a.length} vs ${b.length}`);
  }
  const out = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const s = a[i]! + b[i]!;
    out[i] = s > maxQ ? maxQ : s < -maxQ ? -maxQ : s;
  }
  return out;
}

// ── Stateful encoder ────────────────────────────────────────────────────────

export interface LatentStreamEncoderOptions {
  latentSpaceId: string;
  shape: readonly number[];
  dtype: LatentDtype;
  pipeline: PipelineName;
  /** Required for `int8` and `int4` pipelines. Length must be shape[0]. */
  staticScales?: Float32Array;
  fps?: number;
  totalFrames?: number;
  vaeScaleFactor?: number;
}

/**
 * Server-side streaming encoder. One per outbound latent stream. Construct
 * with the negotiated `(latent_space_id, shape, dtype, pipeline)`, call
 * `header()` once, then `frame(latent, …)` per produced latent.
 *
 * Mirrors `LatentStreamEncoder` in `latent_frame.py`.
 */
export class LatentStreamEncoder {
  readonly latentSpaceId: string;
  readonly shape: readonly number[];
  readonly dtype: LatentDtype;
  readonly pipeline: PipelineName;
  readonly fps?: number;
  readonly totalFrames?: number;
  readonly vaeScaleFactor?: number;

  private readonly staticScales: Float32Array | null;
  private lastKeyframeQ: Int8Array | null = null;
  private lastKeyframeScales: Float32Array | null = null;
  private lastSeq = -1;

  constructor(opts: LatentStreamEncoderOptions) {
    if (!PIPELINE_NAMES.includes(opts.pipeline)) {
      throw new Error(
        `unknown pipeline ${JSON.stringify(opts.pipeline)}; ` +
          `must be one of ${PIPELINE_NAMES.join(', ')}`,
      );
    }
    if (STATIC_SCALE_PIPELINES.has(opts.pipeline) && !opts.staticScales) {
      throw new Error(
        `pipeline ${opts.pipeline} requires staticScales (per-channel fp16 array)`,
      );
    }
    if (!STATIC_SCALE_PIPELINES.has(opts.pipeline) && opts.staticScales) {
      throw new Error(
        `pipeline ${opts.pipeline} doesn't accept staticScales — ` +
          `scales travel per-keyframe`,
      );
    }
    if (opts.staticScales && opts.staticScales.length !== opts.shape[0]) {
      throw new Error(
        `staticScales must have length shape[0] = ${opts.shape[0]}; ` +
          `got ${opts.staticScales.length}`,
      );
    }
    this.latentSpaceId = opts.latentSpaceId;
    this.shape = [...opts.shape];
    this.dtype = opts.dtype;
    this.pipeline = opts.pipeline;
    this.fps = opts.fps;
    this.totalFrames = opts.totalFrames;
    this.vaeScaleFactor = opts.vaeScaleFactor;
    this.staticScales = opts.staticScales ?? null;
  }

  /** Encode the per-stream header. Call once, before any frame(). */
  header(): Uint8Array {
    const scalesBytes = this.staticScales ? scalesToBytes(this.staticScales) : undefined;
    return encodeLatentHeaderMsgpack({
      latent_space_id: this.latentSpaceId,
      shape: this.shape,
      dtype: this.dtype,
      pipeline: this.pipeline,
      scales: scalesBytes,
      fps: this.fps,
      total_frames: this.totalFrames,
      vae_scale_factor: this.vaeScaleFactor,
    });
  }

  /**
   * Encode one frame. `latent` is the raw fp32 tensor in channel-first
   * row-major order (shape == this.shape). `seq` is monotonic 0,1,2,…
   * Image streams emit a single frame with `seq=0, keyframe=true`.
   */
  frame(
    latent: Float32Array,
    opts: { seq: number; keyframe: boolean; done?: boolean; finishReason?: string },
  ): Uint8Array {
    if (opts.seq <= this.lastSeq) {
      throw new Error(
        `seq must be monotonically increasing; got ${opts.seq} after ${this.lastSeq}`,
      );
    }
    const expectedLen = this.shape.reduce((a, b) => a * b, 1);
    if (latent.length !== expectedLen) {
      throw new Error(
        `latent length ${latent.length} does not match shape product ${expectedLen}`,
      );
    }
    const data = this.encodePipeline(latent, opts.keyframe);
    this.lastSeq = opts.seq;
    return encodeLatentFrameMsgpack({
      data,
      seq: opts.seq,
      keyframe: opts.keyframe,
      done: opts.done ?? false,
      finish_reason: opts.finishReason,
    });
  }

  private encodePipeline(latent: Float32Array, keyframe: boolean): Uint8Array {
    const p = this.pipeline;

    if (p === 'raw') {
      return float32ArrayToTypedBytes(latent, this.dtype);
    }

    if (p === 'int8') {
      const q = quantizeInt8(latent, this.shape, this.staticScales!);
      return new Uint8Array(q.buffer, q.byteOffset, q.byteLength);
    }

    if (p === 'int4') {
      const q = quantizeInt4(latent, this.shape, this.staticScales!);
      return packInt4LowFirst(q);
    }

    if (p === 'int8-adaptive') {
      if (!keyframe) {
        throw new Error('int8-adaptive: every frame must be keyframe=true');
      }
      const scales = computeScales(latent, this.shape);
      const q = quantizeInt8(latent, this.shape, scales);
      return concat(scalesToBytes(scales), int8ArrayToBytes(q));
    }

    if (p === 'int4-adaptive') {
      if (!keyframe) {
        throw new Error('int4-adaptive: every frame must be keyframe=true');
      }
      const scales = computeScales(latent, this.shape);
      const q = quantizeInt4(latent, this.shape, scales);
      return concat(scalesToBytes(scales), packInt4LowFirst(q));
    }

    if (p === 'delta+int8') {
      if (keyframe) {
        const scales = computeScales(latent, this.shape);
        const q = quantizeInt8(latent, this.shape, scales);
        this.lastKeyframeQ = q;
        this.lastKeyframeScales = scales;
        return concat(scalesToBytes(scales), int8ArrayToBytes(q));
      }
      if (!this.lastKeyframeQ || !this.lastKeyframeScales) {
        throw new Error('delta+int8: first frame in stream must be keyframe=true');
      }
      const qNow = quantizeInt8(latent, this.shape, this.lastKeyframeScales);
      const residual = saturatingDiff(qNow, this.lastKeyframeQ, 127);
      return int8ArrayToBytes(residual);
    }

    if (p === 'delta+int4') {
      if (keyframe) {
        const scales = computeScales(latent, this.shape);
        const q = quantizeInt4(latent, this.shape, scales);
        this.lastKeyframeQ = q;
        this.lastKeyframeScales = scales;
        return concat(scalesToBytes(scales), packInt4LowFirst(q));
      }
      if (!this.lastKeyframeQ || !this.lastKeyframeScales) {
        throw new Error('delta+int4: first frame in stream must be keyframe=true');
      }
      const qNow = quantizeInt4(latent, this.shape, this.lastKeyframeScales);
      const residual = saturatingDiff(qNow, this.lastKeyframeQ, 7);
      return packInt4LowFirst(residual);
    }

    throw new Error(`unhandled pipeline ${p}`);
  }
}

// ── Inverse / decoder pipeline ──────────────────────────────────────────────

/**
 * Stateful decoder. Construct with the parsed `LatentStreamHeader`, then call
 * `decodeFrame(frame)` per incoming `LatentFrame`. Returns the reconstructed
 * fp32 tensor in channel-first row-major order, suitable for handing to a
 * VAE decoder. Bit-identical reconstruction at the latent-byte boundary
 * against the Python reference encoder (modulo fp16 rounding which both
 * sides handle identically).
 */
export class LatentStreamDecoder {
  readonly header: LatentStreamHeader;
  private readonly C: number;
  private readonly spatial: number;
  private staticScales: Float32Array | null;
  private lastKeyframeQ: Int8Array | null = null;
  private lastKeyframeScales: Float32Array | null = null;

  constructor(header: LatentStreamHeader) {
    if (!PIPELINE_NAMES.includes(header.pipeline)) {
      throw new Error(`unknown pipeline ${header.pipeline} on header`);
    }
    this.header = header;
    this.C = header.shape[0]!;
    this.spatial = header.shape.slice(1).reduce((a, b) => a * b, 1);
    if (STATIC_SCALE_PIPELINES.has(header.pipeline)) {
      if (!header.scales || header.scales.length !== 2 * this.C) {
        throw new Error(
          `pipeline ${header.pipeline} requires header.scales of length ${2 * this.C}`,
        );
      }
      this.staticScales = scalesFromBytes(header.scales);
    } else {
      this.staticScales = null;
    }
  }

  decodeFrame(frame: LatentFrame): Float32Array {
    const p = this.header.pipeline;
    const totalLen = this.C * this.spatial;

    if (p === 'raw') {
      return typedBytesToFloat32Array(frame.data, this.header.dtype, totalLen);
    }

    if (p === 'int8') {
      const q = bytesToInt8Array(frame.data, totalLen);
      return dequantize(q, this.staticScales!, this.C, this.spatial, 127);
    }

    if (p === 'int4') {
      const q = unpackInt4LowFirst(frame.data, totalLen);
      return dequantize(q, this.staticScales!, this.C, this.spatial, 7);
    }

    if (p === 'int8-adaptive') {
      const scales = scalesFromBytes(frame.data.subarray(0, 2 * this.C));
      const q = bytesToInt8Array(frame.data.subarray(2 * this.C), totalLen);
      return dequantize(q, scales, this.C, this.spatial, 127);
    }

    if (p === 'int4-adaptive') {
      const scales = scalesFromBytes(frame.data.subarray(0, 2 * this.C));
      const q = unpackInt4LowFirst(frame.data.subarray(2 * this.C), totalLen);
      return dequantize(q, scales, this.C, this.spatial, 7);
    }

    if (p === 'delta+int8') {
      if (frame.keyframe) {
        const scales = scalesFromBytes(frame.data.subarray(0, 2 * this.C));
        const q = bytesToInt8Array(frame.data.subarray(2 * this.C), totalLen);
        this.lastKeyframeScales = scales;
        this.lastKeyframeQ = q;
        return dequantize(q, scales, this.C, this.spatial, 127);
      }
      if (!this.lastKeyframeQ || !this.lastKeyframeScales) {
        throw new Error('delta+int8: first frame in stream must be a keyframe');
      }
      const residual = bytesToInt8Array(frame.data, totalLen);
      const qNow = saturatingAdd(this.lastKeyframeQ, residual, 127);
      return dequantize(qNow, this.lastKeyframeScales, this.C, this.spatial, 127);
    }

    if (p === 'delta+int4') {
      if (frame.keyframe) {
        const scales = scalesFromBytes(frame.data.subarray(0, 2 * this.C));
        const q = unpackInt4LowFirst(frame.data.subarray(2 * this.C), totalLen);
        this.lastKeyframeScales = scales;
        this.lastKeyframeQ = q;
        return dequantize(q, scales, this.C, this.spatial, 7);
      }
      if (!this.lastKeyframeQ || !this.lastKeyframeScales) {
        throw new Error('delta+int4: first frame in stream must be a keyframe');
      }
      const residual = unpackInt4LowFirst(frame.data, totalLen);
      const qNow = saturatingAdd(this.lastKeyframeQ, residual, 7);
      return dequantize(qNow, this.lastKeyframeScales, this.C, this.spatial, 7);
    }

    throw new Error(`unhandled pipeline ${p}`);
  }
}

function dequantize(
  q: Int8Array, scales: Float32Array,
  C: number, spatial: number, maxQ: number,
): Float32Array {
  const out = new Float32Array(q.length);
  for (let c = 0; c < C; c++) {
    const s = scales[c]!;
    const off = c * spatial;
    const factor = s / maxQ;
    for (let i = 0; i < spatial; i++) {
      out[off + i] = q[off + i]! * factor;
    }
  }
  return out;
}

// ── msgpack encoder / decoder ───────────────────────────────────────────────

/**
 * Encode a `LatentStreamHeader` as a single msgpack object. The first frame
 * of any latent stream MUST be a header; subsequent frames are
 * `LatentFrame`s.
 */
export function encodeLatentHeaderMsgpack(
  h: LatentStreamHeader & { type?: 'header' },
): Uint8Array {
  const msg: Record<string, unknown> = {
    type: 'header',
    latent_space_id: h.latent_space_id,
    shape: [...h.shape],
    dtype: h.dtype,
    pipeline: h.pipeline,
  };
  if (h.scales !== undefined) msg.scales = h.scales;
  if (h.fps !== undefined) msg.fps = h.fps;
  if (h.total_frames !== undefined) msg.total_frames = h.total_frames;
  if (h.vae_scale_factor !== undefined) msg.vae_scale_factor = h.vae_scale_factor;
  return msgpackEncode(msg);
}

export function encodeLatentFrameMsgpack(f: LatentFrame): Uint8Array {
  const msg: Record<string, unknown> = {
    data: f.data,
    seq: f.seq,
    keyframe: f.keyframe,
    done: f.done,
  };
  if (f.finish_reason !== undefined) msg.finish_reason = f.finish_reason;
  return msgpackEncode(msg);
}

/**
 * Parse one msgpack object as a `LatentStreamHeader`. Throws if it doesn't
 * look like a header (missing latent_space_id / shape / dtype / pipeline,
 * or `type !== 'header'` if `type` is present).
 */
export function decodeLatentHeaderMsgpack(bytes: Uint8Array): LatentStreamHeader {
  const obj = msgpackDecode(bytes) as Record<string, unknown>;
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('header msgpack did not decode to an object');
  }
  if ('type' in obj && obj.type !== 'header') {
    throw new Error(`expected type:'header', got ${JSON.stringify(obj.type)}`);
  }
  const required = ['latent_space_id', 'shape', 'dtype', 'pipeline'];
  for (const k of required) {
    if (!(k in obj)) throw new Error(`header missing required field: ${k}`);
  }
  return {
    latent_space_id: String(obj.latent_space_id),
    shape: obj.shape as number[],
    dtype: obj.dtype as LatentDtype,
    pipeline: obj.pipeline as PipelineName,
    scales: obj.scales as Uint8Array | undefined,
    fps: obj.fps as number | undefined,
    total_frames: obj.total_frames as number | undefined,
    vae_scale_factor: obj.vae_scale_factor as number | undefined,
  };
}

export function decodeLatentFrameMsgpack(bytes: Uint8Array): LatentFrame {
  const obj = msgpackDecode(bytes) as Record<string, unknown>;
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('frame msgpack did not decode to an object');
  }
  if (!(obj.data instanceof Uint8Array)) {
    throw new Error('frame.data must be a Uint8Array');
  }
  return {
    data: obj.data,
    seq: Number(obj.seq),
    keyframe: Boolean(obj.keyframe),
    done: Boolean(obj.done),
    finish_reason: typeof obj.finish_reason === 'string' ? obj.finish_reason : undefined,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function int8ArrayToBytes(arr: Int8Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bytesToInt8Array(bytes: Uint8Array, expectedLen: number): Int8Array {
  if (bytes.length !== expectedLen) {
    throw new Error(`int8 byte length ${bytes.length} != expected ${expectedLen}`);
  }
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function float32ArrayToTypedBytes(latent: Float32Array, dtype: LatentDtype): Uint8Array {
  if (dtype === 'fp32') {
    return new Uint8Array(latent.buffer, latent.byteOffset, latent.byteLength);
  }
  if (dtype === 'fp16' || dtype === 'bf16') {
    // bf16 has no native JS support and is not used by SD-family VAEs at
    // raw-pipeline; treat as fp16 wire byte width to match the Python file's
    // mapping table. Servers using bf16 latents at raw should switch to a
    // quantizing pipeline.
    const out = new Uint8Array(latent.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < latent.length; i++) {
      view.setUint16(i * 2, f32ToF16(latent[i]!), true);
    }
    return out;
  }
  if (dtype === 'int8') {
    const out = new Int8Array(latent.length);
    for (let i = 0; i < latent.length; i++) {
      const r = rintTowardEven(latent[i]!);
      out[i] = r > 127 ? 127 : r < -128 ? -128 : r;
    }
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
  if (dtype === 'int4') {
    const arr = new Int8Array(latent.length);
    for (let i = 0; i < latent.length; i++) {
      const r = rintTowardEven(latent[i]!);
      arr[i] = r > 7 ? 7 : r < -7 ? -7 : r;
    }
    return packInt4LowFirst(arr);
  }
  throw new Error(`unsupported raw-pipeline dtype: ${dtype}`);
}

function typedBytesToFloat32Array(
  bytes: Uint8Array, dtype: LatentDtype, expectedLen: number,
): Float32Array {
  if (dtype === 'fp32') {
    return new Float32Array(bytes.buffer, bytes.byteOffset, expectedLen);
  }
  if (dtype === 'fp16' || dtype === 'bf16') {
    const out = new Float32Array(expectedLen);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < expectedLen; i++) {
      out[i] = f16ToF32(view.getUint16(i * 2, true));
    }
    return out;
  }
  if (dtype === 'int8') {
    const i8 = new Int8Array(bytes.buffer, bytes.byteOffset, expectedLen);
    const out = new Float32Array(expectedLen);
    for (let i = 0; i < expectedLen; i++) out[i] = i8[i]!;
    return out;
  }
  if (dtype === 'int4') {
    const i4 = unpackInt4LowFirst(bytes, expectedLen);
    const out = new Float32Array(expectedLen);
    for (let i = 0; i < expectedLen; i++) out[i] = i4[i]!;
    return out;
  }
  throw new Error(`unsupported raw-pipeline dtype: ${dtype}`);
}

// Re-exports for ergonomic single-import access.
export { f32ToF16, f16ToF32 };
// `INT4_PIPELINES`, `DELTA_PIPELINES`, etc. are intentionally NOT exported —
// callers who need to introspect should switch on `pipeline` directly.
