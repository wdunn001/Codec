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
}
