// SPDX-License-Identifier: MIT
//
// Translator tests: mirror packages/web/test/translate.test.ts and
// packages/python/tests/test_translate.py.
//
// Real-map tests gate on environment variables (CODEC_MAPS_QWEN +
// CODEC_MAPS_LLAMA3) the same way the other client suites do. Without
// them, only the synthetic empty-input / Reset behavior tests run.
using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;
using Xunit.Sdk;

namespace Codec.Tests;

public class TranslatorTests
{
    private static string? FindMap(string family)
    {
        var filename = family == "qwen" ? "qwen2.json" : "llama-3.json";
        var candidates = new[]
        {
            Path.GetFullPath(Path.Combine(Environment.CurrentDirectory,
                $"../../../../../../codec-maps/maps/{family}/{filename}")),
            Path.GetFullPath(Path.Combine(Environment.CurrentDirectory,
                $"../../../../../../../codec-maps/maps/{family}/{filename}")),
            Environment.GetEnvironmentVariable(
                family == "qwen" ? "CODEC_MAPS_QWEN" : "CODEC_MAPS_LLAMA3") ?? "",
        };
        foreach (var c in candidates)
            if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c;
        return null;
    }

    private static TokenizerMap LoadMap(string path)
    {
        var json = File.ReadAllText(path);
        var m = JsonSerializer.Deserialize<TokenizerMap>(json);
        Assert.NotNull(m);
        return m!;
    }

    // ── Synthetic tests that don't need a real map ─────────────────────────

    [Fact]
    public void EmptyInputReturnsEmptyOutput()
    {
        // Use the existing TinyMap fixture (v1-style, longest-match on both sides).
        var m = Fixtures.TinyMap;
        var tr = new Translator(m, m);
        Assert.Empty(tr.Translate(Array.Empty<int>()));
    }

    [Fact]
    public void ResetClearsTextBuffer()
    {
        var m = Fixtures.TinyMap;
        var tr = new Translator(m, m);
        // Feed something with a partial flag, then reset, then finish: should
        // produce no output (buffer was cleared).
        tr.Translate(new int[] { 3, 4 }, partial: true);  // "hello "
        tr.Reset();
        Assert.Empty(tr.Finish());
    }

    // ── Real Qwen-2 → Qwen-2 identity ──────────────────────────────────────

    [SkippableFact]
    public void IdentityQwen2RoundTrip()
    {
        var path = FindMap("qwen");
        Skip.If(path is null, "qwen2.json not found");
        var m = LoadMap(path!);

        const string text = "The quick brown fox jumps over the lazy dog. 2 + 2 = 4.";
        var srcIds = Tokenize.Pick(m).Encode(text);

        var tr = new Translator(m, m);
        var outIds = tr.Translate(srcIds);
        var rendered = new Detokenizer(m).Render(outIds);
        Assert.Equal(text, rendered);
    }

    [SkippableFact]
    public void StreamingChunksDrainCorrectly()
    {
        var path = FindMap("qwen");
        Skip.If(path is null, "qwen2.json not found");
        var m = LoadMap(path!);

        const string text = "Hello world. This is a streaming test with several words.";
        var srcIds = Tokenize.Pick(m).Encode(text);

        // One-shot reference.
        var oneShot = new Translator(m, m).Translate(srcIds);

        // Streaming: feed 4 IDs at a time with partial=true, then Finish.
        var tr = new Translator(m, m);
        var chunked = new System.Collections.Generic.List<int>();
        for (int off = 0; off < srcIds.Length; off += 4)
        {
            var len = Math.Min(4, srcIds.Length - off);
            var slice = new int[len];
            Array.Copy(srcIds, off, slice, 0, len);
            chunked.AddRange(tr.Translate(slice, partial: true));
        }
        chunked.AddRange(tr.Finish());

        // Both paths must round-trip back to the same text.
        var detokOne = new Detokenizer(m).Render(oneShot);
        var detokStr = new Detokenizer(m).Render(chunked);
        Assert.Equal(text, detokOne);
        Assert.Equal(text, detokStr);
    }

    // ── Real cross-vocab: Qwen-2 → Llama-3 ─────────────────────────────────

    [SkippableFact]
    public void CrossVocabQwen2ToLlama3RoundTrip()
    {
        var qPath = FindMap("qwen");
        var lPath = FindMap("meta-llama");
        Skip.If(qPath is null || lPath is null, "need both qwen2 + llama-3 maps");

        var src = LoadMap(qPath!);
        var dst = LoadMap(lPath!);

        const string text = "The quick brown fox.";
        var srcIds = Tokenize.Pick(src).Encode(text);

        var dstIds = TranslatorExtensions.Translate(src, dst, srcIds);
        var rendered = new Detokenizer(dst).Render(dstIds);
        Assert.Equal(text, rendered);
    }

    // ── Static translation table ───────────────────────────────────────────

    [SkippableFact]
    public void StaticTranslationTableIdentityIncludesSelf()
    {
        var path = FindMap("qwen");
        Skip.If(path is null, "qwen2.json not found");
        var m = LoadMap(path!);

        var table = TranslatorExtensions.StaticTranslationTable(m, m);
        var detok = new Detokenizer(m);

        int sample = 0;
        foreach (var (srcId, dstIds) in table.Take(200))
        {
            var srcText = detok.Render(new[] { srcId });
            detok.Reset();
            var dstText = detok.Render(dstIds);
            detok.Reset();
            if (srcText.Length > 0)
            {
                Assert.Equal(srcText, dstText);
                sample++;
            }
        }
        Assert.True(sample > 0);
    }
}
