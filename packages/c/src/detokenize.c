/* Stateful detokenizer: byte_level + metaspace + byte fallback + partial
 * UTF-8 buffering across calls. Mirrors @codecai/web's Detokenizer. */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stdlib.h>
#include <string.h>

/* Output is a growable byte buffer that we always finalize as UTF-8. */
typedef struct {
    char  *data;
    size_t len;
    size_t cap;
} growbuf_t;

static int gb_reserve(growbuf_t *b, size_t need) {
    if (b->cap >= need) return 1;
    size_t cap = b->cap ? b->cap : 64;
    while (cap < need) cap *= 2;
    char *p = (char *)realloc(b->data, cap + 1);
    if (!p) return 0;
    b->data = p;
    b->cap = cap;
    return 1;
}
static int gb_append(growbuf_t *b, const char *s, size_t len) {
    if (!gb_reserve(b, b->len + len)) return 0;
    memcpy(b->data + b->len, s, len);
    b->len += len;
    return 1;
}
static int gb_append_bytes(growbuf_t *b, const uint8_t *s, size_t len) {
    return gb_append(b, (const char *)s, len);
}
static int gb_append_replacement(growbuf_t *b) {
    /* U+FFFD = EF BF BD */
    static const char repl[3] = { (char)0xEF, (char)0xBF, (char)0xBD };
    return gb_append(b, repl, 3);
}

/* ── Detokenizer struct ─────────────────────────────────────────────────── */

struct codec_detokenizer {
    const codec_tokenizer_map_t *map;

    /* Partial-UTF-8 buffer; only populated by byte_level decoded bytes
     * and SentencePiece byte-fallback IDs. */
    uint8_t *byte_buf;
    size_t   byte_len;
    size_t   byte_cap;

    int32_t fallback_start; /* cached from map (-1 if none) */
    int32_t fallback_end;
    int     is_byte_level;
};

static int byte_buf_reserve(codec_detokenizer_t *d, size_t need) {
    if (d->byte_cap >= need) return 1;
    size_t cap = d->byte_cap ? d->byte_cap : 16;
    while (cap < need) cap *= 2;
    uint8_t *p = (uint8_t *)realloc(d->byte_buf, cap);
    if (!p) return 0;
    d->byte_buf = p;
    d->byte_cap = cap;
    return 1;
}

codec_status_t codec_detokenizer_new(const codec_tokenizer_map_t *map,
                                     codec_detokenizer_t **out) {
    if (!map || !out) return CODEC_ERR_INVALID_ARG;
    codec_detokenizer_t *d = (codec_detokenizer_t *)calloc(1, sizeof(*d));
    if (!d) return CODEC_ERR_OUT_OF_MEMORY;
    d->map = map;
    d->fallback_start = codec_map_byte_fallback_start(map);
    d->fallback_end   = codec_map_byte_fallback_end(map);
    d->is_byte_level  = codec_map_encoder(map) == CODEC_ENCODER_BYTE_LEVEL;
    *out = d;
    return CODEC_OK;
}

void codec_detokenizer_free(codec_detokenizer_t *d) {
    if (!d) return;
    free(d->byte_buf);
    free(d);
}

void codec_detokenizer_reset(codec_detokenizer_t *d) {
    if (d) d->byte_len = 0;
}

/* ── Byte-buffer flushing ───────────────────────────────────────────────── */

/* Try to peel and emit complete UTF-8 sequences from the head of byte_buf.
 * Stops when the next sequence is incomplete (returns leaving partial in
 * the buffer). */
static int flush_complete(codec_detokenizer_t *d, growbuf_t *out) {
    while (d->byte_len > 0) {
        int needed = codec_utf8_seq_len(d->byte_buf[0]);
        if (needed == 0) {
            /* Invalid leading byte: drop it as a replacement char. */
            memmove(d->byte_buf, d->byte_buf + 1, --d->byte_len);
            if (!gb_append_replacement(out)) return 0;
            continue;
        }
        if ((size_t)needed > d->byte_len) return 1; /* incomplete: keep buffered */

        /* Check continuation bytes. */
        int valid = 1;
        for (int k = 1; k < needed; k++) {
            if ((d->byte_buf[k] & 0xC0) != 0x80) { valid = 0; break; }
        }
        if (!valid) {
            /* Drop one byte, emit replacement. */
            memmove(d->byte_buf, d->byte_buf + 1, --d->byte_len);
            if (!gb_append_replacement(out)) return 0;
            continue;
        }
        if (!gb_append_bytes(out, d->byte_buf, (size_t)needed)) return 0;
        memmove(d->byte_buf, d->byte_buf + needed, d->byte_len - (size_t)needed);
        d->byte_len -= (size_t)needed;
    }
    return 1;
}

/* Force-flush whatever's in the byte buffer, replacing invalid sequences. */
static int flush_force(codec_detokenizer_t *d, growbuf_t *out) {
    /* Walk through byte_buf decoding; whatever doesn't decode → replacement. */
    while (d->byte_len > 0) {
        int needed = codec_utf8_seq_len(d->byte_buf[0]);
        if (needed == 0 || (size_t)needed > d->byte_len) {
            memmove(d->byte_buf, d->byte_buf + 1, --d->byte_len);
            if (!gb_append_replacement(out)) return 0;
            continue;
        }
        int valid = 1;
        for (int k = 1; k < needed; k++) {
            if ((d->byte_buf[k] & 0xC0) != 0x80) { valid = 0; break; }
        }
        if (!valid) {
            memmove(d->byte_buf, d->byte_buf + 1, --d->byte_len);
            if (!gb_append_replacement(out)) return 0;
            continue;
        }
        if (!gb_append_bytes(out, d->byte_buf, (size_t)needed)) return 0;
        memmove(d->byte_buf, d->byte_buf + needed, d->byte_len - (size_t)needed);
        d->byte_len -= (size_t)needed;
    }
    return 1;
}

/* ── Render ─────────────────────────────────────────────────────────────── */

codec_status_t codec_detokenizer_render(codec_detokenizer_t *d,
                                        const uint32_t *ids, size_t ids_len,
                                        codec_detokenize_opts_t opts,
                                        char **out, size_t *out_len) {
    if (!d || !out) return CODEC_ERR_INVALID_ARG;
    *out = NULL;
    if (out_len) *out_len = 0;

    growbuf_t buf = {0};
    if (!gb_reserve(&buf, 16)) return CODEC_ERR_OUT_OF_MEMORY;

    for (size_t i = 0; i < ids_len; i++) {
        uint32_t id = ids[i];

        /* Byte-fallback range: SentencePiece reserves IDs for bytes 0x00-0xFF. */
        if (d->fallback_start >= 0
            && (int64_t)id >= (int64_t)d->fallback_start
            && (int64_t)id <= (int64_t)d->fallback_end) {
            if (!byte_buf_reserve(d, d->byte_len + 1)) {
                free(buf.data); return CODEC_ERR_OUT_OF_MEMORY;
            }
            d->byte_buf[d->byte_len++] = (uint8_t)((int64_t)id - d->fallback_start);
            if (!flush_complete(d, &buf)) { free(buf.data); return CODEC_ERR_OUT_OF_MEMORY; }
            continue;
        }

        if (d->is_byte_level) {
            /* byte_level: every vocab token IS a byte sequence. */
            if (codec_map_is_special(d->map, id) && !opts.render_special) {
                if (d->byte_len > 0) {
                    if (!flush_force(d, &buf)) { free(buf.data); return CODEC_ERR_OUT_OF_MEMORY; }
                }
                continue;
            }
            const codec_id_entry_t *e = codec_map_entry(d->map, id);
            if (!e) {
                if (d->byte_len > 0) {
                    if (!flush_force(d, &buf)) { free(buf.data); return CODEC_ERR_OUT_OF_MEMORY; }
                }
                if (!gb_append_replacement(&buf)) { free(buf.data); return CODEC_ERR_OUT_OF_MEMORY; }
                continue;
            }
            if (!byte_buf_reserve(d, d->byte_len + e->len)) {
                free(buf.data); return CODEC_ERR_OUT_OF_MEMORY;
            }
            memcpy(d->byte_buf + d->byte_len, e->bytes, e->len);
            d->byte_len += e->len;
            if (!flush_complete(d, &buf)) { free(buf.data); return CODEC_ERR_OUT_OF_MEMORY; }
            continue;
        }

        /* metaspace / identity: token text rendered directly. */
        if (d->byte_len > 0) {
            if (!flush_force(d, &buf)) { free(buf.data); return CODEC_ERR_OUT_OF_MEMORY; }
        }
        if (codec_map_is_special(d->map, id) && !opts.render_special) continue;

        const codec_id_entry_t *e = codec_map_entry(d->map, id);
        if (!e) {
            if (!gb_append_replacement(&buf)) { free(buf.data); return CODEC_ERR_OUT_OF_MEMORY; }
            continue;
        }
        if (!gb_append_bytes(&buf, e->bytes, e->len)) {
            free(buf.data); return CODEC_ERR_OUT_OF_MEMORY;
        }
    }

    if (!opts.partial && d->byte_len > 0) {
        if (!flush_force(d, &buf)) { free(buf.data); return CODEC_ERR_OUT_OF_MEMORY; }
    }

    if (!gb_reserve(&buf, buf.len + 1)) { free(buf.data); return CODEC_ERR_OUT_OF_MEMORY; }
    buf.data[buf.len] = 0;
    *out = buf.data;
    if (out_len) *out_len = buf.len;
    return CODEC_OK;
}
