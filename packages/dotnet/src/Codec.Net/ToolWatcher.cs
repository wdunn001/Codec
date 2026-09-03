// SPDX-License-Identifier: MIT
//
// Tool-call / region watcher.
//
// Mirrors libcodec's codec_tool_watcher and @codecai/web's ToolWatcher:
// same state-machine semantics. Detects delimited regions (tool calls,
// reasoning blocks, vision spans, sandbox regions, channel headers) in
// a token-ID stream without ever decoding. The hot loop is a uint
// compare against two cached IDs; no vocab read, no detokenize call,
// no string allocation.
//
// State survives across Feed() calls: a region split between network
// frames buffers internally until the end marker arrives. Feed() has no
// way to know the stream is over, so call End() once you know no more
// tokens are coming (e.g. right after a frame whose Done is true).
//
// Known limitation, not yet handled: a single (StartId, EndId) pair
// assumes the start marker is exclusive to tool calls. Formats where the
// same start marker opens every assistant message and a closing token
// decides after the fact whether it was a tool call (gpt-oss harmony:
// <|start|> 200006 opens every message; <|call|> 200012 confirms,
// <|end|> 200007 / <|return|> 200002 reject) need a set of closing
// tokens with different outcomes, not one EndId. See the "Known
// limitation" paragraph on codec_tool_watcher in
// packages/c/include/codec/codec.h for the full writeup and the
// reasoning for why this is additive to the event kinds below, not a
// rewrite of them.
using System;
using System.Collections.Generic;

namespace Codec;

/// <summary>Kind of event emitted by <see cref="ToolWatcher.Feed(System.Collections.Generic.IReadOnlyList{uint})"/> / <see cref="ToolWatcher.End"/>.</summary>
public enum WatcherEventKind
{
    /// <summary>Token IDs outside any watched region. Forward as-is.</summary>
    Passthrough = 0,

    /// <summary>A complete start..end region with markers excluded.</summary>
    Region = 1,

    /// <summary>Emitted only by <see cref="ToolWatcher.End"/>, when the stream finished while still inside a region.</summary>
    Truncated = 2,

    /// <summary>The region buffer hit its configured cap.</summary>
    Overflow = 3,

    /// <summary>A start marker was seen while already inside a region.</summary>
    NestedStart = 4,
}

/// <summary>One event from <see cref="ToolWatcher.Feed(System.Collections.Generic.IReadOnlyList{uint})"/> / <see cref="ToolWatcher.End"/>.</summary>
/// <remarks>
/// <see cref="Ids"/> is always a fresh array: safe to retain across
/// subsequent Feed calls. The C version returns pointers aliasing the
/// watcher's internal buffer instead: .NET callers don't have to
/// copy out before continuing the read loop.
/// </remarks>
public readonly struct WatcherEvent
{
    public readonly WatcherEventKind Kind;
    public readonly IReadOnlyList<uint> Ids;

    /// <summary>
    /// Set only on <see cref="WatcherEventKind.Truncated"/>, and only
    /// when the caller passed one to <see cref="ToolWatcher.End"/>. Null
    /// otherwise.
    /// </summary>
    public readonly string? FinishReason;

    public WatcherEvent(WatcherEventKind kind, IReadOnlyList<uint> ids, string? finishReason = null)
    {
        Kind = kind;
        Ids = ids;
        FinishReason = finishReason;
    }
}

/// <summary>Raised when a named special token isn't in the map.</summary>
public sealed class ToolWatcherException : Exception
{
    public ToolWatcherException(string message) : base(message) { }
}

/// <summary>
/// Stateful watcher for delimited regions in a token-ID stream.
/// Construct with a map and the names of the start/end specials. The
/// watcher resolves them to IDs once and caches them: no further map
/// access happens during <see cref="Feed(System.Collections.Generic.IReadOnlyList{uint})"/>.
/// </summary>
/// <example>
/// <code>
/// var watcher = new ToolWatcher(map, "&lt;tool_call&gt;", "&lt;/tool_call&gt;");
/// await foreach (var frame in StreamDecoder.DecodeMsgpack(body))
/// {
///     foreach (var ev in watcher.Feed(frame.Ids))
///     {
///         if (ev.Kind == WatcherEventKind.Passthrough)
///             ForwardCodecFrame(nextAgent, ev.Ids);   // no decode
///         else if (ev.Kind == WatcherEventKind.Region)
///             DispatchTool(JsonDocument.Parse(detok.Render(ev.Ids)));
///     }
///     if (frame.Done)
///     {
///         // Feed() cannot know the stream is over. Call this once, after
///         // the last Feed(), even (especially) when the model hit its
///         // length limit mid tool-call:
///         foreach (var ev in watcher.End(frame.FinishReason)) { /* ... */ }
///     }
/// }
/// </code>
/// </example>
public sealed class ToolWatcher
{
    /// <summary>
    /// Default cap on the number of token IDs buffered inside one open
    /// region. 65536 tokens is comfortably above any real tool-call
    /// payload while still bounding worst-case per-watcher memory
    /// against a client that can make the model emit a start marker
    /// without a matching end marker.
    /// </summary>
    public const int DefaultRegionCap = 65536;

    public uint StartId { get; }
    public uint EndId { get; }
    public string StartName { get; }
    public string EndName { get; }

    private bool _inside;
    /// <summary>
    /// True once the in-progress region has hit RegionCap and emitted its
    /// Overflow event. While set, body tokens are dropped (not buffered,
    /// not re-reported) until the end marker closes the region.
    /// </summary>
    private bool _capped;
    private int _regionCap;
    /// <summary>Captured region body: accumulates while Inside, cleared once the region closes.</summary>
    private readonly List<uint> _region = new();

    public ToolWatcher(TokenizerMap map, string startName, string endName, int regionCap = DefaultRegionCap)
    {
        if (map is null) throw new ArgumentNullException(nameof(map));
        if (startName is null) throw new ArgumentNullException(nameof(startName));
        if (endName is null) throw new ArgumentNullException(nameof(endName));

        var specials = map.SpecialTokens;
        if (specials is null || !specials.TryGetValue(startName, out int startId))
            throw new ToolWatcherException(
                $"special token \"{startName}\" not in map.special_tokens");
        if (!specials.TryGetValue(endName, out int endId))
            throw new ToolWatcherException(
                $"special token \"{endName}\" not in map.special_tokens");

        StartId   = (uint)startId;
        EndId     = (uint)endId;
        StartName = startName;
        EndName   = endName;
        _regionCap = regionCap > 0 ? regionCap : DefaultRegionCap;
    }

    /// <summary>True while a region is open (start seen, end not yet).</summary>
    public bool Inside => _inside;

    /// <summary>Cap on the number of token IDs buffered inside one open region.</summary>
    public int RegionCap => _regionCap;

    /// <summary>Change the region cap. 0 resets to <see cref="DefaultRegionCap"/>.</summary>
    public void SetRegionCap(int cap)
    {
        _regionCap = cap > 0 ? cap : DefaultRegionCap;
    }

    /// <summary>
    /// Drop any in-flight region buffer. Call between conversations so a
    /// leftover unclosed region from session N doesn't spill into N+1.
    /// </summary>
    public void Reset()
    {
        _inside = false;
        _capped = false;
        _region.Clear();
    }

    /// <summary>Feed a chunk of token IDs and receive a flat list of events, in stream order.</summary>
    public IReadOnlyList<WatcherEvent> Feed(IReadOnlyList<uint> ids)
    {
        if (ids is null) throw new ArgumentNullException(nameof(ids));
        var events = new List<WatcherEvent>();
        int n = ids.Count;
        int ptStart = 0;

        // Single-pass scan. Identical state machine to the C and TS
        // implementations: keep them in sync if you change one.
        for (int i = 0; i < n; i++)
        {
            uint id = ids[i];
            if (!_inside)
            {
                if (id == StartId)
                {
                    if (i > ptStart)
                    {
                        events.Add(new WatcherEvent(
                            WatcherEventKind.Passthrough,
                            CopySlice(ids, ptStart, i)));
                    }
                    _inside = true;
                    _capped = false;
                    _region.Clear();
                    // ptStart re-anchors when the region closes.
                }
                // else: token continues passthrough run; no action.
            }
            else
            {
                if (id == EndId)
                {
                    // Region complete. Skipped when the region already
                    // overflowed: that was reported once, already, at
                    // the moment the cap was hit.
                    if (!_capped)
                    {
                        events.Add(new WatcherEvent(
                            WatcherEventKind.Region,
                            _region.ToArray()));
                    }
                    _region.Clear();
                    _inside = false;
                    _capped = false;
                    ptStart = i + 1;
                }
                else if (id == StartId)
                {
                    // Nested start: dropped from the region body, then
                        // reported so it is not silently swallowed. Most
                        // models don't nest these markers. Treating an
                        // inner start as a new region would silently drop
                        // the outer content.
                    events.Add(new WatcherEvent(
                        WatcherEventKind.NestedStart, new[] { id }));
                }
                else if (_capped)
                {
                    // Already reported Overflow for this region. Keep
                    // scanning for the end marker without buffering:
                    // memory stays bounded.
                }
                else if (_region.Count >= _regionCap)
                {
                    // Cap hit on this token. Report what's buffered so
                    // far, then stop growing: do not silently truncate.
                    // Deliberately does NOT clear _region: if the stream
                    // then ends without an end marker, End() reports the
                    // same capped content as Truncated (overflow and
                    // truncation are orthogonal signals; a region can be
                    // both). The end-marker path above clears it once
                    // the region actually closes.
                    events.Add(new WatcherEvent(
                        WatcherEventKind.Overflow, _region.ToArray()));
                    _capped = true;
                }
                else
                {
                    _region.Add(id);
                }
            }
        }

        if (!_inside && ptStart < n)
        {
            events.Add(new WatcherEvent(
                WatcherEventKind.Passthrough,
                CopySlice(ids, ptStart, n)));
        }

        return events;
    }

    /// <summary>Convenience: feed an int[] (the wire frame's natural type).</summary>
    public IReadOnlyList<WatcherEvent> Feed(IReadOnlyList<int> ids)
    {
        if (ids is null) throw new ArgumentNullException(nameof(ids));
        var copy = new uint[ids.Count];
        for (int i = 0; i < ids.Count; i++) copy[i] = (uint)ids[i];
        return Feed(copy);
    }

    /// <summary>
    /// Signal end of stream. Feed() has no way to know the stream is
    /// over, so call this once you know no more tokens are coming.
    ///
    /// If a region is currently open, returns a single Truncated event
    /// carrying whatever was buffered (possibly empty) and
    /// <paramref name="finishReason"/>, so the caller can tell "the
    /// model hit its length limit mid tool-call" (finishReason ==
    /// "length") apart from a malformed emission on its own. Returns an
    /// empty list when not inside a region: calling End() on a cleanly
    /// finished stream is a no-op.
    /// </summary>
    public IReadOnlyList<WatcherEvent> End(string? finishReason = null)
    {
        if (!_inside) return Array.Empty<WatcherEvent>();
        var ids = _region.ToArray();
        _region.Clear();
        _inside = false;
        _capped = false;
        return new[] { new WatcherEvent(WatcherEventKind.Truncated, ids, finishReason) };
    }

    private static uint[] CopySlice(IReadOnlyList<uint> src, int from, int to)
    {
        var slice = new uint[to - from];
        for (int i = 0; i < slice.Length; i++) slice[i] = src[from + i];
        return slice;
    }
}
