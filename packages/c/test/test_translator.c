/* SPDX-License-Identifier: MIT
 *
 * Translator tests: mirror packages/web/test/translate.test.ts and
 * packages/python/tests/test_translate.py.
 *
 * Two layers:
 *   1. Synthetic byte_level identity translator built from the same
 *      tiny map test_bpe.c uses. Verifies the pipeline plumbing works
 *      end-to-end without depending on codec-maps.
 *   2. Real Qwen-2 → Qwen-2 identity round-trip (skipped without
 *      CODEC_MAPS_QWEN). Ships text through detokenize -> encode and
 *      asserts the encoded IDs detokenize back to the original text.
 *      The cross-vocab Qwen-2 → Llama-3 case is verified in the TS /
 *      Python / .NET test suites; libcodec self-consistency is
 *      sufficient here.
 */
#include "codec/codec.h"
#include "codec_test.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Same synthetic map as test_bpe.c, copied to keep tests independent. */
static const char SYN_MAP[] =
"{"
"  \"id\": \"test/synth-translator\","
"  \"version\": \"2\","
"  \"vocab_size\": 20,"
"  \"vocab\": {"
"    \"h\": 0, \"e\": 1, \"l\": 2, \"o\": 3,"
"    \"w\": 4, \"r\": 5, \"d\": 6,"
"    \"\\u0120\": 7,"
"    \"!\": 8,"
"    \"he\": 9, \"hel\": 10, \"hell\": 11, \"hello\": 12,"
"    \"wo\": 13, \"wor\": 14, \"worl\": 15, \"world\": 16,"
"    \"\\u0120world\": 17"
"  },"
"  \"encoder\": \"byte_level\","
"  \"merges\": ["
"    \"h e\", \"he l\", \"hel l\", \"hell o\","
"    \"w o\", \"wo r\", \"wor l\", \"worl d\","
"    \"\\u0120 world\""
"  ],"
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

/* ── Synthetic identity round-trip ─────────────────────────────────────── */

static void test_synthetic_identity_round_trip(void) {
    /* Encode "hello world!" through the BPE encoder, then translate the
     * resulting IDs through Translator(synth -> synth). The output IDs
     * must equal the input IDs (identity translation), modulo the fact
     * that BPE re-encoding of the detokenized text might shift slightly
     * for partial words: which doesn't apply here because there's no
     * partial flag. */
    codec_tokenizer_map_t *m = load_synth();

    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);
    uint32_t *src_ids = NULL; size_t src_n = 0;
    CT_EQ_INT(codec_bpe_encode(enc, "hello world!", 12, &src_ids, &src_n), CODEC_OK);
    CT_EQ_SZ(src_n, 3);  /* [hello, Ġworld, !] */
    codec_bpe_encoder_free(enc);

    codec_translator_t *tr = NULL;
    CT_EQ_INT(codec_translator_new(m, m, &tr), CODEC_OK);
    uint32_t *out_ids = NULL; size_t out_n = 0;
    CT_EQ_INT(codec_translator_translate(tr, src_ids, src_n, /*partial=*/0,
                                          &out_ids, &out_n), CODEC_OK);

    CT_EQ_SZ(out_n, src_n);
    for (size_t i = 0; i < src_n; i++) CT_EQ_INT(out_ids[i], src_ids[i]);

    free(out_ids);
    free(src_ids);
    codec_translator_free(tr);
    codec_map_free(m);
}

static void test_streaming_chunks_drain_to_same_text(void) {
    /* Feed source IDs in chunks with partial=1, then finish().
     * The IDs from streaming may differ from one-shot translation
     * because chunk boundaries shift BPE pieces: but the text the
     * concatenated IDs detokenize back to MUST equal the original
     * text. This mirrors the Python test's assertion. */
    codec_tokenizer_map_t *m = load_synth();

    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);
    uint32_t *src_ids = NULL; size_t src_n = 0;
    CT_EQ_INT(codec_bpe_encode(enc, "hello world!", 12, &src_ids, &src_n), CODEC_OK);
    codec_bpe_encoder_free(enc);

    codec_translator_t *tr = NULL;
    CT_EQ_INT(codec_translator_new(m, m, &tr), CODEC_OK);

    /* Accumulate output across all chunks. */
    uint32_t *all = NULL; size_t all_n = 0, all_cap = 0;
    #define APPEND(arr, n) do {                                            \
        if (all_n + (n) > all_cap) {                                       \
            all_cap = (all_cap ? all_cap : 8);                             \
            while (all_n + (n) > all_cap) all_cap *= 2;                    \
            all = (uint32_t *)realloc(all, all_cap * sizeof(uint32_t));    \
        }                                                                  \
        memcpy(all + all_n, (arr), (n) * sizeof(uint32_t));                \
        all_n += (n);                                                      \
    } while (0)

    /* Feed in chunks of 1 ID at a time with partial=1. */
    for (size_t i = 0; i < src_n; i++) {
        uint32_t *chunk = NULL; size_t chunk_n = 0;
        CT_EQ_INT(codec_translator_translate(tr, src_ids + i, 1, /*partial=*/1,
                                              &chunk, &chunk_n), CODEC_OK);
        if (chunk_n > 0) APPEND(chunk, chunk_n);
        free(chunk);
    }

    uint32_t *flush = NULL; size_t flush_n = 0;
    CT_EQ_INT(codec_translator_finish(tr, &flush, &flush_n), CODEC_OK);
    if (flush_n > 0) APPEND(flush, flush_n);
    free(flush);
    #undef APPEND

    CT_TRUE(all_n > 0);

    /* Detokenize the streamed output and compare to the original text. */
    codec_detokenizer_t *detok = NULL;
    CT_EQ_INT(codec_detokenizer_new(m, &detok), CODEC_OK);
    char *rendered = NULL; size_t rendered_len = 0;
    codec_detokenize_opts_t opts = { false, false };
    CT_EQ_INT(codec_detokenizer_render(detok, all, all_n, opts,
                                        &rendered, &rendered_len), CODEC_OK);
    /* Strip leading whitespace as the BPE round-trip can produce one. */
    const char *p = rendered;
    while (rendered_len > 0 && (*p == ' ' || *p == '\t')) {
        p++; rendered_len--;
    }
    CT_EQ_STR(p, "hello world!");

    free(rendered);
    free(all);
    free(src_ids);
    codec_detokenizer_free(detok);
    codec_translator_free(tr);
    codec_map_free(m);
}

static void test_reset_clears_buffer(void) {
    codec_tokenizer_map_t *m = load_synth();

    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);
    uint32_t *src_ids = NULL; size_t src_n = 0;
    CT_EQ_INT(codec_bpe_encode(enc, "hello", 5, &src_ids, &src_n), CODEC_OK);
    codec_bpe_encoder_free(enc);

    codec_translator_t *tr = NULL;
    CT_EQ_INT(codec_translator_new(m, m, &tr), CODEC_OK);

    /* Feed something with partial=1 (nothing drains since no whitespace). */
    uint32_t *out = NULL; size_t out_n = 0;
    CT_EQ_INT(codec_translator_translate(tr, src_ids, src_n, /*partial=*/1,
                                          &out, &out_n), CODEC_OK);
    CT_EQ_SZ(out_n, 0);
    free(out); out = NULL;

    /* Reset clears the buffer. Subsequent finish() returns empty. */
    codec_translator_reset(tr);
    CT_EQ_INT(codec_translator_finish(tr, &out, &out_n), CODEC_OK);
    CT_EQ_SZ(out_n, 0);
    free(out);

    free(src_ids);
    codec_translator_free(tr);
    codec_map_free(m);
}

/* ── Real Qwen-2 round-trip (skipped without env var) ──────────────────── */

static void test_real_qwen2_identity_round_trip(void) {
    const char *path = getenv("CODEC_MAPS_QWEN");
    if (!path || !*path) {
        fprintf(stdout, "  (skipped: set CODEC_MAPS_QWEN to enable)\n");
        return;
    }
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stdout, "  (skipped: could not open %s)\n", path);
        return;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *json = (char *)malloc((size_t)sz);
    if (!json || fread(json, 1, (size_t)sz, f) != (size_t)sz) {
        free(json); fclose(f); CT_FAIL("read failed"); return;
    }
    fclose(f);

    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(json, (size_t)sz, &m), CODEC_OK);
    free(json);

    /* Translator(qwen -> qwen): identity. The IDs in must produce text
     * that, when re-encoded, gives back the same IDs. We don't assert
     * ID equality directly because BPE under the same vocab on the same
     * text is bit-identical, but only if pretokenization splits the
     * round-tripped text identically (which it does for this prompt). */
    codec_bpe_encoder_t *enc = NULL;
    codec_status_t st = codec_bpe_encoder_new(m, &enc);
    if (st == CODEC_ERR_VALIDATION) {
        fprintf(stdout, "  (skipped: qwen2 map lacks pre_tokenizer_program; "
                        "regenerate with maps-cli >= 0.3.0)\n");
        codec_map_free(m);
        return;
    }
    CT_EQ_INT(st, CODEC_OK);

    const char *TEXT = "Explain entropy.";
    uint32_t *src_ids = NULL; size_t src_n = 0;
    CT_EQ_INT(codec_bpe_encode(enc, TEXT, strlen(TEXT), &src_ids, &src_n), CODEC_OK);
    codec_bpe_encoder_free(enc);

    codec_translator_t *tr = NULL;
    CT_EQ_INT(codec_translator_new(m, m, &tr), CODEC_OK);

    uint32_t *out_ids = NULL; size_t out_n = 0;
    CT_EQ_INT(codec_translator_translate(tr, src_ids, src_n, /*partial=*/0,
                                          &out_ids, &out_n), CODEC_OK);
    CT_TRUE(out_n > 0);

    /* Round-trip through the detokenizer to verify text equivalence. */
    codec_detokenizer_t *detok = NULL;
    CT_EQ_INT(codec_detokenizer_new(m, &detok), CODEC_OK);
    char *rendered = NULL; size_t rendered_len = 0;
    codec_detokenize_opts_t opts = { false, false };
    CT_EQ_INT(codec_detokenizer_render(detok, out_ids, out_n, opts,
                                        &rendered, &rendered_len), CODEC_OK);

    /* Strip a possible leading space (byte_level encoding can prefix one). */
    const char *p = rendered;
    while (rendered_len > 0 && (*p == ' ' || *p == '\t')) {
        p++; rendered_len--;
    }
    fprintf(stdout, "  qwen2 identity translate: %zu -> %zu IDs -> \"%.*s\"\n",
            src_n, out_n, (int)rendered_len, p);
    CT_EQ_STR(p, TEXT);

    free(rendered);
    free(out_ids);
    free(src_ids);
    codec_detokenizer_free(detok);
    codec_translator_free(tr);
    codec_map_free(m);
}

int main(void) {
    CT_RUN(test_synthetic_identity_round_trip);
    CT_RUN(test_streaming_chunks_drain_to_same_text);
    CT_RUN(test_reset_clears_buffer);
    CT_RUN(test_real_qwen2_identity_round_trip);
    CT_DONE();
}
