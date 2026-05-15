// Codec v0.4 version negotiation — client-side primitives.
//
// Java mirror of @codecai/web's version-signaling.ts and codecai's
// version_signaling.py. See spec/versions/v0.4.md:
//   § Version Compatibility Signaling
//   § Capabilities are opt-on at the server
//   § Graceful downgrade
package ai.codec;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

/**
 * Codec v0.4 version negotiation primitives. Static helpers — no instance state.
 */
public final class VersionSignaling {

    /** The protocol version this jar speaks. */
    public static final String CODEC_CLIENT_VERSION = "0.4";

    /** Request header name (canonical case). */
    public static final String CODEC_CLIENT_VERSION_HEADER = "Codec-Client-Version";

    /** Response header name; advisory on 2xx, load-bearing on 426. */
    public static final String CODEC_MIN_VERSION_HEADER = "Codec-Min-Version";

    /** Response header name; emitted on 426. */
    public static final String CODEC_REQUIRED_FEATURES_HEADER = "Codec-Required-Features";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private VersionSignaling() {}

    /** Add Codec-Client-Version to the request builder using the default version. */
    public static HttpRequest.Builder addClientVersionHeader(HttpRequest.Builder builder) {
        return builder.header(CODEC_CLIENT_VERSION_HEADER, CODEC_CLIENT_VERSION);
    }

    /** Add Codec-Client-Version with a caller-supplied override. */
    public static HttpRequest.Builder addClientVersionHeader(
            HttpRequest.Builder builder, String overrideVersion) {
        return builder.header(CODEC_CLIENT_VERSION_HEADER, overrideVersion);
    }

    /** Build the well-known URL for an origin. */
    public static String wellKnownVersionPolicyUrl(String origin) {
        String trimmed = origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin;
        return trimmed + "/.well-known/codec/version-policy.json";
    }

    /**
     * Body of a v0.4 server's 426 Upgrade Required response.
     */
    public record CodecVersionRequiredBody(
            String error,
            String minimumVersion,
            List<String> requiredFeatures,
            String clientVersion,
            String docsUrl,
            String deploymentId) {}

    /**
     * Shape of .well-known/codec/version-policy.json.
     */
    public record CodecVersionPolicyDocument(
            String minimumVersion,
            List<String> requiredFeatures,
            String deploymentId,
            String docsUrl,
            String validUntil) {}

    /**
     * Thrown when a v0.4-mandating server refuses with a 426.
     */
    public static final class CodecVersionRequiredException extends RuntimeException {
        public final CodecVersionRequiredBody body;

        public CodecVersionRequiredException(CodecVersionRequiredBody body) {
            super(formatMessage(body));
            this.body = body;
        }

        private static String formatMessage(CodecVersionRequiredBody body) {
            String features = body.requiredFeatures().isEmpty()
                    ? ""
                    : " (requires: " + String.join(", ", body.requiredFeatures()) + ")";
            String docs = body.docsUrl() != null && !body.docsUrl().isEmpty()
                    ? " See " + body.docsUrl()
                    : "";
            return ("Codec server requires v" + body.minimumVersion() + features
                    + "; this client speaks v" + body.clientVersion() + "." + docs).trim();
        }
    }

    /**
     * Parse a (status, body) pair into a typed exception.
     *
     * @return empty if not a 426; the exception ready to throw otherwise.
     * @throws IllegalArgumentException if the response is 426 but the body
     *     is not JSON or is not a recognized v0.4 shape — never silently
     *     swallows a 426.
     */
    public static Optional<CodecVersionRequiredException> parseVersionRequired(
            int status, String bodyText) {
        if (status != 426) return Optional.empty();
        return Optional.of(new CodecVersionRequiredException(parseBody(bodyText)));
    }

    private static CodecVersionRequiredBody parseBody(String bodyText) {
        JsonNode raw;
        try {
            raw = MAPPER.readTree(bodyText);
        } catch (IOException e) {
            throw new IllegalArgumentException(
                    "Codec server returned 426 Upgrade Required but body was not JSON: "
                            + truncate(bodyText, 200), e);
        }
        if (!raw.isObject()
                || !"codec_version_required".equals(raw.path("error").asText(null))
                || raw.path("minimum_version").asText("").isEmpty()
                || raw.path("client_version").asText("").isEmpty()
                || !raw.path("required_features").isArray()) {
            throw new IllegalArgumentException(
                    "Codec server returned 426 Upgrade Required with an unrecognized body: "
                            + truncate(bodyText, 200));
        }
        List<String> features = new ArrayList<>();
        raw.path("required_features").forEach(n -> features.add(n.asText()));
        return new CodecVersionRequiredBody(
                raw.path("error").asText(),
                raw.path("minimum_version").asText(),
                Collections.unmodifiableList(features),
                raw.path("client_version").asText(),
                nullable(raw, "docs_url"),
                nullable(raw, "deployment_id"));
    }

    private static String nullable(JsonNode raw, String field) {
        JsonNode n = raw.path(field);
        return n.isMissingNode() || n.isNull() ? null : n.asText();
    }

    /**
     * Parse and validate a version-policy JSON document.
     */
    public static CodecVersionPolicyDocument parseVersionPolicyDocument(String json) {
        JsonNode raw;
        try {
            raw = MAPPER.readTree(json);
        } catch (IOException e) {
            throw new IllegalArgumentException("version-policy doc is not JSON: " + truncate(json, 200), e);
        }
        if (!raw.isObject() || raw.path("minimum_version").asText("").isEmpty()) {
            throw new IllegalArgumentException(
                    "version-policy doc missing/invalid minimum_version");
        }
        if (!raw.path("required_features").isArray()) {
            throw new IllegalArgumentException(
                    "version-policy doc has malformed required_features");
        }
        List<String> features = new ArrayList<>();
        raw.path("required_features").forEach(n -> features.add(n.asText()));
        return new CodecVersionPolicyDocument(
                raw.path("minimum_version").asText(),
                Collections.unmodifiableList(features),
                nullable(raw, "deployment_id"),
                nullable(raw, "docs_url"),
                nullable(raw, "valid_until"));
    }

    /**
     * Pre-flight fetch of the deployment's minimum-version policy.
     * Returns empty if the server returns 404 (unrestricted deployment).
     * Throws on 5xx or malformed body.
     */
    public static Optional<CodecVersionPolicyDocument> discoverVersionPolicy(
            String origin, HttpClient client) {
        String url = wellKnownVersionPolicyUrl(origin);
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header(CODEC_CLIENT_VERSION_HEADER, CODEC_CLIENT_VERSION)
                .GET()
                .build();
        HttpResponse<String> resp;
        try {
            resp = client.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (IOException | InterruptedException e) {
            throw new RuntimeException("Failed to fetch version policy from " + url, e);
        }
        if (resp.statusCode() == 404) return Optional.empty();
        if (resp.statusCode() >= 400) {
            throw new RuntimeException(
                    "Failed to fetch version policy from " + url + ": HTTP " + resp.statusCode());
        }
        return Optional.of(parseVersionPolicyDocument(resp.body()));
    }

    private static String truncate(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n);
    }
}
