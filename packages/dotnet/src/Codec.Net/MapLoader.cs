// SPDX-License-Identifier: MIT
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;

namespace Codec;

/// <summary>Options for <see cref="MapLoader.LoadAsync"/>.</summary>
public sealed class LoadOptions
{
    /// <summary>URL to fetch the map from.</summary>
    public required string Url { get; init; }

    /// <summary>
    /// Optional sha256 hex digest to verify the fetched map against.
    /// Accepts <c>sha256:&lt;hex&gt;</c> or bare <c>&lt;hex&gt;</c>. If omitted, no verification.
    /// </summary>
    public string? Hash { get; init; }

    /// <summary>Pluggable cache. Defaults to a static in-memory cache.</summary>
    public IMapCache? Cache { get; init; }

    /// <summary>HttpClient. If omitted, a static default is used.</summary>
    public HttpClient? Http { get; init; }

    /// <summary>Cache key. Defaults to <c>{Url}#{Hash}</c>.</summary>
    public string? CacheKey { get; init; }
}

/// <summary>Thrown when a fetched map doesn't match the expected hash.</summary>
public sealed class TokenizerMapHashMismatchException : Exception
{
    public string Expected { get; }
    public string Actual { get; }

    public TokenizerMapHashMismatchException(string expected, string actual)
        : base($"TokenizerMap hash mismatch.\n  expected: {expected}\n  actual:   {actual}")
    {
        Expected = expected;
        Actual = actual;
    }
}

/// <summary>Fetch, verify, and cache tokenizer maps.</summary>
public static class MapLoader
{
    private static readonly IMapCache DefaultCache = new MemoryMapCache();
    private static readonly HttpClient DefaultHttp = CreateDefaultHttp();

    private static HttpClient CreateDefaultHttp()
    {
        // Enable transparent decompression so brotli/gzip/zstd Content-Encoding
        // from CDNs (jsDelivr serves brotli for free) works without callers
        // having to configure anything.
        var handler = new HttpClientHandler
        {
            AutomaticDecompression =
                System.Net.DecompressionMethods.GZip
                | System.Net.DecompressionMethods.Brotli
                | System.Net.DecompressionMethods.Deflate,
        };
        var client = new HttpClient(handler);
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Codec.Net/0.1");
        return client;
    }

    /// <summary>
    /// Fetch, verify, and cache a tokenizer map. Cache hits skip the network.
    /// </summary>
    public static async Task<TokenizerMap> LoadAsync(LoadOptions opts, CancellationToken ct = default)
    {
        var cache = opts.Cache ?? DefaultCache;
        var http = opts.Http ?? DefaultHttp;
        var cacheKey = opts.CacheKey ?? $"{opts.Url}#{opts.Hash ?? string.Empty}";

        var cached = await cache.GetAsync(cacheKey, ct).ConfigureAwait(false);
        if (cached is not null) return cached;

        using var resp = await http.GetAsync(opts.Url, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        var bytes = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);

        if (opts.Hash is not null)
        {
            var expected = ParseHash(opts.Hash);
            var actual = Sha256Hex(bytes);
            if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
                throw new TokenizerMapHashMismatchException(expected, actual);
        }

        var map = TokenizerMap.FromJson(bytes);
        await cache.SetAsync(cacheKey, map, ct).ConfigureAwait(false);
        return map;
    }

    private static string Sha256Hex(byte[] bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        var sb = new StringBuilder(64);
        foreach (var b in hash) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    private static string ParseHash(string hash)
    {
        var colon = hash.IndexOf(':');
        if (colon < 0) return hash.ToLowerInvariant();
        var algo = hash[..colon].ToLowerInvariant();
        if (algo != "sha256")
            throw new NotSupportedException($"Unsupported hash algorithm: {algo} (only sha256 supported)");
        return hash[(colon + 1)..].ToLowerInvariant();
    }
}
