// SPDX-License-Identifier: MIT
using System.Collections.Generic;
using System.IO;
using Xunit;
using Codec;

namespace Codec.Net.Tests;

public class CompressionTests
{
    /// <summary>
    /// Canonical hash from
    /// <c>packages/bench/fixtures/dict-zstd-interop/manifest.json</c>.
    /// Every Codec client (TS, Python, Rust, Java, .NET, C) MUST produce
    /// this exact string for the shipped dict bytes — drift means the
    /// header value won't match the server's emission and clients will
    /// refuse to decompress.
    /// </summary>
    private const string ExpectedFixtureDictHash =
        "sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db";

    /// <summary>
    /// Locate the dict-zstd-interop fixture. The .NET tests can be run
    /// from a few different working dirs (dotnet test, the IDE, CI matrix),
    /// so we walk up to <c>packages/</c> and resolve from there.
    /// </summary>
    private static string FixtureDir()
    {
        var dir = AppContext.BaseDirectory;
        for (int i = 0; i < 10; i++)
        {
            var candidate = Path.Combine(dir, "packages", "bench", "fixtures", "dict-zstd-interop");
            if (Directory.Exists(candidate)) return candidate;
            var parent = Directory.GetParent(dir);
            if (parent is null) break;
            dir = parent.FullName;
        }
        throw new DirectoryNotFoundException(
            "Could not locate packages/bench/fixtures/dict-zstd-interop relative to "
            + AppContext.BaseDirectory);
    }

    private static byte[] LoadDictBin() => File.ReadAllBytes(Path.Combine(FixtureDir(), "dict.bin"));

    // ── HashZstdDict ──────────────────────────────────────────────────────

    [Fact]
    public void HashZstdDict_MatchesManifestForShippedFixture()
    {
        var bytes = LoadDictBin();
        var hash = Compression.HashZstdDict(bytes);
        Assert.Equal(ExpectedFixtureDictHash, hash);
    }

    [Fact]
    public void HashZstdDict_KnownEmptyVector()
    {
        // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        Assert.Equal(
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            Compression.HashZstdDict(ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public void HashZstdDict_IsDeterministic()
    {
        var bytes = LoadDictBin();
        Assert.Equal(Compression.HashZstdDict(bytes), Compression.HashZstdDict(bytes));
    }

    // ── SelectZstdDictForResponse ────────────────────────────────────────

    private static Dictionary<string, byte[]> LoadedRegistry()
    {
        var bytes = LoadDictBin();
        return new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            [Compression.HashZstdDict(bytes)] = bytes,
        };
    }

    [Fact]
    public void SelectDict_ReturnsDictWhenHeadersMatch()
    {
        var loaded = LoadedRegistry();
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Encoding"] = "zstd",
            ["Codec-Zstd-Dict"] = ExpectedFixtureDictHash,
        };
        var picked = Compression.SelectZstdDictForResponse(headers, loaded);
        Assert.NotNull(picked);
        Assert.Equal(loaded[ExpectedFixtureDictHash], picked);
    }

    [Fact]
    public void SelectDict_CaseInsensitiveHeaderLookupOverPlainDict()
    {
        // Caller-supplied plain dict (ordinal comparer): the helper must
        // still match by case-insensitive header name per RFC 7230 §3.2.
        var loaded = LoadedRegistry();
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["content-encoding"] = "ZSTD",
            ["codec-zstd-dict"] = ExpectedFixtureDictHash,
        };
        var picked = Compression.SelectZstdDictForResponse(headers, loaded);
        Assert.NotNull(picked);
    }

    [Fact]
    public void SelectDict_ReturnsNullWhenContentEncodingMissing()
    {
        var loaded = LoadedRegistry();
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        Assert.Null(Compression.SelectZstdDictForResponse(headers, loaded));
    }

    [Fact]
    public void SelectDict_ReturnsNullWhenContentEncodingIsGzipOrIdentity()
    {
        var loaded = LoadedRegistry();
        foreach (var enc in new[] { "identity", "gzip", "br", "deflate" })
        {
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Content-Encoding"] = enc,
                // Header is harmlessly present — but the response is not
                // zstd, so we MUST NOT throw and MUST return null.
                ["Codec-Zstd-Dict"] = ExpectedFixtureDictHash,
            };
            Assert.Null(Compression.SelectZstdDictForResponse(headers, loaded));
        }
    }

    [Fact]
    public void SelectDict_ThrowsWhenZstdButNoCodecHeader()
    {
        var loaded = LoadedRegistry();
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Encoding"] = "zstd",
        };
        var ex = Assert.Throws<CodecZstdDictException>(
            () => Compression.SelectZstdDictForResponse(headers, loaded));
        Assert.Contains("Codec-Zstd-Dict", ex.Message);
    }

    [Fact]
    public void SelectDict_ThrowsWhenCodecHeaderIsEmpty()
    {
        var loaded = LoadedRegistry();
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Encoding"] = "zstd",
            ["Codec-Zstd-Dict"] = "",
        };
        Assert.Throws<CodecZstdDictException>(
            () => Compression.SelectZstdDictForResponse(headers, loaded));
    }

    [Theory]
    [InlineData("not-a-hash")]
    [InlineData("md5:abc")]
    [InlineData("sha256:tooshort")]
    // 63 hex chars (one short):
    [InlineData("sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891d")]
    // 65 hex chars (one over):
    [InlineData("sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891dbb")]
    public void SelectDict_ThrowsOnMalformedHeader(string declared)
    {
        var loaded = LoadedRegistry();
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Encoding"] = "zstd",
            ["Codec-Zstd-Dict"] = declared,
        };
        Assert.Throws<CodecZstdDictException>(
            () => Compression.SelectZstdDictForResponse(headers, loaded));
    }

    [Fact]
    public void SelectDict_ThrowsOnUnknownHash()
    {
        var loaded = LoadedRegistry();
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Encoding"] = "zstd",
            ["Codec-Zstd-Dict"] = "sha256:" + new string('a', 64),
        };
        var ex = Assert.Throws<CodecZstdDictException>(
            () => Compression.SelectZstdDictForResponse(headers, loaded));
        Assert.Contains("isn't loaded locally", ex.Message);
    }

    [Fact]
    public void SelectDict_HeaderValueIsTrimmedBeforeMatch()
    {
        var loaded = LoadedRegistry();
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Encoding"] = "  zstd  ",
            ["Codec-Zstd-Dict"] = "  " + ExpectedFixtureDictHash + "  ",
        };
        var picked = Compression.SelectZstdDictForResponse(headers, loaded);
        Assert.NotNull(picked);
    }

    // ── ZstdDictDiscovery (v0.5+) ─────────────────────────────────────────

    [Fact]
    public void WellKnownDictUrl_StripsSha256Prefix()
    {
        var h = new string('a', 64);
        Assert.Equal(
            $"https://codec.example/.well-known/codec/dicts/{h}.zstd",
            ZstdDictDiscovery.WellKnownDictUrl("https://codec.example", $"sha256:{h}"));
    }

    [Fact]
    public void WellKnownDictUrl_AcceptsBareHex()
    {
        var h = new string('b', 64);
        Assert.Equal(
            $"https://codec.example/.well-known/codec/dicts/{h}.zstd",
            ZstdDictDiscovery.WellKnownDictUrl("https://codec.example", h));
    }

    [Fact]
    public void WellKnownDictUrl_StripsTrailingSlash()
    {
        var h = new string('c', 64);
        Assert.Equal(
            $"https://codec.example/.well-known/codec/dicts/{h}.zstd",
            ZstdDictDiscovery.WellKnownDictUrl("https://codec.example/", h));
    }

    [Fact]
    public void WellKnownDictUrl_NormalisesUppercaseHex()
    {
        var upper = new string('D', 64);
        var expected = new string('d', 64);
        Assert.Equal(
            $"https://codec.example/.well-known/codec/dicts/{expected}.zstd",
            ZstdDictDiscovery.WellKnownDictUrl("https://codec.example", upper));
    }

    [Fact]
    public void WellKnownDictUrl_RejectsShortHash()
    {
        Assert.Throws<ZstdDictDiscoveryException>(() =>
            ZstdDictDiscovery.WellKnownDictUrl("https://codec.example", "deadbeef"));
    }

    [Fact]
    public void WellKnownDictUrl_RejectsWrongAlgorithm()
    {
        Assert.Throws<ZstdDictDiscoveryException>(() =>
            ZstdDictDiscovery.WellKnownDictUrl("https://codec.example", "md5:" + new string('a', 32)));
    }

    [Fact]
    public void WellKnownDictUrl_RejectsNonHexChars()
    {
        Assert.Throws<ZstdDictDiscoveryException>(() =>
            ZstdDictDiscovery.WellKnownDictUrl("https://codec.example", new string('z', 64)));
    }
}
