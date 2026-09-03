// SPDX-License-Identifier: MIT
package ai.codec;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ToolWatcherTests {
    private static final long START = 90L;
    private static final long END = 91L;

    private static TokenizerMap synthMap() {
        TokenizerMap m = new TokenizerMap();
        m.id = "test/synth";
        m.version = "2";
        m.vocabSize = 100;
        m.encoder = "byte_level";
        m.vocab = new HashMap<>();
        m.vocab.put("hello", 0);
        m.vocab.put("world", 1);
        m.vocab.put("!", 2);
        m.vocab.put("foo", 3);
        m.vocab.put("bar", 4);
        m.specialTokens = new HashMap<>();
        m.specialTokens.put("<tool_call>", 90);
        m.specialTokens.put("</tool_call>", 91);
        return m;
    }

    @Test
    void passthroughThenRegionThenPassthrough() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        // "hello world <tool_call> foo bar </tool_call> hello !"
        List<WatcherEvent> evs = w.feed(new long[] { 0, 1, START, 3, 4, END, 0, 2 });
        assertEquals(3, evs.size());

        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(0).getKind());
        assertArrayEquals(new long[] { 0, 1 }, evs.get(0).getIds());

        assertEquals(WatcherEventKind.REGION, evs.get(1).getKind());
        assertArrayEquals(new long[] { 3, 4 }, evs.get(1).getIds());

        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(2).getKind());
        assertArrayEquals(new long[] { 0, 2 }, evs.get(2).getIds());

        assertFalse(w.isInside());
    }

    @Test
    void regionSplitAcrossFeeds() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");

        // Feed 1: region opens but doesn't close.
        List<WatcherEvent> evs = w.feed(new long[] { 0, START, 3 });
        assertEquals(1, evs.size());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(0).getKind());
        assertArrayEquals(new long[] { 0 }, evs.get(0).getIds());
        assertTrue(w.isInside());

        // Feed 2: closes the region with body accumulated across both feeds.
        evs = w.feed(new long[] { 4, END, 1 });
        assertEquals(2, evs.size());
        assertEquals(WatcherEventKind.REGION, evs.get(0).getKind());
        assertArrayEquals(new long[] { 3, 4 }, evs.get(0).getIds());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(1).getKind());
        assertArrayEquals(new long[] { 1 }, evs.get(1).getIds());
        assertFalse(w.isInside());
    }

    @Test
    void multipleRegionsInOneFeed() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        List<WatcherEvent> evs = w.feed(new long[] { 0, START, 3, END, 1, START, 4, END, 2 });
        assertEquals(5, evs.size());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(0).getKind());
        assertEquals(WatcherEventKind.REGION, evs.get(1).getKind());
        assertArrayEquals(new long[] { 3 }, evs.get(1).getIds());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(2).getKind());
        assertEquals(WatcherEventKind.REGION, evs.get(3).getKind());
        assertArrayEquals(new long[] { 4 }, evs.get(3).getIds());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(4).getKind());
    }

    @Test
    void strayEndPassesThrough() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        List<WatcherEvent> evs = w.feed(new long[] { 0, END, 1 });
        // End with no preceding start: ordinary token.
        assertEquals(1, evs.size());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(0).getKind());
        assertArrayEquals(new long[] { 0, END, 1 }, evs.get(0).getIds());
    }

    @Test
    void missingSpecialNameThrows() {
        assertThrows(ToolWatcherException.class,
                () -> new ToolWatcher(synthMap(), "<not_real>", "</tool_call>"));
    }

    @Test
    void resetDropsInFlightRegion() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        w.feed(new long[] { START, 3, 4 });
        assertTrue(w.isInside());
        w.reset();
        assertFalse(w.isInside());
        // End marker now becomes a stray (no buffered body).
        List<WatcherEvent> evs = w.feed(new long[] { END, 1 });
        assertEquals(1, evs.size());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(0).getKind());
        assertArrayEquals(new long[] { END, 1 }, evs.get(0).getIds());
    }

    /**
     * No-decode contract: must operate on raw IDs only, never reading map.vocab.
     * Use a map with empty vocab and feed IDs outside any plausible vocab range.
     * The watcher must emit them verbatim.
     */
    @Test
    void neverDecodesOperatesOnRawIds() {
        TokenizerMap noVocab = new TokenizerMap();
        noVocab.id = "test/no-vocab";
        noVocab.version = "2";
        noVocab.vocabSize = 4;
        noVocab.encoder = "byte_level";
        noVocab.vocab = new HashMap<>();
        noVocab.specialTokens = new HashMap<>();
        noVocab.specialTokens.put("<tool_call>", 90);
        noVocab.specialTokens.put("</tool_call>", 91);

        ToolWatcher w = new ToolWatcher(noVocab, "<tool_call>", "</tool_call>");
        long bigA = 0xFFFFFF00L;
        long bigB = 0xDEADBEEFL;
        long bigC = 0xCAFEBABEL;
        List<WatcherEvent> evs = w.feed(new long[] { 12345L, bigA, START, bigB, bigC, END, 99999L });
        assertEquals(3, evs.size());
        assertArrayEquals(new long[] { 12345L, bigA }, evs.get(0).getIds());
        assertArrayEquals(new long[] { bigB, bigC }, evs.get(1).getIds()); // body verbatim
        assertArrayEquals(new long[] { 99999L }, evs.get(2).getIds());
    }

    @Test
    void intOverloadAcceptsWireFrameType() {
        // CodecFrame.ids is int[]; verify the int overload works.
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        List<WatcherEvent> evs = w.feed(new int[] { 0, 1, (int) START, 3, (int) END, 2 });
        assertEquals(3, evs.size());
        assertEquals(WatcherEventKind.REGION, evs.get(1).getKind());
        assertArrayEquals(new long[] { 3 }, evs.get(1).getIds());
    }

    // ── Ordering: interleaved events in stream order (defect 3) ──────────────
    //
    // [a, S, X, E, b, S, Y, E, c] must produce five ORDERED events:
    // passthrough(a) / region(X) / passthrough(b) / region(Y) / passthrough(c).
    // This is the exact shape every language's watcher must agree on.

    @Test
    void orderingMatchesDefect3Example() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        long a = 0, b = 1, c = 2, x = 3, y = 4; // hello, world, !, foo, bar
        List<WatcherEvent> evs = w.feed(new long[] { a, START, x, END, b, START, y, END, c });
        assertEquals(5, evs.size());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(0).getKind());
        assertArrayEquals(new long[] { a }, evs.get(0).getIds());
        assertEquals(WatcherEventKind.REGION, evs.get(1).getKind());
        assertArrayEquals(new long[] { x }, evs.get(1).getIds());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(2).getKind());
        assertArrayEquals(new long[] { b }, evs.get(2).getIds());
        assertEquals(WatcherEventKind.REGION, evs.get(3).getKind());
        assertArrayEquals(new long[] { y }, evs.get(3).getIds());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(4).getKind());
        assertArrayEquals(new long[] { c }, evs.get(4).getIds());
    }

    // ── Nested start markers (defect 5) ───────────────────────────────────────

    @Test
    void nestedStartIsDroppedFromBodyButObservable() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        // S 0 S 1 E 2 -> NESTED_START / REGION([0,1]) / PASSTHROUGH([2])
        List<WatcherEvent> evs = w.feed(new long[] { START, 0, START, 1, END, 2 });
        assertEquals(3, evs.size());
        assertEquals(WatcherEventKind.NESTED_START, evs.get(0).getKind());
        assertArrayEquals(new long[] { START }, evs.get(0).getIds());
        assertEquals(WatcherEventKind.REGION, evs.get(1).getKind());
        assertArrayEquals(new long[] { 0, 1 }, evs.get(1).getIds());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(2).getKind());
        assertArrayEquals(new long[] { 2 }, evs.get(2).getIds());
    }

    // ── Truncation: end() while inside a region (defect 1) ────────────────────
    //
    // An unterminated region (stream ends mid tool-call, e.g. the model hit
    // its length limit) used to be silently dropped: no event, no signal,
    // indistinguishable from a model that never called a tool. end() must
    // report it, carrying the finish reason so a length stop is
    // distinguishable from a malformed emission.

    @Test
    void endEmitsTruncatedWithFinishReason() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        List<WatcherEvent> evs = w.feed(new long[] { 0, START, 3, 4 });
        assertEquals(1, evs.size());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(0).getKind());
        assertTrue(w.isInside());

        evs = w.end("length");
        assertEquals(1, evs.size());
        assertEquals(WatcherEventKind.TRUNCATED, evs.get(0).getKind());
        assertArrayEquals(new long[] { 3, 4 }, evs.get(0).getIds());
        assertEquals("length", evs.get(0).getFinishReason());
        assertFalse(w.isInside());

        // A second end() call is a no-op: nothing left in flight.
        assertTrue(w.end("length").isEmpty());
    }

    @Test
    void endReportsEmptyBodyWhenStreamEndsRightAfterStart() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        w.feed(new long[] { START });
        assertTrue(w.isInside());

        List<WatcherEvent> evs = w.end(); // no finish reason known
        assertEquals(1, evs.size());
        assertEquals(WatcherEventKind.TRUNCATED, evs.get(0).getKind());
        assertArrayEquals(new long[0], evs.get(0).getIds());
        assertNull(evs.get(0).getFinishReason());
    }

    @Test
    void endOutsideRegionEmitsNothing() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        w.feed(new long[] { START, 3, END, 4 });
        assertFalse(w.isInside());
        assertTrue(w.end("stop").isEmpty());
    }

    // ── Overflow: region buffer cap (defect 2) ─────────────────────────────────
    //
    // The region buffer used to grow without bound: a client that can make
    // the model emit a start marker without a matching end marker could
    // grow it to the entire remaining generation. The cap must be enforced
    // and the overflow must be a defined, observable event, not a silent
    // truncation.

    @Test
    void regionCapDefaultsAndIsSettable() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>");
        assertEquals(ToolWatcher.DEFAULT_REGION_CAP, w.getRegionCap());

        w.setRegionCap(3);
        assertEquals(3, w.getRegionCap());

        // 0 resets to the default rather than becoming an unusable cap.
        w.setRegionCap(0);
        assertEquals(ToolWatcher.DEFAULT_REGION_CAP, w.getRegionCap());

        ToolWatcher w2 = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>", 3);
        assertEquals(3, w2.getRegionCap());
    }

    @Test
    void overflowFiresOnceAtCapThenResyncsOnEndMarker() {
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>", 3);
        // Region body is 5 tokens long against a cap of 3: must overflow
        // once, with exactly the first 3 tokens, and must NOT also emit
        // a region event for the same region when the end marker
        // eventually arrives.
        List<WatcherEvent> evs = w.feed(new long[] { START, 1, 2, 3, 4, 5, END, 9 });
        assertEquals(2, evs.size());
        assertEquals(WatcherEventKind.OVERFLOW, evs.get(0).getKind());
        assertArrayEquals(new long[] { 1, 2, 3 }, evs.get(0).getIds());
        assertEquals(WatcherEventKind.PASSTHROUGH, evs.get(1).getKind());
        assertArrayEquals(new long[] { 9 }, evs.get(1).getIds());
        assertFalse(w.isInside());
    }

    @Test
    void overflowThenTruncatedReportsBoth() {
        // A region that overflows and then never sees an end marker must
        // report BOTH: the overflow (memory bound hit) and the
        // truncation (stream ended without a close). They are orthogonal
        // signals.
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>", 2);
        List<WatcherEvent> evs = w.feed(new long[] { START, 1, 2, 3, 4 });
        assertEquals(1, evs.size());
        assertEquals(WatcherEventKind.OVERFLOW, evs.get(0).getKind());
        assertArrayEquals(new long[] { 1, 2 }, evs.get(0).getIds());

        evs = w.end("length");
        assertEquals(1, evs.size());
        assertEquals(WatcherEventKind.TRUNCATED, evs.get(0).getKind());
        assertArrayEquals(new long[] { 1, 2 }, evs.get(0).getIds());
        assertEquals("length", evs.get(0).getFinishReason());
    }

    @Test
    void exactCapDoesNotOverflow() {
        // Off-by-one check: a region whose body is exactly `cap` tokens
        // must close cleanly as REGION, not as OVERFLOW.
        ToolWatcher w = new ToolWatcher(synthMap(), "<tool_call>", "</tool_call>", 3);
        List<WatcherEvent> evs = w.feed(new long[] { START, 1, 2, 3, END });
        assertEquals(1, evs.size());
        assertEquals(WatcherEventKind.REGION, evs.get(0).getKind());
        assertArrayEquals(new long[] { 1, 2, 3 }, evs.get(0).getIds());
    }
}
