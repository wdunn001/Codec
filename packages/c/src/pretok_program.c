/* SPDX-License-Identifier: MIT
 *
 * Pre-tokenizer program runtime: C99 port.
 *
 * Mirrors @codecai/web/src/pretok-program.ts and codecai's
 * pretok_program.py. Executes a `pre_tokenizer_program` (see
 * spec/PRETOKENIZER_PROGRAM.md) against UTF-8 input, producing the
 * same sequence of pieces a Unicode-regex engine would produce for the
 * equivalent `pre_tokenizer_pattern`. The Unicode class queries go
 * through the generated tables in codec_unicode_tables.c: no regex,
 * no PCRE2.
 *
 * The program comes from the JSON map's `pre_tokenizer_program` field,
 * parsed by map.c. The internal representation is either a flat `ops`
 * list (v1) or an ordered `stages` list (v2); this file owns the
 * matchers, the per-op switch, the per-stage switch, and the v1/v2
 * dispatch in codec_pretok_run_program().
 *
 * Two program shapes:
 *
 *   - v1 (`version == 1`): a single alternation scan over the whole
 *     input, trying every op in `ops` at each cursor position in
 *     priority order.
 *   - v2 (`version == 2`): an ordered list of `stages`. Each stage
 *     transforms every piece the stage before it produced (mirroring
 *     HuggingFace's `Sequence` pre-tokenizer exactly). Required for
 *     SmolLM2, Falcon, DeepSeek-V3 and DeepSeek-R1: see
 *     spec/PRETOKENIZER_PROGRAM.md § Stages (v2).
 *
 * Memory model: every v1 op and every v2 stage (`digits_isolate`,
 * `digit_triples_isolate`, `punctuation_contiguous`, `cjk_isolate`,
 * `alternation`) only ever subdivides an existing contiguous byte range
 * of the caller's input buffer into smaller contiguous, non-overlapping
 * sub-ranges. None of them reorder bytes, insert synthetic bytes, or
 * copy text. The whole v1 AND v2 pipeline therefore runs on
 * (offset, length) pairs into the ORIGINAL input buffer end to end: a
 * v2 program's intermediate piece lists are never materialised as
 * copied strings, only as arrays of (offset, length) pairs, each stage
 * freeing the previous stage's array once it has read every entry.
 * Metaspace is the one exception (see § Metaspace shortcut below): it
 * prepends synthetic bytes (▁), so it needs freshly-allocated strings
 * and is handled by a separate function with a separate memory model,
 * exactly as in v1.
 *
 * The final piece array is caller-owned; free with
 * codec_pretok_free_pieces().
 */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ── UTF-8 decode at offset i, returning code point + byte length ────────── */

/* Returns 1 on success and fills *out_cp / *out_len. Returns 0 on
 * malformed UTF-8 (caller should treat as one-byte advance). `n` is the
 * boundary the decode must not read past: for a v2 stage running on one
 * piece, that is the piece's own end offset, not the whole input
 * buffer's length, so a match never reads across a piece boundary into
 * bytes an earlier stage already routed to a different piece. */
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

/* Decode at `i`, or fall back to a one-byte advance with a code point
 * value ("invalid" sentinel, above every table's range) that every
 * Unicode class predicate reports false for. Used by the v2 stage
 * transforms, which must account for every input byte in their output
 * (unlike the alternation matchers below, which are allowed to just
 * stop a run on invalid UTF-8: a stage transform cannot drop bytes). */
static void decode_cp_or_byte(const uint8_t *s, size_t n, size_t i,
                              uint32_t *out_cp, size_t *out_len) {
    if (!decode_utf8_cp(s, n, i, out_cp, out_len)) {
        *out_cp  = 0xFFFFFFFFu;
        *out_len = 1;
    }
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

/* ── ASCII helpers ───────────────────────────────────────────────────────── */

/* `[!-\/:-@\[-\`{-~]`: the 32 ASCII punctuation chars HuggingFace's
 * is_ascii_punctuation accepts. Shared by punct_ascii_letters and
 * punctuation_contiguous. */
static int is_ascii_punct_byte(uint8_t c) {
    return (c >= '!' && c <= '/')
        || (c >= ':' && c <= '@')
        || (c >= '[' && c <= '`')
        || (c >= '{' && c <= '~');
}

static int is_ascii_digit_byte(uint8_t c) {
    return c >= '0' && c <= '9';
}

static int is_ascii_letter_byte(uint8_t c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

/* DeepSeek-V3's literal CJK ranges: U+4E00-U+9FA5 (its own bound, short
 * of the full CJK Unified Ideographs block at U+9FFF), Hiragana
 * U+3040-U+309F, Katakana U+30A0-U+30FF. Fixed integer comparisons: no
 * property table needed for this one. See
 * spec/PRETOKENIZER_PROGRAM.md § cjk_isolate. */
static int is_cjk_cp(uint32_t cp) {
    return (cp >= 0x4E00 && cp <= 0x9FA5)
        || (cp >= 0x3040 && cp <= 0x309F)
        || (cp >= 0x30A0 && cp <= 0x30FF);
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

/* Case-sensitive counterpart of match_literals_ci: exact-case longest
 * match. Used by the older OpenAI tokenizers (p50k_base, r50k_base) and
 * by ByteLevel(use_regex=true)'s fixed internal op list, which a v2
 * `alternation` stage runs for SmolLM2 and Falcon. */
static size_t match_literals(const codec_pretok_op_t *op,
                             const uint8_t *s, size_t n, size_t i) {
    size_t best = 0;
    for (size_t k = 0; k < op->u.literals.count; k++) {
        const char *p = op->u.literals.patterns[k];
        size_t plen = strlen(p);
        if (plen <= best || i + plen > n) continue;
        if (memcmp(s + i, p, plen) == 0) best = plen;
    }
    return best;
}

static size_t match_letters(const codec_pretok_op_t *op,
                            const uint8_t *s, size_t n, size_t i) {
    /* `[^\r\n\p{L}\p{N}]?\p{L}+` (lead_other, lead_other_class: l_n,
     * default), `[^\r\n\p{L}\p{P}\p{S}]?\p{L}+` (lead_other_class:
     * l_p_s), ` ?\p{L}+` (lead_space), or `\p{L}+` (neither). lead_other
     * and lead_space are mutually exclusive. */
    size_t p = i;
    if (op->u.letters.lead_other) {
        uint32_t cp; size_t cplen;
        if (decode_utf8_cp(s, n, p, &cp, &cplen)
            && cp != '\r' && cp != '\n'
            && !codec_unicode_is_letter(cp)) {
            int excluded;
            if (op->u.letters.lead_other_class == CODEC_PRETOK_LEAD_OTHER_L_P_S) {
                excluded = !codec_unicode_is_punct(cp) && !codec_unicode_is_symbol(cp);
            } else {
                excluded = !codec_unicode_is_number(cp);
            }
            if (excluded) p += cplen;
        }
    } else if (op->u.letters.lead_space) {
        if (p < n && s[p] == ' ') p += 1;
    }
    size_t run_start = p;
    /* `\p{L}+` (default body: L), or `[\p{L}\p{M}]+` (body: L_M). */
    while (p < n) {
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, n, p, &cp, &cplen)) break;
        int body_ok = codec_unicode_is_letter(cp)
            || (op->u.letters.body == CODEC_PRETOK_LETTERS_BODY_L_M
                && codec_unicode_is_mark(cp));
        if (!body_ok) break;
        p += cplen;
    }
    if (p == run_start) return 0;  /* lead-only match doesn't count */
    return p - i;
}

static size_t match_numbers(const codec_pretok_op_t *op,
                            const uint8_t *s, size_t n, size_t i) {
    /* `\p{N}+` if max_run==0; `\p{N}{1,K}` otherwise, each with an
     * optional ` ?` lead_space. Note: max_run==1 is the Qwen-style
     * "one digit per piece" semantics. */
    size_t p = i;
    if (op->u.numbers.lead_space && p < n && s[p] == ' ') p += 1;
    size_t run_start = p;
    size_t count = 0;
    uint32_t max_run = op->u.numbers.max_run;
    while (p < n && (max_run == 0 || count < max_run)) {
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, n, p, &cp, &cplen)) break;
        if (!codec_unicode_is_number(cp)) break;
        p += cplen;
        count++;
    }
    if (p == run_start) return 0;  /* lead space alone doesn't count */
    return p - i;
}

static size_t match_punct_run(const codec_pretok_op_t *op,
                              const uint8_t *s, size_t n, size_t i) {
    /* ` ?[^\s\p{L}\p{N}]+[\r\n]*` (default charset: not_ws_L_N), or
     * ` ?[\p{P}\p{S}]+[\r\n]*` (charset: p_s). lead_space and
     * trailing_newlines toggle independently of charset. */
    size_t p = i;
    if (op->u.punct_run.lead_space && p < n && s[p] == ' ') {
        p++;
    }
    size_t run_start = p;
    while (p < n) {
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, n, p, &cp, &cplen)) break;
        int in_run;
        if (op->u.punct_run.charset == CODEC_PRETOK_PUNCT_CHARSET_P_S) {
            in_run = codec_unicode_is_punct(cp) || codec_unicode_is_symbol(cp);
        } else {
            in_run = !codec_unicode_is_ws(cp)
                  && !codec_unicode_is_letter(cp)
                  && !codec_unicode_is_number(cp);
        }
        if (!in_run) break;
        p += cplen;
    }
    if (p == run_start) return 0;  /* lead space alone doesn't count */
    /* Trailing chars: prefer explicit trailing_chars (o200k_base /
     * mistral-nemo / o200k_harmony use "\r\n/"). Fall back to the
     * legacy trailing_newlines boolean -> \r\n. trailing_chars is
     * ASCII-only in every published map, so a plain byte membership
     * scan matches the TS reference's per-character indexOf check. */
    if (op->u.punct_run.trailing_chars) {
        while (p < n && s[p] != 0
               && strchr(op->u.punct_run.trailing_chars, (int)s[p]) != NULL) p++;
    } else if (op->u.punct_run.trailing_newlines) {
        while (p < n && (s[p] == '\n' || s[p] == '\r')) p++;
    }
    return p - i;
}

/* `[!-\/:-@\[-\`{-~][A-Za-z]+`: one ASCII punctuation char, then 1+
 * ASCII letters. DeepSeek-V3's third `Split` stage's FIRST alternative:
 * an apostrophe glued to identifier letters ('m in code like
 * `sys.platform == 'linux'`) comes out as one piece under this op. ASCII
 * punctuation and ASCII letters are always single bytes, so no UTF-8
 * decoding is needed here. */
static size_t match_punct_ascii_letters(const uint8_t *s, size_t n, size_t i) {
    if (i >= n) return 0;
    if (!is_ascii_punct_byte(s[i])) return 0;
    size_t p = i + 1;
    size_t run_start = p;
    while (p < n && is_ascii_letter_byte(s[p])) p++;
    if (p == run_start) return 0;  /* need at least one ASCII letter */
    return p - i;
}

static size_t match_newline_block(const codec_pretok_op_t *op,
                                  const uint8_t *s, size_t n, size_t i) {
    (void)op;
    /* `\s*[\r\n]+`: whitespace run that must contain at least one
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
     * "EOI" here means the boundary `n`: the end of the current v2
     * piece when this runs inside an `alternation` stage, not
     * necessarily the end of the whole input buffer.
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
    /* Followed by non-whitespace: truncate before the final ws cp. */
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

/* Case-boundary letter run: o200k_base, o200k_harmony, mistral-nemo.
 * TITLE matches `[Lu Lt Lm Lo M]* [Ll Lm Lo M]+`; UPPER matches
 * `[Lu Lt Lm Lo M]+ [Ll Lm Lo M]*`. Lm/Lo/M sit in BOTH clusters, so
 * the longest match may need to backtrack one or more chars from the
 * greedy upper-cluster run to let the suffix consume them instead:
 * try the suffix from each prefix length, longest-first, first success
 * wins. This mirrors packages/web/src/pretok-program.ts's
 * matchLettersCased exactly, including its checkpoint/backtrack
 * structure. */
static size_t match_letters_cased(const codec_pretok_op_t *op,
                                  const uint8_t *s, size_t n, size_t i) {
    size_t p = i;
    if (op->u.letters_cased.lead_other) {
        uint32_t cp; size_t cplen;
        if (decode_utf8_cp(s, n, p, &cp, &cplen) && cp != '\r' && cp != '\n'
            && !codec_unicode_is_letter(cp) && !codec_unicode_is_number(cp)) {
            p += cplen;
        }
    }

    /* Greedily consume upper-cluster chars, recording a checkpoint (byte
     * offset) after each one consumed. checkpoints[k] is the position
     * after consuming exactly k upper-cluster chars.
     *
     * This is called at EVERY cursor position the alternation scanner
     * tries, matched or not (see try_ops_at / run_alternation_ops). An
     * earlier version sized this buffer to the entire remaining input
     * (`n - p + 1`) up front on every single call: for a long piece
     * (a full chat turn under a v1 letters_cased program, no earlier
     * v2 stage to shrink it first) that is an O(remaining-length)
     * allocation at O(length) call sites, i.e. quadratic in the piece
     * length, and it dominates runtime long before the underlying
     * upper-cluster run (almost always well under 64 code points in
     * real text) ever gets close to filling it. A small fixed buffer
     * covers every realistic run with zero allocation; the heap
     * fallback below only ever triggers on pathological input (a
     * single word of 64+ consecutive upper-cluster code points). */
    enum { CHECKPOINTS_INLINE_CAP = 64 };
    size_t inline_checkpoints[CHECKPOINTS_INLINE_CAP];
    size_t *checkpoints = inline_checkpoints;
    size_t cap = CHECKPOINTS_INLINE_CAP;
    size_t ncheck = 0;
    checkpoints[ncheck++] = p;
    while (p < n) {
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, n, p, &cp, &cplen)) break;
        if (!codec_unicode_is_letter_cased_upper(cp)) break;
        if (ncheck == cap) {
            size_t new_cap = cap * 2;
            size_t *grown = (size_t *)malloc(new_cap * sizeof(size_t));
            if (!grown) {
                if (checkpoints != inline_checkpoints) free(checkpoints);
                return 0;  /* OOM: report no match rather than crash */
            }
            memcpy(grown, checkpoints, ncheck * sizeof(size_t));
            if (checkpoints != inline_checkpoints) free(checkpoints);
            checkpoints = grown;
            cap = new_cap;
        }
        p += cplen;
        checkpoints[ncheck++] = p;
    }

    int min_prefix = (op->u.letters_cased.kind == CODEC_PRETOK_CASED_UPPER) ? 1 : 0;
    int min_suffix = (op->u.letters_cased.kind == CODEC_PRETOK_CASED_UPPER) ? 0 : 1;

    size_t result = 0;
    for (size_t k = ncheck; k-- > 0; ) {
        if ((int)k < min_prefix) break;
        size_t q = checkpoints[k];
        int suffix_count = 0;
        while (q < n) {
            uint32_t cp; size_t cplen;
            if (!decode_utf8_cp(s, n, q, &cp, &cplen)) break;
            if (!codec_unicode_is_letter_cased_lower(cp)) break;
            q += cplen;
            suffix_count++;
        }
        if (suffix_count < min_suffix) continue;

        /* Optional case-insensitive trailing contractions, longest
         * match wins (same ASCII case-fold semantics as literals_ci). */
        if (op->u.letters_cased.trailing_ci_count > 0) {
            size_t best = 0;
            for (size_t t = 0; t < op->u.letters_cased.trailing_ci_count; t++) {
                const char *pat = op->u.letters_cased.trailing_ci[t];
                size_t plen = strlen(pat);
                if (plen <= best || q + plen > n) continue;
                size_t m;
                for (m = 0; m < plen; m++) {
                    uint8_t a = s[q + m];
                    uint8_t b = (uint8_t)pat[m];
                    if (a == b) continue;
                    if (a >= 'A' && a <= 'Z' && (uint8_t)(a + 32) == b) continue;
                    if (a >= 'a' && a <= 'z' && (uint8_t)(a - 32) == b) continue;
                    break;
                }
                if (m == plen) best = plen;
            }
            q += best;
        }

        result = q - i;
        break;
    }
    if (checkpoints != inline_checkpoints) free(checkpoints);
    return result;
}

/* ── Alternation scanner (v1 whole-program loop, and the v2
 *    `alternation` stage) ────────────────────────────────────────────── */

/* Try every op in `ops`, in priority order, at position `i` (bounded by
 * `n`). Returns the first non-empty match's span, or 0 if none match. */
static size_t try_ops_at(const codec_pretok_op_t *ops, size_t op_count,
                         const uint8_t *s, size_t n, size_t i) {
    for (size_t k = 0; k < op_count; k++) {
        const codec_pretok_op_t *op = &ops[k];
        size_t span = 0;
        switch (op->kind) {
            case CODEC_PRETOK_LITERALS_CI:         span = match_literals_ci(op, s, n, i); break;
            case CODEC_PRETOK_LITERALS:            span = match_literals(op, s, n, i); break;
            case CODEC_PRETOK_LETTERS:             span = match_letters(op, s, n, i); break;
            case CODEC_PRETOK_LETTERS_CASED:       span = match_letters_cased(op, s, n, i); break;
            case CODEC_PRETOK_NUMBERS:             span = match_numbers(op, s, n, i); break;
            case CODEC_PRETOK_PUNCT_RUN:           span = match_punct_run(op, s, n, i); break;
            case CODEC_PRETOK_PUNCT_ASCII_LETTERS: span = match_punct_ascii_letters(s, n, i); break;
            case CODEC_PRETOK_NEWLINE_BLOCK:       span = match_newline_block(op, s, n, i); break;
            case CODEC_PRETOK_TRAILING_WS:         span = match_trailing_ws(op, s, n, i); break;
            case CODEC_PRETOK_WS_RUN:              span = match_ws_run(op, s, n, i); break;
            case CODEC_PRETOK_METASPACE_SPLIT:
                /* Mixed programs aren't legal: metaspace is single-op
                 * (v1) and never appears inside an alternation stage
                 * (v2). Skip. */
                continue;
        }
        if (span > 0) return span;
    }
    return 0;
}

/*
 * Try every op in `ops`, in priority order, at each cursor position from
 * `start` to `end`; consume the first non-empty match and advance, and
 * push (offset, length) pieces into `out`. This is the whole v1
 * program's execution model, and one v2 `alternation` stage's execution
 * model (scoped to a single input piece's [start, end) range rather
 * than the whole original text).
 *
 * When NO op matches at a position, this is `Split(..., Isolated)` GAP
 * behavior: consume the maximal run of consecutive non-matching
 * positions as ONE piece, verbatim, rather than shattering it one
 * Unicode scalar at a time. For a GPT-2-family op list running directly
 * over raw text (v1 programs, and a v2 `alternation` stage that is the
 * program's only stage), this list is exhaustive over every Unicode
 * scalar value and the branch is unreachable. It becomes reachable, and
 * matters, once an earlier v2 stage has already stripped a character
 * class this alternation's ops were never meant to see: DeepSeek-V3's
 * third stage receives whole digit-run and CJK-run pieces from the two
 * stages before it, and its own ops have no digit or CJK branch at all
 * (those stages already isolated them). Shattering such a piece one
 * scalar at a time would turn a three-digit piece "123" into three
 * separate one-digit pieces instead of passing it through untouched:
 * exactly the kind of silent wrong-shaped output this format exists to
 * prevent. See spec/PRETOKENIZER_PROGRAM.md § v2 execution.
 *
 * Returns 0 on allocation failure (caller frees `out->items` itself),
 * 1 on success.
 */
static int run_alternation_ops(const codec_pretok_op_t *ops, size_t op_count,
                               const uint8_t *s, size_t start, size_t end,
                               codec_pretok_pieces_t *out) {
    size_t i = start;
    while (i < end) {
        size_t span = try_ops_at(ops, op_count, s, end, i);
        if (span > 0) {
            if (!pieces_push(out, i, span)) return 0;
            i += span;
            continue;
        }
        uint32_t cp; size_t cplen;
        if (!decode_utf8_cp(s, end, i, &cp, &cplen)) cplen = 1;
        size_t j = i + cplen;
        while (j < end && try_ops_at(ops, op_count, s, end, j) == 0) {
            if (!decode_utf8_cp(s, end, j, &cp, &cplen)) cplen = 1;
            j += cplen;
        }
        if (!pieces_push(out, i, j - i)) return 0;
        i = j;
    }
    return 1;
}

/* ── v2 stage executors ──────────────────────────────────────────────────── */
/*
 * Each stage transforms ONE piece (an [off, off+len) byte range of the
 * shared input buffer) into zero or more sub-pieces, pushed into `out`
 * in left-to-right order. The pipeline driver (codec_pretok_run_program)
 * runs every stage over every piece the stage before it produced,
 * mirroring HuggingFace's `Sequence` pre-tokenizer's flatMap exactly.
 * Returns 0 on allocation failure, 1 on success.
 */

static int stage_digits_isolate(const codec_pretok_stage_t *stage,
                                const uint8_t *s, size_t off, size_t len,
                                codec_pretok_pieces_t *out) {
    size_t end = off + len;
    size_t i  = off;

    size_t buf_start = off; int have_buf = 0; /* pending non-digit run */
    size_t num_start = off; int have_num = 0; /* pending digit run (grouped mode) */
    uint32_t num_count = 0;

    codec_pretok_digits_mode_t mode = stage->u.digits_isolate.mode;
    uint32_t max_run = stage->u.digits_isolate.max_run; /* 0 = unbounded */

    while (i < end) {
        uint32_t cp; size_t cplen;
        decode_cp_or_byte(s, end, i, &cp, &cplen);

        if (codec_unicode_is_number(cp)) {
            if (have_buf) {
                if (!pieces_push(out, buf_start, i - buf_start)) return 0;
                have_buf = 0;
            }
            if (mode == CODEC_PRETOK_DIGITS_INDIVIDUAL) {
                if (!pieces_push(out, i, cplen)) return 0;
            } else {
                if (!have_num) { num_start = i; num_count = 0; have_num = 1; }
                if (max_run > 0 && num_count >= max_run) {
                    if (!pieces_push(out, num_start, i - num_start)) return 0;
                    num_start = i;
                    num_count = 0;
                }
                num_count++;
            }
        } else {
            if (have_num) {
                if (!pieces_push(out, num_start, i - num_start)) return 0;
                have_num = 0;
            }
            if (!have_buf) { buf_start = i; have_buf = 1; }
        }
        i += cplen;
    }
    if (have_num && !pieces_push(out, num_start, end - num_start)) return 0;
    if (have_buf && !pieces_push(out, buf_start, end - buf_start)) return 0;
    return 1;
}

/* HuggingFace `Split("[0-9][0-9][0-9]", Isolated)`: Falcon's fourth
 * stage. Exact non-overlapping windows of 3 ASCII digits, scanned
 * left-to-right; a digit run whose length isn't a multiple of 3 leaves
 * a remainder that stays ungrouped. Deliberately distinct from
 * digits_isolate's max_run, which chunks a whole \p{N} run with no
 * remainder ever left over. ASCII digits are always single bytes, so
 * plain byte indexing is safe here (no UTF-8 decoding needed). */
static int stage_digit_triples_isolate(const uint8_t *s, size_t off, size_t len,
                                       codec_pretok_pieces_t *out) {
    size_t end = off + len;
    size_t last = off;
    size_t i = off;
    while (i + 3 <= end) {
        if (is_ascii_digit_byte(s[i]) && is_ascii_digit_byte(s[i + 1])
            && is_ascii_digit_byte(s[i + 2])) {
            if (i > last && !pieces_push(out, last, i - last)) return 0;
            if (!pieces_push(out, i, 3)) return 0;
            i += 3;
            last = i;
        } else {
            i += 1;
        }
    }
    if (last < end && !pieces_push(out, last, end - last)) return 0;
    return 1;
}

/* HuggingFace `Punctuation(Contiguous)`: Falcon's first stage.
 * Classifies each code point as ASCII-punctuation-or-\p{P} versus
 * everything else, and groups each maximal run of the same
 * classification into one piece. Whitespace and letters share the
 * "everything else" bucket, so a whitespace run stays attached to its
 * adjacent letters here. */
static int stage_punctuation_contiguous(const uint8_t *s, size_t off, size_t len,
                                        codec_pretok_pieces_t *out) {
    size_t end = off + len;
    size_t i = off;

    size_t buf_start = off; int have_buf = 0;
    size_t p_start   = off; int have_p   = 0;

    while (i < end) {
        uint32_t cp; size_t cplen;
        decode_cp_or_byte(s, end, i, &cp, &cplen);
        int is_p = (cp <= 0x7F && is_ascii_punct_byte((uint8_t)cp))
                || codec_unicode_is_punct(cp);
        if (is_p) {
            if (have_buf) {
                if (!pieces_push(out, buf_start, i - buf_start)) return 0;
                have_buf = 0;
            }
            if (!have_p) { p_start = i; have_p = 1; }
        } else {
            if (have_p) {
                if (!pieces_push(out, p_start, i - p_start)) return 0;
                have_p = 0;
            }
            if (!have_buf) { buf_start = i; have_buf = 1; }
        }
        i += cplen;
    }
    if (have_p && !pieces_push(out, p_start, end - p_start)) return 0;
    if (have_buf && !pieces_push(out, buf_start, end - buf_start)) return 0;
    return 1;
}

/* HuggingFace `Split([一-龥぀-ゟ゠-ヿ]+, Isolated)`: DeepSeek-V3's second
 * stage. Isolates maximal runs of the three CJK ranges as their own
 * pieces, so a CJK run never merges with adjacent Latin text or a
 * preceding space. */
static int stage_cjk_isolate(const uint8_t *s, size_t off, size_t len,
                             codec_pretok_pieces_t *out) {
    size_t end = off + len;
    size_t last = off;
    size_t i = off;
    while (i < end) {
        uint32_t cp; size_t cplen;
        decode_cp_or_byte(s, end, i, &cp, &cplen);
        if (is_cjk_cp(cp)) {
            if (i > last && !pieces_push(out, last, i - last)) return 0;
            size_t j = i + cplen;
            while (j < end) {
                uint32_t cp2; size_t cplen2;
                decode_cp_or_byte(s, end, j, &cp2, &cplen2);
                if (!is_cjk_cp(cp2)) break;
                j += cplen2;
            }
            if (!pieces_push(out, i, j - i)) return 0;
            i = j;
            last = j;
        } else {
            i += cplen;
        }
    }
    if (last < end && !pieces_push(out, last, end - last)) return 0;
    return 1;
}

/* Dispatch one v2 stage over one piece. Returns 0 on allocation
 * failure, 1 on success. `stage->kind` is validated at parse time
 * (map.c), so every enumerator is handled; there is no default arm. */
static int run_stage_on_piece(const codec_pretok_stage_t *stage,
                              const uint8_t *s, size_t off, size_t len,
                              codec_pretok_pieces_t *out) {
    switch (stage->kind) {
        case CODEC_PRETOK_STAGE_DIGITS_ISOLATE:
            return stage_digits_isolate(stage, s, off, len, out);
        case CODEC_PRETOK_STAGE_DIGIT_TRIPLES_ISOLATE:
            return stage_digit_triples_isolate(s, off, len, out);
        case CODEC_PRETOK_STAGE_PUNCTUATION_CONTIGUOUS:
            return stage_punctuation_contiguous(s, off, len, out);
        case CODEC_PRETOK_STAGE_CJK_ISOLATE:
            return stage_cjk_isolate(s, off, len, out);
        case CODEC_PRETOK_STAGE_ALTERNATION:
            return run_alternation_ops(stage->u.alternation.ops,
                                       stage->u.alternation.op_count,
                                       s, off, off + len, out);
    }
    return 0;
}

/* ── Metaspace shortcut (single-op programs) ─────────────────────────────── */

/* Metaspace splits whitespace runs and prefixes ▁ (U+2581 = 0xE2 0x96 0x81)
 * to each non-empty piece. Unlike the GPT-2-family case, pieces here are
 * not slices of the input: they're prefixed strings. We allocate them
 * separately and store their pointers in a side buffer. The piece
 * struct's `off` field then becomes an index into that side buffer
 * (with a sentinel `len == 0` and a flag elsewhere: but for simplicity
 * we keep the pieces as offsets into a single concatenated buffer that
 * the caller frees with codec_pretok_free_metaspace_pieces).
 *
 * Practically, libcodec's BPE encoder is the only metaspace consumer
 * we care about today. It can call `codec_pretok_run_metaspace`
 * directly to get the prefixed pieces as a fresh string array. So we
 * keep that helper separate and don't try to share the offset-based
 * pieces representation with metaspace. Metaspace is v1-only and never
 * appears inside a v2 stage: see spec/PRETOKENIZER_PROGRAM.md §
 * metaspace_split.
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

    if (prog->version == 1) {
        /* Metaspace single-op programs are handled by the dedicated
         * helper. The offset-based piece representation doesn't apply
         * to them (they prepend synthetic bytes). */
        if (prog->op_count == 1 && prog->ops[0].kind == CODEC_PRETOK_METASPACE_SPLIT) {
            return CODEC_ERR_INVALID_ARG;  /* caller must use codec_pretok_run_metaspace */
        }
        codec_pretok_pieces_t out = {0};
        if (!run_alternation_ops(prog->ops, prog->op_count, input, 0, input_len, &out)) {
            free(out.items);
            return CODEC_ERR_OUT_OF_MEMORY;
        }
        *out_pieces = out.items;
        *out_count  = out.count;
        return CODEC_OK;
    }

    if (prog->version == 2) {
        /* Start with the whole input as the one and only piece, then run
         * every stage over every piece the stage before it produced:
         * HuggingFace's Sequence pre-tokenizer, exactly. */
        codec_pretok_pieces_t cur = {0};
        if (input_len > 0 && !pieces_push(&cur, 0, input_len)) {
            return CODEC_ERR_OUT_OF_MEMORY;
        }
        for (size_t si = 0; si < prog->stage_count; si++) {
            codec_pretok_pieces_t next = {0};
            for (size_t k = 0; k < cur.count; k++) {
                if (!run_stage_on_piece(&prog->stages[si], input,
                                        cur.items[k].off, cur.items[k].len, &next)) {
                    free(next.items);
                    free(cur.items);
                    return CODEC_ERR_OUT_OF_MEMORY;
                }
            }
            free(cur.items);
            cur = next;
        }
        *out_pieces = cur.items;
        *out_count  = cur.count;
        return CODEC_OK;
    }

    /* Unknown version: refuse to guess at execution semantics. A newer
     * program version may use stage/op kinds this interpreter has never
     * heard of; silently running it as v1 or v2 risks emitting a
     * plausible-looking but wrong split, which is exactly the failure
     * mode this format exists to prevent. See
     * spec/PRETOKENIZER_PROGRAM.md § Versioning. map.c's parser already
     * rejects this at load time; this is a defensive second check for
     * a hand-constructed codec_pretok_program_t. */
    return CODEC_ERR_UNSUPPORTED_PRETOK_VERSION;
}
