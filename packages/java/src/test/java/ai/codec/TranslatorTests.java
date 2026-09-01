// SPDX-License-Identifier: MIT
package ai.codec;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class TranslatorTests {

    @Test
    void emptyInputReturnsEmptyOutput() {
        TokenizerMap m = Fixtures.tinyMap();
        Translator tr = new Translator(m, m);
        assertEquals(0, tr.translate(new int[0]).length);
    }

    @Test
    void resetClearsTextBuffer() {
        TokenizerMap m = Fixtures.tinyMap();
        Translator tr = new Translator(m, m);
        // Feed something with a partial flag, then reset, then finish: should
        // produce no output (buffer was cleared).
        tr.translate(new int[] { 3, 4 }, true);  // "hello "
        tr.reset();
        assertEquals(0, tr.finish().length);
    }

    /**
     * Streaming with a synthetic byte_level map. Verifies the
     * word-boundary buffering stays consistent across chunked feeds:
     * the chunked path must produce the same DETOKENIZED text as the
     * one-shot path. (BPE merges depend on context. Token IDs may
     * therefore differ across chunked vs one-shot: but the text round-trips.)
     */
    @Test
    void streamingChunksProduceSameTextAsOneShot() {
        TokenizerMap m = byteLevelStreamingMap();
        BPETokenizer tok = new BPETokenizer(m);
        Detokenizer detok = new Detokenizer(m);

        String text = "hello world hello world";
        int[] srcIds = tok.encode(text);

        // One-shot reference.
        Translator one = new Translator(m, m);
        int[] oneShot = one.translate(srcIds);

        // Streaming: feed 2 IDs at a time with partial=true, then finish.
        Translator tr = new Translator(m, m);
        java.util.List<Integer> chunked = new java.util.ArrayList<>();
        for (int off = 0; off < srcIds.length; off += 2) {
            int len = Math.min(2, srcIds.length - off);
            int[] slice = new int[len];
            System.arraycopy(srcIds, off, slice, 0, len);
            for (int v : tr.translate(slice, true)) chunked.add(v);
        }
        for (int v : tr.finish()) chunked.add(v);

        int[] chunkedArr = new int[chunked.size()];
        for (int i = 0; i < chunkedArr.length; i++) chunkedArr[i] = chunked.get(i);

        // Both paths must round-trip back to the same text.
        Detokenizer d = new Detokenizer(m);
        String detokOne = d.render(oneShot);
        d.reset();
        String detokStr = d.render(chunkedArr);
        assertEquals(text, detokOne);
        assertEquals(text, detokStr);
    }

    /** Build a small byte_level map that supports "hello world" encoding. */
    private static TokenizerMap byteLevelStreamingMap() {
        String space = ByteEncoder.encodeByteLevelChars(new byte[] { 0x20 });
        TokenizerMap m = new TokenizerMap();
        m.id = "test/byte_level/streaming";
        m.version = "2";
        m.encoder = "byte_level";
        m.vocab = new HashMap<>();
        m.vocab.put("h", 0);
        m.vocab.put("e", 1);
        m.vocab.put("l", 2);
        m.vocab.put("o", 3);
        m.vocab.put("w", 4);
        m.vocab.put("r", 5);
        m.vocab.put("d", 6);
        m.vocab.put(space, 7);
        m.vocab.put("hello", 12);
        m.vocab.put("world", 16);
        m.vocab.put(space + "world", 17);
        m.vocab.put(space + "hello", 18);
        m.vocabSize = 20;
        m.merges = List.of(
                "h e", "he l", "hel l", "hell o",
                "w o", "wo r", "wor l", "worl d",
                space + " world", space + " hello"
        );
        m.preTokenizerPattern = " ?[A-Za-z]+| ?[^A-Za-z\\s]+|\\s+";
        return m;
    }

    @Test
    void identityQwen2RoundTrip() throws IOException {
        String path = Fixtures.findQwenMap();
        if (path == null) return; // gracefully skip when codec-maps absent
        TokenizerMap m = TokenizerMap.fromJson(Files.readAllBytes(Paths.get(path)));

        String text = "The quick brown fox jumps over the lazy dog. 2 + 2 = 4.";
        int[] srcIds = Tokenize.pick(m).encode(text);

        Translator tr = new Translator(m, m);
        int[] outIds = tr.translate(srcIds);
        String rendered = new Detokenizer(m).render(outIds);
        assertEquals(text, rendered);
    }
}
