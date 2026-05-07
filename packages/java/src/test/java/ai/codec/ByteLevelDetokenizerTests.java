// SPDX-License-Identifier: MIT
package ai.codec;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for byte_level (Qwen-2 / Llama-3 style) detokenization. Builds a
 * tiny synthetic byte_level vocab so the test doesn't require the
 * codec-maps repo.
 */
class ByteLevelDetokenizerTests {

    /** Build a byte_level map for an arbitrary input string by encoding each
     *  byte and registering each codepoint of the encoding as a vocab token. */
    private static TokenizerMap byteLevelMapFor(String text) {
        TokenizerMap m = new TokenizerMap();
        m.id = "test-byte-level";
        m.version = "2";
        m.encoder = "byte_level";
        m.vocab = new HashMap<>();

        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        // Encode the input bytes; assign one ID per encoded GPT-2 char.
        String encoded = ByteEncoder.encodeByteLevelChars(bytes);
        int id = 0;
        int i = 0;
        while (i < encoded.length()) {
            int cp = encoded.codePointAt(i);
            String tok = new String(Character.toChars(cp));
            m.vocab.putIfAbsent(tok, id++);
            i += Character.charCount(cp);
        }
        m.vocabSize = m.vocab.size();
        return m;
    }

    @Test
    void byteLevelDetokenizesAscii() {
        String text = "Hello world";
        TokenizerMap m = byteLevelMapFor(text);
        Detokenizer d = new Detokenizer(m);
        // Tokenize manually: each byte → its encoded char → ID
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        int[] ids = new int[bytes.length];
        for (int j = 0; j < bytes.length; j++) {
            int cp = ByteEncoder.byteToCodepoint(bytes[j] & 0xff);
            ids[j] = m.vocab.get(new String(Character.toChars(cp)));
        }
        assertEquals(text, d.render(ids));
    }

    @Test
    void byteLevelDetokenizesEmojiSplitAcrossFrames() {
        String text = "🚀";
        TokenizerMap m = byteLevelMapFor(text);
        Detokenizer d = new Detokenizer(m);
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        // 🚀 = F0 9F 9A 80 (4 bytes)
        assertEquals(4, bytes.length);

        int[] ids = new int[bytes.length];
        for (int j = 0; j < bytes.length; j++) {
            int cp = ByteEncoder.byteToCodepoint(bytes[j] & 0xff);
            ids[j] = m.vocab.get(new String(Character.toChars(cp)));
        }

        // Split frame at offset 2.
        int[] left = new int[] { ids[0], ids[1] };
        int[] right = new int[] { ids[2], ids[3] };

        String out1 = d.render(left, DetokenizeOptions.partial(true));
        // Either "" or possibly partially decoded output; for byte_level after
        // 2 bytes of a 4-byte UTF-8 sequence, no codepoint should emit yet.
        assertEquals("", out1);
        String out2 = d.render(right, DetokenizeOptions.partial(false));
        assertEquals(text, out2);
    }

    @Test
    void byteLevelMetaspaceLikeRenderViaMetaspaceMap() {
        // Verify metaspace path: replace ▁ with space. Synthesize a metaspace map.
        TokenizerMap m = new TokenizerMap();
        m.id = "test-metaspace";
        m.version = "2";
        m.encoder = "metaspace";
        m.vocab = new HashMap<>();
        m.vocab.put("▁hello", 1);
        m.vocab.put("▁world", 2);
        m.vocabSize = 3;
        Detokenizer d = new Detokenizer(m);
        assertEquals(" hello world", d.render(new int[] { 1, 2 }));
    }
}
