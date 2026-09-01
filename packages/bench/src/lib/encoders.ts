/**
 * Wire encoders under test. All four produce a stream of frames given the same
 * sequence of token-ID chunks, so byte counts and CPU times are directly
 * comparable.
 *
 *   json-sse   the current OpenAI/SSE format. Chunk → `data: {…}\n\n`.
 *              The "incumbent" we're measuring against.
 *   msgpack    `{ ids, done, finish_reason? }` per chunk, msgpack-encoded.
 *              The Codec MessagePack mode (Mode A in spec/PROTOCOL.md).
 *   protobuf   length-prefixed CodecFrame protobuf bytes.
 *              The Codec Protobuf mode (Mode B). Hand-rolled to match the
 *              server-side encoder in vllm/entrypoints/codec_frame.py.
 *   raw        4 bytes per token, no framing. The theoretical wire floor:
 *              not a real protocol, just the absolute lower bound.
 */
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

export type EncoderName = 'json-sse' | 'msgpack' | 'protobuf' | 'raw';

export interface Chunk {
  ids: number[];
  done: boolean;
  finishReason?: string;
}

// ── JSON-SSE (the incumbent) ──────────────────────────────────────────────────
//
// Models the real OpenAI/Ollama wire format, which detokenizes IDs to text
// before shipping them. We use placeholder text of the average per-token width
// observed empirically (~4 chars) so the JSON envelope cost is realistic.

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();

const SAMPLE_TEXT_PER_TOKEN = 'word'; // 4-char placeholder ≈ avg English token width

export function encodeJsonSse(chunk: Chunk): Uint8Array {
  // Mirror the shape of an OpenAI chat-completion delta: the most common
  // form on the wire today.
  const obj = {
    id: 'cmpl-bench',
    object: 'chat.completion.chunk',
    created: 1730000000,
    model: 'bench-model',
    choices: [
      {
        index: 0,
        delta: { content: SAMPLE_TEXT_PER_TOKEN.repeat(chunk.ids.length) },
        ...(chunk.done && { finish_reason: chunk.finishReason ?? 'stop' }),
      },
    ],
  };
  return TEXT_ENC.encode('data: ' + JSON.stringify(obj) + '\n\n');
}

export function decodeJsonSse(buf: Uint8Array): Chunk {
  const s = TEXT_DEC.decode(buf);
  // Mirror real-client work: split the SSE prefix, JSON.parse, then "tokenize"
  // the text back to IDs. Tokenization is the cost an agent pays on receipt;
  // we approximate it as length/4 to keep the bench self-contained.
  const dataLine = s.startsWith('data: ') ? s.slice(6).trim() : s.trim();
  const parsed = JSON.parse(dataLine);
  const text = parsed.choices?.[0]?.delta?.content ?? '';
  const finishReason = parsed.choices?.[0]?.finish_reason;
  const idCount = Math.max(1, Math.round(text.length / 4));
  return {
    ids: Array.from({ length: idCount }, (_, i) => i),
    done: !!finishReason,
    finishReason,
  };
}

// ── MessagePack (Codec Mode A) ────────────────────────────────────────────────

export function encodeMsgpack(chunk: Chunk): Uint8Array {
  const obj: Record<string, unknown> = { ids: chunk.ids, done: chunk.done };
  if (chunk.finishReason) obj.finish_reason = chunk.finishReason;
  return msgpackEncode(obj);
}

export function decodeMsgpack(buf: Uint8Array): Chunk {
  const o = msgpackDecode(buf) as { ids: number[]; done: boolean; finish_reason?: string };
  return { ids: o.ids, done: o.done, finishReason: o.finish_reason };
}

// ── Protobuf (Codec Mode B) ───────────────────────────────────────────────────
//
// Hand-rolled to match the wire bytes the server emits. This is the same logic
// as `_varint` / `encode_protobuf_frame` in vllm/entrypoints/codec_frame.py.
//
//   message CodecFrame {
//     repeated uint32 ids          = 1 [packed = true];
//     bool            done         = 2;
//     optional string finish_reason = 3;
//   }
//
// Wire = 4-byte big-endian length prefix + raw CodecFrame bytes.

function varint(n: number): number[] {
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
}

export function encodeProtobuf(chunk: Chunk): Uint8Array {
  const parts: number[] = [];
  if (chunk.ids.length > 0) {
    const packed: number[] = [];
    for (const id of chunk.ids) packed.push(...varint(id));
    parts.push(0x0a, ...varint(packed.length), ...packed); // field 1, wt=2
  }
  parts.push(0x10, chunk.done ? 1 : 0); // field 2, wt=0
  if (chunk.finishReason) {
    const enc = TEXT_ENC.encode(chunk.finishReason);
    parts.push(0x1a, ...varint(enc.length), ...enc); // field 3, wt=2
  }
  // 4-byte BE length prefix + payload
  const out = new Uint8Array(4 + parts.length);
  new DataView(out.buffer).setUint32(0, parts.length, false);
  out.set(parts, 4);
  return out;
}

function decodeVarint(data: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (true) {
    const b = data[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7;
  }
}

export function decodeProtobuf(buf: Uint8Array): Chunk {
  // strip 4-byte length prefix
  const data = buf.subarray(4);
  const ids: number[] = [];
  let done = false;
  let finishReason: string | undefined;
  let pos = 0;
  while (pos < data.length) {
    let tag: number;
    [tag, pos] = decodeVarint(data, pos);
    const field = tag >> 3;
    const wt = tag & 0x7;
    if (wt === 0) {
      let val: number;
      [val, pos] = decodeVarint(data, pos);
      if (field === 2) done = val !== 0;
    } else if (wt === 2) {
      let len: number;
      [len, pos] = decodeVarint(data, pos);
      const payload = data.subarray(pos, pos + len);
      pos += len;
      if (field === 1) {
        let p = 0;
        while (p < payload.length) {
          let v: number;
          [v, p] = decodeVarint(payload, p);
          ids.push(v);
        }
      } else if (field === 3) {
        finishReason = TEXT_DEC.decode(payload);
      }
    } else {
      throw new Error(`unsupported wire type ${wt}`);
    }
  }
  return { ids, done, finishReason };
}

// ── Raw uint32 (theoretical floor) ────────────────────────────────────────────

export function encodeRaw(chunk: Chunk): Uint8Array {
  // 4 bytes per token, no framing whatsoever. Not a real protocol: just the
  // absolute lower bound so we can see how close the framed formats get.
  const buf = new Uint8Array(chunk.ids.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < chunk.ids.length; i++) view.setUint32(i * 4, chunk.ids[i]!, false);
  return buf;
}

export function decodeRaw(buf: Uint8Array): Chunk {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ids: number[] = [];
  for (let i = 0; i + 4 <= buf.byteLength; i += 4) ids.push(view.getUint32(i, false));
  return { ids, done: false };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export interface Codec {
  name: EncoderName;
  encode: (chunk: Chunk) => Uint8Array;
  decode: (buf: Uint8Array) => Chunk;
}

export const CODECS: Codec[] = [
  { name: 'json-sse', encode: encodeJsonSse, decode: decodeJsonSse },
  { name: 'msgpack', encode: encodeMsgpack, decode: decodeMsgpack },
  { name: 'protobuf', encode: encodeProtobuf, decode: decodeProtobuf },
  { name: 'raw', encode: encodeRaw, decode: decodeRaw },
];
