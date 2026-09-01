/* SPDX-License-Identifier: MIT
 *
 * BPE encoder tests.
 *
 * Two layers:
 *   1. Synthetic byte_level fixture: a tiny hand-built map with vocab,
 *      merges, pre_tokenizer_program. Verifies the merge loop, vocab
 *      lookup, and pretok integration without depending on the real
 *      codec-maps repo.
 *   2. Real Qwen-2 map (skipped unless CODEC_MAPS_QWEN points at the
 *      published map). Round-trips a sentence: text -> encode -> ids
 *      -> detokenize -> text and asserts equality. Bit-identical
 *      tokenization vs HF's reference is verified in the TS / Python
 *      / .NET test suites; here we just verify the C encoder is
 *      consistent with the C detokenizer.
 */
#include "codec/codec.h"
#include "codec_test.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Synthetic map: byte_level, "hello world!" only ────────────────────── */
/*
 * The vocab covers what's needed to encode "hello world!":
 *   - every byte (we'll list a handful explicitly; the rest are
 *     irrelevant since we won't encode them)
 *   - "hello", "world", " world", "!"
 *
 * Merges:
 *   - h e -> he
 *   - he l -> hel
 *   - hel l -> hell
 *   - hell o -> hello
 *   - w o -> wo
 *   - wo r -> wor
 *   - wor l -> worl
 *   - worl d -> world
 *   - Ġ world -> Ġworld   (Ġ is the GPT-2 byte-encoded space)
 */
static const char SYN_MAP[] =
"{"
"  \"id\": \"test/synth-bpe\","
"  \"version\": \"2\","
"  \"vocab_size\": 20,"
"  \"vocab\": {"
"    \"h\": 0, \"e\": 1, \"l\": 2, \"o\": 3,"
"    \"w\": 4, \"r\": 5, \"d\": 6,"
"    \"\\u0120\": 7,"            /* Ġ */
"    \"!\": 8,"
"    \"he\": 9, \"hel\": 10, \"hell\": 11, \"hello\": 12,"
"    \"wo\": 13, \"wor\": 14, \"worl\": 15, \"world\": 16,"
"    \"\\u0120world\": 17"      /* Ġworld */
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

/* ── Synthetic encode tests ────────────────────────────────────────────── */

static void test_encode_hello_world_bang(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);

    /* "hello world!" should pretok to ["hello", " world", "!"]. The first
     * piece byte-level encodes to "hello" (no Ġ since no leading space),
     * which through the merge ladder collapses to vocab token "hello"
     * (id 12). The second piece is " world" → "Ġworld" → merge "Ġ world"
     * → "Ġworld" (id 17). The third piece is "!" → id 8.
     *
     * Expected ids: [12, 17, 8] */
    uint32_t *ids = NULL;
    size_t    n = 0;
    CT_EQ_INT(codec_bpe_encode(enc, "hello world!", 12, &ids, &n), CODEC_OK);
    CT_EQ_SZ(n, 3);
    CT_EQ_INT(ids[0], 12);
    CT_EQ_INT(ids[1], 17);
    CT_EQ_INT(ids[2], 8);

    free(ids);
    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

static void test_encode_empty_input(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_OK);

    uint32_t *ids = NULL;
    size_t    n = 0;
    CT_EQ_INT(codec_bpe_encode(enc, "", 0, &ids, &n), CODEC_OK);
    CT_EQ_SZ(n, 0);
    CT_TRUE(ids == NULL);

    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

static void test_encoder_construction_requires_program(void) {
    /* Same map but with pre_tokenizer_program stripped: encoder
     * construction must fail. We can't easily build that JSON without
     * duplicating a lot. Just verify the error path with a v1-style
     * map that has no encoder, no merges. */
    static const char NO_PROG_MAP[] =
        "{"
        "  \"id\": \"test/no-prog\","
        "  \"version\": \"1.0.0\","
        "  \"vocab_size\": 1,"
        "  \"tokens\": { \"0\": \"hello\" }"
        "}";
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(NO_PROG_MAP, sizeof(NO_PROG_MAP) - 1, &m), CODEC_OK);

    codec_bpe_encoder_t *enc = NULL;
    CT_EQ_INT(codec_bpe_encoder_new(m, &enc), CODEC_ERR_VALIDATION);
    CT_TRUE(enc == NULL);

    codec_map_free(m);
}

/* ── Real Qwen-2 round-trip (skipped without env var) ──────────────────── */

static void test_real_qwen2_round_trip(void) {
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

    /* Construct encoder. If the map doesn't carry a pre_tokenizer_program
     * (older codec-maps snapshots may not), skip cleanly. */
    codec_bpe_encoder_t *enc = NULL;
    codec_status_t st = codec_bpe_encoder_new(m, &enc);
    if (st == CODEC_ERR_VALIDATION) {
        fprintf(stdout, "  (skipped: qwen2 map lacks pre_tokenizer_program; "
                        "regenerate with maps-cli >= 0.3.0)\n");
        codec_map_free(m);
        return;
    }
    CT_EQ_INT(st, CODEC_OK);

    /* Encode → detokenize round trip. We don't assert specific IDs (those
     * are verified bit-identical to HF in TS / Python / .NET); we assert
     * that the C encoder and C detokenizer round-trip the same text. */
    const char *TEXT = "Explain entropy.";
    uint32_t *ids = NULL;
    size_t    n = 0;
    CT_EQ_INT(codec_bpe_encode(enc, TEXT, strlen(TEXT), &ids, &n), CODEC_OK);
    CT_TRUE(n > 0);

    /* Detokenize via the existing detokenizer. */
    codec_detokenizer_t *detok = NULL;
    CT_EQ_INT(codec_detokenizer_new(m, &detok), CODEC_OK);
    char *out = NULL;
    size_t out_len = 0;
    codec_detokenize_opts_t opts = { false, false };
    CT_EQ_INT(codec_detokenizer_render(detok, ids, n, opts, &out, &out_len), CODEC_OK);

    /* The Detokenizer doesn't always include a leading space prefix for
     * every byte_level token. We compare normalized instead: strip any
     * leading whitespace from `out` and compare to TEXT. */
    const char *p = out;
    while (out_len > 0 && (*p == ' ' || *p == '\t')) { p++; out_len--; }
    fprintf(stdout, "  qwen2 round-trip: %zu ids → \"%.*s\"\n",
            n, (int)out_len, p);
    CT_EQ_STR(p, TEXT);

    free(out);
    free(ids);
    codec_detokenizer_free(detok);
    codec_bpe_encoder_free(enc);
    codec_map_free(m);
}

int main(void) {
    CT_RUN(test_encode_hello_world_bang);
    CT_RUN(test_encode_empty_input);
    CT_RUN(test_encoder_construction_requires_program);
    CT_RUN(test_real_qwen2_round_trip);
    CT_DONE();
}
