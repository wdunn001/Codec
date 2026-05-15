// Codec v0.4 version negotiation — client-side surface.
//
// Mirror of `packages/web/src/version-signaling.ts` and
// `packages/python/src/codecai/version_signaling.py`. See
// `spec/versions/v0.4.md`:
//   - § Version Compatibility Signaling (Codec-Client-Version, 426 path)
//   - § Capabilities are opt-on at the server (two-stage)
//   - § Graceful downgrade (response shaping)
//
// Typical usage:
//
//     using var client = new HttpClient();
//     var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = body };
//     VersionSignaling.AddClientVersionHeader(req);
//     var resp = await client.SendAsync(req);
//     var err = await VersionSignaling.ParseVersionRequiredAsync(resp);
//     if (err != null) throw err;

using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Codec;

/// <summary>
/// Shape of the JSON body on a v0.4 server's <c>426 Upgrade Required</c>
/// response. Pre-v0.4 clients that parse this as a generic JSON error can
/// still render <see cref="Error"/> + <see cref="MinimumVersion"/> as a
/// string — the structure degrades gracefully.
/// </summary>
public sealed record CodecVersionRequiredBody(
    [property: JsonPropertyName("error")] string Error,
    [property: JsonPropertyName("minimum_version")] string MinimumVersion,
    [property: JsonPropertyName("required_features")] IReadOnlyList<string> RequiredFeatures,
    [property: JsonPropertyName("client_version")] string ClientVersion,
    [property: JsonPropertyName("docs_url")] string? DocsUrl = null,
    [property: JsonPropertyName("deployment_id")] string? DeploymentId = null
);

/// <summary>
/// Shape of <c>.well-known/codec/version-policy.json</c>. Returned by
/// deployments that mandate v0.4+ features. Deployments without
/// mandatory features SHOULD NOT publish this document.
/// </summary>
public sealed record CodecVersionPolicyDocument(
    [property: JsonPropertyName("minimum_version")] string MinimumVersion,
    [property: JsonPropertyName("required_features")] IReadOnlyList<string> RequiredFeatures,
    [property: JsonPropertyName("deployment_id")] string? DeploymentId = null,
    [property: JsonPropertyName("docs_url")] string? DocsUrl = null,
    [property: JsonPropertyName("valid_until")] string? ValidUntil = null
);

/// <summary>
/// Thrown when a v0.4-mandating server refuses a request with a 426.
/// </summary>
public sealed class CodecVersionRequiredException : Exception
{
    public string MinimumVersion { get; }
    public IReadOnlyList<string> RequiredFeatures { get; }
    public string ClientVersion { get; }
    public string? DocsUrl { get; }
    public string? DeploymentId { get; }
    public CodecVersionRequiredBody Body { get; }

    public CodecVersionRequiredException(CodecVersionRequiredBody body)
        : base(FormatMessage(body))
    {
        Body = body;
        MinimumVersion = body.MinimumVersion;
        RequiredFeatures = body.RequiredFeatures;
        ClientVersion = body.ClientVersion;
        DocsUrl = body.DocsUrl;
        DeploymentId = body.DeploymentId;
    }

    private static string FormatMessage(CodecVersionRequiredBody body)
    {
        var features = body.RequiredFeatures.Count > 0
            ? $" (requires: {string.Join(", ", body.RequiredFeatures)})"
            : string.Empty;
        var docs = !string.IsNullOrEmpty(body.DocsUrl) ? $" See {body.DocsUrl}" : "";
        return $"Codec server requires v{body.MinimumVersion}{features}; "
             + $"this client speaks v{body.ClientVersion}.{docs}".TrimEnd();
    }
}

/// <summary>
/// Codec v0.4 version negotiation primitives. Static class — no state.
/// </summary>
public static class VersionSignaling
{
    /// <summary>The protocol version this package speaks.</summary>
    public const string CodecClientVersion = "0.4";

    /// <summary>Request header name (canonical case).</summary>
    public const string CodecClientVersionHeader = "Codec-Client-Version";

    /// <summary>Response header name; advisory on 2xx, load-bearing on 426.</summary>
    public const string CodecMinVersionHeader = "Codec-Min-Version";

    /// <summary>Response header name; emitted on 426.</summary>
    public const string CodecRequiredFeaturesHeader = "Codec-Required-Features";

    /// <summary>
    /// Stamp <see cref="CodecClientVersionHeader"/> on an outbound request,
    /// preserving any caller-set value (for test harnesses simulating
    /// older clients).
    /// </summary>
    public static void AddClientVersionHeader(
        HttpRequestMessage request,
        string? overrideVersion = null)
    {
        if (!request.Headers.Contains(CodecClientVersionHeader))
        {
            request.Headers.Add(
                CodecClientVersionHeader,
                overrideVersion ?? CodecClientVersion);
        }
    }

    /// <summary>
    /// Same as <see cref="AddClientVersionHeader(HttpRequestMessage, string?)"/>
    /// but on a <see cref="HttpRequestHeaders"/> directly. Useful when
    /// reusing headers across many requests.
    /// </summary>
    public static void AddClientVersionHeader(
        HttpRequestHeaders headers,
        string? overrideVersion = null)
    {
        if (!headers.Contains(CodecClientVersionHeader))
        {
            headers.Add(
                CodecClientVersionHeader,
                overrideVersion ?? CodecClientVersion);
        }
    }

    /// <summary>
    /// Build the well-known URL for an origin.
    /// </summary>
    public static string WellKnownVersionPolicyUrl(string origin)
        => $"{origin.TrimEnd('/')}/.well-known/codec/version-policy.json";

    /// <summary>
    /// Parse a 426 Upgrade Required response body into a typed exception.
    /// Returns <c>null</c> if the response is not a 426. Throws
    /// <see cref="FormatException"/> if it is a 426 but the body isn't
    /// a recognized v0.4 shape — never silently swallows a 426.
    /// </summary>
    public static async Task<CodecVersionRequiredException?> ParseVersionRequiredAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken = default)
    {
        if (response.StatusCode != System.Net.HttpStatusCode.UpgradeRequired)
            return null;

        var text = await response.Content
            .ReadAsStringAsync(cancellationToken)
            .ConfigureAwait(false);

        CodecVersionRequiredBody? body;
        try
        {
            body = JsonSerializer.Deserialize<CodecVersionRequiredBody>(text);
        }
        catch (JsonException)
        {
            throw new FormatException(
                $"Codec server returned 426 Upgrade Required but body was not JSON: "
                + Truncate(text, 200));
        }

        if (body is null
            || body.Error != "codec_version_required"
            || string.IsNullOrEmpty(body.MinimumVersion)
            || string.IsNullOrEmpty(body.ClientVersion)
            || body.RequiredFeatures is null)
        {
            throw new FormatException(
                $"Codec server returned 426 Upgrade Required with an unrecognized body: "
                + Truncate(text, 200));
        }

        return new CodecVersionRequiredException(body);
    }

    /// <summary>
    /// Pre-flight fetch of the deployment's minimum-version policy.
    /// Returns <c>null</c> when the server returns 404 (unrestricted
    /// deployment). Throws on 5xx or malformed body.
    /// </summary>
    public static async Task<CodecVersionPolicyDocument?> DiscoverVersionPolicyAsync(
        string origin,
        HttpClient client,
        CancellationToken cancellationToken = default)
    {
        var url = WellKnownVersionPolicyUrl(origin);
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        AddClientVersionHeader(req);
        using var resp = await client.SendAsync(req, cancellationToken).ConfigureAwait(false);

        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return null;

        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"Failed to fetch version policy from {url}: HTTP {(int)resp.StatusCode}");
        }

        var text = await resp.Content
            .ReadAsStringAsync(cancellationToken)
            .ConfigureAwait(false);
        CodecVersionPolicyDocument? doc;
        try
        {
            doc = JsonSerializer.Deserialize<CodecVersionPolicyDocument>(text);
        }
        catch (JsonException ex)
        {
            throw new FormatException(
                $"Version-policy document at {url} is malformed: {Truncate(text, 200)}",
                ex);
        }
        if (doc is null
            || string.IsNullOrEmpty(doc.MinimumVersion)
            || doc.RequiredFeatures is null)
        {
            throw new FormatException(
                $"Version-policy document at {url} is malformed: {Truncate(text, 200)}");
        }
        return doc;
    }

    private static string Truncate(string s, int n)
        => s.Length <= n ? s : s.Substring(0, n);
}
