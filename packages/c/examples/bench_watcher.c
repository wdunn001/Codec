/*
 * bench_watcher.c — microbench for codec_tool_watcher.
 *
 * Measures the watcher's hot-loop cost (uint32 compare + region buffering)
 * against the cost of detokenizing the same stream. This is the headline
 * number for "tool-call detection without decoding": the watcher is
 * orders of magnitude faster than detokenize because it never touches
 * the vocab.
 *
 *   bench_watcher [num_tokens=1000000] [region_density=0.05] [chunk=1024]
 *
 * region_density is the fraction of stream that lies inside <tool_call>
 * regions. 0.0 = no tool calls, 1.0 = entirely tool calls. Default 5%.
 *
 * Self-contained — uses an inline synthetic tokenizer map so the bench
 * runs without any external map file.
 */
#include "codec/codec.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#else
#  include <time.h>
#endif

static double now_ns(void) {
#if defined(_WIN32)
    static LARGE_INTEGER freq;
    if (freq.QuadPart == 0) QueryPerformanceFrequency(&freq);
    LARGE_INTEGER c;
    QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1.0e9 / (double)freq.QuadPart;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1.0e9 + (double)ts.tv_nsec;
#endif
}

/* Minimal byte-level vocab covering 0..255 — enough for the detokenizer
 * to do real work on every token in the stream. Specials at 256/257. */
static char *build_synth_map(size_t *out_len) {
    /* Pre-size: header + 256 entries (~"\"a\":N," each ~10 bytes) + tail */
    size_t cap = 4096 + 256 * 24;
    char *s = (char *)malloc(cap);
    if (!s) return NULL;
    int n = snprintf(s, cap,
        "{"
        "\"id\":\"test/bench\","
        "\"version\":\"2\","
        "\"vocab_size\":260,"
        "\"encoder\":\"byte_level\","
        "\"vocab\":{");
    /* GPT-2 byte-level vocab uses U+0100..U+01FF for control bytes; for
     * the bench we just need *some* string per ID so detokenize has work
     * to do. Use single-character ASCII for the printable range. */
    for (int i = 0; i < 256; i++) {
        char ch = (i >= 0x20 && i < 0x7f && i != '"' && i != '\\') ? (char)i : 'x';
        n += snprintf(s + n, cap - n, "\"%c%d\":%d%s",
                      ch, i, i, (i + 1 < 256) ? "," : "");
    }
    n += snprintf(s + n, cap - n,
        "},"
        "\"special_tokens\":{"
        "\"<tool_call>\":256,"
        "\"</tool_call>\":257"
        "}}");
    *out_len = (size_t)n;
    return s;
}

#define START_ID 256u
#define END_ID   257u

int main(int argc, char **argv) {
    size_t num_tokens     = (argc >= 2) ? (size_t)atol(argv[1]) : 1000000;
    double region_density = (argc >= 3) ? atof(argv[2])         : 0.05;
    size_t chunk          = (argc >= 4) ? (size_t)atol(argv[3]) : 1024;

    /* ── Map (synthetic) ──────────────────────────────────────────────── */
    size_t map_len = 0;
    char *map_json = build_synth_map(&map_len);
    if (!map_json) { fprintf(stderr, "oom\n"); return 1; }

    codec_tokenizer_map_t *map = NULL;
    if (codec_map_from_json(map_json, map_len, &map) != CODEC_OK) {
        fprintf(stderr, "synth map parse failed\n");
        free(map_json); return 1;
    }
    free(map_json);

    /* ── Stream ───────────────────────────────────────────────────────── */
    uint32_t *ids = (uint32_t *)malloc(num_tokens * sizeof(uint32_t));
    if (!ids) { fprintf(stderr, "oom\n"); return 1; }
    {
        uint32_t seed = 0xdeadbeefu;
        size_t i = 0;
        while (i < num_tokens) {
            seed = seed * 1664525u + 1013904223u;
            double r = (double)(seed >> 8) / (double)(1u << 24);
            if (r < region_density / 12.0 && i + 14 < num_tokens) {
                ids[i++] = START_ID;
                for (size_t k = 0; k < 12; k++) {
                    seed = seed * 1664525u + 1013904223u;
                    ids[i++] = seed & 0xFFu;  /* stays inside 0..255 vocab */
                }
                ids[i++] = END_ID;
            } else {
                ids[i++] = seed & 0xFFu;
            }
        }
    }

    /* ── 1. Watcher hot-loop ──────────────────────────────────────────── */
    codec_tool_watcher_t *w = NULL;
    if (codec_tool_watcher_new(map, "<tool_call>", "</tool_call>", &w) != CODEC_OK) {
        fprintf(stderr, "watcher_new failed\n"); return 1;
    }

    size_t regions_seen = 0, passthrough_ids = 0;
    double t0 = now_ns();
    for (size_t off = 0; off < num_tokens; off += chunk) {
        size_t take = (off + chunk <= num_tokens) ? chunk : (num_tokens - off);
        codec_watcher_event_t *evs; size_t n_evs;
        codec_status_t r = codec_tool_watcher_feed(w, &ids[off], take, &evs, &n_evs);
        if (r != CODEC_OK) { fprintf(stderr, "feed err %d\n", r); break; }
        for (size_t e = 0; e < n_evs; e++) {
            if (evs[e].kind == CODEC_WATCH_REGION_END) regions_seen++;
            else passthrough_ids += evs[e].ids_len;
        }
    }
    double t1 = now_ns();
    double watcher_ns_per_token = (t1 - t0) / (double)num_tokens;

    /* ── 2. Detokenize same stream as comparison baseline ─────────────── */
    codec_detokenizer_t *detok = NULL;
    if (codec_detokenizer_new(map, &detok) != CODEC_OK) {
        fprintf(stderr, "detok_new failed\n"); return 1;
    }
    size_t chars = 0;
    double d0 = now_ns();
    for (size_t off = 0; off < num_tokens; off += chunk) {
        size_t take = (off + chunk <= num_tokens) ? chunk : (num_tokens - off);
        char *text = NULL; size_t tlen = 0;
        codec_detokenize_opts_t o = { /*partial=*/true, /*render_special=*/false };
        codec_detokenizer_render(detok, &ids[off], take, o, &text, &tlen);
        chars += tlen;
        free(text);
    }
    double d1 = now_ns();
    double detok_ns_per_token = (d1 - d0) / (double)num_tokens;

    /* ── Report ───────────────────────────────────────────────────────── */
    fprintf(stdout,
        "bench_watcher  (synthetic byte-level map, %zu-id chunks)\n"
        "  tokens             %zu\n"
        "  region_density     %.3f  (regions seen: %zu)\n"
        "  passthrough ids    %zu\n"
        "  detok chars        %zu\n"
        "\n"
        "  watcher            %.2f ns/token   %.2f Mtok/s   total %.2f ms\n"
        "  detokenize         %.2f ns/token   %.2f Mtok/s   total %.2f ms\n"
        "  speedup            %.1fx\n",
        chunk, num_tokens, region_density, regions_seen,
        passthrough_ids, chars,
        watcher_ns_per_token, 1000.0 / watcher_ns_per_token, (t1 - t0) / 1.0e6,
        detok_ns_per_token,   1000.0 / detok_ns_per_token,   (d1 - d0) / 1.0e6,
        detok_ns_per_token / watcher_ns_per_token);

    free(ids);
    codec_tool_watcher_free(w);
    codec_detokenizer_free(detok);
    codec_map_free(map);
    return 0;
}
