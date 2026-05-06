// SPDX-License-Identifier: MIT
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Codec;

/// <summary>
/// A per-model tokenizer dialect — the data needed to encode text into
/// token IDs and decode IDs back to text. Maps are immutable once
/// published; a new model version publishes a new map at a new URL with
/// a new sha256 hash.
/// </summary>
/// <remarks>
/// Schema v2: <see cref="Vocab"/> is the raw HuggingFace tokenizer.json
/// form (byte-level GPT-2-encoded chars or ▁-prefixed metaspace strings).
/// <see cref="Tokens"/> is the legacy v1 field, kept for backwards
/// compatibility — the Detokenizer reads from whichever is present.
/// </remarks>
public sealed class TokenizerMap
{
    /// <summary>Stable, globally unique tokenizer identifier (e.g. "qwen/qwen2").</summary>
    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    /// <summary>Schema version. "2" for v2 maps; "1" for legacy v1.</summary>
    [JsonPropertyName("version")]
    public string Version { get; init; } = "2";

    /// <summary>Total number of token IDs in the vocabulary.</summary>
    [JsonPropertyName("vocab_size")]
    public int VocabSize { get; init; }

    /// <summary>
    /// Vocabulary as { raw_token_text → id }. v2 schema field. "Raw" means
    /// the form stored in HuggingFace tokenizer.json — for byte_level this
    /// contains GPT-2 byte-encoded chars, for metaspace ▁-prefixed strings.
    /// </summary>
    [JsonPropertyName("vocab")]
    public Dictionary<string, int>? Vocab { get; init; }

    /// <summary>
    /// Legacy v1 vocabulary as { id_string → decoded_text }. Present only
    /// on v1 maps; v2 maps use <see cref="Vocab"/> instead.
    /// </summary>
    [JsonPropertyName("tokens")]
    public Dictionary<string, string>? Tokens { get; init; }

    /// <summary>
    /// Encoder family. "byte_level" (GPT-2 byte→unicode), "metaspace"
    /// (▁-prefix), or null (identity — vocab is already decoded text).
    /// </summary>
    [JsonPropertyName("encoder")]
    public string? Encoder { get; init; }

    /// <summary>
    /// BPE merges in priority order. Each entry is two tokens separated
    /// by a single space, e.g. "Ġ a". Required for client-side BPE.
    /// </summary>
    [JsonPropertyName("merges")]
    public List<string>? Merges { get; init; }

    /// <summary>Pre-tokenizer regex pattern. Required for byte_level BPE.</summary>
    [JsonPropertyName("pre_tokenizer_pattern")]
    public string? PreTokenizerPattern { get; init; }

    /// <summary>First ID in the byte-fallback range (inclusive). SentencePiece only.</summary>
    [JsonPropertyName("byte_fallback_start")]
    public int? ByteFallbackStart { get; init; }

    /// <summary>Last ID in the byte-fallback range (inclusive). SentencePiece only.</summary>
    [JsonPropertyName("byte_fallback_end")]
    public int? ByteFallbackEnd { get; init; }

    /// <summary>Named special tokens. Skipped during text rendering by default.</summary>
    [JsonPropertyName("special_tokens")]
    public Dictionary<string, int>? SpecialTokens { get; init; }

    /// <summary>ISO 8601 publish timestamp. Informational.</summary>
    [JsonPropertyName("published_at")]
    public string? PublishedAt { get; init; }

    /// <summary>Parse a TokenizerMap from JSON bytes.</summary>
    public static TokenizerMap FromJson(ReadOnlySpan<byte> json)
    {
        var map = JsonSerializer.Deserialize<TokenizerMap>(json, JsonOpts)
                  ?? throw new TokenizerMapValidationException("payload deserialised to null");
        Validate(map);
        return map;
    }

    /// <summary>Parse from a string.</summary>
    public static TokenizerMap FromJson(string json) =>
        FromJson(System.Text.Encoding.UTF8.GetBytes(json));

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Skip,
    };

    /// <summary>Throws <see cref="TokenizerMapValidationException"/> if the map is malformed.</summary>
    public static void Validate(TokenizerMap map)
    {
        if (string.IsNullOrEmpty(map.Id))
            throw new TokenizerMapValidationException("id must be a non-empty string");
        if (string.IsNullOrEmpty(map.Version))
            throw new TokenizerMapValidationException("version must be a non-empty string");
        if (map.VocabSize < 1)
            throw new TokenizerMapValidationException("vocab_size must be a positive integer");
        var hasVocab = map.Vocab is { Count: > 0 };
        var hasTokens = map.Tokens is { Count: > 0 };
        if (!hasVocab && !hasTokens)
            throw new TokenizerMapValidationException("one of `vocab` (v2) or `tokens` (v1) is required");
        if (map.Encoder is not (null or "byte_level" or "metaspace"))
            throw new TokenizerMapValidationException(
                $"encoder must be \"byte_level\" or \"metaspace\" if present, got \"{map.Encoder}\"");
        if (map.ByteFallbackStart.HasValue != map.ByteFallbackEnd.HasValue)
            throw new TokenizerMapValidationException(
                "byte_fallback_start and byte_fallback_end must both be set or both omitted");
    }
}

/// <summary>Thrown by <see cref="TokenizerMap.Validate"/> on schema violations.</summary>
public sealed class TokenizerMapValidationException : Exception
{
    public TokenizerMapValidationException(string message)
        : base($"TokenizerMap validation failed: {message}") { }
}
