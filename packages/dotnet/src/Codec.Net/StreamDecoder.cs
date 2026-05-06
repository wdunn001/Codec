// SPDX-License-Identifier: MIT
using System.Buffers;
using System.Buffers.Binary;
using System.Runtime.CompilerServices;
using System.Text;
using MessagePack;

namespace Codec;

/// <summary>
/// Decoders for the two Codec wire formats. Adapt an HTTP response body
/// (any <see cref="Stream"/>) into an <see cref="IAsyncEnumerable{CodecFrame}"/>.
/// </summary>
public static class StreamDecoder
{
    /// <summary>
    /// Unified entry point. Picks the decoder based on <paramref name="format"/>.
    /// </summary>
    public static IAsyncEnumerable<CodecFrame> DecodeAsync(
        Stream body,
        string format = "msgpack",
        CancellationToken ct = default) =>
        format == "protobuf"
            ? DecodeProtobufStreamAsync(body, ct)
            : DecodeMsgpackStreamAsync(body, ct);

    // ── MessagePack ─────────────────────────────────────────────────────────

    /// <summary>
    /// Yield frames from a stream of concatenated MessagePack maps with the
    /// shape <c>{ "ids": [int...], "done": bool, "finish_reason"?: string }</c>.
    /// </summary>
    public static async IAsyncEnumerable<CodecFrame> DecodeMsgpackStreamAsync(
        Stream body,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        // MessagePack-CSharp handles the "many concatenated maps" stream pattern
        // via MessagePackStreamReader.
        using var reader = new MessagePackStreamReader(body, leaveOpen: true);
        ReadOnlySequence<byte>? msg;
        while ((msg = await reader.ReadAsync(ct).ConfigureAwait(false)) is not null)
        {
            var frame = DecodeMsgpackFrame(msg.Value);
            yield return frame;
            if (frame.Done) yield break;
        }
    }

    private static CodecFrame DecodeMsgpackFrame(ReadOnlySequence<byte> seq)
    {
        var reader = new MessagePackReader(seq);
        var count = reader.ReadMapHeader();

        int[]? ids = null;
        var done = false;
        string? finishReason = null;

        for (var i = 0; i < count; i++)
        {
            var key = reader.ReadString() ?? string.Empty;
            switch (key)
            {
                case "ids":
                    var n = reader.ReadArrayHeader();
                    var arr = new int[n];
                    for (var j = 0; j < n; j++) arr[j] = reader.ReadInt32();
                    ids = arr;
                    break;
                case "done":
                    done = reader.ReadBoolean();
                    break;
                case "finish_reason":
                    finishReason = reader.TryReadNil() ? null : reader.ReadString();
                    break;
                default:
                    reader.Skip();
                    break;
            }
        }

        return new CodecFrame
        {
            Ids = ids ?? Array.Empty<int>(),
            Done = done,
            FinishReason = finishReason,
        };
    }

    // ── Protobuf ───────────────────────────────────────────────────────────

    /// <summary>
    /// Yield frames from a stream of length-prefixed protobuf CodecFrame
    /// payloads: 4-byte big-endian length followed by the protobuf bytes.
    /// </summary>
    public static async IAsyncEnumerable<CodecFrame> DecodeProtobufStreamAsync(
        Stream body,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        // Buffer up bytes until we have a complete frame, then yield.
        var buf = new MemoryStream();
        var temp = new byte[16 * 1024];

        while (true)
        {
            // Read until we have at least 4 bytes for the length prefix.
            while (buf.Length < 4)
            {
                var n = await body.ReadAsync(temp.AsMemory(), ct).ConfigureAwait(false);
                if (n == 0)
                {
                    if (buf.Length > 0)
                        throw new InvalidDataException(
                            $"Codec protobuf stream ended mid-frame ({buf.Length} bytes left)");
                    yield break;
                }
                buf.Write(temp, 0, n);
            }

            // Peek the length.
            var bufBytes = buf.GetBuffer();
            var frameLen = BinaryPrimitives.ReadUInt32BigEndian(bufBytes.AsSpan(0, 4));

            // Read more until we have 4 + frameLen.
            while (buf.Length < 4 + frameLen)
            {
                var n = await body.ReadAsync(temp.AsMemory(), ct).ConfigureAwait(false);
                if (n == 0)
                    throw new InvalidDataException(
                        $"Codec protobuf stream ended mid-frame (need {frameLen} bytes)");
                buf.Write(temp, 0, n);
            }

            // Re-fetch buffer (Write may have grown the array).
            bufBytes = buf.GetBuffer();
            var payload = bufBytes.AsSpan(4, (int)frameLen);
            var frame = DecodeProtobufFrame(payload.ToArray());

            // Reset buffer with leftover bytes (next frame, partial).
            var leftover = (int)(buf.Length - 4 - frameLen);
            var nextBuf = new MemoryStream();
            if (leftover > 0)
                nextBuf.Write(bufBytes, 4 + (int)frameLen, leftover);
            buf.Dispose();
            buf = nextBuf;

            yield return frame;
            if (frame.Done) yield break;
        }
    }

    /// <summary>Decode a single CodecFrame protobuf payload (no length prefix).</summary>
    public static CodecFrame DecodeProtobufFrame(ReadOnlySpan<byte> data)
    {
        var ids = new List<int>();
        var done = false;
        string? finishReason = null;
        var pos = 0;

        while (pos < data.Length)
        {
            var (tag, np) = ReadVarint(data, pos);
            pos = np;
            var field = (int)(tag >> 3);
            var wt = (int)(tag & 0x07);

            switch (wt)
            {
                case 0: // varint
                    var (val, np2) = ReadVarint(data, pos);
                    pos = np2;
                    if (field == 2) done = val != 0;
                    break;
                case 1: // 64-bit fixed
                    pos += 8;
                    break;
                case 2: // length-delimited
                    var (len, np3) = ReadVarint(data, pos);
                    pos = np3;
                    var chunk = data.Slice(pos, (int)len);
                    pos += (int)len;
                    if (field == 1) // packed repeated uint32 ids
                    {
                        var p = 0;
                        while (p < chunk.Length)
                        {
                            var (id, npp) = ReadVarint(chunk, p);
                            p = npp;
                            ids.Add((int)id);
                        }
                    }
                    else if (field == 3) // optional string finish_reason
                    {
                        finishReason = Encoding.UTF8.GetString(chunk);
                    }
                    break;
                case 5: // 32-bit fixed
                    pos += 4;
                    break;
                default:
                    throw new InvalidDataException(
                        $"Codec: unknown protobuf wire type {wt} in CodecFrame field {field}");
            }
        }

        return new CodecFrame { Ids = ids, Done = done, FinishReason = finishReason };
    }

    private static (ulong value, int newPos) ReadVarint(ReadOnlySpan<byte> data, int pos)
    {
        ulong result = 0;
        var shift = 0;
        while (true)
        {
            if (pos >= data.Length)
                throw new InvalidDataException("Codec protobuf: truncated varint");
            var b = data[pos++];
            result |= (ulong)(b & 0x7f) << shift;
            if ((b & 0x80) == 0) return (result, pos);
            shift += 7;
            if (shift > 63)
                throw new InvalidDataException("Codec protobuf: varint too long");
        }
    }
}
