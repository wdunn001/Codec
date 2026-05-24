// SPDX-License-Identifier: MIT
//
// PickerTests.cs — unit tests for Codec.Wire.Picker.
//
// Hand-curated cases that mirror packages/wire-compress/test/picker.test.ts.
// The cross-language conformance suite lives in PickerConformanceTests.cs
// (replays the shared JSON vector set against this port and asserts
// byte-for-byte parity with the TS reference).

using System;
using Codec.Wire;
using Xunit;

namespace Codec.Net.Tests;

public class PickerTests
{
    // ── parseAcceptEncoding ─────────────────────────────────────────────────

    [Fact]
    public void ParseAcceptEncoding_NullHeader_ReturnsUnspecifiedIdentityOnly()
    {
        var r = Picker.ParseAcceptEncoding(null);
        Assert.True(r.Unspecified);
        Assert.Single(r.Accepted);
        Assert.Equal(Codec.Wire.Encoding.Identity, r.Accepted[0]);
    }

    [Fact]
    public void ParseAcceptEncoding_OrdersByQValueDesc()
    {
        var r = Picker.ParseAcceptEncoding("br;q=0.5, gzip;q=1.0, zstd;q=0.8");
        // gzip > zstd > br > identity (identity always implicit).
        Assert.Equal(new[]
        {
            Codec.Wire.Encoding.Gzip,
            Codec.Wire.Encoding.Zstd,
            Codec.Wire.Encoding.Br,
            Codec.Wire.Encoding.Identity,
        }, r.Accepted);
    }

    [Fact]
    public void ParseAcceptEncoding_DropsQZeroEntries()
    {
        var r = Picker.ParseAcceptEncoding("gzip;q=0, zstd;q=1.0");
        Assert.Contains(Codec.Wire.Encoding.Zstd, r.Accepted);
        Assert.DoesNotContain(Codec.Wire.Encoding.Gzip, r.Accepted);
        Assert.Contains(Codec.Wire.Encoding.Identity, r.Accepted);
    }

    [Fact]
    public void ParseAcceptEncoding_RespectsIdentityQZero()
    {
        var r = Picker.ParseAcceptEncoding("gzip, identity;q=0");
        Assert.Contains(Codec.Wire.Encoding.Gzip, r.Accepted);
        Assert.DoesNotContain(Codec.Wire.Encoding.Identity, r.Accepted);
    }

    // ── pick ────────────────────────────────────────────────────────────────

    [Fact]
    public void Pick_DefaultNoGates_ReturnsGzip()
    {
        var r = Picker.Pick(new PickInput
        {
            AcceptEncoding = "zstd, gzip, br",
            EstimatedSize = 1024,
        });
        Assert.Equal(Codec.Wire.Encoding.Gzip, r.Encoding);
        Assert.Equal(PickReasonCode.GzipNoDict, r.ReasonCode);
    }

    [Fact]
    public void Pick_BothGatesOpen_ReturnsZstd()
    {
        var r = Picker.Pick(new PickInput
        {
            AcceptEncoding = "zstd, gzip, br",
            EstimatedSize = 1024,
            ZstdHasDict = true,
        });
        Assert.Equal(Codec.Wire.Encoding.Zstd, r.Encoding);
        Assert.Equal(PickReasonCode.DictZstdDefault, r.ReasonCode);
    }

    [Fact]
    public void Pick_DictButMiddlewareDisabled_ReturnsGzip()
    {
        var r = Picker.Pick(new PickInput
        {
            AcceptEncoding = "zstd, gzip, br",
            EstimatedSize = 1024,
            ZstdHasDict = true,
            ZstdEnabled = false,
        });
        Assert.Equal(Codec.Wire.Encoding.Gzip, r.Encoding);
        Assert.Equal(PickReasonCode.GzipMiddlewareDisabled, r.ReasonCode);
    }

    [Fact]
    public void Pick_ZstdOnlyClientNoDict_ReturnsIdentity()
    {
        // Server has no dict; client only advertises zstd. Per spec, refuse
        // to pick zstd (TTFT cliff + zero byte advantage) and fall back to
        // identity since gzip/br aren't in the candidate set.
        var r = Picker.Pick(new PickInput
        {
            AcceptEncoding = "zstd",
            EstimatedSize = 1024,
        });
        Assert.Equal(Codec.Wire.Encoding.Identity, r.Encoding);
    }

    [Fact]
    public void Pick_BrOnlyClient_ReturnsBr()
    {
        var r = Picker.Pick(new PickInput
        {
            AcceptEncoding = "br",
            EstimatedSize = 1024,
        });
        Assert.Equal(Codec.Wire.Encoding.Br, r.Encoding);
        Assert.Equal(PickReasonCode.BrFallbackNoGzip, r.ReasonCode);
    }

    [Fact]
    public void Pick_BrNeverChosenWhenGzipAvailable()
    {
        foreach (var size in new[] { 16, 64, 128, 256, 512, 2048 })
        {
            var r = Picker.Pick(new PickInput
            {
                AcceptEncoding = "gzip, br",
                EstimatedSize = size,
            });
            Assert.NotEqual(Codec.Wire.Encoding.Br, r.Encoding);
        }
    }

    [Fact]
    public void Pick_LowEntropySample_PrefersBrOverZstd()
    {
        var sample = new byte[256];
        Array.Fill(sample, (byte)0x41);
        var r = Picker.Pick(new PickInput
        {
            AcceptEncoding = "zstd, gzip, br",
            EstimatedSize = 1024,
            ZstdHasDict = true,
            SampleBytes = sample,
        });
        Assert.Equal(Codec.Wire.Encoding.Br, r.Encoding);
        Assert.Equal(PickReasonCode.BrContentSampleLowEntropy, r.ReasonCode);
    }

    [Fact]
    public void Pick_HighEntropySample_KeepsZstd()
    {
        var sample = new byte[256];
        for (int i = 0; i < sample.Length; i++) sample[i] = (byte)((i * 31 + 17) & 0xff);
        var r = Picker.Pick(new PickInput
        {
            AcceptEncoding = "zstd, gzip, br",
            EstimatedSize = 1024,
            ZstdHasDict = true,
            SampleBytes = sample,
        });
        Assert.Equal(Codec.Wire.Encoding.Zstd, r.Encoding);
        Assert.Equal(PickReasonCode.DictZstdDefault, r.ReasonCode);
    }

    [Fact]
    public void Pick_PerStackBufferedZstd_DropsZstd()
    {
        var bufferedStack = new StackProfile("custom-buffered-zstd",
            new System.Collections.Generic.Dictionary<Codec.Wire.Encoding, EncodingChars>
            {
                [Codec.Wire.Encoding.Gzip] = new(0.05, 1.0),
                [Codec.Wire.Encoding.Br] = new(0.5, 1.0),
                [Codec.Wire.Encoding.Zstd] = new(0.05, PickerConstants.MaxTtftRatio + 100.0),
            });
        var r = Picker.Pick(new PickInput
        {
            AcceptEncoding = "zstd, gzip, br",
            EstimatedSize = 1024,
            ZstdHasDict = true,
            StackProfile = bufferedStack,
        });
        Assert.Equal(Codec.Wire.Encoding.Gzip, r.Encoding);
        Assert.Equal(PickReasonCode.PerStackOverrodeZstd, r.ReasonCode);
    }

    // ── buildAcceptEncoding ─────────────────────────────────────────────────

    [Fact]
    public void BuildAcceptEncoding_DefaultOmitsZstd()
    {
        Assert.Equal("gzip;q=1.0, br;q=0.5", Picker.BuildAcceptEncoding());
    }

    [Fact]
    public void BuildAcceptEncoding_ZstdOptIn()
    {
        Assert.Equal("gzip;q=1.0, br;q=0.5, zstd;q=0.3",
            Picker.BuildAcceptEncoding(zstd: true));
    }

    // ── shannonEntropy ──────────────────────────────────────────────────────

    [Fact]
    public void ShannonEntropy_AllZeroBytes_IsZero()
    {
        var bytes = new byte[100];
        Assert.Equal(0.0, Picker.ShannonEntropyBitsPerByte(bytes));
    }

    [Fact]
    public void ShannonEntropy_UniformDistribution_NearEight()
    {
        var bytes = new byte[256];
        for (int i = 0; i < 256; i++) bytes[i] = (byte)i;
        double e = Picker.ShannonEntropyBitsPerByte(bytes);
        Assert.True(e > 7.5 && e <= 8.0, $"expected ~8, got {e}");
    }

    [Fact]
    public void ShannonEntropy_Empty_IsZero()
    {
        Assert.Equal(0.0, Picker.ShannonEntropyBitsPerByte(ReadOnlySpan<byte>.Empty));
    }
}
