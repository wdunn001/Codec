// SPDX-License-Identifier: MIT
using System.Text;

namespace Codec;

/// <summary>Options for <see cref="Detokenizer.Render"/>.</summary>
public readonly struct DetokenizeOptions
{
    /// <summary>
    /// If <c>true</c>, this is not the final chunk: buffer any trailing
    /// partial UTF-8 sequence.
    /// Set to <c>false</c> on the last chunk so the buffer flushes.
    /// </summary>
    public bool Partial { get; init; }

    /// <summary>If <c>true</c>, render special tokens (e.g. <c>&lt;|eos|&gt;</c>) as text. Default: false.</summary>
    public bool RenderSpecial { get; init; }
}

/// <summary>
/// Stateful detokenizer. IDs → text. Three correctness concerns it
/// handles:
/// <list type="number">
/// <item>Per-token decoding via the map's encoder (byte_level / metaspace / identity).</item>
/// <item>Byte-fallback range: IDs in <c>[byte_fallback_start, byte_fallback_end]</c> are decoded as raw bytes and accumulated until a valid UTF-8 sequence forms.</item>
/// <item>Partial multi-byte sequences across frame boundaries: buffered between calls when <c>Partial: true</c>.</item>
/// </list>
/// </summary>
public sealed class Detokenizer
{
    private readonly TokenizerMap _map;
    private readonly HashSet<int> _specialIds;
    private readonly int _fallbackStart;
    private readonly int _fallbackEnd;
    private readonly Dictionary<int, byte[]>? _idToBytes;     // byte_level
    private readonly Dictionary<int, string>? _idToText;       // metaspace + identity
    private readonly List<byte> _byteBuffer = new();

    public Detokenizer(TokenizerMap map)
    {
        _map = map;
        _specialIds = map.SpecialTokens is null
            ? new HashSet<int>()
            : new HashSet<int>(map.SpecialTokens.Values);
        _fallbackStart = map.ByteFallbackStart ?? -1;
        _fallbackEnd = map.ByteFallbackEnd ?? -2;

        if (map.Encoder == "byte_level")
        {
            _idToBytes = BuildByteLevelTable(map);
            _idToText = null;
        }
        else
        {
            _idToBytes = null;
            _idToText = BuildTextTable(map);
        }
    }

    /// <summary>Render a chunk of IDs to text. Stateful across calls.</summary>
    public string Render(IReadOnlyList<int> ids, DetokenizeOptions options = default)
    {
        var sb = new StringBuilder();
        var renderSpecial = options.RenderSpecial;

        foreach (var id in ids)
        {
            // Byte-fallback range: SentencePiece reserves IDs for raw bytes 0x00-0xFF.
            if (id >= _fallbackStart && id <= _fallbackEnd)
            {
                _byteBuffer.Add((byte)(id - _fallbackStart));
                FlushAllBytes(sb);
                continue;
            }

            if (_idToBytes is not null)
            {
                // byte_level: every vocab token IS a byte sequence.
                if (_specialIds.Contains(id) && !renderSpecial)
                {
                    if (_byteBuffer.Count > 0) FlushBytesForce(sb);
                    continue;
                }
                if (!_idToBytes.TryGetValue(id, out var bytes))
                {
                    if (_byteBuffer.Count > 0) FlushBytesForce(sb);
                    sb.Append('�');
                    continue;
                }
                _byteBuffer.AddRange(bytes);
                FlushAllBytes(sb);
                continue;
            }

            // metaspace / identity: token text is rendered directly.
            if (_byteBuffer.Count > 0) FlushBytesForce(sb);
            if (_specialIds.Contains(id) && !renderSpecial) continue;
            if (_idToText!.TryGetValue(id, out var text))
                sb.Append(text);
            else
                sb.Append('�');
        }

        if (!options.Partial && _byteBuffer.Count > 0) FlushBytesForce(sb);
        return sb.ToString();
    }

    /// <summary>Reset internal state: call between conversations / requests.</summary>
    public void Reset() => _byteBuffer.Clear();

    /// <summary>
    /// Convenience: detokenize a complete sequence in one shot. Uses a
    /// fresh Detokenizer; partial buffering not exposed.
    /// </summary>
    public static string Detokenize(TokenizerMap map, IReadOnlyList<int> ids, bool renderSpecial = false) =>
        new Detokenizer(map).Render(ids, new DetokenizeOptions { RenderSpecial = renderSpecial });

    // ── Internals ──────────────────────────────────────────────────────────

    private void FlushAllBytes(StringBuilder sb)
    {
        while (_byteBuffer.Count > 0)
        {
            var needed = Utf8SequenceLength(_byteBuffer[0]);
            if (needed == 0)
            {
                _byteBuffer.RemoveAt(0);
                sb.Append('�');
                continue;
            }
            if (_byteBuffer.Count < needed) break;
            var span = _byteBuffer.GetRange(0, needed).ToArray();
            _byteBuffer.RemoveRange(0, needed);
            try
            {
                sb.Append(Utf8Strict.GetString(span));
            }
            catch (DecoderFallbackException)
            {
                sb.Append('�');
            }
        }
    }

    private void FlushBytesForce(StringBuilder sb)
    {
        if (_byteBuffer.Count == 0) return;
        var bytes = _byteBuffer.ToArray();
        _byteBuffer.Clear();
        sb.Append(Encoding.UTF8.GetString(bytes));
    }

    private static int Utf8SequenceLength(byte b) =>
        (b & 0x80) == 0x00 ? 1:
        (b & 0xE0) == 0xC0 ? 2:
        (b & 0xF0) == 0xE0 ? 3:
        (b & 0xF8) == 0xF0 ? 4 : 0;

    private static readonly Encoding Utf8Strict =
        new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private static Dictionary<int, byte[]> BuildByteLevelTable(TokenizerMap map)
    {
        var result = new Dictionary<int, byte[]>(map.Vocab?.Count ?? 0);
        if (map.Vocab is null) return result;
        foreach (var (token, id) in map.Vocab)
            result[id] = ByteEncoder.DecodeByteLevelToken(token);
        return result;
    }

    private static Dictionary<int, string> BuildTextTable(TokenizerMap map)
    {
        var result = new Dictionary<int, string>();
        var isMetaspace = map.Encoder == "metaspace";

        if (map.Vocab is not null)
        {
            foreach (var (token, id) in map.Vocab)
            {
                // SentencePiece byte-fallback tokens (<0xHH>) live in vocab
                // but are handled by the byte_fallback range path.
                if (IsByteFallbackToken(token)) continue;
                var text = isMetaspace ? token.Replace(ByteEncoder.Metaspace, ' ') : token;
                result[id] = text;
            }
        }
        if (map.Tokens is not null)
        {
            foreach (var (idStr, text) in map.Tokens)
            {
                if (int.TryParse(idStr, out var id))
                    result[id] = text;
            }
        }
        return result;
    }

    private static bool IsByteFallbackToken(string s)
    {
        if (s.Length != 6 || s[0] != '<' || s[1] != '0' || s[2] != 'x' || s[5] != '>') return false;
        return IsHex(s[3]) && IsHex(s[4]);
        static bool IsHex(char c) => (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
    }
}
