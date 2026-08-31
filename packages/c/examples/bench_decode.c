/*
 * bench_decode.c: minimal microbench for the decode path.
 *
 * Builds a synthetic msgpack stream of N frames (1 token per frame, matching
 * the worst-case streaming scenario) then measures how fast we can pull
 * frames + detokenize them through the real map.
 *
 *   bench_decode <map.json> [num_frames=10000]
 *
 * Reports: wire bytes/token, decode ns/frame, detokenize ns/frame.
 */
#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#  define _POSIX_C_SOURCE 199309L  /* unlocks clock_gettime + CLOCK_MONOTONIC */
#endif
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

static int slurp(const char *path, char **out, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *b = (char *)malloc((size_t)sz + 1);
    if (!b) { fclose(f); return 0; }
    size_t got = fread(b, 1, (size_t)sz, f);
    fclose(f);
    b[got] = 0;
    *out = b; *out_len = got;
    return 1;
}

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

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <map.json> [num_frames]\n", argv[0]); return 2; }
    size_t num_frames = (argc >= 3) ? (size_t)atoi(argv[2]) : 10000;

    char *json = NULL; size_t json_len = 0;
    if (!slurp(argv[1], &json, &json_len)) { fprintf(stderr, "read failed\n"); return 1; }

    codec_tokenizer_map_t *map = NULL;
    if (codec_map_from_json(json, json_len, &map) != CODEC_OK) {
        fprintf(stderr, "map parse failed\n"); return 1;
    }
    free(json);

    /* Build a deterministic stream. Use a simple LCG to pick token IDs in
     * the first 32K: typical hot range for an LLM. */
    uint8_t *stream = NULL;
    size_t   stream_len = 0;
    {
        uint32_t seed = 0xdeadbeefu;
        for (size_t i = 0; i < num_frames; i++) {
            seed = seed * 1664525u + 1013904223u;
            uint32_t id = seed & 0x7FFF;
            codec_frame_t fr; codec_frame_init(&fr);
            uint32_t arr[1] = { id };
            fr.ids = arr; fr.ids_len = 1;
            fr.done = (i + 1 == num_frames);
            fr.finish_reason = fr.done ? (char *)"stop" : NULL;

            codec_buffer_t buf = {0};
            codec_encode_msgpack(&fr, &buf);
            uint8_t *grow = (uint8_t *)realloc(stream, stream_len + buf.len);
            memcpy(grow + stream_len, buf.data, buf.len);
            stream = grow;
            stream_len += buf.len;
            codec_buffer_free(&buf);
            fr.ids = NULL; fr.finish_reason = NULL; codec_frame_destroy(&fr);
        }
    }

    fprintf(stderr, "stream: %zu bytes (%g B/token)\n",
            stream_len, (double)stream_len / (double)num_frames);

    /* Decode + detokenize in a tight loop. */
    codec_msgpack_stream_t *dec = NULL;
    codec_msgpack_stream_new(&dec);
    codec_detokenizer_t *detok = NULL;
    codec_detokenizer_new(map, &detok);

    /* Feed the whole stream up front; this isolates decode CPU from feed CPU. */
    codec_msgpack_stream_feed(dec, stream, stream_len);

    double t0 = now_ns();
    size_t decoded = 0, dt_chars = 0;
    for (;;) {
        codec_frame_t out;
        codec_status_t r = codec_msgpack_stream_next(dec, &out);
        if (r == CODEC_ERR_INCOMPLETE) break;
        if (r != CODEC_OK) { fprintf(stderr, "decode error %d\n", r); break; }
        decoded++;

        char *text = NULL; size_t tlen = 0;
        codec_detokenize_opts_t o = { !out.done, false };
        codec_detokenizer_render(detok, out.ids, out.ids_len, o, &text, &tlen);
        dt_chars += tlen;
        free(text);

        bool done = out.done;
        codec_frame_destroy(&out);
        if (done) break;
    }
    double t1 = now_ns();

    double per_frame = (t1 - t0) / (double)decoded;
    fprintf(stdout,
        "decoded %zu frames in %.2f ms\n"
        "  %.0f ns/frame (decode+detokenize combined)\n"
        "  %.2f million tokens/sec\n"
        "  %zu chars rendered\n",
        decoded, (t1 - t0) / 1.0e6, per_frame,
        (1.0e9 / per_frame) / 1.0e6, dt_chars);

    free(stream);
    codec_detokenizer_free(detok);
    codec_msgpack_stream_free(dec);
    codec_map_free(map);
    return 0;
}
