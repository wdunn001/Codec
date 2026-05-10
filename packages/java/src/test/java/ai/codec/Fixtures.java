// SPDX-License-Identifier: MIT
package ai.codec;

import java.io.File;
import java.util.HashMap;
import java.util.Map;

/** Test fixtures shared across the JUnit suite. Mirrors the .NET / Python fixtures. */
final class Fixtures {
    private Fixtures() {}

    /**
     * Tiny synthetic v1-style map for exercising Detokenizer + LongestMatch
     * without pulling in a real model.
     */
    static TokenizerMap tinyMap() {
        TokenizerMap m = new TokenizerMap();
        m.id = "test-tiny-v1";
        m.version = "1.0.0";
        m.vocabSize = 270;
        m.tokens = new HashMap<>();
        m.tokens.put("0", "�");
        m.tokens.put("1", "h");
        m.tokens.put("2", "he");
        m.tokens.put("3", "hello");
        m.tokens.put("4", " ");
        m.tokens.put("5", "world");
        m.tokens.put("6", "w");
        m.tokens.put("7", "wor");
        m.tokens.put("8", "!");
        m.tokens.put("9", "\n");
        // 10-265 reserved for byte-fallback (256 bytes)
        Map<String, Integer> specials = new HashMap<>();
        specials.put("eos", 266);
        specials.put("bos", 267);
        m.specialTokens = specials;
        m.byteFallbackStart = 10;
        m.byteFallbackEnd = 265;
        return m;
    }

    /** ID for a raw byte in the byte-fallback range. */
    static int byteId(int b) { return tinyMap().byteFallbackStart + (b & 0xff); }

    /** Locate a real Qwen-2 map for round-trip testing. Returns null if absent. */
    static String findQwenMap() {
        String[] candidates = {
                "H:\\dev\\codec-maps\\maps\\qwen\\qwen2.json",
                "/mnt/h/dev/codec-maps/maps/qwen/qwen2.json",
                System.getProperty("user.dir") + File.separator + ".." + File.separator + ".."
                        + File.separator + "codec-maps" + File.separator + "maps"
                        + File.separator + "qwen" + File.separator + "qwen2.json",
        };
        for (String c : candidates) {
            File f = new File(c);
            if (f.exists()) return f.getAbsolutePath();
        }
        return null;
    }
}
