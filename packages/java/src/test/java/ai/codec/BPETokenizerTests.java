// SPDX-License-Identifier: MIT
package ai.codec;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class BPETokenizerTests {

    /** Tiny synthetic byte_level map: single space encodes to "Ġ" via GPT-2. */
    private static TokenizerMap byteLevelFixture() {
        String space = ByteEncoder.encodeByteLevelChars(new byte[] { 0x20 });
        TokenizerMap m = new TokenizerMap();
        m.id = "test/byte_level";
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
        m.vocab.put("!", 8);
        m.vocab.put("he", 9);
        m.vocab.put("hel", 10);
        m.vocab.put("hell", 11);
        m.vocab.put("hello", 12);
        m.vocab.put("wo", 13);
        m.vocab.put("wor", 14);
        m.vocab.put("worl", 15);
        m.vocab.put("world", 16);
        m.vocab.put(space + "world", 17);
        m.vocabSize = m.vocab.size();
        m.merges = List.of(
                "h e",
                "he l",
                "hel l",
                "hell o",
                "w o",
                "wo r",
                "wor l",
                "worl d",
                space + " world"
        );
        m.preTokenizerPattern = " ?[A-Za-z]+| ?[^A-Za-z\\s]+|\\s+";
        return m;
    }

    @Test
    void encodesHelloWorldExactly() {
        TokenizerMap m = byteLevelFixture();
        BPETokenizer tok = new BPETokenizer(m);
        int[] ids = tok.encode("hello world!");
        assertArrayEquals(new int[] { 12, 17, 8 }, ids);
    }

    @Test
    void roundTripsThroughDetokenizer() {
        TokenizerMap m = byteLevelFixture();
        BPETokenizer tok = new BPETokenizer(m);
        Detokenizer d = new Detokenizer(m);
        String text = "hello world!";
        assertEquals(text, d.render(tok.encode(text)));
    }

    @Test
    void mergesGreedilyByPriorityNotLeftToRight() {
        // Build a fixture where merge priority matters.
        TokenizerMap m = new TokenizerMap();
        m.id = "test/priority";
        m.version = "2";
        m.encoder = "byte_level";
        m.vocab = new HashMap<>();
        m.vocab.put("a", 0);
        m.vocab.put("b", 1);
        m.vocab.put("c", 2);
        m.vocab.put("ab", 3);
        m.vocab.put("bc", 4);
        m.vocab.put("abc", 5);
        m.vocabSize = 6;

        // "b c" first (lower index = higher priority).
        // Greedy left-to-right: "ab" + "c" → [3, 2].
        // Priority-correct: "a" + "bc" → [0, 4].
        m.merges = List.of("b c", "a b");
        m.preTokenizerPattern = "\\S+";

        BPETokenizer tok = new BPETokenizer(m);
        assertArrayEquals(new int[] { 0, 4 }, tok.encode("abc"));
    }

    @Test
    void roundTripsRealQwenMapForUnicode() throws IOException {
        String path = Fixtures.findQwenMap();
        if (path == null) return; // gracefully skip when codec-maps is absent

        byte[] data = Files.readAllBytes(Paths.get(path));
        TokenizerMap m = TokenizerMap.fromJson(data);
        BPETokenizer tok = new BPETokenizer(m);
        Detokenizer d = new Detokenizer(m);

        String[] samples = {
                "Hello, world!",
                "Explain entropy in one sentence.",
                "def add(a, b):\n    return a + b",
                "Multiple   spaces   between   words.",
                "🚀 launch",
                "日本語のテキスト",
                "Café résumé naïve",
        };
        for (String s : samples) {
            int[] ids = tok.encode(s);
            assertEquals(s, d.render(ids));
        }
    }
}
