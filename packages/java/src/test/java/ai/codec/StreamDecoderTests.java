// SPDX-License-Identifier: MIT
package ai.codec;

import org.junit.jupiter.api.Test;
import org.msgpack.core.MessagePack;
import org.msgpack.core.MessagePacker;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class StreamDecoderTests {

    @Test
    void msgpackStreamYieldsFramesInOrderAndStopsAtDone() {
        byte[][] frames = {
                encodeMsgpack(new int[] { 1, 2, 3 }, false, null),
                encodeMsgpack(new int[] { 4, 5 }, false, null),
                encodeMsgpack(new int[] { 6 }, true, "stop"),
        };
        byte[] concatenated = concat(frames);
        ByteArrayInputStream in = new ByteArrayInputStream(concatenated);

        List<CodecFrame> collected = new ArrayList<>();
        Iterator<CodecFrame> it = StreamDecoder.decodeMsgpackStream(in);
        while (it.hasNext()) collected.add(it.next());

        assertEquals(3, collected.size());
        assertArrayEquals(new int[] { 1, 2, 3 }, collected.get(0).ids());
        assertArrayEquals(new int[] { 6 }, collected.get(2).ids());
        assertTrue(collected.get(2).done());
        assertEquals("stop", collected.get(2).finishReason());
    }

    @Test
    void protobufStreamReassemblesFramesSplitAcrossChunks() {
        byte[][] frames = {
                encodeProtobufFrame(new int[] { 1, 2 }, false, null),
                encodeProtobufFrame(new int[] { 3, 4 }, false, null),
                encodeProtobufFrame(new int[] { 5 }, true, "stop"),
        };
        byte[] concatenated = concat(frames);

        // Stream chunked at 7-byte boundaries so frames straddle reads.
        ChunkedInputStream in = new ChunkedInputStream(concatenated, 7);

        List<int[]> collected = new ArrayList<>();
        Iterator<CodecFrame> it = StreamDecoder.decodeProtobufStream(in);
        while (it.hasNext()) collected.add(it.next().ids());

        assertEquals(3, collected.size());
        assertArrayEquals(new int[] { 1, 2 }, collected.get(0));
        assertArrayEquals(new int[] { 3, 4 }, collected.get(1));
        assertArrayEquals(new int[] { 5 }, collected.get(2));
    }

    @Test
    void decodeProtobufFrameRoundTripsAllFields() {
        byte[] wire = encodeProtobufFrame(new int[] { 100, 200, 300 }, true, "length");
        // Strip 4-byte length prefix to feed the per-frame decoder directly.
        byte[] payload = new byte[wire.length - 4];
        System.arraycopy(wire, 4, payload, 0, payload.length);
        CodecFrame frame = StreamDecoder.decodeProtobufFrame(payload);
        assertArrayEquals(new int[] { 100, 200, 300 }, frame.ids());
        assertTrue(frame.done());
        assertEquals("length", frame.finishReason());
    }

    @Test
    void msgpackFrameRoundTripsDirectly() {
        byte[] data = encodeMsgpack(new int[] { 7, 8, 9 }, true, "eos_token");
        CodecFrame frame = StreamDecoder.decodeMsgpackFrame(data);
        assertArrayEquals(new int[] { 7, 8, 9 }, frame.ids());
        assertTrue(frame.done());
        assertEquals("eos_token", frame.finishReason());
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private static byte[] encodeMsgpack(int[] ids, boolean done, String finishReason) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (MessagePacker p = MessagePack.newDefaultPacker(out)) {
            int fieldCount = (finishReason == null) ? 2 : 3;
            p.packMapHeader(fieldCount);
            p.packString("ids");
            p.packArrayHeader(ids.length);
            for (int id : ids) p.packInt(id);
            p.packString("done");
            p.packBoolean(done);
            if (finishReason != null) {
                p.packString("finish_reason");
                p.packString(finishReason);
            }
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        return out.toByteArray();
    }

    private static byte[] encodeProtobufFrame(int[] ids, boolean done, String finishReason) {
        // Same hand-rolled wire format as codec_frame.py / codec_frame.ts.
        ByteArrayOutputStream parts = new ByteArrayOutputStream();
        if (ids.length > 0) {
            ByteArrayOutputStream packed = new ByteArrayOutputStream();
            for (int id : ids) writeVarint(packed, id);
            parts.write(0x0A);
            writeVarint(parts, packed.size());
            try { parts.write(packed.toByteArray()); } catch (IOException e) { throw new RuntimeException(e); }
        }
        parts.write(0x10);
        parts.write(done ? 1 : 0);
        if (finishReason != null) {
            byte[] enc = finishReason.getBytes(StandardCharsets.UTF_8);
            parts.write(0x1A);
            writeVarint(parts, enc.length);
            try { parts.write(enc); } catch (IOException e) { throw new RuntimeException(e); }
        }
        byte[] body = parts.toByteArray();
        byte[] result = new byte[4 + body.length];
        ByteBuffer.wrap(result, 0, 4).putInt(body.length);
        System.arraycopy(body, 0, result, 4, body.length);
        return result;
    }

    private static void writeVarint(ByteArrayOutputStream out, long n) {
        while (true) {
            int bits = (int) (n & 0x7F);
            n >>>= 7;
            if (n == 0) {
                out.write(bits);
                return;
            }
            out.write(bits | 0x80);
        }
    }

    private static byte[] concat(byte[][] arrays) {
        int total = 0;
        for (byte[] a : arrays) total += a.length;
        byte[] result = new byte[total];
        int off = 0;
        for (byte[] a : arrays) {
            System.arraycopy(a, 0, result, off, a.length);
            off += a.length;
        }
        return result;
    }

    /** InputStream that returns at most chunkSize bytes per read. */
    private static final class ChunkedInputStream extends InputStream {
        private final byte[] buf;
        private final int chunkSize;
        private int pos;

        ChunkedInputStream(byte[] buf, int chunkSize) {
            this.buf = buf;
            this.chunkSize = chunkSize;
        }

        @Override
        public int read() {
            if (pos >= buf.length) return -1;
            return buf[pos++] & 0xff;
        }

        @Override
        public int read(byte[] b, int off, int len) {
            int remaining = buf.length - pos;
            if (remaining == 0) return -1;
            int n = Math.min(Math.min(len, chunkSize), remaining);
            System.arraycopy(buf, pos, b, off, n);
            pos += n;
            return n;
        }
    }
}
