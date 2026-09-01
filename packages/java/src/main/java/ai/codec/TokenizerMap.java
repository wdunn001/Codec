// SPDX-License-Identifier: MIT
package ai.codec;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * A per-model tokenizer dialect: the data needed to encode text into
 * token IDs and decode IDs back to text. Maps are immutable once
 * published; a new model version publishes a new map at a new URL with
 * a new sha256 hash.
 *
 * <p>Schema v2: {@code vocab} is the raw HuggingFace tokenizer.json form
 * (byte-level GPT-2-encoded chars or ▁-prefixed metaspace strings).
 * {@code tokens} is the legacy v1 field, kept for backwards compatibility.
 * The Detokenizer reads from whichever is present.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public final class TokenizerMap {

    @JsonProperty("id")
    public String id = "";

    @JsonProperty("version")
    public String version = "2";

    @JsonProperty("vocab_size")
    public int vocabSize;

    /**
     * Vocabulary as { raw_token_text → id }. v2 schema field.
     */
    @JsonProperty("vocab")
    public Map<String, Integer> vocab;

    /** Legacy v1 vocabulary as { id_string → decoded_text }. */
    @JsonProperty("tokens")
    public Map<String, String> tokens;

    /** Encoder family. "byte_level", "metaspace", or null. */
    @JsonProperty("encoder")
    public String encoder;

    /** BPE merges in priority order. */
    @JsonProperty("merges")
    public java.util.List<String> merges;

    /** Pre-tokenizer regex pattern. Required for byte_level BPE. */
    @JsonProperty("pre_tokenizer_pattern")
    public String preTokenizerPattern;

    /** First ID in the byte-fallback range (inclusive). SentencePiece only. */
    @JsonProperty("byte_fallback_start")
    public Integer byteFallbackStart;

    /** Last ID in the byte-fallback range (inclusive). SentencePiece only. */
    @JsonProperty("byte_fallback_end")
    public Integer byteFallbackEnd;

    /** Named special tokens. Skipped during text rendering by default. */
    @JsonProperty("special_tokens")
    public Map<String, Integer> specialTokens;

    /**
     * Per-model tool-calling convention. Optional; populated by
     * {@code @codecai/maps-cli} when it detects a known chat-template
     * signature. Absence means "convention not declared in this map": see
     * {@code spec/PROTOCOL.md} § "Tool-call calling conventions in the map".
     */
    @JsonProperty("tool_calling")
    public ToolCallingBlock toolCalling;

    /** ISO 8601 publish timestamp. Informational. */
    @JsonProperty("published_at")
    public String publishedAt;

    public TokenizerMap() {}

    // ── Static parse + validate ─────────────────────────────────────────────

    private static final ObjectMapper MAPPER = createMapper();

    private static ObjectMapper createMapper() {
        ObjectMapper m = new ObjectMapper();
        m.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
        m.configure(JsonParser.Feature.ALLOW_COMMENTS, true);
        return m;
    }

    /** Parse a TokenizerMap from JSON bytes. */
    public static TokenizerMap fromJson(byte[] json) {
        TokenizerMap map;
        try {
            map = MAPPER.readValue(json, TokenizerMap.class);
        } catch (IOException e) {
            throw new TokenizerMapValidationException("payload deserialised with error: " + e.getMessage());
        }
        if (map == null)
            throw new TokenizerMapValidationException("payload deserialised to null");
        validate(map);
        return map;
    }

    /** Parse from a UTF-8 string. */
    public static TokenizerMap fromJson(String json) {
        return fromJson(json.getBytes(StandardCharsets.UTF_8));
    }

    /** Throws {@link TokenizerMapValidationException} if the map is malformed. */
    public static void validate(TokenizerMap map) {
        if (map.id == null || map.id.isEmpty())
            throw new TokenizerMapValidationException("id must be a non-empty string");
        if (map.version == null || map.version.isEmpty())
            throw new TokenizerMapValidationException("version must be a non-empty string");
        if (map.vocabSize < 1)
            throw new TokenizerMapValidationException("vocab_size must be a positive integer");
        boolean hasVocab = map.vocab != null && !map.vocab.isEmpty();
        boolean hasTokens = map.tokens != null && !map.tokens.isEmpty();
        if (!hasVocab && !hasTokens)
            throw new TokenizerMapValidationException("one of `vocab` (v2) or `tokens` (v1) is required");
        if (map.encoder != null
                && !map.encoder.equals("byte_level")
                && !map.encoder.equals("metaspace"))
            throw new TokenizerMapValidationException(
                    "encoder must be \"byte_level\" or \"metaspace\" if present, got \"" + map.encoder + "\"");
        if ((map.byteFallbackStart != null) != (map.byteFallbackEnd != null))
            throw new TokenizerMapValidationException(
                    "byte_fallback_start and byte_fallback_end must both be set or both omitted");
        if (map.toolCalling != null) {
            ToolCallingBlock tc = map.toolCalling;
            if (tc.convention == null)
                throw new TokenizerMapValidationException("tool_calling.convention is required");
            if (tc.argsFormat == null)
                throw new TokenizerMapValidationException("tool_calling.args_format is required");
            if (tc.resultFormat == null)
                throw new TokenizerMapValidationException("tool_calling.result_format is required");
            if (tc.markers == null
                    || tc.markers.start == null || tc.markers.start.isEmpty()
                    || tc.markers.end == null || tc.markers.end.isEmpty())
                throw new TokenizerMapValidationException(
                        "tool_calling.markers.start/.end must both be non-empty strings");
            if (map.specialTokens == null
                    || !map.specialTokens.containsKey(tc.markers.start)
                    || !map.specialTokens.containsKey(tc.markers.end))
                throw new TokenizerMapValidationException(
                        "tool_calling.markers.start (\"" + tc.markers.start + "\") and .end (\""
                        + tc.markers.end + "\") must both exist as keys in special_tokens");
        }
    }

    /** Compute sha256 of a payload as lowercase hex (utility). */
    public static String sha256Hex(byte[] payload) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(payload);
            StringBuilder sb = new StringBuilder(64);
            for (byte b : hash) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new UncheckedIOException("SHA-256 unavailable", new IOException(e));
        }
    }

    /** Verify the given bytes hash to the expected digest. Accepts {@code sha256:hex} or bare hex. */
    public static void verifySha256(byte[] payload, String expected) {
        String e = parseHash(expected);
        String a = sha256Hex(payload);
        if (!e.equalsIgnoreCase(a))
            throw new TokenizerMapHashMismatchException(e, a);
    }

    private static String parseHash(String hash) {
        int colon = hash.indexOf(':');
        if (colon < 0) return hash.toLowerCase(java.util.Locale.ROOT);
        String algo = hash.substring(0, colon).toLowerCase(java.util.Locale.ROOT);
        if (!algo.equals("sha256"))
            throw new UnsupportedOperationException("Unsupported hash algorithm: " + algo + " (only sha256 supported)");
        return hash.substring(colon + 1).toLowerCase(java.util.Locale.ROOT);
    }
}
