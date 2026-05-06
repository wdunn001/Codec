// SPDX-License-Identifier: MIT
namespace Codec.Tests;

internal static class Fixtures
{
    /// <summary>
    /// Tiny synthetic v1-style map for exercising Detokenizer + LongestMatch
    /// without pulling in a real model. Mirrors packages/web/test/fixtures.ts.
    /// </summary>
    public static readonly TokenizerMap TinyMap = new()
    {
        Id = "test-tiny-v1",
        Version = "1.0.0",
        VocabSize = 270,
        Tokens = new Dictionary<string, string>
        {
            { "0", "�" },          // UNK fallback
            { "1", "h" },
            { "2", "he" },
            { "3", "hello" },
            { "4", " " },
            { "5", "world" },
            { "6", "w" },
            { "7", "wor" },
            { "8", "!" },
            { "9", "\n" },
            // 10-265 reserved for byte-fallback (256 bytes)
        },
        SpecialTokens = new Dictionary<string, int> { { "eos", 266 }, { "bos", 267 } },
        ByteFallbackStart = 10,
        ByteFallbackEnd = 265,
    };

    /// <summary>ID for a raw byte in the byte-fallback range.</summary>
    public static int ByteId(byte b) => TinyMap.ByteFallbackStart!.Value + b;

    /// <summary>
    /// Locate a real Qwen-2 map for round-trip testing. Returns null if
    /// the codec-maps repo isn't present (CI may not have it).
    /// </summary>
    public static string? FindQwenMap()
    {
        var candidates = new[]
        {
            @"H:\dev\codec-maps\maps\qwen\qwen2.json",
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "codec-maps", "maps", "qwen", "qwen2.json"),
        };
        foreach (var c in candidates)
            if (File.Exists(c)) return Path.GetFullPath(c);
        return null;
    }
}
