// SPDX-License-Identifier: MIT
//
// Translator — cross-vocab token-stream pipe.
//
// Take Agent A's token IDs in vocab V_A, produce Agent B's token IDs in
// vocab V_B, with no text ever leaving the process. Internally:
//
//     ids_A → Detokenizer(V_A) → utf8 → BPETokenizer(V_B) → ids_B
//
// The text intermediate is purely local; agent-to-agent traffic still
// carries only token IDs on the wire. Mirrors the .NET Translator —
// same word-boundary buffering rules.
package ai.codec;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Cross-vocab agent-handoff pipe.
 *
 * <p>Construct with a source map and a target map. Call translate
 * repeatedly with chunks of source IDs; receive chunks of target IDs.
 * Stateful across calls — partial words buffer internally.
 *
 * <pre>{@code
 * Translator tr = new Translator(qwenMap, llamaMap);
 * int[] llamaIds = tr.translate(qwenIds);                          // one-shot
 *
 * // Streaming:
 * for (int[] chunk : chunks) {
 *     int[] ids = tr.translate(chunk, true);  // partial = true
 *     // forward ids ...
 * }
 * int[] tail = tr.finish();
 * }</pre>
 */
public final class Translator {
    private final String fromId;
    private final String toId;

    private final Detokenizer fromDetok;
    private final ITokenizer toTok;
    private final StringBuilder textBuffer = new StringBuilder();

    public Translator(TokenizerMap fromMap, TokenizerMap toMap) {
        if (fromMap == null) throw new NullPointerException("fromMap");
        if (toMap == null) throw new NullPointerException("toMap");

        this.fromId = fromMap.id;
        this.toId = toMap.id;
        this.fromDetok = new Detokenizer(fromMap);
        this.toTok = Tokenize.pick(toMap);
    }

    public String getFromId() { return fromId; }
    public String getToId() { return toId; }

    /**
     * Translate a chunk of source-vocab IDs to target-vocab IDs.
     *
     * @param ids source IDs to render through V_A's detokenizer.
     * @param partial true for streaming chunks (a trailing partial word stays
     *                buffered). false (or call {@link #finish}) on the final
     *                chunk so the buffer drains.
     */
    public int[] translate(int[] ids, boolean partial) {
        if (ids == null) throw new NullPointerException("ids");

        // Render through V_A's detokenizer with the same partial flag — the
        // detokenizer handles partial UTF-8 byte sequences for us.
        String text = fromDetok.render(ids, DetokenizeOptions.partial(partial));
        if (!text.isEmpty()) textBuffer.append(text);

        if (!partial) {
            String allText = textBuffer.toString();
            textBuffer.setLength(0);
            return toTok.encode(allText);
        }

        // Streaming chunk — find the last safe boundary and flush before it.
        int safe = findLastSafeBoundary(textBuffer);
        if (safe <= 0) return new int[0];

        String toEncode = textBuffer.substring(0, safe);
        textBuffer.delete(0, safe);
        return toTok.encode(toEncode);
    }

    /** One-shot non-streaming translate. */
    public int[] translate(int[] ids) {
        return translate(ids, false);
    }

    /** End-of-stream flush. Equivalent to {@code translate(empty, false)}. */
    public int[] finish() {
        return translate(new int[0], false);
    }

    /** Drop all internal state. Call between conversations. */
    public void reset() {
        fromDetok.reset();
        textBuffer.setLength(0);
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    /** ASCII whitespace + common Unicode whitespace block — covers Llama-3, Qwen, Phi-3, Mistral pre-tok regexes. */
    private static boolean isWhitespaceCp(int cp) {
        return cp == 0x20 || cp == 0x09 || cp == 0x0A || cp == 0x0D
                || cp == 0x0B || cp == 0x0C
                || cp == 0x00A0 || cp == 0x2028 || cp == 0x2029 || cp == 0x3000;
    }

    private static int findLastSafeBoundary(StringBuilder buf) {
        for (int i = buf.length() - 1; i >= 0; i--) {
            if (isWhitespaceCp(buf.charAt(i))) return i + 1;
        }
        return 0;
    }

    /** One-shot Translator, for non-streaming uses where all IDs are in hand. */
    public static int[] translate(TokenizerMap fromMap, TokenizerMap toMap, int[] ids) {
        return new Translator(fromMap, toMap).translate(ids);
    }

    /**
     * Build a static V_A → V_B[] translation table by rendering each V_A
     * vocab entry to text and re-tokenizing through V_B.
     *
     * <p>Context-free: the result for a given source ID may differ from what
     * {@link #translate} produces when the same ID appears mid-sentence
     * (BPE merges depend on context). Useful for analysis (vocab overlap,
     * cost estimation) and as a fast lookup when context-free translation
     * is acceptable.
     */
    public static Map<Integer, int[]> staticTranslationTable(
            TokenizerMap fromMap, TokenizerMap toMap) {
        Detokenizer detok = new Detokenizer(fromMap);
        ITokenizer tok = Tokenize.pick(toMap);
        Map<Integer, int[]> result = new HashMap<>();

        Set<Integer> specialIds = new HashSet<>();
        if (fromMap.specialTokens != null) specialIds.addAll(fromMap.specialTokens.values());

        if (fromMap.vocab != null) {
            for (Map.Entry<String, Integer> e : fromMap.vocab.entrySet()) {
                int id = e.getValue();
                if (specialIds.contains(id)) continue;
                String text = detok.render(new int[] { id });
                if (text.isEmpty()) { detok.reset(); continue; }
                result.put(id, tok.encode(text));
                detok.reset();
            }
        }

        if (fromMap.tokens != null) {
            for (Map.Entry<String, String> e : fromMap.tokens.entrySet()) {
                int id;
                try { id = Integer.parseInt(e.getKey()); }
                catch (NumberFormatException ex) { continue; }
                if (specialIds.contains(id) || result.containsKey(id)) continue;
                String text = detok.render(new int[] { id });
                if (text.isEmpty()) { detok.reset(); continue; }
                result.put(id, tok.encode(text));
                detok.reset();
            }
        }

        return result;
    }
}
