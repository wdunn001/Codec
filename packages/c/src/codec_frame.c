/* CodecFrame encode/decode: msgpack and protobuf, hand-rolled.
 *
 * The frame shape is fixed:
 *   { ids: [uint32], done: bool, finish_reason?: string }
 *
 * msgpack encoding: a fixmap of 2 or 3 entries.
 * protobuf encoding: hand-rolled wire format matching the .proto in spec.
 */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stdlib.h>
#include <string.h>

/* ── shared growable byte buffer ────────────────────────────────────────── */

typedef struct {
    uint8_t *data;
    size_t   len;
    size_t   cap;
} bytebuf_t;

static int bb_reserve(bytebuf_t *b, size_t need) {
    if (b->cap >= need) return 1;
    size_t cap = b->cap ? b->cap : 64;
    while (cap < need) cap *= 2;
    uint8_t *p = (uint8_t *)realloc(b->data, cap);
    if (!p) return 0;
    b->data = p;
    b->cap = cap;
    return 1;
}
static int bb_putc(bytebuf_t *b, uint8_t c) {
    if (!bb_reserve(b, b->len + 1)) return 0;
    b->data[b->len++] = c;
    return 1;
}
static int bb_put(bytebuf_t *b, const uint8_t *p, size_t n) {
    if (!bb_reserve(b, b->len + n)) return 0;
    memcpy(b->data + b->len, p, n);
    b->len += n;
    return 1;
}
static int bb_put_be32(bytebuf_t *b, uint32_t v) {
    uint8_t tmp[4] = { (uint8_t)(v >> 24), (uint8_t)(v >> 16),
                       (uint8_t)(v >> 8),  (uint8_t)v };
    return bb_put(b, tmp, 4);
}

/* ── msgpack encode (we emit only the shapes the wire spec defines) ─────── */

static int mp_pack_uint(bytebuf_t *b, uint32_t v) {
    if (v <= 0x7F) return bb_putc(b, (uint8_t)v);
    if (v <= 0xFF) {
        uint8_t tmp[2] = { 0xCC, (uint8_t)v };
        return bb_put(b, tmp, 2);
    }
    if (v <= 0xFFFF) {
        uint8_t tmp[3] = { 0xCD, (uint8_t)(v >> 8), (uint8_t)v };
        return bb_put(b, tmp, 3);
    }
    uint8_t tmp[5] = { 0xCE, (uint8_t)(v >> 24), (uint8_t)(v >> 16),
                              (uint8_t)(v >>  8), (uint8_t)v };
    return bb_put(b, tmp, 5);
}

static int mp_pack_array_header(bytebuf_t *b, uint32_t n) {
    if (n <= 15)    return bb_putc(b, (uint8_t)(0x90 | n));
    if (n <= 0xFFFF) {
        uint8_t tmp[3] = { 0xDC, (uint8_t)(n >> 8), (uint8_t)n };
        return bb_put(b, tmp, 3);
    }
    uint8_t tmp[5] = { 0xDD, (uint8_t)(n >> 24), (uint8_t)(n >> 16),
                              (uint8_t)(n >>  8), (uint8_t)n };
    return bb_put(b, tmp, 5);
}

static int mp_pack_map_header(bytebuf_t *b, uint32_t n) {
    if (n <= 15) return bb_putc(b, (uint8_t)(0x80 | n));
    /* CodecFrame map only ever has 2 or 3 fields, so we don't need the
     * larger encodings. Defensive: support up to 0xFFFF. */
    uint8_t tmp[3] = { 0xDE, (uint8_t)(n >> 8), (uint8_t)n };
    return bb_put(b, tmp, 3);
}

static int mp_pack_str(bytebuf_t *b, const char *s, size_t len) {
    if (len <= 31) {
        if (!bb_putc(b, (uint8_t)(0xA0 | len))) return 0;
    } else if (len <= 0xFF) {
        uint8_t hdr[2] = { 0xD9, (uint8_t)len };
        if (!bb_put(b, hdr, 2)) return 0;
    } else if (len <= 0xFFFF) {
        uint8_t hdr[3] = { 0xDA, (uint8_t)(len >> 8), (uint8_t)len };
        if (!bb_put(b, hdr, 3)) return 0;
    } else {
        uint8_t hdr[5] = { 0xDB, (uint8_t)(len >> 24), (uint8_t)(len >> 16),
                                  (uint8_t)(len >>  8), (uint8_t)len };
        if (!bb_put(b, hdr, 5)) return 0;
    }
    return bb_put(b, (const uint8_t *)s, len);
}

static int mp_pack_bool(bytebuf_t *b, bool v) { return bb_putc(b, v ? 0xC3 : 0xC2); }

/* Pack one tool call as a msgpack map. Mirrors sglang's
 * _encode_tool_call_msg + the python wire shape:
 *   {arguments_json: str, name?: str, id?: str}
 * Only present fields are packed: keeps small frames small. */
static int mp_pack_tool_call(bytebuf_t *b, const codec_tool_call_t *tc) {
    uint32_t fields = 1; /* arguments_json is required */
    if (tc->name) fields++;
    if (tc->id)   fields++;

    if (!mp_pack_map_header(b, fields)) return 0;

    /* arguments_json: always emitted; empty string if the model produced
     * an empty body. Downstream parsers distinguish missing vs empty by
     * key presence. */
    {
        const char *s = tc->arguments_json ? tc->arguments_json : "";
        if (!mp_pack_str(b, "arguments_json", 14)) return 0;
        if (!mp_pack_str(b, s, strlen(s))) return 0;
    }
    if (tc->name) {
        if (!mp_pack_str(b, "name", 4)) return 0;
        if (!mp_pack_str(b, tc->name, strlen(tc->name))) return 0;
    }
    if (tc->id) {
        if (!mp_pack_str(b, "id", 2)) return 0;
        if (!mp_pack_str(b, tc->id, strlen(tc->id))) return 0;
    }
    return 1;
}

codec_status_t codec_encode_msgpack(const codec_frame_t *frame, codec_buffer_t *out) {
    if (!frame || !out) return CODEC_ERR_INVALID_ARG;
    bytebuf_t b = {0};
    uint32_t fields = 2; /* ids, done */
    if (frame->finish_reason)        fields++;
    if (frame->tool_calls_len > 0)   fields++;

    if (!mp_pack_map_header(&b, fields)) goto oom;

    if (!mp_pack_str(&b, "ids", 3)) goto oom;
    if (!mp_pack_array_header(&b, (uint32_t)frame->ids_len)) goto oom;
    for (size_t i = 0; i < frame->ids_len; i++) {
        if (!mp_pack_uint(&b, frame->ids[i])) goto oom;
    }
    if (!mp_pack_str(&b, "done", 4)) goto oom;
    if (!mp_pack_bool(&b, frame->done)) goto oom;
    if (frame->finish_reason) {
        if (!mp_pack_str(&b, "finish_reason", 13)) goto oom;
        if (!mp_pack_str(&b, frame->finish_reason, strlen(frame->finish_reason))) goto oom;
    }
    if (frame->tool_calls_len > 0) {
        if (!frame->tool_calls) goto oom; /* defensive: len > 0 with NULL ptr is a caller bug */
        if (!mp_pack_str(&b, "tool_calls", 10)) goto oom;
        if (!mp_pack_array_header(&b, (uint32_t)frame->tool_calls_len)) goto oom;
        for (size_t i = 0; i < frame->tool_calls_len; i++) {
            if (!mp_pack_tool_call(&b, &frame->tool_calls[i])) goto oom;
        }
    }

    out->data = b.data;
    out->len  = b.len;
    return CODEC_OK;
oom:
    free(b.data);
    return CODEC_ERR_OUT_OF_MEMORY;
}

/* ── msgpack decode (only the shapes the wire spec defines) ─────────────── */

typedef struct {
    const uint8_t *p;
    size_t         remaining;
} mp_reader_t;

static int mp_take(mp_reader_t *r, size_t n, const uint8_t **out) {
    if (r->remaining < n) return 0;
    *out = r->p;
    r->p += n;
    r->remaining -= n;
    return 1;
}

static int mp_read_u8(mp_reader_t *r, uint8_t *v) {
    const uint8_t *p; if (!mp_take(r, 1, &p)) return 0; *v = p[0]; return 1;
}

static int mp_read_be(mp_reader_t *r, size_t n, uint64_t *v) {
    const uint8_t *p; if (!mp_take(r, n, &p)) return 0;
    uint64_t x = 0;
    for (size_t i = 0; i < n; i++) x = (x << 8) | (uint64_t)p[i];
    *v = x;
    return 1;
}

static int mp_read_uint(mp_reader_t *r, uint32_t *out) {
    uint8_t b;
    if (!mp_read_u8(r, &b)) return 0;
    if (b <= 0x7F) { *out = b; return 1; }
    uint64_t v;
    switch (b) {
        case 0xCC: if (!mp_read_be(r, 1, &v)) return 0; *out = (uint32_t)v; return 1;
        case 0xCD: if (!mp_read_be(r, 2, &v)) return 0; *out = (uint32_t)v; return 1;
        case 0xCE: if (!mp_read_be(r, 4, &v)) return 0; *out = (uint32_t)v; return 1;
        case 0xCF:
            /* uint64: we only support uint32 token IDs; reject overflow. */
            if (!mp_read_be(r, 8, &v)) return 0;
            if (v > 0xFFFFFFFFu) return 0;
            *out = (uint32_t)v; return 1;
        case 0xD0: case 0xD1: case 0xD2: case 0xD3: /* signed: should not appear */
            return 0;
        default: return 0;
    }
}

static int mp_read_array_header(mp_reader_t *r, uint32_t *n) {
    uint8_t b;
    if (!mp_read_u8(r, &b)) return 0;
    if ((b & 0xF0) == 0x90) { *n = b & 0x0F; return 1; }
    uint64_t v;
    if (b == 0xDC) { if (!mp_read_be(r, 2, &v)) return 0; *n = (uint32_t)v; return 1; }
    if (b == 0xDD) { if (!mp_read_be(r, 4, &v)) return 0; *n = (uint32_t)v; return 1; }
    return 0;
}

static int mp_read_map_header(mp_reader_t *r, uint32_t *n) {
    uint8_t b;
    if (!mp_read_u8(r, &b)) return 0;
    if ((b & 0xF0) == 0x80) { *n = b & 0x0F; return 1; }
    uint64_t v;
    if (b == 0xDE) { if (!mp_read_be(r, 2, &v)) return 0; *n = (uint32_t)v; return 1; }
    if (b == 0xDF) { if (!mp_read_be(r, 4, &v)) return 0; *n = (uint32_t)v; return 1; }
    return 0;
}

/* Read a string's length and a pointer into the source buffer. The string
 * is NOT NUL-terminated; the caller copies it out if needed. */
static int mp_read_str_view(mp_reader_t *r, const char **s, size_t *len) {
    uint8_t b;
    if (!mp_read_u8(r, &b)) return 0;
    size_t n;
    if ((b & 0xE0) == 0xA0) { n = b & 0x1F; }
    else if (b == 0xD9) { uint64_t v; if (!mp_read_be(r, 1, &v)) return 0; n = (size_t)v; }
    else if (b == 0xDA) { uint64_t v; if (!mp_read_be(r, 2, &v)) return 0; n = (size_t)v; }
    else if (b == 0xDB) { uint64_t v; if (!mp_read_be(r, 4, &v)) return 0; n = (size_t)v; }
    else return 0;
    const uint8_t *p;
    if (!mp_take(r, n, &p)) return 0;
    *s = (const char *)p;
    *len = n;
    return 1;
}

static int mp_read_bool(mp_reader_t *r, bool *v) {
    uint8_t b; if (!mp_read_u8(r, &b)) return 0;
    if (b == 0xC2) { *v = false; return 1; }
    if (b == 0xC3) { *v = true; return 1; }
    return 0;
}

/* Skip a single msgpack value. Used to ignore unknown fields. Returns
 * remaining bytes consumed via the reader; 0 on malformed input. */
static int mp_skip_value(mp_reader_t *r);
static int mp_skip_n(mp_reader_t *r, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) if (!mp_skip_value(r)) return 0;
    return 1;
}
static int mp_skip_value(mp_reader_t *r) {
    if (r->remaining == 0) return 0;
    uint8_t b = r->p[0];
    /* fixint / nil / bool */
    if (b <= 0x7F || b >= 0xE0 || b == 0xC0 || b == 0xC2 || b == 0xC3) {
        r->p++; r->remaining--;
        return 1;
    }
    /* fixstr */
    if ((b & 0xE0) == 0xA0) { size_t n = b & 0x1F;
        if (r->remaining < 1 + n) return 0;
        r->p += 1 + n; r->remaining -= 1 + n; return 1; }
    /* fixarray / fixmap */
    if ((b & 0xF0) == 0x90) { uint32_t n = b & 0x0F; r->p++; r->remaining--;
        return mp_skip_n(r, n); }
    if ((b & 0xF0) == 0x80) { uint32_t n = b & 0x0F; r->p++; r->remaining--;
        return mp_skip_n(r, n * 2); }
    /* Various wider types */
    static const uint8_t fixed_widths[256] = {
        [0xCA] = 4, [0xCB] = 8,
        [0xCC] = 1, [0xCD] = 2, [0xCE] = 4, [0xCF] = 8,
        [0xD0] = 1, [0xD1] = 2, [0xD2] = 4, [0xD3] = 8,
        [0xD4] = 2, [0xD5] = 3, [0xD6] = 5, [0xD7] = 9, [0xD8] = 17,
    };
    if (fixed_widths[b]) {
        size_t total = 1u + fixed_widths[b];
        if (r->remaining < total) return 0;
        r->p += total; r->remaining -= total; return 1;
    }
    /* Length-prefixed bin/str/array/map. */
    if (b == 0xC4 || b == 0xC5 || b == 0xC6 || b == 0xD9 || b == 0xDA || b == 0xDB) {
        size_t hl = (b == 0xC4 || b == 0xD9) ? 1 : (b == 0xC5 || b == 0xDA) ? 2 : 4;
        if (r->remaining < 1 + hl) return 0;
        size_t n = 0;
        for (size_t i = 0; i < hl; i++) n = (n << 8) | r->p[1 + i];
        if (r->remaining < 1 + hl + n) return 0;
        r->p += 1 + hl + n; r->remaining -= 1 + hl + n; return 1;
    }
    if (b == 0xDC || b == 0xDD) {
        size_t hl = (b == 0xDC) ? 2 : 4;
        if (r->remaining < 1 + hl) return 0;
        size_t n = 0; for (size_t i = 0; i < hl; i++) n = (n << 8) | r->p[1 + i];
        r->p += 1 + hl; r->remaining -= 1 + hl;
        return mp_skip_n(r, (uint32_t)n);
    }
    if (b == 0xDE || b == 0xDF) {
        size_t hl = (b == 0xDE) ? 2 : 4;
        if (r->remaining < 1 + hl) return 0;
        size_t n = 0; for (size_t i = 0; i < hl; i++) n = (n << 8) | r->p[1 + i];
        r->p += 1 + hl; r->remaining -= 1 + hl;
        return mp_skip_n(r, (uint32_t)n * 2);
    }
    return 0;
}

codec_status_t codec_decode_msgpack(const uint8_t *data, size_t len,
                                    codec_frame_t *out, size_t *consumed) {
    if (!data || !out) return CODEC_ERR_INVALID_ARG;
    codec_frame_init(out);

    mp_reader_t r = { data, len };
    uint32_t map_size;
    if (!mp_read_map_header(&r, &map_size)) return CODEC_ERR_INCOMPLETE;

    for (uint32_t i = 0; i < map_size; i++) {
        const char *k; size_t klen;
        if (!mp_read_str_view(&r, &k, &klen)) {
            codec_frame_destroy(out);
            return CODEC_ERR_PARSE;
        }
        if (klen == 3 && memcmp(k, "ids", 3) == 0) {
            uint32_t n;
            if (!mp_read_array_header(&r, &n)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
            free(out->ids);
            out->ids = (uint32_t *)malloc(n > 0 ? n * sizeof(uint32_t) : 1);
            if (!out->ids) { codec_frame_destroy(out); return CODEC_ERR_OUT_OF_MEMORY; }
            for (uint32_t j = 0; j < n; j++) {
                if (!mp_read_uint(&r, &out->ids[j])) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
            }
            out->ids_len = n;
        } else if (klen == 4 && memcmp(k, "done", 4) == 0) {
            if (!mp_read_bool(&r, &out->done)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
        } else if (klen == 13 && memcmp(k, "finish_reason", 13) == 0) {
            /* Could be string or nil. */
            if (r.remaining > 0 && r.p[0] == 0xC0) { r.p++; r.remaining--; }
            else {
                const char *s; size_t slen;
                if (!mp_read_str_view(&r, &s, &slen)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
                free(out->finish_reason);
                out->finish_reason = (char *)malloc(slen + 1);
                if (!out->finish_reason) { codec_frame_destroy(out); return CODEC_ERR_OUT_OF_MEMORY; }
                memcpy(out->finish_reason, s, slen);
                out->finish_reason[slen] = 0;
            }
        } else {
            if (!mp_skip_value(&r)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
        }
    }

    if (consumed) *consumed = (size_t)(r.p - data);
    return CODEC_OK;
}

/* ── protobuf encode ────────────────────────────────────────────────────── */

static int pb_put_varint(bytebuf_t *b, uint64_t v) {
    while (v >= 0x80) {
        if (!bb_putc(b, (uint8_t)((v & 0x7F) | 0x80))) return 0;
        v >>= 7;
    }
    return bb_putc(b, (uint8_t)v);
}

/* Encode a single ToolCall sub-message into `out` (no length prefix; the
 * caller adds the length-delimited wrapper as field 4 of CodecFrame).
 * Wire shape (matches sglang's _encode_tool_call_msg):
 *   tag 0x0a  field 1  string name           (optional)
 *   tag 0x12  field 2  string arguments_json (required)
 *   tag 0x1a  field 3  string id             (optional)
 */
static int pb_encode_tool_call(bytebuf_t *out, const codec_tool_call_t *tc) {
    if (tc->name) {
        size_t n = strlen(tc->name);
        if (!bb_putc(out, 0x0A) ||
            !pb_put_varint(out, n) ||
            !bb_put(out, (const uint8_t *)tc->name, n)) return 0;
    }
    {
        const char *s = tc->arguments_json ? tc->arguments_json : "";
        size_t n = strlen(s);
        if (!bb_putc(out, 0x12) ||
            !pb_put_varint(out, n) ||
            !bb_put(out, (const uint8_t *)s, n)) return 0;
    }
    if (tc->id) {
        size_t n = strlen(tc->id);
        if (!bb_putc(out, 0x1A) ||
            !pb_put_varint(out, n) ||
            !bb_put(out, (const uint8_t *)tc->id, n)) return 0;
    }
    return 1;
}

codec_status_t codec_encode_protobuf(const codec_frame_t *frame, codec_buffer_t *out) {
    if (!frame || !out) return CODEC_ERR_INVALID_ARG;
    bytebuf_t b = {0};

    /* We build a payload then prepend a 4-byte big-endian length. */
    bytebuf_t payload = {0};

    /* Field 1: repeated uint32 ids [packed = true] */
    if (frame->ids_len > 0) {
        bytebuf_t packed = {0};
        for (size_t i = 0; i < frame->ids_len; i++) {
            if (!pb_put_varint(&packed, frame->ids[i])) {
                free(packed.data); free(payload.data); return CODEC_ERR_OUT_OF_MEMORY;
            }
        }
        if (!bb_putc(&payload, 0x0A) ||
            !pb_put_varint(&payload, packed.len) ||
            !bb_put(&payload, packed.data, packed.len)) {
            free(packed.data); free(payload.data); return CODEC_ERR_OUT_OF_MEMORY;
        }
        free(packed.data);
    }

    /* Field 2: bool done. */
    if (!bb_putc(&payload, 0x10) || !bb_putc(&payload, frame->done ? 1 : 0)) {
        free(payload.data); return CODEC_ERR_OUT_OF_MEMORY;
    }

    /* Field 3: optional string finish_reason. */
    if (frame->finish_reason) {
        size_t slen = strlen(frame->finish_reason);
        if (!bb_putc(&payload, 0x1A) ||
            !pb_put_varint(&payload, slen) ||
            !bb_put(&payload, (const uint8_t *)frame->finish_reason, slen)) {
            free(payload.data); return CODEC_ERR_OUT_OF_MEMORY;
        }
    }

    /* Field 4: repeated ToolCall tool_calls. Each call is a length-delimited
     * sub-message tagged 0x22 = (4 << 3) | 2. */
    if (frame->tool_calls_len > 0) {
        if (!frame->tool_calls) { free(payload.data); return CODEC_ERR_INVALID_ARG; }
        for (size_t i = 0; i < frame->tool_calls_len; i++) {
            bytebuf_t sub = {0};
            if (!pb_encode_tool_call(&sub, &frame->tool_calls[i])) {
                free(sub.data); free(payload.data); return CODEC_ERR_OUT_OF_MEMORY;
            }
            if (!bb_putc(&payload, 0x22) ||
                !pb_put_varint(&payload, sub.len) ||
                !bb_put(&payload, sub.data, sub.len)) {
                free(sub.data); free(payload.data); return CODEC_ERR_OUT_OF_MEMORY;
            }
            free(sub.data);
        }
    }

    /* Length prefix + payload. */
    if (!bb_put_be32(&b, (uint32_t)payload.len) ||
        !bb_put(&b, payload.data, payload.len)) {
        free(payload.data); free(b.data); return CODEC_ERR_OUT_OF_MEMORY;
    }
    free(payload.data);

    out->data = b.data;
    out->len  = b.len;
    return CODEC_OK;
}

/* ── protobuf decode ────────────────────────────────────────────────────── */

static int pb_read_varint(const uint8_t *data, size_t len, size_t *pos, uint64_t *out) {
    uint64_t v = 0;
    int shift = 0;
    while (*pos < len) {
        uint8_t b = data[(*pos)++];
        v |= (uint64_t)(b & 0x7F) << shift;
        if (!(b & 0x80)) { *out = v; return 1; }
        shift += 7;
        if (shift > 63) return 0;
    }
    return 0;
}

codec_status_t codec_decode_protobuf_frame(const uint8_t *data, size_t len,
                                           codec_frame_t *out) {
    if (!data || !out) return CODEC_ERR_INVALID_ARG;
    codec_frame_init(out);

    size_t pos = 0;
    /* Pre-count IDs so we can allocate exactly. */
    size_t ids_count = 0;
    {
        size_t scan = 0;
        while (scan < len) {
            uint64_t tag;
            if (!pb_read_varint(data, len, &scan, &tag)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
            uint64_t field = tag >> 3;
            uint64_t wt    = tag & 0x07;
            if (field == 1 && wt == 2) {
                uint64_t length;
                if (!pb_read_varint(data, len, &scan, &length)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
                size_t sub_end = scan + (size_t)length;
                if (sub_end > len) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
                size_t sp = scan;
                while (sp < sub_end) {
                    uint64_t v; if (!pb_read_varint(data, sub_end, &sp, &v)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
                    ids_count++;
                }
                scan = sub_end;
            } else if (wt == 0) {
                uint64_t v; if (!pb_read_varint(data, len, &scan, &v)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
            } else if (wt == 1) {
                if (scan + 8 > len) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
                scan += 8;
            } else if (wt == 2) {
                uint64_t length; if (!pb_read_varint(data, len, &scan, &length)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
                if (scan + length > len) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
                scan += length;
            } else if (wt == 5) {
                if (scan + 4 > len) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
                scan += 4;
            } else {
                codec_frame_destroy(out); return CODEC_ERR_PARSE;
            }
        }
    }

    if (ids_count > 0) {
        out->ids = (uint32_t *)malloc(ids_count * sizeof(uint32_t));
        if (!out->ids) return CODEC_ERR_OUT_OF_MEMORY;
    }

    size_t ids_written = 0;
    while (pos < len) {
        uint64_t tag;
        if (!pb_read_varint(data, len, &pos, &tag)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
        uint64_t field = tag >> 3;
        uint64_t wt    = tag & 0x07;

        if (wt == 0) {
            uint64_t v; if (!pb_read_varint(data, len, &pos, &v)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
            if (field == 2) out->done = (v != 0);
        } else if (wt == 1) {
            pos += 8;
        } else if (wt == 2) {
            uint64_t length;
            if (!pb_read_varint(data, len, &pos, &length)) { codec_frame_destroy(out); return CODEC_ERR_PARSE; }
            const uint8_t *chunk = data + pos;
            size_t chunk_len = (size_t)length;
            pos += chunk_len;

            if (field == 1) { /* packed repeated uint32 ids */
                size_t sp = 0;
                while (sp < chunk_len) {
                    uint64_t v;
                    if (!pb_read_varint(chunk, chunk_len, &sp, &v)) {
                        codec_frame_destroy(out); return CODEC_ERR_PARSE;
                    }
                    out->ids[ids_written++] = (uint32_t)v;
                }
            } else if (field == 3) { /* string finish_reason */
                free(out->finish_reason);
                out->finish_reason = (char *)malloc(chunk_len + 1);
                if (!out->finish_reason) { codec_frame_destroy(out); return CODEC_ERR_OUT_OF_MEMORY; }
                memcpy(out->finish_reason, chunk, chunk_len);
                out->finish_reason[chunk_len] = 0;
            }
        } else if (wt == 5) {
            pos += 4;
        } else {
            codec_frame_destroy(out); return CODEC_ERR_PARSE;
        }
    }

    out->ids_len = ids_written;
    return CODEC_OK;
}
