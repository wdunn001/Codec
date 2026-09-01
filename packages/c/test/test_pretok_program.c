/* SPDX-License-Identifier: MIT
 *
 * Pre-tokenizer program runtime tests.
 *
 * Mirrors packages/web/test/pretok-program.test.ts and verifies the C
 * runtime produces the same pieces as the TS reference does for the
 * same Qwen-2 / Llama-3 op programs over the same stress inputs.
 *
 * Programs are constructed in-code (since map-side parsing of
 * pre_tokenizer_program lands in a follow-up alongside BPE).
 */
#include "codec/codec.h"
#include "codec_test.h"

#include <stdlib.h>
#include <string.h>

/* ── Helpers to build a Qwen-style or Llama-3-style program in-code ───── */

/* Pattern lists are owned by the test; the program's literals_ci op
 * borrows them. Lifetime: stack: programs do NOT outlive the test fn. */
static const char *CONTRACTIONS[] = {
    "'s", "'t", "'re", "'ve", "'m", "'ll", "'d",
};

static codec_pretok_program_t make_qwen_like(uint32_t numbers_max_run) {
    static codec_pretok_op_t ops[7];

    ops[0].kind = CODEC_PRETOK_LITERALS_CI;
    ops[0].u.literals_ci.patterns = (char **)CONTRACTIONS;
    ops[0].u.literals_ci.count    = sizeof(CONTRACTIONS) / sizeof(CONTRACTIONS[0]);

    ops[1].kind = CODEC_PRETOK_LETTERS;
    ops[1].u.letters.lead_other = 1;

    ops[2].kind = CODEC_PRETOK_NUMBERS;
    ops[2].u.numbers.max_run = numbers_max_run;

    ops[3].kind = CODEC_PRETOK_PUNCT_RUN;
    ops[3].u.punct_run.lead_space        = 1;
    ops[3].u.punct_run.trailing_newlines = 1;

    ops[4].kind = CODEC_PRETOK_NEWLINE_BLOCK;
    ops[5].kind = CODEC_PRETOK_TRAILING_WS;
    ops[6].kind = CODEC_PRETOK_WS_RUN;

    codec_pretok_program_t prog = {
        .version  = 1,
        .ops      = ops,
        .op_count = 7,
    };
    return prog;
}

/* Compare runtime output to an expected list of UTF-8 piece strings. */
static int pieces_match_strings(const uint8_t *input,
                                const codec_pretok_piece_t *pieces, size_t n,
                                const char **expected, size_t expected_n) {
    if (n != expected_n) {
        fprintf(stderr, "  piece count mismatch: got %zu, expected %zu\n",
                n, expected_n);
        for (size_t i = 0; i < n; i++) {
            fprintf(stderr, "    got[%zu] = \"%.*s\" (len=%zu)\n",
                    i, (int)pieces[i].len, input + pieces[i].off, pieces[i].len);
        }
        return 0;
    }
    for (size_t i = 0; i < n; i++) {
        size_t elen = strlen(expected[i]);
        if (pieces[i].len != elen
            || memcmp(input + pieces[i].off, expected[i], elen) != 0) {
            fprintf(stderr, "  piece[%zu]: got \"%.*s\" (len=%zu), "
                            "expected \"%s\" (len=%zu)\n",
                    i, (int)pieces[i].len, input + pieces[i].off, pieces[i].len,
                    expected[i], elen);
            return 0;
        }
    }
    return 1;
}

#define ASSERT_PIECES(prog, input, ...) do {                               \
    const char *expected[] = { __VA_ARGS__ };                              \
    size_t expected_n = sizeof(expected) / sizeof(expected[0]);            \
    const uint8_t *in = (const uint8_t *)(input);                          \
    size_t in_len = strlen((const char *)(input));                         \
    codec_pretok_piece_t *pieces = NULL; size_t pcount = 0;                \
    codec_status_t r = codec_pretok_run_program(&(prog), in, in_len,       \
                                                &pieces, &pcount);         \
    CT_EQ_INT(r, CODEC_OK);                                                \
    CT_TRUE(pieces_match_strings(in, pieces, pcount, expected, expected_n));\
    codec_pretok_free_pieces(pieces);                                      \
} while (0)

/* ── Tests ──────────────────────────────────────────────────────────────── */

static void test_simple_ascii_sentence(void) {
    /* "Hello world!" → ["Hello", " world", "!"] (Qwen-style, max_run=1) */
    codec_pretok_program_t prog = make_qwen_like(1);
    ASSERT_PIECES(prog, "Hello world!", "Hello", " world", "!");
}

static void test_contractions_case_insensitive(void) {
    codec_pretok_program_t prog = make_qwen_like(1);
    /* "It's" → ["It", "'s"] */
    ASSERT_PIECES(prog, "It's", "It", "'s");
    /* "It'S" → ["It", "'S"] (case-insensitive match preserves casing) */
    ASSERT_PIECES(prog, "It'S", "It", "'S");
}

static void test_qwen_digits_one_per_piece(void) {
    /* Qwen regex is `\p{N}` (no quantifier) → one digit per piece. */
    codec_pretok_program_t prog = make_qwen_like(1);
    ASSERT_PIECES(prog, "abc12345",
                  "abc", "1", "2", "3", "4", "5");
}

static void test_llama3_digits_max_run_3(void) {
    codec_pretok_program_t prog = make_qwen_like(3);
    /* "12345" with max_run=3 → ["123", "45"] */
    ASSERT_PIECES(prog, "12345", "123", "45");
}

static void test_punct_run_with_trailing_newline(void) {
    codec_pretok_program_t prog = make_qwen_like(1);
    /* "hi !!!\n" → ["hi", " !!!\n"] */
    ASSERT_PIECES(prog, "hi !!!\n", "hi", " !!!\n");
}

static void test_trailing_ws_at_eoi(void) {
    codec_pretok_program_t prog = make_qwen_like(1);
    /* "hi   " → ["hi", "   "] (trailing_ws matches whole run at EOI) */
    ASSERT_PIECES(prog, "hi   ", "hi", "   ");
}

static void test_leading_ws_then_word(void) {
    codec_pretok_program_t prog = make_qwen_like(1);
    /* "   leading spaces" → ["  ", " leading", " spaces"]
     * trailing_ws matches "  " (run minus last cp before "l"),
     * then letters w/ lead_space matches " leading", then " spaces". */
    ASSERT_PIECES(prog, "   leading spaces",
                  "  ", " leading", " spaces");
}

static void test_emoji_and_cjk_as_letters(void) {
    /* CJK ideographs are \p{L}o → letters op matches the whole run. */
    codec_pretok_program_t prog = make_qwen_like(1);
    ASSERT_PIECES(prog, "\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e",
                  "\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e");
}

static void test_metaspace_split(void) {
    /* Single-op metaspace program: runs through codec_pretok_run_metaspace,
     * NOT codec_pretok_run_program. */
    char **pieces = NULL; size_t count = 0;
    codec_status_t r = codec_pretok_run_metaspace(
        (const uint8_t *)"Hello world", 11, /*prefix_first=*/0,
        &pieces, &count);
    CT_EQ_INT(r, CODEC_OK);
    CT_EQ_SZ(count, 2);
    /* "Hello" prefixed with U+2581 = 0xE2 0x96 0x81 */
    CT_EQ_STR(pieces[0], "\xe2\x96\x81Hello");
    CT_EQ_STR(pieces[1], "\xe2\x96\x81world");
    codec_pretok_free_metaspace_pieces(pieces, count);
}

static void test_metaspace_prefix_first_skips_first(void) {
    char **pieces = NULL; size_t count = 0;
    codec_status_t r = codec_pretok_run_metaspace(
        (const uint8_t *)"Hello world", 11, /*prefix_first=*/1,
        &pieces, &count);
    CT_EQ_INT(r, CODEC_OK);
    CT_EQ_SZ(count, 2);
    CT_EQ_STR(pieces[0], "Hello");                         /* unprefixed */
    CT_EQ_STR(pieces[1], "\xe2\x96\x81world");             /* prefixed */
    codec_pretok_free_metaspace_pieces(pieces, count);
}

/* The Unicode class predicates (codec_unicode_is_letter/_number/_ws)
 * are internal: exercised indirectly by every match_* op below. The
 * letters / numbers / ws_run tests would fail loudly if the tables
 * were broken. */

int main(void) {
    CT_RUN(test_simple_ascii_sentence);
    CT_RUN(test_contractions_case_insensitive);
    CT_RUN(test_qwen_digits_one_per_piece);
    CT_RUN(test_llama3_digits_max_run_3);
    CT_RUN(test_punct_run_with_trailing_newline);
    CT_RUN(test_trailing_ws_at_eoi);
    CT_RUN(test_leading_ws_then_word);
    CT_RUN(test_emoji_and_cjk_as_letters);
    CT_RUN(test_metaspace_split);
    CT_RUN(test_metaspace_prefix_first_skips_first);
    CT_DONE();
}
