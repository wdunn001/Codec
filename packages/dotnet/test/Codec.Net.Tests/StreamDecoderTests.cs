// SPDX-License-Identifier: MIT
using System.Buffers;
using System.Buffers.Binary;
using MessagePack;
using Xunit;

namespace Codec.Tests;

public class StreamDecoderTests
{
    [Fact]
    public async Task MsgpackStreamYieldsFramesInOrderAndStopsAtDone()
    {
        var frames = new[]
        {
            EncodeMsgpack(new[] { 1, 2, 3 }, false, null),
            EncodeMsgpack(new[] { 4, 5 }, false, null),
            EncodeMsgpack(new[] { 6 }, true, "stop"),
        };
        var concatenated = Concat(frames);

        using var ms = new MemoryStream(concatenated);
        var collected = new List<CodecFrame>();
        await foreach (var f in StreamDecoder.DecodeMsgpackStreamAsync(ms))
            collected.Add(f);

        Assert.Equal(3, collected.Count);
        Assert.Equal(new[] { 1, 2, 3 }, collected[0].Ids);
        Assert.Equal(new[] { 6 }, collected[2].Ids);
        Assert.True(collected[2].Done);
        Assert.Equal("stop", collected[2].FinishReason);
    }

    [Fact]
    public async Task ProtobufStreamReassemblesFramesSplitAcrossChunks()
    {
        var frames = new[]
        {
            EncodeProtobufFrame(new[] { 1, 2 }, false, null),
            EncodeProtobufFrame(new[] { 3, 4 }, false, null),
            EncodeProtobufFrame(new[] { 5 }, true, "stop"),
        };
        var concatenated = Concat(frames);

        // Stream chunked at 7-byte boundaries so frames straddle reads.
        using var ms = new ChunkedStream(concatenated, chunkSize: 7);
        var collected = new List<int[]>();
        await foreach (var f in StreamDecoder.DecodeProtobufStreamAsync(ms))
            collected.Add(f.Ids.ToArray());

        Assert.Equal(new[] { new[] { 1, 2 }, new[] { 3, 4 }, new[] { 5 } }, collected);
    }

    [Fact]
    public void DecodeProtobufFrameRoundTripsAllFields()
    {
        var wire = EncodeProtobufFrame(new[] { 100, 200, 300 }, true, "length");
        // Strip 4-byte length prefix to feed the per-frame decoder directly.
        var payload = wire.AsSpan(4);
        var frame = StreamDecoder.DecodeProtobufFrame(payload);
        Assert.Equal(new[] { 100, 200, 300 }, frame.Ids);
        Assert.True(frame.Done);
        Assert.Equal("length", frame.FinishReason);
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private static byte[] EncodeMsgpack(int[] ids, bool done, string? finishReason)
    {
        // Build manually so we don't depend on the implementation we're testing.
        var bw = new ArrayBufferWriter<byte>();
        var w = new MessagePackWriter(bw);
        var fieldCount = finishReason is null ? 2 : 3;
        w.WriteMapHeader(fieldCount);
        w.Write("ids");
        w.WriteArrayHeader(ids.Length);
        foreach (var id in ids) w.Write(id);
        w.Write("done");
        w.Write(done);
        if (finishReason is not null)
        {
            w.Write("finish_reason");
            w.Write(finishReason);
        }
        w.Flush();
        return bw.WrittenSpan.ToArray();
    }

    private static byte[] EncodeProtobufFrame(int[] ids, bool done, string? finishReason)
    {
        // Same hand-rolled wire format as codec_frame.py / codec_frame.ts.
        var parts = new List<byte>();
        if (ids.Length > 0)
        {
            var packed = new List<byte>();
            foreach (var id in ids) WriteVarint(packed, (uint)id);
            parts.Add(0x0A);
            WriteVarint(parts, (uint)packed.Count);
            parts.AddRange(packed);
        }
        parts.Add(0x10);
        parts.Add((byte)(done ? 1 : 0));
        if (finishReason is not null)
        {
            var enc = System.Text.Encoding.UTF8.GetBytes(finishReason);
            parts.Add(0x1A);
            WriteVarint(parts, (uint)enc.Length);
            parts.AddRange(enc);
        }
        var output = new byte[4 + parts.Count];
        BinaryPrimitives.WriteUInt32BigEndian(output.AsSpan(0, 4), (uint)parts.Count);
        parts.CopyTo(output, 4);
        return output;
    }

    private static void WriteVarint(List<byte> output, uint n)
    {
        while (true)
        {
            var bits = (byte)(n & 0x7F);
            n >>= 7;
            if (n == 0)
            {
                output.Add(bits);
                return;
            }
            output.Add((byte)(bits | 0x80));
        }
    }

    private static byte[] Concat(byte[][] arrays)
    {
        var total = arrays.Sum(a => a.Length);
        var output = new byte[total];
        var off = 0;
        foreach (var a in arrays)
        {
            Buffer.BlockCopy(a, 0, output, off, a.Length);
            off += a.Length;
        }
        return output;
    }

    /// <summary>
    /// MemoryStream variant that returns at most <c>chunkSize</c> bytes per Read,
    /// so we can verify the protobuf decoder reassembles split frames correctly.
    /// </summary>
    private sealed class ChunkedStream : Stream
    {
        private readonly byte[] _buf;
        private readonly int _chunkSize;
        private int _pos;

        public ChunkedStream(byte[] buf, int chunkSize)
        {
            _buf = buf;
            _chunkSize = chunkSize;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => _buf.Length;
        public override long Position { get => _pos; set => _pos = (int)value; }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var remaining = _buf.Length - _pos;
            if (remaining == 0) return 0;
            var n = Math.Min(Math.Min(count, _chunkSize), remaining);
            Buffer.BlockCopy(_buf, _pos, buffer, offset, n);
            _pos += n;
            return n;
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            Task.FromResult(Read(buffer, offset, count));

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var arr = new byte[Math.Min(buffer.Length, _chunkSize)];
            var n = Read(arr, 0, arr.Length);
            arr.AsMemory(0, n).CopyTo(buffer);
            return new ValueTask<int>(n);
        }

        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
