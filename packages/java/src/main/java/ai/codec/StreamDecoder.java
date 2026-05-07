// SPDX-License-Identifier: MIT
package ai.codec;

import org.msgpack.core.MessagePack;
import org.msgpack.core.MessageUnpacker;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.concurrent.Flow;
import java.util.concurrent.SubmissionPublisher;

/**
 * Decoders for the two Codec wire formats. Adapt an HTTP response body
 * (any {@link InputStream}) into an {@link Iterator} of {@link CodecFrame}.
 *
 * <p>Both modes carry identical frame semantics; they differ only in
 * serialization. The msgpack mode emits concatenated MessagePack maps;
 * the protobuf mode emits 4-byte big-endian length-prefixed payloads.
 */
public final class StreamDecoder {
    private StreamDecoder() {}

    /**
     * Unified entry point. Picks the decoder based on {@code format}.
     */
    public static Iterator<CodecFrame> decode(InputStream body, String format) {
        return "protobuf".equals(format)
                ? decodeProtobufStream(body)
                : decodeMsgpackStream(body);
    }

    // ── MessagePack ─────────────────────────────────────────────────────────

    /**
     * Yield frames from a stream of concatenated MessagePack maps with the
     * shape {@code { "ids": [int...], "done": bool, "finish_reason"?: string }}.
     */
    public static Iterator<CodecFrame> decodeMsgpackStream(InputStream body) {
        return new MsgpackFrameIterator(body);
    }

    /** Decode a single msgpack frame. */
    public static CodecFrame decodeMsgpackFrame(byte[] data) {
        try (MessageUnpacker u = MessagePack.newDefaultUnpacker(data)) {
            return readFrameFrom(u);
        } catch (IOException e) {
            throw new RuntimeException("Codec msgpack: " + e.getMessage(), e);
        }
    }

    private static CodecFrame readFrameFrom(MessageUnpacker u) throws IOException {
        int count = u.unpackMapHeader();
        int[] ids = new int[0];
        boolean done = false;
        String finishReason = null;

        for (int i = 0; i < count; i++) {
            String key = u.unpackString();
            switch (key) {
                case "ids":
                    int n = u.unpackArrayHeader();
                    int[] arr = new int[n];
                    for (int j = 0; j < n; j++) arr[j] = u.unpackInt();
                    ids = arr;
                    break;
                case "done":
                    done = u.unpackBoolean();
                    break;
                case "finish_reason":
                    if (u.tryUnpackNil()) finishReason = null;
                    else finishReason = u.unpackString();
                    break;
                default:
                    u.skipValue();
                    break;
            }
        }
        return new CodecFrame(ids, done, finishReason);
    }

    /** Iterator over msgpack frames in an InputStream. */
    private static final class MsgpackFrameIterator implements Iterator<CodecFrame> {
        private final MessageUnpacker unpacker;
        private CodecFrame next;
        private boolean done;

        MsgpackFrameIterator(InputStream body) {
            this.unpacker = MessagePack.newDefaultUnpacker(body);
        }

        @Override
        public boolean hasNext() {
            if (next != null) return true;
            if (done) return false;
            try {
                if (!unpacker.hasNext()) {
                    done = true;
                    closeQuietly();
                    return false;
                }
                next = readFrameFrom(unpacker);
                if (next.done()) done = true;
                return true;
            } catch (IOException e) {
                throw new RuntimeException("Codec msgpack stream: " + e.getMessage(), e);
            }
        }

        @Override
        public CodecFrame next() {
            if (!hasNext()) throw new NoSuchElementException();
            CodecFrame out = next;
            next = null;
            if (out.done()) {
                done = true;
                closeQuietly();
            }
            return out;
        }

        private void closeQuietly() {
            try { unpacker.close(); } catch (IOException ignored) {}
        }
    }

    // ── Protobuf ───────────────────────────────────────────────────────────

    /**
     * Yield frames from a stream of length-prefixed protobuf CodecFrame
     * payloads: 4-byte big-endian length followed by the protobuf bytes.
     */
    public static Iterator<CodecFrame> decodeProtobufStream(InputStream body) {
        return new ProtobufFrameIterator(body);
    }

    /** Decode a single CodecFrame protobuf payload (no length prefix). */
    public static CodecFrame decodeProtobufFrame(byte[] data) {
        return decodeProtobufFrame(data, 0, data.length);
    }

    /** Decode a single CodecFrame protobuf payload (no length prefix). */
    public static CodecFrame decodeProtobufFrame(byte[] data, int offset, int length) {
        List<Integer> ids = new ArrayList<>();
        boolean done = false;
        String finishReason = null;
        int pos = offset;
        int end = offset + length;

        while (pos < end) {
            long[] tagRes = readVarint(data, pos, end);
            long tag = tagRes[0];
            pos = (int) tagRes[1];
            int field = (int) (tag >>> 3);
            int wt = (int) (tag & 0x07);

            switch (wt) {
                case 0: { // varint
                    long[] v = readVarint(data, pos, end);
                    pos = (int) v[1];
                    if (field == 2) done = v[0] != 0;
                    break;
                }
                case 1: { // 64-bit fixed
                    pos += 8;
                    break;
                }
                case 2: { // length-delimited
                    long[] lenR = readVarint(data, pos, end);
                    pos = (int) lenR[1];
                    int len = (int) lenR[0];
                    int chunkEnd = pos + len;
                    if (field == 1) { // packed repeated uint32 ids
                        int p = pos;
                        while (p < chunkEnd) {
                            long[] idR = readVarint(data, p, chunkEnd);
                            p = (int) idR[1];
                            ids.add((int) idR[0]);
                        }
                    } else if (field == 3) { // optional string finish_reason
                        finishReason = new String(data, pos, len, java.nio.charset.StandardCharsets.UTF_8);
                    }
                    pos = chunkEnd;
                    break;
                }
                case 5: { // 32-bit fixed
                    pos += 4;
                    break;
                }
                default:
                    throw new RuntimeException(
                            "Codec: unknown protobuf wire type " + wt + " in CodecFrame field " + field);
            }
        }

        int[] arr = new int[ids.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = ids.get(i);
        return new CodecFrame(arr, done, finishReason);
    }

    /** Returns {value, newPos}. */
    private static long[] readVarint(byte[] data, int pos, int end) {
        long result = 0;
        int shift = 0;
        while (true) {
            if (pos >= end)
                throw new RuntimeException("Codec protobuf: truncated varint");
            byte b = data[pos++];
            result |= ((long) (b & 0x7f)) << shift;
            if ((b & 0x80) == 0) return new long[] { result, pos };
            shift += 7;
            if (shift > 63)
                throw new RuntimeException("Codec protobuf: varint too long");
        }
    }

    /** Iterator over protobuf frames in an InputStream. */
    private static final class ProtobufFrameIterator implements Iterator<CodecFrame> {
        private final InputStream body;
        private final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        private int bufStart = 0; // logical read pointer into buf.toByteArray()
        private CodecFrame next;
        private boolean done;

        ProtobufFrameIterator(InputStream body) {
            this.body = body;
        }

        @Override
        public boolean hasNext() {
            if (next != null) return true;
            if (done) return false;
            try {
                next = readFrame();
            } catch (IOException e) {
                throw new RuntimeException(e.getMessage(), e);
            }
            if (next == null) {
                done = true;
                return false;
            }
            if (next.done()) done = true;
            return true;
        }

        @Override
        public CodecFrame next() {
            if (!hasNext()) throw new NoSuchElementException();
            CodecFrame out = next;
            next = null;
            return out;
        }

        private CodecFrame readFrame() throws IOException {
            // Need at least 4 bytes for the length prefix.
            while (available() < 4) {
                if (!readMore()) {
                    if (available() > 0)
                        throw new IOException(
                                "Codec protobuf stream ended mid-frame (" + available() + " bytes left)");
                    return null;
                }
            }

            byte[] all = buf.toByteArray();
            ByteBuffer bb = ByteBuffer.wrap(all, bufStart, 4);
            int frameLen = bb.getInt();
            // ByteBuffer reads big-endian by default; this is what we want.

            while (available() < 4 + frameLen) {
                if (!readMore())
                    throw new IOException(
                            "Codec protobuf stream ended mid-frame (need " + frameLen + " bytes)");
                all = buf.toByteArray();
            }

            CodecFrame frame = decodeProtobufFrame(all, bufStart + 4, frameLen);
            bufStart += 4 + frameLen;

            // Compact buffer occasionally to avoid unbounded growth.
            if (bufStart > 64 * 1024 || bufStart >= buf.size()) {
                int leftover = buf.size() - bufStart;
                byte[] keep = new byte[leftover];
                if (leftover > 0) System.arraycopy(buf.toByteArray(), bufStart, keep, 0, leftover);
                buf.reset();
                if (leftover > 0) buf.write(keep, 0, leftover);
                bufStart = 0;
            }
            return frame;
        }

        private int available() {
            return buf.size() - bufStart;
        }

        private boolean readMore() throws IOException {
            byte[] tmp = new byte[16 * 1024];
            int n = body.read(tmp);
            if (n <= 0) return false;
            buf.write(tmp, 0, n);
            return true;
        }
    }

    // ── Reactive variant ───────────────────────────────────────────────────

    /**
     * Reactive {@link Flow.Publisher} variant for callers using the
     * java.util.concurrent.Flow contract. Frames are emitted on an
     * internal worker thread spawned by the SubmissionPublisher.
     */
    public static Flow.Publisher<CodecFrame> publishMsgpack(InputStream body) {
        return new IteratorPublisher(decodeMsgpackStream(body));
    }

    /** Reactive variant for protobuf streams. */
    public static Flow.Publisher<CodecFrame> publishProtobuf(InputStream body) {
        return new IteratorPublisher(decodeProtobufStream(body));
    }

    private static final class IteratorPublisher implements Flow.Publisher<CodecFrame> {
        private final Iterator<CodecFrame> source;

        IteratorPublisher(Iterator<CodecFrame> source) {
            this.source = source;
        }

        @Override
        public void subscribe(Flow.Subscriber<? super CodecFrame> subscriber) {
            // Drive the iterator on a worker thread to avoid blocking the caller.
            // SubmissionPublisher is auto-closed once the iterator drains so the
            // subscriber receives an onComplete signal.
            SubmissionPublisher<CodecFrame> pub = new SubmissionPublisher<>();
            pub.subscribe(subscriber);
            Thread worker = new Thread(() -> {
                try {
                    while (source.hasNext()) {
                        pub.submit(source.next());
                    }
                } catch (RuntimeException re) {
                    pub.closeExceptionally(re);
                    return;
                } finally {
                    if (!pub.isClosed()) pub.close();
                }
            }, "codec-stream-publisher");
            worker.setDaemon(true);
            worker.start();
        }
    }
}
