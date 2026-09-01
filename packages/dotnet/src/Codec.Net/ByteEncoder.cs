// SPDX-License-Identifier: MIT
using System.Text;

namespace Codec;

/// <summary>
/// Shared encoder utilities: the GPT-2 byte↔unicode mapping table and
/// helpers used by both <see cref="Detokenizer"/> and <see cref="BPETokenizer"/>.
/// </summary>
public static class ByteEncoder
{
    /// <summary>The metaspace marker (▁, U+2581) used by SentencePiece tokenizers.</summary>
    public const char Metaspace = '▁';

    private static readonly Dictionary<int, char> ByteToCharMap;
    private static readonly Dictionary<int, int> CharToByteMap;

    static ByteEncoder()
    {
        // The GPT-2 bijection: bytes 33-126, 161-172, 174-255 map to themselves
        // (printable / non-control). Other bytes map to U+0100+n.
        var bs = new List<int>();
        for (var i = 33; i <= 126; i++) bs.Add(i);
        for (var i = 161; i <= 172; i++) bs.Add(i);
        for (var i = 174; i <= 255; i++) bs.Add(i);
        var cs = new List<int>(bs);
        var n = 0;
        for (var b = 0; b < 256; b++)
        {
            if (!bs.Contains(b))
            {
                bs.Add(b);
                cs.Add(256 + n);
                n++;
            }
        }

        ByteToCharMap = new Dictionary<int, char>(256);
        CharToByteMap = new Dictionary<int, int>(256);
        for (var i = 0; i < bs.Count; i++)
        {
            ByteToCharMap[bs[i]] = (char)cs[i];
            CharToByteMap[cs[i]] = bs[i];
        }
    }

    /// <summary>Maps a byte (0 to 255) to its GPT-2-encoded character.</summary>
    public static char ByteToChar(int b) => ByteToCharMap[b];

    /// <summary>Maps a GPT-2-encoded character codepoint back to a byte; returns -1 if not in the table.</summary>
    public static int CharToByte(int codePoint) =>
        CharToByteMap.TryGetValue(codePoint, out var b) ? b : -1;

    /// <summary>
    /// Decode a byte-level BPE token (e.g. "Ġhello") to its raw bytes by
    /// reversing the GPT-2 byte→unicode table. Characters outside the
    /// table fall back to UTF-8 bytes (defensive: shouldn't happen for
    /// valid vocab entries).
    /// </summary>
    public static byte[] DecodeByteLevelToken(string rawToken)
    {
        var buf = new List<byte>(rawToken.Length);
        var i = 0;
        while (i < rawToken.Length)
        {
            int cp;
            if (char.IsHighSurrogate(rawToken[i]) && i + 1 < rawToken.Length)
            {
                cp = char.ConvertToUtf32(rawToken, i);
                i += 2;
            }
            else
            {
                cp = rawToken[i];
                i++;
            }
            var b = CharToByte(cp);
            if (b >= 0)
            {
                buf.Add((byte)b);
            }
            else
            {
                // Unknown char: emit as UTF-8 bytes.
                var s = char.ConvertFromUtf32(cp);
                buf.AddRange(Encoding.UTF8.GetBytes(s));
            }
        }
        return buf.ToArray();
    }

    /// <summary>
    /// Encode raw bytes into a string of GPT-2 byte-encoded characters.
    /// The result matches the keys of a byte_level vocab.
    /// </summary>
    public static string EncodeByteLevelChars(ReadOnlySpan<byte> bytes)
    {
        var sb = new StringBuilder(bytes.Length);
        foreach (var b in bytes) sb.Append(ByteToCharMap[b]);
        return sb.ToString();
    }
}
