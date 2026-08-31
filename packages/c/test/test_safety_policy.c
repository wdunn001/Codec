/* C parity tests for slice 11 — mirrors the TS / Python / Rust /
 * .NET / Java suites at the parser-and-URL-builder layer. */
#include "codec/codec_safety_policy.h"
#include "codec_test.h"

#include <stdio.h>
#include <string.h>

static const char VALID_DESCRIPTOR[] =
"{"
"  \"id\": \"acme/strict-v3\","
"  \"version\": \"1\","
"  \"tokenizers\": [\"meta-llama/llama-3\"],"
"  \"categories\": ["
"    {\"name\": \"secrets\", \"action\": \"stop\"},"
"    {\"name\": \"pii\", \"action\": \"redact\", \"description\": \"Email and phone.\"}"
"  ],"
"  \"classifier\": {"
"    \"family\": \"llama-guard-3-1b\","
"    \"host\": \"server\""
"  },"
"  \"category_registry\": \"mlcommons/ailuminate-v0.5\","
"  \"published_at\": \"2026-05-09T00:00:00Z\""
"}";

/* ── Parser ─────────────────────────────────────────────────────────────── */

static void test_parse_valid_descriptor(void) {
    codec_safety_policy_t *p = NULL;
    CT_EQ_INT(codec_safety_policy_from_json(VALID_DESCRIPTOR,
                                            sizeof(VALID_DESCRIPTOR) - 1, &p),
              CODEC_OK);
    CT_TRUE(p != NULL);
    CT_EQ_STR(codec_safety_policy_id(p), "acme/strict-v3");
    CT_EQ_STR(codec_safety_policy_version(p), "1");
    CT_EQ_SZ(codec_safety_policy_tokenizer_count(p), 1);
    CT_EQ_STR(codec_safety_policy_tokenizer(p, 0), "meta-llama/llama-3");
    CT_EQ_SZ(codec_safety_policy_category_count(p), 2);
    CT_EQ_STR(codec_safety_policy_category_name(p, 0), "secrets");
    CT_EQ_INT((int)codec_safety_policy_category_action(p, 0), (int)CODEC_SAFETY_ACTION_STOP);
    CT_EQ_STR(codec_safety_policy_category_name(p, 1), "pii");
    CT_EQ_INT((int)codec_safety_policy_category_action(p, 1), (int)CODEC_SAFETY_ACTION_REDACT);
    CT_EQ_STR(codec_safety_policy_category_description(p, 1), "Email and phone.");
    CT_EQ_STR(codec_safety_policy_classifier_family(p), "llama-guard-3-1b");
    CT_EQ_INT((int)codec_safety_policy_classifier_host(p), (int)CODEC_CLASSIFIER_HOST_SERVER);
    CT_EQ_STR(codec_safety_policy_category_registry(p), "mlcommons/ailuminate-v0.5");
    CT_EQ_STR(codec_safety_policy_published_at(p), "2026-05-09T00:00:00Z");
    codec_safety_policy_free(p);
}

static void test_parse_rejects_empty_object(void) {
    codec_safety_policy_t *p = NULL;
    CT_EQ_INT(codec_safety_policy_from_json("{}", 2, &p), CODEC_ERR_VALIDATION);
    CT_TRUE(p == NULL);
}

static void test_parse_rejects_bad_category_name(void) {
    static const char J[] =
        "{\"id\":\"x/y\",\"version\":\"1\",\"tokenizers\":[\"t\"],"
        "\"categories\":[{\"name\":\"BadCaps\",\"action\":\"stop\"}],"
        "\"classifier\":{\"family\":\"f\"}}";
    codec_safety_policy_t *p = NULL;
    CT_EQ_INT(codec_safety_policy_from_json(J, sizeof(J) - 1, &p),
              CODEC_ERR_VALIDATION);
    CT_TRUE(p == NULL);
}

static void test_parse_rejects_unknown_action(void) {
    static const char J[] =
        "{\"id\":\"x/y\",\"version\":\"1\",\"tokenizers\":[\"t\"],"
        "\"categories\":[{\"name\":\"secrets\",\"action\":\"banhammer\"}],"
        "\"classifier\":{\"family\":\"f\"}}";
    codec_safety_policy_t *p = NULL;
    CT_EQ_INT(codec_safety_policy_from_json(J, sizeof(J) - 1, &p),
              CODEC_ERR_VALIDATION);
    CT_TRUE(p == NULL);
}

static void test_parse_rejects_missing_classifier(void) {
    static const char J[] =
        "{\"id\":\"x/y\",\"version\":\"1\",\"tokenizers\":[\"t\"],"
        "\"categories\":[{\"name\":\"secrets\",\"action\":\"stop\"}]}";
    codec_safety_policy_t *p = NULL;
    CT_EQ_INT(codec_safety_policy_from_json(J, sizeof(J) - 1, &p),
              CODEC_ERR_VALIDATION);
}

/* ── URL builders ──────────────────────────────────────────────────────── */

static void test_well_known_url_preserves_slashes(void) {
    char buf[256];
    CT_EQ_INT(codec_safety_policy_well_known_url(
                  "https://acme.example/", "acme/strict-v3", buf, sizeof(buf)),
              CODEC_OK);
    CT_EQ_STR(buf,
              "https://acme.example/.well-known/codec/policies/acme/strict-v3.json");
}

static void test_well_known_url_rejects_traversal(void) {
    char buf[256];
    CT_EQ_INT(codec_safety_policy_well_known_url(
                  "https://acme.example", "../etc", buf, sizeof(buf)),
              CODEC_ERR_INVALID_ARG);
    CT_EQ_INT(codec_safety_policy_well_known_url(
                  "https://acme.example", "/abs", buf, sizeof(buf)),
              CODEC_ERR_INVALID_ARG);
    CT_EQ_INT(codec_safety_policy_well_known_url(
                  "https://acme.example", "trailing/", buf, sizeof(buf)),
              CODEC_ERR_INVALID_ARG);
}

static void test_well_known_url_rejects_bad_charset(void) {
    char buf[256];
    CT_EQ_INT(codec_safety_policy_well_known_url(
                  "https://acme.example", "Acme/Strict", buf, sizeof(buf)),
              CODEC_ERR_INVALID_ARG);
}

static void test_well_known_hash_url(void) {
    char buf[256];
    char hex64[65];
    for (int i = 0; i < 64; i++) hex64[i] = 'a';
    hex64[64] = 0;
    CT_EQ_INT(codec_safety_policy_well_known_hash_url(
                  "https://acme.example", hex64, buf, sizeof(buf)),
              CODEC_OK);
    CT_TRUE(strstr(buf, "/sha256/") != NULL);
    CT_TRUE(strstr(buf, hex64) != NULL);
}

static void test_well_known_hash_url_rejects_bad_hex(void) {
    char buf[256];
    CT_EQ_INT(codec_safety_policy_well_known_hash_url(
                  "https://acme.example", "not-hex", buf, sizeof(buf)),
              CODEC_ERR_INVALID_ARG);
}

static void test_well_known_hash_url_truncates_safely(void) {
    char buf[16];  /* too small */
    char hex64[65];
    for (int i = 0; i < 64; i++) hex64[i] = 'a';
    hex64[64] = 0;
    CT_EQ_INT(codec_safety_policy_well_known_hash_url(
                  "https://acme.example", hex64, buf, sizeof(buf)),
              CODEC_ERR_TRUNCATED);
}

/* ── Hash verification ─────────────────────────────────────────────────── */

static void test_verify_sha256_match(void) {
    const char *body = "hello world";
    /* sha256("hello world") =
       b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9 */
    const char *want =
        "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    CT_EQ_INT(codec_safety_policy_verify_sha256(body, strlen(body), want),
              CODEC_OK);
}

static void test_verify_sha256_mismatch(void) {
    const char *body = "hello world";
    const char *wrong =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    CT_EQ_INT(codec_safety_policy_verify_sha256(body, strlen(body), wrong),
              CODEC_ERR_HASH_MISMATCH);
}

static void test_verify_sha256_bare_hex_accepted(void) {
    const char *body = "hello world";
    const char *bare =
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    CT_EQ_INT(codec_safety_policy_verify_sha256(body, strlen(body), bare),
              CODEC_OK);
}

static void test_verify_sha256_uppercase_hex_accepted(void) {
    const char *body = "hello world";
    const char *upper =
        "sha256:B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9";
    CT_EQ_INT(codec_safety_policy_verify_sha256(body, strlen(body), upper),
              CODEC_OK);
}

static void test_verify_sha256_rejects_malformed(void) {
    const char *body = "hello world";
    CT_EQ_INT(codec_safety_policy_verify_sha256(body, strlen(body), "not-a-hash"),
              CODEC_ERR_INVALID_ARG);
    CT_EQ_INT(codec_safety_policy_verify_sha256(body, strlen(body), "sha256:short"),
              CODEC_ERR_INVALID_ARG);
    CT_EQ_INT(codec_safety_policy_verify_sha256(body, strlen(body),
                  "md5:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"),
              CODEC_ERR_INVALID_ARG);
}

/* ── Structurally incomplete JSON ───────────────────────────────────────── */
/*
 * The root walk read `toks[i + 1]` with no comparison against the parsed
 * token count. jsmn accepts a key with no value, so a descriptor ending in
 * a bare recognised key leaves the value index one past the end. The token
 * array here starts at 256 entries and doubles, so the overread only leaves
 * the allocation when the parse lands on an exact power-of-two boundary.
 * The generated case below does exactly that: 1 root token plus 127 pairs
 * plus a trailing bare "id" is 256 tokens, and toks[256] is off the end.
 */

static void test_rejects_bare_key(void) {
    const char *json = "{\"id\"}";
    codec_safety_policy_t *p = NULL;
    CT_TRUE(codec_safety_policy_from_json(json, strlen(json), &p) != CODEC_OK);
    CT_TRUE(p == NULL);
}

static void test_rejects_bare_key_at_token_array_boundary(void) {
    char json[4096];
    size_t o = 0;
    o += (size_t)snprintf(json + o, sizeof json - o, "{");
    for (int k = 0; k < 127; k++) {
        o += (size_t)snprintf(json + o, sizeof json - o, "\"a%d\":1,", k);
    }
    o += (size_t)snprintf(json + o, sizeof json - o, "\"id\"}");

    codec_safety_policy_t *p = NULL;
    CT_TRUE(codec_safety_policy_from_json(json, o, &p) != CODEC_OK);
    CT_TRUE(p == NULL);
}

int main(void) {
    test_parse_valid_descriptor();
    test_parse_rejects_empty_object();
    test_parse_rejects_bad_category_name();
    test_parse_rejects_unknown_action();
    test_parse_rejects_missing_classifier();

    test_well_known_url_preserves_slashes();
    test_well_known_url_rejects_traversal();
    test_well_known_url_rejects_bad_charset();
    test_well_known_hash_url();
    test_well_known_hash_url_rejects_bad_hex();
    test_well_known_hash_url_truncates_safely();

    test_verify_sha256_match();
    test_verify_sha256_mismatch();
    test_verify_sha256_bare_hex_accepted();
    test_verify_sha256_uppercase_hex_accepted();
    test_verify_sha256_rejects_malformed();

    test_rejects_bare_key();
    test_rejects_bare_key_at_token_array_boundary();

    if (_codec_test_failures > 0) {
        fprintf(stderr, "test_safety_policy: %d failure(s)\n", _codec_test_failures);
        return 1;
    }
    fprintf(stderr, "test_safety_policy: ok\n");
    return 0;
}
