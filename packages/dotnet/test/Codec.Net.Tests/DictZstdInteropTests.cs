// SPDX-License-Identifier: MIT
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Codec;
using Xunit;
using ZstdSharp;

namespace Codec.Net.Tests;

/// <summary>
/// End-to-end interop test against the shipped cross-client fixture at
/// <c>packages/bench/fixtures/dict-zstd-interop/</c>. Every Codec client
/// (TS, Python, Rust, Java, .NET, C) MUST:
/// <list type="number">
///   <item>hash <c>dict.bin</c> to
///   <c>sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db</c>,</item>
///   <item>decompress <c>compressed.bin</c> using that dict and produce
///   bytes byte-identical to <c>decompressed.bin</c>,</item>
///   <item>msgpack-parse the result into 32 token IDs starting with
///   <c>[53365, 1593, 7552, 57218, 5371, 37, 11278, 43, 9909, 2773]</c>.</item>
/// </list>
/// This proves the dotnet bench would round-trip a real server stream
/// rather than the previous "pass-through" placeholder that fed garbage
/// into MessagePack and threw <c>MessagePackSerializationException</c>.
/// </summary>
public class DictZstdInteropTests
{
    private const string ExpectedDictHash =
        "sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db";

    private static readonly int[] ExpectedFirstTen =
        new[] { 53365, 1593, 7552, 57218, 5371, 37, 11278, 43, 9909, 2773 };

    private const int ExpectedTokenCount = 32;

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

    [Fact]
    public async Task DecompressFixture_RoundTripsByteIdenticalAndYieldsExpectedTokens()
    {
        var dir = FixtureDir();
        var dictBytes = File.ReadAllBytes(Path.Combine(dir, "dict.bin"));
        var compressed = File.ReadAllBytes(Path.Combine(dir, "compressed.bin"));
        var expected = File.ReadAllBytes(Path.Combine(dir, "decompressed.bin"));

        // Step 1: hash matches the manifest. If this fails the bench
        // would refuse to decompress in production (which is correct —
        // never feed mismatched dicts to a decompressor).
        Assert.Equal(ExpectedDictHash, Compression.HashZstdDict(dictBytes));

        // Step 2: simulate what FetchStream sees: a response with
        // Content-Encoding: zstd + Codec-Zstd-Dict: <hash>. Pull the dict
        // through the production helper, exactly like the bench does.
        var loaded = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            [ExpectedDictHash] = dictBytes,
        };
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Encoding"] = "zstd",
            ["Codec-Zstd-Dict"] = ExpectedDictHash,
        };
        var picked = Compression.SelectZstdDictForResponse(headers, loaded);
        Assert.NotNull(picked);

        // Step 3: dict-aware decompression. ZstdSharp.Port mirrors
        // libzstd's ZSTD_DCtx_loadDictionary contract.
        using var dec = new Decompressor();
        dec.LoadDictionary(picked!);
        var actual = dec.Unwrap(compressed).ToArray();

        // Byte-identical against the canonical reference.
        Assert.Equal(expected.Length, actual.Length);
        Assert.Equal(expected, actual);

        // Step 4: msgpack-parse via the same StreamDecoder the bench uses
        // for token counting, and check the token-ID sequence matches
        // the manifest's expected_first_10_ids + expected_token_count.
        using var ms = new MemoryStream(actual);
        var allIds = new List<int>();
        await foreach (var frame in StreamDecoder.DecodeMsgpackStreamAsync(ms))
            allIds.AddRange(frame.Ids);

        Assert.Equal(ExpectedTokenCount, allIds.Count);
        Assert.Equal(ExpectedFirstTen, allIds.Take(10).ToArray());
    }

    [Fact]
    public void WithoutDict_DecompressionFailsOrProducesGarbage()
    {
        // Sanity check that the placeholder behaviour (pass through the
        // compressed bytes, or decompress without the dict) really would
        // have produced garbage — justifying the failure-mode the user
        // hit ("MessagePackSerializationException: Unexpected m..."). We
        // assert that ZstdSharp either throws on no-dict decompression
        // or returns bytes that DON'T match the reference output.
        var dir = FixtureDir();
        var compressed = File.ReadAllBytes(Path.Combine(dir, "compressed.bin"));
        var expected = File.ReadAllBytes(Path.Combine(dir, "decompressed.bin"));

        byte[]? noDictOutput = null;
        try
        {
            using var dec = new Decompressor();
            noDictOutput = dec.Unwrap(compressed).ToArray();
        }
        catch
        {
            // ZstdSharp threw — that is acceptable evidence the dict is
            // required for this stream.
            return;
        }
        // Decompression "succeeded" without a dict: the output MUST
        // differ from the reference, otherwise the dict requirement
        // claim in the spec is wrong.
        Assert.NotEqual(expected, noDictOutput);
    }
}
