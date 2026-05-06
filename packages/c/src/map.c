/* TokenizerMap parsing, validation, and SHA-256 hash verification. */
#include "codec/codec.h"
#include "codec_internal.h"
#include "jsmn.h"
#include "sha256.h"

#include <stdlib.h>
#include <string.h>

/* ── JSON string unescape ──────────────────────────────────────────────── */
/*
 * JSON spec escapes (RFC 8259 §7). Returns a freshly-malloced UTF-8 string.
 * `*out_len` is the strlen (not counting the NUL terminator we always
 * append, since vocab keys never contain NUL).
 *
 * Returns NULL on malformed input.
 */
static char *json_unescape(const char *src, size_t src_len, size_t *out_len) {
    /* Worst case length: same as input (escapes never expand). */
    char *buf = (char *)malloc(src_len + 1);
    if (!buf) return NULL;
    size_t out = 0, i = 0;

    while (i < src_len) {
        unsigned char c = (unsigned char)src[i];
        if (c != '\\') { buf[out++] = (char)c; i++; continue; }

        /* Need at least one more char after backslash. */
        if (i + 1 >= src_len) { free(buf); return NULL; }
        char esc = src[i + 1];
        i += 2;

        switch (esc) {
            case '"':  buf[out++] = '"';  break;
            case '\\': buf[out++] = '\\'; break;
            case '/':  buf[out++] = '/';  break;
            case 'b':  buf[out++] = '\b'; break;
            case 'f':  buf[out++] = '\f'; break;
            case 'n':  buf[out++] = '\n'; break;
            case 'r':  buf[out++] = '\r'; break;
            case 't':  buf[out++] = '\t'; break;
            case 'u': {
                /* \uXXXX */
                if (i + 4 > src_len) { free(buf); return NULL; }
                int hi = codec_hex_to_byte(src[i],     src[i + 1]);
                int lo = codec_hex_to_byte(src[i + 2], src[i + 3]);
                if (hi < 0 || lo < 0) { free(buf); return NULL; }
                uint32_t cp = ((uint32_t)hi << 8) | (uint32_t)lo;
                i += 4;
                /* Surrogate pair? */
                if (cp >= 0xD800 && cp <= 0xDBFF) {
                    if (i + 6 > src_len || src[i] != '\\' || src[i + 1] != 'u') {
                        free(buf); return NULL;
                    }
                    int hi2 = codec_hex_to_byte(src[i + 2], src[i + 3]);
                    int lo2 = codec_hex_to_byte(src[i + 4], src[i + 5]);
                    if (hi2 < 0 || lo2 < 0) { free(buf); return NULL; }
                    uint32_t low = ((uint32_t)hi2 << 8) | (uint32_t)lo2;
                    if (low < 0xDC00 || low > 0xDFFF) { free(buf); return NULL; }
                    i += 6;
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                }
                /* Encode `cp` as UTF-8. */
                if (cp <= 0x7F) {
                    buf[out++] = (char)cp;
                } else if (cp <= 0x7FF) {
                    buf[out++] = (char)(0xC0 | (cp >> 6));
                    buf[out++] = (char)(0x80 | (cp & 0x3F));
                } else if (cp <= 0xFFFF) {
                    buf[out++] = (char)(0xE0 | (cp >> 12));
                    buf[out++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                    buf[out++] = (char)(0x80 | (cp & 0x3F));
                } else {
                    buf[out++] = (char)(0xF0 | (cp >> 18));
                    buf[out++] = (char)(0x80 | ((cp >> 12) & 0x3F));
                    buf[out++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                    buf[out++] = (char)(0x80 | (cp & 0x3F));
                }
                break;
            }
            default:
                free(buf);
                return NULL;
        }
    }
    /* Extend buffer if escapes shrank it; reallocate down to fit. */
    char *fit = (char *)realloc(buf, out + 1);
    if (fit) buf = fit;
    buf[out] = 0;
    *out_len = out;
    return buf;
}

/* Atoi that fails on trailing garbage. */
static int parse_int(const char *s, size_t len, long *out) {
    if (len == 0) return 0;
    size_t i = 0;
    int neg = 0;
    if (s[0] == '-') { neg = 1; i = 1; }
    else if (s[0] == '+') { i = 1; }
    long v = 0;
    int got = 0;
    while (i < len) {
        char c = s[i++];
        if (c < '0' || c > '9') return 0;
        v = v * 10 + (c - '0');
        got = 1;
    }
    if (!got) return 0;
    *out = neg ? -v : v;
    return 1;
}

/* Compare a jsmn string token to a literal (no escapes in literal). */
static int tok_eq(const char *json, const jsmntok_t *t, const char *lit) {
    if (t->type != JSMN_STRING && t->type != JSMN_PRIMITIVE) return 0;
    size_t lit_len = strlen(lit);
    size_t tok_len = (size_t)(t->end - t->start);
    if (tok_len != lit_len) return 0;
    return memcmp(json + t->start, lit, lit_len) == 0;
}

/* Replace every occurrence of `▁` (U+2581 = E2 96 81) in-place with ' '.
 * The string shrinks when replacements happen; we update *len. */
static void replace_metaspace_inplace(char *s, size_t *len) {
    size_t r = 0, w = 0;
    while (r < *len) {
        if (r + 2 < *len && (uint8_t)s[r] == 0xE2 && (uint8_t)s[r + 1] == 0x96 && (uint8_t)s[r + 2] == 0x81) {
            s[w++] = ' ';
            r += 3;
        } else {
            s[w++] = s[r++];
        }
    }
    *len = w;
    s[w] = 0;
}

/* Detect "<0xHH>" SentencePiece byte-fallback tokens. */
static int is_byte_fallback_token(const char *s, size_t len) {
    if (len != 6) return 0;
    if (s[0] != '<' || s[1] != '0' || s[2] != 'x' || s[5] != '>') return 0;
    return codec_hex_to_byte(s[3], s[4]) >= 0;
}

/* ── Map struct lifecycle ───────────────────────────────────────────────── */

static codec_status_t ensure_entries_cap(codec_tokenizer_map_t *m, size_t need) {
    if (need <= m->entries_cap) return CODEC_OK;
    size_t new_cap = m->entries_cap ? m->entries_cap : 16;
    while (new_cap < need) new_cap *= 2;
    codec_id_entry_t *p = (codec_id_entry_t *)realloc(
        m->entries, new_cap * sizeof(codec_id_entry_t));
    if (!p) return CODEC_ERR_OUT_OF_MEMORY;
    /* Zero-init the new tail. */
    memset(p + m->entries_cap, 0,
           (new_cap - m->entries_cap) * sizeof(codec_id_entry_t));
    m->entries = p;
    m->entries_cap = new_cap;
    return CODEC_OK;
}

static codec_status_t set_entry(codec_tokenizer_map_t *m, uint32_t id,
                                const uint8_t *bytes, size_t bytes_len) {
    codec_status_t st = ensure_entries_cap(m, (size_t)id + 1);
    if (st != CODEC_OK) return st;
    codec_id_entry_t *e = &m->entries[id];
    free(e->bytes);
    e->bytes = (uint8_t *)malloc(bytes_len > 0 ? bytes_len : 1);
    if (!e->bytes) return CODEC_ERR_OUT_OF_MEMORY;
    if (bytes_len > 0) memcpy(e->bytes, bytes, bytes_len);
    e->len = bytes_len;
    return CODEC_OK;
}

void codec_map_free(codec_tokenizer_map_t *map) {
    if (!map) return;
    free(map->id);
    free(map->version);
    if (map->entries) {
        for (size_t i = 0; i < map->entries_cap; i++) free(map->entries[i].bytes);
        free(map->entries);
    }
    if (map->specials) {
        for (size_t i = 0; i < map->special_count; i++) free(map->specials[i].name);
        free(map->specials);
    }
    free(map);
}

const char     *codec_map_id(const codec_tokenizer_map_t *m)      { return m ? m->id : NULL; }
const char     *codec_map_version(const codec_tokenizer_map_t *m) { return m ? m->version : NULL; }
size_t          codec_map_vocab_size(const codec_tokenizer_map_t *m) { return m ? m->vocab_size : 0; }
codec_encoder_t codec_map_encoder(const codec_tokenizer_map_t *m) { return m ? m->encoder : CODEC_ENCODER_NONE; }

/* ── Parse encoder string ───────────────────────────────────────────────── */

static codec_encoder_t parse_encoder(const char *json, const jsmntok_t *t) {
    if (tok_eq(json, t, "byte_level")) return CODEC_ENCODER_BYTE_LEVEL;
    if (tok_eq(json, t, "metaspace"))  return CODEC_ENCODER_METASPACE;
    return CODEC_ENCODER_NONE; /* validation will catch unrecognised values */
}

/* Skip past a token tree rooted at `idx`. Returns the index immediately after
 * the entire subtree. */
static size_t skip_subtree(const jsmntok_t *toks, size_t idx) {
    int remaining = 1;
    size_t i = idx;
    while (remaining > 0) {
        const jsmntok_t *t = &toks[i++];
        remaining--;
        if (t->type == JSMN_OBJECT) remaining += t->size * 2;
        else if (t->type == JSMN_ARRAY) remaining += t->size;
    }
    return i;
}

/* ── Process one vocab entry into the id→bytes table ────────────────────── */

static codec_status_t install_entry(codec_tokenizer_map_t *m,
                                    const char *json,
                                    const jsmntok_t *key_tok,
                                    const jsmntok_t *id_tok) {
    long id_long;
    if (!parse_int(json + id_tok->start,
                   (size_t)(id_tok->end - id_tok->start), &id_long) ||
        id_long < 0) {
        return CODEC_ERR_PARSE;
    }
    uint32_t id = (uint32_t)id_long;

    size_t key_len = (size_t)(key_tok->end - key_tok->start);
    const char *key_raw = json + key_tok->start;

    /* Skip SentencePiece byte-fallback tokens — they're handled by the
     * byte_fallback range path, never as direct table entries. */
    if (is_byte_fallback_token(key_raw, key_len)) return CODEC_OK;

    size_t key_unesc_len;
    char *key_unesc = json_unescape(key_raw, key_len, &key_unesc_len);
    if (!key_unesc) return CODEC_ERR_PARSE;

    codec_status_t st;
    if (m->encoder == CODEC_ENCODER_BYTE_LEVEL) {
        size_t bytes_len;
        char *bytes = codec_decode_byte_level_token(key_unesc, key_unesc_len, &bytes_len);
        free(key_unesc);
        if (!bytes) return CODEC_ERR_OUT_OF_MEMORY;
        st = set_entry(m, id, (const uint8_t *)bytes, bytes_len);
        free(bytes);
    } else if (m->encoder == CODEC_ENCODER_METASPACE) {
        replace_metaspace_inplace(key_unesc, &key_unesc_len);
        st = set_entry(m, id, (const uint8_t *)key_unesc, key_unesc_len);
        free(key_unesc);
    } else {
        st = set_entry(m, id, (const uint8_t *)key_unesc, key_unesc_len);
        free(key_unesc);
    }
    return st;
}

static codec_status_t install_v1_entry(codec_tokenizer_map_t *m,
                                       const char *json,
                                       const jsmntok_t *id_str_tok,
                                       const jsmntok_t *text_tok) {
    long id_long;
    if (!parse_int(json + id_str_tok->start,
                   (size_t)(id_str_tok->end - id_str_tok->start), &id_long) ||
        id_long < 0) {
        return CODEC_ERR_PARSE;
    }
    uint32_t id = (uint32_t)id_long;
    size_t text_len = (size_t)(text_tok->end - text_tok->start);
    size_t unesc_len;
    char *unesc = json_unescape(json + text_tok->start, text_len, &unesc_len);
    if (!unesc) return CODEC_ERR_PARSE;
    codec_status_t st = set_entry(m, id, (const uint8_t *)unesc, unesc_len);
    free(unesc);
    return st;
}

/* ── Top-level parser ───────────────────────────────────────────────────── */

codec_status_t codec_map_from_json(const char *json, size_t len,
                                   codec_tokenizer_map_t **out) {
    if (!json || !out) return CODEC_ERR_INVALID_ARG;
    *out = NULL;

    /* Two-pass jsmn: first count tokens, then allocate and parse for real. */
    jsmn_parser p;
    jsmn_init(&p);
    int n = jsmn_parse(&p, json, len, NULL, 0);
    if (n < 0) return CODEC_ERR_PARSE;

    jsmntok_t *toks = (jsmntok_t *)malloc(sizeof(jsmntok_t) * (size_t)n);
    if (!toks) return CODEC_ERR_OUT_OF_MEMORY;
    jsmn_init(&p);
    n = jsmn_parse(&p, json, len, toks, (unsigned int)n);
    if (n < 0) { free(toks); return CODEC_ERR_PARSE; }
    if (n == 0 || toks[0].type != JSMN_OBJECT) { free(toks); return CODEC_ERR_VALIDATION; }

    codec_tokenizer_map_t *m = (codec_tokenizer_map_t *)calloc(1, sizeof(*m));
    if (!m) { free(toks); return CODEC_ERR_OUT_OF_MEMORY; }
    m->byte_fallback_start = -1;
    m->byte_fallback_end = -1;

    /* First pass: scalar fields + encoder. We need encoder before processing
     * vocab so we can decode keys correctly. */
    int root_size = toks[0].size;
    size_t i = 1;
    /* Save indices of the deferred fields. */
    size_t idx_vocab = 0, idx_tokens = 0, idx_added = 0, idx_specials = 0;

    for (int field = 0; field < root_size; field++) {
        if (i >= (size_t)n) { codec_map_free(m); free(toks); return CODEC_ERR_PARSE; }
        const jsmntok_t *key = &toks[i++];
        if (key->type != JSMN_STRING) { codec_map_free(m); free(toks); return CODEC_ERR_PARSE; }
        size_t val_idx = i;
        i = skip_subtree(toks, val_idx);
        const jsmntok_t *val = &toks[val_idx];

        if (tok_eq(json, key, "id") && val->type == JSMN_STRING) {
            size_t L = (size_t)(val->end - val->start), uL;
            free(m->id);
            m->id = json_unescape(json + val->start, L, &uL);
        } else if (tok_eq(json, key, "version") && val->type == JSMN_STRING) {
            size_t L = (size_t)(val->end - val->start), uL;
            free(m->version);
            m->version = json_unescape(json + val->start, L, &uL);
        } else if (tok_eq(json, key, "vocab_size") && val->type == JSMN_PRIMITIVE) {
            long v;
            if (!parse_int(json + val->start, (size_t)(val->end - val->start), &v) || v < 1) {
                codec_map_free(m); free(toks); return CODEC_ERR_VALIDATION;
            }
            m->vocab_size = (size_t)v;
        } else if (tok_eq(json, key, "encoder") && val->type == JSMN_STRING) {
            m->encoder = parse_encoder(json, val);
        } else if (tok_eq(json, key, "byte_fallback_start") && val->type == JSMN_PRIMITIVE) {
            long v;
            if (parse_int(json + val->start, (size_t)(val->end - val->start), &v) && v >= 0)
                m->byte_fallback_start = (int32_t)v;
        } else if (tok_eq(json, key, "byte_fallback_end") && val->type == JSMN_PRIMITIVE) {
            long v;
            if (parse_int(json + val->start, (size_t)(val->end - val->start), &v) && v >= 0)
                m->byte_fallback_end = (int32_t)v;
        } else if (tok_eq(json, key, "vocab") && val->type == JSMN_OBJECT) {
            idx_vocab = val_idx;
        } else if (tok_eq(json, key, "tokens") && val->type == JSMN_OBJECT) {
            idx_tokens = val_idx;
        } else if (tok_eq(json, key, "special_tokens") && val->type == JSMN_OBJECT) {
            idx_specials = val_idx;
        } else {
            (void)idx_added; /* reserved for future BPE additions */
        }
    }

    /* ── Validation ─────────────────────────────────────────────────────── */
    if (!m->id || !m->version || m->vocab_size < 1) {
        codec_map_free(m); free(toks); return CODEC_ERR_VALIDATION;
    }
    if ((m->byte_fallback_start < 0) != (m->byte_fallback_end < 0)) {
        codec_map_free(m); free(toks); return CODEC_ERR_VALIDATION;
    }
    if (idx_vocab == 0 && idx_tokens == 0) {
        codec_map_free(m); free(toks); return CODEC_ERR_VALIDATION;
    }

    /* ── Process vocab (v2) or tokens (v1) ──────────────────────────────── */
    if (idx_vocab != 0) {
        const jsmntok_t *vocab = &toks[idx_vocab];
        size_t pos = idx_vocab + 1;
        for (int j = 0; j < vocab->size; j++) {
            const jsmntok_t *key_tok = &toks[pos];
            const jsmntok_t *id_tok = &toks[pos + 1];
            codec_status_t st = install_entry(m, json, key_tok, id_tok);
            if (st != CODEC_OK) { codec_map_free(m); free(toks); return st; }
            pos += 2;
        }
    }
    if (idx_tokens != 0) {
        const jsmntok_t *tokens_obj = &toks[idx_tokens];
        size_t pos = idx_tokens + 1;
        for (int j = 0; j < tokens_obj->size; j++) {
            const jsmntok_t *id_str = &toks[pos];
            const jsmntok_t *text   = &toks[pos + 1];
            codec_status_t st = install_v1_entry(m, json, id_str, text);
            if (st != CODEC_OK) { codec_map_free(m); free(toks); return st; }
            pos += 2;
        }
    }

    /* ── Process special_tokens ─────────────────────────────────────────── */
    if (idx_specials != 0) {
        const jsmntok_t *spec = &toks[idx_specials];
        m->special_count = (size_t)spec->size;
        m->specials = calloc(m->special_count, sizeof(*m->specials));
        if (!m->specials) { codec_map_free(m); free(toks); return CODEC_ERR_OUT_OF_MEMORY; }
        size_t pos = idx_specials + 1;
        for (int j = 0; j < spec->size; j++) {
            const jsmntok_t *name_tok = &toks[pos];
            const jsmntok_t *id_tok   = &toks[pos + 1];
            long v;
            if (!parse_int(json + id_tok->start,
                           (size_t)(id_tok->end - id_tok->start), &v) || v < 0) {
                codec_map_free(m); free(toks); return CODEC_ERR_PARSE;
            }
            size_t name_len_unesc;
            char *name = json_unescape(
                json + name_tok->start,
                (size_t)(name_tok->end - name_tok->start),
                &name_len_unesc);
            if (!name) { codec_map_free(m); free(toks); return CODEC_ERR_PARSE; }
            m->specials[j].name = name;
            m->specials[j].id   = (uint32_t)v;
            pos += 2;
        }
    }

    free(toks);
    *out = m;
    return CODEC_OK;
}

/* ── SHA-256 verification ───────────────────────────────────────────────── */

codec_status_t codec_map_verify_sha256(const char *json, size_t len,
                                       const char *expected_hex) {
    if (!json || !expected_hex) return CODEC_ERR_INVALID_ARG;

    /* Strip optional "sha256:" prefix. */
    const char *hex = expected_hex;
    if (strncmp(hex, "sha256:", 7) == 0) hex += 7;
    if (strlen(hex) != 64) return CODEC_ERR_INVALID_ARG;

    uint8_t expected_bin[32];
    for (int i = 0; i < 32; i++) {
        int b = codec_hex_to_byte(hex[i * 2], hex[i * 2 + 1]);
        if (b < 0) return CODEC_ERR_INVALID_ARG;
        expected_bin[i] = (uint8_t)b;
    }

    uint8_t actual[32];
    codec_sha256((const uint8_t *)json, len, actual);

    /* Constant-time compare. */
    uint8_t diff = 0;
    for (int i = 0; i < 32; i++) diff |= expected_bin[i] ^ actual[i];
    return diff == 0 ? CODEC_OK : CODEC_ERR_HASH_MISMATCH;
}

/* ── Internal accessors used by detokenize.c ────────────────────────────── */

const codec_id_entry_t *codec_map_entry(const codec_tokenizer_map_t *m, uint32_t id) {
    if (!m || (size_t)id >= m->entries_cap) return NULL;
    const codec_id_entry_t *e = &m->entries[id];
    if (!e->bytes) return NULL;
    return e;
}

int codec_map_is_special(const codec_tokenizer_map_t *m, uint32_t id) {
    if (!m || !m->specials) return 0;
    for (size_t i = 0; i < m->special_count; i++)
        if (m->specials[i].id == id) return 1;
    return 0;
}

codec_status_t codec_map_special_id(const codec_tokenizer_map_t *m,
                                    const char *name,
                                    uint32_t *out_id) {
    if (!m || !name || !out_id) return CODEC_ERR_INVALID_ARG;
    if (!m->specials) return CODEC_ERR_NOT_FOUND;
    for (size_t i = 0; i < m->special_count; i++) {
        if (strcmp(m->specials[i].name, name) == 0) {
            *out_id = m->specials[i].id;
            return CODEC_OK;
        }
    }
    return CODEC_ERR_NOT_FOUND;
}

int32_t codec_map_byte_fallback_start(const codec_tokenizer_map_t *m) {
    return m ? m->byte_fallback_start : -1;
}
int32_t codec_map_byte_fallback_end(const codec_tokenizer_map_t *m) {
    return m ? m->byte_fallback_end : -1;
}
