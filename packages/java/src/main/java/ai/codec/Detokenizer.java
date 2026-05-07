// SPDX-License-Identifier: MIT
package ai.codec;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Stateful detokenizer. IDs → text. Three correctness concerns it
 * handles:
 * <ol>
 *   <li>Per-token decoding via the map's encoder (byte_level / metaspace / identity).</li>
 *   <li>Byte-fallback range — IDs in {@code [byte_fallback_start, byte_fallback_end]}
 *       are decoded as raw bytes and accumulated until a valid UTF-8 sequence forms.</li>
 *   <li>Partial multi-byte sequences across frame boundaries — buffered between
 *       calls when {@code partial: true}.</li>
 * </ol>
 */
public final class Detokenizer {
    private final TokenizerMap map;
    private final Set<Integer> specialIds;
    private final int fallbackStart;
    private final int fallbackEnd;
    private final Map<Integer, byte[]> idToBytes;   // byte_level
    private final Map<Integer, String> idToText;     // metaspace + identity
    private final List<Byte> byteBuffer = new ArrayList<>();

    public Detokenizer(TokenizerMap map) {
        this.map = map;
        this.specialIds = (map.specialTokens == null)
                ? new HashSet<>()
                : new HashSet<>(map.specialTokens.values());
        this.fallbackStart = map.byteFallbackStart == null ? -1 : map.byteFallbackStart;
        this.fallbackEnd = map.byteFallbackEnd == null ? -2 : map.byteFallbackEnd;

        if ("byte_level".equals(map.encoder)) {
            this.idToBytes = buildByteLevelTable(map);
            this.idToText = null;
        } else {
            this.idToBytes = null;
            this.idToText = buildTextTable(map);
        }
    }

    /** Render a chunk of IDs to text. Stateful across calls. */
    public String render(int[] ids, DetokenizeOptions options) {
        if (options == null) options = DetokenizeOptions.defaults();
        StringBuilder sb = new StringBuilder();
        boolean renderSpecial = options.renderSpecial;

        for (int id : ids) {
            // Byte-fallback range: SentencePiece reserves IDs for raw bytes 0x00-0xFF.
            if (id >= fallbackStart && id <= fallbackEnd) {
                byteBuffer.add((byte) (id - fallbackStart));
                flushAllBytes(sb);
                continue;
            }

            if (idToBytes != null) {
                // byte_level: every vocab token IS a byte sequence.
                if (specialIds.contains(id) && !renderSpecial) {
                    if (!byteBuffer.isEmpty()) flushBytesForce(sb);
                    continue;
                }
                byte[] bytes = idToBytes.get(id);
                if (bytes == null) {
                    if (!byteBuffer.isEmpty()) flushBytesForce(sb);
                    sb.append('�');
                    continue;
                }
                for (byte b : bytes) byteBuffer.add(b);
                flushAllBytes(sb);
                continue;
            }

            // metaspace / identity: token text is rendered directly.
            if (!byteBuffer.isEmpty()) flushBytesForce(sb);
            if (specialIds.contains(id) && !renderSpecial) continue;
            String text = idToText.get(id);
            if (text != null) sb.append(text);
            else sb.append('�');
        }

        if (!options.partial && !byteBuffer.isEmpty()) flushBytesForce(sb);
        return sb.toString();
    }

    /** Render with default options (non-partial, no special rendering). */
    public String render(int[] ids) {
        return render(ids, DetokenizeOptions.defaults());
    }

    /** Render an int list (convenience overload). */
    public String render(List<Integer> ids, DetokenizeOptions options) {
        int[] arr = new int[ids.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = ids.get(i);
        return render(arr, options);
    }

    /** Reset internal state — call between conversations / requests. */
    public void reset() {
        byteBuffer.clear();
    }

    /**
     * Convenience: detokenize a complete sequence in one shot. Uses a
     * fresh Detokenizer; partial buffering not exposed.
     */
    public static String detokenize(TokenizerMap map, int[] ids, boolean renderSpecial) {
        return new Detokenizer(map).render(ids, new DetokenizeOptions(false, renderSpecial));
    }

    public static String detokenize(TokenizerMap map, int[] ids) {
        return detokenize(map, ids, false);
    }

    // ── Internals ──────────────────────────────────────────────────────────

    private void flushAllBytes(StringBuilder sb) {
        while (!byteBuffer.isEmpty()) {
            int needed = utf8SequenceLength(byteBuffer.get(0) & 0xff);
            if (needed == 0) {
                byteBuffer.remove(0);
                sb.append('�');
                continue;
            }
            if (byteBuffer.size() < needed) break;
            byte[] span = new byte[needed];
            for (int i = 0; i < needed; i++) span[i] = byteBuffer.get(i);
            // Drop consumed bytes, then attempt strict decode.
            for (int i = 0; i < needed; i++) byteBuffer.remove(0);
            CharsetDecoder dec = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT);
            try {
                sb.append(dec.decode(ByteBuffer.wrap(span)).toString());
            } catch (CharacterCodingException e) {
                sb.append('�');
            }
        }
    }

    private void flushBytesForce(StringBuilder sb) {
        if (byteBuffer.isEmpty()) return;
        byte[] bytes = new byte[byteBuffer.size()];
        for (int i = 0; i < bytes.length; i++) bytes[i] = byteBuffer.get(i);
        byteBuffer.clear();
        // Lossy decode (replace invalid with U+FFFD).
        sb.append(new String(bytes, StandardCharsets.UTF_8));
    }

    private static int utf8SequenceLength(int b) {
        if ((b & 0x80) == 0x00) return 1;
        if ((b & 0xE0) == 0xC0) return 2;
        if ((b & 0xF0) == 0xE0) return 3;
        if ((b & 0xF8) == 0xF0) return 4;
        return 0;
    }

    private static Map<Integer, byte[]> buildByteLevelTable(TokenizerMap map) {
        Map<Integer, byte[]> result = new HashMap<>(map.vocab == null ? 0 : map.vocab.size());
        if (map.vocab == null) return result;
        for (Map.Entry<String, Integer> e : map.vocab.entrySet()) {
            result.put(e.getValue(), ByteEncoder.decodeByteLevelToken(e.getKey()));
        }
        return result;
    }

    private static Map<Integer, String> buildTextTable(TokenizerMap map) {
        Map<Integer, String> result = new HashMap<>();
        boolean isMetaspace = "metaspace".equals(map.encoder);

        if (map.vocab != null) {
            for (Map.Entry<String, Integer> e : map.vocab.entrySet()) {
                String token = e.getKey();
                int id = e.getValue();
                // SentencePiece byte-fallback tokens (<0xHH>) live in vocab
                // but are handled by the byte_fallback range path.
                if (isByteFallbackToken(token)) continue;
                String text = isMetaspace ? token.replace(ByteEncoder.METASPACE, ' ') : token;
                result.put(id, text);
            }
        }
        if (map.tokens != null) {
            for (Map.Entry<String, String> e : map.tokens.entrySet()) {
                try {
                    int id = Integer.parseInt(e.getKey());
                    result.put(id, e.getValue());
                } catch (NumberFormatException ignored) {}
            }
        }
        return result;
    }

    private static boolean isByteFallbackToken(String s) {
        if (s.length() != 6 || s.charAt(0) != '<' || s.charAt(1) != '0'
                || s.charAt(2) != 'x' || s.charAt(5) != '>') return false;
        return isHex(s.charAt(3)) && isHex(s.charAt(4));
    }

    private static boolean isHex(char c) {
        return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
    }
}
