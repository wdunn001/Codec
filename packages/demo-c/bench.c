/* CLOCK_MONOTONIC + struct timespec require POSIX 199309 features.
 * MUST be defined BEFORE any system header is pulled in transitively. */
#ifndef _POSIX_C_SOURCE
#  define _POSIX_C_SOURCE 199309L
#endif

/* SPDX-License-Identifier: MIT
 *
 * codec-bench (C) - same shape as the web/python/dotnet demos.
 * Runs 3 wire formats x 4 compression encodings against an sglang
 * server, prints the wire-byte table.
 *
 *   ./codec-bench [--url URL] [--model M] [--prompt P] [--max-tokens N]
 *
 * libcurl handles the HTTP transport (and transparent gzip/br/zstd
 * decompression when available). libcodec decodes the binary frames.
 * We measure the actual wire bytes via curl's CURLINFO_SIZE_DOWNLOAD_T,
 * which reports compressed bytes when the server compresses.
 */
#include "codec/codec.h"

#include <curl/curl.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#endif

/* ── timing ─────────────────────────────────────────────────────────────── */

static double now_ms(void) {
#if defined(_WIN32)
    static LARGE_INTEGER freq;
    if (freq.QuadPart == 0) QueryPerformanceFrequency(&freq);
    LARGE_INTEGER c; QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1000.0 / (double)freq.QuadPart;
#else
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1.0e6;
#endif
}

/* ── byte buffer ────────────────────────────────────────────────────────── */

typedef struct { uint8_t *data; size_t len, cap; } buf_t;

static int buf_push(buf_t *b, const uint8_t *src, size_t n) {
    if (b->len + n > b->cap) {
        size_t nc = b->cap ? b->cap * 2 : 4096;
        while (nc < b->len + n) nc *= 2;
        uint8_t *p = (uint8_t *)realloc(b->data, nc);
        if (!p) return 0;
        b->data = p; b->cap = nc;
    }
    memcpy(b->data + b->len, src, n);
    b->len += n;
    return 1;
}

static size_t curl_write(char *ptr, size_t size, size_t nmemb, void *userdata) {
    buf_t *b = (buf_t *)userdata;
    size_t n = size * nmemb;
    if (!buf_push(b, (const uint8_t *)ptr, n)) return 0;
    return n;
}

/* ── token counters ────────────────────────────────────────────────────── */

static size_t count_jsonsse(const buf_t *b) {
    size_t n = 0;
    const char *s = (const char *)b->data;
    size_t L = b->len;
    size_t i = 0;
    while (i < L) {
        size_t j = i;
        while (j < L && s[j] != '\n') j++;
        if (j - i >= 6 && memcmp(s + i, "data: ", 6) == 0) {
            const char *p = s + i + 6;
            size_t pL = j - i - 6;
            int is_done = (pL >= 6 && memcmp(p, "[DONE]", 6) == 0);
            if (!is_done) n++;
        }
        i = j + 1;
    }
    return n;
}

static size_t count_msgpack(const buf_t *b) {
    codec_msgpack_stream_t *s = NULL;
    if (codec_msgpack_stream_new(&s) != CODEC_OK) return 0;
    if (codec_msgpack_stream_feed(s, b->data, b->len) != CODEC_OK) {
        codec_msgpack_stream_free(s); return 0;
    }
    size_t n = 0;
    for (;;) {
        codec_frame_t f;
        codec_status_t r = codec_msgpack_stream_next(s, &f);
        if (r == CODEC_ERR_INCOMPLETE) break;
        if (r != CODEC_OK) break;
        n += f.ids_len;
        codec_frame_destroy(&f);
    }
    codec_msgpack_stream_free(s);
    return n;
}

static size_t count_protobuf(const buf_t *b) {
    codec_protobuf_stream_t *s = NULL;
    if (codec_protobuf_stream_new(&s) != CODEC_OK) return 0;
    if (codec_protobuf_stream_feed(s, b->data, b->len) != CODEC_OK) {
        codec_protobuf_stream_free(s); return 0;
    }
    size_t n = 0;
    for (;;) {
        codec_frame_t f;
        codec_status_t r = codec_protobuf_stream_next(s, &f);
        if (r == CODEC_ERR_INCOMPLETE) break;
        if (r != CODEC_OK) break;
        n += f.ids_len;
        codec_frame_destroy(&f);
    }
    codec_protobuf_stream_free(s);
    return n;
}

/* ── cell + grid ───────────────────────────────────────────────────────── */

typedef struct {
    const char *path_label;
    const char *format;     /* "json" | "msgpack" | "protobuf" */
    const char *encoding;   /* "identity" | "gzip" | "br" | "zstd" */
    int  ok;
    size_t wire_bytes;
    size_t decoded_bytes;
    size_t tokens;
    double ttfb_ms;
    double total_ms;
    char err[128];
} cell_t;

static const struct { const char *label, *fmt; } PATHS[] = {
    { "JSON-SSE (default)", "json" },
    { "Codec msgpack",      "msgpack" },
    { "Codec protobuf",     "protobuf" },
};
#define N_PATHS (sizeof(PATHS) / sizeof(PATHS[0]))

static const char *ENCODINGS[] = { "identity", "gzip", "br", "zstd" };
#define N_ENCODINGS (sizeof(ENCODINGS) / sizeof(ENCODINGS[0]))

static const char *fmt_bytes(size_t n, char *out, size_t out_cap) {
    if (n < 1024) snprintf(out, out_cap, "%zu B", n);
    else if (n < 1048576) snprintf(out, out_cap, "%.1f KB", n / 1024.0);
    else snprintf(out, out_cap, "%.2f MB", n / 1048576.0);
    return out;
}

/* ── one cell ──────────────────────────────────────────────────────────── */

typedef struct {
    const char *url, *model, *prompt;
    int max_tokens;
} args_t;

static int run_one(const args_t *a, cell_t *c) {
    /* Build request body. */
    char body[1024];
    if (strcmp(c->format, "json") == 0) {
        snprintf(body, sizeof(body),
            "{\"model\":\"%s\",\"prompt\":\"%s\","
            "\"max_tokens\":%d,\"stream\":true,\"temperature\":0.0}",
            a->model, a->prompt, a->max_tokens);
    } else {
        snprintf(body, sizeof(body),
            "{\"model\":\"%s\",\"prompt\":\"%s\","
            "\"max_tokens\":%d,\"stream\":true,\"temperature\":0.0,"
            "\"stream_format\":\"%s\"}",
            a->model, a->prompt, a->max_tokens, c->format);
    }

    char url[512];
    snprintf(url, sizeof(url), "%s/v1/completions", a->url);

    CURL *curl = curl_easy_init();
    if (!curl) { snprintf(c->err, sizeof(c->err), "curl_easy_init failed"); return 0; }

    buf_t buf = {0};

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    char ae[64];
    snprintf(ae, sizeof(ae), "Accept-Encoding: %s", c->encoding);
    headers = curl_slist_append(headers, ae);

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buf);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 120L);
    /* Tell libcurl to advertise this encoding AND auto-decompress on
     * receive. Our write callback then sees the decompressed bytes
     * (so the libcodec stream decoder is happy), while
     * CURLINFO_SIZE_DOWNLOAD_T continues to report the on-the-wire
     * (compressed) byte count. We don't pass CURLOPT_ACCEPT_ENCODING
     * for "identity" — that would still send "Accept-Encoding:
     * identity" but disable decompression, which is what we want. */
    if (strcmp(c->encoding, "identity") != 0) {
        curl_easy_setopt(curl, CURLOPT_ACCEPT_ENCODING, c->encoding);
    }

    double t0 = now_ms();
    CURLcode rc = curl_easy_perform(curl);
    double t1 = now_ms();

    if (rc != CURLE_OK) {
        snprintf(c->err, sizeof(c->err), "curl: %s", curl_easy_strerror(rc));
        free(buf.data); curl_slist_free_all(headers); curl_easy_cleanup(curl);
        return 0;
    }

    long http_status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_status);
    /* Compressed-body byte count comes from the size of what we received. */
    curl_off_t dl = 0;
    curl_easy_getinfo(curl, CURLINFO_SIZE_DOWNLOAD_T, &dl);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (http_status != 200) {
        snprintf(c->err, sizeof(c->err), "HTTP %ld", http_status);
        free(buf.data); return 0;
    }

    c->wire_bytes = (size_t)dl;
    c->decoded_bytes = buf.len;
    c->total_ms = t1 - t0;
    c->ttfb_ms = c->total_ms;  /* libcurl easy doesn't expose first-byte time
                                * cheaply; report total as both.   */

    if (strcmp(c->format, "json") == 0)        c->tokens = count_jsonsse(&buf);
    else if (strcmp(c->format, "msgpack") == 0) c->tokens = count_msgpack(&buf);
    else                                         c->tokens = count_protobuf(&buf);

    free(buf.data);
    c->ok = 1;
    return 1;
}

/* ── render ────────────────────────────────────────────────────────────── */

static void render(cell_t (*grid)[N_ENCODINGS]) {
    size_t baseline = (grid[0][0].ok) ? grid[0][0].wire_bytes : 0;

    char hdr[256];
    int p = snprintf(hdr, sizeof(hdr), "%-25s", "path");
    for (size_t e = 0; e < N_ENCODINGS; e++)
        p += snprintf(hdr + p, sizeof(hdr) - p, "  %16s", ENCODINGS[e]);
    printf("\n%s\n", hdr);
    for (size_t i = 0; i < strlen(hdr); i++) putchar('-');
    putchar('\n');

    for (size_t i = 0; i < N_PATHS; i++) {
        printf("%-25s", PATHS[i].label);
        for (size_t e = 0; e < N_ENCODINGS; e++) {
            char b[32];
            cell_t *c = &grid[i][e];
            if (!c->ok)
                printf("  %16s", c->err[0] ? c->err : "-");
            else
                printf("  %16s", fmt_bytes(c->wire_bytes, b, sizeof(b)));
        }
        putchar('\n');
    }

    printf("\nper cell: wire / tokens / B-per-tok / total / ratio-vs-json\n\n");
    for (size_t i = 0; i < N_PATHS; i++) {
        for (size_t e = 0; e < N_ENCODINGS; e++) {
            cell_t *c = &grid[i][e];
            if (!c->ok) continue;
            double ratio = (baseline && c->wire_bytes) ? (double)baseline / c->wire_bytes : 0.0;
            double bpt = c->tokens ? (double)c->wire_bytes / c->tokens : 0.0;
            char b[32];
            printf("  %-25s %-8s  %10s  %4zu tok  %6.1f B/tok  %7.0f ms  %5.1fx\n",
                   PATHS[i].label, ENCODINGS[e],
                   fmt_bytes(c->wire_bytes, b, sizeof(b)),
                   c->tokens, bpt, c->total_ms, ratio);
        }
    }
}

/* ── main ──────────────────────────────────────────────────────────────── */

int main(int argc, char **argv) {
    args_t a = {
        .url = "http://192.168.1.88:30000",
        .model = "Qwen/Qwen2.5-0.5B-Instruct",
        .prompt = "Explain entropy in one sentence:",
        .max_tokens = 64,
    };
    for (int i = 1; i < argc; i++) {
        if (i + 1 < argc && strcmp(argv[i], "--url") == 0) a.url = argv[++i];
        else if (i + 1 < argc && strcmp(argv[i], "--model") == 0) a.model = argv[++i];
        else if (i + 1 < argc && strcmp(argv[i], "--prompt") == 0) a.prompt = argv[++i];
        else if (i + 1 < argc && strcmp(argv[i], "--max-tokens") == 0) a.max_tokens = atoi(argv[++i]);
    }

    fprintf(stderr, "target: %s\nmodel:  %s\nprompt: %s  (max_tokens=%d)\n",
            a.url, a.model, a.prompt, a.max_tokens);

    curl_global_init(CURL_GLOBAL_DEFAULT);

    cell_t grid[N_PATHS][N_ENCODINGS];
    memset(grid, 0, sizeof(grid));
    for (size_t i = 0; i < N_PATHS; i++) {
        for (size_t e = 0; e < N_ENCODINGS; e++) {
            grid[i][e].path_label = PATHS[i].label;
            grid[i][e].format = PATHS[i].fmt;
            grid[i][e].encoding = ENCODINGS[e];
            fprintf(stderr, ">>>  %s / %s\n", PATHS[i].label, ENCODINGS[e]);
            run_one(&a, &grid[i][e]);
            cell_t *c = &grid[i][e];
            if (c->ok) {
                char b[32];
                fprintf(stderr, "     wire=%s tokens=%zu total=%.0f ms\n",
                        fmt_bytes(c->wire_bytes, b, sizeof(b)),
                        c->tokens, c->total_ms);
            } else {
                fprintf(stderr, "     ERROR: %s\n", c->err);
            }
        }
    }

    render(grid);

    curl_global_cleanup();
    return 0;
}
