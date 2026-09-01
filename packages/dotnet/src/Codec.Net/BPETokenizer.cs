// SPDX-License-Identifier: MIT
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Codec;

/// <summary>
/// Pure C# BPE encoder. Text → token IDs. Required for the bidirectional
/// Codec endpoint where the client wants to send token-ID prompts (zero
/// text on the wire in either direction).
///
/// Algorithm (for both byte_level and metaspace BPE):
/// <list type="number">
/// <item>Pre-tokenize: split input into pieces (regex for byte_level; whitespace for metaspace).</item>
/// <item>Encode each piece into the vocab's character space (GPT-2 byte chars or ▁-prefixed).</item>
/// <item>Apply BPE merges greedily by priority: match HuggingFace reference.</item>
/// <item>Look up final tokens in <c>Vocab</c>. Tokens not in vocab fall back to byte tokens (metaspace path).</item>
/// </list>
/// Pure managed code, no native deps.
/// </summary>
public sealed class BPETokenizer : ITokenizer
{
    public string Id { get; }
    private readonly Dictionary<string, int> _vocab;
    private readonly Dictionary<string, int> _mergeRanks;
    private readonly Regex? _preTokRegex;
    private readonly string _encoder;
    private readonly int _byteFallbackStart;
    private readonly Dictionary<string, int[]> _cache = new();
    /// <summary>
    /// Special-token scanner. Built from <c>map.SpecialTokens</c> plus any
    /// vocab key in <c>&lt;|body|&gt;</c> shape with a non-empty
    /// identifier-like body. HF's reference tokenizer splits input on
    /// registered specials BEFORE running BPE: emit each match as the
    /// atomic vocab ID, BPE the surrounding text. Required for chat
    /// templates (<c>&lt;|im_start|&gt;...&lt;|im_end|&gt;</c>), tool-call
    /// delimiters, FIM markers, etc. to round-trip with HF.
    /// </summary>
    private readonly Dictionary<string, int> _specialIds;
    private readonly Regex? _specialRegex;

    private static readonly Regex DelimiterBodyRegex = new("^[A-Za-z0-9_-]+$", RegexOptions.Compiled);

    /// <summary>
    /// Match <c>&lt;|body|&gt;</c> where body is non-empty and identifier-like
    /// (letters/digits/_/-). Catches every shipped chat-template and tool-call
    /// delimiter while excluding pathological vocab BPE tokens like Falcon's
    /// <c>&lt;|&gt;</c> (id 61799) that share the start/end pair.
    /// </summary>
    private static bool IsDelimiterShape(string tok)
    {
        if (tok.Length <= 4) return false;
        if (!tok.StartsWith("<|", StringComparison.Ordinal) ||
            !tok.EndsWith("|>", StringComparison.Ordinal)) return false;
        return DelimiterBodyRegex.IsMatch(tok.Substring(2, tok.Length - 4));
    }

    /// <summary>True if the map has the data BPETokenizer needs.</summary>
    public static bool Supports(TokenizerMap map) =>
        map.Vocab is { Count: > 0 } &&
        map.Merges is { Count: > 0 } &&
        (map.Encoder == "byte_level" || map.Encoder == "metaspace");

    public BPETokenizer(TokenizerMap map)
    {
        if (!Supports(map))
            throw new ArgumentException(
                $"BPETokenizer: map \"{map.Id}\" lacks vocab/merges/encoder. " +
                "Use BPETokenizer.Supports(map) to check first, or call " +
                "Tokenize.Pick(map) which falls back to LongestMatchTokenizer.",
                nameof(map));

        var mapVocab = map.Vocab!;
        var mapMerges = map.Merges!;
        _encoder = map.Encoder!;
        Id = map.Id;
        _byteFallbackStart = map.ByteFallbackStart ?? -1;

        _vocab = new Dictionary<string, int>(mapVocab.Count);
        foreach (var (k, v) in mapVocab) _vocab[k] = v;

        _mergeRanks = new Dictionary<string, int>(mapMerges.Count);
        for (var i = 0; i < mapMerges.Count; i++) _mergeRanks[mapMerges[i]] = i;

        if (_encoder == "byte_level")
        {
            if (string.IsNullOrEmpty(map.PreTokenizerPattern))
                throw new ArgumentException(
                    $"BPETokenizer: byte_level map \"{map.Id}\" missing pre_tokenizer_pattern.",
                    nameof(map));
            // Unicode property classes (\p{L} etc.) require RegexOptions.None
            //: .NET's regex engine supports them natively.
            _preTokRegex = new Regex(map.PreTokenizerPattern, RegexOptions.Compiled);
        }

        // Build the special-token scanner. Accept entries from map.SpecialTokens
        // AND any vocab key in `<|body|>` shape: older maps shipped before a
        // chat-template revision may carry the delimiters in vocab but not in
        // SpecialTokens. Length-descending order so longer delimiters match
        // before shorter prefixes. Without this pre-scan, `<|im_start|>` would
        // tokenise byte-by-byte, never resolving to its single atomic vocab ID.
        _specialIds = new Dictionary<string, int>();
        if (map.SpecialTokens is { Count: > 0 } specials)
            foreach (var (name, id) in specials) _specialIds[name] = id;
        foreach (var (tok, id) in _vocab)
        {
            if (_specialIds.ContainsKey(tok)) continue;
            if (IsDelimiterShape(tok)) _specialIds[tok] = id;
        }
        if (_specialIds.Count > 0)
        {
            var keys = _specialIds.Keys.OrderByDescending(k => k.Length);
            var alt = string.Join("|", keys.Select(Regex.Escape));
            _specialRegex = new Regex(alt, RegexOptions.Compiled);
        }
    }

    /// <summary>Encode text → token IDs.</summary>
    public int[] Encode(string text)
    {
        if (string.IsNullOrEmpty(text)) return Array.Empty<int>();

        if (_specialRegex is not null)
        {
            var ids = new List<int>();
            var cursor = 0;
            foreach (Match m in _specialRegex.Matches(text))
            {
                if (m.Index > cursor) EncodeChunk(text.AsSpan(cursor, m.Index - cursor).ToString(), ids);
                ids.Add(_specialIds[m.Value]);
                cursor = m.Index + m.Length;
            }
            if (cursor < text.Length) EncodeChunk(text[cursor..], ids);
            return ids.ToArray();
        }

        var idsAll = new List<int>();
        EncodeChunk(text, idsAll);
        return idsAll.ToArray();
    }

    private void EncodeChunk(string text, List<int> ids)
    {
        if (string.IsNullOrEmpty(text)) return;
        var pieces = PreTokenize(text);
        foreach (var piece in pieces)
        {
            if (_cache.TryGetValue(piece, out var cached))
            {
                ids.AddRange(cached);
                continue;
            }
            var encoded = EncodePieceToVocabSpace(piece);
            var merged = ApplyBPE(encoded);
            var pieceIds = Lookup(merged);
            _cache[piece] = pieceIds;
            ids.AddRange(pieceIds);
        }
    }

    // ── Pre-tokenization ────────────────────────────────────────────────────

    private List<string> PreTokenize(string text)
    {
        if (_encoder == "byte_level")
        {
            var result = new List<string>();
            foreach (Match m in _preTokRegex!.Matches(text))
                if (m.Length > 0) result.Add(m.Value);
            return result;
        }

        // Metaspace: split on whitespace, prefix every word with ▁.
        var pieces = new List<string>();
        var collapsed = Regex.Replace(text, "[ \\t]+", " ");
        var parts = Regex.Split(collapsed, "(\\s)").Where(p => p.Length > 0);
        foreach (var p in parts)
        {
            if (p == " ") continue;
            pieces.Add(ByteEncoder.Metaspace + p);
        }
        return pieces;
    }

    // ── Step 2: piece → vocab character space ──────────────────────────────

    private List<string> EncodePieceToVocabSpace(string piece)
    {
        if (_encoder == "byte_level")
        {
            var bytes = Encoding.UTF8.GetBytes(piece);
            var encoded = ByteEncoder.EncodeByteLevelChars(bytes);
            return Codepoints(encoded);
        }
        return Codepoints(piece);
    }

    private static List<string> Codepoints(string s)
    {
        var result = new List<string>(s.Length);
        var enumerator = StringInfo.GetTextElementEnumerator(s);
        while (enumerator.MoveNext())
            result.Add((string)enumerator.Current);
        return result;
    }

    // ── Step 3: BPE merges ─────────────────────────────────────────────────

    private List<string> ApplyBPE(List<string> tokens)
    {
        if (tokens.Count < 2) return tokens;

        var parts = new List<string>(tokens);
        while (true)
        {
            var bestIdx = -1;
            var bestRank = int.MaxValue;
            for (var i = 0; i < parts.Count - 1; i++)
            {
                var key = parts[i] + ' ' + parts[i + 1];
                if (_mergeRanks.TryGetValue(key, out var r) && r < bestRank)
                {
                    bestRank = r;
                    bestIdx = i;
                }
            }
            if (bestIdx == -1) break;

            // Merge ALL non-overlapping occurrences in one pass: matches HF.
            var left = parts[bestIdx];
            var right = parts[bestIdx + 1];
            var merged = left + right;
            var next = new List<string>(parts.Count);
            var j = 0;
            while (j < parts.Count)
            {
                if (j < parts.Count - 1 && parts[j] == left && parts[j + 1] == right)
                {
                    next.Add(merged);
                    j += 2;
                }
                else
                {
                    next.Add(parts[j]);
                    j += 1;
                }
            }
            parts = next;
        }
        return parts;
    }

    // ── Step 4: vocab lookup with byte fallback ────────────────────────────

    private int[] Lookup(List<string> tokens)
    {
        var ids = new List<int>(tokens.Count);
        foreach (var tok in tokens)
        {
            if (_vocab.TryGetValue(tok, out var id))
            {
                ids.Add(id);
                continue;
            }
            if (_byteFallbackStart >= 0)
            {
                foreach (var b in Encoding.UTF8.GetBytes(tok))
                    ids.Add(_byteFallbackStart + b);
            }
            // For byte_level this is unreachable for valid UTF-8 input.
        }
        return ids.ToArray();
    }
}
