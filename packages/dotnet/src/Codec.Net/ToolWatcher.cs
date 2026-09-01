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
// frames buffers internally until the end marker arrives.
using System;
using System.Collections.Generic;

namespace Codec;

/// <summary>Kind of event emitted by <see cref="ToolWatcher.Feed(System.Collections.Generic.IReadOnlyList{uint})"/>.</summary>
public enum WatcherEventKind
{
    /// <summary>Token IDs outside any watched region. Forward as-is.</summary>
    Passthrough = 0,

    /// <summary>A complete start..end region with markers excluded.</summary>
    Region = 1,
}

/// <summary>One event from <see cref="ToolWatcher.Feed(System.Collections.Generic.IReadOnlyList{uint})"/>.</summary>
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

    public WatcherEvent(WatcherEventKind kind, IReadOnlyList<uint> ids)
    {
        Kind = kind;
        Ids = ids;
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
///         else
///             DispatchTool(JsonDocument.Parse(detok.Render(ev.Ids)));
///     }
/// }
/// </code>
/// </example>
public sealed class ToolWatcher
{
    public uint StartId { get; }
    public uint EndId { get; }
    public string StartName { get; }
    public string EndName { get; }

    private bool _inside;
    /// <summary>Captured region body: accumulates while Inside, cleared on Region emit.</summary>
    private readonly List<uint> _region = new();

    public ToolWatcher(TokenizerMap map, string startName, string endName)
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
    }

    /// <summary>True while a region is open (start seen, end not yet).</summary>
    public bool Inside => _inside;

    /// <summary>
    /// Drop any in-flight region buffer. Call between conversations so a
    /// leftover unclosed region from session N doesn't spill into N+1.
    /// </summary>
    public void Reset()
    {
        _inside = false;
        _region.Clear();
    }

    /// <summary>Feed a chunk of token IDs and receive a flat list of events.</summary>
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
                    _region.Clear();
                    // ptStart re-anchors when the region closes.
                }
                // else: token continues passthrough run; no action.
            }
            else
            {
                if (id == EndId)
                {
                    // Emit a snapshot of the region body. The internal list
                    // gets cleared and reused for the next region.
                    events.Add(new WatcherEvent(
                        WatcherEventKind.Region,
                        _region.ToArray()));
                    _region.Clear();
                    _inside = false;
                    ptStart = i + 1;
                }
                else if (id == StartId)
                {
                    // Nested start: ignore. Most models don't nest these
                    // markers. Treating an inner start as a new region
                    // would silently drop the outer content.
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

    private static uint[] CopySlice(IReadOnlyList<uint> src, int from, int to)
    {
        var slice = new uint[to - from];
        for (int i = 0; i < slice.Length; i++) slice[i] = src[from + i];
        return slice;
    }
}
