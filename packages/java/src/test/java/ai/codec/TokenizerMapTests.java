// SPDX-License-Identifier: MIT
package ai.codec;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class TokenizerMapTests {

    @Test
    void parsesMinimalV2Map() {
        String json = "{ \"id\": \"x\", \"version\": \"2\", \"vocab_size\": 3, "
                + "\"vocab\": { \"a\": 0, \"b\": 1, \"c\": 2 }, \"encoder\": \"byte_level\" }";
        TokenizerMap m = TokenizerMap.fromJson(json);
        assertEquals("x", m.id);
        assertEquals(3, m.vocabSize);
        assertEquals("byte_level", m.encoder);
    }

    @Test
    void parsesV1MapWithTokens() {
        String json = "{ \"id\": \"v1-test\", \"version\": \"1\", \"vocab_size\": 2, "
                + "\"tokens\": { \"0\": \"hello\", \"1\": \"world\" } }";
        TokenizerMap m = TokenizerMap.fromJson(json);
        assertEquals("v1-test", m.id);
        assertEquals("hello", m.tokens.get("0"));
    }

    @Test
    void rejectsMissingVocabAndTokens() {
        String json = "{ \"id\": \"bad\", \"version\": \"2\", \"vocab_size\": 1 }";
        assertThrows(TokenizerMapValidationException.class,
                () -> TokenizerMap.fromJson(json));
    }

    @Test
    void rejectsBadEncoder() {
        String json = "{ \"id\": \"bad\", \"version\": \"2\", \"vocab_size\": 1, "
                + "\"vocab\": { \"x\": 0 }, \"encoder\": \"weird\" }";
        assertThrows(TokenizerMapValidationException.class,
                () -> TokenizerMap.fromJson(json));
    }

    @Test
    void rejectsMismatchedByteFallbackRange() {
        String json = "{ \"id\": \"bad\", \"version\": \"2\", \"vocab_size\": 1, "
                + "\"vocab\": { \"x\": 0 }, \"byte_fallback_start\": 1 }";
        assertThrows(TokenizerMapValidationException.class,
                () -> TokenizerMap.fromJson(json));
    }
}
