package ai.codec;

import ai.codec.VersionSignaling.CodecVersionPolicyDocument;
import ai.codec.VersionSignaling.CodecVersionRequiredException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.net.http.HttpRequest;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

class VersionSignalingTests {

    private static final String VALID_BODY = """
        {
          "error": "codec_version_required",
          "minimum_version": "0.4",
          "required_features": ["safety-policy-enforcement"],
          "client_version": "0.3",
          "docs_url": "https://codecai.net/docs/version-negotiation/",
          "deployment_id": "lab-test"
        }
        """;

    // ── addClientVersionHeader ─────────────────────────────────────────

    @Test
    void addClientVersionHeader_stampsHeader() {
        HttpRequest req = VersionSignaling
                .addClientVersionHeader(HttpRequest.newBuilder().uri(java.net.URI.create("https://x.test/")))
                .GET()
                .build();
        Optional<String> v = req.headers().firstValue(VersionSignaling.CODEC_CLIENT_VERSION_HEADER);
        assertTrue(v.isPresent());
        assertEquals(VersionSignaling.CODEC_CLIENT_VERSION, v.get());
    }

    @Test
    void addClientVersionHeader_respectsOverride() {
        HttpRequest req = VersionSignaling
                .addClientVersionHeader(
                        HttpRequest.newBuilder().uri(java.net.URI.create("https://x.test/")),
                        "0.2")
                .GET()
                .build();
        assertEquals(
                "0.2",
                req.headers()
                        .firstValue(VersionSignaling.CODEC_CLIENT_VERSION_HEADER)
                        .orElse(""));
    }

    @Test
    void wellKnownUrl_trimsTrailingSlash() {
        assertEquals(
                "https://x.test/.well-known/codec/version-policy.json",
                VersionSignaling.wellKnownVersionPolicyUrl("https://x.test/"));
    }

    // ── parseVersionRequired ───────────────────────────────────────────

    @Test
    void parse_returnsEmptyForNon426() {
        Optional<CodecVersionRequiredException> err =
                VersionSignaling.parseVersionRequired(200, "{\"ok\":true}");
        assertTrue(err.isEmpty());
    }

    @Test
    void parse_returnsTypedExceptionForValid426() {
        Optional<CodecVersionRequiredException> err =
                VersionSignaling.parseVersionRequired(426, VALID_BODY);
        assertTrue(err.isPresent());
        CodecVersionRequiredException e = err.get();
        assertEquals("0.4", e.body.minimumVersion());
        assertEquals("0.3", e.body.clientVersion());
        assertEquals(List.of("safety-policy-enforcement"), e.body.requiredFeatures());
        assertEquals("https://codecai.net/docs/version-negotiation/", e.body.docsUrl());
        assertEquals("lab-test", e.body.deploymentId());
        assertTrue(e.getMessage().contains("requires v0.4"));
        assertTrue(e.getMessage().contains("safety-policy-enforcement"));
        assertTrue(e.getMessage().contains("speaks v0.3"));
    }

    @Test
    void parse_throwsOnNonJsonBody() {
        assertThrows(IllegalArgumentException.class,
                () -> VersionSignaling.parseVersionRequired(426, "plain text refusal"));
    }

    @Test
    void parse_throwsOnUnrecognizedShape() {
        assertThrows(IllegalArgumentException.class,
                () -> VersionSignaling.parseVersionRequired(
                        426, "{\"error\":\"something_else\",\"foo\":1}"));
    }

    @Test
    void parse_handlesEmptyRequiredFeatures() {
        String body = """
            {
              "error": "codec_version_required",
              "minimum_version": "0.4",
              "required_features": [],
              "client_version": "0.3"
            }
            """;
        Optional<CodecVersionRequiredException> err =
                VersionSignaling.parseVersionRequired(426, body);
        assertTrue(err.isPresent());
        assertEquals(List.of(), err.get().body.requiredFeatures());
        assertFalse(err.get().getMessage().contains("requires:"));
    }

    // ── parseVersionPolicyDocument ─────────────────────────────────────

    @Test
    void parsePolicyDoc_valid() {
        String body = """
            {
              "minimum_version": "0.4",
              "required_features": ["safety-policy-enforcement"],
              "deployment_id": "acme-prod"
            }
            """;
        CodecVersionPolicyDocument doc = VersionSignaling.parseVersionPolicyDocument(body);
        assertEquals("0.4", doc.minimumVersion());
        assertEquals(List.of("safety-policy-enforcement"), doc.requiredFeatures());
        assertEquals("acme-prod", doc.deploymentId());
    }

    @Test
    void parsePolicyDoc_rejectsMissingMinVersion() {
        assertThrows(IllegalArgumentException.class,
                () -> VersionSignaling.parseVersionPolicyDocument("{\"required_features\":[]}"));
    }

    @Test
    void parsePolicyDoc_rejectsMalformedFeatures() {
        assertThrows(IllegalArgumentException.class,
                () -> VersionSignaling.parseVersionPolicyDocument(
                        "{\"minimum_version\":\"0.4\",\"required_features\":\"not a list\"}"));
    }

    // ── Matrix: client × server config ─────────────────────────────────

    static Stream<Arguments> matrixCases() {
        String[] clients = {"0.2", "0.3", "0.4", "0.5"};
        return Stream.of(
                // default-off: no refusal anywhere
                Stream.of(clients).map(c -> Arguments.of("default-off", c, false, List.of())),
                // safety-enforced: refuse v0.2 + v0.3
                Stream.of(clients).map(c -> Arguments.of(
                        "safety-enforced", c, isOld(c), List.of("safety-policy-enforcement"))),
                // version-policy-strict: refuse v0.2 + v0.3, no specific features
                Stream.of(clients).map(c -> Arguments.of(
                        "version-policy-strict", c, isOld(c), List.<String>of()))
        ).flatMap(s -> s);
    }

    private static boolean isOld(String v) {
        return v.equals("0.2") || v.equals("0.3");
    }

    @ParameterizedTest
    @MethodSource("matrixCases")
    void matrix(String serverName, String clientVersion, boolean refused, List<String> features) {
        if (refused) {
            String featuresJson = features.isEmpty()
                    ? ""
                    : String.join(",", features.stream().map(f -> "\"" + f + "\"").toList());
            String body = "{\"error\":\"codec_version_required\","
                    + "\"minimum_version\":\"0.4\","
                    + "\"required_features\":[" + featuresJson + "],"
                    + "\"client_version\":\"" + clientVersion + "\"}";
            Optional<CodecVersionRequiredException> err =
                    VersionSignaling.parseVersionRequired(426, body);
            assertTrue(err.isPresent(),
                    "server=" + serverName + " client=" + clientVersion);
            assertEquals("0.4", err.get().body.minimumVersion());
            assertEquals(clientVersion, err.get().body.clientVersion());
            assertEquals(features, err.get().body.requiredFeatures());
        } else {
            Optional<CodecVersionRequiredException> err =
                    VersionSignaling.parseVersionRequired(200, "{\"ok\":true}");
            assertTrue(err.isEmpty(),
                    "server=" + serverName + " client=" + clientVersion);
        }
    }
}
