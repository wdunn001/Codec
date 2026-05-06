/**
 * Frame stream decoders. Adapt a transport-level `ReadableStream<Uint8Array>`
 * (typically `fetch().body`) into a typed `AsyncIterable<CodecFrame>`.
 *
 * Two formats are supported, both emitted by the vLLM Codec server:
 *
 *   msgpack  — concatenated MessagePack maps. Decoded with the official
 *              streaming unpacker (`decodeMultiStream`), which handles frame
 *              boundaries that fall inside a single msgpack object.
 *
 *   protobuf — 4-byte big-endian length prefix followed by raw CodecFrame
 *              bytes. We do the framing manually here to avoid pulling in a
 *              full protobuf runtime for one tiny message.
 */
import { decodeMultiStream } from '@msgpack/msgpack';
/** Unified entry point — picks the decoder based on the format hint. */
export function decodeStream(stream, format = 'msgpack') {
    return format === 'msgpack' ? decodeMsgpackStream(stream) : decodeProtobufStream(stream);
}
// ── MessagePack ───────────────────────────────────────────────────────────────
export async function* decodeMsgpackStream(stream) {
    for await (const value of decodeMultiStream(stream)) {
        const frame = value;
        yield { ids: frame.ids, done: frame.done, finish_reason: frame.finish_reason };
        if (frame.done)
            return;
    }
}
// ── Protobuf ──────────────────────────────────────────────────────────────────
export async function* decodeProtobufStream(stream) {
    const reader = stream.getReader();
    let buffer = new Uint8Array(0);
    try {
        while (true) {
            // Need at least 4 bytes for the length prefix.
            while (buffer.length < 4) {
                const { done, value } = await reader.read();
                if (done) {
                    if (buffer.length > 0) {
                        throw new Error(`Codec protobuf stream ended mid-frame (${buffer.length} bytes left)`);
                    }
                    return;
                }
                buffer = concat(buffer, value);
            }
            const frameLen = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, false);
            while (buffer.length < 4 + frameLen) {
                const { done, value } = await reader.read();
                if (done) {
                    throw new Error(`Codec protobuf stream ended mid-frame (need ${frameLen} bytes)`);
                }
                buffer = concat(buffer, value);
            }
            const payload = buffer.subarray(4, 4 + frameLen);
            buffer = buffer.subarray(4 + frameLen);
            const frame = decodeProtobufFrame(payload);
            yield frame;
            if (frame.done)
                return;
        }
    }
    finally {
        reader.releaseLock();
    }
}
function concat(a, b) {
    const len = a.length + b.length;
    const out = new Uint8Array(len);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
function decodeVarint(data, pos) {
    let result = 0;
    let shift = 0;
    while (true) {
        if (pos >= data.length)
            throw new Error('Codec protobuf: truncated varint');
        const b = data[pos++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0)
            return [result, pos];
        shift += 7;
        if (shift > 35)
            throw new Error('Codec protobuf: varint too long');
    }
}
const TEXT_DEC = new TextDecoder();
/** Decode a single CodecFrame protobuf payload (no length prefix). */
export function decodeProtobufFrame(data) {
    const ids = [];
    let done = false;
    let finishReason;
    let pos = 0;
    while (pos < data.length) {
        let tag;
        [tag, pos] = decodeVarint(data, pos);
        const field = tag >> 3;
        const wt = tag & 0x7;
        if (wt === 0) {
            let val;
            [val, pos] = decodeVarint(data, pos);
            if (field === 2)
                done = val !== 0;
        }
        else if (wt === 1) {
            // 64-bit — not used in CodecFrame, skip.
            pos += 8;
        }
        else if (wt === 2) {
            let len;
            [len, pos] = decodeVarint(data, pos);
            const payload = data.subarray(pos, pos + len);
            pos += len;
            if (field === 1) {
                let p = 0;
                while (p < payload.length) {
                    let v;
                    [v, p] = decodeVarint(payload, p);
                    ids.push(v);
                }
            }
            else if (field === 3) {
                finishReason = TEXT_DEC.decode(payload);
            }
        }
        else if (wt === 5) {
            // 32-bit — not used, skip.
            pos += 4;
        }
        else {
            throw new Error(`Codec protobuf: unsupported wire type ${wt}`);
        }
    }
    return { ids, done, finish_reason: finishReason };
}
//# sourceMappingURL=stream.js.map