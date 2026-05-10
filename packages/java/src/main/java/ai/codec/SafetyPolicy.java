// SPDX-License-Identifier: MIT
package ai.codec;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.core.util.DefaultIndenter;
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;

/**
 * Validation, canonical JSON, hashing, and HTTP loader/discoverer for
 * {@link SafetyPolicyDescriptor}. Java twin of {@code @codecai/web}'s
 * {@code safety-policy.ts}, {@code codecai.safety_policy} (Python),
 * {@code codec_rs::safety_policy} (Rust), and {@code Codec.SafetyPolicy}
 * (.NET).
 *
 * <p>The cross-stack contract: a descriptor that hashes to
 * {@code sha256:abc…} in any client hashes to the identical digest
 * here. {@link #canonicalBytes} emits 2-space-indent + trailing-newline
 * JSON with null-omitted, matching every other client's output.
 *
 * <p>Discovery follows the existing tokenizer-map convention:
 * <ul>
 *   <li>{@code <origin>/.well-known/codec/policies/<id>.json}         (mutable)</li>
 *   <li>{@code <origin>/.well-known/codec/policies/sha256/<hex>.json} (immutable)</li>
 * </ul>
 */
public final class SafetyPolicy {
    private SafetyPolicy() {}

    public static final String POLICY_WELL_KNOWN_BASE = "/.well-known/codec/policies";

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Set<String> VALID_ACTIONS =
            Set.of("stop", "redact", "regenerate", "flag");
    private static final Set<String> VALID_HOSTS =
            Set.of("server", "client", "both");
    private static final Set<String> VALID_ENGINE_FEATURES =
            Set.of("logits_processor", "hidden_states", "sampling_chain");

    private static final Pattern CATEGORY_NAME = Pattern.compile("^[a-z0-9_-]+$");
    private static final Pattern POLICY_ID = Pattern.compile("^[a-z0-9._/-]+$");
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$", Pattern.CASE_INSENSITIVE);

    private static final HttpClient DEFAULT_HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(30))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    // ── Validation ──────────────────────────────────────────────────────────

    /**
     * Validate a parsed JSON node against the descriptor schema.
     *
     * @throws SafetyPolicyValidationException with a clean message on
     *     any shape violation. Returns silently on success.
     */
    public static void validate(JsonNode value) {
        if (value == null || !value.isObject())
            throw new SafetyPolicyValidationException("not an object");

        String id = textOrNull(value, "id");
        if (id == null || id.isEmpty())
            throw new SafetyPolicyValidationException("id must be a non-empty string");

        if (textOrNull(value, "version") == null)
            throw new SafetyPolicyValidationException("version must be a string");

        JsonNode tokenizers = value.get("tokenizers");
        if (tokenizers == null || !tokenizers.isArray() || tokenizers.size() == 0)
            throw new SafetyPolicyValidationException(
                    "tokenizers must be a non-empty array of tokenizer ids");
        for (JsonNode t : tokenizers)
            if (!t.isTextual())
                throw new SafetyPolicyValidationException("tokenizers entries must be strings");

        JsonNode categories = value.get("categories");
        if (categories == null || !categories.isArray() || categories.size() == 0)
            throw new SafetyPolicyValidationException("categories must be a non-empty array");
        for (JsonNode c : categories) {
            if (!c.isObject())
                throw new SafetyPolicyValidationException("category entry must be an object");
            String name = textOrNull(c, "name");
            if (name == null)
                throw new SafetyPolicyValidationException("category.name must be a string");
            if (!CATEGORY_NAME.matcher(name).matches())
                throw new SafetyPolicyValidationException(
                        "category.name must match " + CATEGORY_NAME + " (got \"" + name + "\")");
            String action = textOrNull(c, "action");
            if (action == null || !VALID_ACTIONS.contains(action))
                throw new SafetyPolicyValidationException(
                        "category.action for \"" + name + "\" must be one of stop|redact|regenerate|flag");
            JsonNode desc = c.get("description");
            if (desc != null && !desc.isNull() && !desc.isTextual())
                throw new SafetyPolicyValidationException(
                        "category.description for \"" + name + "\" must be a string when present");
        }

        JsonNode classifier = value.get("classifier");
        if (classifier == null || !classifier.isObject())
            throw new SafetyPolicyValidationException("classifier must be an object");
        String family = textOrNull(classifier, "family");
        if (family == null || family.isEmpty())
            throw new SafetyPolicyValidationException(
                    "classifier.family must be a non-empty string");
        JsonNode host = classifier.get("host");
        if (host != null && !host.isNull()) {
            String h = host.isTextual() ? host.asText() : "<not-string>";
            if (!VALID_HOSTS.contains(h))
                throw new SafetyPolicyValidationException(
                        "classifier.host must be one of server|client|both (got \"" + h + "\")");
        }
        JsonNode feats = classifier.get("requires_engine_features");
        if (feats != null && !feats.isNull()) {
            if (!feats.isArray())
                throw new SafetyPolicyValidationException(
                        "classifier.requires_engine_features must be an array");
            for (JsonNode f : feats) {
                if (!f.isTextual())
                    throw new SafetyPolicyValidationException(
                            "classifier.requires_engine_features entry must be a string");
                if (!VALID_ENGINE_FEATURES.contains(f.asText()))
                    throw new SafetyPolicyValidationException(
                            "classifier.requires_engine_features entry must be one of "
                                    + "logits_processor|hidden_states|sampling_chain "
                                    + "(got \"" + f.asText() + "\")");
            }
        }

        JsonNode rs = value.get("rules_summary");
        if (rs != null && !rs.isNull()) {
            if (!rs.isObject())
                throw new SafetyPolicyValidationException(
                        "rules_summary must be an object when present");
            for (String key : List.of(
                    "banned_token_id_count", "regex_pattern_count",
                    "grammar_constraint_count", "multi_token_pattern_count")) {
                JsonNode v = rs.get(key);
                if (v != null && !v.isNull()) {
                    if (!v.isIntegralNumber() || v.asLong() < 0)
                        throw new SafetyPolicyValidationException(
                                "rules_summary." + key + " must be a non-negative integer when present");
                }
            }
        }
    }

    /**
     * Parse + validate a JSON byte slice into a typed
     * {@link SafetyPolicyDescriptor}. Validates the parsed JsonNode
     * first (clean error messages) before deserializing.
     */
    public static SafetyPolicyDescriptor fromJson(byte[] bytes) {
        try {
            JsonNode node = MAPPER.readTree(bytes);
            validate(node);
            return MAPPER.treeToValue(node, SafetyPolicyDescriptor.class);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ── Canonical bytes + hash ──────────────────────────────────────────────

    /**
     * Canonical JSON serialization for hashing + well-known publish.
     * Matches the TS / Python / Rust / .NET / Pydantic format: 2-space
     * indent + trailing newline + null-omitted (Jackson's
     * {@code NON_NULL} on the descriptor types).
     */
    public static byte[] canonicalBytes(SafetyPolicyDescriptor d) {
        try {
            ObjectMapper m = MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT);
            DefaultPrettyPrinter pp = new DefaultPrettyPrinter();
            DefaultIndenter twoSpace = new DefaultIndenter("  ", "\n");
            pp.indentObjectsWith(twoSpace);
            pp.indentArraysWith(twoSpace);
            byte[] body = m.writer(pp).writeValueAsBytes(d);
            byte[] out = new byte[body.length + 1];
            System.arraycopy(body, 0, out, 0, body.length);
            out[body.length] = (byte) '\n';
            return out;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * Canonical sha256 hash. Returns {@code sha256:<64 hex chars>}
     * matching what {@code codecai-maps policies-hash} emits.
     */
    public static String hash(SafetyPolicyDescriptor d) {
        try {
            byte[] bytes = canonicalBytes(d);
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            return "sha256:" + HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is required by every JVM; this can't happen.
            throw new IllegalStateException(e);
        }
    }

    // ── URL builders ────────────────────────────────────────────────────────

    /** Per-policy URL by mutable id (e.g. {@code acme/strict-v3}). */
    public static String wellKnownPolicyUrl(String origin, String policyId) {
        encodePolicyId(policyId);
        return stripTrailingSlash(origin) + POLICY_WELL_KNOWN_BASE + "/" + policyId + ".json";
    }

    /** Content-addressed URL by sha256 hex. */
    public static String wellKnownPolicyHashUrl(String origin, String hashHex) {
        if (!HEX64.matcher(hashHex).matches())
            throw new SafetyPolicyDiscoveryException(
                    "Invalid policy hash hex: must be 64-char lowercase hex (got \"" + hashHex + "\")");
        return stripTrailingSlash(origin) + POLICY_WELL_KNOWN_BASE
                + "/sha256/" + hashHex.toLowerCase(Locale.ROOT) + ".json";
    }

    // ── Loader + discovery ─────────────────────────────────────────────────

    /** Synchronously fetch + verify + parse a descriptor by URL. */
    public static SafetyPolicyDescriptor load(String url, String hash) {
        return load(url, hash, DEFAULT_HTTP);
    }

    public static SafetyPolicyDescriptor load(String url, String hash, HttpClient http) {
        try {
            return loadAsync(url, hash, http).get();
        } catch (Exception e) {
            Throwable c = e.getCause() != null ? e.getCause() : e;
            if (c instanceof SafetyPolicyHashMismatchException sm) throw sm;
            if (c instanceof SafetyPolicyValidationException sv) throw sv;
            if (c instanceof SafetyPolicyDiscoveryException sd) throw sd;
            if (c instanceof RuntimeException re) throw re;
            throw new RuntimeException(c);
        }
    }

    public static CompletableFuture<SafetyPolicyDescriptor> loadAsync(
            String url, String hash, HttpClient http) {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Accept", "application/json")
                .GET().build();
        return http.sendAsync(req, HttpResponse.BodyHandlers.ofByteArray())
                .thenApply(resp -> {
                    int code = resp.statusCode();
                    if (code < 200 || code >= 300)
                        throw new RuntimeException("SafetyPolicy.load: HTTP " + code + " from " + url);
                    byte[] bytes = resp.body();
                    if (hash != null) {
                        String expected = parseHash(hash);
                        String actual = sha256Hex(bytes);
                        if (!expected.equalsIgnoreCase(actual))
                            throw new SafetyPolicyHashMismatchException(expected, actual);
                    }
                    return fromJson(bytes);
                });
    }

    /**
     * Synchronously resolve a descriptor via
     * {@code .well-known/codec/policies/}.
     *
     * <p>Hash present → fetches the immutable content-addressed sibling
     * and verifies bytes. Hash absent → fetches the mutable per-id
     * document and follows pointers.
     */
    public static SafetyPolicyDescriptor discover(String origin, String id, String hash) {
        return discover(origin, id, hash, DEFAULT_HTTP);
    }

    public static SafetyPolicyDescriptor discover(
            String origin, String id, String hash, HttpClient http) {
        try {
            return discoverAsync(origin, id, hash, http).get();
        } catch (Exception e) {
            Throwable c = e.getCause() != null ? e.getCause() : e;
            if (c instanceof SafetyPolicyHashMismatchException sm) throw sm;
            if (c instanceof SafetyPolicyValidationException sv) throw sv;
            if (c instanceof SafetyPolicyDiscoveryException sd) throw sd;
            if (c instanceof RuntimeException re) throw re;
            throw new RuntimeException(c);
        }
    }

    public static CompletableFuture<SafetyPolicyDescriptor> discoverAsync(
            String origin, String id, String hash, HttpClient http) {
        if (hash != null) {
            String hashHex = parseHash(hash);
            String url = wellKnownPolicyHashUrl(origin, hashHex);
            return get(http, url).thenCompose(resp -> {
                int code = resp.statusCode();
                if (code == 404)
                    throw new SafetyPolicyDiscoveryException.NotFound(url, code);
                if (code < 200 || code >= 300)
                    throw new RuntimeException("SafetyPolicy.discover: HTTP " + code + " from " + url);
                byte[] bytes = resp.body();
                String actual = sha256Hex(bytes);
                if (!actual.equalsIgnoreCase(hashHex))
                    throw new SafetyPolicyHashMismatchException(hashHex, actual);
                return CompletableFuture.completedFuture(followMaybePointer(bytes, id, http));
            });
        }
        String url = wellKnownPolicyUrl(origin, id);
        return get(http, url).thenCompose(resp -> {
            int code = resp.statusCode();
            if (code == 404)
                throw new SafetyPolicyDiscoveryException.NotFound(url, code);
            if (code < 200 || code >= 300)
                throw new RuntimeException("SafetyPolicy.discover: HTTP " + code + " from " + url);
            return CompletableFuture.completedFuture(followMaybePointer(resp.body(), id, http));
        });
    }

    // ── internals ──────────────────────────────────────────────────────────

    private static SafetyPolicyDescriptor followMaybePointer(
            byte[] bytes, String expectedId, HttpClient http) {
        try {
            JsonNode root = MAPPER.readTree(bytes);
            if (isPointerShape(root)) {
                SafetyPolicyDescriptor.Pointer p =
                        MAPPER.treeToValue(root, SafetyPolicyDescriptor.Pointer.class);
                validatePointer(p, expectedId);
                return load(p.url, p.hash, http);
            }
            SafetyPolicyDescriptor d = fromJson(bytes);
            if (!expectedId.equals(d.id))
                throw new SafetyPolicyDiscoveryException(
                        "Inline descriptor id \"" + d.id + "\" does not match requested id \""
                                + expectedId + "\"");
            return d;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static boolean isPointerShape(JsonNode obj) {
        if (obj == null || !obj.isObject()) return false;
        JsonNode id = obj.get("id");
        JsonNode url = obj.get("url");
        JsonNode hash = obj.get("hash");
        return id != null && id.isTextual()
                && url != null && url.isTextual()
                && hash != null && hash.isTextual()
                && !obj.has("categories");
    }

    private static void validatePointer(SafetyPolicyDescriptor.Pointer p, String expectedId) {
        if (!expectedId.equals(p.id))
            throw new SafetyPolicyDiscoveryException(
                    "Pointer id \"" + p.id + "\" does not match requested id \"" + expectedId + "\"");
        if (!(p.url.startsWith("https://") || p.url.startsWith("http://")))
            throw new SafetyPolicyDiscoveryException(
                    "Pointer url must be http(s): got \"" + p.url + "\"");
        if (!Pattern.matches("^sha256:[0-9a-fA-F]{64}$", p.hash))
            throw new SafetyPolicyDiscoveryException(
                    "Pointer hash must be sha256:<64 hex chars>: got \"" + p.hash + "\"");
    }

    private static String encodePolicyId(String id) {
        if (!POLICY_ID.matcher(id).matches())
            throw new SafetyPolicyDiscoveryException(
                    "Invalid policy id \"" + id + "\": must match [a-z0-9._/-]+");
        if (id.contains("..") || id.startsWith("/") || id.endsWith("/"))
            throw new SafetyPolicyDiscoveryException(
                    "Invalid policy id \"" + id + "\": path traversal or empty segment");
        return id;
    }

    private static String parseHash(String hash) {
        int idx = hash.indexOf(':');
        if (idx < 0) return hash.toLowerCase(Locale.ROOT);
        String algo = hash.substring(0, idx).toLowerCase(Locale.ROOT);
        if (!"sha256".equals(algo))
            throw new IllegalArgumentException(
                    "Unsupported hash algorithm: " + algo + " (only sha256 supported)");
        return hash.substring(idx + 1).toLowerCase(Locale.ROOT);
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    private static String textOrNull(JsonNode obj, String key) {
        JsonNode v = obj.get(key);
        return v != null && v.isTextual() ? v.asText() : null;
    }

    private static CompletableFuture<HttpResponse<byte[]>> get(HttpClient http, String url) {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Accept", "application/json")
                .GET().build();
        return http.sendAsync(req, HttpResponse.BodyHandlers.ofByteArray());
    }
}
