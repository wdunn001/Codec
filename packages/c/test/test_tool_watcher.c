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

    /* Feed 1: "hello <tool_call> foo": region opens but doesn't close. */
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

    /* Feed 2: "bar </tool_call> world": closes region, then more text. */
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

    /* end_id with no preceding start_id: should be treated as ordinary text. */
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

/* ── Watcher operates on raw IDs only: never decodes ─────────────────── */
/*
 * This test exists to lock in the contract that codec_tool_watcher does
 * NOT route token IDs through the detokenizer. The watcher is meant to be
 * usable on a map that contains ONLY the start/end specials: no vocab,
 * no merges, no decoder config. If the watcher ever grew an accidental
 * dependency on the vocab (e.g. via codec_map_is_special falling back to
 * a vocab lookup), this test would fail.
 *
 * We construct a map whose `vocab` is empty and whose `vocab_size` is a
 * deliberately small number, then feed the watcher token IDs that are
 * BOTH outside the vocab and above the declared vocab_size. The watcher
 * must still emit the events verbatim: including those bogus IDs: and
 * the captured region body must contain the exact uint32 values we fed,
 * not anything derived from a string round-trip.
 */
static const char NO_VOCAB_MAP[] =
"{"
"  \"id\": \"test/no-vocab\","
"  \"version\": \"2\","
"  \"vocab_size\": 4,"
"  \"vocab\": {},"
"  \"encoder\": \"byte_level\","
"  \"special_tokens\": {"
"    \"<tool_call>\":  90,"
"    \"</tool_call>\": 91"
"  }"
"}";

static void test_watcher_does_not_decode_tokens(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(NO_VOCAB_MAP, sizeof(NO_VOCAB_MAP) - 1, &m),
              CODEC_OK);

    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new(m, "<tool_call>", "</tool_call>", &w),
              CODEC_OK);

    /* IDs deliberately chosen to be:
     *  - outside the (empty) vocab
     *  - above the declared vocab_size of 4
     *  - including UINT32_MAX-adjacent values to catch any accidental
     *    integer-narrowing via a string-decode round-trip
     * If the watcher were decoding, codec_map_id_to_text on these would
     * either fail or return empty: either way, the body verification
     * below would not match. */
    const uint32_t BIG_A = 0xFFFFFF00u;
    const uint32_t BIG_B = 0xDEADBEEFu;
    const uint32_t BIG_C = 0xCAFEBABEu;
    uint32_t ids[] = {
        12345u,                /* passthrough: way out of vocab */
        BIG_A,                 /* passthrough: near uint32 max */
        START_ID,              /* opens region */
        BIG_B,                 /* region body: bogus ID */
        BIG_C,                 /* region body: bogus ID */
        END_ID,                /* closes region */
        99999u,                /* passthrough: out of vocab */
    };

    codec_watcher_event_t *evs;
    size_t n;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, sizeof(ids) / sizeof(ids[0]),
                                      &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 3);

    /* PASSTHROUGH: verbatim copy of the input slice: same uint32 values,
     * no string round-trip, no narrowing. */
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[0].ids_len, 2);
    CT_EQ_INT(evs[0].ids[0], 12345u);
    CT_EQ_INT(evs[0].ids[1], BIG_A);

    /* REGION_END: body IDs preserved bit-for-bit, markers excluded. The
     * fact that BIG_B/BIG_C have no vocab entry is irrelevant: the
     * watcher never asks. */
    CT_EQ_INT((int)evs[1].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[1].ids_len, 2);
    CT_EQ_INT(evs[1].ids[0], BIG_B);
    CT_EQ_INT(evs[1].ids[1], BIG_C);

    /* PASSTHROUGH: trailing IDs after end marker. */
    CT_EQ_INT((int)evs[2].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[2].ids_len, 1);
    CT_EQ_INT(evs[2].ids[0], 99999u);

    /* Additionally: PASSTHROUGH events must point INTO the caller's
     * input buffer (zero-copy contract). Verify the pointer math. */
    CT_TRUE(evs[0].ids == &ids[0]);
    CT_TRUE(evs[2].ids == &ids[6]);

    codec_tool_watcher_free(w);
    codec_map_free(m);
}

/* ── Real Qwen-2 sanity check (when codec-maps is mounted) ────────────── */

static void test_watcher_real_qwen2(void) {
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

    /* Qwen-2 chat-tuned would ship <tool_call> at 151657 / </tool_call>
     * at 151658, BUT some published HF tokenizer.json snapshots mark
     * those tokens with `special: false`, in which case the maps-cli
     * leaves them out of `special_tokens` (they're still in `vocab`).
     * Mirror the Python test's resilience: fall back to a pair that
     * IS guaranteed to be in special_tokens. The watcher is the
     * subject under test here. */
    uint32_t start_id = 0, end_id = 0;
    const char *start_name = "<tool_call>";
    const char *end_name   = "</tool_call>";
    if (codec_map_special_id(m, start_name, &start_id) != CODEC_OK
        || codec_map_special_id(m, end_name, &end_id) != CODEC_OK) {
        start_name = "<|im_start|>";
        end_name   = "<|im_end|>";
        CT_EQ_INT(codec_map_special_id(m, start_name, &start_id), CODEC_OK);
        CT_EQ_INT(codec_map_special_id(m, end_name,   &end_id),   CODEC_OK);
    }

    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new(m, start_name, end_name, &w),
              CODEC_OK);

    /* Synthesize a stream: "Hi" START {body} END "Done"
     * Specific IDs don't matter here; we only verify the watcher
     * reports the correct sequence of events on a real-vocab map. */
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

/* ── Two regions in one feed ────────────────────────────────────────────── */
/*
 * REGION_END events point into the watcher's own region buffer. That
 * buffer was reset and reused at the start of each region. Two regions in
 * one feed therefore produced two events aliasing the same storage. A
 * second region large enough to grow the buffer freed the memory the first
 * event still pointed at. The documented contract is that events stay valid
 * until the next feed call.
 */

static void test_watcher_two_regions_one_feed_keep_distinct_ids(void) {
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(1000, 1001, &w), CODEC_OK);

    /* Region 1 is two ids. Region 2 is large enough to drive the buffer
     * through several reallocs. That relocates it under glibc. */
    enum { BIG = 5000 };
    size_t n = 0;
    uint32_t *ids = (uint32_t *)malloc((size_t)(BIG + 8) * sizeof(uint32_t));
    CT_TRUE(ids != NULL);
    ids[n++] = 1000;
    ids[n++] = 111;
    ids[n++] = 222;
    ids[n++] = 1001;
    ids[n++] = 1000;
    for (int i = 0; i < BIG; i++) ids[n++] = 900000u + (uint32_t)i;
    ids[n++] = 1001;

    codec_watcher_event_t *ev = NULL;
    size_t ev_len = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, n, &ev, &ev_len), CODEC_OK);

    size_t seen = 0;
    for (size_t i = 0; i < ev_len; i++) {
        if (ev[i].kind != CODEC_WATCH_REGION_END) continue;
        if (seen == 0) {
            CT_EQ_SZ(ev[i].ids_len, 2);
            CT_EQ_INT(ev[i].ids[0], 111);
            CT_EQ_INT(ev[i].ids[1], 222);
        } else {
            CT_EQ_SZ(ev[i].ids_len, (size_t)BIG);
            CT_EQ_INT(ev[i].ids[0], 900000u);
            CT_EQ_INT(ev[i].ids[BIG - 1], 900000u + BIG - 1);
        }
        seen++;
    }
    CT_EQ_SZ(seen, 2);

    free(ids);
    codec_tool_watcher_free(w);
}

static void test_watcher_region_across_feeds_still_survives(void) {
    /* The arena must not drop an in-progress region when the next feed
     * starts. */
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(1000, 1001, &w), CODEC_OK);

    uint32_t a[] = { 7, 1000, 41, 42 };
    uint32_t b[] = { 43, 1001, 8 };
    codec_watcher_event_t *ev = NULL;
    size_t ev_len = 0;

    CT_EQ_INT(codec_tool_watcher_feed(w, a, 4, &ev, &ev_len), CODEC_OK);
    CT_TRUE(codec_tool_watcher_inside(w));

    CT_EQ_INT(codec_tool_watcher_feed(w, b, 3, &ev, &ev_len), CODEC_OK);
    size_t seen = 0;
    for (size_t i = 0; i < ev_len; i++) {
        if (ev[i].kind != CODEC_WATCH_REGION_END) continue;
        CT_EQ_SZ(ev[i].ids_len, 3);
        CT_EQ_INT(ev[i].ids[0], 41);
        CT_EQ_INT(ev[i].ids[1], 42);
        CT_EQ_INT(ev[i].ids[2], 43);
        seen++;
    }
    CT_EQ_SZ(seen, 1);
    codec_tool_watcher_free(w);
}

/* ── Truncation: codec_tool_watcher_end() while inside a region ───────── */
/*
 * Defect: an unterminated region (stream ends mid tool-call, e.g. the
 * model hit its length limit) used to be silently dropped: no event, no
 * signal, indistinguishable from a model that never called a tool.
 * codec_tool_watcher_end() must report it.
 */

static void test_watcher_end_emits_truncated_with_finish_reason(void) {
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(1000, 1001, &w), CODEC_OK);

    uint32_t ids[] = { 7, 1000, 41, 42 };
    codec_watcher_event_t *evs = NULL;
    size_t n = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, 4, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 1);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_TRUE(codec_tool_watcher_inside(w));

    CT_EQ_INT(codec_tool_watcher_end(w, "length", &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 1);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_REGION_TRUNCATED);
    CT_EQ_SZ(evs[0].ids_len, 2);
    CT_EQ_INT(evs[0].ids[0], 41);
    CT_EQ_INT(evs[0].ids[1], 42);
    CT_EQ_STR(evs[0].finish_reason, "length");
    CT_TRUE(!codec_tool_watcher_inside(w));

    /* A second end() call is a no-op: nothing left in flight. */
    CT_EQ_INT(codec_tool_watcher_end(w, "length", &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 0);

    codec_tool_watcher_free(w);
}

static void test_watcher_end_reports_empty_body_when_stream_ends_right_after_start(void) {
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(1000, 1001, &w), CODEC_OK);

    uint32_t ids[] = { 1000 };
    codec_watcher_event_t *evs = NULL;
    size_t n = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, 1, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 0);
    CT_TRUE(codec_tool_watcher_inside(w));

    /* No finish_reason known: NULL is a legitimate argument. */
    CT_EQ_INT(codec_tool_watcher_end(w, NULL, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 1);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_REGION_TRUNCATED);
    CT_EQ_SZ(evs[0].ids_len, 0);
    CT_TRUE(evs[0].finish_reason == NULL);

    codec_tool_watcher_free(w);
}

static void test_watcher_end_outside_region_emits_nothing(void) {
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(1000, 1001, &w), CODEC_OK);

    uint32_t ids[] = { 1000, 5, 1001, 6 };
    codec_watcher_event_t *evs = NULL;
    size_t n = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, 4, &evs, &n), CODEC_OK);
    CT_TRUE(!codec_tool_watcher_inside(w));

    CT_EQ_INT(codec_tool_watcher_end(w, "stop", &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 0);

    codec_tool_watcher_free(w);
}

/* ── Overflow: region buffer cap ───────────────────────────────────────── */
/*
 * Defect: the region buffer grew without bound. A client that can make
 * the model emit a start marker without a matching end marker could grow
 * it to the entire remaining generation. The cap must be enforced and the
 * overflow must be a defined, observable event, not a silent truncation.
 */

static void test_watcher_region_cap_defaults_and_is_settable(void) {
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(1000, 1001, &w), CODEC_OK);
    CT_EQ_SZ(codec_tool_watcher_region_cap(w), CODEC_TOOL_WATCHER_DEFAULT_REGION_CAP);

    codec_tool_watcher_set_region_cap(w, 3);
    CT_EQ_SZ(codec_tool_watcher_region_cap(w), 3);

    /* 0 resets to the default rather than becoming an unusable cap. */
    codec_tool_watcher_set_region_cap(w, 0);
    CT_EQ_SZ(codec_tool_watcher_region_cap(w), CODEC_TOOL_WATCHER_DEFAULT_REGION_CAP);

    codec_tool_watcher_free(w);
}

static void test_watcher_overflow_fires_once_at_cap_then_resyncs_on_end_marker(void) {
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(1000, 1001, &w), CODEC_OK);
    codec_tool_watcher_set_region_cap(w, 3);

    /* Region body is 5 tokens long against a cap of 3: must overflow once,
     * with exactly the first 3 tokens, and must NOT also emit REGION_END
     * for the same region when the end marker eventually arrives. */
    uint32_t ids[] = { 1000, 1, 2, 3, 4, 5, 1001, 9 };
    codec_watcher_event_t *evs = NULL;
    size_t n = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, sizeof(ids) / sizeof(ids[0]),
                                       &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 2);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_REGION_OVERFLOW);
    CT_EQ_SZ(evs[0].ids_len, 3);
    CT_EQ_INT(evs[0].ids[0], 1);
    CT_EQ_INT(evs[0].ids[1], 2);
    CT_EQ_INT(evs[0].ids[2], 3);
    CT_EQ_INT((int)evs[1].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[1].ids_len, 1);
    CT_EQ_INT(evs[1].ids[0], 9);
    CT_TRUE(!codec_tool_watcher_inside(w));

    codec_tool_watcher_free(w);
}

static void test_watcher_overflow_then_truncated_reports_both(void) {
    /* A region that overflows and then never sees an end marker must
     * report BOTH: the overflow (memory bound hit) and the truncation
     * (stream ended without a close). They are orthogonal signals. */
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(1000, 1001, &w), CODEC_OK);
    codec_tool_watcher_set_region_cap(w, 2);

    uint32_t ids[] = { 1000, 1, 2, 3, 4 };
    codec_watcher_event_t *evs = NULL;
    size_t n = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, 5, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 1);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_REGION_OVERFLOW);
    CT_EQ_SZ(evs[0].ids_len, 2);

    CT_EQ_INT(codec_tool_watcher_end(w, "length", &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 1);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_REGION_TRUNCATED);
    CT_EQ_SZ(evs[0].ids_len, 2);
    CT_EQ_STR(evs[0].finish_reason, "length");

    codec_tool_watcher_free(w);
}

static void test_watcher_exact_cap_does_not_overflow(void) {
    /* Off-by-one check: a region whose body is exactly `cap` tokens must
     * close cleanly as REGION_END, not as REGION_OVERFLOW. */
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(1000, 1001, &w), CODEC_OK);
    codec_tool_watcher_set_region_cap(w, 3);

    uint32_t ids[] = { 1000, 1, 2, 3, 1001 };
    codec_watcher_event_t *evs = NULL;
    size_t n = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, 5, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 1);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[0].ids_len, 3);

    codec_tool_watcher_free(w);
}

/* ── Nested start markers ──────────────────────────────────────────────── */
/*
 * Defect: a start marker seen while already inside a region vanished with
 * no diagnostic: not in the region body, not anywhere else. The behaviour
 * (drop from the body; no nested regions) is unchanged, but it must now
 * be observable.
 */

static void test_watcher_nested_start_is_observable_and_ordered(void) {
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(1000, 1001, &w), CODEC_OK);

    /* S 1 S 2 E 3 -> nested_start / region([1,2]) / passthrough([3]) */
    uint32_t ids[] = { 1000, 1, 1000, 2, 1001, 3 };
    codec_watcher_event_t *evs = NULL;
    size_t n = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, 6, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 3);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_NESTED_START);
    CT_EQ_SZ(evs[0].ids_len, 1);
    CT_EQ_INT(evs[0].ids[0], 1000);
    CT_EQ_INT((int)evs[1].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[1].ids_len, 2);
    CT_EQ_INT(evs[1].ids[0], 1);
    CT_EQ_INT(evs[1].ids[1], 2);
    CT_EQ_INT((int)evs[2].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[2].ids_len, 1);
    CT_EQ_INT(evs[2].ids[0], 3);

    codec_tool_watcher_free(w);
}

/* ── Empty region: start marker immediately followed by end marker ────── */
/*
 * Defect: an empty region emitted NO event at all in C, because the
 * emit_region() helper skipped zero-length spans. The other five
 * implementations (TypeScript, Python, Rust, Java, .NET) all emit
 * REGION_END with an empty body. A model that emits
 * "<tool_call></tool_call>" was therefore indistinguishable, to a C
 * caller, from a model that never called a tool at all: exactly the
 * silent swallow that REGION_TRUNCATED and NESTED_START were added to
 * prevent. Not covered by the shared conformance fixture, which is why
 * it survived.
 */

static void test_watcher_empty_region_is_still_reported(void) {
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(90, 91, &w), CODEC_OK);

    /* Bare empty region. */
    uint32_t ids[] = { 90, 91 };
    codec_watcher_event_t *evs = NULL;
    size_t n = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, 2, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 1);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[0].ids_len, 0);

    /* Surrounded by passthrough: ordering must still hold. */
    codec_tool_watcher_reset(w);
    uint32_t ids2[] = { 0, 90, 91, 1 };
    CT_EQ_INT(codec_tool_watcher_feed(w, ids2, 4, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 3);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[0].ids_len, 1);
    CT_EQ_INT(evs[0].ids[0], 0);
    CT_EQ_INT((int)evs[1].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[1].ids_len, 0);
    CT_EQ_INT((int)evs[2].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_SZ(evs[2].ids_len, 1);
    CT_EQ_INT(evs[2].ids[0], 1);

    /* Empty region split across two feeds. */
    codec_tool_watcher_reset(w);
    uint32_t a[] = { 90 };
    uint32_t b[] = { 91 };
    CT_EQ_INT(codec_tool_watcher_feed(w, a, 1, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 0);
    CT_TRUE(codec_tool_watcher_inside(w));
    CT_EQ_INT(codec_tool_watcher_feed(w, b, 1, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 1);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[0].ids_len, 0);

    /* An empty region must not disturb a following non-empty one: the
     * arena offset bookkeeping has to stay correct across a 0-length
     * span. */
    codec_tool_watcher_reset(w);
    uint32_t ids3[] = { 90, 91, 90, 7, 91 };
    CT_EQ_INT(codec_tool_watcher_feed(w, ids3, 5, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 2);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[0].ids_len, 0);
    CT_EQ_INT((int)evs[1].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_SZ(evs[1].ids_len, 1);
    CT_EQ_INT(evs[1].ids[0], 7);

    codec_tool_watcher_free(w);
}

/* ── Ordering: interleaved events in stream order (defect 3) ──────────── */
/*
 * [a, S, X, E, b, S, Y, E, c] must produce five ORDERED events:
 * passthrough(a) / region(X) / passthrough(b) / region(Y) / passthrough(c).
 * This is the exact shape every language's watcher must agree on.
 */

static void test_watcher_ordering_matches_defect3_example(void) {
    codec_tool_watcher_t *w = NULL;
    CT_EQ_INT(codec_tool_watcher_new_with_ids(90, 91, &w), CODEC_OK);

    uint32_t a = 10, b = 11, c = 12, x = 13, y = 14;
    uint32_t ids[] = { a, 90, x, 91, b, 90, y, 91, c };
    codec_watcher_event_t *evs = NULL;
    size_t n = 0;
    CT_EQ_INT(codec_tool_watcher_feed(w, ids, 9, &evs, &n), CODEC_OK);
    CT_EQ_SZ(n, 5);
    CT_EQ_INT((int)evs[0].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_INT(evs[0].ids[0], (int)a);
    CT_EQ_INT((int)evs[1].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_INT(evs[1].ids[0], (int)x);
    CT_EQ_INT((int)evs[2].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_INT(evs[2].ids[0], (int)b);
    CT_EQ_INT((int)evs[3].kind, (int)CODEC_WATCH_REGION_END);
    CT_EQ_INT(evs[3].ids[0], (int)y);
    CT_EQ_INT((int)evs[4].kind, (int)CODEC_WATCH_PASSTHROUGH);
    CT_EQ_INT(evs[4].ids[0], (int)c);

    codec_tool_watcher_free(w);
}

int main(void) {
    CT_RUN(test_map_special_id_resolves_by_name);
    CT_RUN(test_watcher_passthrough_then_region_then_passthrough);
    CT_RUN(test_watcher_region_split_across_feeds);
    CT_RUN(test_watcher_multiple_regions);
    CT_RUN(test_watcher_stray_end_passes_through);
    CT_RUN(test_watcher_missing_name_is_not_found);
    CT_RUN(test_watcher_does_not_decode_tokens);
    CT_RUN(test_watcher_real_qwen2);
    CT_RUN(test_watcher_two_regions_one_feed_keep_distinct_ids);
    CT_RUN(test_watcher_region_across_feeds_still_survives);
    CT_RUN(test_watcher_end_emits_truncated_with_finish_reason);
    CT_RUN(test_watcher_end_reports_empty_body_when_stream_ends_right_after_start);
    CT_RUN(test_watcher_end_outside_region_emits_nothing);
    CT_RUN(test_watcher_region_cap_defaults_and_is_settable);
    CT_RUN(test_watcher_overflow_fires_once_at_cap_then_resyncs_on_end_marker);
    CT_RUN(test_watcher_overflow_then_truncated_reports_both);
    CT_RUN(test_watcher_exact_cap_does_not_overflow);
    CT_RUN(test_watcher_nested_start_is_observable_and_ordered);
    CT_RUN(test_watcher_empty_region_is_still_reported);
    CT_RUN(test_watcher_ordering_matches_defect3_example);
    CT_DONE();
}
