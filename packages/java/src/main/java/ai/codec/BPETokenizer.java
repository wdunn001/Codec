// SPDX-License-Identifier: MIT
package ai.codec;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure Java BPE encoder. Text → token IDs. Required for the bidirectional
 * Codec endpoint where the client wants to send token-ID prompts (zero
 * text on the wire in either direction).
 *
 * <p>Algorithm (for both byte_level and metaspace BPE):
 * <ol>
 *   <li>Pre-tokenize: split input into pieces (regex for byte_level; whitespace for metaspace).</li>
 *   <li>Encode each piece into the vocab's character space (GPT-2 byte chars or ▁-prefixed).</li>
 *   <li>Apply BPE merges greedily by priority — match HuggingFace reference.</li>
 *   <li>Look up final tokens in vocab. Tokens not in vocab fall back to byte tokens (metaspace path).</li>
 * </ol>
 */
public final class BPETokenizer implements ITokenizer {
    private final String id;
    private final Map<String, Integer> vocab;
    private final Map<String, Integer> mergeRanks;
    private final Pattern preTokRegex;
    private final String encoder;
    private final int byteFallbackStart;
    private final Map<String, int[]> cache = new HashMap<>();
    /**
     * Special-token scanner. Built from {@code map.specialTokens} plus any
     * vocab key in {@code <|body|>} shape with non-empty identifier-like
     * body. HF's reference tokenizer splits input on registered specials
     * BEFORE running BPE — emit each match as the atomic vocab ID, BPE
     * the surrounding text. Required for chat templates
     * ({@code <|im_start|>...<|im_end|>}), tool-call delimiters, FIM
     * markers, etc. to round-trip with HF.
     */
    private final Map<String, Integer> specialIds;
    private final Pattern specialRegex;

    private static final Pattern DELIMITER_BODY = Pattern.compile("^[A-Za-z0-9_-]+$");

    /**
     * Match {@code <|body|>} where body is non-empty and identifier-like
     * (letters/digits/_/-). Catches every shipped chat-template and tool-
     * call delimiter while excluding pathological vocab BPE tokens like
     * Falcon's {@code <|>} (id 61799) that share the start/end pair.
     */
    private static boolean isDelimiterShape(String tok) {
        if (tok.length() <= 4) return false;
        if (!tok.startsWith("<|") || !tok.endsWith("|>")) return false;
        return DELIMITER_BODY.matcher(tok.substring(2, tok.length() - 2)).matches();
    }

    /** True if the map has the data BPETokenizer needs. */
    public static boolean supports(TokenizerMap map) {
        return map.vocab != null && !map.vocab.isEmpty()
                && map.merges != null && !map.merges.isEmpty()
                && ("byte_level".equals(map.encoder) || "metaspace".equals(map.encoder));
    }

    public BPETokenizer(TokenizerMap map) {
        if (!supports(map))
            throw new IllegalArgumentException(
                    "BPETokenizer: map \"" + map.id + "\" lacks vocab/merges/encoder. "
                            + "Use BPETokenizer.supports(map) to check first, or call "
                            + "Tokenize.pick(map) which falls back to LongestMatchTokenizer.");

        this.encoder = map.encoder;
        this.id = map.id;
        this.byteFallbackStart = map.byteFallbackStart == null ? -1 : map.byteFallbackStart;

        this.vocab = new HashMap<>(map.vocab);
        this.mergeRanks = new HashMap<>(map.merges.size());
        for (int i = 0; i < map.merges.size(); i++) {
            this.mergeRanks.put(map.merges.get(i), i);
        }

        if ("byte_level".equals(this.encoder)) {
            if (map.preTokenizerPattern == null || map.preTokenizerPattern.isEmpty())
                throw new IllegalArgumentException(
                        "BPETokenizer: byte_level map \"" + map.id + "\" missing pre_tokenizer_pattern.");
            // Java's regex supports \p{L} natively under UNICODE_CHARACTER_CLASS.
            this.preTokRegex = Pattern.compile(map.preTokenizerPattern, Pattern.UNICODE_CHARACTER_CLASS);
        } else {
            this.preTokRegex = null;
        }

        // Build the special-token scanner. Accept entries from
        // map.specialTokens AND any vocab key in `<|body|>` shape — older
        // maps shipped before a chat-template revision may carry the
        // delimiters in vocab but not in specialTokens. Length-descending
        // alternation order so longer delimiters match before shorter
        // prefixes. Without this pre-scan, `<|im_start|>` would tokenise
        // byte-by-byte instead of as the single atomic vocab ID.
        Map<String, Integer> specials = new HashMap<>();
        if (map.specialTokens != null) specials.putAll(map.specialTokens);
        for (Map.Entry<String, Integer> e : this.vocab.entrySet()) {
            if (specials.containsKey(e.getKey())) continue;
            if (isDelimiterShape(e.getKey())) specials.put(e.getKey(), e.getValue());
        }
        this.specialIds = specials;
        if (specials.isEmpty()) {
            this.specialRegex = null;
        } else {
            List<String> keys = new ArrayList<>(specials.keySet());
            keys.sort((a, b) -> Integer.compare(b.length(), a.length()));
            StringBuilder alt = new StringBuilder();
            for (int i = 0; i < keys.size(); i++) {
                if (i > 0) alt.append('|');
                alt.append(Pattern.quote(keys.get(i)));
            }
            this.specialRegex = Pattern.compile(alt.toString());
        }
    }

    @Override public String getId() { return id; }

    @Override
    public int[] encode(String text) {
        if (text == null || text.isEmpty()) return new int[0];

        if (specialRegex != null) {
            List<Integer> ids = new ArrayList<>();
            Matcher m = specialRegex.matcher(text);
            int cursor = 0;
            while (m.find()) {
                if (m.start() > cursor) encodeChunk(text.substring(cursor, m.start()), ids);
                ids.add(specialIds.get(m.group()));
                cursor = m.end();
            }
            if (cursor < text.length()) encodeChunk(text.substring(cursor), ids);
            int[] out = new int[ids.size()];
            for (int i = 0; i < out.length; i++) out[i] = ids.get(i);
            return out;
        }

        List<Integer> ids = new ArrayList<>();
        encodeChunk(text, ids);
        int[] out = new int[ids.size()];
        for (int i = 0; i < out.length; i++) out[i] = ids.get(i);
        return out;
    }

    private void encodeChunk(String text, List<Integer> ids) {
        if (text == null || text.isEmpty()) return;
        List<String> pieces = preTokenize(text);
        for (String piece : pieces) {
            int[] cached = cache.get(piece);
            if (cached != null) {
                for (int v : cached) ids.add(v);
                continue;
            }
            List<String> encoded = encodePieceToVocabSpace(piece);
            List<String> merged = applyBPE(encoded);
            int[] pieceIds = lookup(merged);
            cache.put(piece, pieceIds);
            for (int v : pieceIds) ids.add(v);
        }
    }

    // ── Pre-tokenization ────────────────────────────────────────────────────

    private List<String> preTokenize(String text) {
        if ("byte_level".equals(encoder)) {
            List<String> result = new ArrayList<>();
            Matcher m = preTokRegex.matcher(text);
            while (m.find()) {
                String s = m.group();
                if (!s.isEmpty()) result.add(s);
            }
            return result;
        }
        // Metaspace: split on whitespace, prefix every word with ▁.
        List<String> pieces = new ArrayList<>();
        // Collapse runs of horizontal whitespace to a single space.
        String collapsed = text.replaceAll("[ \\t]+", " ");
        // Split on whitespace, retaining whitespace tokens.
        Pattern ws = Pattern.compile("(\\s)");
        // We replicate C#'s Regex.Split behavior: include captured groups.
        List<String> parts = splitKeepDelimiters(collapsed, ws);
        for (String p : parts) {
            if (p.isEmpty()) continue;
            if (" ".equals(p)) continue;
            pieces.add(ByteEncoder.METASPACE + p);
        }
        return pieces;
    }

    /** Like {@code Regex.Split} in .NET with a capturing group: keeps delimiters as separate items. */
    private static List<String> splitKeepDelimiters(String text, Pattern delim) {
        List<String> out = new ArrayList<>();
        Matcher m = delim.matcher(text);
        int last = 0;
        while (m.find()) {
            if (m.start() > last) out.add(text.substring(last, m.start()));
            out.add(m.group());
            last = m.end();
        }
        if (last < text.length()) out.add(text.substring(last));
        return out;
    }

    // ── Step 2: piece → vocab character space ──────────────────────────────

    private List<String> encodePieceToVocabSpace(String piece) {
        if ("byte_level".equals(encoder)) {
            byte[] bytes = piece.getBytes(StandardCharsets.UTF_8);
            String encoded = ByteEncoder.encodeByteLevelChars(bytes);
            return codepoints(encoded);
        }
        return codepoints(piece);
    }

    /** Split a string into its grapheme-style code points (one element per Unicode codepoint). */
    private static List<String> codepoints(String s) {
        List<String> result = new ArrayList<>(s.length());
        int i = 0;
        while (i < s.length()) {
            int cp = s.codePointAt(i);
            result.add(new String(Character.toChars(cp)));
            i += Character.charCount(cp);
        }
        return result;
    }

    // ── Step 3: BPE merges ─────────────────────────────────────────────────

    private List<String> applyBPE(List<String> tokens) {
        if (tokens.size() < 2) return tokens;

        List<String> parts = new ArrayList<>(tokens);
        while (true) {
            int bestIdx = -1;
            int bestRank = Integer.MAX_VALUE;
            for (int i = 0; i < parts.size() - 1; i++) {
                String key = parts.get(i) + ' ' + parts.get(i + 1);
                Integer r = mergeRanks.get(key);
                if (r != null && r < bestRank) {
                    bestRank = r;
                    bestIdx = i;
                }
            }
            if (bestIdx == -1) break;

            // Merge ALL non-overlapping occurrences in one pass — matches HF.
            String left = parts.get(bestIdx);
            String right = parts.get(bestIdx + 1);
            String merged = left + right;
            List<String> next = new ArrayList<>(parts.size());
            int j = 0;
            while (j < parts.size()) {
                if (j < parts.size() - 1
                        && parts.get(j).equals(left)
                        && parts.get(j + 1).equals(right)) {
                    next.add(merged);
                    j += 2;
                } else {
                    next.add(parts.get(j));
                    j += 1;
                }
            }
            parts = next;
        }
        return parts;
    }

    // ── Step 4: vocab lookup with byte fallback ────────────────────────────

    private int[] lookup(List<String> tokens) {
        List<Integer> ids = new ArrayList<>(tokens.size());
        for (String tok : tokens) {
            Integer id = vocab.get(tok);
            if (id != null) {
                ids.add(id);
                continue;
            }
            if (byteFallbackStart >= 0) {
                byte[] enc = tok.getBytes(StandardCharsets.UTF_8);
                for (byte raw : enc) ids.add(byteFallbackStart + (raw & 0xff));
            }
            // For byte_level this is unreachable for valid UTF-8 input.
        }
        int[] out = new int[ids.size()];
        for (int i = 0; i < out.length; i++) out[i] = ids.get(i);
        return out;
    }
}
