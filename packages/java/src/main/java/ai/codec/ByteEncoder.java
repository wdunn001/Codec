// SPDX-License-Identifier: MIT
package ai.codec;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Shared encoder utilities — the GPT-2 byte&#x2194;unicode mapping table and
 * helpers used by both {@link Detokenizer} and {@link BPETokenizer}.
 */
public final class ByteEncoder {
    /** The metaspace marker (▁, U+2581) used by SentencePiece tokenizers. */
    public static final char METASPACE = '▁';

    private static final Map<Integer, Integer> BYTE_TO_CHAR_MAP;
    private static final Map<Integer, Integer> CHAR_TO_BYTE_MAP;

    static {
        // The GPT-2 bijection: bytes 33-126, 161-172, 174-255 map to themselves
        // (printable / non-control). Other bytes map to U+0100+n.
        List<Integer> bs = new ArrayList<>();
        for (int i = 33; i <= 126; i++) bs.add(i);
        for (int i = 161; i <= 172; i++) bs.add(i);
        for (int i = 174; i <= 255; i++) bs.add(i);
        List<Integer> cs = new ArrayList<>(bs);
        int n = 0;
        for (int b = 0; b < 256; b++) {
            if (!bs.contains(b)) {
                bs.add(b);
                cs.add(256 + n);
                n++;
            }
        }

        BYTE_TO_CHAR_MAP = new HashMap<>(256);
        CHAR_TO_BYTE_MAP = new HashMap<>(256);
        for (int i = 0; i < bs.size(); i++) {
            BYTE_TO_CHAR_MAP.put(bs.get(i), cs.get(i));
            CHAR_TO_BYTE_MAP.put(cs.get(i), bs.get(i));
        }
    }

    private ByteEncoder() {}

    /** Maps a byte (0–255) to its GPT-2-encoded codepoint. */
    public static int byteToCodepoint(int b) {
        return BYTE_TO_CHAR_MAP.get(b);
    }

    /** Maps a GPT-2-encoded codepoint back to a byte; returns -1 if not in the table. */
    public static int charToByte(int codepoint) {
        Integer v = CHAR_TO_BYTE_MAP.get(codepoint);
        return v == null ? -1 : v;
    }

    /**
     * Decode a byte-level BPE token (e.g. "Ġhello") to its raw bytes by
     * reversing the GPT-2 byte→unicode table. Characters outside the
     * table fall back to UTF-8 bytes (defensive — shouldn't happen for
     * valid vocab entries).
     */
    public static byte[] decodeByteLevelToken(String rawToken) {
        // Use a list backed by bytes since each codepoint maps to at most a few bytes.
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream(rawToken.length());
        int i = 0;
        while (i < rawToken.length()) {
            int cp;
            char c = rawToken.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < rawToken.length()
                    && Character.isLowSurrogate(rawToken.charAt(i + 1))) {
                cp = Character.toCodePoint(c, rawToken.charAt(i + 1));
                i += 2;
            } else {
                cp = c;
                i++;
            }
            int b = charToByte(cp);
            if (b >= 0) {
                buf.write(b);
            } else {
                // Unknown char — emit as UTF-8 bytes.
                String s = new String(Character.toChars(cp));
                byte[] enc = s.getBytes(StandardCharsets.UTF_8);
                try {
                    buf.write(enc);
                } catch (java.io.IOException ignored) { /* ByteArrayOutputStream never throws */ }
            }
        }
        return buf.toByteArray();
    }

    /**
     * Encode raw bytes into a string of GPT-2 byte-encoded characters.
     * The result matches the keys of a byte_level vocab.
     */
    public static String encodeByteLevelChars(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length);
        for (byte raw : bytes) {
            int b = raw & 0xff;
            int cp = BYTE_TO_CHAR_MAP.get(b);
            sb.appendCodePoint(cp);
        }
        return sb.toString();
    }
}
