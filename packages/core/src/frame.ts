/**
 * Codec wire format: binary frame encoding/decoding.
 *
 * Frame layout:
 *   [1 byte : type]
 *   [4 bytes: payload_len, uint32 big-endian]
 *   [N bytes: payload]
 *
 * Frame types:
 *   0x00  HELLO: client declares version + accepted tokenizers (JSON payload)
 *   0x01  READY: server declares chosen tokenizer + map URL (JSON payload)
 *   0x02  TOKENS: packed token IDs, uint32 big-endian, 4 bytes each
 *   0x03  EOS: end of stream, empty payload
 *   0x04  ERROR: UTF-8 error message
 */

export const FrameType = {
  HELLO: 0x00,
  READY: 0x01,
  TOKENS: 0x02,
  EOS: 0x03,
  ERROR: 0x04,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  type: FrameTypeValue;
  payload: Uint8Array;
}

const HEADER_SIZE = 5; // 1 type + 4 len

export function encodeFrame(type: FrameTypeValue, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(buf.buffer);
  view.setUint8(0, type);
  view.setUint32(1, payload.byteLength, false);
  buf.set(payload, HEADER_SIZE);
  return buf;
}

export function decodeFrames(buf: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;

  while (offset + HEADER_SIZE <= buf.byteLength) {
    const type = view.getUint8(offset) as FrameTypeValue;
    const payloadLen = view.getUint32(offset + 1, false);
    offset += HEADER_SIZE;

    if (offset + payloadLen > buf.byteLength) break;
    frames.push({ type, payload: buf.slice(offset, offset + payloadLen) });
    offset += payloadLen;
  }

  return frames;
}

/** Pack token IDs as uint32 big-endian array (4 bytes per ID). */
export function encodeTokens(ids: number[]): Uint8Array {
  const buf = new Uint8Array(ids.length * 4);
  const view = new DataView(buf.buffer);
  ids.forEach((id, i) => view.setUint32(i * 4, id, false));
  return buf;
}

/** Unpack a TOKENS payload back into token ID array. */
export function decodeTokens(buf: Uint8Array): number[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ids: number[] = [];
  for (let i = 0; i + 4 <= buf.byteLength; i += 4) {
    ids.push(view.getUint32(i, false));
  }
  return ids;
}

/** Encode a JSON payload into a Frame. */
export function encodeJsonFrame(type: FrameTypeValue, data: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(data));
  return encodeFrame(type, payload);
}

/** Decode a JSON frame payload. */
export function decodeJsonPayload<T>(frame: Frame): T {
  return JSON.parse(new TextDecoder().decode(frame.payload)) as T;
}

/** Compute total byte size of an array of encoded frames. */
export function totalBytes(frames: Uint8Array[]): number {
  return frames.reduce((sum, f) => sum + f.byteLength, 0);
}
