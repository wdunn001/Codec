/*
 * test_wire_picker.c — unit + conformance tests for codec_wire_picker.
 *
 * SPDX-License-Identifier: MIT
 *
 * Two test groups:
 *
 *   1. Unit tests — direct calls against the C picker, mirroring the
 *      hand-curated cases in packages/wire-compress/test/picker.test.ts.
 *
 *   2. Conformance — replay the 12.9K shared vector set
 *      (packages/wire-compress/test/conformance-vectors.json) against
 *      the C picker and assert encoding + reason_code match the TS
 *      reference byte-for-byte. The vector path is passed via the
 *      CODEC_WIRE_CONFORMANCE_VECTORS env var (set by the test CMake);
 *      conformance is skipped (with a warning) if the file is absent
 *      so partial checkouts / clean clones don't break the unit run.
 *
 * Uses jsmn (already vendored in src/jsmn.h) for JSON parsing — keeps
 * the test dependency-free, no extra fetch.
 */

#include "codec/codec_wire_picker.h"
#include "codec_test.h"

/* Pull jsmn impl into this translation unit (header is single-include). */
#include "../src/jsmn.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Unit tests ─────────────────────────────────────────────────────────── */

static void test_parse_accept_encoding_basic(void) {
    codec_wire_client_support_t c;

    /* NULL header → unspecified + identity only. */
    CT_EQ_INT(CODEC_OK, codec_wire_parse_accept_encoding(NULL, &c));
    CT_TRUE(c.unspecified);
    CT_TRUE(c.accepts_identity);
    CT_TRUE(!c.accepts_gzip);
    CT_TRUE(!c.accepts_br);
    CT_TRUE(!c.accepts_zstd);

    /* Full slate. */
    CT_EQ_INT(CODEC_OK, codec_wire_parse_accept_encoding("gzip, br, zstd", &c));
    CT_TRUE(!c.unspecified);
    CT_TRUE(c.accepts_gzip);
    CT_TRUE(c.accepts_br);
    CT_TRUE(c.accepts_zstd);
    CT_TRUE(c.accepts_identity);

    /* identity;q=0 → identity dropped. */
    CT_EQ_INT(CODEC_OK, codec_wire_parse_accept_encoding("gzip, identity;q=0", &c));
    CT_TRUE(c.accepts_gzip);
    CT_TRUE(!c.accepts_identity);

    /* q=0 entry dropped. */
    CT_EQ_INT(CODEC_OK, codec_wire_parse_accept_encoding("gzip;q=0, zstd;q=1.0", &c));
    CT_TRUE(!c.accepts_gzip);
    CT_TRUE(c.accepts_zstd);
    CT_TRUE(c.accepts_identity);
}

static void test_pick_default_no_zstd_gates(void) {
    codec_wire_pick_input_t in = {
        .accept_encoding = "zstd, gzip, br",
        .estimated_size = 1024,
    };
    codec_wire_pick_result_t r;
    CT_EQ_INT(CODEC_OK, codec_wire_pick(&in, &r));
    CT_EQ_INT(CODEC_WIRE_ENC_GZIP, r.encoding);
    CT_EQ_INT(CODEC_WIRE_REASON_GZIP_NO_DICT, r.reason_code);
}

static void test_pick_both_gates_pass_zstd(void) {
    codec_wire_pick_input_t in = {
        .accept_encoding = "zstd, gzip, br",
        .estimated_size = 1024,
        .zstd_has_dict = true,
        /* zstd_enabled defaults true at v0.5. */
    };
    codec_wire_pick_result_t r;
    CT_EQ_INT(CODEC_OK, codec_wire_pick(&in, &r));
    CT_EQ_INT(CODEC_WIRE_ENC_ZSTD, r.encoding);
    CT_EQ_INT(CODEC_WIRE_REASON_DICT_ZSTD_DEFAULT, r.reason_code);
}

static void test_pick_zstd_disabled_middleware(void) {
    codec_wire_pick_input_t in = {
        .accept_encoding = "zstd, gzip, br",
        .estimated_size = 1024,
        .zstd_has_dict = true,
        .zstd_enabled_set = true,
        .zstd_enabled = false,
    };
    codec_wire_pick_result_t r;
    CT_EQ_INT(CODEC_OK, codec_wire_pick(&in, &r));
    CT_EQ_INT(CODEC_WIRE_ENC_GZIP, r.encoding);
    CT_EQ_INT(CODEC_WIRE_REASON_GZIP_MIDDLEWARE_DISABLED, r.reason_code);
}

static void test_pick_br_only_client(void) {
    codec_wire_pick_input_t in = {
        .accept_encoding = "br",
        .estimated_size = 1024,
    };
    codec_wire_pick_result_t r;
    CT_EQ_INT(CODEC_OK, codec_wire_pick(&in, &r));
    CT_EQ_INT(CODEC_WIRE_ENC_BR, r.encoding);
    CT_EQ_INT(CODEC_WIRE_REASON_BR_FALLBACK_NO_GZIP, r.reason_code);
}

static void test_pick_zstd_only_client_no_dict(void) {
    /* Server has no dict; client only advertises zstd. Per spec, refuse
     * to pick zstd (no dict + no gzip in candidate set + no br) → identity. */
    codec_wire_pick_input_t in = {
        .accept_encoding = "zstd",
        .estimated_size = 1024,
    };
    codec_wire_pick_result_t r;
    CT_EQ_INT(CODEC_OK, codec_wire_pick(&in, &r));
    CT_EQ_INT(CODEC_WIRE_ENC_IDENTITY, r.encoding);
}

static void test_build_accept_encoding(void) {
    char buf[CODEC_WIRE_ACCEPT_ENCODING_BUF_LEN];
    CT_EQ_INT(CODEC_OK, codec_wire_build_accept_encoding(true, true, false, buf, sizeof(buf)));
    CT_EQ_STR(buf, "gzip;q=1.0, br;q=0.5");
    CT_EQ_INT(CODEC_OK, codec_wire_build_accept_encoding(true, true, true, buf, sizeof(buf)));
    CT_EQ_STR(buf, "gzip;q=1.0, br;q=0.5, zstd;q=0.3");
}

static void test_shannon_entropy(void) {
    uint8_t zeros[100] = {0};
    double e = codec_wire_shannon_entropy_bits_per_byte(zeros, sizeof(zeros));
    CT_TRUE(e == 0.0);

    uint8_t uniform[256];
    for (int i = 0; i < 256; i++) uniform[i] = (uint8_t)i;
    e = codec_wire_shannon_entropy_bits_per_byte(uniform, sizeof(uniform));
    CT_TRUE(e > 7.5 && e <= 8.0);

    /* Empty buffer → 0. */
    CT_TRUE(codec_wire_shannon_entropy_bits_per_byte(NULL, 0) == 0.0);
}

static void test_content_aware_low_entropy_picks_br(void) {
    uint8_t sample[256];
    memset(sample, 0x41, sizeof(sample));
    codec_wire_pick_input_t in = {
        .accept_encoding = "zstd, gzip, br",
        .estimated_size = 1024,
        .zstd_has_dict = true,
        .sample_bytes = sample,
        .sample_len = sizeof(sample),
    };
    codec_wire_pick_result_t r;
    CT_EQ_INT(CODEC_OK, codec_wire_pick(&in, &r));
    CT_EQ_INT(CODEC_WIRE_ENC_BR, r.encoding);
    CT_EQ_INT(CODEC_WIRE_REASON_BR_CONTENT_SAMPLE_LOW_ENTROPY, r.reason_code);
}

/* ── Conformance: replay the cross-language vector set ──────────────────── */

static char *slurp(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[got] = 0;
    if (out_len) *out_len = got;
    return buf;
}

/* String compare against a jsmn token region. */
static int jeq(const char *json, jsmntok_t *t, const char *s) {
    int len = t->end - t->start;
    if ((int)strlen(s) != len) return 0;
    return strncmp(json + t->start, s, (size_t)len) == 0;
}

static int jeq_null(const char *json, jsmntok_t *t) {
    return t->type == JSMN_PRIMITIVE && json[t->start] == 'n';
}

static int jbool(const char *json, jsmntok_t *t) {
    return t->type == JSMN_PRIMITIVE && json[t->start] == 't';
}

static char *jstr(const char *json, jsmntok_t *t) {
    if (t->type == JSMN_STRING) {
        int n = t->end - t->start;
        char *out = malloc((size_t)n + 1);
        memcpy(out, json + t->start, (size_t)n);
        out[n] = 0;
        return out;
    }
    if (t->type == JSMN_PRIMITIVE && (json[t->start] == 't' || json[t->start] == 'f')) {
        const char *lit = json[t->start] == 't' ? "true" : "false";
        size_t n = strlen(lit);
        char *out = malloc(n + 1);
        memcpy(out, lit, n + 1);
        return out;
    }
    return NULL;
}

static int jint(const char *json, jsmntok_t *t) {
    char tmp[24];
    int n = t->end - t->start;
    if (n >= (int)sizeof(tmp)) return 0;
    memcpy(tmp, json + t->start, (size_t)n);
    tmp[n] = 0;
    return atoi(tmp);
}

/* Map encoding wire name → codec_wire_encoding_t. */
static int parse_enc(const char *s, codec_wire_encoding_t *out) {
    if (!strcmp(s, "identity")) { *out = CODEC_WIRE_ENC_IDENTITY; return 1; }
    if (!strcmp(s, "gzip"))     { *out = CODEC_WIRE_ENC_GZIP;     return 1; }
    if (!strcmp(s, "br"))       { *out = CODEC_WIRE_ENC_BR;       return 1; }
    if (!strcmp(s, "zstd"))     { *out = CODEC_WIRE_ENC_ZSTD;     return 1; }
    return 0;
}

/* Map reason wire name → codec_wire_pick_reason_t. */
static int parse_reason(const char *s, codec_wire_pick_reason_t *out) {
    for (int i = 0; i <= CODEC_WIRE_REASON_IDENTITY_LAST_RESORT; i++) {
        if (!strcmp(s, codec_wire_pick_reason_name((codec_wire_pick_reason_t)i))) {
            *out = (codec_wire_pick_reason_t)i;
            return 1;
        }
    }
    return 0;
}

static int divergences = 0;

static void run_one_case(const char *json,
                         jsmntok_t  *toks,
                         int         obj_idx,
                         int         obj_size,
                         int         vector_id)
{
    /* Walk the object's keys. */
    const char *accept = NULL;
    char       *accept_owned = NULL;
    int         size = 0;
    int         interactive = 1;
    int         has_dict = 0;
    int         enabled = 1;
    const char *stack_name = NULL;
    char       *stack_owned = NULL;
    const char *sample_id = "none";
    char       *sample_owned = NULL;
    const char *expect_enc = NULL;
    char       *expect_enc_owned = NULL;
    const char *expect_reason = NULL;
    char       *expect_reason_owned = NULL;

    int p = obj_idx + 1;
    for (int k = 0; k < obj_size; k++) {
        jsmntok_t *key = &toks[p];
        jsmntok_t *val = &toks[p + 1];
        if (jeq(json, key, "accept_encoding")) {
            if (jeq_null(json, val)) accept = NULL;
            else { accept_owned = jstr(json, val); accept = accept_owned; }
        } else if (jeq(json, key, "estimated_size")) {
            size = jint(json, val);
        } else if (jeq(json, key, "interactive")) {
            interactive = jbool(json, val);
        } else if (jeq(json, key, "zstd_has_dict")) {
            has_dict = jbool(json, val);
        } else if (jeq(json, key, "zstd_enabled")) {
            enabled = jbool(json, val);
        } else if (jeq(json, key, "stack_profile")) {
            if (jeq_null(json, val)) stack_name = NULL;
            else { stack_owned = jstr(json, val); stack_name = stack_owned; }
        } else if (jeq(json, key, "sample")) {
            sample_owned = jstr(json, val);
            sample_id = sample_owned;
        } else if (jeq(json, key, "expect_encoding")) {
            expect_enc_owned = jstr(json, val);
            expect_enc = expect_enc_owned;
        } else if (jeq(json, key, "expect_reason_code")) {
            expect_reason_owned = jstr(json, val);
            expect_reason = expect_reason_owned;
        }
        p += 2;
    }

    /* Build sample bytes that mirror the JS PRNG-generated samples by id.
     * Note: the C runner doesn't need to reproduce the exact PRNG sequence,
     * because the picker only cares about *entropy* and both samples are
     * pre-classified low / high. Synthesize bytes with the same entropy
     * profile here. */
    uint8_t low_entropy[256];
    uint8_t high_entropy[256];
    memset(low_entropy, 0x41, sizeof(low_entropy));
    for (int i = 0; i < 256; i++) high_entropy[i] = (uint8_t)i;

    const uint8_t *sample_bytes = NULL;
    size_t sample_len = 0;
    if (!strcmp(sample_id, "low-entropy")) {
        sample_bytes = low_entropy;
        sample_len = sizeof(low_entropy);
    } else if (!strcmp(sample_id, "high-entropy")) {
        sample_bytes = high_entropy;
        sample_len = sizeof(high_entropy);
    }

    codec_wire_pick_input_t in = {
        .accept_encoding = accept,
        .estimated_size  = size,
        .interactive_set = true,
        .interactive     = (bool)interactive,
        .zstd_enabled_set = true,
        .zstd_enabled    = (bool)enabled,
        .zstd_has_dict   = (bool)has_dict,
        .stack_profile   = codec_wire_profile_for(stack_name),
        .sample_bytes    = sample_bytes,
        .sample_len      = sample_len,
    };
    codec_wire_pick_result_t r;
    codec_status_t st = codec_wire_pick(&in, &r);
    if (st != CODEC_OK) {
        CT_FAIL("vector %d: codec_wire_pick returned %d", vector_id, (int)st);
        goto cleanup;
    }

    codec_wire_encoding_t want_enc;
    codec_wire_pick_reason_t want_reason;
    if (!parse_enc(expect_enc, &want_enc)) {
        CT_FAIL("vector %d: unknown expected encoding %s", vector_id, expect_enc);
        goto cleanup;
    }
    if (!parse_reason(expect_reason, &want_reason)) {
        CT_FAIL("vector %d: unknown expected reason %s", vector_id, expect_reason);
        goto cleanup;
    }

    if (r.encoding != want_enc || r.reason_code != want_reason) {
        if (divergences < 10) {
            fprintf(stderr,
                    "  vector %d divergence: accept=%s size=%d interactive=%d "
                    "has_dict=%d enabled=%d stack=%s sample=%s\n"
                    "    expect: enc=%s reason=%s\n"
                    "    got:    enc=%s reason=%s\n",
                    vector_id, accept ? accept : "(null)", size, interactive,
                    has_dict, enabled, stack_name ? stack_name : "(default)",
                    sample_id,
                    expect_enc, expect_reason,
                    codec_wire_encoding_name(r.encoding),
                    codec_wire_pick_reason_name(r.reason_code));
        }
        divergences++;
    }

cleanup:
    free(accept_owned);
    free(stack_owned);
    free(sample_owned);
    free(expect_enc_owned);
    free(expect_reason_owned);
}

static void test_conformance(void) {
    const char *vec_path = getenv("CODEC_WIRE_CONFORMANCE_VECTORS");
    if (!vec_path) {
        fprintf(stderr, "  [skip] CODEC_WIRE_CONFORMANCE_VECTORS unset\n");
        return;
    }
    size_t json_len = 0;
    char *json = slurp(vec_path, &json_len);
    if (!json) {
        fprintf(stderr, "  [skip] could not read vectors from %s\n", vec_path);
        return;
    }

    jsmn_parser parser;
    jsmn_init(&parser);
    /* First pass: count tokens. */
    int n_toks = jsmn_parse(&parser, json, json_len, NULL, 0);
    if (n_toks < 0) {
        CT_FAIL("conformance: jsmn token count failed (%d)", n_toks);
        free(json);
        return;
    }
    jsmntok_t *toks = malloc((size_t)n_toks * sizeof(*toks));
    jsmn_init(&parser);
    int got = jsmn_parse(&parser, json, json_len, toks, n_toks);
    if (got < 0) {
        CT_FAIL("conformance: jsmn parse failed (%d)", got);
        free(json); free(toks);
        return;
    }

    /* Find the "vectors" array at the top-level object. */
    int p = 1; /* skip root object */
    int vectors_idx = -1;
    int vectors_size = 0;
    int root_size = toks[0].size;
    for (int k = 0; k < root_size; k++) {
        if (jeq(json, &toks[p], "vectors")) {
            vectors_idx = p + 1;
            vectors_size = toks[p + 1].size;
            break;
        }
        /* skip key + its value subtree */
        p++;
        /* Token sub-tree walk: jsmn doesn't track subtree size in tokens
         * directly other than .size; iterate the value subtree manually. */
        int subtree = 1; /* the value itself */
        int sub_p = p;
        while (subtree > 0) {
            subtree--;
            if (toks[sub_p].type == JSMN_OBJECT) subtree += toks[sub_p].size * 2;
            else if (toks[sub_p].type == JSMN_ARRAY) subtree += toks[sub_p].size;
            sub_p++;
        }
        p = sub_p;
    }
    if (vectors_idx < 0) {
        CT_FAIL("conformance: 'vectors' key not found");
        free(json); free(toks);
        return;
    }

    /* Iterate each vector object. */
    int vp = vectors_idx + 1;
    int run = 0;
    for (int i = 0; i < vectors_size; i++) {
        if (toks[vp].type != JSMN_OBJECT) {
            CT_FAIL("conformance: vectors[%d] not object", i);
            break;
        }
        int obj_size = toks[vp].size;
        run_one_case(json, toks, vp, obj_size, i);
        run++;
        /* Advance vp past this object's key/value pairs. */
        int sub_p = vp + 1;
        for (int k = 0; k < obj_size; k++) {
            sub_p++;
            int subtree = 1;
            while (subtree > 0) {
                subtree--;
                if (toks[sub_p].type == JSMN_OBJECT) subtree += toks[sub_p].size * 2;
                else if (toks[sub_p].type == JSMN_ARRAY) subtree += toks[sub_p].size;
                sub_p++;
            }
        }
        vp = sub_p;
    }

    if (divergences > 0) {
        CT_FAIL("conformance: %d / %d vectors diverged from TS reference",
                divergences, run);
    } else {
        fprintf(stdout, "  conformance: %d vectors matched TS reference\n", run);
    }

    free(json);
    free(toks);
}

int main(void) {
    CT_RUN(test_parse_accept_encoding_basic);
    CT_RUN(test_pick_default_no_zstd_gates);
    CT_RUN(test_pick_both_gates_pass_zstd);
    CT_RUN(test_pick_zstd_disabled_middleware);
    CT_RUN(test_pick_br_only_client);
    CT_RUN(test_pick_zstd_only_client_no_dict);
    CT_RUN(test_build_accept_encoding);
    CT_RUN(test_shannon_entropy);
    CT_RUN(test_content_aware_low_entropy_picks_br);
    CT_RUN(test_conformance);
    CT_DONE();
}
