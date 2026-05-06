/* Shared helpers: GPT-2 byte↔unicode table, hex codec, UTF-8 utilities,
 * version + status string. */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ── Version / status strings ───────────────────────────────────────────── */

const char *codec_version(void) { return "0.2.0"; }

const char *codec_status_str(codec_status_t s) {
    switch (s) {
        case CODEC_OK:                return "ok";
        case CODEC_ERR_INVALID_ARG:   return "invalid argument";
        case CODEC_ERR_PARSE:         return "parse error";
        case CODEC_ERR_VALIDATION:    return "validation error";
        case CODEC_ERR_HASH_MISMATCH: return "hash mismatch";
        case CODEC_ERR_INCOMPLETE:    return "incomplete (need more bytes)";
        case CODEC_ERR_OUT_OF_MEMORY: return "out of memory";
        case CODEC_ERR_NOT_FOUND:     return "not found";
        case CODEC_ERR_TRUNCATED:     return "truncated";
        case CODEC_ERR_INVALID_UTF8:  return "invalid utf-8";
        default:                      return "unknown error";
    }
}

/* ── Buffer ─────────────────────────────────────────────────────────────── */

void codec_buffer_free(codec_buffer_t *buf) {
    if (!buf) return;
    free(buf->data);
    buf->data = NULL;
    buf->len = 0;
}

/* ── GPT-2 byte ↔ unicode bijection ─────────────────────────────────────── */
/*
 * Build the same 256-entry mapping JS / C# / Python use: bytes 33-126,
 * 161-172, 174-255 map to themselves (printable / non-control); the
 * remaining bytes map to U+0100+n.
 *
 * The forward map (byte → codepoint) is small (256 entries). We store the
 * reverse map (codepoint → byte) in a sorted array of (codepoint, byte)
 * pairs to keep memory low. Codepoints span [0x21, 0xFF] for the identity
 * range and [0x100, 0x142] for the synthetic range.
 */

typedef struct { uint16_t cp; uint8_t byte; } codec_cp_byte_t;

static uint16_t        s_byte_to_cp[256];
static codec_cp_byte_t s_cp_to_byte[256];
static size_t          s_cp_to_byte_len = 0;
static int             s_byte_unicode_inited = 0;

static int cp_byte_cmp(const void *a, const void *b) {
    uint16_t ca = ((const codec_cp_byte_t *)a)->cp;
    uint16_t cb = ((const codec_cp_byte_t *)b)->cp;
    return (ca < cb) ? -1 : (ca > cb);
}

void codec_byte_unicode_init(void) {
    if (s_byte_unicode_inited) return;

    /* The "self-mapping" bytes. */
    int  bs_buf[256];
    int  cs_buf[256];
    int  n_self = 0;
    int  n_synth = 0;

    for (int i = 33; i <= 126; i++) { bs_buf[n_self] = i; cs_buf[n_self] = i; n_self++; }
    for (int i = 161; i <= 172; i++) { bs_buf[n_self] = i; cs_buf[n_self] = i; n_self++; }
    for (int i = 174; i <= 255; i++) { bs_buf[n_self] = i; cs_buf[n_self] = i; n_self++; }

    /* Remaining bytes get codepoints starting at 256. */
    for (int b = 0; b < 256; b++) {
        int present = 0;
        for (int j = 0; j < n_self; j++) {
            if (bs_buf[j] == b) { present = 1; break; }
        }
        if (!present) {
            bs_buf[n_self + n_synth] = b;
            cs_buf[n_self + n_synth] = 256 + n_synth;
            n_synth++;
        }
    }

    int total = n_self + n_synth; /* should be 256 */
    for (int i = 0; i < total; i++) {
        uint8_t byte = (uint8_t)bs_buf[i];
        uint16_t cp = (uint16_t)cs_buf[i];
        s_byte_to_cp[byte] = cp;
        s_cp_to_byte[s_cp_to_byte_len].cp = cp;
        s_cp_to_byte[s_cp_to_byte_len].byte = byte;
        s_cp_to_byte_len++;
    }

    qsort(s_cp_to_byte, s_cp_to_byte_len, sizeof(codec_cp_byte_t), cp_byte_cmp);
    s_byte_unicode_inited = 1;
}

static int codepoint_to_byte(uint32_t cp) {
    if (!s_byte_unicode_inited) codec_byte_unicode_init();
    if (cp > 0xFFFF) return -1;

    /* Binary search. */
    size_t lo = 0, hi = s_cp_to_byte_len;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (s_cp_to_byte[mid].cp < (uint16_t)cp) lo = mid + 1;
        else hi = mid;
    }
    if (lo < s_cp_to_byte_len && s_cp_to_byte[lo].cp == (uint16_t)cp) {
        return s_cp_to_byte[lo].byte;
    }
    return -1;
}

/* ── UTF-8 codepoint reader ─────────────────────────────────────────────── */
/* Returns number of bytes consumed (1..4) or 0 on invalid input.
 * On invalid input, *out_cp is set to U+FFFD. */
static int utf8_read_codepoint(const char *s, size_t avail, uint32_t *out_cp) {
    if (avail == 0) { *out_cp = 0xFFFD; return 0; }
    uint8_t b0 = (uint8_t)s[0];

    if ((b0 & 0x80) == 0) { *out_cp = b0; return 1; }
    if ((b0 & 0xE0) == 0xC0) {
        if (avail < 2) { *out_cp = 0xFFFD; return 0; }
        uint8_t b1 = (uint8_t)s[1];
        if ((b1 & 0xC0) != 0x80) { *out_cp = 0xFFFD; return 0; }
        *out_cp = ((uint32_t)(b0 & 0x1F) << 6) | (uint32_t)(b1 & 0x3F);
        return 2;
    }
    if ((b0 & 0xF0) == 0xE0) {
        if (avail < 3) { *out_cp = 0xFFFD; return 0; }
        uint8_t b1 = (uint8_t)s[1], b2 = (uint8_t)s[2];
        if (((b1 & 0xC0) != 0x80) || ((b2 & 0xC0) != 0x80)) { *out_cp = 0xFFFD; return 0; }
        *out_cp = ((uint32_t)(b0 & 0x0F) << 12)
                | ((uint32_t)(b1 & 0x3F) << 6)
                |  (uint32_t)(b2 & 0x3F);
        return 3;
    }
    if ((b0 & 0xF8) == 0xF0) {
        if (avail < 4) { *out_cp = 0xFFFD; return 0; }
        uint8_t b1 = (uint8_t)s[1], b2 = (uint8_t)s[2], b3 = (uint8_t)s[3];
        if (((b1 & 0xC0) != 0x80) || ((b2 & 0xC0) != 0x80) || ((b3 & 0xC0) != 0x80)) {
            *out_cp = 0xFFFD; return 0;
        }
        *out_cp = ((uint32_t)(b0 & 0x07) << 18)
                | ((uint32_t)(b1 & 0x3F) << 12)
                | ((uint32_t)(b2 & 0x3F) << 6)
                |  (uint32_t)(b3 & 0x3F);
        return 4;
    }
    *out_cp = 0xFFFD;
    return 0;
}

int codec_utf8_seq_len(uint8_t lead) {
    if ((lead & 0x80) == 0x00) return 1;
    if ((lead & 0xE0) == 0xC0) return 2;
    if ((lead & 0xF0) == 0xE0) return 3;
    if ((lead & 0xF8) == 0xF0) return 4;
    return 0;
}

static size_t utf8_encode_codepoint(uint32_t cp, uint8_t out[4]) {
    if (cp <= 0x7F) { out[0] = (uint8_t)cp; return 1; }
    if (cp <= 0x7FF) {
        out[0] = (uint8_t)(0xC0 | (cp >> 6));
        out[1] = (uint8_t)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp <= 0xFFFF) {
        out[0] = (uint8_t)(0xE0 | (cp >> 12));
        out[1] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F));
        out[2] = (uint8_t)(0x80 | (cp & 0x3F));
        return 3;
    }
    out[0] = (uint8_t)(0xF0 | (cp >> 18));
    out[1] = (uint8_t)(0x80 | ((cp >> 12) & 0x3F));
    out[2] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F));
    out[3] = (uint8_t)(0x80 | (cp & 0x3F));
    return 4;
}

/* ── decode a byte-level BPE token to raw bytes ─────────────────────────── */
/*
 * Each codepoint of `raw` is mapped back to a byte via the GPT-2 reverse
 * table. Codepoints not in the table emit their UTF-8 bytes (defensive —
 * shouldn't happen for valid vocab keys).
 *
 * Returns a newly-malloced buffer; caller frees with free().
 * On failure returns NULL with *out_len set to 0.
 */
char *codec_decode_byte_level_token(const char *raw, size_t raw_len, size_t *out_len) {
    if (!s_byte_unicode_inited) codec_byte_unicode_init();

    /* Worst case: every codepoint is outside the GPT-2 table and emits up
     * to 4 UTF-8 bytes. In practice the result is much smaller. */
    uint8_t *buf = (uint8_t *)malloc(raw_len * 4 + 1);
    if (!buf) { *out_len = 0; return NULL; }
    size_t buf_len = 0;
    size_t i = 0;

    while (i < raw_len) {
        uint32_t cp;
        int n = utf8_read_codepoint(raw + i, raw_len - i, &cp);
        if (n == 0) { /* invalid input — bail */ free(buf); *out_len = 0; return NULL; }
        i += (size_t)n;

        int b = codepoint_to_byte(cp);
        if (b >= 0) {
            buf[buf_len++] = (uint8_t)b;
        } else {
            /* Emit the codepoint as UTF-8 bytes. */
            uint8_t tmp[4];
            size_t tn = utf8_encode_codepoint(cp, tmp);
            for (size_t k = 0; k < tn; k++) buf[buf_len++] = tmp[k];
        }
    }
    buf[buf_len] = 0;
    *out_len = buf_len;
    return (char *)buf;
}

/* Inverse of codec_decode_byte_level_token: take raw input bytes (UTF-8
 * text), map each byte through the GPT-2 byte→unicode table, and emit
 * the resulting codepoints as UTF-8. The output is the form used for
 * BPE vocab keys (Ġworld, etc.).
 *
 * Each input byte produces a 1-3 byte UTF-8 sequence (codepoints are
 * ≤ U+0142). Worst-case output size is 3 * input_len + 1.
 *
 * Returns malloc'd buffer or NULL.
 */
char *codec_encode_byte_level(const uint8_t *bytes, size_t bytes_len, size_t *out_len) {
    if (!s_byte_unicode_inited) codec_byte_unicode_init();

    uint8_t *buf = (uint8_t *)malloc(bytes_len * 3 + 1);
    if (!buf) { *out_len = 0; return NULL; }
    size_t buf_len = 0;
    for (size_t i = 0; i < bytes_len; i++) {
        uint32_t cp = (uint32_t)s_byte_to_cp[bytes[i]];
        uint8_t tmp[4];
        size_t tn = utf8_encode_codepoint(cp, tmp);
        for (size_t k = 0; k < tn; k++) buf[buf_len++] = tmp[k];
    }
    buf[buf_len] = 0;
    *out_len = buf_len;
    return (char *)buf;
}

/* ── Hex helpers for SHA-256 ────────────────────────────────────────────── */

int codec_hex_to_byte(char hi, char lo) {
    int h, l;
    if      (hi >= '0' && hi <= '9') h = hi - '0';
    else if (hi >= 'a' && hi <= 'f') h = hi - 'a' + 10;
    else if (hi >= 'A' && hi <= 'F') h = hi - 'A' + 10;
    else return -1;
    if      (lo >= '0' && lo <= '9') l = lo - '0';
    else if (lo >= 'a' && lo <= 'f') l = lo - 'a' + 10;
    else if (lo >= 'A' && lo <= 'F') l = lo - 'A' + 10;
    else return -1;
    return (h << 4) | l;
}

void codec_bytes_to_hex(const uint8_t *bytes, size_t len, char *hex_out) {
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        hex_out[i * 2]     = digits[bytes[i] >> 4];
        hex_out[i * 2 + 1] = digits[bytes[i] & 0x0F];
    }
    hex_out[len * 2] = 0;
}

/* ── Frame init/destroy ─────────────────────────────────────────────────── */

void codec_frame_init(codec_frame_t *frame) {
    if (!frame) return;
    frame->ids = NULL;
    frame->ids_len = 0;
    frame->done = false;
    frame->finish_reason = NULL;
}

void codec_frame_destroy(codec_frame_t *frame) {
    if (!frame) return;
    free(frame->ids);
    free(frame->finish_reason);
    codec_frame_init(frame);
}
