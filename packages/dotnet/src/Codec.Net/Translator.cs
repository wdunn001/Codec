// SPDX-License-Identifier: MIT
//
// Translator: cross-vocab token-stream pipe.
//
// Take Agent A's token IDs in vocab V_A, produce Agent B's token IDs in
// vocab V_B, with no text ever leaving the process. Internally:
//
//     ids_A → Detokenizer(V_A) → utf8 → BPETokenizer(V_B) → ids_B
//
// The text intermediate is purely local; agent-to-agent traffic still
// carries only token IDs on the wire. Mirrors the TS Translator class
// from @codecai/web and the Python Translator from codecai: same
// word-boundary buffering rules.
//
// Streaming caveat: BPE merges depend on context. Re-tokenizing
// partial words mid-stream produces different IDs than re-tokenizing
// the complete word. The Translator buffers text until a safe boundary
// (whitespace) before flushing through BPE. Pass partial=true for
// incoming chunks and partial=false (or call Finish()) on the last
// chunk so the buffer drains.
using System;
using System.Collections.Generic;
using System.Text;

namespace Codec;

/// <summary>Cross-vocab agent-handoff pipe.</summary>
/// <remarks>
/// Construct with a source map and a target map. Call Translate
/// repeatedly with chunks of source IDs; receive chunks of target IDs.
/// Stateful across calls: partial words buffer internally.
/// </remarks>
/// <example>
/// <code>
/// var tr = new Translator(qwenMap, llamaMap);
/// var llamaIds = tr.Translate(qwenIds);                    // one-shot
///
/// // Streaming:
/// foreach (var chunk in chunks)
///     output.AddRange(tr.Translate(chunk, partial: true));
/// output.AddRange(tr.Finish());
/// </code>
/// </example>
public sealed class Translator
{
    public string FromId { get; }
    public string ToId { get; }

    private readonly Detokenizer _fromDetok;
    private readonly ITokenizer  _toTok;
    private readonly StringBuilder _textBuffer = new();

    public Translator(TokenizerMap fromMap, TokenizerMap toMap)
    {
        if (fromMap is null) throw new ArgumentNullException(nameof(fromMap));
        if (toMap is null)   throw new ArgumentNullException(nameof(toMap));

        FromId    = fromMap.Id;
        ToId      = toMap.Id;
        _fromDetok = new Detokenizer(fromMap);
        _toTok     = Tokenize.Pick(toMap);
    }

    /// <summary>
    /// Translate a chunk of source-vocab IDs to target-vocab IDs.
    /// </summary>
    /// <param name="ids">Source IDs to render through V_A's detokenizer.</param>
    /// <param name="partial">
    /// True for streaming chunks (a trailing partial word stays buffered).
    /// False (or call <see cref="Finish"/>) on the final chunk so the
    /// buffer drains.
    /// </param>
    public int[] Translate(IReadOnlyList<int> ids, bool partial = false)
    {
        if (ids is null) throw new ArgumentNullException(nameof(ids));

        // Render through V_A's detokenizer with the same partial flag: the
        // detokenizer handles partial UTF-8 byte sequences for us.
        var text = _fromDetok.Render(ids, new DetokenizeOptions { Partial = partial });
        if (text.Length > 0) _textBuffer.Append(text);

        if (!partial)
        {
            var allText = _textBuffer.ToString();
            _textBuffer.Clear();
            return _toTok.Encode(allText);
        }

        // Streaming chunk: find the last safe boundary and flush before it.
        // Pre-tokenizers split at whitespace. Re-encoding text up to the
        // last whitespace therefore yields the same IDs as re-encoding the
        // complete word later.
        int safe = FindLastSafeBoundary(_textBuffer);
        if (safe <= 0) return Array.Empty<int>();

        var toEncode = _textBuffer.ToString(0, safe);
        _textBuffer.Remove(0, safe);
        return _toTok.Encode(toEncode);
    }

    /// <summary>
    /// End-of-stream flush. Equivalent to <c>Translate(empty, partial: false)</c>.
    /// </summary>
    public int[] Finish() => Translate(Array.Empty<int>(), partial: false);

    /// <summary>Drop all internal state. Call between conversations.</summary>
    public void Reset()
    {
        _fromDetok.Reset();
        _textBuffer.Clear();
    }

    // ASCII whitespace + common Unicode whitespace block: covers the
    // pre-tokenizer regexes used by Llama-3, Qwen, Phi-3, Mistral, etc.
    private static bool IsWhitespaceCp(int cp) => cp switch
    {
        0x20 or 0x09 or 0x0A or 0x0D or 0x0B or 0x0C
            or 0x00A0 or 0x2028 or 0x2029 or 0x3000 => true,
        _ => false,
    };

    private static int FindLastSafeBoundary(StringBuilder buf)
    {
        for (int i = buf.Length - 1; i >= 0; i--)
        {
            if (IsWhitespaceCp(buf[i])) return i + 1;
        }
        return 0;
    }
}

/// <summary>One-shot Translator, for non-streaming uses where all IDs are in hand.</summary>
public static class TranslatorExtensions
{
    public static int[] Translate(TokenizerMap fromMap, TokenizerMap toMap, IReadOnlyList<int> ids) =>
        new Translator(fromMap, toMap).Translate(ids);

    /// <summary>
    /// Build a static V_A → V_B[] translation table by rendering each V_A
    /// vocab entry to text and re-tokenizing through V_B.
    /// </summary>
    /// <remarks>
    /// Context-free: the result for a given source ID may differ from what
    /// <see cref="Translator.Translate"/> produces when the same ID
    /// appears mid-sentence (BPE merges depend on context). Useful for
    /// analysis (vocab overlap, cost estimation) and as a fast lookup
    /// when context-free translation is acceptable.
    /// </remarks>
    public static Dictionary<int, int[]> StaticTranslationTable(
        TokenizerMap fromMap, TokenizerMap toMap)
    {
        var detok = new Detokenizer(fromMap);
        var tok = Tokenize.Pick(toMap);
        var result = new Dictionary<int, int[]>();

        var specialIds = new HashSet<int>();
        if (fromMap.SpecialTokens is not null)
            foreach (var id in fromMap.SpecialTokens.Values) specialIds.Add(id);

        // v2 maps: walk vocab
        if (fromMap.Vocab is not null)
        {
            foreach (var (_, id) in fromMap.Vocab)
            {
                if (specialIds.Contains(id)) continue;
                var text = detok.Render(new[] { id });
                if (text.Length == 0) continue;
                result[id] = tok.Encode(text);
                detok.Reset();
            }
        }

        // v1 maps: also walk tokens (keys are id strings)
        if (fromMap.Tokens is not null)
        {
            foreach (var (idStr, _) in fromMap.Tokens)
            {
                if (!int.TryParse(idStr, out int id)) continue;
                if (specialIds.Contains(id) || result.ContainsKey(id)) continue;
                var text = detok.Render(new[] { id });
                if (text.Length == 0) continue;
                result[id] = tok.Encode(text);
                detok.Reset();
            }
        }

        return result;
    }
}
