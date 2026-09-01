/* C parity tests for codec_version_signaling: mirrors the TS / Python /
 * Rust / .NET / Java suites at the parser-and-URL-builder layer.
 *
 * libcodec stays HTTP-transport-agnostic; these tests exercise the
 * pure-parser surface (parse a 426 body, parse a well-known doc, build
 * the well-known URL). HTTP-level smoke happens in the higher-level
 * client packages and the end-to-end matrix on the lab box.
 */
#include "codec/codec_version_signaling.h"
#include "codec_test.h"

#include <string.h>

static const char VALID_BODY[] =
    "{"
    "  \"error\": \"codec_version_required\","
    "  \"minimum_version\": \"0.4\","
    "  \"required_features\": [\"safety-policy-enforcement\"],"
    "  \"client_version\": \"0.3\","
    "  \"docs_url\": \"https://codecai.net/docs/version-negotiation/\","
    "  \"deployment_id\": \"lab-test\""
    "}";

static const char VALID_BODY_EMPTY_FEATURES[] =
    "{"
    "  \"error\": \"codec_version_required\","
    "  \"minimum_version\": \"0.4\","
    "  \"required_features\": [],"
    "  \"client_version\": \"0.3\""
    "}";

static const char WELLKNOWN_VALID[] =
    "{"
    "  \"minimum_version\": \"0.4\","
    "  \"required_features\": [\"safety-policy-enforcement\"],"
    "  \"deployment_id\": \"acme-prod\","
    "  \"docs_url\": \"https://codecai.net/docs/version-negotiation/\""
    "}";

/* ── parse_version_required ─────────────────────────────────────────────── */

static void test_parse_valid_body(void) {
    codec_version_required_body_t b;
    codec_status_t rc = codec_version_required_parse(
        VALID_BODY, sizeof(VALID_BODY) - 1, &b);
    CT_EQ_INT(rc, CODEC_OK);
    CT_EQ_STR(b.error, "codec_version_required");
    CT_EQ_STR(b.minimum_version, "0.4");
    CT_EQ_STR(b.client_version, "0.3");
    CT_EQ_SZ(b.required_features_count, 1);
    CT_TRUE(b.required_features != NULL);
    CT_EQ_STR(b.required_features[0], "safety-policy-enforcement");
    CT_EQ_STR(b.docs_url, "https://codecai.net/docs/version-negotiation/");
    CT_EQ_STR(b.deployment_id, "lab-test");
    codec_version_required_free(&b);
}

static void test_parse_empty_features(void) {
    codec_version_required_body_t b;
    codec_status_t rc = codec_version_required_parse(
        VALID_BODY_EMPTY_FEATURES, sizeof(VALID_BODY_EMPTY_FEATURES) - 1, &b);
    CT_EQ_INT(rc, CODEC_OK);
    CT_EQ_SZ(b.required_features_count, 0);
    CT_TRUE(b.required_features == NULL);
    CT_TRUE(b.docs_url == NULL);
    codec_version_required_free(&b);
}

static void test_parse_rejects_non_json(void) {
    codec_version_required_body_t b;
    const char *junk = "plain text refusal";
    codec_status_t rc = codec_version_required_parse(junk, strlen(junk), &b);
    CT_EQ_INT(rc, CODEC_ERR_PARSE);
}

static void test_parse_rejects_unrecognized_error(void) {
    codec_version_required_body_t b;
    const char *body = "{\"error\":\"something_else\",\"foo\":1}";
    codec_status_t rc = codec_version_required_parse(body, strlen(body), &b);
    CT_EQ_INT(rc, CODEC_ERR_VALIDATION);
}

static void test_parse_rejects_missing_min_version(void) {
    codec_version_required_body_t b;
    const char *body =
        "{\"error\":\"codec_version_required\","
        "\"client_version\":\"0.3\","
        "\"required_features\":[]}";
    codec_status_t rc = codec_version_required_parse(body, strlen(body), &b);
    CT_EQ_INT(rc, CODEC_ERR_VALIDATION);
}

/* ── parse_version_policy_document ──────────────────────────────────────── */

static void test_parse_wellknown_valid(void) {
    codec_version_policy_doc_t d;
    codec_status_t rc = codec_version_policy_parse(
        WELLKNOWN_VALID, sizeof(WELLKNOWN_VALID) - 1, &d);
    CT_EQ_INT(rc, CODEC_OK);
    CT_EQ_STR(d.minimum_version, "0.4");
    CT_EQ_SZ(d.required_features_count, 1);
    CT_EQ_STR(d.required_features[0], "safety-policy-enforcement");
    CT_EQ_STR(d.deployment_id, "acme-prod");
    codec_version_policy_free(&d);
}

static void test_parse_wellknown_rejects_missing_min(void) {
    codec_version_policy_doc_t d;
    const char *body = "{\"required_features\":[]}";
    codec_status_t rc = codec_version_policy_parse(body, strlen(body), &d);
    CT_EQ_INT(rc, CODEC_ERR_VALIDATION);
}

static void test_parse_wellknown_rejects_malformed_features(void) {
    codec_version_policy_doc_t d;
    const char *body =
        "{\"minimum_version\":\"0.4\",\"required_features\":\"not a list\"}";
    codec_status_t rc = codec_version_policy_parse(body, strlen(body), &d);
    CT_EQ_INT(rc, CODEC_ERR_VALIDATION);
}

/* ── well-known URL helper ──────────────────────────────────────────────── */

static void test_wellknown_url_builds(void) {
    char buf[256];
    codec_status_t rc =
        codec_well_known_version_policy_url("https://x.test", buf, sizeof(buf));
    CT_EQ_INT(rc, CODEC_OK);
    CT_EQ_STR(buf, "https://x.test/.well-known/codec/version-policy.json");
}

static void test_wellknown_url_trims_trailing_slash(void) {
    char buf[256];
    codec_status_t rc =
        codec_well_known_version_policy_url("https://x.test/", buf, sizeof(buf));
    CT_EQ_INT(rc, CODEC_OK);
    CT_EQ_STR(buf, "https://x.test/.well-known/codec/version-policy.json");
}

static void test_wellknown_url_buffer_too_small(void) {
    char buf[10];
    codec_status_t rc =
        codec_well_known_version_policy_url("https://x.test", buf, sizeof(buf));
    CT_EQ_INT(rc, CODEC_ERR_TRUNCATED);
}

/* ── Matrix: simulate server bodies for each (client, config) cell ──────── */

static void test_matrix_cells(void) {
    /* Same matrix the TS/Python/Rust/.NET/Java sides exercise: every
     * refusal body parses to the expected required_features set. */
    struct {
        const char *server;
        const char *client_version;
        const char *features_json;  /* contents of the JSON array */
        const char *first_feature_or_null;
    } cells[] = {
        {"safety-enforced", "0.2", "\"safety-policy-enforcement\"",
         "safety-policy-enforcement"},
        {"safety-enforced", "0.3", "\"safety-policy-enforcement\"",
         "safety-policy-enforcement"},
        {"version-policy-strict", "0.2", "", NULL},
        {"version-policy-strict", "0.3", "", NULL},
    };
    char body[256];
    for (size_t i = 0; i < sizeof(cells) / sizeof(cells[0]); i++) {
        snprintf(body, sizeof(body),
            "{\"error\":\"codec_version_required\","
            "\"minimum_version\":\"0.4\","
            "\"required_features\":[%s],"
            "\"client_version\":\"%s\"}",
            cells[i].features_json, cells[i].client_version);
        codec_version_required_body_t b;
        codec_status_t rc = codec_version_required_parse(body, strlen(body), &b);
        CT_EQ_INT(rc, CODEC_OK);
        CT_EQ_STR(b.minimum_version, "0.4");
        CT_EQ_STR(b.client_version, cells[i].client_version);
        if (cells[i].first_feature_or_null) {
            CT_EQ_SZ(b.required_features_count, 1);
            CT_EQ_STR(b.required_features[0], cells[i].first_feature_or_null);
        } else {
            CT_EQ_SZ(b.required_features_count, 0);
        }
        codec_version_required_free(&b);
    }
}

/* ── Structurally incomplete JSON ───────────────────────────────────────── */
/*
 * find_field_ returns `i + 1` after matching a key at index i. i was
 * only checked against toks_count. On `{"minimum_version"}` jsmn emits two
 * tokens. The returned index therefore equals toks_count. The required-field
 * paths then read one token past a heap array sized to exactly that count. The
 * garbage token's start/end then reached strndup_tok_. That memcpy'd from
 * an attacker-unbounded offset into a string the caller reads back.
 */

static void test_wellknown_rejects_bare_key(void) {
    const char *json = "{\"minimum_version\"}";
    codec_version_policy_doc_t doc;
    memset(&doc, 0, sizeof doc);
    CT_TRUE(codec_version_policy_parse(json, strlen(json), &doc) != CODEC_OK);
    CT_TRUE(doc.minimum_version == NULL);
    codec_version_policy_free(&doc);
}

static void test_required_rejects_bare_key(void) {
    const char *json = "{\"error\"}";
    codec_version_required_body_t body;
    memset(&body, 0, sizeof body);
    CT_TRUE(codec_version_required_parse(json, strlen(json), &body) != CODEC_OK);
    codec_version_required_free(&body);
}

int main(void) {
    CT_RUN(test_parse_valid_body);
    CT_RUN(test_parse_empty_features);
    CT_RUN(test_parse_rejects_non_json);
    CT_RUN(test_parse_rejects_unrecognized_error);
    CT_RUN(test_parse_rejects_missing_min_version);
    CT_RUN(test_parse_wellknown_valid);
    CT_RUN(test_parse_wellknown_rejects_missing_min);
    CT_RUN(test_parse_wellknown_rejects_malformed_features);
    CT_RUN(test_wellknown_url_builds);
    CT_RUN(test_wellknown_url_trims_trailing_slash);
    CT_RUN(test_wellknown_url_buffer_too_small);
    CT_RUN(test_wellknown_rejects_bare_key);
    CT_RUN(test_required_rejects_bare_key);
    CT_RUN(test_matrix_cells);
    CT_DONE();
}
