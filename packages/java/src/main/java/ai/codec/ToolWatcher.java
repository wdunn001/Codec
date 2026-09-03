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
// frames buffers internally until the end marker arrives. feed() has no
// way to know the stream is over, so call end() once you know no more
// tokens are coming (e.g. right after a frame whose done is true).
//
// Known limitation, not yet handled: a single (startId, endId) pair
// assumes the start marker is exclusive to tool calls. Formats where the
// same start marker opens every assistant message and a closing token
// decides after the fact whether it was a tool call (gpt-oss harmony:
// <|start|> 200006 opens every message; <|call|> 200012 confirms,
// <|end|> 200007 / <|return|> 200002 reject) need a set of closing
// tokens with different outcomes, not one endId. See the "Known
// limitation" paragraph on codec_tool_watcher in
// packages/c/include/codec/codec.h for the full writeup and the
// reasoning for why this is additive to WatcherEventKind, not a rewrite
// of it.
package ai.codec;

import java.util.ArrayList;
import java.util.Collections;
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
 *         } else if (ev.getKind() == WatcherEventKind.REGION) {
 *             dispatchTool(detok.render(toIntArray(ev.getIds())));
 *         }
 *     }
 *     if (frame.done()) {
 *         // feed() cannot know the stream is over. Call this once, after
 *         // the last feed(), even (especially) when the model hit its
 *         // length limit mid tool-call:
 *         watcher.end(frame.finishReason()).forEach(ev -> handleEnd(ev));
 *     }
 * }
 * }</pre>
 */
public final class ToolWatcher {
    /**
     * Default cap on the number of token IDs buffered inside one open
     * region. 65536 tokens is comfortably above any real tool-call
     * payload while still bounding worst-case per-watcher memory
     * against a client that can make the model emit a start marker
     * without a matching end marker.
     */
    public static final int DEFAULT_REGION_CAP = 65536;

    private final long startId;
    private final long endId;
    private final String startName;
    private final String endName;

    private boolean inside;
    /** True once the in-progress region has hit regionCap and emitted its OVERFLOW event.
     * While set, body tokens are dropped (not buffered, not re-reported) until the end marker closes the region. */
    private boolean capped;
    private int regionCap;
    /** Captured region body: accumulates while inside, cleared once the region closes. */
    private final List<Long> region = new ArrayList<>();

    public ToolWatcher(TokenizerMap map, String startName, String endName) {
        this(map, startName, endName, DEFAULT_REGION_CAP);
    }

    public ToolWatcher(TokenizerMap map, String startName, String endName, int regionCap) {
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
        this.regionCap = regionCap > 0 ? regionCap : DEFAULT_REGION_CAP;
    }

    public long getStartId() { return startId; }
    public long getEndId() { return endId; }
    public String getStartName() { return startName; }
    public String getEndName() { return endName; }

    /** True while a region is open (start seen, end not yet). */
    public boolean isInside() { return inside; }

    /** Cap on the number of token IDs buffered inside one open region. */
    public int getRegionCap() { return regionCap; }

    /** Change the region cap. 0 resets to {@link #DEFAULT_REGION_CAP}. */
    public void setRegionCap(int cap) {
        this.regionCap = cap > 0 ? cap : DEFAULT_REGION_CAP;
    }

    /**
     * Drop any in-flight region buffer. Call between conversations so a
     * leftover unclosed region from session N doesn't spill into N+1.
     */
    public void reset() {
        inside = false;
        capped = false;
        region.clear();
    }

    /** Feed a chunk of token IDs (as longs holding uint32 values) and receive a flat, stream-ordered list of events. */
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
                    capped = false;
                    region.clear();
                }
            } else {
                if (id == endId) {
                    // Region complete. Skipped when the region already
                    // overflowed: that was reported once, already, at
                    // the moment the cap was hit.
                    if (!capped) {
                        long[] body = new long[region.size()];
                        for (int j = 0; j < body.length; j++) body[j] = region.get(j);
                        events.add(new WatcherEvent(WatcherEventKind.REGION, body));
                    }
                    region.clear();
                    inside = false;
                    capped = false;
                    ptStart = i + 1;
                } else if (id == startId) {
                    // Nested start: dropped from the region body (most
                    // models don't nest these markers, and treating an
                    // inner start as a new region would silently drop
                    // the outer content) but reported so it isn't
                    // silently swallowed.
                    events.add(new WatcherEvent(WatcherEventKind.NESTED_START, new long[] { id }));
                } else if (capped) {
                    // Already reported OVERFLOW for this region. Keep
                    // scanning for the end marker without buffering:
                    // memory stays bounded.
                } else if (region.size() >= regionCap) {
                    // Cap hit on this token. Report what's buffered so
                    // far, then stop growing: do not silently truncate.
                    // Deliberately does NOT clear `region`: if the
                    // stream then ends without an end marker, end()
                    // reports the same capped content as TRUNCATED
                    // (overflow and truncation are orthogonal signals; a
                    // region can be both). The end-marker path above
                    // clears it once the region actually closes.
                    long[] body = new long[region.size()];
                    for (int j = 0; j < body.length; j++) body[j] = region.get(j);
                    events.add(new WatcherEvent(WatcherEventKind.OVERFLOW, body));
                    capped = true;
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

    /**
     * Signal end of stream. {@link #feed(long[])} has no way to know
     * the stream is over, so call this once you know no more tokens are
     * coming.
     *
     * <p>If a region is currently open, returns a single-element list
     * with a {@link WatcherEventKind#TRUNCATED} event carrying whatever
     * was buffered (possibly empty) and {@code finishReason}, so the
     * caller can tell "the model hit its length limit mid tool-call"
     * ({@code "length".equals(finishReason)}) apart from a malformed
     * emission on its own. Returns an empty list when not inside a
     * region: calling {@code end()} on a cleanly finished stream is a
     * no-op.
     */
    public List<WatcherEvent> end(String finishReason) {
        if (!inside) return Collections.emptyList();
        long[] body = new long[region.size()];
        for (int j = 0; j < body.length; j++) body[j] = region.get(j);
        region.clear();
        inside = false;
        capped = false;
        List<WatcherEvent> out = new ArrayList<>(1);
        out.add(new WatcherEvent(WatcherEventKind.TRUNCATED, body, finishReason));
        return out;
    }

    /** {@link #end(String)} with no known finish reason. */
    public List<WatcherEvent> end() {
        return end(null);
    }

    private static long[] copySlice(long[] src, int from, int to) {
        long[] slice = new long[to - from];
        System.arraycopy(src, from, slice, 0, slice.length);
        return slice;
    }
}
