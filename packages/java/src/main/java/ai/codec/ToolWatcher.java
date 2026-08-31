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
// State survives across feed() calls: a region split between network
// frames buffers internally until the end marker arrives.
package ai.codec;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Stateful watcher for delimited regions in a token-ID stream.
 * Construct with a map and the names of the start/end specials. The
 * watcher resolves them to IDs once and caches them: no further map
 * access happens during {@link #feed(long[])}.
 *
 * <pre>{@code
 * ToolWatcher watcher = new ToolWatcher(map, "<tool_call>", "</tool_call>");
 * Iterator<CodecFrame> frames = StreamDecoder.decodeMsgpackStream(body);
 * while (frames.hasNext()) {
 *     CodecFrame frame = frames.next();
 *     for (WatcherEvent ev : watcher.feed(frame.ids())) {
 *         if (ev.getKind() == WatcherEventKind.PASSTHROUGH) {
 *             forwardCodecFrame(nextAgent, ev.getIds());   // no decode
 *         } else {
 *             dispatchTool(detok.render(toIntArray(ev.getIds())));
 *         }
 *     }
 * }
 * }</pre>
 */
public final class ToolWatcher {
    private final long startId;
    private final long endId;
    private final String startName;
    private final String endName;

    private boolean inside;
    /** Captured region body: accumulates while inside, cleared on Region emit. */
    private final List<Long> region = new ArrayList<>();

    public ToolWatcher(TokenizerMap map, String startName, String endName) {
        if (map == null) throw new NullPointerException("map");
        if (startName == null) throw new NullPointerException("startName");
        if (endName == null) throw new NullPointerException("endName");

        Map<String, Integer> specials = map.specialTokens;
        if (specials == null || !specials.containsKey(startName))
            throw new ToolWatcherException(
                    "special token \"" + startName + "\" not in map.special_tokens");
        if (!specials.containsKey(endName))
            throw new ToolWatcherException(
                    "special token \"" + endName + "\" not in map.special_tokens");

        this.startId = specials.get(startName) & 0xFFFFFFFFL;
        this.endId = specials.get(endName) & 0xFFFFFFFFL;
        this.startName = startName;
        this.endName = endName;
    }

    public long getStartId() { return startId; }
    public long getEndId() { return endId; }
    public String getStartName() { return startName; }
    public String getEndName() { return endName; }

    /** True while a region is open (start seen, end not yet). */
    public boolean isInside() { return inside; }

    /**
     * Drop any in-flight region buffer. Call between conversations so a
     * leftover unclosed region from session N doesn't spill into N+1.
     */
    public void reset() {
        inside = false;
        region.clear();
    }

    /** Feed a chunk of token IDs (as longs holding uint32 values) and receive a flat list of events. */
    public List<WatcherEvent> feed(long[] ids) {
        if (ids == null) throw new NullPointerException("ids");
        List<WatcherEvent> events = new ArrayList<>();
        int n = ids.length;
        int ptStart = 0;

        // Single-pass scan. Identical state machine to the C and TS
        // implementations: keep them in sync if you change one.
        for (int i = 0; i < n; i++) {
            long id = ids[i];
            if (!inside) {
                if (id == startId) {
                    if (i > ptStart) {
                        events.add(new WatcherEvent(
                                WatcherEventKind.PASSTHROUGH, copySlice(ids, ptStart, i)));
                    }
                    inside = true;
                    region.clear();
                }
            } else {
                if (id == endId) {
                    long[] body = new long[region.size()];
                    for (int j = 0; j < body.length; j++) body[j] = region.get(j);
                    events.add(new WatcherEvent(WatcherEventKind.REGION, body));
                    region.clear();
                    inside = false;
                    ptStart = i + 1;
                } else if (id == startId) {
                    // Nested start: ignore.
                } else {
                    region.add(id);
                }
            }
        }

        if (!inside && ptStart < n) {
            events.add(new WatcherEvent(
                    WatcherEventKind.PASSTHROUGH, copySlice(ids, ptStart, n)));
        }
        return events;
    }

    /** Convenience: feed an int[] (the wire frame's natural type). */
    public List<WatcherEvent> feed(int[] ids) {
        if (ids == null) throw new NullPointerException("ids");
        long[] copy = new long[ids.length];
        for (int i = 0; i < ids.length; i++) copy[i] = ids[i] & 0xFFFFFFFFL;
        return feed(copy);
    }

    private static long[] copySlice(long[] src, int from, int to) {
        long[] slice = new long[to - from];
        System.arraycopy(src, from, slice, 0, slice.length);
        return slice;
    }
}
