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

    /// <summary>
    /// Per-model tool-calling convention. Optional; populated by
    /// <c>@codecai/maps-cli</c> when it detects a known chat-template
    /// signature. Absence means "convention not declared in this map" — see
    /// <c>spec/PROTOCOL.md</c> § "Tool-call calling conventions in the map".
    /// </summary>
    [JsonPropertyName("tool_calling")]
    public ToolCallingBlock? ToolCalling { get; init; }

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
        if (map.ToolCalling is { } tc)
        {
            if (tc.Markers is null
                || string.IsNullOrEmpty(tc.Markers.Start)
                || string.IsNullOrEmpty(tc.Markers.End))
                throw new TokenizerMapValidationException(
                    "tool_calling.markers.start/.end must both be non-empty strings");
            if (map.SpecialTokens is null
                || !map.SpecialTokens.ContainsKey(tc.Markers.Start)
                || !map.SpecialTokens.ContainsKey(tc.Markers.End))
                throw new TokenizerMapValidationException(
                    $"tool_calling.markers.start (\"{tc.Markers.Start}\") and .end "
                    + $"(\"{tc.Markers.End}\") must both exist as keys in special_tokens");
        }
    }
}

/// <summary>Thrown by <see cref="TokenizerMap.Validate"/> on schema violations.</summary>
public sealed class TokenizerMapValidationException : Exception
{
    public TokenizerMapValidationException(string message)
        : base($"TokenizerMap validation failed: {message}") { }
}

/// <summary>
/// Per-model tool-calling convention block on a <see cref="TokenizerMap"/>.
/// Each <see cref="Convention"/> value pins a specific argument layout, marker
/// placement, and result framing — see <c>spec/PROTOCOL.md</c> §
/// "Tool-call calling conventions in the map" for the normative table.
/// </summary>
public sealed class ToolCallingBlock
{
    /// <summary>Closed enum naming the calling convention.</summary>
    [JsonPropertyName("convention")]
    public ToolCallingConvention Convention { get; init; }

    /// <summary>
    /// Start/end marker token names. Both names MUST exist as keys in the
    /// parent map's <c>special_tokens</c> table.
    /// </summary>
    [JsonPropertyName("markers")]
    public ToolCallingMarkers? Markers { get; init; }

    /// <summary>How tool-call arguments are packed inside the marker pair.</summary>
    [JsonPropertyName("args_format")]
    public ToolCallingArgsFormat ArgsFormat { get; init; }

    /// <summary>How tool results come back into the model's input.</summary>
    [JsonPropertyName("result_format")]
    public ToolCallingResultFormat ResultFormat { get; init; }
}

/// <summary>Start/end marker token names for a tool call.</summary>
public sealed class ToolCallingMarkers
{
    [JsonPropertyName("start")]
    public string Start { get; init; } = string.Empty;

    [JsonPropertyName("end")]
    public string End { get; init; } = string.Empty;
}

/// <summary>
/// Closed enum of tool-calling conventions. Wire form is the snake_case
/// version of the enum name (e.g. <c>MistralNemo</c> ↔ <c>"mistral_nemo"</c>);
/// applied via the <see cref="JsonSnakeCaseEnumConverter"/> on
/// <see cref="TokenizerMap"/>'s deserialization options.
/// </summary>
[JsonConverter(typeof(JsonSnakeCaseEnumConverter))]
public enum ToolCallingConvention
{
    Llama3,
    Qwen25,
    Phi4,
    MistralNemo,
    DeepseekV3,
    DeepseekR1,
    Custom,
}

[JsonConverter(typeof(JsonSnakeCaseEnumConverter))]
public enum ToolCallingArgsFormat
{
    Json,
    PythonArgs,
}

[JsonConverter(typeof(JsonSnakeCaseEnumConverter))]
public enum ToolCallingResultFormat
{
    Text,
    Json,
}

/// <summary>
/// .NET 8-compatible snake_case enum converter. Subclasses
/// <see cref="JsonStringEnumConverter"/> with <see cref="JsonNamingPolicy.SnakeCaseLower"/>
/// so PascalCase enum members serialise as <c>snake_case</c> on the wire
/// (matches the spec's enum values).
/// </summary>
internal sealed class JsonSnakeCaseEnumConverter : JsonStringEnumConverter
{
    public JsonSnakeCaseEnumConverter()
        : base(JsonNamingPolicy.SnakeCaseLower) { }
}
