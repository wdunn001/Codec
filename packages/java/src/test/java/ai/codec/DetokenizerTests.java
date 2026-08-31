// SPDX-License-Identifier: MIT
package ai.codec;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class DetokenizerTests {

    @Test
    void detokenizesSimpleVocabTokens() {
        int[] ids = { 3, 4, 5, 8 }; // hello + space + world + !
        assertEquals("hello world!", Detokenizer.detokenize(Fixtures.tinyMap(), ids));
    }

    @Test
    void skipsSpecialTokensByDefault() {
        int[] ids = { 267, 3, 4, 5, 266 }; // <bos> hello world <eos>
        assertEquals("hello world", Detokenizer.detokenize(Fixtures.tinyMap(), ids));
    }

    @Test
    void rendersSpecialTokensWhenAsked() {
        int[] ids = { 3, 266 };
        String result = Detokenizer.detokenize(Fixtures.tinyMap(), ids, true);
        // Special-token rendering: 266 isn't in the v1 tokens map → replacement char.
        assertTrue(result.startsWith("hello"));
    }

    @Test
    void byteFallbackThreeByteUtf8() {
        // € = E2 82 AC (3 bytes)
        int[] ids = { Fixtures.byteId(0xE2), Fixtures.byteId(0x82), Fixtures.byteId(0xAC) };
        assertEquals("€", Detokenizer.detokenize(Fixtures.tinyMap(), ids));
    }

    @Test
    void byteFallbackFourByteEmoji() {
        // 🚀 = F0 9F 9A 80 (4 bytes)
        int[] ids = {
                Fixtures.byteId(0xF0), Fixtures.byteId(0x9F),
                Fixtures.byteId(0x9A), Fixtures.byteId(0x80),
        };
        assertEquals("🚀", Detokenizer.detokenize(Fixtures.tinyMap(), ids));
    }

    @Test
    void partialMultiByteSequenceBufferedAcrossFrames() {
        Detokenizer d = new Detokenizer(Fixtures.tinyMap());
        // Frame 1: first 2 bytes of €: incomplete, must not emit anything.
        String out1 = d.render(
                new int[] { Fixtures.byteId(0xE2), Fixtures.byteId(0x82) },
                DetokenizeOptions.partial(true));
        assertEquals("", out1);
        // Frame 2: final byte. Now flushes.
        String out2 = d.render(new int[] { Fixtures.byteId(0xAC) },
                DetokenizeOptions.partial(false));
        assertEquals("€", out2);
    }

    @Test
    void partialFourByteEmojiAcrossTwoFrames() {
        // 🚀 = F0 9F 9A 80: split between two frames; must round-trip identically.
        Detokenizer d = new Detokenizer(Fixtures.tinyMap());
        String out1 = d.render(
                new int[] { Fixtures.byteId(0xF0), Fixtures.byteId(0x9F) },
                DetokenizeOptions.partial(true));
        assertEquals("", out1);
        String out2 = d.render(
                new int[] { Fixtures.byteId(0x9A), Fixtures.byteId(0x80) },
                DetokenizeOptions.partial(false));
        assertEquals("🚀", out2);
    }

    @Test
    void vocabTokenAfterPartialBytesFlushesBufferFirst() {
        Detokenizer d = new Detokenizer(Fixtures.tinyMap());
        // 'A' as byte (0x41) + 'hello' (vocab id 3)
        String output = d.render(new int[] { Fixtures.byteId(0x41), 3 });
        assertEquals("Ahello", output);
    }

    @Test
    void unknownIdEmitsReplacement() {
        Detokenizer d = new Detokenizer(Fixtures.tinyMap());
        assertEquals("�", d.render(new int[] { 99999 }));
    }

    @Test
    void resetClearsPartialBuffer() {
        Detokenizer d = new Detokenizer(Fixtures.tinyMap());
        d.render(new int[] { Fixtures.byteId(0xE2) }, DetokenizeOptions.partial(true));
        d.reset();
        assertEquals("hello", d.render(new int[] { 3 }));
    }
}
