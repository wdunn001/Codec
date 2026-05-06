/* codec_tool_watcher tests. Synthetic + real Qwen-2 tool-call sample. */
#include "codec/codec.h"
#include "codec_test.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Synthetic map: minimal, two specials acting as tool-call markers ──── */

static const char SYN_MAP[] =
"{"
"  \"id\": \"test/synth\","
"  \"version\": \"2\","
"  \"vocab_size\": 100,"
"  \"vocab\": {"
"    \"hello\": 0, \"world\": 1, \"!\": 2,"
"    \"foo\": 3, \"bar\": 4"
"  },"
"  \"encoder\": \"byte_level\","
"  \"special_tokens\": {"
"    \"<tool_call>\":  90,"
"    \"</tool_call>\": 91"
"  }"
"}";

#define START_ID 90u
#define END_ID   91u

static codec_tokenizer_map_t *load_synth(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(SYN_MAP, sizeof(SYN_MAP) - 1, &m), CODEC_OK);
    return m;
}

/* ── Special-token name lookup ─────────────────────────────────────────── */

static void test_map_special_id_resolves_by_name(void) {
    codec_tokenizer_map_t *m = load_synth();
    uint32_t id;
    CT_EQ_INT(codec_map_special_id(m, "<tool_call>", &id), CODEC_OK);
    CT_EQ_INT(id, START_ID);
    CT_EQ_INT(codec_map_special_id(m, "</tool_call>", &id), CODEC_OK);
    CT_EQ_INT(id, END_ID);
    CT_EQ_INT(codec_map_special_id(m, "<not_real>", &id), CODEC_ERR_NOT_FOUND);
    codec_map_free(m);
}

/* ── Watcher: basic one-region case ────────────────────────────────────── */

static void test_watcher_passthrough_then_region_then_passthrough(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new(m, "<tool_call>", "</tool_call>", &w), CODEC_OK);

    /* "hello world <tool_call> foo bar </tool_call> hello !" */
    uint32_t ids[] = { 0, 1, START_ID, 3, 4, END_ID, 0, 2 };

    codec_watcher_event_t *evs = NULL;
    size_t n_evs = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, 8, &evs, &n_evs), CODEC_OK);
    CT_EQ_SZ(n_evs, 3);

    /* Event 0: passthrough [0, 1] */
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[0].ids_len, 2);
    CT_EQ_INT(evs[0].ids[0], 0);
    CT_EQ_INT(evs[0].ids[1], 1);

    /* Event 1: region_end [3, 4] (start/end markers excluded) */
    CT_EQ_INT((int)evs[1].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[1].ids_len, 2);
    CT_EQ_INT(evs[1].ids[0], 3);
    CT_EQ_INT(evs[1].ids[1], 4);

    /* Event 2: passthrough [0, 2] */
    CT_EQ_INT((int)evs[2].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[2].ids_len, 2);
    CT_EQ_INT(evs[2].ids[0], 0);
    CT_EQ_INT(evs[2].ids[1], 2);

    CT_TRUE(!codec_tool_watcher_inside(w));
    codec_tool_watcher_free(w);
    codec_map_free(m);
}

/* ── Watcher: region split across multiple feeds ──────────────────────── */

static void test_watcher_region_split_across_feeds(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new(m, "<tool_call>", "</tool_call>", &w), CODEC_OK);

    /* Feed 1: "hello <tool_call> foo" — region opens but doesn't close. */
    uint32_t feed1[] = { 0, START_ID, 3 };
    codec_watcher_event_t *evs;
    size_t n;
    CT_EQ_INT(codec_tool_watcher_feed(w, feed1, 3, &evs, &n), CODEC_OK);
    /* One passthrough event: [0]. No region_end yet. */
    CT_EQ_SZ(n, 1);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[0].ids_len, 1);
    CT_EQ_INT(evs[0].ids[0], 0);
    CT_TRUE(codec_tool_watcher_inside(w));

    /* Feed 2: "bar </tool_call> world" — closes region, then more text. */
    uint32_t feed2[] = { 4, END_ID, 1 };
    CT_EQ_INT(codec_tool_watcher_feed(w, feed2, 3, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 2);

    /* Event 0: region_end with [3, 4] (the foo + bar accumulated across feeds). */
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[0].ids_len, 2);
    CT_EQ_INT(evs[0].ids[0], 3);
    CT_EQ_INT(evs[0].ids[1], 4);

    /* Event 1: passthrough [1] */
    CT_EQ_INT((int)evs[1].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[1].ids_len, 1);
    CT_EQ_INT(evs[1].ids[0], 1);

    CT_TRUE(!codec_tool_watcher_inside(w));
    codec_tool_watcher_free(w);
    codec_map_free(m);
}

/* ── Watcher: multiple regions in one feed ─────────────────────────────── */

static void test_watcher_multiple_regions(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new(m, "<tool_call>", "</tool_call>", &w), CODEC_OK);

    /* Two tool calls back-to-back with text in between. */
    uint32_t ids[] = {
        0,                  /* hello */
        START_ID, 3, END_ID, /* <tool_call> foo </tool_call> */
        1,                  /* world */
        START_ID, 4, END_ID, /* <tool_call> bar </tool_call> */
        2,                  /* ! */
    };
    codec_watcher_event_t *evs;
    size_t n;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, sizeof(ids) / sizeof(ids[0]),
                                       &evs, &n), CODEC_OK);
    /* Expect: passthrough[0] / region[3] / passthrough[1] / region[4] / passthrough[2] */
    CT_EQ_SZ(n, 5);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_INT((int)evs[1].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_INT((int)evs[2].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_INT((int)evs[3].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_INT((int)evs[4].kind, (int)CODEC_WATCH_PASSTHROUGH);

    codec_tool_watcher_free(w);
    codec_map_free(m);
}

/* ── Watcher: stray end marker is passed through ───────────────────────── */

static void test_watcher_stray_end_passes_through(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new(m, "<tool_call>", "</tool_call>", &w), CODEC_OK);

    /* end_id with no preceding start_id — should be treated as ordinary text. */
    uint32_t ids[] = { 0, END_ID, 1 };
    codec_watcher_event_t *evs;
    size_t n;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, 3, &evs, &n), CODEC_OK);
    /* All three IDs in a single passthrough event (the end_id is just a token here). */
    CT_EQ_SZ(n, 1);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[0].ids_len, 3);

    codec_tool_watcher_free(w);
    codec_map_free(m);
}

/* ── Watcher: missing special name returns NOT_FOUND ──────────────────── */

static void test_watcher_missing_name_is_not_found(void) {
    codec_tokenizer_map_t *m = load_synth();
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new(m, "<not_real>", "</tool_call>", &w),
              CODEC_ERR_NOT_FOUND);
    CT_TRUE(w == NULL);
    codec_map_free(m);
}

/* ── Real Qwen-2 sanity check (when codec-maps is mounted) ────────────── */

static void test_watcher_real_qwen2(void) {
    const char *path = getenv("CODEC_MAPS_QWEN");
    if (!path || !*path) {
        fprintf(stdout, "  (skipped — set CODEC_MAPS_QWEN to enable)\n");
        return;
    }
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stdout, "  (skipped — could not open %s)\n", path);
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

    /* Qwen-2 ships <tool_call> at id 151657 and </tool_call> at 151658. */
    uint32_t start_id = 0, end_id = 0;
    CT_EQ_INT(codec_map_special_id(m, "<tool_call>",  &start_id), CODEC_OK);
    CT_EQ_INT(codec_map_special_id(m, "</tool_call>", &end_id),   CODEC_OK);
    CT_EQ_INT(start_id, 151657u);
    CT_EQ_INT(end_id,   151658u);

    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new(m, "<tool_call>", "</tool_call>", &w),
              CODEC_OK);

    /* Synthesize a stream: "Hi" <tool_call> {body} </tool_call> "Done"
     * Specific IDs don't matter here; we only verify the watcher reports
     * the correct sequence of events on a real-vocab map. */
    uint32_t ids[] = { 9707, start_id, 90909, 12345, 67890, end_id, 1101 };
    codec_watcher_event_t *evs;
    size_t n;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, sizeof(ids)/sizeof(ids[0]),
                                       &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 3);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_INT((int)evs[1].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[1].ids_len, 3);  /* the body, markers excluded */
    CT_EQ_INT((int)evs[2].kind, (int)CODEC_WATCH_PASSTHROUGH);

    codec_tool_watcher_free(w);
    codec_map_free(m);
}

int main(void) {
    CT_RUN(test_map_special_id_resolves_by_name);
    CT_RUN(test_watcher_passthrough_then_region_then_passthrough);
    CT_RUN(test_watcher_region_split_across_feeds);
    CT_RUN(test_watcher_multiple_regions);
    CT_RUN(test_watcher_stray_end_passes_through);
    CT_RUN(test_watcher_missing_name_is_not_found);
    CT_RUN(test_watcher_real_qwen2);
    CT_DONE();
}
