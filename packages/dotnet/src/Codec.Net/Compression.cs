// SPDX-License-Identifier: MIT
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Codec;

/// <summary>
/// Client-side helpers for the Codec compression contract.
///
/// .NET twin of <c>codecai.compression</c> (Python) and the Java /
/// TypeScript / Rust equivalents: the server emits
/// <c>Codec-Zstd-Dict: sha256:&lt;hex&gt;</c> on every zstd response, the
/// client validates that header against locally-loaded dicts before
/// decompressing. See <c>spec/PROTOCOL.md</c> "Codec-Zstd-Dict response
/// header" for the full contract.
///
/// The actual zstd decompression is intentionally out of scope here: the
/// BCL has gzip + brotli built in, zstd needs a third-party package
/// (ZstdSharp.Port / ZstdNet / native bindings), and either way the
/// caller usually already has its own HTTP plumbing. This class gives you
/// the small piece that is specific to Codec: matching a response's
/// declared dict hash to the dict you have loaded.
/// </summary>
public static class Compression
{
    /// <summary>
    /// Compute the canonical Codec-Zstd-Dict hash for <paramref name="bytes"/>.
    /// Returns <c>sha256:&lt;lowercase hex&gt;</c>: same shape as the
    /// server-side header value and the <c>hash</c> field in tokenizer-map
    /// <c>zstd_dictionaries[]</c> entries.
    /// </summary>
    public static string HashZstdDict(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        var sb = new StringBuilder("sha256:", 7 + 64);
        foreach (var b in hash) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    /// <summary>
    /// Pick the zstd dict to decompress this response with.
    /// </summary>
    /// <param name="responseHeaders">Response headers. Lookups are
    /// case-insensitive: HTTP header names are case-insensitive per
    /// RFC 7230 §3.2 and most .NET HTTP layers expose a case-insensitive
    /// view, but a caller-supplied <see cref="Dictionary{TKey,TValue}"/>
    /// with the default comparer is normalised here.</param>
    /// <param name="loadedDicts">
    /// <c>{sha256_hash: dict_bytes}</c>: the dicts the client has loaded
    /// locally. Hashes follow the same <c>sha256:&lt;hex&gt;</c> format
    /// the server emits.</param>
    /// <returns>
    /// The matching dict's bytes when the response is
    /// <c>Content-Encoding: zstd</c> and the server's
    /// <c>Codec-Zstd-Dict</c> header points at a loaded dict; or
    /// <c>null</c> when the response is not zstd (the caller's HTTP
    /// stack handles gzip / br / identity).
    /// </returns>
    /// <exception cref="CodecZstdDictException">
    /// Thrown when the response is zstd but:
    /// <list type="bullet">
    /// <item>the <c>Codec-Zstd-Dict</c> header is missing (per spec the
    /// server MUST emit it on every zstd response),</item>
    /// <item>the header is malformed (not <c>sha256:&lt;hex&gt;</c>),</item>
    /// <item>the header names a hash we have not loaded: the caller
    /// should fetch the dict from the tokenizer map's
    /// <c>zstd_dictionaries[]</c> entry whose <c>hash</c> matches, or
    /// retry the request with <c>Accept-Encoding: gzip</c> to downgrade
    /// to a no-dict path.</item>
    /// </list>
    /// A wrong-dict decompression would produce garbage bytes that
    /// downstream parsers would misinterpret: fail fast instead.
    /// </exception>
    public static byte[]? SelectZstdDictForResponse(
        IDictionary<string, string> responseHeaders,
        IDictionary<string, byte[]> loadedDicts)
    {
        var enc = GetHeader(responseHeaders, "content-encoding");
        if (enc is null || !enc.Trim().Equals("zstd", StringComparison.OrdinalIgnoreCase))
            return null; // caller's HTTP stack handles gzip/br/identity

        var declared = GetHeader(responseHeaders, "codec-zstd-dict");
        if (string.IsNullOrEmpty(declared))
            throw new CodecZstdDictException(
                "Response is Content-Encoding: zstd but no Codec-Zstd-Dict "
                + "header was present. Per spec/PROTOCOL.md the server MUST "
                + "name the dict it used. Refusing to guess.");

        declared = declared.Trim();
        if (!declared.StartsWith("sha256:", StringComparison.Ordinal)
            || declared.Length != "sha256:".Length + 64)
        {
            throw new CodecZstdDictException(
                $"Malformed Codec-Zstd-Dict value: '{declared}'. "
                + "Expected 'sha256:<64 hex chars>'.");
        }

        if (!TryGetLoadedDict(loadedDicts, declared, out var dictBytes))
        {
            throw new CodecZstdDictException(
                $"Server used zstd dict {declared} but it isn't loaded "
                + "locally. Fetch it from the tokenizer map's "
                + "zstd_dictionaries[] entry (the entry whose hash "
                + "matches), or send Accept-Encoding: gzip to downgrade.");
        }
        return dictBytes;
    }

    /// <summary>Case-insensitive header lookup over a plain dict.</summary>
    private static string? GetHeader(IDictionary<string, string> headers, string name)
    {
        if (headers.TryGetValue(name, out var v)) return v;
        foreach (var kv in headers)
        {
            if (string.Equals(kv.Key, name, StringComparison.OrdinalIgnoreCase))
                return kv.Value;
        }
        return null;
    }

    /// <summary>
    /// Loaded-dict lookup. Keys are <c>sha256:&lt;hex&gt;</c>; both the
    /// declared header and the registry keys are normalised to lowercase
    /// hex per the spec. An ordinal match therefore suffices for the common
    /// path. We still fall through to an ordinal-ignore-case scan to
    /// defend against callers that key the registry with mixed case.
    /// </summary>
    private static bool TryGetLoadedDict(
        IDictionary<string, byte[]> loadedDicts, string declared, out byte[] dictBytes)
    {
        if (loadedDicts.TryGetValue(declared, out var v1))
        {
            dictBytes = v1;
            return true;
        }
        foreach (var kv in loadedDicts)
        {
            if (string.Equals(kv.Key, declared, StringComparison.OrdinalIgnoreCase))
            {
                dictBytes = kv.Value;
                return true;
            }
        }
        dictBytes = Array.Empty<byte>();
        return false;
    }
}

/// <summary>
/// Raised when the server's <c>Codec-Zstd-Dict</c> header does not match
/// any dict the client has loaded, or is missing on a zstd response.
///
/// A wrong-dict decompression would produce garbage bytes that downstream
/// parsers (msgpack, protobuf) would misinterpret: fail fast instead.
/// </summary>
public class CodecZstdDictException : Exception
{
    public CodecZstdDictException(string message) : base(message) { }
    public CodecZstdDictException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>
/// Discoverable zstd dictionary surface (v0.5+).
///
/// Spec: <c>spec/WELL_KNOWN_DISCOVERY.md § "Zstd dictionaries (v0.5+)"</c>.
///
/// .NET twin of <c>codecai.discover_zstd_dict</c> (Python),
/// <c>@codecai/web#discoverZstdDict</c> (TypeScript), and
/// <c>codec_rs::discover_zstd_dict</c> (Rust). The discovery surface is
/// hard-fail by design: silent fallback to identity bytes was the v0.4.1
/// sglang COPY-dicts regression class this surface eliminates.
/// </summary>
public static class ZstdDictDiscovery
{
    /// <summary>Fixed base path under which Codec dict documents live.</summary>
    public const string DictsWellKnownBase = "/.well-known/codec/dicts";

    private static readonly Regex DictHashRe = new("^[0-9a-f]{64}$", RegexOptions.Compiled);

    /// <summary>
    /// Per-dict document URL for an origin + sha256 hash (v0.5+).
    /// Accepts either <c>sha256:&lt;hex&gt;</c> or bare <c>&lt;hex&gt;</c>.
    /// Returns <c>&lt;origin&gt;/.well-known/codec/dicts/&lt;sha256-hex&gt;.zstd</c>.
    /// </summary>
    /// <exception cref="ZstdDictDiscoveryException">
    /// Thrown when the hash input is not the expected 64-hex-char sha256 form.
    /// </exception>
    public static string WellKnownDictUrl(string origin, string hash)
    {
        var hex = ParseDictHash(hash);
        return $"{StripTrailingSlash(origin)}{DictsWellKnownBase}/{hex}.zstd";
    }

    /// <summary>
    /// Resolve a zstd dictionary via <c>.well-known/codec/dicts/&lt;hex&gt;.zstd</c>.
    /// Fetches the bytes, verifies they hash to the URL's path component, returns
    /// the raw dict bytes ready to feed into a zstd decoder.
    /// </summary>
    /// <param name="origin">HTTPS origin serving the dict (e.g. <c>https://codec.example</c>).</param>
    /// <param name="hash">SHA-256 hash, as <c>sha256:&lt;hex&gt;</c> or bare <c>&lt;hex&gt;</c>.</param>
    /// <param name="http">Optional <see cref="HttpClient"/>. If omitted, a default client is used.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <exception cref="ZstdDictDiscoveryException">404 from origin, or malformed hash input.</exception>
    /// <exception cref="ZstdDictHashMismatchException">Origin served bytes that don't match the URL's hash.</exception>
    public static async Task<byte[]> DiscoverAsync(
        string origin,
        string hash,
        HttpClient? http = null,
        CancellationToken ct = default)
    {
        var expected = ParseDictHash(hash);
        var url = WellKnownDictUrl(origin, hash);
        var client = http ?? DefaultHttp;

        using var resp = await client.GetAsync(url, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound)
            throw new ZstdDictDiscoveryException($"No zstd dict at {url} (HTTP 404)", url);
        if (!resp.IsSuccessStatusCode)
            throw new ZstdDictDiscoveryException(
                $"Failed to fetch {url}: HTTP {(int)resp.StatusCode}", url);

        var body = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        var actual = Sha256HexBytes(body);
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
            throw new ZstdDictHashMismatchException(url, expected, actual);
        return body;
    }

    private static string ParseDictHash(string hash)
    {
        var s = hash.Trim();
        if (s.StartsWith("sha256:", StringComparison.Ordinal))
            s = s.Substring("sha256:".Length);
        s = s.ToLowerInvariant();
        if (!DictHashRe.IsMatch(s))
            throw new ZstdDictDiscoveryException(
                $"Invalid dict hash '{hash}': expected 'sha256:<64 hex>' or '<64 hex>'");
        return s;
    }

    private static string Sha256HexBytes(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        var sb = new StringBuilder(64);
        foreach (var b in hash) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    private static string StripTrailingSlash(string s) =>
        s.EndsWith("/", StringComparison.Ordinal) ? s.Substring(0, s.Length - 1) : s;

    private static readonly HttpClient DefaultHttp = new HttpClient
    {
        Timeout = TimeSpan.FromSeconds(30),
    };
}

/// <summary>
/// Raised when <c>.well-known/codec/dicts/&lt;hex&gt;.zstd</c> discovery fails.
/// Covers: 404 from origin, malformed hash input.
/// </summary>
public class ZstdDictDiscoveryException : Exception
{
    public string? Url { get; }
    public ZstdDictDiscoveryException(string message, string? url = null) : base(message)
    {
        Url = url;
    }
}

/// <summary>
/// Raised when fetched dict bytes don't hash to the URL's path component.
/// Treat as byte-tampering: never decompress.
/// </summary>
public sealed class ZstdDictHashMismatchException : ZstdDictDiscoveryException
{
    public string Expected { get; }
    public string Actual { get; }
    public ZstdDictHashMismatchException(string url, string expected, string actual)
        : base($"Zstd dict hash mismatch at {url}\n  expected: {expected}\n  actual:   {actual}", url)
    {
        Expected = expected;
        Actual = actual;
    }
}
