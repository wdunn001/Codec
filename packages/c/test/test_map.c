/* Map parser + SHA-256 verification + (optional) real Qwen-2 round trip. */
#include "codec/codec.h"
#include "codec_test.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char V2_MAP_JSON[] =
"{"
"  \"id\": \"test/byte_level\","
"  \"version\": \"2\","
"  \"vocab_size\": 9,"
"  \"vocab\": {"
"    \"hello\": 0,"
"    \"\\u0120world\": 1,"
"    \"!\": 2"
"  },"
"  \"encoder\": \"byte_level\""
"}";

static void test_v2_basic_parse(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(V2_MAP_JSON, sizeof(V2_MAP_JSON) - 1, &m), CODEC_OK);
    CT_TRUE(m != NULL);
    CT_EQ_STR(codec_map_id(m), "test/byte_level");
    CT_EQ_STR(codec_map_version(m), "2");
    CT_EQ_SZ(codec_map_vocab_size(m), 9);
    CT_EQ_INT((int)codec_map_encoder(m), (int)CODEC_ENCODER_BYTE_LEVEL);
    codec_map_free(m);
}

static void test_v2_roundtrip_render(void) {
    /* Decode 'hello' then ' world' (id 0 + id 1): id 1's vocab key
     * "Ġworld" is GPT-2 byte-encoded " world", so the byte_level
     * decoder should emit a leading space. */
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(V2_MAP_JSON, sizeof(V2_MAP_JSON) - 1, &m), CODEC_OK);
    codec_detokenizer_t *d = NULL;
    CT_EQ_INT(codec_detokenizer_new(m, &d), CODEC_OK);
    uint32_t ids[] = { 0, 1, 2 };
    char *s = NULL; size_t slen = 0;
    codec_detokenize_opts_t o = { false, false };
    CT_EQ_INT(codec_detokenizer_render(d, ids, 3, o, &s, &slen), CODEC_OK);
    CT_EQ_STR(s, "hello world!");
    free(s);
    codec_detokenizer_free(d);
    codec_map_free(m);
}

static void test_validation_rejects_bad(void) {
    codec_tokenizer_map_t *m = NULL;
    /* Missing vocab and tokens. */
    const char *bad = "{\"id\":\"x\",\"version\":\"2\",\"vocab_size\":1}";
    CT_EQ_INT(codec_map_from_json(bad, strlen(bad), &m), CODEC_ERR_VALIDATION);
    CT_TRUE(m == NULL);
}

static void test_sha256_verify_match(void) {
    /* SHA-256 of the literal V2_MAP_JSON bytes. We compute it on the fly so
     * the test is self-checking even if we change the fixture later. */
    /* First compute via the public API on a known input, then verify. */
    const char *msg = "abc";
    /* SHA-256("abc") = ba7816bf... */
    CT_EQ_INT(codec_map_verify_sha256(
        msg, 3,
        "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
        CODEC_OK);
    CT_EQ_INT(codec_map_verify_sha256(msg, 3,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
        CODEC_OK);
}

static void test_sha256_verify_mismatch(void) {
    const char *msg = "abc";
    CT_EQ_INT(codec_map_verify_sha256(msg, 3,
        "sha256:0000000000000000000000000000000000000000000000000000000000000000"),
        CODEC_ERR_HASH_MISMATCH);
}

static void test_sha256_invalid_length(void) {
    const char *msg = "abc";
    CT_EQ_INT(codec_map_verify_sha256(msg, 3, "sha256:abcd"), CODEC_ERR_INVALID_ARG);
}

/* Optional: real Qwen-2 round-trip when codec-maps is mounted nearby. */
static void test_real_qwen2_round_trip(void) {
    const char *path = getenv("CODEC_MAPS_QWEN");
    if (!path || !*path) {
        fprintf(stdout, "  (skipped: set CODEC_MAPS_QWEN to enable)\n");
        return;
    }
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stdout, "  (skipped: could not open %s)\n", path);
        return;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *json = (char *)malloc((size_t)sz);
    if (!json || fread(json, 1, (size_t)sz, f) != (size_t)sz) {
        free(json); fclose(f); CT_FAIL("read failed"); return;
    }
    fclose(f);

    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(json, (size_t)sz, &m), CODEC_OK);
    free(json);

    /* Spot-check a known token: Qwen-2's vocab maps "Hello" → 9707.
     * We don't have the BPE encoder yet, but we can verify the detokenizer
     * round-trips the IDs we hand-chose for "Hello, world!". */
    codec_detokenizer_t *d = NULL;
    CT_EQ_INT(codec_detokenizer_new(m, &d), CODEC_OK);
    /* From @codecai/web's Qwen-2 BPE: "Hello, world!" → [9707, 11, 1879, 0] */
    uint32_t ids[] = { 9707, 11, 1879, 0 };
    char *s = NULL; size_t slen = 0;
    codec_detokenize_opts_t o = { false, false };
    CT_EQ_INT(codec_detokenizer_render(d, ids, 4, o, &s, &slen), CODEC_OK);
    CT_EQ_STR(s, "Hello, world!");
    free(s);
    codec_detokenizer_free(d);
    codec_map_free(m);
}

/* ── Structurally incomplete JSON ───────────────────────────────────────── */
/*
 * jsmn accepts a key with no value: `{"a"}` yields an OBJECT of size 1 and
 * a single STRING, with no JSMN_ERROR_PART. Every walker here assumed an
 * object of size N is backed by 2N tokens, so it read one past the end of
 * a token array allocated to exactly the parsed count. In install_entry and
 * the special_tokens loop the garbage token's start/end then became an
 * offset and length into the JSON buffer.
 */

static void test_rejects_bare_key_at_root(void) {
    const char *json = "{\"a\"}";
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(json, strlen(json), &m), CODEC_ERR_PARSE);
    CT_TRUE(m == NULL);
}

static void test_rejects_odd_vocab_child_count(void) {
    const char *json =
        "{\"id\":\"a\",\"version\":\"1\",\"vocab_size\":1,"
        "\"vocab\":{\"a\":1,\"b\"}}";
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(json, strlen(json), &m), CODEC_ERR_PARSE);
    CT_TRUE(m == NULL);
}

static void test_rejects_bare_key_in_special_tokens(void) {
    const char *json =
        "{\"id\":\"a\",\"version\":\"1\",\"vocab_size\":1,"
        "\"vocab\":{\"a\":1},\"special_tokens\":{\"x\":1,\"y\"}}";
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(json, strlen(json), &m), CODEC_ERR_PARSE);
    CT_TRUE(m == NULL);
}

/* ── Token id as an allocation primitive ────────────────────────────────── */
/*
 * The id table is sized by the largest token id in the document. vocab_size
 * is parsed and validated but never compared against any id, so a single
 * entry with a huge id sized the allocation on its own. A 63-byte document
 * with id 100000000 reached 2.1 GB resident in 1.25 seconds and returned
 * CODEC_OK. id 4294967295 asks for 64 GiB.
 */

static void test_rejects_id_far_beyond_document_size(void) {
    const char *json =
        "{\"id\":\"a\",\"version\":\"1\",\"vocab_size\":1,"
        "\"vocab\":{\"x\":4294967295}}";
    codec_tokenizer_map_t *m = NULL;
    CT_TRUE(codec_map_from_json(json, strlen(json), &m) != CODEC_OK);
    CT_TRUE(m == NULL);
}

static void test_rejects_moderately_large_id_from_tiny_document(void) {
    const char *json =
        "{\"id\":\"a\",\"version\":\"1\",\"vocab_size\":1,"
        "\"vocab\":{\"x\":100000000}}";
    codec_tokenizer_map_t *m = NULL;
    CT_TRUE(codec_map_from_json(json, strlen(json), &m) != CODEC_OK);
    CT_TRUE(m == NULL);
}

static void test_accepts_ids_at_real_vocabulary_scale(void) {
    /* The cap must not reject a small hand-written map whose special-token
     * ids sit at real-vocabulary scale. This shape is exactly what
     * test_tool_calling.c uses. */
    const char *json =
        "{\"id\":\"a\",\"version\":\"2\",\"encoder\":\"identity\","
        "\"vocab_size\":151665,\"vocab\":{\"a\":0},"
        "\"special_tokens\":{\"<t>\":151657}}";
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(json, strlen(json), &m), CODEC_OK);
    CT_TRUE(m != NULL);
    codec_map_free(m);
}

static void test_rejects_overflowing_id_literal(void) {
    /* parse_int accumulated into a signed long with no overflow check. */
    const char *json =
        "{\"id\":\"a\",\"version\":\"1\",\"vocab_size\":1,"
        "\"vocab\":{\"x\":99999999999999999999999}}";
    codec_tokenizer_map_t *m = NULL;
    CT_TRUE(codec_map_from_json(json, strlen(json), &m) != CODEC_OK);
    CT_TRUE(m == NULL);
}

int main(void) {
    CT_RUN(test_v2_basic_parse);
    CT_RUN(test_v2_roundtrip_render);
    CT_RUN(test_validation_rejects_bad);
    CT_RUN(test_sha256_verify_match);
    CT_RUN(test_sha256_verify_mismatch);
    CT_RUN(test_sha256_invalid_length);
    CT_RUN(test_real_qwen2_round_trip);
    CT_RUN(test_rejects_bare_key_at_root);
    CT_RUN(test_rejects_odd_vocab_child_count);
    CT_RUN(test_rejects_bare_key_in_special_tokens);
    CT_RUN(test_rejects_id_far_beyond_document_size);
    CT_RUN(test_rejects_moderately_large_id_from_tiny_document);
    CT_RUN(test_accepts_ids_at_real_vocabulary_scale);
    CT_RUN(test_rejects_overflowing_id_literal);
    CT_DONE();
}
