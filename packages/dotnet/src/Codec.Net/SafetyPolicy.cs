// SPDX-License-Identifier: MIT
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Codec;

/// <summary>
/// Safety-policy descriptor types + loader. .NET twin of
/// <c>@codecai/web</c>'s <c>safety-policy.ts</c> (slice 1) and
/// <c>codecai.safety_policy</c> (Python). Same shapes, same canonical
/// JSON form for hashing — descriptors that hash to <c>sha256:abc…</c>
/// in any client hash to the identical digest here.
///
/// Used by clients that received <c>safety_policy_id</c> +
/// <c>safety_policy_hash</c> in <c>READY</c> and want to fetch and
/// surface what the server is enforcing. The descriptor is the
/// <em>sanitized</em>, publishable shape — categories, actions,
/// classifier family, summary stats — never the operator's internal
/// banned token IDs / classifier thresholds / regex patterns.
///
/// Discovery follows the existing tokenizer-map convention:
///   - <c>&lt;origin&gt;/.well-known/codec/policies/&lt;id&gt;.json</c>           (mutable)
///   - <c>&lt;origin&gt;/.well-known/codec/policies/sha256/&lt;hex&gt;.json</c> (immutable)
/// </summary>
public static class SafetyPolicyConstants
{
    public const string PolicyWellKnownBase = "/.well-known/codec/policies";
}

/// <summary>Per-category enforcement entry on the descriptor.</summary>
public sealed record SafetyCategory
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("action")]
    public required string Action { get; init; }

    [JsonPropertyName("description")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Description { get; init; }
}

/// <summary>Disclosed half of the classifier spec.</summary>
public sealed record SafetyClassifierBlock
{
    [JsonPropertyName("family")]
    public required string Family { get; init; }

    [JsonPropertyName("host")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Host { get; init; }

    [JsonPropertyName("requires_engine_features")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<string>? RequiresEngineFeatures { get; init; }
}

public sealed record SafetyRulesSummary
{
    [JsonPropertyName("banned_token_id_count")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? BannedTokenIdCount { get; init; }

    [JsonPropertyName("regex_pattern_count")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? RegexPatternCount { get; init; }

    [JsonPropertyName("grammar_constraint_count")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? GrammarConstraintCount { get; init; }

    [JsonPropertyName("multi_token_pattern_count")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MultiTokenPatternCount { get; init; }
}

public sealed record SafetyClientHooksBlock
{
    [JsonPropertyName("prefilter_categories")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<string>? PrefilterCategories { get; init; }

    [JsonPropertyName("client_classifier_family")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ClientClassifierFamily { get; init; }
}

public sealed record SafetyPublisherBlock
{
    [JsonPropertyName("name")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Name { get; init; }

    [JsonPropertyName("url")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Url { get; init; }

    [JsonPropertyName("contact")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Contact { get; init; }
}

/// <summary>
/// The sanitized, publishable safety-policy descriptor. Matches
/// <c>spec/safety-policy.schema.json</c> v1.
/// </summary>
public sealed record SafetyPolicyDescriptor
{
    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("version")]
    public required string Version { get; init; }

    [JsonPropertyName("tokenizers")]
    public required IReadOnlyList<string> Tokenizers { get; init; }

    [JsonPropertyName("categories")]
    public required IReadOnlyList<SafetyCategory> Categories { get; init; }

    [JsonPropertyName("category_registry")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? CategoryRegistry { get; init; }

    [JsonPropertyName("classifier")]
    public required SafetyClassifierBlock Classifier { get; init; }

    [JsonPropertyName("rules_summary")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public SafetyRulesSummary? RulesSummary { get; init; }

    [JsonPropertyName("client_hooks")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public SafetyClientHooksBlock? ClientHooks { get; init; }

    [JsonPropertyName("published_at")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PublishedAt { get; init; }

    [JsonPropertyName("publisher")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public SafetyPublisherBlock? Publisher { get; init; }
}

public sealed record SafetyPolicyPointer
{
    [JsonPropertyName("id")] public required string Id { get; init; }
    [JsonPropertyName("url")] public required string Url { get; init; }
    [JsonPropertyName("hash")] public required string Hash { get; init; }
    [JsonPropertyName("published_at")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PublishedAt { get; init; }
}

/// <summary>Errors raised by safety-policy validation / loading.</summary>
public sealed class SafetyPolicyValidationException : Exception
{
    public SafetyPolicyValidationException(string message)
        : base($"SafetyPolicyDescriptor validation failed: {message}") { }
}

public sealed class SafetyPolicyHashMismatchException : Exception
{
    public string Expected { get; }
    public string Actual { get; }

    public SafetyPolicyHashMismatchException(string expected, string actual)
        : base($"SafetyPolicyDescriptor hash mismatch.\n  expected: {expected}\n  actual:   {actual}")
    {
        Expected = expected;
        Actual = actual;
    }
}

public class SafetyPolicyDiscoveryException : Exception
{
    public SafetyPolicyDiscoveryException(string message) : base(message) { }
}

public sealed class SafetyPolicyDiscoveryNotFoundException : SafetyPolicyDiscoveryException
{
    public string Url { get; }
    public int Status { get; }

    public SafetyPolicyDiscoveryNotFoundException(string url, int status)
        : base($"No safety-policy document at {url} (HTTP {status})")
    {
        Url = url;
        Status = status;
    }
}

/// <summary>Validation + canonical JSON + URL builders + HTTP loader.</summary>
public static class SafetyPolicy
{
    private static readonly HashSet<string> _validActions =
        new(StringComparer.Ordinal) { "stop", "redact", "regenerate", "flag" };
    private static readonly HashSet<string> _validHosts =
        new(StringComparer.Ordinal) { "server", "client", "both" };
    private static readonly HashSet<string> _validEngineFeatures =
        new(StringComparer.Ordinal) { "logits_processor", "hidden_states", "sampling_chain" };

    private static readonly System.Text.RegularExpressions.Regex CategoryNameRe =
        new("^[a-z0-9_-]+$", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex IdRe =
        new("^[a-z0-9._/-]+$", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex HexRe =
        new("^[0-9a-f]{64}$", System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>
    /// JSON serializer options matching the canonical wire format:
    /// 2-space indent, omit-null, no escape-non-ascii so unicode in
    /// publisher/contact fields round-trips byte-identically across
    /// stacks.
    /// </summary>
    public static readonly JsonSerializerOptions CanonicalJsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// Validate a parsed JSON document against the descriptor schema.
    /// Throws <see cref="SafetyPolicyValidationException"/> on failure;
    /// returns silently on success.
    /// </summary>
    public static void Validate(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object)
            throw new SafetyPolicyValidationException("not an object");

        var id = TryString(value, "id");
        if (string.IsNullOrEmpty(id))
            throw new SafetyPolicyValidationException("id must be a non-empty string");

        if (TryString(value, "version") is null)
            throw new SafetyPolicyValidationException("version must be a string");

        if (!value.TryGetProperty("tokenizers", out var tokenizers)
            || tokenizers.ValueKind != JsonValueKind.Array
            || tokenizers.GetArrayLength() == 0)
            throw new SafetyPolicyValidationException(
                "tokenizers must be a non-empty array of tokenizer ids");
        foreach (var t in tokenizers.EnumerateArray())
            if (t.ValueKind != JsonValueKind.String)
                throw new SafetyPolicyValidationException("tokenizers entries must be strings");

        if (!value.TryGetProperty("categories", out var categories)
            || categories.ValueKind != JsonValueKind.Array
            || categories.GetArrayLength() == 0)
            throw new SafetyPolicyValidationException("categories must be a non-empty array");
        foreach (var c in categories.EnumerateArray())
        {
            if (c.ValueKind != JsonValueKind.Object)
                throw new SafetyPolicyValidationException("category entry must be an object");
            var name = TryString(c, "name") ?? throw new SafetyPolicyValidationException(
                "category.name must be a string");
            if (!CategoryNameRe.IsMatch(name))
                throw new SafetyPolicyValidationException(
                    $"category.name must match {CategoryNameRe} (got {JsonEsc(name)})");
            var action = TryString(c, "action") ?? throw new SafetyPolicyValidationException(
                $"category.action for {JsonEsc(name)} must be one of stop|redact|regenerate|flag");
            if (!_validActions.Contains(action))
                throw new SafetyPolicyValidationException(
                    $"category.action for {JsonEsc(name)} must be one of stop|redact|regenerate|flag");
            if (c.TryGetProperty("description", out var desc) && desc.ValueKind != JsonValueKind.String && desc.ValueKind != JsonValueKind.Null)
                throw new SafetyPolicyValidationException(
                    $"category.description for {JsonEsc(name)} must be a string when present");
        }

        if (!value.TryGetProperty("classifier", out var classifier) || classifier.ValueKind != JsonValueKind.Object)
            throw new SafetyPolicyValidationException("classifier must be an object");
        var family = TryString(classifier, "family");
        if (string.IsNullOrEmpty(family))
            throw new SafetyPolicyValidationException("classifier.family must be a non-empty string");
        if (classifier.TryGetProperty("host", out var host) && host.ValueKind != JsonValueKind.Null)
        {
            var h = host.ValueKind == JsonValueKind.String ? host.GetString()! : "<not-string>";
            if (!_validHosts.Contains(h))
                throw new SafetyPolicyValidationException(
                    $"classifier.host must be one of server|client|both (got {JsonEsc(h)})");
        }
        if (classifier.TryGetProperty("requires_engine_features", out var feats) && feats.ValueKind != JsonValueKind.Null)
        {
            if (feats.ValueKind != JsonValueKind.Array)
                throw new SafetyPolicyValidationException(
                    "classifier.requires_engine_features must be an array");
            foreach (var f in feats.EnumerateArray())
            {
                if (f.ValueKind != JsonValueKind.String)
                    throw new SafetyPolicyValidationException(
                        "classifier.requires_engine_features entry must be a string");
                if (!_validEngineFeatures.Contains(f.GetString()!))
                    throw new SafetyPolicyValidationException(
                        $"classifier.requires_engine_features entry must be one of " +
                        $"logits_processor|hidden_states|sampling_chain (got {JsonEsc(f.GetString()!)})");
            }
        }

        if (value.TryGetProperty("rules_summary", out var rs) && rs.ValueKind != JsonValueKind.Null)
        {
            if (rs.ValueKind != JsonValueKind.Object)
                throw new SafetyPolicyValidationException(
                    "rules_summary must be an object when present");
            foreach (var key in new[]
            {
                "banned_token_id_count", "regex_pattern_count",
                "grammar_constraint_count", "multi_token_pattern_count",
            })
            {
                if (rs.TryGetProperty(key, out var v) && v.ValueKind != JsonValueKind.Null)
                {
                    if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt64(out var n) || n < 0)
                        throw new SafetyPolicyValidationException(
                            $"rules_summary.{key} must be a non-negative integer when present");
                }
            }
        }
    }

    /// <summary>Parse + validate a JSON byte slice into a typed descriptor.</summary>
    public static SafetyPolicyDescriptor FromJson(ReadOnlySpan<byte> bytes)
    {
        using var doc = JsonDocument.Parse(bytes.ToArray());
        Validate(doc.RootElement);
        var d = JsonSerializer.Deserialize<SafetyPolicyDescriptor>(bytes)
            ?? throw new SafetyPolicyValidationException("deserialization returned null");
        return d;
    }

    /// <summary>
    /// Canonical JSON serialization for hashing + well-known publish.
    /// Matches the TS / Python / Pydantic format: 2-space indent +
    /// trailing newline + null-omitted.
    /// </summary>
    public static byte[] CanonicalBytes(SafetyPolicyDescriptor descriptor)
    {
        using var stream = new MemoryStream();
        // Utf8JsonWriter's default indent is 2 spaces, matching the
        // canonical TS / Python / Pydantic format. (IndentSize as a
        // property only exists in .NET 9+; we rely on the default for
        // the net8.0 target this assembly targets.)
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Indented = true,
            Encoder = CanonicalJsonOptions.Encoder,
        }))
        {
            JsonSerializer.Serialize(writer, descriptor, CanonicalJsonOptions);
        }
        stream.WriteByte((byte)'\n');
        return stream.ToArray();
    }

    /// <summary>
    /// Canonical sha256 hash of a descriptor. Returns
    /// <c>sha256:&lt;64 hex chars&gt;</c> matching what
    /// <c>codecai-maps policies-hash</c> emits.
    /// </summary>
    public static string Hash(SafetyPolicyDescriptor descriptor)
    {
        var bytes = CanonicalBytes(descriptor);
        var sb = new StringBuilder("sha256:", 7 + 64);
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        foreach (var b in hash) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    /// <summary>Per-policy URL by mutable id (e.g. <c>acme/strict-v3</c>).</summary>
    public static string WellKnownPolicyUrl(string origin, string policyId)
    {
        EncodePolicyId(policyId);
        return $"{StripTrailingSlash(origin)}{SafetyPolicyConstants.PolicyWellKnownBase}/{policyId}.json";
    }

    /// <summary>Content-addressed URL by sha256 hex.</summary>
    public static string WellKnownPolicyHashUrl(string origin, string hashHex)
    {
        if (!HexRe.IsMatch(hashHex))
            throw new SafetyPolicyDiscoveryException(
                $"Invalid policy hash hex: must be 64-char lowercase hex (got {JsonEsc(hashHex)})");
        return $"{StripTrailingSlash(origin)}{SafetyPolicyConstants.PolicyWellKnownBase}/sha256/{hashHex.ToLowerInvariant()}.json";
    }

    /// <summary>Fetch + verify + parse a descriptor by URL.</summary>
    public static async Task<SafetyPolicyDescriptor> LoadAsync(
        string url, string? hash = null, HttpClient? http = null,
        CancellationToken ct = default)
    {
        http ??= DefaultHttp;
        using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        var bytes = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        if (hash is not null)
        {
            var expected = ParseHash(hash);
            var actual = Sha256Hex(bytes);
            if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
                throw new SafetyPolicyHashMismatchException(expected, actual);
        }
        return FromJson(bytes);
    }

    /// <summary>
    /// Resolve a descriptor via <c>.well-known/codec/policies/</c>.
    /// Hash present → fetches the immutable content-addressed sibling.
    /// Hash absent → fetches the mutable per-id document and follows
    /// pointers.
    /// </summary>
    public static async Task<SafetyPolicyDescriptor> DiscoverAsync(
        string origin, string id, string? hash = null,
        HttpClient? http = null, CancellationToken ct = default)
    {
        http ??= DefaultHttp;

        if (hash is not null)
        {
            var hashHex = ParseHash(hash);
            var url = WellKnownPolicyHashUrl(origin, hashHex);
            using var resp = await http.GetAsync(url, ct).ConfigureAwait(false);
            if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
                throw new SafetyPolicyDiscoveryNotFoundException(url, (int)resp.StatusCode);
            resp.EnsureSuccessStatusCode();
            var bytes = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
            var actual = Sha256Hex(bytes);
            if (!string.Equals(hashHex, actual, StringComparison.OrdinalIgnoreCase))
                throw new SafetyPolicyHashMismatchException(hashHex, actual);
            return await FollowMaybePointer(bytes, id, http, ct).ConfigureAwait(false);
        }

        var idUrl = WellKnownPolicyUrl(origin, id);
        using var idResp = await http.GetAsync(idUrl, ct).ConfigureAwait(false);
        if (idResp.StatusCode == System.Net.HttpStatusCode.NotFound)
            throw new SafetyPolicyDiscoveryNotFoundException(idUrl, (int)idResp.StatusCode);
        idResp.EnsureSuccessStatusCode();
        var idBytes = await idResp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        return await FollowMaybePointer(idBytes, id, http, ct).ConfigureAwait(false);
    }

    // -------------------------------------------------------------- internals

    private static async Task<SafetyPolicyDescriptor> FollowMaybePointer(
        byte[] bytes, string expectedId, HttpClient http, CancellationToken ct)
    {
        using var doc = JsonDocument.Parse(bytes);
        var root = doc.RootElement;
        if (root.ValueKind == JsonValueKind.Object && IsPointerShape(root))
        {
            var pointer = JsonSerializer.Deserialize<SafetyPolicyPointer>(bytes)!;
            ValidatePointer(pointer, expectedId);
            return await LoadAsync(pointer.Url, pointer.Hash, http, ct).ConfigureAwait(false);
        }
        var descriptor = FromJson(bytes);
        if (descriptor.Id != expectedId)
            throw new SafetyPolicyDiscoveryException(
                $"Inline descriptor id {JsonEsc(descriptor.Id)} does not match requested id {JsonEsc(expectedId)}");
        return descriptor;
    }

    private static bool IsPointerShape(JsonElement obj)
        => obj.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
        && obj.TryGetProperty("url", out var url) && url.ValueKind == JsonValueKind.String
        && obj.TryGetProperty("hash", out var hash) && hash.ValueKind == JsonValueKind.String
        && !obj.TryGetProperty("categories", out _);

    private static void ValidatePointer(SafetyPolicyPointer p, string expectedId)
    {
        if (p.Id != expectedId)
            throw new SafetyPolicyDiscoveryException(
                $"Pointer id {JsonEsc(p.Id)} does not match requested id {JsonEsc(expectedId)}");
        if (!(p.Url.StartsWith("https://") || p.Url.StartsWith("http://")))
            throw new SafetyPolicyDiscoveryException(
                $"Pointer url must be http(s): got {JsonEsc(p.Url)}");
        if (!System.Text.RegularExpressions.Regex.IsMatch(p.Hash, "^sha256:[0-9a-fA-F]{64}$"))
            throw new SafetyPolicyDiscoveryException(
                $"Pointer hash must be sha256:<64 hex chars>: got {JsonEsc(p.Hash)}");
    }

    private static string EncodePolicyId(string id)
    {
        if (!IdRe.IsMatch(id))
            throw new SafetyPolicyDiscoveryException(
                $"Invalid policy id {JsonEsc(id)}: must match [a-z0-9._/-]+");
        if (id.Contains("..") || id.StartsWith("/") || id.EndsWith("/"))
            throw new SafetyPolicyDiscoveryException(
                $"Invalid policy id {JsonEsc(id)}: path traversal or empty segment");
        return id;
    }

    private static string ParseHash(string hash)
    {
        var idx = hash.IndexOf(':');
        if (idx < 0) return hash.ToLowerInvariant();
        var algo = hash.AsSpan(0, idx).ToString().ToLowerInvariant();
        if (algo != "sha256")
            throw new ArgumentException($"Unsupported hash algorithm: {algo} (only sha256 supported)");
        return hash.AsSpan(idx + 1).ToString().ToLowerInvariant();
    }

    private static string Sha256Hex(byte[] bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        var sb = new StringBuilder(64);
        foreach (var b in hash) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    private static string StripTrailingSlash(string s) => s.EndsWith('/') ? s[..^1] : s;

    private static string? TryString(JsonElement obj, string name)
        => obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string JsonEsc(string s) => $"\"{s.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"";

    private static readonly HttpClient DefaultHttp = CreateDefaultHttp();

    private static HttpClient CreateDefaultHttp()
    {
        var handler = new HttpClientHandler
        {
            AutomaticDecompression =
                System.Net.DecompressionMethods.GZip
                | System.Net.DecompressionMethods.Brotli
                | System.Net.DecompressionMethods.Deflate,
        };
        var client = new HttpClient(handler);
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Codec.Net/0.2");
        return client;
    }
}
