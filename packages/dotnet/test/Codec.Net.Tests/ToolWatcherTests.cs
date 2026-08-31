// SPDX-License-Identifier: MIT
//
// ToolWatcher tests: mirror packages/web/test/tool-watcher.test.ts and
// packages/python/tests/test_tool_watcher.py.
using System;
using System.Collections.Generic;
using Xunit;

namespace Codec.Tests;

public class ToolWatcherTests
{
    private const uint START = 90;
    private const uint END   = 91;

    private static TokenizerMap SynthMap() => new()
    {
        Id = "test/synth",
        Version = "2",
        VocabSize = 100,
        Encoder = "byte_level",
        Vocab = new() { ["hello"] = 0, ["world"] = 1, ["!"] = 2, ["foo"] = 3, ["bar"] = 4 },
        SpecialTokens = new() { ["<tool_call>"] = 90, ["</tool_call>"] = 91 },
    };

    [Fact]
    public void PassthroughThenRegionThenPassthrough()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        // "hello world <tool_call> foo bar </tool_call> hello !"
        var evs = w.Feed(new uint[] { 0, 1, START, 3, 4, END, 0, 2 });
        Assert.Equal(3, evs.Count);

        Assert.Equal(WatcherEventKind.Passthrough, evs[0].Kind);
        Assert.Equal(new uint[] { 0, 1 }, evs[0].Ids);

        Assert.Equal(WatcherEventKind.Region, evs[1].Kind);
        Assert.Equal(new uint[] { 3, 4 }, evs[1].Ids);  // markers excluded

        Assert.Equal(WatcherEventKind.Passthrough, evs[2].Kind);
        Assert.Equal(new uint[] { 0, 2 }, evs[2].Ids);

        Assert.False(w.Inside);
    }

    [Fact]
    public void RegionSplitAcrossFeeds()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");

        // Feed 1: region opens but doesn't close.
        var evs = w.Feed(new uint[] { 0, START, 3 });
        Assert.Single(evs);
        Assert.Equal(WatcherEventKind.Passthrough, evs[0].Kind);
        Assert.Equal(new uint[] { 0 }, evs[0].Ids);
        Assert.True(w.Inside);

        // Feed 2: closes the region with body accumulated across both feeds.
        evs = w.Feed(new uint[] { 4, END, 1 });
        Assert.Equal(2, evs.Count);
        Assert.Equal(WatcherEventKind.Region, evs[0].Kind);
        Assert.Equal(new uint[] { 3, 4 }, evs[0].Ids);
        Assert.Equal(WatcherEventKind.Passthrough, evs[1].Kind);
        Assert.Equal(new uint[] { 1 }, evs[1].Ids);
        Assert.False(w.Inside);
    }

    [Fact]
    public void MultipleRegionsInOneFeed()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        var evs = w.Feed(new uint[] { 0, START, 3, END, 1, START, 4, END, 2 });
        Assert.Equal(5, evs.Count);
        Assert.Equal(WatcherEventKind.Passthrough, evs[0].Kind);
        Assert.Equal(WatcherEventKind.Region,      evs[1].Kind);
        Assert.Equal(new uint[] { 3 }, evs[1].Ids);
        Assert.Equal(WatcherEventKind.Passthrough, evs[2].Kind);
        Assert.Equal(WatcherEventKind.Region,      evs[3].Kind);
        Assert.Equal(new uint[] { 4 }, evs[3].Ids);
        Assert.Equal(WatcherEventKind.Passthrough, evs[4].Kind);
    }

    [Fact]
    public void StrayEndPassesThrough()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        var evs = w.Feed(new uint[] { 0, END, 1 });
        // End with no preceding start: ordinary token.
        Assert.Single(evs);
        Assert.Equal(WatcherEventKind.Passthrough, evs[0].Kind);
        Assert.Equal(new uint[] { 0, END, 1 }, evs[0].Ids);
    }

    [Fact]
    public void MissingSpecialNameThrows()
    {
        Assert.Throws<ToolWatcherException>(
            () => new ToolWatcher(SynthMap(), "<not_real>", "</tool_call>"));
    }

    [Fact]
    public void ResetDropsInFlightRegion()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        w.Feed(new uint[] { START, 3, 4 });
        Assert.True(w.Inside);
        w.Reset();
        Assert.False(w.Inside);
        // End marker now becomes a stray (no buffered body).
        var evs = w.Feed(new uint[] { END, 1 });
        Assert.Single(evs);
        Assert.Equal(WatcherEventKind.Passthrough, evs[0].Kind);
        Assert.Equal(new uint[] { END, 1 }, evs[0].Ids);
    }

    /// <summary>
    /// No-decode contract: mirror of test_watcher_does_not_decode_tokens
    /// in libcodec / @codecai/web / codecai. Use a map with empty vocab
    /// and feed IDs outside any plausible vocab range. The watcher must
    /// emit them verbatim.
    /// </summary>
    [Fact]
    public void NeverDecodesOperatesOnRawIds()
    {
        var noVocab = new TokenizerMap
        {
            Id = "test/no-vocab",
            Version = "2",
            VocabSize = 4,
            Encoder = "byte_level",
            Vocab = new(),
            SpecialTokens = new() { ["<tool_call>"] = 90, ["</tool_call>"] = 91 },
        };
        var w = new ToolWatcher(noVocab, "<tool_call>", "</tool_call>");
        const uint BIG_A = 0xFFFFFF00, BIG_B = 0xDEADBEEF, BIG_C = 0xCAFEBABE;
        var evs = w.Feed(new uint[] { 12345, BIG_A, START, BIG_B, BIG_C, END, 99999 });
        Assert.Equal(3, evs.Count);
        Assert.Equal(new uint[] { 12345, BIG_A }, evs[0].Ids);
        Assert.Equal(new uint[] { BIG_B, BIG_C }, evs[1].Ids);  // body verbatim
        Assert.Equal(new uint[] { 99999 }, evs[2].Ids);
    }

    [Fact]
    public void IntOverloadAcceptsWireFrameType()
    {
        // CodecFrame.Ids is int[]; verify the int overload works.
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        var evs = w.Feed(new int[] { 0, 1, (int)START, 3, (int)END, 2 });
        Assert.Equal(3, evs.Count);
        Assert.Equal(WatcherEventKind.Region, evs[1].Kind);
        Assert.Equal(new uint[] { 3 }, evs[1].Ids);
    }
}
