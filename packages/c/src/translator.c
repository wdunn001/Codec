/* SPDX-License-Identifier: MIT
 *
 * Translator: cross-vocab agent-handoff pipe.
 *
 * Mirrors @codecai/web's Translator, codecai's Translator, and
 * Codec.Net's Translator. Pipeline:
 *
 *     ids_A → Detokenizer(V_A) → utf8 → BPETokenizer(V_B) → ids_B
 *
 * The text intermediate exists only inside the translator's address
 * space: it never enters a wire frame. Agent-to-agent traffic still
 * carries only token IDs.
 *
 * Streaming model: BPE merges depend on context. Re-tokenizing a
 * partial word produces different IDs than re-tokenizing the complete
 * word. So we buffer text until a safe boundary (whitespace, since
 * pre-tokenizers always split there) before flushing through BPE.
 * Callers pass partial=1 for streaming chunks; partial=0 (or finish())
 * on the last chunk drains the buffer.
 */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

struct codec_translator {
    codec_detokenizer_t *from_detok;
    codec_bpe_encoder_t *to_enc;

    /* Text buffer accumulating output of the source detokenizer until a
     * safe boundary is reached. Owned. */
    char  *text_buf;
    size_t text_len;
    size_t text_cap;
};

/* ── Lifecycle ─────────────────────────────────────────────────────────── */

codec_status_t codec_translator_new(const codec_tokenizer_map_t *from_map,
                                    const codec_tokenizer_map_t *to_map,
                                    codec_translator_t **out) {
    if (!from_map || !to_map || !out) return CODEC_ERR_INVALID_ARG;

    codec_translator_t *tr = (codec_translator_t *)calloc(1, sizeof(*tr));
    if (!tr) return CODEC_ERR_OUT_OF_MEMORY;

    codec_status_t st = codec_detokenizer_new(from_map, &tr->from_detok);
    if (st != CODEC_OK) { free(tr); return st; }

    st = codec_bpe_encoder_new(to_map, &tr->to_enc);
    if (st != CODEC_OK) {
        codec_detokenizer_free(tr->from_detok);
        free(tr);
        return st;
    }

    *out = tr;
    return CODEC_OK;
}

void codec_translator_free(codec_translator_t *tr) {
    if (!tr) return;
    codec_detokenizer_free(tr->from_detok);
    codec_bpe_encoder_free(tr->to_enc);
    free(tr->text_buf);
    free(tr);
}

void codec_translator_reset(codec_translator_t *tr) {
    if (!tr) return;
    codec_detokenizer_reset(tr->from_detok);
    tr->text_len = 0;
}

/* ── Text buffer + safe-boundary scan ──────────────────────────────────── */

static codec_status_t buf_reserve(codec_translator_t *tr, size_t need) {
    if (need <= tr->text_cap) return CODEC_OK;
    size_t cap = tr->text_cap ? tr->text_cap : 256;
    while (cap < need) cap *= 2;
    char *p = (char *)realloc(tr->text_buf, cap);
    if (!p) return CODEC_ERR_OUT_OF_MEMORY;
    tr->text_buf = p;
    tr->text_cap = cap;
    return CODEC_OK;
}

static codec_status_t buf_append(codec_translator_t *tr,
                                  const char *bytes, size_t len) {
    codec_status_t st = buf_reserve(tr, tr->text_len + len);
    if (st != CODEC_OK) return st;
    memcpy(tr->text_buf + tr->text_len, bytes, len);
    tr->text_len += len;
    return CODEC_OK;
}

/* Scan backward through the buffer for the last byte position that's
 * the END of a whitespace UTF-8 code point, returning the byte index
 * just after that whitespace. If no whitespace is found, return 0
 * (nothing safe to flush yet: keep buffering).
 *
 * The whitespace set mirrors the other Translator implementations:
 * ASCII whitespace + the common Unicode whitespace block (U+00A0,
 * U+2028, U+2029, U+3000). We re-decode UTF-8 backwards by walking
 * forward: slower for huge buffers but tiny under the streaming
 * chunk sizes the Translator actually sees. */
static int is_ws_cp(uint32_t cp) {
    return cp == 0x20 || cp == 0x09 || cp == 0x0A || cp == 0x0D
        || cp == 0x0B || cp == 0x0C
        || cp == 0x00A0 || cp == 0x2028 || cp == 0x2029 || cp == 0x3000;
}

static size_t find_last_safe_boundary(const char *buf, size_t len) {
    /* Forward-scan, remember the byte position just after each
     * whitespace code point we see. Return the last one found. */
    size_t safe = 0;
    size_t i = 0;
    while (i < len) {
        uint8_t lead = (uint8_t)buf[i];
        size_t cp_len;
        uint32_t cp;
        if (lead < 0x80)               { cp = lead; cp_len = 1; }
        else if ((lead & 0xE0) == 0xC0) { cp = lead & 0x1F; cp_len = 2; }
        else if ((lead & 0xF0) == 0xE0) { cp = lead & 0x0F; cp_len = 3; }
        else if ((lead & 0xF8) == 0xF0) { cp = lead & 0x07; cp_len = 4; }
        else                            { i++; continue; }
        if (i + cp_len > len) break;
        for (size_t k = 1; k < cp_len; k++)
            cp = (cp << 6) | ((uint8_t)buf[i + k] & 0x3F);
        if (is_ws_cp(cp)) safe = i + cp_len;
        i += cp_len;
    }
    return safe;
}

/* ── Public translate ──────────────────────────────────────────────────── */

codec_status_t codec_translator_translate(
    codec_translator_t *tr,
    const uint32_t *ids, size_t ids_count,
    int partial,
    uint32_t **out_ids, size_t *out_count)
{
    if (!tr || !out_ids || !out_count) return CODEC_ERR_INVALID_ARG;
    if (!ids && ids_count > 0) return CODEC_ERR_INVALID_ARG;
    *out_ids = NULL;
    *out_count = 0;

    /* Step 1: render source IDs through the source detokenizer with the
     * same partial flag: the detokenizer handles partial UTF-8
     * sequences across chunk boundaries for us. */
    if (ids_count > 0) {
        char  *text = NULL;
        size_t text_len = 0;
        codec_detokenize_opts_t opts = { (bool)partial, false };
        codec_status_t st = codec_detokenizer_render(
            tr->from_detok, ids, ids_count, opts, &text, &text_len);
        if (st != CODEC_OK) return st;

        if (text_len > 0) {
            st = buf_append(tr, text, text_len);
            free(text);
            if (st != CODEC_OK) return st;
        } else {
            free(text);
        }
    }

    /* Step 2: pick a flush window. */
    size_t flush_len;
    if (!partial) {
        /* Final chunk: drain everything. */
        flush_len = tr->text_len;
    } else {
        /* Streaming chunk: flush only up to the last whitespace. */
        flush_len = find_last_safe_boundary(tr->text_buf, tr->text_len);
        if (flush_len == 0) {
            /* Nothing safe to flush: keep buffering. */
            return CODEC_OK;
        }
    }
    if (flush_len == 0) return CODEC_OK;

    /* Step 3: encode the flush window through the target tokenizer. */
    codec_status_t st = codec_bpe_encode(tr->to_enc, tr->text_buf, flush_len,
                                         out_ids, out_count);
    if (st != CODEC_OK) return st;

    /* Step 4: shift the buffer left, dropping flushed bytes. */
    size_t remaining = tr->text_len - flush_len;
    if (remaining > 0) {
        memmove(tr->text_buf, tr->text_buf + flush_len, remaining);
    }
    tr->text_len = remaining;
    return CODEC_OK;
}

codec_status_t codec_translator_finish(codec_translator_t *tr,
                                       uint32_t **out_ids, size_t *out_count) {
    return codec_translator_translate(tr, NULL, 0, 0, out_ids, out_count);
}
