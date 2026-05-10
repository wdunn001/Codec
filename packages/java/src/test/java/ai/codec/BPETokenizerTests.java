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

    @Test
    void chatTemplateAndFimSpecialsEmitAtomicIds() throws IOException {
        // Regression guard for the special-token pre-scan. Reference IDs
        // come from HuggingFace `tokenizers` 0.23.1 reading
        // Qwen-2.5-0.5B-Instruct's tokenizer.json — the encoder must emit
        // each `<|...|>` delimiter as a single atomic vocab ID, not as 6
        // byte-level tokens.
        String path = Fixtures.findQwenMap();
        if (path == null) return;

        byte[] data = Files.readAllBytes(Paths.get(path));
        TokenizerMap m = TokenizerMap.fromJson(data);
        BPETokenizer tok = new BPETokenizer(m);

        assertArrayEquals(
                new int[]{151644, 872, 198, 3838, 374, 220, 17, 10, 17, 30, 151645},
                tok.encode("<|im_start|>user\nWhat is 2+2?<|im_end|>"));
        assertArrayEquals(
                new int[]{151659, 750, 15229, 2075, 1648, 151661, 262, 470, 856, 151660, 198},
                tok.encode("<|fim_prefix|>def foo(x):<|fim_suffix|>    return x<|fim_middle|>\n"));
        assertArrayEquals(
                new int[]{151644, 8948, 198, 2610, 525, 10950, 13, 151645, 198, 151644, 872, 198, 9707, 151645},
                tok.encode("<|im_start|>system\nYou are helpful.<|im_end|>\n<|im_start|>user\nHello<|im_end|>"));
    }
}
