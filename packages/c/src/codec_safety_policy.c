/*
 * codec_safety_policy.c: implementation of the safety-policy descriptor
 * parser, accessors, URL builders, and hash verifier.
 *
 * SPDX-License-Identifier: MIT
 *
 * Lean C port. No descriptor *publishing* (canonical-bytes emit) here:
 * embedded / FFI consumers receive descriptors and verify by hash; the
 * publish step happens upstream in TS / Python / Rust / .NET / Java.
 */

#include "codec/codec_safety_policy.h"

/* Use the headers-only form of jsmn: map.c already pulls in the
 * implementation; defining JSMN_HEADER here keeps us at declarations
 * only so the linker doesn't see two copies of jsmn_parse / jsmn_init. */
#define JSMN_HEADER
#include "jsmn.h"
#include "codec_jsmn_guard.h"
#include "sha256.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Internal types ─────────────────────────────────────────────────────── */

typedef struct sp_category {
    char *name;
    codec_safety_action_t action;
    char *description;  /* may be NULL */
} sp_category_t;

struct codec_safety_policy {
    char *id;
    char *version;

    char **tokenizers;
    size_t tokenizer_count;

    sp_category_t *categories;
    size_t category_count;

    char *category_registry;       /* may be NULL */

    char *classifier_family;
    codec_classifier_host_t classifier_host;

    char *published_at;            /* may be NULL */
};

/* ── Helpers ────────────────────────────────────────────────────────────── */

static int tok_str_eq(const char *json, const jsmntok_t *t, const char *lit) {
    if (t->type != JSMN_STRING) return 0;
    size_t lit_len = strlen(lit);
    size_t tok_len = (size_t)(t->end - t->start);
    if (tok_len != lit_len) return 0;
    return memcmp(json + t->start, lit, lit_len) == 0;
}

static char *strndup_tok(const char *json, const jsmntok_t *t) {
    if (t->type != JSMN_STRING) return NULL;
    size_t n = (size_t)(t->end - t->start);
    char *s = (char *)malloc(n + 1);
    if (!s) return NULL;
    memcpy(s, json + t->start, n);
    s[n] = 0;
    return s;
}

/* skip an arbitrary JSON subtree starting at toks[idx]. Returns the
 * number of tokens (incl. the head) consumed. */
static size_t skip_subtree(const jsmntok_t *toks, size_t idx) {
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

static codec_safety_action_t parse_action(const char *json, const jsmntok_t *t) {
    if (tok_str_eq(json, t, "stop"))       return CODEC_SAFETY_ACTION_STOP;
    if (tok_str_eq(json, t, "redact"))     return CODEC_SAFETY_ACTION_REDACT;
    if (tok_str_eq(json, t, "regenerate")) return CODEC_SAFETY_ACTION_REGENERATE;
    if (tok_str_eq(json, t, "flag"))       return CODEC_SAFETY_ACTION_FLAG;
    return CODEC_SAFETY_ACTION_UNKNOWN;
}

static codec_classifier_host_t parse_host(const char *json, const jsmntok_t *t) {
    if (tok_str_eq(json, t, "server")) return CODEC_CLASSIFIER_HOST_SERVER;
    if (tok_str_eq(json, t, "client")) return CODEC_CLASSIFIER_HOST_CLIENT;
    if (tok_str_eq(json, t, "both"))   return CODEC_CLASSIFIER_HOST_BOTH;
    return CODEC_CLASSIFIER_HOST_UNSET;
}

/* Validate a category name against [a-z0-9_-]+ (non-empty). */
static int category_name_ok(const char *s) {
    if (!s || !*s) return 0;
    for (const char *p = s; *p; p++) {
        char c = *p;
        if (!(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9')
            && c != '_' && c != '-')
            return 0;
    }
    return 1;
}

/* Validate an id against [a-z0-9._/-]+ AND no traversal segments. */
static int policy_id_ok(const char *s) {
    if (!s || !*s) return 0;
    if (s[0] == '/') return 0;
    size_t n = strlen(s);
    if (n == 0 || s[n - 1] == '/') return 0;
    if (strstr(s, "..") != NULL) return 0;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (!(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9')
            && c != '_' && c != '-' && c != '.' && c != '/')
            return 0;
    }
    return 1;
}

static void byte_to_hex_lower(uint8_t b, char *out) {
    static const char hex[] = "0123456789abcdef";
    out[0] = hex[(b >> 4) & 0xF];
    out[1] = hex[b & 0xF];
}

/* Compute sha256 of `bytes` and write 64 lowercase-hex chars + NUL into
 * `out` (caller-provided 65 bytes). */
static void sha256_lower_hex(const char *bytes, size_t len, char out[65]) {
    uint8_t digest[32];
    codec_sha256((const uint8_t *)bytes, len, digest);
    for (int i = 0; i < 32; i++) byte_to_hex_lower(digest[i], &out[i * 2]);
    out[64] = 0;
}

/* Parse `expected_hash`: accepts `sha256:<hex>` or bare `<hex>`. Lowercases
 * + writes the hex into `out` (65-byte buffer). Returns 1 on success. */
static int parse_expected_hash(const char *expected, char out[65]) {
    if (!expected) return 0;
    const char *hex = expected;
    const char *colon = strchr(expected, ':');
    if (colon) {
        if ((size_t)(colon - expected) != 6
            || strncmp(expected, "sha256", 6) != 0)
            return 0;
        hex = colon + 1;
    }
    if (strlen(hex) != 64) return 0;
    for (size_t i = 0; i < 64; i++) {
        char c = hex[i];
        if (c >= 'A' && c <= 'F') c = (char)(c - 'A' + 'a');
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
        out[i] = c;
    }
    out[64] = 0;
    return 1;
}

/* ── Parser ─────────────────────────────────────────────────────────────── */

void codec_safety_policy_free(codec_safety_policy_t *p) {
    if (!p) return;
    free(p->id);
    free(p->version);
    if (p->tokenizers) {
        for (size_t i = 0; i < p->tokenizer_count; i++) free(p->tokenizers[i]);
        free(p->tokenizers);
    }
    if (p->categories) {
        for (size_t i = 0; i < p->category_count; i++) {
            free(p->categories[i].name);
            free(p->categories[i].description);
        }
        free(p->categories);
    }
    free(p->category_registry);
    free(p->classifier_family);
    free(p->published_at);
    free(p);
}

codec_status_t codec_safety_policy_from_json(const char *json, size_t len,
                                             codec_safety_policy_t **out) {
    if (!json || !out) return CODEC_ERR_INVALID_ARG;
    *out = NULL;

    /* Tokenize. We grow the buffer on demand. */
    size_t cap = 256;
    jsmntok_t *toks = (jsmntok_t *)malloc(cap * sizeof(jsmntok_t));
    if (!toks) return CODEC_ERR_OUT_OF_MEMORY;
    jsmn_parser parser;
    jsmn_init(&parser);
    int n = jsmn_parse(&parser, json, len, toks, (unsigned int)cap);
    while (n == JSMN_ERROR_NOMEM) {
        cap *= 2;
        jsmntok_t *grow = (jsmntok_t *)realloc(toks, cap * sizeof(jsmntok_t));
        if (!grow) { free(toks); return CODEC_ERR_OUT_OF_MEMORY; }
        toks = grow;
        jsmn_init(&parser);
        n = jsmn_parse(&parser, json, len, toks, (unsigned int)cap);
    }
    if (n < 1 || toks[0].type != JSMN_OBJECT) {
        free(toks);
        return CODEC_ERR_PARSE;
    }
    if (!codec_jsmn_tree_complete(toks, (size_t)n)) {
        free(toks);
        return CODEC_ERR_PARSE;
    }

    codec_safety_policy_t *p = (codec_safety_policy_t *)calloc(1, sizeof(*p));
    if (!p) { free(toks); return CODEC_ERR_OUT_OF_MEMORY; }
    p->classifier_host = CODEC_CLASSIFIER_HOST_UNSET;

    /* Walk top-level keys. toks[0] is the root object; its children are
     * key/value pairs starting at toks[1]. */
    int root_pairs = toks[0].size;
    size_t i = 1;
    int saw_id = 0, saw_version = 0, saw_tokenizers = 0, saw_categories = 0,
        saw_classifier = 0;

    for (int kv = 0; kv < root_pairs; kv++) {
        const jsmntok_t *k = &toks[i];
        size_t v = i + 1;
        const jsmntok_t *vt = &toks[v];
        if (k->type != JSMN_STRING) goto bad_shape;

        if (tok_str_eq(json, k, "id")) {
            if (vt->type != JSMN_STRING) goto bad_shape;
            p->id = strndup_tok(json, vt);
            if (!p->id) goto oom;
            if (p->id[0] == '\0') goto bad_shape;
            saw_id = 1;
            i = v + 1;
        } else if (tok_str_eq(json, k, "version")) {
            if (vt->type != JSMN_STRING) goto bad_shape;
            p->version = strndup_tok(json, vt);
            if (!p->version) goto oom;
            saw_version = 1;
            i = v + 1;
        } else if (tok_str_eq(json, k, "tokenizers")) {
            if (vt->type != JSMN_ARRAY || vt->size == 0) goto bad_shape;
            p->tokenizer_count = (size_t)vt->size;
            p->tokenizers = (char **)calloc(p->tokenizer_count, sizeof(char *));
            if (!p->tokenizers) goto oom;
            size_t e = v + 1;
            for (size_t j = 0; j < p->tokenizer_count; j++) {
                if (toks[e].type != JSMN_STRING) goto bad_shape;
                p->tokenizers[j] = strndup_tok(json, &toks[e]);
                if (!p->tokenizers[j]) goto oom;
                e++;
            }
            saw_tokenizers = 1;
            i = v + skip_subtree(toks, v);
        } else if (tok_str_eq(json, k, "categories")) {
            if (vt->type != JSMN_ARRAY || vt->size == 0) goto bad_shape;
            p->category_count = (size_t)vt->size;
            p->categories = (sp_category_t *)calloc(p->category_count,
                                                    sizeof(sp_category_t));
            if (!p->categories) goto oom;
            size_t e = v + 1;
            for (size_t c = 0; c < p->category_count; c++) {
                const jsmntok_t *ct = &toks[e];
                if (ct->type != JSMN_OBJECT) goto bad_shape;
                int cpairs = ct->size;
                size_t ce = e + 1;
                for (int cp = 0; cp < cpairs; cp++) {
                    const jsmntok_t *ck = &toks[ce];
                    const jsmntok_t *cv = &toks[ce + 1];
                    if (tok_str_eq(json, ck, "name")) {
                        if (cv->type != JSMN_STRING) goto bad_shape;
                        p->categories[c].name = strndup_tok(json, cv);
                        if (!p->categories[c].name) goto oom;
                        if (!category_name_ok(p->categories[c].name)) goto bad_shape;
                    } else if (tok_str_eq(json, ck, "action")) {
                        if (cv->type != JSMN_STRING) goto bad_shape;
                        p->categories[c].action = parse_action(json, cv);
                        if (p->categories[c].action == CODEC_SAFETY_ACTION_UNKNOWN)
                            goto bad_shape;
                    } else if (tok_str_eq(json, ck, "description")) {
                        if (cv->type == JSMN_STRING) {
                            p->categories[c].description = strndup_tok(json, cv);
                            if (!p->categories[c].description) goto oom;
                        } else if (cv->type != JSMN_PRIMITIVE) {
                            /* numbers/booleans/null all primitive; skip */
                        }
                    }
                    ce += 1 + skip_subtree(toks, ce + 1);
                }
                if (!p->categories[c].name
                    || p->categories[c].action == CODEC_SAFETY_ACTION_UNKNOWN)
                    goto bad_shape;
                e = ce;
            }
            saw_categories = 1;
            i = v + skip_subtree(toks, v);
        } else if (tok_str_eq(json, k, "classifier")) {
            if (vt->type != JSMN_OBJECT) goto bad_shape;
            int cpairs = vt->size;
            size_t ce = v + 1;
            for (int cp = 0; cp < cpairs; cp++) {
                const jsmntok_t *ck = &toks[ce];
                const jsmntok_t *cv = &toks[ce + 1];
                if (tok_str_eq(json, ck, "family")) {
                    if (cv->type != JSMN_STRING) goto bad_shape;
                    p->classifier_family = strndup_tok(json, cv);
                    if (!p->classifier_family) goto oom;
                    if (p->classifier_family[0] == '\0') goto bad_shape;
                } else if (tok_str_eq(json, ck, "host")) {
                    if (cv->type == JSMN_STRING)
                        p->classifier_host = parse_host(json, cv);
                }
                ce += 1 + skip_subtree(toks, ce + 1);
            }
            if (!p->classifier_family) goto bad_shape;
            saw_classifier = 1;
            i = v + skip_subtree(toks, v);
        } else if (tok_str_eq(json, k, "category_registry")) {
            if (vt->type == JSMN_STRING) {
                p->category_registry = strndup_tok(json, vt);
                if (!p->category_registry) goto oom;
            }
            i = v + skip_subtree(toks, v);
        } else if (tok_str_eq(json, k, "published_at")) {
            if (vt->type == JSMN_STRING) {
                p->published_at = strndup_tok(json, vt);
                if (!p->published_at) goto oom;
            }
            i = v + skip_subtree(toks, v);
        } else {
            /* Skip unknown / additional fields (rules_summary, client_hooks,
             * publisher): readers only surface the fields C consumers need;
             * full parity lives in the higher-level clients. */
            i = v + skip_subtree(toks, v);
        }
    }

    if (!saw_id || !saw_version || !saw_tokenizers
        || !saw_categories || !saw_classifier) {
        codec_safety_policy_free(p);
        free(toks);
        return CODEC_ERR_VALIDATION;
    }

    free(toks);
    *out = p;
    return CODEC_OK;

bad_shape:
    codec_safety_policy_free(p);
    free(toks);
    return CODEC_ERR_VALIDATION;

oom:
    codec_safety_policy_free(p);
    free(toks);
    return CODEC_ERR_OUT_OF_MEMORY;
}

/* ── Accessors ──────────────────────────────────────────────────────────── */

const char *codec_safety_policy_id(const codec_safety_policy_t *p) {
    return p ? p->id : NULL;
}
const char *codec_safety_policy_version(const codec_safety_policy_t *p) {
    return p ? p->version : NULL;
}
size_t codec_safety_policy_tokenizer_count(const codec_safety_policy_t *p) {
    return p ? p->tokenizer_count : 0;
}
const char *codec_safety_policy_tokenizer(const codec_safety_policy_t *p, size_t i) {
    return (p && i < p->tokenizer_count) ? p->tokenizers[i] : NULL;
}
size_t codec_safety_policy_category_count(const codec_safety_policy_t *p) {
    return p ? p->category_count : 0;
}
const char *codec_safety_policy_category_name(const codec_safety_policy_t *p, size_t i) {
    return (p && i < p->category_count) ? p->categories[i].name : NULL;
}
codec_safety_action_t codec_safety_policy_category_action(
    const codec_safety_policy_t *p, size_t i) {
    return (p && i < p->category_count)
        ? p->categories[i].action : CODEC_SAFETY_ACTION_UNKNOWN;
}
const char *codec_safety_policy_category_description(
    const codec_safety_policy_t *p, size_t i) {
    return (p && i < p->category_count) ? p->categories[i].description : NULL;
}
const char *codec_safety_policy_classifier_family(const codec_safety_policy_t *p) {
    return p ? p->classifier_family : NULL;
}
codec_classifier_host_t codec_safety_policy_classifier_host(
    const codec_safety_policy_t *p) {
    return p ? p->classifier_host : CODEC_CLASSIFIER_HOST_UNSET;
}
const char *codec_safety_policy_category_registry(const codec_safety_policy_t *p) {
    return p ? p->category_registry : NULL;
}
const char *codec_safety_policy_published_at(const codec_safety_policy_t *p) {
    return p ? p->published_at : NULL;
}

/* ── URL builders ──────────────────────────────────────────────────────── */

static codec_status_t safe_snprintf(char *out, size_t cap, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(out, cap, fmt, ap);
    va_end(ap);
    if (n < 0) return CODEC_ERR_INVALID_ARG;
    if ((size_t)n >= cap) return CODEC_ERR_TRUNCATED;
    return CODEC_OK;
}

/* Strip a trailing '/' from origin into a fresh buffer (no allocation;
 * we call snprintf with a precision = origin_len_without_trailing_slash). */

codec_status_t codec_safety_policy_well_known_url(const char *origin,
                                                  const char *policy_id,
                                                  char *out, size_t out_cap) {
    if (!origin || !policy_id || !out || out_cap == 0)
        return CODEC_ERR_INVALID_ARG;
    if (!policy_id_ok(policy_id))
        return CODEC_ERR_INVALID_ARG;
    size_t olen = strlen(origin);
    if (olen > 0 && origin[olen - 1] == '/') olen--;
    return safe_snprintf(out, out_cap, "%.*s%s/%s.json",
                         (int)olen, origin,
                         CODEC_SAFETY_POLICY_WELL_KNOWN_BASE,
                         policy_id);
}

codec_status_t codec_safety_policy_well_known_hash_url(const char *origin,
                                                       const char *hash_hex,
                                                       char *out, size_t out_cap) {
    if (!origin || !hash_hex || !out || out_cap == 0)
        return CODEC_ERR_INVALID_ARG;
    /* Lowercase + validate the hex. */
    char lower[65];
    if (strlen(hash_hex) != 64) return CODEC_ERR_INVALID_ARG;
    for (size_t i = 0; i < 64; i++) {
        char c = hash_hex[i];
        if (c >= 'A' && c <= 'F') c = (char)(c - 'A' + 'a');
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
            return CODEC_ERR_INVALID_ARG;
        lower[i] = c;
    }
    lower[64] = 0;
    size_t olen = strlen(origin);
    if (olen > 0 && origin[olen - 1] == '/') olen--;
    return safe_snprintf(out, out_cap, "%.*s%s/sha256/%s.json",
                         (int)olen, origin,
                         CODEC_SAFETY_POLICY_WELL_KNOWN_BASE,
                         lower);
}

/* ── Hash verification ─────────────────────────────────────────────────── */

codec_status_t codec_safety_policy_verify_sha256(const char *bytes, size_t len,
                                                 const char *expected_hash) {
    if (!bytes || !expected_hash) return CODEC_ERR_INVALID_ARG;
    char want[65];
    if (!parse_expected_hash(expected_hash, want))
        return CODEC_ERR_INVALID_ARG;
    char actual[65];
    sha256_lower_hex(bytes, len, actual);
    if (memcmp(actual, want, 64) != 0)
        return CODEC_ERR_HASH_MISMATCH;
    return CODEC_OK;
}

