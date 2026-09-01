// SPDX-License-Identifier: MIT
namespace Codec;

/// <summary>
/// Vocab-only longest-prefix-match tokenizer. Walks input left-to-right,
/// emitting the ID of the longest vocab fragment that matches at each
/// position. Suitable for canonical-IR / synthetic test maps. NOT
/// BPE-correct for real model vocabs: use <see cref="BPETokenizer"/>
/// for those.
/// </summary>
public sealed class LongestMatchTokenizer : ITokenizer
{
    public string Id { get; }
    private readonly Dictionary<string, int> _fragmentToId = new();
    private readonly int _maxFragmentLength;
    private readonly Dictionary<string, int> _specialFragmentToId = new();

    public LongestMatchTokenizer(TokenizerMap map)
    {
        Id = map.Id;
        var maxLen = 1;

        if (map.Vocab is not null)
        {
            foreach (var (fragment, id) in map.Vocab)
            {
                if (string.IsNullOrEmpty(fragment)) continue;
                _fragmentToId[fragment] = id;
                if (fragment.Length > maxLen) maxLen = fragment.Length;
            }
        }
        if (map.Tokens is not null)
        {
            foreach (var (idStr, fragment) in map.Tokens)
            {
                if (string.IsNullOrEmpty(fragment)) continue;
                if (!int.TryParse(idStr, out var id)) continue;
                _fragmentToId[fragment] = id;
                if (fragment.Length > maxLen) maxLen = fragment.Length;
            }
        }
        _maxFragmentLength = maxLen;

        if (map.SpecialTokens is not null)
        {
            foreach (var (name, id) in map.SpecialTokens)
            {
                _specialFragmentToId[name] = id;
                if (!name.StartsWith('<'))
                    _specialFragmentToId[$"<|{name}|>"] = id;
            }
        }
    }

    public int[] Encode(string text)
    {
        var output = new List<int>();
        var pos = 0;
        var n = text.Length;

        while (pos < n)
        {
            // Specials win.
            var consumed = false;
            foreach (var (frag, id) in _specialFragmentToId)
            {
                if (string.CompareOrdinal(text, pos, frag, 0, frag.Length) == 0)
                {
                    output.Add(id);
                    pos += frag.Length;
                    consumed = true;
                    break;
                }
            }
            if (consumed) continue;

            var remaining = n - pos;
            var tryUpTo = Math.Min(_maxFragmentLength, remaining);
            var matchedId = -1;
            var matchedLen = 0;
            for (var len = tryUpTo; len >= 1; len--)
            {
                var candidate = text.Substring(pos, len);
                if (_fragmentToId.TryGetValue(candidate, out var id))
                {
                    matchedId = id;
                    matchedLen = len;
                    break;
                }
            }

            if (matchedId == -1)
            {
                output.Add(0); // UNK
                pos += 1;
            }
            else
            {
                output.Add(matchedId);
                pos += matchedLen;
            }
        }
        return output.ToArray();
    }
}

/// <summary>Top-level tokenizer factory.</summary>
public static class Tokenize
{
    /// <summary>
    /// Build the right tokenizer for the map. <see cref="BPETokenizer"/>
    /// when the map has BPE data; otherwise <see cref="LongestMatchTokenizer"/>.
    /// </summary>
    public static ITokenizer Pick(TokenizerMap map) =>
        BPETokenizer.Supports(map)
            ? new BPETokenizer(map)
            : new LongestMatchTokenizer(map);

    /// <summary>One-shot encode using <see cref="Pick"/>.</summary>
    public static int[] Encode(TokenizerMap map, string text) => Pick(map).Encode(text);
}
