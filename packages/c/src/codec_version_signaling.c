/*
 * codec_version_signaling.c — C client-side for Codec v0.4 version
 * negotiation.
 *
 * SPDX-License-Identifier: MIT
 *
 * Mirrors @codecai/web's version-signaling.ts. See header for the
 * public surface and the spec for the contract.
 */

#include "codec/codec_version_signaling.h"

#define JSMN_HEADER
#include "jsmn.h"
#include "codec_jsmn_guard.h"

#include <stdlib.h>
#include <string.h>

/* ── Helpers (mirror codec_safety_policy.c's idiom) ─────────────────────── */

static int tok_str_eq_(const char *json, const jsmntok_t *t, const char *lit) {
    if (t->type != JSMN_STRING) return 0;
    size_t lit_len = strlen(lit);
    size_t tok_len = (size_t)(t->end - t->start);
    if (tok_len != lit_len) return 0;
    return memcmp(json + t->start, lit, lit_len) == 0;
}

static char *strndup_tok_(const char *json, const jsmntok_t *t) {
    size_t n = (size_t)(t->end - t->start);
    char *s = (char *)malloc(n + 1);
    if (!s) return NULL;
    memcpy(s, json + t->start, n);
    s[n] = 0;
    return s;
}

static size_t skip_subtree_(const jsmntok_t *toks, size_t idx) {
    size_t i = idx;
    size_t remaining = 1;
    while (remaining > 0) {
        const jsmntok_t *t = &toks[i++];
        remaining--;
        if (t->type == JSMN_OBJECT) remaining += (size_t)t->size * 2;
        else if (t->type == JSMN_ARRAY) remaining += (size_t)t->size;
    }
    return i - idx;
}

/* Parse the JSON. Returns a malloc'd token array on success; caller
 * frees. Sets *toks_count to the number of populated tokens. */
static jsmntok_t *parse_json_(const char *json, size_t len, size_t *toks_count) {
    jsmn_parser p;
    jsmn_init(&p);
    int needed = jsmn_parse(&p, json, len, NULL, 0);
    if (needed <= 0) return NULL;
    jsmntok_t *toks = (jsmntok_t *)malloc(sizeof(jsmntok_t) * (size_t)needed);
    if (!toks) return NULL;
    jsmn_init(&p);
    int got = jsmn_parse(&p, json, len, toks, (unsigned int)needed);
    if (got != needed) {
        free(toks);
        return NULL;
    }
    if (!codec_jsmn_tree_complete(toks, (size_t)got)) {
        free(toks);
        return NULL;
    }
    *toks_count = (size_t)got;
    return toks;
}

/* Locate the value of an object field by key name. Returns the index
 * of the value token (idx+1 of the key) or 0 if not found.
 * Assumes the object token is at toks[0]. */
static size_t find_field_(const char *json, const jsmntok_t *toks, size_t toks_count,
                          const char *key) {
    if (toks_count == 0 || toks[0].type != JSMN_OBJECT) return 0;
    size_t num_pairs = (size_t)toks[0].size;
    size_t i = 1;
    for (size_t p = 0; p < num_pairs; p++) {
        if (i >= toks_count) return 0;
        const jsmntok_t *k = &toks[i];
        if (tok_str_eq_(json, k, key)) {
            return i + 1;
        }
        i++;  /* past key */
        if (i >= toks_count) return 0;
        i += skip_subtree_(toks, i);
    }
    return 0;
}

/* Read an array of strings at toks[idx]. Caller frees out_arr + each item. */
static codec_status_t read_string_array_(
    const char *json, const jsmntok_t *toks, size_t toks_count, size_t idx,
    char ***out_arr, size_t *out_count) {
    *out_arr = NULL;
    *out_count = 0;
    if (idx >= toks_count || toks[idx].type != JSMN_ARRAY) {
        return CODEC_ERR_VALIDATION;
    }
    size_t n = (size_t)toks[idx].size;
    if (n == 0) return CODEC_OK;

    char **arr = (char **)calloc(n, sizeof(char *));
    if (!arr) return CODEC_ERR_OUT_OF_MEMORY;

    size_t i = idx + 1;
    for (size_t k = 0; k < n; k++) {
        if (i >= toks_count || toks[i].type != JSMN_STRING) {
            for (size_t j = 0; j < k; j++) free(arr[j]);
            free(arr);
            return CODEC_ERR_VALIDATION;
        }
        arr[k] = strndup_tok_(json, &toks[i]);
        if (!arr[k]) {
            for (size_t j = 0; j < k; j++) free(arr[j]);
            free(arr);
            return CODEC_ERR_OUT_OF_MEMORY;
        }
        i++;
    }
    *out_arr = arr;
    *out_count = n;
    return CODEC_OK;
}

static codec_status_t read_optional_string_(
    const char *json, const jsmntok_t *toks, size_t toks_count,
    const char *key, char **out) {
    *out = NULL;
    size_t idx = find_field_(json, toks, toks_count, key);
    if (idx == 0 || idx >= toks_count) return CODEC_OK;  /* missing is fine */
    if (toks[idx].type != JSMN_STRING) return CODEC_OK;  /* null/non-string ignored */
    *out = strndup_tok_(json, &toks[idx]);
    return (*out == NULL) ? CODEC_ERR_OUT_OF_MEMORY : CODEC_OK;
}

/* ── codec_version_required_parse ───────────────────────────────────────── */

codec_status_t codec_version_required_parse(
    const char *json_bytes, size_t json_len,
    codec_version_required_body_t *out) {
    if (!json_bytes || !out) return CODEC_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));

    size_t toks_count = 0;
    jsmntok_t *toks = parse_json_(json_bytes, json_len, &toks_count);
    if (!toks) return CODEC_ERR_PARSE;

    codec_status_t rc = CODEC_OK;

    size_t err_idx = find_field_(json_bytes, toks, toks_count, "error");
    if (!err_idx || toks[err_idx].type != JSMN_STRING
        || !tok_str_eq_(json_bytes, &toks[err_idx], "codec_version_required")) {
        rc = CODEC_ERR_VALIDATION;
        goto done;
    }
    out->error = strndup_tok_(json_bytes, &toks[err_idx]);
    if (!out->error) { rc = CODEC_ERR_OUT_OF_MEMORY; goto done; }

    size_t mv_idx = find_field_(json_bytes, toks, toks_count, "minimum_version");
    if (!mv_idx || toks[mv_idx].type != JSMN_STRING) {
        rc = CODEC_ERR_VALIDATION; goto done;
    }
    out->minimum_version = strndup_tok_(json_bytes, &toks[mv_idx]);
    if (!out->minimum_version) { rc = CODEC_ERR_OUT_OF_MEMORY; goto done; }

    size_t cv_idx = find_field_(json_bytes, toks, toks_count, "client_version");
    if (!cv_idx || toks[cv_idx].type != JSMN_STRING) {
        rc = CODEC_ERR_VALIDATION; goto done;
    }
    out->client_version = strndup_tok_(json_bytes, &toks[cv_idx]);
    if (!out->client_version) { rc = CODEC_ERR_OUT_OF_MEMORY; goto done; }

    size_t rf_idx = find_field_(json_bytes, toks, toks_count, "required_features");
    if (rf_idx) {
        rc = read_string_array_(json_bytes, toks, toks_count, rf_idx,
                                &out->required_features,
                                &out->required_features_count);
        if (rc != CODEC_OK) goto done;
    }

    rc = read_optional_string_(json_bytes, toks, toks_count, "docs_url", &out->docs_url);
    if (rc != CODEC_OK) goto done;
    rc = read_optional_string_(json_bytes, toks, toks_count, "deployment_id", &out->deployment_id);
    if (rc != CODEC_OK) goto done;

done:
    free(toks);
    if (rc != CODEC_OK) {
        codec_version_required_free(out);
    }
    return rc;
}

void codec_version_required_free(codec_version_required_body_t *body) {
    if (!body) return;
    free(body->error);
    free(body->minimum_version);
    free(body->client_version);
    if (body->required_features) {
        for (size_t i = 0; i < body->required_features_count; i++) {
            free(body->required_features[i]);
        }
        free(body->required_features);
    }
    free(body->docs_url);
    free(body->deployment_id);
    memset(body, 0, sizeof(*body));
}

/* ── codec_version_policy_parse ─────────────────────────────────────────── */

codec_status_t codec_version_policy_parse(
    const char *json_bytes, size_t json_len,
    codec_version_policy_doc_t *out) {
    if (!json_bytes || !out) return CODEC_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));

    size_t toks_count = 0;
    jsmntok_t *toks = parse_json_(json_bytes, json_len, &toks_count);
    if (!toks) return CODEC_ERR_PARSE;

    codec_status_t rc = CODEC_OK;

    size_t mv_idx = find_field_(json_bytes, toks, toks_count, "minimum_version");
    if (!mv_idx || toks[mv_idx].type != JSMN_STRING
        || (size_t)(toks[mv_idx].end - toks[mv_idx].start) == 0) {
        rc = CODEC_ERR_VALIDATION; goto done;
    }
    out->minimum_version = strndup_tok_(json_bytes, &toks[mv_idx]);
    if (!out->minimum_version) { rc = CODEC_ERR_OUT_OF_MEMORY; goto done; }

    size_t rf_idx = find_field_(json_bytes, toks, toks_count, "required_features");
    if (!rf_idx || toks[rf_idx].type != JSMN_ARRAY) {
        rc = CODEC_ERR_VALIDATION; goto done;
    }
    rc = read_string_array_(json_bytes, toks, toks_count, rf_idx,
                            &out->required_features, &out->required_features_count);
    if (rc != CODEC_OK) goto done;

    rc = read_optional_string_(json_bytes, toks, toks_count, "deployment_id",
                               &out->deployment_id);
    if (rc != CODEC_OK) goto done;
    rc = read_optional_string_(json_bytes, toks, toks_count, "docs_url", &out->docs_url);
    if (rc != CODEC_OK) goto done;
    rc = read_optional_string_(json_bytes, toks, toks_count, "valid_until", &out->valid_until);
    if (rc != CODEC_OK) goto done;

done:
    free(toks);
    if (rc != CODEC_OK) codec_version_policy_free(out);
    return rc;
}

void codec_version_policy_free(codec_version_policy_doc_t *doc) {
    if (!doc) return;
    free(doc->minimum_version);
    if (doc->required_features) {
        for (size_t i = 0; i < doc->required_features_count; i++) {
            free(doc->required_features[i]);
        }
        free(doc->required_features);
    }
    free(doc->deployment_id);
    free(doc->docs_url);
    free(doc->valid_until);
    memset(doc, 0, sizeof(*doc));
}

/* ── codec_well_known_version_policy_url ────────────────────────────────── */

codec_status_t codec_well_known_version_policy_url(
    const char *origin, char *out_buf, size_t buf_size) {
    if (!origin || !out_buf) return CODEC_ERR_INVALID_ARG;
    static const char SUFFIX[] = "/.well-known/codec/version-policy.json";

    size_t olen = strlen(origin);
    while (olen > 0 && origin[olen - 1] == '/') olen--;

    size_t needed = olen + (sizeof(SUFFIX) - 1) + 1;
    if (buf_size < needed) return CODEC_ERR_TRUNCATED;

    memcpy(out_buf, origin, olen);
    memcpy(out_buf + olen, SUFFIX, sizeof(SUFFIX) - 1);
    out_buf[olen + sizeof(SUFFIX) - 1] = 0;
    return CODEC_OK;
}
