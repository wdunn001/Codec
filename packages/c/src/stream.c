/* Incremental stream decoders for the two Codec wire formats. */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stdlib.h>
#include <string.h>

/* ── shared accumulating buffer ─────────────────────────────────────────── */

typedef struct {
    uint8_t *data;
    size_t   len;
    size_t   cap;
} accbuf_t;

static int acc_reserve(accbuf_t *a, size_t need) {
    if (a->cap >= need) return 1;
    size_t cap = a->cap ? a->cap : 256;
    while (cap < need) cap *= 2;
    uint8_t *p = (uint8_t *)realloc(a->data, cap);
    if (!p) return 0;
    a->data = p;
    a->cap = cap;
    return 1;
}
static int acc_append(accbuf_t *a, const uint8_t *src, size_t n) {
    if (n == 0) return 1;
    if (!acc_reserve(a, a->len + n)) return 0;
    memcpy(a->data + a->len, src, n);
    a->len += n;
    return 1;
}
static void acc_consume_front(accbuf_t *a, size_t n) {
    if (n >= a->len) { a->len = 0; return; }
    memmove(a->data, a->data + n, a->len - n);
    a->len -= n;
}

/* ── msgpack stream ─────────────────────────────────────────────────────── */
/*
 * msgpack frames are length-self-describing; we walk the value tree to
 * locate the boundary, then hand the slice to codec_decode_msgpack.
 */

struct codec_msgpack_stream {
    accbuf_t buf;
};

codec_status_t codec_msgpack_stream_new(codec_msgpack_stream_t **out) {
    if (!out) return CODEC_ERR_INVALID_ARG;
    *out = (codec_msgpack_stream_t *)calloc(1, sizeof(codec_msgpack_stream_t));
    return *out ? CODEC_OK : CODEC_ERR_OUT_OF_MEMORY;
}
void codec_msgpack_stream_free(codec_msgpack_stream_t *s) {
    if (!s) return;
    free(s->buf.data);
    free(s);
}
codec_status_t codec_msgpack_stream_feed(codec_msgpack_stream_t *s,
                                         const uint8_t *data, size_t len) {
    if (!s) return CODEC_ERR_INVALID_ARG;
    return acc_append(&s->buf, data, len) ? CODEC_OK : CODEC_ERR_OUT_OF_MEMORY;
}

/* Walk a single msgpack value to find its end offset. Returns 0 if the
 * buffer is too short, -1 on malformed input, otherwise the byte index
 * just past the value. */
/* `depth` bounds container nesting. This walker runs on the raw accumulated
 * buffer before any frame is decoded. A plain run of 0x91 bytes with no
 * valid frame in it is therefore enough to exhaust the stack. Codec frames
 * nest three deep at most. */
#define CODEC_MP_MAX_DEPTH 64
static long mp_end_offset(const uint8_t *p, size_t len, size_t pos, unsigned depth);

static long mp_skip_n(const uint8_t *p, size_t len, size_t pos, uint32_t n,
                      unsigned depth) {
    for (uint32_t i = 0; i < n; i++) {
        long next = mp_end_offset(p, len, pos, depth);
        if (next <= 0) return next;
        pos = (size_t)next;
    }
    return (long)pos;
}

static long mp_end_offset(const uint8_t *p, size_t len, size_t pos,
                          unsigned depth) {
    if (depth > CODEC_MP_MAX_DEPTH) return -1;
    if (pos >= len) return 0;
    uint8_t b = p[pos];

    /* fixint, neg fixint, nil, false, true */
    if (b <= 0x7F || b >= 0xE0 || b == 0xC0 || b == 0xC2 || b == 0xC3) return (long)pos + 1;

    /* fixstr */
    if ((b & 0xE0) == 0xA0) {
        size_t n = b & 0x1F;
        if (pos + 1 + n > len) return 0;
        return (long)(pos + 1 + n);
    }
    /* fixarray / fixmap */
    if ((b & 0xF0) == 0x90) return mp_skip_n(p, len, pos + 1, b & 0x0F, depth + 1);
    if ((b & 0xF0) == 0x80) return mp_skip_n(p, len, pos + 1, (uint32_t)(b & 0x0F) * 2, depth + 1);

    /* fixed-width primitives */
    static const uint8_t fixed_widths[256] = {
        [0xCA] = 4, [0xCB] = 8,
        [0xCC] = 1, [0xCD] = 2, [0xCE] = 4, [0xCF] = 8,
        [0xD0] = 1, [0xD1] = 2, [0xD2] = 4, [0xD3] = 8,
        [0xD4] = 2, [0xD5] = 3, [0xD6] = 5, [0xD7] = 9, [0xD8] = 17,
    };
    if (fixed_widths[b]) {
        size_t total = 1u + fixed_widths[b];
        if (pos + total > len) return 0;
        return (long)(pos + total);
    }

    /* Length-prefixed bin/str. */
    if (b == 0xC4 || b == 0xC5 || b == 0xC6 || b == 0xD9 || b == 0xDA || b == 0xDB) {
        size_t hl = (b == 0xC4 || b == 0xD9) ? 1 : (b == 0xC5 || b == 0xDA) ? 2 : 4;
        if (pos + 1 + hl > len) return 0;
        size_t n = 0;
        for (size_t i = 0; i < hl; i++) n = (n << 8) | p[pos + 1 + i];
        if (pos + 1 + hl + n > len) return 0;
        return (long)(pos + 1 + hl + n);
    }
    /* array16/32, map16/32 */
    if (b == 0xDC || b == 0xDD) {
        size_t hl = (b == 0xDC) ? 2 : 4;
        if (pos + 1 + hl > len) return 0;
        size_t n = 0;
        for (size_t i = 0; i < hl; i++) n = (n << 8) | p[pos + 1 + i];
        return mp_skip_n(p, len, pos + 1 + hl, (uint32_t)n, depth + 1);
    }
    if (b == 0xDE || b == 0xDF) {
        size_t hl = (b == 0xDE) ? 2 : 4;
        if (pos + 1 + hl > len) return 0;
        size_t n = 0;
        for (size_t i = 0; i < hl; i++) n = (n << 8) | p[pos + 1 + i];
        return mp_skip_n(p, len, pos + 1 + hl, (uint32_t)n * 2, depth + 1);
    }
    /* ext family (0xC7..0xC9): skip for now */
    if (b == 0xC7 || b == 0xC8 || b == 0xC9) {
        size_t hl = (b == 0xC7) ? 1 : (b == 0xC8) ? 2 : 4;
        if (pos + 1 + hl + 1 > len) return 0;
        size_t n = 0;
        for (size_t i = 0; i < hl; i++) n = (n << 8) | p[pos + 1 + i];
        if (pos + 1 + hl + 1 + n > len) return 0;
        return (long)(pos + 1 + hl + 1 + n);
    }
    return -1;
}

codec_status_t codec_msgpack_stream_next(codec_msgpack_stream_t *s,
                                         codec_frame_t *out) {
    if (!s || !out) return CODEC_ERR_INVALID_ARG;
    long end = mp_end_offset(s->buf.data, s->buf.len, 0, 0);
    if (end == 0) return CODEC_ERR_INCOMPLETE;
    if (end < 0)  return CODEC_ERR_PARSE;

    size_t consumed = 0;
    codec_status_t st = codec_decode_msgpack(s->buf.data, (size_t)end, out, &consumed);
    if (st != CODEC_OK) return st;
    acc_consume_front(&s->buf, consumed);
    return CODEC_OK;
}

/* ── protobuf stream ────────────────────────────────────────────────────── */
/*
 * Protobuf frames have an explicit 4-byte big-endian length prefix.
 */

struct codec_protobuf_stream {
    accbuf_t buf;
};

codec_status_t codec_protobuf_stream_new(codec_protobuf_stream_t **out) {
    if (!out) return CODEC_ERR_INVALID_ARG;
    *out = (codec_protobuf_stream_t *)calloc(1, sizeof(codec_protobuf_stream_t));
    return *out ? CODEC_OK : CODEC_ERR_OUT_OF_MEMORY;
}
void codec_protobuf_stream_free(codec_protobuf_stream_t *s) {
    if (!s) return;
    free(s->buf.data);
    free(s);
}
codec_status_t codec_protobuf_stream_feed(codec_protobuf_stream_t *s,
                                          const uint8_t *data, size_t len) {
    if (!s) return CODEC_ERR_INVALID_ARG;
    return acc_append(&s->buf, data, len) ? CODEC_OK : CODEC_ERR_OUT_OF_MEMORY;
}
codec_status_t codec_protobuf_stream_next(codec_protobuf_stream_t *s,
                                          codec_frame_t *out) {
    if (!s || !out) return CODEC_ERR_INVALID_ARG;
    if (s->buf.len < 4) return CODEC_ERR_INCOMPLETE;

    uint32_t flen = ((uint32_t)s->buf.data[0] << 24)
                  | ((uint32_t)s->buf.data[1] << 16)
                  | ((uint32_t)s->buf.data[2] << 8)
                  |  (uint32_t)s->buf.data[3];
    if (s->buf.len < (size_t)4 + flen) return CODEC_ERR_INCOMPLETE;

    codec_status_t st = codec_decode_protobuf_frame(s->buf.data + 4, flen, out);
    if (st != CODEC_OK) return st;
    acc_consume_front(&s->buf, 4 + (size_t)flen);
    return CODEC_OK;
}
