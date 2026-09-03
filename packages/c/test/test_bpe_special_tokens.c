/* SPDX-License-Identifier: MIT
 *
 * Special-token pre-scan tests.
 *
 * Covers the gap described in the C BPE encoder's algorithm step 0:
 * a special token (declared in `special_tokens`, or a `vocab` key
 * shaped like a `<|...|>` delimiter) must be sliced out of the input
 * and emitted as its atomic vocab ID before pre-tokenization/BPE runs,
 * exactly mirroring `packages/web/src/bpe.ts`'s `encode()`. Two
 * synthetic maps:
 *
 *   1. A byte_level map (extends test_bpe.c's "hello world!" fixture)
 *      covering: an exact special-token match, a special embedded
 *      between plain-text spans, back-to-back specials, the
 *      declared-`special_tokens`-beats-`vocab` priority rule, the
 *      vocab-key delimiter-shape fallback, longest-match-wins when one
 *      special token is a byte-for-byte prefix of another, and a
 *      no-match baseline proving plain text is untouched.
 *
 *   2. A metaspace map covering the interaction with the
 *      `prefix_first` prepend scheme: the leading synthetic ▁ must
 *      apply only to the span that opens the whole `encode()` call,
 *      not to every span after a special-token boundary. No currently
 *      published metaspace map ships a `pre_tokenizer_program`, so
 *      this path isn't reachable by any real map today; the test
 *      exists so the threading stays correct if/when one does.
 */
#include "codec/codec.h"
#include "codec_test.h"

#include <stdlib.h>
#include <string.h>

/* ── Byte_level fixture ───────────────────────────────────────────────── */
/*
 * Vocab covers "hello world!" (same ladder as test_bpe.c) plus:
 *   - "<|im_start|>": 20, declared in special_tokens only.
 *   - "<|dup|>": declared as 21 in special_tokens AND 22 in vocab, to
 *     prove special_tokens wins.
 *   - "<|zz|>": 23, in vocab only (no special_tokens entry): picked up
 *     by the delimiter-shape fallback scan.
 *   - "<foo>": 24 and "<foo>bar": 26, both in special_tokens, where
 *     the first is a byte-for-byte prefix of the second: proves
 *     longest-match-wins.
 */
static const char SYN_MAP[] =
"{"
"  \"id\": \"test/synth-bpe-specials\","
"  \"version\": \"2\","
"  \"vocab_size\": 30,"
"  \"vocab\": {"
"    \"h\": 0, \"e\": 1, \"l\": 2, \"o\": 3,"
"    \"w\": 4, \"r\": 5, \"d\": 6,"
"    \"\\u0120\": 7,"            /* Ġ */
"    \"!\": 8,"
"    \"he\": 9, \"hel\": 10, \"hell\": 11, \"hello\": 12,"
"    \"wo\": 13, \"wor\": 14, \"worl\": 15, \"world\": 16,"
"    \"\\u0120world\": 17,"     /* Ġworld */
"    \"<|dup|>\": 22,"
"    \"<|zz|>\": 23"
"  },"
"  \"encoder\": \"byte_level\","
"  \"merges\": ["
"    \"h e\","
"    \"he l\","
"    \"hel l\","
"    \"hell o\","
"    \"w o\","
"    \"wo r\","
"    \"wor l\","
"    \"worl d\","
"    \"\\u0120 world\""
"  ],"
"  \"special_tokens\": {"
"    \"<|im_start|>\": 20,"
"    \"<|dup|>\": 21,"
"    \"<foo>\": 24,"
"    \"<foo>bar\": 26"
"  },"
"  \"pre_tokenizer_program\": {"
"    \"version\": 1,"
"    \"ops\": ["
"      { \"op\": \"literals_ci\", \"patterns\": [\"'s\"] },"
"      { \"op\": \"letters\", \"lead_other\": true },"
"      { \"op\": \"numbers\", \"max_run\": 1 },"
"      { \"op\": \"punct_run\", \"lead_space\": true, \"trailing_newlines\": true },"
"      { \"op\": \"newline_block\" },"
"      { \"op\": \"trailing_ws\" },"
"      { \"op\": \"ws_run\" }"
"    ]"
"  }"
"}";

static codec_tokenizer_map_t *load_synth(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(SYN_MAP, sizeof(SYN_MAP) - 1, &m), CODEC_OK);
    return m;
}

static void encode_expect(codec_bpe_encoder_t *enc, const char *text,
                          const uint32_t *want, size_t want_n) {
    uint32_t *ids = NULL;
    size_t    n = 0;
    CT_EQ_INT(codec_bpe_encode(enc, text, strlen(text), &ids, &n), CODEC_OK);
    CT_EQ_SZ(n, want_n);
    size_t check_n = n < want_n ? n : want_n;
    for (size_t i = 0; i < check_n; i++) {
        CT_EQ_INT(ids[i], want[i]);
    }
    free(ids);
}

static void test_exact_special_alone(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);

    const uint32_t want[] = { 20 };
    encode_expect(enc, "<|im_start|>", want, 1);

    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

static void test_special_between_plain_spans(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);

    /* Leading and trailing special, plain text in between. Also proves
     * a special token repeated later in the same input is matched
     * again (the trie is stateless across positions). */
    const uint32_t want[] = { 20, 12, 17, 8, 20 };
    encode_expect(enc, "<|im_start|>hello world!<|im_start|>", want, 5);

    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

static void test_adjacent_specials_and_priority(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);

    /* Two specials back-to-back: no plain-text span, and no spurious
     * empty-chunk work, between them. "<|dup|>" must resolve to its
     * special_tokens id (21), not its vocab id (22): declared
     * special_tokens takes priority, mirroring bpe.ts's
     * `if (specialIds.has(tok)) continue;` when scanning vocab. */
    const uint32_t want[] = { 20, 21 };
    encode_expect(enc, "<|im_start|><|dup|>", want, 2);

    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

static void test_vocab_delimiter_shape_fallback(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);

    /* "<|zz|>" is declared only in `vocab`, never in `special_tokens`.
     * The delimiter-shape fallback must still catch it. */
    const uint32_t want[] = { 23 };
    encode_expect(enc, "<|zz|>", want, 1);

    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

static void test_longest_match_wins_on_prefix_overlap(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);

    /* "<foo>" is a byte-for-byte prefix of "<foo>bar". When the input
     * actually contains the longer string, it must win over the
     * shorter one whose match also starts there. */
    const uint32_t want_long[] = { 26 };
    encode_expect(enc, "<foo>bar", want_long, 1);

    /* When the input diverges from the longer candidate partway
     * through, the walk must fall back to the shorter match rather
     * than matching nothing. The trailing "baz" bytes aren't in this
     * tiny vocab, so they contribute no further ids. */
    const uint32_t want_short[] = { 24 };
    encode_expect(enc, "<foo>baz", want_short, 1);

    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

static void test_plain_text_unaffected(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);

    /* Regression guard: a map with special tokens declared still
     * encodes ordinary text (that contains none of them) exactly as
     * it did before the pre-scan existed. */
    const uint32_t want[] = { 12, 17, 8 };
    encode_expect(enc, "hello world!", want, 3);

    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

/* ── Metaspace fixture: is_first_chunk threading ─────────────────────── */
/*
 * Vocab: "hi" and "hello" as whole words, each with a synthetic-▁-prefixed
 * counterpart. `prefix_first: false` is configured, meaning (per
 * codec_pretok_run_metaspace's own bookkeeping) the metaspace splitter
 * always adds its ▁ prefix to a word that doesn't follow real
 * whitespace. That "always add" behavior must apply only to the span
 * that opens the whole encode(): every later span (after a special
 * token) must fall back to the plain, no-synthesis per-word ▁ behavior,
 * exactly as packages/web/src/bpe.ts's `isFirstChunk` does.
 */
static const char SYN_METASPACE_MAP[] =
"{"
"  \"id\": \"test/synth-metaspace-specials\","
"  \"version\": \"2\","
"  \"vocab_size\": 13,"
"  \"vocab\": {"
"    \"h\": 0, \"e\": 1, \"l\": 2, \"o\": 3, \"i\": 4,"
"    \"he\": 5, \"hel\": 6, \"hell\": 7, \"hello\": 8,"
"    \"hi\": 9,"
"    \"\\u2581hi\": 10,"
"    \"\\u2581hello\": 11"
"  },"
"  \"encoder\": \"metaspace\","
"  \"merges\": ["
"    \"h e\","
"    \"he l\","
"    \"hel l\","
"    \"hell o\","
"    \"h i\","
"    \"\\u2581 hi\","
"    \"\\u2581 hello\""
"  ],"
"  \"special_tokens\": {"
"    \"<|s|>\": 12"
"  },"
"  \"pre_tokenizer_program\": {"
"    \"version\": 1,"
"    \"ops\": ["
"      { \"op\": \"metaspace_split\", \"prefix_first\": false }"
"    ]"
"  }"
"}";

static codec_tokenizer_map_t *load_synth_metaspace(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(SYN_METASPACE_MAP, sizeof(SYN_METASPACE_MAP) - 1, &m), CODEC_OK);
    return m;
}

static void test_metaspace_prepend_baseline(void) {
    codec_tokenizer_map_t *m = load_synth_metaspace();
    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);

    /* No special token in play: the sole span is the first (and only)
     * chunk of the whole encode, so the configured prefix_first=false
     * ("always add") applies: "hi" -> "▁hi" (id 10), "hello" -> "▁hello"
     * (id 11). This just proves the fixture's vocab/merge ladder is
     * wired correctly before trusting the multi-chunk test below. */
    const uint32_t want_hi[] = { 10 };
    encode_expect(enc, "hi", want_hi, 1);

    const uint32_t want_hello[] = { 11 };
    encode_expect(enc, "hello", want_hello, 1);

    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

static void test_metaspace_prepend_only_on_first_chunk(void) {
    codec_tokenizer_map_t *m = load_synth_metaspace();
    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);

    /* "hi" opens the whole encode: it gets the configured "always add"
     * prepend, same as the baseline above, giving "▁hi" (id 10). The
     * special token in the middle must not reset that: "hello" is a
     * later span, so it must fall back to plain per-word ▁ behavior
     * (no synthesis), landing on the bare "hello" (id 8) rather than
     * "▁hello" (id 11). A regression that re-applies the configured
     * prefix_first to every span would produce id 11 here instead. */
    const uint32_t want[] = { 10, 12, 8 };
    encode_expect(enc, "hi<|s|>hello", want, 3);

    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

int main(void) {
    CT_RUN(test_exact_special_alone);
    CT_RUN(test_special_between_plain_spans);
    CT_RUN(test_adjacent_specials_and_priority);
    CT_RUN(test_vocab_delimiter_shape_fallback);
    CT_RUN(test_longest_match_wins_on_prefix_overlap);
    CT_RUN(test_plain_text_unaffected);
    CT_RUN(test_metaspace_prepend_baseline);
    CT_RUN(test_metaspace_prepend_only_on_first_chunk);
    CT_DONE();
}
