/* SPDX-License-Identifier: MIT
 *
 * Pre-tokenizer program runtime — C99 port.
 *
 * Mirrors @codecai/web/src/pretok-program.ts and codecai's
 * pretok_program.py. Executes a `pre_tokenizer_program` (see
 * spec/PRETOKENIZER_PROGRAM.md) against UTF-8 input, producing the
 * same sequence of pieces a Unicode-regex engine would produce for the
 * equivalent `pre_tokenizer_pattern`. The Unicode class queries go
 * through the generated tables in codec_unicode_tables.c — no regex,
 * no PCRE2.
 *
 * The program comes from the JSON map's `pre_tokenizer_program` field,
 * parsed by map.c. The internal representation is a list of opaque
 * `codec_pretok_op_t` structures; this file owns the matchers and the
 * per-op switch.
 *
 * Memory model: pieces are returned as a freshly-allocated array of
 * (offset, length) pairs into the caller's input buffer. The caller
 * reads slices via `input + piece.off` for `piece.len` bytes; no
 * string copies happen during pre-tokenization. Frees the pieces array
 * with codec_pretok_free_pieces().
 */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stdlib.h>
#include <string.h>

/* ── UTF-8 decode at offset i, returning code point + byte length ────────── */

/* Returns 1 on success and fills *out_cp / *out_len. Returns 0 on
 * malformed UTF-8 (caller should treat as one-byte advance). */
static int decode_utf8_cp(const uint8_t *s, size_t n, size_t i,
                          uint32_t *out_cp, size_t *out_len) {
    if (i >= n) return 0;
    uint8_t lead = s[i];
    if (lead < 0x80) {
        *out_cp = lead;
        *out_len = 1;
        return 1;
    }
    int cont;
    uint32_t cp;
    if ((lead & 0xE0) == 0xC0)      { cont = 1; cp = lead & 0x1F; }
    else if ((lead & 0xF0) == 0xE0) { cont = 2; cp = lead & 0x0F; }
    else if ((lead & 0xF8) == 0xF0) { cont = 3; cp = lead & 0x07; }
    else return 0;
    if (i + 1 + (size_t)cont > n) return 0;
    for (int k = 0; k < cont; k++) {
        uint8_t b = s[i + 1 + (size_t)k];
        if ((b & 0xC0) != 0x80) return 0;
        cp = (cp << 6) | (b & 0x3F);
    }
    *out_cp  = cp;
    *out_len = (size_t)(1 + cont);
    return 1;
}

/* ── Pieces buffer ───────────────────────────────────────────────────────── */

typedef struct codec_pretok_pieces {
    codec_pretok_piece_t *items;
    size_t                count;
    size_t                cap;
} codec_pretok_pieces_t;

static int pieces_push(codec_pretok_pieces_t *p, size_t off, size_t len) {
    if (len == 0) return 1; /* skip empty pieces */
    if (p->count == p->cap) {
        size_t newcap = p->cap ? p->cap * 2 : 16;
        codec_pretok_piece_t *grow =
            (codec_pretok_piece_t *)realloc(p->items, newcap * sizeof(*grow));
        if (!grow) return 0;
        p->items = grow;
        p->cap   = newcap;
    }
    p->items[p->count].off = off;
    p->items[p->count].len = len;
    p->count++;
    return 1;
}

void codec_pretok_free_pieces(codec_pretok_piece_t *pieces) {
    free(pieces);
}

/* ── Per-op matchers ─────────────────────────────────────────────────────── */

/* Returns the number of bytes consumed at offset i, or 0 if no match. */

static size_t match_literals_ci(const codec_pretok_op_t *op,
                                const uint8_t *s, size_t n, size_t i) {
    /* Scan all patterns and pick the longest match. The contraction
     * lists are tiny (typically 7 entries) so a quadratic scan is fine. */
    size_t best = 0;
    for (size_t k = 0; k < op->u.literals_ci.count; k++) {
        const char *p = op->u.literals_ci.patterns[k];
        size_t plen = strlen(p);
        if (plen <= best || i + plen > n) continue;
        size_t m;
        for (m = 0; m < plen; m++) {
            uint8_t a = s[i + m];
            uint8_t b = (uint8_t)p[m];
            if (a == b) continue;
            /* ASCII case fold; pretok contraction lists are always ASCII. */
            if (a >= 'A' && a <= 'Z' && (uint8_t)(a + 32) == b) continue;
            if (a >= 'a' && a <= 'z' && (uint8_t)(a - 32) == b) continue;
            break;
        }
        if (m == plen) best = plen;
    }
    return best;
}

static size_t match_letters(const codec_pretok_op_t *op,
                            const uint8_t *s, size_t n, size_t i) {
    /* `[^\r\n\p{L}\p{N}]?\p{L}+` (lead_other), or `\p{L}+`. */
    size_t p = i;
    if (op->u.letters.lead_other) {
        uint32_t cp; size_t cplen;
        if (decode_utf8_cp(s, n, p, &cp, &cplen)
            && cp != '\r' && cp != '\n'
            && !codec_unicode_is_letter(cp)
            && !codec_unicode_is_number(cp)) {
            p += cplen;
        }
    }
    size_t run_start = p;
    while (p < n) {
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, n, p, &cp, &cplen)) break;
        if (!codec_unicode_is_letter(cp)) break;
        p += cplen;
    }
    if (p == run_start) return 0;  /* lead-only match doesn't count */
    return p - i;
}

static size_t match_numbers(const codec_pretok_op_t *op,
                            const uint8_t *s, size_t n, size_t i) {
    /* `\p{N}+` if max_run==0; `\p{N}{1,K}` otherwise. Note: max_run==1
     * is the Qwen-style "one digit per piece" semantics. */
    size_t p = i;
    size_t count = 0;
    uint32_t max_run = op->u.numbers.max_run;
    while (p < n && (max_run == 0 || count < max_run)) {
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, n, p, &cp, &cplen)) break;
        if (!codec_unicode_is_number(cp)) break;
        p += cplen;
        count++;
    }
    return p - i;
}

static size_t match_punct_run(const codec_pretok_op_t *op,
                              const uint8_t *s, size_t n, size_t i) {
    /* ` ?[^\s\p{L}\p{N}]+[\r\n]*` — lead_space and trailing_newlines toggleable. */
    size_t p = i;
    if (op->u.punct_run.lead_space && p < n && s[p] == ' ') {
        p++;
    }
    size_t run_start = p;
    while (p < n) {
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, n, p, &cp, &cplen)) break;
        if (codec_unicode_is_ws(cp)
            || codec_unicode_is_letter(cp)
            || codec_unicode_is_number(cp)) break;
        p += cplen;
    }
    if (p == run_start) return 0;  /* lead space alone doesn't count */
    if (op->u.punct_run.trailing_newlines) {
        while (p < n && (s[p] == '\n' || s[p] == '\r')) p++;
    }
    return p - i;
}

static size_t match_newline_block(const codec_pretok_op_t *op,
                                  const uint8_t *s, size_t n, size_t i) {
    (void)op;
    /* `\s*[\r\n]+` — whitespace run that must contain at least one
     * newline; the match ends on the last newline of the run. */
    size_t p = i;
    while (p < n) {
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, n, p, &cp, &cplen)) break;
        if (!codec_unicode_is_ws(cp)) break;
        p += cplen;
    }
    if (p == i) return 0;
    /* Find first newline within the run. */
    ptrdiff_t first_nl = -1;
    for (size_t q = i; q < p; q++) {
        if (s[q] == '\n' || s[q] == '\r') { first_nl = (ptrdiff_t)q; break; }
    }
    if (first_nl < 0) return 0;
    /* Trim back trailing non-newline whitespace. */
    size_t q = p;
    while (q > (size_t)first_nl && !(s[q - 1] == '\n' || s[q - 1] == '\r')) q--;
    return q - i;
}

static size_t match_trailing_ws(const codec_pretok_op_t *op,
                                const uint8_t *s, size_t n, size_t i) {
    (void)op;
    /* `\s+(?!\S)` with regex backtracking semantics. See TS interpreter
     * for the derivation. Match length:
     *   run reaches EOI                          → whole run
     *   run ends at non-whitespace               → run minus last cp
     *   single-cp run followed by non-whitespace → 0
     */
    size_t p = i;
    size_t last_cp_start = i;
    while (p < n) {
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, n, p, &cp, &cplen)) break;
        if (!codec_unicode_is_ws(cp)) break;
        last_cp_start = p;
        p += cplen;
    }
    if (p == i) return 0;
    if (p == n) return p - i;
    /* Followed by non-whitespace — truncate before the final ws cp. */
    return last_cp_start - i;
}

static size_t match_ws_run(const codec_pretok_op_t *op,
                           const uint8_t *s, size_t n, size_t i) {
    (void)op;
    size_t p = i;
    while (p < n) {
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, n, p, &cp, &cplen)) break;
        if (!codec_unicode_is_ws(cp)) break;
        p += cplen;
    }
    return p - i;
}

/* ── Metaspace shortcut (single-op programs) ─────────────────────────────── */

/* Metaspace splits whitespace runs and prefixes ▁ (U+2581 = 0xE2 0x96 0x81)
 * to each non-empty piece. Unlike the GPT-2-family case, pieces here are
 * not slices of the input — they're prefixed strings. We allocate them
 * separately and store their pointers in a side buffer. The piece
 * struct's `off` field then becomes an index into that side buffer
 * (with a sentinel `len == 0` and a flag elsewhere — but for simplicity
 * we keep the pieces as offsets into a single concatenated buffer that
 * the caller frees with codec_pretok_free_metaspace_pieces).
 *
 * Practically, libcodec's BPE encoder is the only metaspace consumer
 * we care about today, and it can call `codec_pretok_run_metaspace`
 * directly to get the prefixed pieces as a fresh string array. So we
 * keep that helper separate and don't try to share the offset-based
 * pieces representation with metaspace.
 */

#define METASPACE_BYTES "\xe2\x96\x81"  /* U+2581 */
#define METASPACE_LEN   3

codec_status_t codec_pretok_run_metaspace(
    const uint8_t *input, size_t input_len,
    int prefix_first,
    char ***out_pieces, size_t *out_count)
{
    /* Walk the input; whitespace runs become boundaries. Each non-ws
     * run becomes one piece. Prefix the metaspace bytes to each piece
     * (or skip the prefix on the first piece if prefix_first set). */
    if (!input || !out_pieces || !out_count) return CODEC_ERR_INVALID_ARG;

    char **pieces = NULL;
    size_t count = 0, cap = 0;

    size_t i = 0;
    int is_first = 1;
    while (i < input_len) {
        /* Advance past any leading whitespace. */
        size_t ws_end = i;
        while (ws_end < input_len) {
            uint32_t cp; size_t cplen;
            if (!decode_utf8_cp(input, input_len, ws_end, &cp, &cplen)) break;
            if (!codec_unicode_is_ws(cp)) break;
            ws_end += cplen;
        }
        if (ws_end > i) is_first = 0;
        i = ws_end;
        if (i >= input_len) break;

        /* Capture the next non-ws run. */
        size_t word_start = i;
        while (i < input_len) {
            uint32_t cp; size_t cplen;
            if (!decode_utf8_cp(input, input_len, i, &cp, &cplen)) break;
            if (codec_unicode_is_ws(cp)) break;
            i += cplen;
        }
        size_t word_len = i - word_start;
        if (word_len == 0) break;

        size_t piece_len = (prefix_first && is_first) ? word_len
                                                       : word_len + METASPACE_LEN;
        char *piece = (char *)malloc(piece_len + 1);
        if (!piece) goto oom;
        size_t off = 0;
        if (!(prefix_first && is_first)) {
            memcpy(piece, METASPACE_BYTES, METASPACE_LEN);
            off += METASPACE_LEN;
        }
        memcpy(piece + off, input + word_start, word_len);
        piece[piece_len] = '\0';

        if (count == cap) {
            size_t newcap = cap ? cap * 2 : 16;
            char **grow = (char **)realloc(pieces, newcap * sizeof(*grow));
            if (!grow) { free(piece); goto oom; }
            pieces = grow;
            cap    = newcap;
        }
        pieces[count++] = piece;
        is_first = 0;
    }

    *out_pieces = pieces;
    *out_count  = count;
    return CODEC_OK;

oom:
    for (size_t k = 0; k < count; k++) free(pieces[k]);
    free(pieces);
    return CODEC_ERR_OUT_OF_MEMORY;
}

void codec_pretok_free_metaspace_pieces(char **pieces, size_t count) {
    if (!pieces) return;
    for (size_t k = 0; k < count; k++) free(pieces[k]);
    free(pieces);
}

/* ── Public entry point: run a program and return offset/length pieces ── */

codec_status_t codec_pretok_run_program(
    const codec_pretok_program_t *prog,
    const uint8_t *input, size_t input_len,
    codec_pretok_piece_t **out_pieces, size_t *out_count)
{
    if (!prog || !input || !out_pieces || !out_count) return CODEC_ERR_INVALID_ARG;

    /* Metaspace single-op programs are handled by the dedicated helper.
     * The offset-based piece representation doesn't apply to them. */
    if (prog->op_count == 1 && prog->ops[0].kind == CODEC_PRETOK_METASPACE_SPLIT) {
        return CODEC_ERR_INVALID_ARG;  /* caller must use codec_pretok_run_metaspace */
    }

    codec_pretok_pieces_t out = {0};
    size_t i = 0;
    while (i < input_len) {
        int matched = 0;
        for (size_t k = 0; k < prog->op_count; k++) {
            const codec_pretok_op_t *op = &prog->ops[k];
            size_t span = 0;
            switch (op->kind) {
                case CODEC_PRETOK_LITERALS_CI:   span = match_literals_ci(op, input, input_len, i); break;
                case CODEC_PRETOK_LETTERS:       span = match_letters(op, input, input_len, i); break;
                case CODEC_PRETOK_NUMBERS:       span = match_numbers(op, input, input_len, i); break;
                case CODEC_PRETOK_PUNCT_RUN:     span = match_punct_run(op, input, input_len, i); break;
                case CODEC_PRETOK_NEWLINE_BLOCK: span = match_newline_block(op, input, input_len, i); break;
                case CODEC_PRETOK_TRAILING_WS:   span = match_trailing_ws(op, input, input_len, i); break;
                case CODEC_PRETOK_WS_RUN:        span = match_ws_run(op, input, input_len, i); break;
                case CODEC_PRETOK_METASPACE_SPLIT: continue;  /* mixed programs invalid */
            }
            if (span > 0) {
                if (!pieces_push(&out, i, span)) {
                    free(out.items);
                    return CODEC_ERR_OUT_OF_MEMORY;
                }
                i += span;
                matched = 1;
                break;
            }
        }
        if (!matched) {
            /* Defensive fallback: well-formed programs end with ws_run,
             * so any input character will match something. If nothing
             * does, advance by one UTF-8 code point to make progress. */
            uint32_t cp; size_t cplen;
            if (!decode_utf8_cp(input, input_len, i, &cp, &cplen)) cplen = 1;
            if (!pieces_push(&out, i, cplen)) {
                free(out.items);
                return CODEC_ERR_OUT_OF_MEMORY;
            }
            i += cplen;
        }
    }

    *out_pieces = out.items;
    *out_count  = out.count;
    return CODEC_OK;
}
