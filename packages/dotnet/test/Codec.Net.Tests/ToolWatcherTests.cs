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

    // ── Ordering: interleaved events in stream order (defect 3) ──────────────
    //
    // [a, S, X, E, b, S, Y, E, c] must produce five ORDERED events:
    // passthrough(a) / region(X) / passthrough(b) / region(Y) / passthrough(c).
    // This is the exact shape every language's watcher must agree on.

    [Fact]
    public void OrderingMatchesDefect3Example()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        const uint a = 0, b = 1, c = 2, x = 3, y = 4; // hello, world, !, foo, bar
        var evs = w.Feed(new uint[] { a, START, x, END, b, START, y, END, c });
        Assert.Equal(5, evs.Count);
        Assert.Equal(WatcherEventKind.Passthrough, evs[0].Kind);
        Assert.Equal(new uint[] { a }, evs[0].Ids);
        Assert.Equal(WatcherEventKind.Region, evs[1].Kind);
        Assert.Equal(new uint[] { x }, evs[1].Ids);
        Assert.Equal(WatcherEventKind.Passthrough, evs[2].Kind);
        Assert.Equal(new uint[] { b }, evs[2].Ids);
        Assert.Equal(WatcherEventKind.Region, evs[3].Kind);
        Assert.Equal(new uint[] { y }, evs[3].Ids);
        Assert.Equal(WatcherEventKind.Passthrough, evs[4].Kind);
        Assert.Equal(new uint[] { c }, evs[4].Ids);
    }

    // ── Nested start markers (defect 5) ───────────────────────────────────────

    [Fact]
    public void NestedStartIsDroppedFromBodyButObservable()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        // S 0 S 1 E 2 -> NestedStart / Region([0,1]) / Passthrough([2])
        var evs = w.Feed(new uint[] { START, 0, START, 1, END, 2 });
        Assert.Equal(3, evs.Count);
        Assert.Equal(WatcherEventKind.NestedStart, evs[0].Kind);
        Assert.Equal(new uint[] { START }, evs[0].Ids);
        Assert.Equal(WatcherEventKind.Region, evs[1].Kind);
        Assert.Equal(new uint[] { 0, 1 }, evs[1].Ids);
        Assert.Equal(WatcherEventKind.Passthrough, evs[2].Kind);
        Assert.Equal(new uint[] { 2 }, evs[2].Ids);
    }

    // ── Truncation: End() while inside a region (defect 1) ────────────────────
    //
    // An unterminated region (stream ends mid tool-call, e.g. the model hit
    // its length limit) used to be silently dropped: no event, no signal,
    // indistinguishable from a model that never called a tool. End() must
    // report it, carrying the finish reason so a length stop is
    // distinguishable from a malformed emission.

    [Fact]
    public void EndEmitsTruncatedWithFinishReason()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        var evs = w.Feed(new uint[] { 0, START, 3, 4 });
        Assert.Single(evs);
        Assert.Equal(WatcherEventKind.Passthrough, evs[0].Kind);
        Assert.True(w.Inside);

        evs = w.End("length");
        Assert.Single(evs);
        Assert.Equal(WatcherEventKind.Truncated, evs[0].Kind);
        Assert.Equal(new uint[] { 3, 4 }, evs[0].Ids);
        Assert.Equal("length", evs[0].FinishReason);
        Assert.False(w.Inside);

        // A second End() call is a no-op: nothing left in flight.
        Assert.Empty(w.End("length"));
    }

    [Fact]
    public void EndReportsEmptyBodyWhenStreamEndsRightAfterStart()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        w.Feed(new uint[] { START });
        Assert.True(w.Inside);

        var evs = w.End(); // no finish reason known
        Assert.Single(evs);
        Assert.Equal(WatcherEventKind.Truncated, evs[0].Kind);
        Assert.Empty(evs[0].Ids);
        Assert.Null(evs[0].FinishReason);
    }

    [Fact]
    public void EndOutsideRegionEmitsNothing()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        w.Feed(new uint[] { START, 3, END, 4 });
        Assert.False(w.Inside);
        Assert.Empty(w.End("stop"));
    }

    // ── Overflow: region buffer cap (defect 2) ─────────────────────────────────
    //
    // The region buffer used to grow without bound: a client that can make
    // the model emit a start marker without a matching end marker could
    // grow it to the entire remaining generation. The cap must be enforced
    // and the overflow must be a defined, observable event, not a silent
    // truncation.

    [Fact]
    public void RegionCapDefaultsAndIsSettable()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>");
        Assert.Equal(ToolWatcher.DefaultRegionCap, w.RegionCap);

        w.SetRegionCap(3);
        Assert.Equal(3, w.RegionCap);

        // 0 resets to the default rather than becoming an unusable cap.
        w.SetRegionCap(0);
        Assert.Equal(ToolWatcher.DefaultRegionCap, w.RegionCap);

        var w2 = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>", regionCap: 3);
        Assert.Equal(3, w2.RegionCap);
    }

    [Fact]
    public void OverflowFiresOnceAtCapThenResyncsOnEndMarker()
    {
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>", regionCap: 3);
        // Region body is 5 tokens long against a cap of 3: must overflow
        // once, with exactly the first 3 tokens, and must NOT also emit a
        // region event for the same region when the end marker eventually
        // arrives.
        var evs = w.Feed(new uint[] { START, 1, 2, 3, 4, 5, END, 9 });
        Assert.Equal(2, evs.Count);
        Assert.Equal(WatcherEventKind.Overflow, evs[0].Kind);
        Assert.Equal(new uint[] { 1, 2, 3 }, evs[0].Ids);
        Assert.Equal(WatcherEventKind.Passthrough, evs[1].Kind);
        Assert.Equal(new uint[] { 9 }, evs[1].Ids);
        Assert.False(w.Inside);
    }

    [Fact]
    public void OverflowThenTruncatedReportsBoth()
    {
        // A region that overflows and then never sees an end marker must
        // report BOTH: the overflow (memory bound hit) and the
        // truncation (stream ended without a close). They are orthogonal
        // signals.
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>", regionCap: 2);
        var evs = w.Feed(new uint[] { START, 1, 2, 3, 4 });
        Assert.Single(evs);
        Assert.Equal(WatcherEventKind.Overflow, evs[0].Kind);
        Assert.Equal(new uint[] { 1, 2 }, evs[0].Ids);

        evs = w.End("length");
        Assert.Single(evs);
        Assert.Equal(WatcherEventKind.Truncated, evs[0].Kind);
        Assert.Equal(new uint[] { 1, 2 }, evs[0].Ids);
        Assert.Equal("length", evs[0].FinishReason);
    }

    [Fact]
    public void ExactCapDoesNotOverflow()
    {
        // Off-by-one check: a region whose body is exactly `cap` tokens
        // must close cleanly as Region, not as Overflow.
        var w = new ToolWatcher(SynthMap(), "<tool_call>", "</tool_call>", regionCap: 3);
        var evs = w.Feed(new uint[] { START, 1, 2, 3, END });
        Assert.Single(evs);
        Assert.Equal(WatcherEventKind.Region, evs[0].Kind);
        Assert.Equal(new uint[] { 1, 2, 3 }, evs[0].Ids);
    }
}
