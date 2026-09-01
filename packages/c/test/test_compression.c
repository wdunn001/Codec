/* Tests for the dict-zstd client-side helpers (codec_compression.h).
 *
 * Pairs with the cross-client interop fixture at
 * packages/bench/fixtures/dict-zstd-interop/. Every Codec client (TS,
 * Python, Rust, Java, .NET, C) hashes dict.bin into the canonical
 * "sha256:29a810f3..." form and matches the recorded Codec-Zstd-Dict
 * header: this test asserts the C client lands on the same hash and
 * the same select-dict decision tree.
 *
 * The actual libzstd decompression step is exercised by the demo bench
 * (packages/demo-c/matrix_run.c). libcodec doesn't link
 * against libzstd here. The parity contract for this module is "hash
 * matches" + "select returns the right verdict for each header
 * combination". */

#include "codec/codec_compression.h"
#include "codec_test.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The hash the manifest records for dict.bin. Hard-coded here so the
 * test catches any future drift in sha256 output, beyond whether the
 * fixture and the helper agree with each other. */
static const char EXPECTED_DICT_HASH[] =
    "sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db";

/* ── fixture loader ────────────────────────────────────────────────────── */

static const char *fixture_dir(void) {
    return getenv("CODEC_DICT_ZSTD_INTEROP_DIR");
}

static int read_file(const char *path, uint8_t **out, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return 0; }
    long L = ftell(f);
    if (L < 0) { fclose(f); return 0; }
    if (fseek(f, 0, SEEK_SET) != 0) { fclose(f); return 0; }
    uint8_t *buf = (uint8_t *)malloc((size_t)L);
    if (!buf && L > 0) { fclose(f); return 0; }
    size_t got = fread(buf, 1, (size_t)L, f);
    fclose(f);
    if (got != (size_t)L) { free(buf); return 0; }
    *out = buf;
    *out_len = (size_t)L;
    return 1;
}

/* ── hash_zstd_dict ────────────────────────────────────────────────────── */

static void test_hash_zstd_dict_against_fixture(void) {
    const char *dir = fixture_dir();
    if (!dir) {
        fprintf(stderr, "  SKIP %s: CODEC_DICT_ZSTD_INTEROP_DIR unset\n",
                __func__);
        return;
    }
    char path[1024];
    snprintf(path, sizeof(path), "%s/dict.bin", dir);
    uint8_t *dict = NULL; size_t dict_len = 0;
    if (!read_file(path, &dict, &dict_len)) {
        CT_FAIL("could not read fixture dict.bin at %s", path);
        return;
    }
    char hash[CODEC_ZSTD_DICT_HASH_BUF_LEN];
    CT_EQ_INT(codec_hash_zstd_dict(dict, dict_len, hash), 0);
    CT_EQ_STR(hash, EXPECTED_DICT_HASH);
    /* And the manifest's recorded length matches. */
    CT_EQ_SZ(dict_len, 16384);
    free(dict);
}

static void test_hash_zstd_dict_empty_input(void) {
    /* sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 */
    char hash[CODEC_ZSTD_DICT_HASH_BUF_LEN];
    CT_EQ_INT(codec_hash_zstd_dict(NULL, 0, hash), 0);
    CT_EQ_STR(hash,
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

static void test_hash_zstd_dict_known_input(void) {
    /* sha256("hello world") = b94d27b9...cde9 */
    const uint8_t msg[] = "hello world";
    char hash[CODEC_ZSTD_DICT_HASH_BUF_LEN];
    CT_EQ_INT(codec_hash_zstd_dict(msg, sizeof(msg) - 1, hash), 0);
    CT_EQ_STR(hash,
        "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
}

static void test_hash_zstd_dict_null_out(void) {
    const uint8_t msg[] = "x";
    CT_TRUE(codec_hash_zstd_dict(msg, 1, NULL) != 0);
}

/* ── select_zstd_dict_for_response ─────────────────────────────────────── */

/* Synthetic small dict bytes for the cases that don't need the real
 * fixture. We populate the hash from codec_hash_zstd_dict so the entry
 * is in canonical form regardless of what the test source claims. */
static uint8_t DUMMY_DICT[] = { 'd','i','c','t' };
static char    DUMMY_DICT_HASH[CODEC_ZSTD_DICT_HASH_BUF_LEN];
static codec_zstd_dict_entry_t DUMMY_REGISTRY[1];

static void setup_dummy_registry(void) {
    codec_hash_zstd_dict(DUMMY_DICT, sizeof(DUMMY_DICT), DUMMY_DICT_HASH);
    DUMMY_REGISTRY[0].hash  = DUMMY_DICT_HASH;
    DUMMY_REGISTRY[0].bytes = DUMMY_DICT;
    DUMMY_REGISTRY[0].len   = sizeof(DUMMY_DICT);
}

static void test_select_ok_when_zstd_and_hash_matches(void) {
    setup_dummy_registry();
    codec_header_kv_t headers[] = {
        { "Content-Encoding", "zstd" },
        { "Codec-Zstd-Dict",  DUMMY_DICT_HASH },
        { "Vary",             "Accept-Encoding" },
    };
    const uint8_t *bytes = NULL;
    size_t len = 0;
    CT_EQ_INT(codec_select_zstd_dict_for_response(
                  headers, 3, DUMMY_REGISTRY, 1, &bytes, &len),
              CODEC_ZSTD_DICT_OK);
    CT_TRUE(bytes == DUMMY_DICT);
    CT_EQ_SZ(len, sizeof(DUMMY_DICT));
}

static void test_select_case_insensitive_header_names(void) {
    setup_dummy_registry();
    /* Same headers, lowercased: case folding is required per RFC 7230. */
    codec_header_kv_t headers[] = {
        { "content-encoding", "zstd" },
        { "codec-zstd-dict",  DUMMY_DICT_HASH },
    };
    const uint8_t *bytes = NULL;
    size_t len = 0;
    CT_EQ_INT(codec_select_zstd_dict_for_response(
                  headers, 2, DUMMY_REGISTRY, 1, &bytes, &len),
              CODEC_ZSTD_DICT_OK);
    CT_TRUE(bytes == DUMMY_DICT);
}

static void test_select_uppercase_hex_in_header_accepted(void) {
    setup_dummy_registry();
    /* Lowercase the registry's hash, then build an uppercase version
     * for the header. Per spec the canonical form is lowercase, but a
     * tolerant decoder treats uppercase as equivalent. */
    char upper[CODEC_ZSTD_DICT_HASH_BUF_LEN];
    memcpy(upper, DUMMY_DICT_HASH, CODEC_ZSTD_DICT_HASH_BUF_LEN);
    for (size_t i = 7; i < 7 + 64; i++) {
        if (upper[i] >= 'a' && upper[i] <= 'f') {
            upper[i] = (char)(upper[i] - 'a' + 'A');
        }
    }
    codec_header_kv_t headers[] = {
        { "Content-Encoding", "zstd" },
        { "Codec-Zstd-Dict",  upper },
    };
    const uint8_t *bytes = NULL;
    size_t len = 0;
    CT_EQ_INT(codec_select_zstd_dict_for_response(
                  headers, 2, DUMMY_REGISTRY, 1, &bytes, &len),
              CODEC_ZSTD_DICT_OK);
}

static void test_select_not_zstd_on_identity(void) {
    setup_dummy_registry();
    codec_header_kv_t headers[] = {
        { "Content-Type", "application/octet-stream" },
    };
    CT_EQ_INT(codec_select_zstd_dict_for_response(
                  headers, 1, DUMMY_REGISTRY, 1, NULL, NULL),
              CODEC_ZSTD_DICT_NOT_ZSTD);
}

static void test_select_not_zstd_on_gzip(void) {
    setup_dummy_registry();
    codec_header_kv_t headers[] = {
        { "Content-Encoding", "gzip" },
        /* The server here does emit Codec-Zstd-Dict even on non-zstd.
         * We still return NOT_ZSTD regardless: the dict-zstd codepath
         * doesn't apply. */
        { "Codec-Zstd-Dict",  DUMMY_DICT_HASH },
    };
    CT_EQ_INT(codec_select_zstd_dict_for_response(
                  headers, 2, DUMMY_REGISTRY, 1, NULL, NULL),
              CODEC_ZSTD_DICT_NOT_ZSTD);
}

static void test_select_missing_header(void) {
    setup_dummy_registry();
    codec_header_kv_t headers[] = {
        { "Content-Encoding", "zstd" },
        /* No Codec-Zstd-Dict: server protocol error. */
    };
    CT_EQ_INT(codec_select_zstd_dict_for_response(
                  headers, 1, DUMMY_REGISTRY, 1, NULL, NULL),
              CODEC_ZSTD_DICT_MISSING_HEADER);
}

static void test_select_malformed_hash(void) {
    setup_dummy_registry();
    /* Various shape violations: missing prefix, short hex, wrong algorithm,
     * non-hex characters. */
    const char *bad[] = {
        "29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db",  /* no sha256: */
        "sha256:short",
        "md5:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        "sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891Z!",
        "sha256:",
        "",
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        codec_header_kv_t headers[] = {
            { "Content-Encoding", "zstd" },
            { "Codec-Zstd-Dict",  bad[i] },
        };
        codec_zstd_dict_result_t r = codec_select_zstd_dict_for_response(
            headers, 2, DUMMY_REGISTRY, 1, NULL, NULL);
        if (r != CODEC_ZSTD_DICT_MALFORMED_HASH) {
            CT_FAIL("expected MALFORMED_HASH for %s, got %d", bad[i], (int)r);
        }
    }
}

static void test_select_unknown_hash(void) {
    setup_dummy_registry();
    /* Well-formed but not in the registry. */
    codec_header_kv_t headers[] = {
        { "Content-Encoding", "zstd" },
        { "Codec-Zstd-Dict",
          "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
    };
    CT_EQ_INT(codec_select_zstd_dict_for_response(
                  headers, 2, DUMMY_REGISTRY, 1, NULL, NULL),
              CODEC_ZSTD_DICT_UNKNOWN_HASH);
}

static void test_select_with_fixture_dict(void) {
    const char *dir = fixture_dir();
    if (!dir) {
        fprintf(stderr, "  SKIP %s: CODEC_DICT_ZSTD_INTEROP_DIR unset\n",
                __func__);
        return;
    }
    char path[1024];
    snprintf(path, sizeof(path), "%s/dict.bin", dir);
    uint8_t *dict = NULL; size_t dict_len = 0;
    if (!read_file(path, &dict, &dict_len)) {
        CT_FAIL("could not read fixture dict.bin at %s", path);
        return;
    }
    char hash[CODEC_ZSTD_DICT_HASH_BUF_LEN];
    CT_EQ_INT(codec_hash_zstd_dict(dict, dict_len, hash), 0);

    codec_zstd_dict_entry_t reg[1] = { { hash, dict, dict_len } };
    codec_header_kv_t headers[] = {
        { "Content-Encoding", "zstd" },
        { "Codec-Zstd-Dict",  EXPECTED_DICT_HASH },
    };
    const uint8_t *bytes = NULL;
    size_t len = 0;
    CT_EQ_INT(codec_select_zstd_dict_for_response(
                  headers, 2, reg, 1, &bytes, &len),
              CODEC_ZSTD_DICT_OK);
    CT_TRUE(bytes == dict);
    CT_EQ_SZ(len, dict_len);
    free(dict);
}

static void test_select_handles_extra_whitespace(void) {
    setup_dummy_registry();
    char padded[CODEC_ZSTD_DICT_HASH_BUF_LEN + 8];
    snprintf(padded, sizeof(padded), "  %s  ", DUMMY_DICT_HASH);
    codec_header_kv_t headers[] = {
        { "Content-Encoding", "  zstd  " },
        { "Codec-Zstd-Dict",  padded },
    };
    CT_EQ_INT(codec_select_zstd_dict_for_response(
                  headers, 2, DUMMY_REGISTRY, 1, NULL, NULL),
              CODEC_ZSTD_DICT_OK);
}

static void test_select_empty_registry_is_unknown(void) {
    setup_dummy_registry();
    codec_header_kv_t headers[] = {
        { "Content-Encoding", "zstd" },
        { "Codec-Zstd-Dict",  DUMMY_DICT_HASH },
    };
    CT_EQ_INT(codec_select_zstd_dict_for_response(
                  headers, 2, NULL, 0, NULL, NULL),
              CODEC_ZSTD_DICT_UNKNOWN_HASH);
}

/* ── well_known_dict_url + verify_zstd_dict_bytes (v0.5) ─────────────── */

static void test_well_known_dict_url_strips_sha256_prefix(void) {
    char url[CODEC_WELL_KNOWN_DICT_URL_BUF_LEN];
    char hash[8 + 64 + 1];
    memcpy(hash, "sha256:", 7);
    memset(hash + 7, 'a', 64);
    hash[7 + 64] = 0;

    CT_EQ_INT(codec_well_known_dict_url("https://codec.example", hash,
                                         url, sizeof(url)),
              CODEC_OK);
    char expected[256];
    snprintf(expected, sizeof(expected),
             "https://codec.example/.well-known/codec/dicts/%.*s.zstd",
             64, hash + 7);
    CT_EQ_STR(url, expected);
}

static void test_well_known_dict_url_accepts_bare_hex(void) {
    char url[CODEC_WELL_KNOWN_DICT_URL_BUF_LEN];
    char hex[65]; memset(hex, 'b', 64); hex[64] = 0;
    CT_EQ_INT(codec_well_known_dict_url("https://codec.example", hex,
                                         url, sizeof(url)),
              CODEC_OK);
    char expected[256];
    snprintf(expected, sizeof(expected),
             "https://codec.example/.well-known/codec/dicts/%s.zstd", hex);
    CT_EQ_STR(url, expected);
}

static void test_well_known_dict_url_strips_trailing_slash(void) {
    char url[CODEC_WELL_KNOWN_DICT_URL_BUF_LEN];
    char hex[65]; memset(hex, 'c', 64); hex[64] = 0;
    CT_EQ_INT(codec_well_known_dict_url("https://codec.example/", hex,
                                         url, sizeof(url)),
              CODEC_OK);
    char expected[256];
    snprintf(expected, sizeof(expected),
             "https://codec.example/.well-known/codec/dicts/%s.zstd", hex);
    CT_EQ_STR(url, expected);
}

static void test_well_known_dict_url_normalises_uppercase_hex(void) {
    char url[CODEC_WELL_KNOWN_DICT_URL_BUF_LEN];
    char hex[65]; memset(hex, 'D', 64); hex[64] = 0;
    CT_EQ_INT(codec_well_known_dict_url("https://codec.example", hex,
                                         url, sizeof(url)),
              CODEC_OK);
    char expected_hex[65]; memset(expected_hex, 'd', 64); expected_hex[64] = 0;
    char expected[256];
    snprintf(expected, sizeof(expected),
             "https://codec.example/.well-known/codec/dicts/%s.zstd",
             expected_hex);
    CT_EQ_STR(url, expected);
}

static void test_well_known_dict_url_rejects_short_hash(void) {
    char url[CODEC_WELL_KNOWN_DICT_URL_BUF_LEN];
    CT_EQ_INT(codec_well_known_dict_url("https://codec.example", "deadbeef",
                                         url, sizeof(url)),
              CODEC_ERR_VALIDATION);
}

static void test_well_known_dict_url_rejects_wrong_algorithm(void) {
    char url[CODEC_WELL_KNOWN_DICT_URL_BUF_LEN];
    char bad[32 + 5];
    memcpy(bad, "md5:", 4);
    memset(bad + 4, 'a', 32);
    bad[4 + 32] = 0;
    CT_EQ_INT(codec_well_known_dict_url("https://codec.example", bad,
                                         url, sizeof(url)),
              CODEC_ERR_VALIDATION);
}

static void test_well_known_dict_url_rejects_nonhex_chars(void) {
    char url[CODEC_WELL_KNOWN_DICT_URL_BUF_LEN];
    char bad[65]; memset(bad, 'z', 64); bad[64] = 0;
    CT_EQ_INT(codec_well_known_dict_url("https://codec.example", bad,
                                         url, sizeof(url)),
              CODEC_ERR_VALIDATION);
}

static void test_well_known_dict_url_rejects_undersized_buffer(void) {
    char tiny[32];
    char hex[65]; memset(hex, 'a', 64); hex[64] = 0;
    CT_EQ_INT(codec_well_known_dict_url("https://codec.example", hex,
                                         tiny, sizeof(tiny)),
              CODEC_ERR_INVALID_ARG);
}

static void test_well_known_dict_url_rejects_null_args(void) {
    char url[CODEC_WELL_KNOWN_DICT_URL_BUF_LEN];
    char hex[65]; memset(hex, 'a', 64); hex[64] = 0;
    CT_EQ_INT(codec_well_known_dict_url(NULL, hex, url, sizeof(url)),
              CODEC_ERR_INVALID_ARG);
    CT_EQ_INT(codec_well_known_dict_url("https://codec.example", NULL,
                                         url, sizeof(url)),
              CODEC_ERR_INVALID_ARG);
    CT_EQ_INT(codec_well_known_dict_url("https://codec.example", hex,
                                         NULL, sizeof(url)),
              CODEC_ERR_INVALID_ARG);
}

static void test_verify_zstd_dict_bytes_matches_correct_hash(void) {
    /* sha256("hello world") = b94d27b9...: same fixture used elsewhere. */
    static const char EXPECTED[] =
        "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    CT_EQ_INT(codec_verify_zstd_dict_bytes(
                  (const uint8_t *)"hello world", 11, EXPECTED),
              CODEC_OK);
}

static void test_verify_zstd_dict_bytes_accepts_bare_hex(void) {
    static const char EXPECTED_BARE[] =
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    CT_EQ_INT(codec_verify_zstd_dict_bytes(
                  (const uint8_t *)"hello world", 11, EXPECTED_BARE),
              CODEC_OK);
}

static void test_verify_zstd_dict_bytes_rejects_mismatch(void) {
    /* All-zeros expected vs real bytes hash → mismatch. */
    char zeros[65]; memset(zeros, '0', 64); zeros[64] = 0;
    CT_EQ_INT(codec_verify_zstd_dict_bytes(
                  (const uint8_t *)"hello world", 11, zeros),
              CODEC_ERR_HASH_MISMATCH);
}

static void test_verify_zstd_dict_bytes_rejects_malformed_hash(void) {
    CT_EQ_INT(codec_verify_zstd_dict_bytes(
                  (const uint8_t *)"x", 1, "not-a-real-hash"),
              CODEC_ERR_VALIDATION);
}

static void test_verify_zstd_dict_bytes_accepts_empty_input(void) {
    /* sha256("") known value. */
    static const char EXPECTED_EMPTY[] =
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    CT_EQ_INT(codec_verify_zstd_dict_bytes(NULL, 0, EXPECTED_EMPTY),
              CODEC_OK);
}

/* ── main ──────────────────────────────────────────────────────────────── */

int main(void) {
    CT_RUN(test_hash_zstd_dict_against_fixture);
    CT_RUN(test_hash_zstd_dict_empty_input);
    CT_RUN(test_hash_zstd_dict_known_input);
    CT_RUN(test_hash_zstd_dict_null_out);

    CT_RUN(test_select_ok_when_zstd_and_hash_matches);
    CT_RUN(test_select_case_insensitive_header_names);
    CT_RUN(test_select_uppercase_hex_in_header_accepted);
    CT_RUN(test_select_not_zstd_on_identity);
    CT_RUN(test_select_not_zstd_on_gzip);
    CT_RUN(test_select_missing_header);
    CT_RUN(test_select_malformed_hash);
    CT_RUN(test_select_unknown_hash);
    CT_RUN(test_select_with_fixture_dict);
    CT_RUN(test_select_handles_extra_whitespace);
    CT_RUN(test_select_empty_registry_is_unknown);

    CT_RUN(test_well_known_dict_url_strips_sha256_prefix);
    CT_RUN(test_well_known_dict_url_accepts_bare_hex);
    CT_RUN(test_well_known_dict_url_strips_trailing_slash);
    CT_RUN(test_well_known_dict_url_normalises_uppercase_hex);
    CT_RUN(test_well_known_dict_url_rejects_short_hash);
    CT_RUN(test_well_known_dict_url_rejects_wrong_algorithm);
    CT_RUN(test_well_known_dict_url_rejects_nonhex_chars);
    CT_RUN(test_well_known_dict_url_rejects_undersized_buffer);
    CT_RUN(test_well_known_dict_url_rejects_null_args);
    CT_RUN(test_verify_zstd_dict_bytes_matches_correct_hash);
    CT_RUN(test_verify_zstd_dict_bytes_accepts_bare_hex);
    CT_RUN(test_verify_zstd_dict_bytes_rejects_mismatch);
    CT_RUN(test_verify_zstd_dict_bytes_rejects_malformed_hash);
    CT_RUN(test_verify_zstd_dict_bytes_accepts_empty_input);

    CT_DONE();
}
