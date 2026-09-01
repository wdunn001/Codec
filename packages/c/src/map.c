/* TokenizerMap parsing, validation, and SHA-256 hash verification. */
#include "codec/codec.h"
#include "codec_internal.h"
#include "jsmn.h"
#include "codec_jsmn_guard.h"
#include "sha256.h"

#include <limits.h>
#include <stdint.h>
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
        /* Signed overflow is undefined behaviour, so reject before it. */
        if (v > (LONG_MAX - (c - '0')) / 10) return 0;
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

/*
 * Hard ceiling on the id table. The table is sized by the largest token id
 * in the document, and that id comes straight off the wire. vocab_size is
 * parsed and validated but never compared against any id, so before this
 * cap a single entry with id 4294967295 asked for a 64 GiB table from 63
 * bytes of JSON, and id 100000000 reached 2.1 GB resident in 1.25 seconds
 * while returning CODEC_OK.
 *
 * 2^22 is roughly sixteen times the largest vocabulary shipping today
 * (Gemma at 256k, o200k at 200k, Qwen3 at 151k), and it caps the table at
 * 64 MB on a 64-bit target. Nothing real comes near it.
 */
#define CODEC_MAP_MAX_ENTRIES ((size_t)1 << 22)

static codec_status_t ensure_entries_cap(codec_tokenizer_map_t *m, size_t need) {
    if (need <= m->entries_cap) return CODEC_OK;
    if (need > CODEC_MAP_MAX_ENTRIES) return CODEC_ERR_VALIDATION;
    size_t new_cap = m->entries_cap ? m->entries_cap : 16;
    while (new_cap < need) {
        if (new_cap > SIZE_MAX / 2) return CODEC_ERR_VALIDATION;
        new_cap *= 2;
    }
    /* On a 32-bit target new_cap * sizeof() can wrap, which would hand back
     * a tiny block that the caller then indexes with the full id. */
    if (new_cap > SIZE_MAX / sizeof(codec_id_entry_t)) return CODEC_ERR_VALIDATION;
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

static void free_pretok_program(codec_pretok_program_t *prog) {
    if (!prog) return;
    if (prog->ops) {
        for (size_t i = 0; i < prog->op_count; i++) {
            codec_pretok_op_t *op = &prog->ops[i];
            if (op->kind == CODEC_PRETOK_LITERALS_CI && op->u.literals_ci.patterns) {
                for (size_t k = 0; k < op->u.literals_ci.count; k++)
                    free(op->u.literals_ci.patterns[k]);
                free(op->u.literals_ci.patterns);
            }
        }
        free(prog->ops);
    }
    free(prog);
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
    if (map->bpe_vocab) {
        for (size_t i = 0; i < map->bpe_vocab_count; i++) free(map->bpe_vocab[i].raw_key);
        free(map->bpe_vocab);
    }
    if (map->bpe_merges) {
        for (size_t i = 0; i < map->bpe_merges_count; i++) free(map->bpe_merges[i].pair);
        free(map->bpe_merges);
    }
    free_pretok_program(map->pretok_program);
    if (map->tool_calling) {
        free((void *)map->tool_calling->marker_start_name);
        free((void *)map->tool_calling->marker_end_name);
        free(map->tool_calling);
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

/* ── BPE vocab + merges helpers ──────────────────────────────────────────── */

static int cmp_bpe_vocab(const void *a, const void *b) {
    const codec_bpe_vocab_entry_t *ea = a;
    const codec_bpe_vocab_entry_t *eb = b;
    return strcmp(ea->raw_key, eb->raw_key);
}

static int cmp_bpe_merge(const void *a, const void *b) {
    const codec_bpe_merge_entry_t *ea = a;
    const codec_bpe_merge_entry_t *eb = b;
    return strcmp(ea->pair, eb->pair);
}

/* Append a (raw_key, id) pair to bpe_vocab. Takes ownership of raw_key
 * (must be malloc'd and unique: caller stops using it). */
static codec_status_t bpe_vocab_push(codec_tokenizer_map_t *m,
                                     char *raw_key, uint32_t id) {
    /* Geometric growth in steps of 2. Allocate count+1 capacity tracked
     * implicitly: we round up to next power of 2 in the realloc path. */
    static const size_t CHUNK = 1024;
    if ((m->bpe_vocab_count % CHUNK) == 0) {
        size_t new_cap = m->bpe_vocab_count + CHUNK;
        codec_bpe_vocab_entry_t *grow = (codec_bpe_vocab_entry_t *)realloc(
            m->bpe_vocab, new_cap * sizeof(codec_bpe_vocab_entry_t));
        if (!grow) return CODEC_ERR_OUT_OF_MEMORY;
        m->bpe_vocab = grow;
    }
    m->bpe_vocab[m->bpe_vocab_count].raw_key = raw_key;
    m->bpe_vocab[m->bpe_vocab_count].id      = id;
    m->bpe_vocab_count++;
    return CODEC_OK;
}

/* Sorted-array bsearch: raw_key -> id. Returns 1 on hit, 0 on miss. */
int codec_bpe_vocab_lookup(const codec_tokenizer_map_t *m,
                           const char *raw_key, uint32_t *out_id) {
    if (!m || !m->bpe_vocab || !raw_key || !out_id) return 0;
    codec_bpe_vocab_entry_t key = { (char *)raw_key, 0 };
    codec_bpe_vocab_entry_t *hit = (codec_bpe_vocab_entry_t *)bsearch(
        &key, m->bpe_vocab, m->bpe_vocab_count,
        sizeof(*m->bpe_vocab), cmp_bpe_vocab);
    if (!hit) return 0;
    *out_id = hit->id;
    return 1;
}

/* Sorted-array bsearch: "left right" -> rank. Returns 1 on hit. */
int codec_bpe_merge_rank(const codec_tokenizer_map_t *m,
                         const char *pair, uint32_t *out_rank) {
    if (!m || !m->bpe_merges || !pair || !out_rank) return 0;
    codec_bpe_merge_entry_t key = { (char *)pair, 0 };
    codec_bpe_merge_entry_t *hit = (codec_bpe_merge_entry_t *)bsearch(
        &key, m->bpe_merges, m->bpe_merges_count,
        sizeof(*m->bpe_merges), cmp_bpe_merge);
    if (!hit) return 0;
    *out_rank = hit->rank;
    return 1;
}

const codec_pretok_program_t *codec_map_pretok_program(
    const codec_tokenizer_map_t *m) {
    return m ? m->pretok_program : NULL;
}

/* ── Parse pre_tokenizer_program ─────────────────────────────────────────── */

static int tok_str_eq(const char *json, const jsmntok_t *t, const char *s) {
    return tok_eq(json, t, s);
}

static int parse_bool_token(const char *json, const jsmntok_t *t, int *out) {
    /* JSMN_PRIMITIVE covers true/false/null/numbers; check the start char. */
    char c = json[t->start];
    if (c == 't') { *out = 1; return 1; }
    if (c == 'f') { *out = 0; return 1; }
    return 0;
}

static codec_status_t parse_one_pretok_op(
    codec_pretok_op_t *out_op,
    const char *json,
    const jsmntok_t *toks, size_t op_idx)
{
    const jsmntok_t *obj = &toks[op_idx];
    if (obj->type != JSMN_OBJECT) return CODEC_ERR_PARSE;
    /* Two passes: first locate "op" so we know which kind, then read
     * the kind-specific fields. */
    const char *kind_str = NULL;
    size_t kind_len = 0;
    size_t pos = op_idx + 1;
    for (int j = 0; j < obj->size; j++) {
        const jsmntok_t *key = &toks[pos];
        const jsmntok_t *val = &toks[pos + 1];
        if (tok_str_eq(json, key, "op") && val->type == JSMN_STRING) {
            kind_str = json + val->start;
            kind_len = (size_t)(val->end - val->start);
        }
        pos = skip_subtree(toks, pos + 1);
    }
    if (!kind_str) return CODEC_ERR_PARSE;

    /* Dispatch on op kind. */
    memset(out_op, 0, sizeof(*out_op));
    if (kind_len == 11 && strncmp(kind_str, "literals_ci", 11) == 0) {
        out_op->kind = CODEC_PRETOK_LITERALS_CI;
    } else if (kind_len == 7 && strncmp(kind_str, "letters", 7) == 0) {
        out_op->kind = CODEC_PRETOK_LETTERS;
    } else if (kind_len == 7 && strncmp(kind_str, "numbers", 7) == 0) {
        out_op->kind = CODEC_PRETOK_NUMBERS;
    } else if (kind_len == 9 && strncmp(kind_str, "punct_run", 9) == 0) {
        out_op->kind = CODEC_PRETOK_PUNCT_RUN;
    } else if (kind_len == 13 && strncmp(kind_str, "newline_block", 13) == 0) {
        out_op->kind = CODEC_PRETOK_NEWLINE_BLOCK;
    } else if (kind_len == 11 && strncmp(kind_str, "trailing_ws", 11) == 0) {
        out_op->kind = CODEC_PRETOK_TRAILING_WS;
    } else if (kind_len == 6 && strncmp(kind_str, "ws_run", 6) == 0) {
        out_op->kind = CODEC_PRETOK_WS_RUN;
    } else if (kind_len == 15 && strncmp(kind_str, "metaspace_split", 15) == 0) {
        out_op->kind = CODEC_PRETOK_METASPACE_SPLIT;
    } else {
        return CODEC_ERR_PARSE;
    }

    /* Second pass: read kind-specific fields. */
    pos = op_idx + 1;
    for (int j = 0; j < obj->size; j++) {
        const jsmntok_t *key = &toks[pos];
        const jsmntok_t *val = &toks[pos + 1];
        size_t next_pos = skip_subtree(toks, pos + 1);

        if (out_op->kind == CODEC_PRETOK_LITERALS_CI
            && tok_str_eq(json, key, "patterns")
            && val->type == JSMN_ARRAY) {
            out_op->u.literals_ci.patterns =
                (char **)calloc((size_t)val->size, sizeof(char *));
            if (!out_op->u.literals_ci.patterns) return CODEC_ERR_OUT_OF_MEMORY;
            out_op->u.literals_ci.count = (size_t)val->size;
            size_t arr_pos = pos + 2;
            for (int k = 0; k < val->size; k++) {
                const jsmntok_t *str = &toks[arr_pos];
                if (str->type != JSMN_STRING) return CODEC_ERR_PARSE;
                size_t L = (size_t)(str->end - str->start), uL;
                char *p = json_unescape(json + str->start, L, &uL);
                if (!p) return CODEC_ERR_OUT_OF_MEMORY;
                out_op->u.literals_ci.patterns[k] = p;
                arr_pos++;
            }
        } else if (out_op->kind == CODEC_PRETOK_LETTERS
                   && tok_str_eq(json, key, "lead_other")
                   && val->type == JSMN_PRIMITIVE) {
            int b;
            if (parse_bool_token(json, val, &b)) out_op->u.letters.lead_other = b;
        } else if (out_op->kind == CODEC_PRETOK_NUMBERS
                   && tok_str_eq(json, key, "max_run")
                   && val->type == JSMN_PRIMITIVE) {
            long v;
            if (parse_int(json + val->start,
                          (size_t)(val->end - val->start), &v) && v >= 0) {
                out_op->u.numbers.max_run = (uint32_t)v;
            }
        } else if (out_op->kind == CODEC_PRETOK_PUNCT_RUN
                   && val->type == JSMN_PRIMITIVE) {
            int b;
            if (tok_str_eq(json, key, "lead_space")
                && parse_bool_token(json, val, &b))
                out_op->u.punct_run.lead_space = b;
            else if (tok_str_eq(json, key, "trailing_newlines")
                     && parse_bool_token(json, val, &b))
                out_op->u.punct_run.trailing_newlines = b;
        } else if (out_op->kind == CODEC_PRETOK_METASPACE_SPLIT
                   && tok_str_eq(json, key, "prefix_first")
                   && val->type == JSMN_PRIMITIVE) {
            int b;
            if (parse_bool_token(json, val, &b))
                out_op->u.metaspace_split.prefix_first = b;
        }
        pos = next_pos;
    }
    return CODEC_OK;
}

static codec_status_t parse_pretok_program(
    codec_tokenizer_map_t *m,
    const char *json,
    const jsmntok_t *toks, size_t prog_idx)
{
    const jsmntok_t *obj = &toks[prog_idx];
    if (obj->type != JSMN_OBJECT) return CODEC_ERR_PARSE;

    /* Locate "version" (optional) and "ops" (required). */
    int version = 1;
    size_t ops_idx = 0;
    size_t pos = prog_idx + 1;
    for (int j = 0; j < obj->size; j++) {
        const jsmntok_t *key = &toks[pos];
        const jsmntok_t *val = &toks[pos + 1];
        size_t next_pos = skip_subtree(toks, pos + 1);
        if (tok_str_eq(json, key, "version") && val->type == JSMN_PRIMITIVE) {
            long v;
            if (parse_int(json + val->start,
                          (size_t)(val->end - val->start), &v) && v >= 0) {
                version = (int)v;
            }
        } else if (tok_str_eq(json, key, "ops") && val->type == JSMN_ARRAY) {
            ops_idx = pos + 1;
        }
        pos = next_pos;
    }
    if (ops_idx == 0) return CODEC_ERR_PARSE;

    const jsmntok_t *ops = &toks[ops_idx];
    codec_pretok_program_t *prog = (codec_pretok_program_t *)calloc(1, sizeof(*prog));
    if (!prog) return CODEC_ERR_OUT_OF_MEMORY;
    prog->version  = version;
    prog->op_count = (size_t)ops->size;
    prog->ops = (codec_pretok_op_t *)calloc(prog->op_count, sizeof(*prog->ops));
    if (!prog->ops) { free(prog); return CODEC_ERR_OUT_OF_MEMORY; }

    size_t op_pos = ops_idx + 1;
    for (int j = 0; j < ops->size; j++) {
        codec_status_t st = parse_one_pretok_op(&prog->ops[j], json, toks, op_pos);
        if (st != CODEC_OK) {
            free_pretok_program(prog);
            return st;
        }
        op_pos = skip_subtree(toks, op_pos);
    }

    m->pretok_program = prog;
    return CODEC_OK;
}

/* ── Tool-calling block (v2.1, optional) ────────────────────────────────── */
/*
 * Mirror of the spec/PROTOCOL.md § "Tool-call calling conventions in the
 * map" block. Validates: convention/args_format/result_format are members
 * of their closed enums; markers.start and .end are non-empty AND appear
 * as keys in special_tokens.
 */

static int specials_contains(const codec_tokenizer_map_t *m, const char *name) {
    if (!m || !m->specials || !name) return 0;
    for (size_t i = 0; i < m->special_count; i++)
        if (strcmp(m->specials[i].name, name) == 0) return 1;
    return 0;
}

static int parse_convention(const char *s, size_t n,
                            codec_tool_calling_convention_t *out) {
    if (n == 6 && strncmp(s, "llama3", 6) == 0) {
        *out = CODEC_TOOL_CALLING_CONVENTION_LLAMA3; return 1;
    }
    if (n == 6 && strncmp(s, "qwen25", 6) == 0) {
        *out = CODEC_TOOL_CALLING_CONVENTION_QWEN25; return 1;
    }
    if (n == 4 && strncmp(s, "phi4", 4) == 0) {
        *out = CODEC_TOOL_CALLING_CONVENTION_PHI4; return 1;
    }
    if (n == 12 && strncmp(s, "mistral_nemo", 12) == 0) {
        *out = CODEC_TOOL_CALLING_CONVENTION_MISTRAL_NEMO; return 1;
    }
    if (n == 11 && strncmp(s, "deepseek_v3", 11) == 0) {
        *out = CODEC_TOOL_CALLING_CONVENTION_DEEPSEEK_V3; return 1;
    }
    if (n == 11 && strncmp(s, "deepseek_r1", 11) == 0) {
        *out = CODEC_TOOL_CALLING_CONVENTION_DEEPSEEK_R1; return 1;
    }
    if (n == 6 && strncmp(s, "custom", 6) == 0) {
        *out = CODEC_TOOL_CALLING_CONVENTION_CUSTOM; return 1;
    }
    return 0;
}

static int parse_args_format(const char *s, size_t n,
                             codec_tool_calling_args_format_t *out) {
    if (n == 4 && strncmp(s, "json", 4) == 0) {
        *out = CODEC_TOOL_CALLING_ARGS_JSON; return 1;
    }
    if (n == 11 && strncmp(s, "python_args", 11) == 0) {
        *out = CODEC_TOOL_CALLING_ARGS_PYTHON_ARGS; return 1;
    }
    return 0;
}

static int parse_result_format(const char *s, size_t n,
                               codec_tool_calling_result_format_t *out) {
    if (n == 4 && strncmp(s, "text", 4) == 0) {
        *out = CODEC_TOOL_CALLING_RESULT_TEXT; return 1;
    }
    if (n == 4 && strncmp(s, "json", 4) == 0) {
        *out = CODEC_TOOL_CALLING_RESULT_JSON; return 1;
    }
    return 0;
}

static codec_status_t parse_tool_calling(
    codec_tokenizer_map_t *m,
    const char *json,
    const jsmntok_t *toks, size_t tc_idx)
{
    const jsmntok_t *obj = &toks[tc_idx];
    if (obj->type != JSMN_OBJECT) return CODEC_ERR_PARSE;

    codec_tool_calling_convention_t    convention   = 0;
    codec_tool_calling_args_format_t   args_format  = 0;
    codec_tool_calling_result_format_t result_fmt   = 0;
    int have_conv = 0, have_args = 0, have_result = 0;
    char *start_name = NULL, *end_name = NULL;

    size_t pos = tc_idx + 1;
    for (int j = 0; j < obj->size; j++) {
        const jsmntok_t *key = &toks[pos];
        const jsmntok_t *val = &toks[pos + 1];
        size_t next_pos = skip_subtree(toks, pos + 1);

        if (tok_eq(json, key, "convention") && val->type == JSMN_STRING) {
            if (!parse_convention(json + val->start,
                                  (size_t)(val->end - val->start), &convention))
                goto bad_value;
            have_conv = 1;
        } else if (tok_eq(json, key, "args_format") && val->type == JSMN_STRING) {
            if (!parse_args_format(json + val->start,
                                   (size_t)(val->end - val->start), &args_format))
                goto bad_value;
            have_args = 1;
        } else if (tok_eq(json, key, "result_format") && val->type == JSMN_STRING) {
            if (!parse_result_format(json + val->start,
                                     (size_t)(val->end - val->start), &result_fmt))
                goto bad_value;
            have_result = 1;
        } else if (tok_eq(json, key, "markers") && val->type == JSMN_OBJECT) {
            /* Inner object: { "start": "...", "end": "..." } */
            size_t inner = pos + 2;
            for (int k = 0; k < val->size; k++) {
                const jsmntok_t *mk = &toks[inner];
                const jsmntok_t *mv = &toks[inner + 1];
                if (mv->type != JSMN_STRING) goto bad_value;
                size_t L = (size_t)(mv->end - mv->start), uL;
                if (tok_eq(json, mk, "start")) {
                    free(start_name);
                    start_name = json_unescape(json + mv->start, L, &uL);
                    if (!start_name) goto oom;
                } else if (tok_eq(json, mk, "end")) {
                    free(end_name);
                    end_name = json_unescape(json + mv->start, L, &uL);
                    if (!end_name) goto oom;
                }
                inner += 2;
            }
        }
        pos = next_pos;
    }

    if (!have_conv || !have_args || !have_result || !start_name || !end_name) goto bad_value;
    if (start_name[0] == '\0' || end_name[0] == '\0') goto bad_value;
    /* Spec: marker names MUST exist as keys in special_tokens. */
    if (!specials_contains(m, start_name) || !specials_contains(m, end_name)) goto bad_value;

    codec_tool_calling_t *tc = (codec_tool_calling_t *)calloc(1, sizeof(*tc));
    if (!tc) goto oom;
    tc->convention         = convention;
    tc->args_format        = args_format;
    tc->result_format      = result_fmt;
    tc->marker_start_name  = start_name;
    tc->marker_end_name    = end_name;
    m->tool_calling = tc;
    return CODEC_OK;

bad_value:
    free(start_name);
    free(end_name);
    return CODEC_ERR_VALIDATION;
oom:
    free(start_name);
    free(end_name);
    return CODEC_ERR_OUT_OF_MEMORY;
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

    /* Skip SentencePiece byte-fallback tokens: they're handled by the
     * byte_fallback range path, never as direct table entries. */
    if (is_byte_fallback_token(key_raw, key_len)) return CODEC_OK;

    size_t key_unesc_len;
    char *key_unesc = json_unescape(key_raw, key_len, &key_unesc_len);
    if (!key_unesc) return CODEC_ERR_PARSE;

    /* Capture the raw (still-encoded) form for BPE vocab lookup before
     * we decode it. BPE merge ranks operate on the raw vocab keys, so
     * we need to keep them around: they're distinct from the decoded
     * `entries` bytes the detokenizer uses. We strdup so subsequent
     * encoding doesn't touch our copy. */
    char *raw_dup = (char *)malloc(key_unesc_len + 1);
    if (!raw_dup) { free(key_unesc); return CODEC_ERR_OUT_OF_MEMORY; }
    memcpy(raw_dup, key_unesc, key_unesc_len);
    raw_dup[key_unesc_len] = '\0';
    codec_status_t bpe_st = bpe_vocab_push(m, raw_dup, id);
    if (bpe_st != CODEC_OK) { free(raw_dup); free(key_unesc); return bpe_st; }

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
    if (!codec_jsmn_tree_complete(toks, (size_t)n)) { free(toks); return CODEC_ERR_PARSE; }
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
    size_t idx_merges = 0, idx_pretok_program = 0, idx_tool_calling = 0;

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
        } else if (tok_eq(json, key, "merges") && val->type == JSMN_ARRAY) {
            idx_merges = val_idx;
        } else if (tok_eq(json, key, "pre_tokenizer_program")
                   && val->type == JSMN_OBJECT) {
            idx_pretok_program = val_idx;
        } else if (tok_eq(json, key, "tool_calling") && val->type == JSMN_OBJECT) {
            idx_tool_calling = val_idx;
        } else {
            (void)idx_added; /* reserved for future fields */
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

    /* ── Process merges (BPE) ───────────────────────────────────────────── */
    if (idx_merges != 0) {
        const jsmntok_t *arr = &toks[idx_merges];
        m->bpe_merges = (codec_bpe_merge_entry_t *)calloc(
            (size_t)arr->size, sizeof(*m->bpe_merges));
        if (!m->bpe_merges) { codec_map_free(m); free(toks); return CODEC_ERR_OUT_OF_MEMORY; }
        size_t pos = idx_merges + 1;
        for (int j = 0; j < arr->size; j++) {
            const jsmntok_t *str = &toks[pos];
            if (str->type != JSMN_STRING) {
                codec_map_free(m); free(toks); return CODEC_ERR_PARSE;
            }
            size_t L = (size_t)(str->end - str->start), uL;
            char *pair = json_unescape(json + str->start, L, &uL);
            if (!pair) { codec_map_free(m); free(toks); return CODEC_ERR_PARSE; }
            m->bpe_merges[j].pair = pair;
            m->bpe_merges[j].rank = (uint32_t)j;
            pos++;
        }
        m->bpe_merges_count = (size_t)arr->size;
        qsort(m->bpe_merges, m->bpe_merges_count,
              sizeof(*m->bpe_merges), cmp_bpe_merge);
    }

    /* Sort BPE vocab for bsearch lookups. */
    if (m->bpe_vocab && m->bpe_vocab_count > 1) {
        qsort(m->bpe_vocab, m->bpe_vocab_count,
              sizeof(*m->bpe_vocab), cmp_bpe_vocab);
    }

    /* ── Process pre_tokenizer_program (v2.1) ──────────────────────────── */
    if (idx_pretok_program != 0) {
        codec_status_t pst = parse_pretok_program(m, json, toks, idx_pretok_program);
        if (pst != CODEC_OK) { codec_map_free(m); free(toks); return pst; }
    }

    /* ── Process tool_calling (v2.1, optional) ─────────────────────────── */
    if (idx_tool_calling != 0) {
        codec_status_t tst = parse_tool_calling(m, json, toks, idx_tool_calling);
        if (tst != CODEC_OK) { codec_map_free(m); free(toks); return tst; }
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

const codec_tool_calling_t *codec_map_tool_calling(
    const codec_tokenizer_map_t *m) {
    return m ? m->tool_calling : NULL;
}
