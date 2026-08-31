/* Detokenizer tests: tiny v1 fixture, mirror @codecai/web's tests. */
#include "codec/codec.h"
#include "codec_test.h"

/* Tiny v1 map: 270 IDs total, byte fallback at 10 to 265, two specials at 266/267. */
static const char TINY_MAP_JSON[] =
"{"
"  \"id\": \"test-tiny-v1\","
"  \"version\": \"1.0.0\","
"  \"vocab_size\": 270,"
"  \"tokens\": {"
"    \"0\": \"\\uFFFD\","
"    \"1\": \"h\","
"    \"2\": \"he\","
"    \"3\": \"hello\","
"    \"4\": \" \","
"    \"5\": \"world\","
"    \"6\": \"w\","
"    \"7\": \"wor\","
"    \"8\": \"!\","
"    \"9\": \"\\n\""
"  },"
"  \"special_tokens\": { \"eos\": 266, \"bos\": 267 },"
"  \"byte_fallback_start\": 10,"
"  \"byte_fallback_end\": 265"
"}";

#define BYTE_ID(b) (10 + (b))

static codec_tokenizer_map_t *load_tiny(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(TINY_MAP_JSON, sizeof(TINY_MAP_JSON) - 1, &m), CODEC_OK);
    CT_TRUE(m != NULL);
    return m;
}

static char *render_one(codec_tokenizer_map_t *m, const uint32_t *ids, size_t n,
                        bool partial, bool render_special) {
    codec_detokenizer_t *d = NULL;
    CT_EQ_INT(codec_detokenizer_new(m, &d), CODEC_OK);
    char *s = NULL;
    size_t slen = 0;
    codec_detokenize_opts_t opts = { partial, render_special };
    CT_EQ_INT(codec_detokenizer_render(d, ids, n, opts, &s, &slen), CODEC_OK);
    codec_detokenizer_free(d);
    return s;
}

static void test_simple_vocab(void) {
    codec_tokenizer_map_t *m = load_tiny();
    uint32_t ids[] = { 3, 4, 5, 8 };
    char *s = render_one(m, ids, 4, false, false);
    CT_EQ_STR(s, "hello world!");
    free(s);
    codec_map_free(m);
}

static void test_skips_specials(void) {
    codec_tokenizer_map_t *m = load_tiny();
    uint32_t ids[] = { 267, 3, 4, 5, 266 };
    char *s = render_one(m, ids, 5, false, false);
    CT_EQ_STR(s, "hello world");
    free(s);
    codec_map_free(m);
}

static void test_byte_fallback_3_byte(void) {
    /* € = E2 82 AC */
    codec_tokenizer_map_t *m = load_tiny();
    uint32_t ids[] = { BYTE_ID(0xE2), BYTE_ID(0x82), BYTE_ID(0xAC) };
    char *s = render_one(m, ids, 3, false, false);
    CT_EQ_STR(s, "\xE2\x82\xAC");
    free(s);
    codec_map_free(m);
}

static void test_byte_fallback_4_byte_emoji(void) {
    /* 🚀 = F0 9F 9A 80 */
    codec_tokenizer_map_t *m = load_tiny();
    uint32_t ids[] = { BYTE_ID(0xF0), BYTE_ID(0x9F), BYTE_ID(0x9A), BYTE_ID(0x80) };
    char *s = render_one(m, ids, 4, false, false);
    CT_EQ_STR(s, "\xF0\x9F\x9A\x80");
    free(s);
    codec_map_free(m);
}

static void test_partial_buffered_across_calls(void) {
    codec_tokenizer_map_t *m = load_tiny();
    codec_detokenizer_t *d = NULL;
    CT_EQ_INT(codec_detokenizer_new(m, &d), CODEC_OK);

    /* First two bytes of €: incomplete, must not emit. */
    uint32_t step1[] = { BYTE_ID(0xE2), BYTE_ID(0x82) };
    char *s1 = NULL; size_t s1_len = 0;
    codec_detokenize_opts_t partial = { true, false };
    CT_EQ_INT(codec_detokenizer_render(d, step1, 2, partial, &s1, &s1_len), CODEC_OK);
    CT_EQ_SZ(s1_len, 0);
    free(s1);

    uint32_t step2[] = { BYTE_ID(0xAC) };
    char *s2 = NULL; size_t s2_len = 0;
    codec_detokenize_opts_t final_opts = { false, false };
    CT_EQ_INT(codec_detokenizer_render(d, step2, 1, final_opts, &s2, &s2_len), CODEC_OK);
    CT_EQ_STR(s2, "\xE2\x82\xAC");
    free(s2);

    codec_detokenizer_free(d);
    codec_map_free(m);
}

static void test_unknown_id_emits_replacement(void) {
    codec_tokenizer_map_t *m = load_tiny();
    uint32_t ids[] = { 99999 };
    char *s = render_one(m, ids, 1, false, false);
    CT_EQ_STR(s, "\xEF\xBF\xBD"); /* U+FFFD */
    free(s);
    codec_map_free(m);
}

static void test_reset_clears_buffer(void) {
    codec_tokenizer_map_t *m = load_tiny();
    codec_detokenizer_t *d = NULL;
    CT_EQ_INT(codec_detokenizer_new(m, &d), CODEC_OK);

    /* Buffer up an incomplete sequence. */
    uint32_t partial_ids[] = { BYTE_ID(0xE2) };
    char *s1 = NULL; size_t s1_len = 0;
    codec_detokenize_opts_t partial = { true, false };
    CT_EQ_INT(codec_detokenizer_render(d, partial_ids, 1, partial, &s1, &s1_len), CODEC_OK);
    free(s1);

    /* Reset should drop the partial bytes. */
    codec_detokenizer_reset(d);

    uint32_t ids[] = { 3 };
    char *s2 = NULL; size_t s2_len = 0;
    codec_detokenize_opts_t opts = { false, false };
    CT_EQ_INT(codec_detokenizer_render(d, ids, 1, opts, &s2, &s2_len), CODEC_OK);
    CT_EQ_STR(s2, "hello");
    free(s2);

    codec_detokenizer_free(d);
    codec_map_free(m);
}

int main(void) {
    CT_RUN(test_simple_vocab);
    CT_RUN(test_skips_specials);
    CT_RUN(test_byte_fallback_3_byte);
    CT_RUN(test_byte_fallback_4_byte_emoji);
    CT_RUN(test_partial_buffered_across_calls);
    CT_RUN(test_unknown_id_emits_replacement);
    CT_RUN(test_reset_clears_buffer);
    CT_DONE();
}
