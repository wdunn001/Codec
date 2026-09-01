/*
 * codec_compression.c: implementation of the dict-zstd client helpers.
 *
 * SPDX-License-Identifier: MIT
 *
 * Mirrors the Python helper in packages/python/src/codecai/compression.py:
 * tiny surface, deliberately stops at "give me the dict bytes for this
 * response". libzstd / libcurl / the caller's HTTP stack own everything
 * downstream.
 */

#include "codec/codec_compression.h"
#include "sha256.h"

#include <ctype.h>
#include <stddef.h>
#include <string.h>

/* ── Helpers ────────────────────────────────────────────────────────────── */

static void byte_to_hex_lower(uint8_t b, char *out) {
    static const char hex[] = "0123456789abcdef";
    out[0] = hex[(b >> 4) & 0xF];
    out[1] = hex[b & 0xF];
}

/* ASCII case-insensitive compare. Header names are ASCII per RFC 7230. */
static int ci_eq(const char *a, const char *b) {
    if (!a || !b) return 0;
    while (*a && *b) {
        unsigned char ca = (unsigned char)*a++;
        unsigned char cb = (unsigned char)*b++;
        if (ca >= 'A' && ca <= 'Z') ca = (unsigned char)(ca - 'A' + 'a');
        if (cb >= 'A' && cb <= 'Z') cb = (unsigned char)(cb - 'A' + 'a');
        if (ca != cb) return 0;
    }
    return *a == 0 && *b == 0;
}

/* Find the first header whose name matches `name` case-insensitively.
 * Returns the value (borrowed from the headers array) or NULL. */
static const char *find_header(const codec_header_kv_t *headers, size_t n,
                               const char *name) {
    if (!headers) return NULL;
    for (size_t i = 0; i < n; i++) {
        if (ci_eq(headers[i].name, name)) return headers[i].value;
    }
    return NULL;
}

/* Strip leading + trailing ASCII whitespace into a fresh pointer pair.
 * Returns pointer to first non-WS char; *end_out points one past the
 * last non-WS char. */
static const char *trim(const char *s, const char **end_out) {
    if (!s) { if (end_out) *end_out = NULL; return NULL; }
    while (*s && isspace((unsigned char)*s)) s++;
    const char *e = s + strlen(s);
    while (e > s && isspace((unsigned char)e[-1])) e--;
    if (end_out) *end_out = e;
    return s;
}

/* Compare a (possibly trimmed) substring [s, e) to a literal,
 * case-insensitively. */
static int range_ci_eq(const char *s, const char *e, const char *lit) {
    size_t lit_len = strlen(lit);
    if ((size_t)(e - s) != lit_len) return 0;
    for (size_t i = 0; i < lit_len; i++) {
        unsigned char ca = (unsigned char)s[i];
        unsigned char cb = (unsigned char)lit[i];
        if (ca >= 'A' && ca <= 'Z') ca = (unsigned char)(ca - 'A' + 'a');
        if (cb >= 'A' && cb <= 'Z') cb = (unsigned char)(cb - 'A' + 'a');
        if (ca != cb) return 0;
    }
    return 1;
}

/* ── codec_hash_zstd_dict ──────────────────────────────────────────────── */

int codec_hash_zstd_dict(const uint8_t *bytes, size_t len,
                         char out_hex[CODEC_ZSTD_DICT_HASH_BUF_LEN]) {
    if (!out_hex) return -1;
    /* bytes==NULL is allowed iff len==0 (the empty input is well-defined
     * for sha256). */
    if (!bytes && len != 0) return -1;

    uint8_t digest[32];
    codec_sha256(bytes, len, digest);

    memcpy(out_hex, "sha256:", 7);
    for (int i = 0; i < 32; i++) byte_to_hex_lower(digest[i], &out_hex[7 + i * 2]);
    out_hex[7 + 64] = 0;  /* index 71 */
    return 0;
}

/* ── codec_select_zstd_dict_for_response ───────────────────────────────── */

/* Parse "sha256:<64 hex>": trimmed, lowercased into `out_norm` (a 72-byte
 * buffer). Returns 1 on success, 0 on shape failure. */
static int normalise_dict_hash(const char *raw, char out_norm[72]) {
    if (!raw) return 0;
    const char *end = NULL;
    const char *s = trim(raw, &end);
    size_t n = (size_t)(end - s);
    if (n != 7 + 64) return 0;
    if (!(s[0] == 's' || s[0] == 'S') ||
        !(s[1] == 'h' || s[1] == 'H') ||
        !(s[2] == 'a' || s[2] == 'A') ||
        s[3] != '2' || s[4] != '5' || s[5] != '6' || s[6] != ':') {
        return 0;
    }
    memcpy(out_norm, "sha256:", 7);
    for (size_t i = 0; i < 64; i++) {
        char c = s[7 + i];
        if (c >= 'A' && c <= 'F') c = (char)(c - 'A' + 'a');
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
        out_norm[7 + i] = c;
    }
    out_norm[71] = 0;
    return 1;
}

codec_zstd_dict_result_t codec_select_zstd_dict_for_response(
    const codec_header_kv_t       *headers,
    size_t                         n_headers,
    const codec_zstd_dict_entry_t *loaded_dicts,
    size_t                         n_dicts,
    const uint8_t                **out_dict_bytes,
    size_t                        *out_dict_len) {

    const char *enc = find_header(headers, n_headers, "content-encoding");
    if (!enc) return CODEC_ZSTD_DICT_NOT_ZSTD;

    /* Per RFC 7230, Content-Encoding is a token (no parameters); we
     * trim whitespace and compare case-insensitively. We deliberately
     * don't try to handle stacked encodings like "br, zstd": Codec
     * servers don't emit them and a stacked encoding would be a server
     * protocol error anyway. */
    const char *enc_end = NULL;
    const char *enc_trim = trim(enc, &enc_end);
    if (!range_ci_eq(enc_trim, enc_end, "zstd")) return CODEC_ZSTD_DICT_NOT_ZSTD;

    const char *declared = find_header(headers, n_headers, "codec-zstd-dict");
    if (!declared) return CODEC_ZSTD_DICT_MISSING_HEADER;

    char norm[72];
    if (!normalise_dict_hash(declared, norm)) return CODEC_ZSTD_DICT_MALFORMED_HASH;

    /* Linear scan. n_dicts is small (typically 2: one per wire format
     * per tokenizer); no need for a hash table. */
    for (size_t i = 0; i < n_dicts; i++) {
        const codec_zstd_dict_entry_t *e = &loaded_dicts[i];
        if (!e || !e->hash) continue;
        /* Loaded entries SHOULD already be in canonical form; compare
         * directly. Use memcmp on the 71-char prefix to keep the
         * comparison constant-time within "sha256:<hex>" shape. */
        if (strlen(e->hash) == 71 && memcmp(e->hash, norm, 71) == 0) {
            if (out_dict_bytes) *out_dict_bytes = e->bytes;
            if (out_dict_len)   *out_dict_len   = e->len;
            return CODEC_ZSTD_DICT_OK;
        }
    }
    return CODEC_ZSTD_DICT_UNKNOWN_HASH;
}

/* ── Discoverable zstd dictionaries (v0.5+) ────────────────────────────── */

/* Parse a hash that may be "sha256:<hex>" or bare "<hex>" into the
 * 64 lowercase hex chars in out_hex64 (NOT NUL-terminated). Returns 1
 * on success, 0 on shape failure. */
static int parse_dict_hash_bare(const char *raw, char out_hex64[64]) {
    if (!raw) return 0;
    const char *end = NULL;
    const char *s = trim(raw, &end);
    size_t n = (size_t)(end - s);
    if (n == 7 + 64) {
        /* sha256:<hex> form */
        if (!(s[0] == 's' || s[0] == 'S') ||
            !(s[1] == 'h' || s[1] == 'H') ||
            !(s[2] == 'a' || s[2] == 'A') ||
            s[3] != '2' || s[4] != '5' || s[5] != '6' || s[6] != ':') {
            return 0;
        }
        s += 7;
        n -= 7;
    } else if (n != 64) {
        return 0;
    }
    for (size_t i = 0; i < 64; i++) {
        char c = s[i];
        if (c >= 'A' && c <= 'F') c = (char)(c - 'A' + 'a');
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
        out_hex64[i] = c;
    }
    return 1;
}

codec_status_t codec_well_known_dict_url(
    const char *origin,
    const char *hash,
    char       *out_url,
    size_t      out_url_buf_len) {

    if (!origin || !hash || !out_url) return CODEC_ERR_INVALID_ARG;

    char hex64[64];
    if (!parse_dict_hash_bare(hash, hex64)) return CODEC_ERR_VALIDATION;

    /* Trim a single trailing slash from origin. */
    size_t origin_len = strlen(origin);
    if (origin_len > 0 && origin[origin_len - 1] == '/') origin_len--;

    static const char SUFFIX[] = "/.well-known/codec/dicts/";
    static const size_t SUFFIX_LEN = sizeof(SUFFIX) - 1; /* 25 */
    /* total = origin_len + 25 + 64 + ".zstd"(5) + NUL(1) */
    size_t total = origin_len + SUFFIX_LEN + 64 + 5 + 1;
    if (total > out_url_buf_len) return CODEC_ERR_INVALID_ARG;

    char *p = out_url;
    memcpy(p, origin, origin_len); p += origin_len;
    memcpy(p, SUFFIX, SUFFIX_LEN); p += SUFFIX_LEN;
    memcpy(p, hex64, 64);          p += 64;
    memcpy(p, ".zstd", 5);         p += 5;
    *p = 0;
    return CODEC_OK;
}

codec_status_t codec_verify_zstd_dict_bytes(
    const uint8_t *bytes,
    size_t         len,
    const char    *expected_hash) {

    if (!expected_hash) return CODEC_ERR_INVALID_ARG;
    if (!bytes && len != 0) return CODEC_ERR_INVALID_ARG;

    char expected[64];
    if (!parse_dict_hash_bare(expected_hash, expected)) return CODEC_ERR_VALIDATION;

    /* Compute actual digest into 64 lowercase hex chars. */
    uint8_t digest[32];
    codec_sha256(bytes, len, digest);
    char actual[64];
    for (int i = 0; i < 32; i++) byte_to_hex_lower(digest[i], &actual[i * 2]);

    if (memcmp(expected, actual, 64) != 0) return CODEC_ERR_HASH_MISMATCH;
    return CODEC_OK;
}
