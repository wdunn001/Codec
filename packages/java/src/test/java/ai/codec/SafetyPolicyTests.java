// SPDX-License-Identifier: MIT
package ai.codec;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Java parity tests for slice 11. Mirrors the TS / Python / Rust /
 * .NET suites — same shape, same assertions.
 */
class SafetyPolicyTests {

    private static final ObjectMapper M = new ObjectMapper();

    private static SafetyPolicyDescriptor buildValid() {
        SafetyPolicyDescriptor d = new SafetyPolicyDescriptor();
        d.id = "acme/strict-v3";
        d.version = "1";
        d.tokenizers = List.of("meta-llama/llama-3");

        SafetyPolicyDescriptor.Category c1 = new SafetyPolicyDescriptor.Category();
        c1.name = "secrets"; c1.action = "stop";
        SafetyPolicyDescriptor.Category c2 = new SafetyPolicyDescriptor.Category();
        c2.name = "pii"; c2.action = "redact"; c2.description = "Email and phone.";
        d.categories = List.of(c1, c2);

        SafetyPolicyDescriptor.ClassifierBlock cls = new SafetyPolicyDescriptor.ClassifierBlock();
        cls.family = "llama-guard-3-1b";
        cls.host = "server";
        cls.requiresEngineFeatures = List.of("logits_processor", "sampling_chain");
        d.classifier = cls;

        SafetyPolicyDescriptor.RulesSummary rs = new SafetyPolicyDescriptor.RulesSummary();
        rs.bannedTokenIdCount = 4128L;
        rs.regexPatternCount = 47L;
        d.rulesSummary = rs;

        SafetyPolicyDescriptor.ClientHooksBlock ch = new SafetyPolicyDescriptor.ClientHooksBlock();
        ch.prefilterCategories = List.of("secrets", "pii");
        ch.clientClassifierFamily = "prompt-guard-86m";
        d.clientHooks = ch;

        d.publishedAt = "2026-05-09T00:00:00Z";
        return d;
    }

    // ── Validation ─────────────────────────────────────────────────────────

    @Test
    void validate_acceptsMinimalValidDescriptor() throws Exception {
        var bytes = SafetyPolicy.canonicalBytes(buildValid());
        SafetyPolicy.validate(M.readTree(bytes));
    }

    @Test
    void validate_rejectsMissingRequiredFields() throws Exception {
        assertThrows(SafetyPolicyValidationException.class,
                () -> SafetyPolicy.validate(M.readTree("{}")));
    }

    @Test
    void validate_rejectsBadCategoryName() throws Exception {
        var bad = """
            {"id": "x/y", "version": "1", "tokenizers": ["t"],
             "categories": [{"name": "BadCaps", "action": "stop"}],
             "classifier": {"family": "f"}}
            """;
        assertThrows(SafetyPolicyValidationException.class,
                () -> SafetyPolicy.validate(M.readTree(bad)));
    }

    @Test
    void validate_rejectsUnknownAction() throws Exception {
        var bad = """
            {"id": "x/y", "version": "1", "tokenizers": ["t"],
             "categories": [{"name": "secrets", "action": "banhammer"}],
             "classifier": {"family": "f"}}
            """;
        assertThrows(SafetyPolicyValidationException.class,
                () -> SafetyPolicy.validate(M.readTree(bad)));
    }

    @Test
    void validate_rejectsUnknownEngineFeature() throws Exception {
        var bad = """
            {"id": "x/y", "version": "1", "tokenizers": ["t"],
             "categories": [{"name": "secrets", "action": "stop"}],
             "classifier": {"family": "f",
                            "requires_engine_features": ["weather_api"]}}
            """;
        assertThrows(SafetyPolicyValidationException.class,
                () -> SafetyPolicy.validate(M.readTree(bad)));
    }

    // ── Hashing ────────────────────────────────────────────────────────────

    @Test
    void hash_isDeterministicForIdenticalInput() {
        var d = buildValid();
        var a = SafetyPolicy.hash(d);
        var b = SafetyPolicy.hash(d);
        assertEquals(a, b);
        assertTrue(a.startsWith("sha256:"));
        assertEquals(64, a.substring(7).length());
    }

    @Test
    void hash_differsWhenCategoryActionChanges() {
        var d1 = buildValid();
        var d2 = buildValid();
        d2.categories.get(0).action = "flag";
        assertNotEquals(SafetyPolicy.hash(d1), SafetyPolicy.hash(d2));
    }

    @Test
    void canonicalBytes_2SpaceIndentTrailingNewline() {
        var raw = SafetyPolicy.canonicalBytes(buildValid());
        var text = new String(raw);
        assertTrue(text.endsWith("\n"));
        assertTrue(text.contains("\n  "));
        // round-trips through Jackson
        assertDoesNotThrow(() -> M.readTree(text));
    }

    // ── URL builders ───────────────────────────────────────────────────────

    @Test
    void wellKnownPolicyUrl_preservesSlashes() {
        assertEquals(
                "https://acme.example/.well-known/codec/policies/acme/strict-v3.json",
                SafetyPolicy.wellKnownPolicyUrl("https://acme.example/", "acme/strict-v3"));
    }

    @Test
    void wellKnownPolicyUrl_rejectsTraversal() {
        assertThrows(SafetyPolicyDiscoveryException.class,
                () -> SafetyPolicy.wellKnownPolicyUrl("https://acme.example", "../etc"));
        assertThrows(SafetyPolicyDiscoveryException.class,
                () -> SafetyPolicy.wellKnownPolicyUrl("https://acme.example", "/abs"));
        assertThrows(SafetyPolicyDiscoveryException.class,
                () -> SafetyPolicy.wellKnownPolicyUrl("https://acme.example", "trailing/"));
    }

    @Test
    void wellKnownPolicyUrl_rejectsBadCharset() {
        assertThrows(SafetyPolicyDiscoveryException.class,
                () -> SafetyPolicy.wellKnownPolicyUrl("https://acme.example", "Acme/Strict"));
    }

    @Test
    void wellKnownPolicyHashUrl_usesSha256Path() {
        var hex = "a".repeat(64);
        assertEquals(
                "https://acme.example/.well-known/codec/policies/sha256/" + hex + ".json",
                SafetyPolicy.wellKnownPolicyHashUrl("https://acme.example", hex));
    }

    @Test
    void wellKnownPolicyHashUrl_rejectsMalformedHex() {
        assertThrows(SafetyPolicyDiscoveryException.class,
                () -> SafetyPolicy.wellKnownPolicyHashUrl("https://acme.example", "not-hex"));
    }

    // ── Round-trip ─────────────────────────────────────────────────────────

    @Test
    void roundTrip_descriptorBytesParse() {
        var d = buildValid();
        var bytes = SafetyPolicy.canonicalBytes(d);
        var d2 = SafetyPolicy.fromJson(bytes);
        assertEquals(d.id, d2.id);
        assertEquals(d.categories.size(), d2.categories.size());
        assertEquals(d.classifier.family, d2.classifier.family);
    }

    @Test
    void fromJson_rejectsBadShape() {
        assertThrows(SafetyPolicyValidationException.class,
                () -> SafetyPolicy.fromJson("{}".getBytes()));
    }

    // ── Cross-stack hash sanity ────────────────────────────────────────────

    @Test
    void hash_matchesDirectSha256OfCanonicalBytes() throws Exception {
        var d = buildValid();
        var bytes = SafetyPolicy.canonicalBytes(d);
        var direct = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        var via = SafetyPolicy.hash(d).substring("sha256:".length());
        assertEquals(direct, via);
    }
}
