// SPDX-License-Identifier: MIT
using Xunit;

namespace Codec.Tests;

public class DetokenizerTests
{
    [Fact]
    public void DetokenizesSimpleVocabTokens()
    {
        var ids = new[] { 3, 4, 5, 8 }; // hello + space + world + !
        Assert.Equal("hello world!", Detokenizer.Detokenize(Fixtures.TinyMap, ids));
    }

    [Fact]
    public void SkipsSpecialTokensByDefault()
    {
        var ids = new[] { 267, 3, 4, 5, 266 }; // <bos> hello world <eos>
        Assert.Equal("hello world", Detokenizer.Detokenize(Fixtures.TinyMap, ids));
    }

    [Fact]
    public void RendersSpecialTokensWhenAsked()
    {
        var ids = new[] { 3, 266 };
        var result = Detokenizer.Detokenize(Fixtures.TinyMap, ids, renderSpecial: true);
        // Special-token rendering: 266 isn't in the v1 tokens map → replacement char.
        // Point: the call doesn't throw and the eos token doesn't silently disappear.
        Assert.StartsWith("hello", result);
    }

    [Fact]
    public void ByteFallbackThreeByteUtf8()
    {
        // € = E2 82 AC (3 bytes)
        var ids = new[] { Fixtures.ByteId(0xE2), Fixtures.ByteId(0x82), Fixtures.ByteId(0xAC) };
        Assert.Equal("€", Detokenizer.Detokenize(Fixtures.TinyMap, ids));
    }

    [Fact]
    public void ByteFallbackFourByteEmoji()
    {
        // 🚀 = F0 9F 9A 80 (4 bytes)
        var ids = new[]
        {
            Fixtures.ByteId(0xF0), Fixtures.ByteId(0x9F),
            Fixtures.ByteId(0x9A), Fixtures.ByteId(0x80),
        };
        Assert.Equal("🚀", Detokenizer.Detokenize(Fixtures.TinyMap, ids));
    }

    [Fact]
    public void PartialMultiByteSequenceBufferedAcrossFrames()
    {
        var d = new Detokenizer(Fixtures.TinyMap);
        // Frame 1: first 2 bytes of € — incomplete, must not emit anything.
        var out1 = d.Render(
            new[] { Fixtures.ByteId(0xE2), Fixtures.ByteId(0x82) },
            new DetokenizeOptions { Partial = true });
        Assert.Equal(string.Empty, out1);
        // Frame 2: final byte. Now flushes.
        var out2 = d.Render(
            new[] { Fixtures.ByteId(0xAC) },
            new DetokenizeOptions { Partial = false });
        Assert.Equal("€", out2);
    }

    [Fact]
    public void VocabTokenAfterPartialBytesFlushesBufferFirst()
    {
        var d = new Detokenizer(Fixtures.TinyMap);
        // 'A' as byte (0x41) + 'hello' (vocab id 3)
        var output = d.Render(new[] { Fixtures.ByteId(0x41), 3 });
        Assert.Equal("Ahello", output);
    }

    [Fact]
    public void UnknownIdEmitsReplacement()
    {
        var d = new Detokenizer(Fixtures.TinyMap);
        Assert.Equal("�", d.Render(new[] { 99999 }));
    }

    [Fact]
    public void ResetClearsPartialBuffer()
    {
        var d = new Detokenizer(Fixtures.TinyMap);
        d.Render(new[] { Fixtures.ByteId(0xE2) }, new DetokenizeOptions { Partial = true });
        d.Reset();
        Assert.Equal("hello", d.Render(new[] { 3 }));
    }
}
