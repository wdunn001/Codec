/* CLOCK_MONOTONIC + struct timespec require POSIX 199309 features. */
#ifndef _POSIX_C_SOURCE
#  define _POSIX_C_SOURCE 199309L
#endif

/* SPDX-License-Identifier: MIT
 *
 * SCHEMA-v1 matrix runner for the C client. Mirrors:
 *   packages/demo-python/src/codec_demo/matrix_run.py
 *   packages/demo/src/matrix_run.ts
 *   packages/demo-dotnet/Program.cs (matrix mode)
 *   packages/demo-rust/src/matrix_run.rs
 *   packages/demo-java/.../MatrixRun.java
 *
 * Reads methodology JSON, runs the 3 paths × 4 encodings × N sizes ×
 * reps grid, emits SCHEMA-v1 result JSON.
 *
 * Dependencies: libcurl (HTTP), libcodec (codec_decode_msgpack /
 * codec_decode_protobuf_frame for token counting). No JSON library:
 * we hand-roll narrow substring extraction for the few methodology
 * fields we read. We then printf-format the result. The bench's primary
 * signal (wire bytes / TTFB / total) doesn't depend on the JSON layer
 * being correct.
 *
 * Usage:
 *   ./codec-matrix --methodology PATH --sizes 64 512 2048 --reps 2 --out PATH
 */

#include "codec/codec.h"
#include "codec/codec_compression.h"

#include <curl/curl.h>

#ifdef CODEC_DEMO_HAVE_ZSTD
#  include <zstd.h>
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdint.h>
#include <stdbool.h>
#include <ctype.h>

/* ── timing ─────────────────────────────────────────────────────────────── */

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1.0e6;
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

static void buf_free(buf_t *b) { free(b->data); b->data = NULL; b->len = b->cap = 0; }

/* ── dict-zstd registry ─────────────────────────────────────────────────── */
/*
 * Mirrors codec_demo.CODEC_ZSTD_DICTS (Python) /
 * @codecai/demo's loaded_dicts map (TS). At bench startup we load the
 * reference Qwen2.5 dicts from <repo-root>/dictionaries/ and key them by
 * the canonical "sha256:<hex>" hash codec_hash_zstd_dict produces.
 *
 * On a zstd response the bench reads the Codec-Zstd-Dict header (captured
 * by curl_header_cb below), calls codec_select_zstd_dict_for_response to
 * pick a matching dict, then hands the dict bytes to libzstd for
 * decompression. Wrong-dict decompression would produce garbage bytes
 * that msgpack/protobuf parsers would misinterpret: codec_select fails
 * fast with UNKNOWN_HASH / MALFORMED_HASH / MISSING_HEADER instead.
 */
typedef struct {
    char *hash;       /* "sha256:<hex>": owned */
    uint8_t *bytes;   /* dict file contents: owned */
    size_t len;
} dict_owned_t;

#define CODEC_DEMO_MAX_DICTS 8

static dict_owned_t g_dicts[CODEC_DEMO_MAX_DICTS];
static size_t       g_dict_count = 0;

/* Load one dict file into the registry. Silent on missing files: the
 * matrix run still completes, but zstd cells that need this dict will
 * fail with "Codec-Zstd-Dict mismatch" in the error column (the row's
 * wire_bytes / ttft / total numbers stay valid). Same behaviour as
 * codec_demo.load_zstd_dict_files. */
static void load_zstd_dict_file(const char *path) {
    if (!path || g_dict_count >= CODEC_DEMO_MAX_DICTS) return;
    FILE *f = fopen(path, "rb");
    if (!f) return;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return; }
    long L = ftell(f);
    if (L < 0) { fclose(f); return; }
    if (fseek(f, 0, SEEK_SET) != 0) { fclose(f); return; }
    uint8_t *bytes = (uint8_t *)malloc((size_t)L);
    if (!bytes && L > 0) { fclose(f); return; }
    if (fread(bytes, 1, (size_t)L, f) != (size_t)L) {
        free(bytes); fclose(f); return;
    }
    fclose(f);
    char hash[CODEC_ZSTD_DICT_HASH_BUF_LEN];
    if (codec_hash_zstd_dict(bytes, (size_t)L, hash) != 0) {
        free(bytes); return;
    }
    g_dicts[g_dict_count].hash  = strdup(hash);
    g_dicts[g_dict_count].bytes = bytes;
    g_dicts[g_dict_count].len   = (size_t)L;
    g_dict_count++;
    fprintf(stderr, "loaded zstd dict %s (%ld bytes) from %s\n",
            hash, L, path);
}

static void free_dict_registry(void) {
    for (size_t i = 0; i < g_dict_count; i++) {
        free(g_dicts[i].hash);
        free(g_dicts[i].bytes);
    }
    g_dict_count = 0;
}

/* Build a codec_zstd_dict_entry_t snapshot of the registry for the
 * codec_select_zstd_dict_for_response call. Borrowed pointers: the
 * snapshot is valid as long as the registry isn't mutated. */
static size_t snapshot_dict_registry(codec_zstd_dict_entry_t out[CODEC_DEMO_MAX_DICTS]) {
    for (size_t i = 0; i < g_dict_count; i++) {
        out[i].hash  = g_dicts[i].hash;
        out[i].bytes = g_dicts[i].bytes;
        out[i].len   = g_dicts[i].len;
    }
    return g_dict_count;
}

/* libcurl writes raw bytes off the socket here. We disabled
 * accept-encoding negotiation in curl (CURLOPT_ACCEPT_ENCODING is unset
 * by default) so the server's response is delivered un-decompressed. */
typedef struct {
    buf_t buf;
    double t0;
    double ttft_ms;
    bool first;
    /* Captured response headers we care about. Heap-owned; freed by
     * stream_state_reset. */
    char *content_encoding;   /* lowercase, trimmed */
    char *codec_zstd_dict;    /* raw header value, untrimmed */
} stream_state_t;

static void stream_state_reset(stream_state_t *st) {
    buf_free(&st->buf);
    free(st->content_encoding); st->content_encoding = NULL;
    free(st->codec_zstd_dict);  st->codec_zstd_dict  = NULL;
    st->t0 = 0; st->ttft_ms = 0; st->first = true;
}

/* curl header callback. Headers arrive one line at a time, including the
 * CRLF terminator. We snapshot Content-Encoding and Codec-Zstd-Dict only.
 * Case-insensitive name match: HTTP/2 lowercases everything but HTTP/1.1
 * leaves casing to the server. */
static size_t curl_header_cb(char *buf, size_t size, size_t nitems, void *userdata) {
    stream_state_t *st = (stream_state_t *)userdata;
    size_t n = size * nitems;
    /* Find the colon. */
    size_t colon = 0;
    while (colon < n && buf[colon] != ':') colon++;
    if (colon >= n) return n; /* status line / continuation / malformed */
    size_t name_len = colon;
    /* Skip ": " and any leading whitespace in value. */
    size_t v = colon + 1;
    while (v < n && (buf[v] == ' ' || buf[v] == '\t')) v++;
    /* Trim CR / LF / trailing whitespace from value. */
    size_t v_end = n;
    while (v_end > v && (buf[v_end - 1] == '\r' || buf[v_end - 1] == '\n'
                         || buf[v_end - 1] == ' ' || buf[v_end - 1] == '\t')) v_end--;
    size_t v_len = v_end - v;

    /* Case-insensitive name compare against the two headers we capture. */
    static const char H_CE[] = "content-encoding";
    static const char H_CZD[] = "codec-zstd-dict";
    int is_ce = (name_len == sizeof(H_CE) - 1);
    int is_czd = (name_len == sizeof(H_CZD) - 1);
    for (size_t i = 0; i < name_len; i++) {
        char c = buf[i];
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        if (is_ce  && c != H_CE[i])  is_ce = 0;
        if (is_czd && c != H_CZD[i]) is_czd = 0;
        if (!is_ce && !is_czd) break;
    }

    if (is_ce && !st->content_encoding) {
        st->content_encoding = (char *)malloc(v_len + 1);
        if (st->content_encoding) {
            memcpy(st->content_encoding, buf + v, v_len);
            st->content_encoding[v_len] = 0;
            /* Lowercase + trim was already done; we keep the value as
             * received but produce a lowercase comparison-friendly form
             * below by calling codec_select_zstd_dict_for_response. */
        }
    } else if (is_czd && !st->codec_zstd_dict) {
        st->codec_zstd_dict = (char *)malloc(v_len + 1);
        if (st->codec_zstd_dict) {
            memcpy(st->codec_zstd_dict, buf + v, v_len);
            st->codec_zstd_dict[v_len] = 0;
        }
    }
    return n;
}

#ifdef CODEC_DEMO_HAVE_ZSTD
/* Decompress `src` with `dict` using libzstd's streaming API. Returns 1
 * on success (sets *out / *out_len); 0 on failure. Caller frees *out. */
static int zstd_decompress_with_dict(const uint8_t *src, size_t src_len,
                                     const uint8_t *dict, size_t dict_len,
                                     uint8_t **out, size_t *out_len) {
    ZSTD_DCtx *dctx = ZSTD_createDCtx();
    if (!dctx) return 0;
    if (ZSTD_isError(ZSTD_DCtx_loadDictionary(dctx, dict, dict_len))) {
        ZSTD_freeDCtx(dctx); return 0;
    }

    /* Grow geometrically. Codec frame streams are small, on the order of KBs.
     * We start with a 64 KB output buffer and double on overflow. */
    size_t cap = 64 * 1024;
    uint8_t *dst = (uint8_t *)malloc(cap);
    if (!dst) { ZSTD_freeDCtx(dctx); return 0; }
    size_t produced = 0;

    ZSTD_inBuffer in = { src, src_len, 0 };
    while (in.pos < in.size) {
        if (produced + ZSTD_BLOCKSIZE_MAX > cap) {
            size_t nc = cap * 2;
            uint8_t *p = (uint8_t *)realloc(dst, nc);
            if (!p) { free(dst); ZSTD_freeDCtx(dctx); return 0; }
            dst = p; cap = nc;
        }
        ZSTD_outBuffer outb = { dst + produced, cap - produced, 0 };
        size_t r = ZSTD_decompressStream(dctx, &outb, &in);
        if (ZSTD_isError(r)) {
            free(dst); ZSTD_freeDCtx(dctx); return 0;
        }
        produced += outb.pos;
        if (r == 0 && in.pos == in.size) break;  /* frame complete */
        if (outb.pos == 0 && in.pos == in.size) break;  /* drained */
    }

    ZSTD_freeDCtx(dctx);
    *out = dst;
    *out_len = produced;
    return 1;
}
#endif

static size_t curl_write(char *ptr, size_t size, size_t nmemb, void *userdata) {
    stream_state_t *st = (stream_state_t *)userdata;
    size_t n = size * nmemb;
    if (st->first) {
        st->first = false;
        st->ttft_ms = now_ms() - st->t0;
    }
    if (!buf_push(&st->buf, (const uint8_t *)ptr, n)) return 0;
    return n;
}

/* ── tiny JSON read helpers (good enough for methodology fields) ────────── */

/* Find the value-string for `"key":` in a JSON document. Returns a freshly-
 * allocated unescaped UTF-8 string, or NULL if not found / not a string.
 * Caller frees. Handles \" \\ \/ \n \r \t \uXXXX (basic ASCII). */
static char *json_extract_string(const char *json, const char *key) {
    char needle[128];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return NULL;
    p = strchr(p + strlen(needle), ':');
    if (!p) return NULL;
    p++;
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != '"') return NULL;
    p++;
    size_t cap = 256, len = 0;
    char *out = (char *)malloc(cap);
    if (!out) return NULL;
    while (*p && *p != '"') {
        if (len + 4 >= cap) { cap *= 2; out = (char *)realloc(out, cap); if (!out) return NULL; }
        if (*p == '\\') {
            p++;
            switch (*p) {
                case '"': out[len++] = '"'; p++; break;
                case '\\': out[len++] = '\\'; p++; break;
                case '/': out[len++] = '/'; p++; break;
                case 'n': out[len++] = '\n'; p++; break;
                case 'r': out[len++] = '\r'; p++; break;
                case 't': out[len++] = '\t'; p++; break;
                case 'u': {
                    /* Minimal: only handle BMP characters that fit ASCII. */
                    if (strlen(p) < 5) { out[len++] = '?'; p++; break; }
                    unsigned u = 0;
                    for (int i = 1; i <= 4; i++) {
                        char c = p[i];
                        u <<= 4;
                        if (c >= '0' && c <= '9') u |= c - '0';
                        else if (c >= 'a' && c <= 'f') u |= c - 'a' + 10;
                        else if (c >= 'A' && c <= 'F') u |= c - 'A' + 10;
                    }
                    /* UTF-8 encode */
                    if (u < 0x80) out[len++] = (char)u;
                    else if (u < 0x800) { out[len++] = 0xC0 | (u >> 6); out[len++] = 0x80 | (u & 0x3F); }
                    else { out[len++] = 0xE0 | (u >> 12); out[len++] = 0x80 | ((u >> 6) & 0x3F); out[len++] = 0x80 | (u & 0x3F); }
                    p += 5;
                    break;
                }
                default: out[len++] = *p; if (*p) p++; break;
            }
        } else {
            out[len++] = *p++;
        }
    }
    out[len] = 0;
    return out;
}

/* ── token counters via libcodec ────────────────────────────────────────── */

static int count_jsonsse(const uint8_t *data, size_t len) {
    int n = 0;
    size_t i = 0;
    while (i < len) {
        size_t j = i;
        while (j < len && data[j] != '\n') j++;
        if (j - i > 6 && memcmp(data + i, "data: ", 6) == 0
                && !memmem(data + i, j - i, "[DONE]", 6)) n++;
        i = j + 1;
    }
    return n;
}

static int count_msgpack(const uint8_t *data, size_t len) {
    int total = 0;
    size_t pos = 0;
    while (pos < len) {
        codec_frame_t f;
        size_t consumed = 0;
        if (codec_decode_msgpack(data + pos, len - pos, &f, &consumed) != CODEC_OK) break;
        total += (int)f.ids_len;
        codec_frame_destroy(&f);
        if (consumed == 0) break;
        pos += consumed;
    }
    return total;
}

static int count_protobuf(const uint8_t *data, size_t len) {
    int total = 0;
    size_t pos = 0;
    while (pos + 4 <= len) {
        uint32_t L = ((uint32_t)data[pos] << 24) | ((uint32_t)data[pos+1] << 16)
                   | ((uint32_t)data[pos+2] << 8)  |  (uint32_t)data[pos+3];
        pos += 4;
        if (pos + L > len) break;
        codec_frame_t f;
        if (codec_decode_protobuf_frame(data + pos, L, &f) != CODEC_OK) break;
        total += (int)f.ids_len;
        codec_frame_destroy(&f);
        pos += L;
    }
    return total;
}

/* ── per-cell driver ────────────────────────────────────────────────────── */

typedef struct {
    int wire_bytes;
    double ttft_ms;
    double total_ms;
    int tokens;
    char error[256]; /* empty = no error */
} cell_t;

static void run_one(CURL *curl, const char *endpoint, const char *model,
                    const char *prompt, int size, const char *format,
                    const char *encoding, cell_t *out) {
    out->wire_bytes = -1;
    out->ttft_ms = -1;
    out->total_ms = -1;
    out->tokens = 0;
    out->error[0] = 0;

    /* Build URL + body */
    char url[512];
    snprintf(url, sizeof(url), "%s/v1/completions", endpoint);

    char body[8192];  /* 8K covers the canonical 2K-token essay prompt with escapes */
    int blen;
    /* Escape the prompt's quotes: it can contain " from the canonical
     * 2K-token essay prompt. We only need to escape \" and \\. */
    char *escaped = malloc(strlen(prompt) * 2 + 1);
    char *e = escaped;
    for (const char *p = prompt; *p; p++) {
        if (*p == '"' || *p == '\\') *e++ = '\\';
        *e++ = *p;
    }
    *e = 0;
    if (strcmp(format, "json") == 0) {
        blen = snprintf(body, sizeof(body),
            "{\"model\":\"%s\",\"prompt\":\"%s\",\"max_tokens\":%d,"
            "\"stream\":true,\"temperature\":0.0}",
            model, escaped, size);
    } else {
        blen = snprintf(body, sizeof(body),
            "{\"model\":\"%s\",\"prompt\":\"%s\",\"max_tokens\":%d,"
            "\"stream\":true,\"temperature\":0.0,\"stream_format\":\"%s\"}",
            model, escaped, size, format);
    }
    free(escaped);
    if (blen < 0 || blen >= (int)sizeof(body)) {
        snprintf(out->error, sizeof(out->error), "body buffer too small (%d)", blen);
        return;
    }

    stream_state_t st = {0};
    st.first = true;
    st.t0 = now_ms();

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    char enc_hdr[64];
    snprintf(enc_hdr, sizeof(enc_hdr), "Accept-Encoding: %s", encoding);
    headers = curl_slist_append(headers, enc_hdr);

    curl_easy_reset(curl);
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &st);
    /* Capture Content-Encoding + Codec-Zstd-Dict so the zstd path can
     * verify the server's dict against our loaded registry. */
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, curl_header_cb);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &st);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 180L);
    /* CRITICAL: do NOT set CURLOPT_ACCEPT_ENCODING: that would tell
     * curl to auto-decompress. That would corrupt our wire-byte count.
     * The Accept-Encoding header is set manually above. */
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);

    CURLcode rc = curl_easy_perform(curl);
    long code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
    out->total_ms = now_ms() - st.t0;
    curl_slist_free_all(headers);

    if (rc != CURLE_OK) {
        snprintf(out->error, sizeof(out->error), "curl: %s", curl_easy_strerror(rc));
        stream_state_reset(&st);
        return;
    }
    if (code / 100 != 2) {
        snprintf(out->error, sizeof(out->error), "HTTP %ld", code);
        stream_state_reset(&st);
        return;
    }
    out->wire_bytes = (int)st.buf.len;
    out->ttft_ms = st.first ? out->total_ms : st.ttft_ms;

    /* Token counting.
     *
     *   identity: bytes are already the canonical content; count directly.
     *   zstd: verify Codec-Zstd-Dict against the loaded dict registry
     *                     (codec_select_zstd_dict_for_response), decompress with
     *                     libzstd, then count post-decompression tokens.
     *   gzip / br: libcodec doesn't link a gzip/brotli decoder. We
     *                     report the requested `size` (same fallback the bench
     *                     used before this change). The primary signal
     *                     (wire_bytes / TTFB / total_ms) is captured pre-decompress
     *                     on the raw socket and is accurate regardless. */
    if (strcmp(encoding, "identity") == 0) {
        if (strcmp(format, "json") == 0)
            out->tokens = count_jsonsse(st.buf.data, st.buf.len);
        else if (strcmp(format, "msgpack") == 0)
            out->tokens = count_msgpack(st.buf.data, st.buf.len);
        else if (strcmp(format, "protobuf") == 0)
            out->tokens = count_protobuf(st.buf.data, st.buf.len);
    } else if (strcmp(encoding, "zstd") == 0) {
        /* Build the header pair for codec_select_zstd_dict_for_response.
         * Two entries are enough: Content-Encoding + Codec-Zstd-Dict. */
        codec_header_kv_t resp_headers[2];
        size_t n_resp = 0;
        if (st.content_encoding) {
            resp_headers[n_resp].name  = "Content-Encoding";
            resp_headers[n_resp].value = st.content_encoding;
            n_resp++;
        }
        if (st.codec_zstd_dict) {
            resp_headers[n_resp].name  = "Codec-Zstd-Dict";
            resp_headers[n_resp].value = st.codec_zstd_dict;
            n_resp++;
        }
        codec_zstd_dict_entry_t reg[CODEC_DEMO_MAX_DICTS];
        size_t n_reg = snapshot_dict_registry(reg);

        const uint8_t *dict_bytes = NULL;
        size_t dict_len = 0;
        codec_zstd_dict_result_t r = codec_select_zstd_dict_for_response(
            resp_headers, n_resp, reg, n_reg, &dict_bytes, &dict_len);

        if (r == CODEC_ZSTD_DICT_NOT_ZSTD) {
            /* Server didn't actually zstd-compress (e.g. Accept-Encoding
             * downgrade); count as identity. */
            if (strcmp(format, "json") == 0)
                out->tokens = count_jsonsse(st.buf.data, st.buf.len);
            else if (strcmp(format, "msgpack") == 0)
                out->tokens = count_msgpack(st.buf.data, st.buf.len);
            else if (strcmp(format, "protobuf") == 0)
                out->tokens = count_protobuf(st.buf.data, st.buf.len);
        } else if (r != CODEC_ZSTD_DICT_OK) {
            static const char *NAMES[] = {
                "ok", "not_zstd", "missing Codec-Zstd-Dict",
                "malformed Codec-Zstd-Dict", "Codec-Zstd-Dict mismatch"
            };
            snprintf(out->error, sizeof(out->error),
                "zstd dict select: %s%s%s",
                NAMES[(int)r],
                st.codec_zstd_dict ? " (server used " : "",
                st.codec_zstd_dict ? st.codec_zstd_dict : "");
            if (st.codec_zstd_dict) {
                size_t L = strlen(out->error);
                if (L + 2 < sizeof(out->error)) {
                    out->error[L]   = ')';
                    out->error[L+1] = 0;
                }
            }
            out->tokens = 0;
        } else {
#ifdef CODEC_DEMO_HAVE_ZSTD
            uint8_t *decompressed = NULL;
            size_t decompressed_len = 0;
            if (zstd_decompress_with_dict(st.buf.data, st.buf.len,
                                          dict_bytes, dict_len,
                                          &decompressed, &decompressed_len)) {
                if (strcmp(format, "msgpack") == 0)
                    out->tokens = count_msgpack(decompressed, decompressed_len);
                else if (strcmp(format, "protobuf") == 0)
                    out->tokens = count_protobuf(decompressed, decompressed_len);
                else if (strcmp(format, "json") == 0)
                    out->tokens = count_jsonsse(decompressed, decompressed_len);
                free(decompressed);
            } else {
                snprintf(out->error, sizeof(out->error),
                    "libzstd decompress failed (dict ok, %zu wire bytes)",
                    st.buf.len);
                out->tokens = 0;
            }
#else
            /* libzstd wasn't available at build time. The wire numbers are
             * still accurate; flag the row so reviewers see why tokens=0. */
            snprintf(out->error, sizeof(out->error),
                "libzstd unavailable at build time");
            out->tokens = 0;
            (void)dict_bytes; (void)dict_len;
#endif
        }
    } else {
        /* gzip / br: wire bytes correct, fall back to requested size
         * for tokens (deterministic at temp=0 in normal completion). */
        out->tokens = size;
    }

    stream_state_reset(&st);
}

/* ── prompts ────────────────────────────────────────────────────────────── */

/* Walk up from `start` looking for the marker file
 * "packages/bench/<rel>" (same anchor find_repo_root_and_load uses).
 * Returns a heap-allocated absolute repo-root path on success, NULL on
 * miss. Caller frees. */
static char *find_repo_root(const char *start, const char *anchor_rel) {
    char *abs = realpath(start, NULL);
    char *p = abs ? strdup(abs) : strdup(start);
    free(abs);
    char *slash;
    char *root = NULL;
    while ((slash = strrchr(p, '/'))) {
        *slash = 0;
        char test[1024];
        snprintf(test, sizeof(test), "%s/%s", p, anchor_rel);
        FILE *f = fopen(test, "r");
        if (f) { fclose(f); root = strdup(p); break; }
    }
    free(p);
    return root;
}

static char *find_repo_root_and_load(const char *methodology_path,
                                     const char *prompts_rel,
                                     char **out_path) {
    /* Walk up from methodology_path looking for the file
     * "<root>/packages/bench/<prompts_rel>". methodology_path may be
     * relative: absolute-ify via realpath so the parent walk works. */
    char *abs = realpath(methodology_path, NULL);
    char *p = abs ? strdup(abs) : strdup(methodology_path);
    free(abs);
    char *slash;
    char *root = NULL;
    while ((slash = strrchr(p, '/'))) {
        *slash = 0;
        char test[1024];
        snprintf(test, sizeof(test), "%s/packages/bench/%s", p, prompts_rel);
        FILE *f = fopen(test, "r");
        if (f) { fclose(f); root = strdup(p); break; }
    }
    free(p);
    if (!root) return NULL;
    char *fp = (char *)malloc(strlen(root) + strlen(prompts_rel) + 32);
    sprintf(fp, "%s/packages/bench/%s", root, prompts_rel);
    *out_path = fp;
    free(root);
    /* Read full file. */
    FILE *f = fopen(fp, "r");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long L = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = (char *)malloc(L + 1);
    fread(buf, 1, L, f);
    buf[L] = 0;
    fclose(f);
    return buf;
}

/* Read the prompt for `size` from the prompts JSON. Looks for `"<size>": "..."`. */
static char *prompt_for_size(const char *prompts_json, int size) {
    char key[16];
    snprintf(key, sizeof(key), "%d", size);
    return json_extract_string(prompts_json, key);
}

/* ── matrix loop ────────────────────────────────────────────────────────── */

static const char *PATHS[][2] = {
    { "JSON-SSE (default)", "json" },
    { "Codec msgpack",      "msgpack" },
    { "Codec protobuf",     "protobuf" },
};
static const char *ENCODINGS[] = { "identity", "gzip", "br", "zstd" };

static int cmp_int(const void *a, const void *b) {
    return *(const int *)a - *(const int *)b;
}
static int cmp_dbl(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y ? 1 : 0;
}
static int median_int(int *xs, int n) {
    if (n == 0) return 0;
    qsort(xs, n, sizeof(int), cmp_int);
    return n % 2 ? xs[n/2] : (xs[n/2 - 1] + xs[n/2]) / 2;
}
static double median_dbl(double *xs, int n) {
    if (n == 0) return 0.0;
    qsort(xs, n, sizeof(double), cmp_dbl);
    return n % 2 ? xs[n/2] : (xs[n/2 - 1] + xs[n/2]) / 2.0;
}

static char *read_file(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long L = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = (char *)malloc(L + 1);
    fread(buf, 1, L, f);
    buf[L] = 0;
    fclose(f);
    return buf;
}

static char *git_head_sha(void) {
    FILE *p = popen("git rev-parse HEAD 2>/dev/null", "r");
    if (!p) return strdup("");
    char buf[64] = {0};
    fgets(buf, sizeof(buf), p);
    pclose(p);
    /* Strip newline. */
    char *nl = strchr(buf, '\n'); if (nl) *nl = 0;
    return strdup(buf);
}

static void render_int_array(FILE *out, const char *key, int *xs, int n) {
    fprintf(out, "    \"%s\": [", key);
    for (int i = 0; i < n; i++) fprintf(out, "%s%d", i ? ", " : "", xs[i]);
    fputs("],\n", out);
}
static void render_dbl_array(FILE *out, const char *key, double *xs, int n) {
    fprintf(out, "    \"%s\": [", key);
    for (int i = 0; i < n; i++) fprintf(out, "%s%.6f", i ? ", " : "", xs[i]);
    fputs("],\n", out);
}

int main(int argc, char **argv) {
    const char *methodology_path = NULL;
    const char *out_path = NULL;
    int sizes[16]; int n_sizes = 0;
    int reps = 2;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--methodology") && i + 1 < argc) methodology_path = argv[++i];
        else if (!strcmp(argv[i], "--out") && i + 1 < argc)    out_path = argv[++i];
        else if (!strcmp(argv[i], "--reps") && i + 1 < argc)   reps = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--sizes")) {
            while (i + 1 < argc && isdigit((unsigned char)argv[i+1][0]) && n_sizes < 16) {
                sizes[n_sizes++] = atoi(argv[++i]);
            }
        }
    }
    if (!methodology_path || !out_path) {
        fprintf(stderr, "usage: codec-matrix --methodology PATH --out PATH [--sizes ...] [--reps N]\n");
        return 1;
    }
    if (n_sizes == 0) { sizes[0] = 64; sizes[1] = 512; sizes[2] = 2048; n_sizes = 3; }

    char *methodology = read_file(methodology_path);
    if (!methodology) { perror("methodology"); return 1; }

    char *endpoint = json_extract_string(methodology, "endpoint");
    char *model = json_extract_string(methodology, "id");
    char *prompts_rel = json_extract_string(methodology, "prompts_file");
    if (!endpoint || !model || !prompts_rel) {
        fprintf(stderr, "could not extract methodology fields\n");
        return 1;
    }
    char *prompts_path = NULL;
    char *prompts_json = find_repo_root_and_load(methodology_path, prompts_rel, &prompts_path);
    if (!prompts_json) {
        fprintf(stderr, "prompts file not found (rel: %s)\n", prompts_rel);
        return 1;
    }
    /* Load reference zstd dicts so we can decompress dict-zstd responses.
     * Mirrors codec_demo.matrix_run.load_zstd_dict_files. Anchor lookup
     * on packages/bench/<prompts_rel> so we land on the same repo root
     * as the prompts file. If the server is configured to use a different
     * dict, the wire/ttft numbers still land: only the decoded-tokens
     * count drops to 0 with a "Codec-Zstd-Dict mismatch" error string on
     * the row. That keeps reviewers honest. */
    {
        char anchor[256];
        snprintf(anchor, sizeof(anchor), "packages/bench/%s", prompts_rel);
        char *repo_root = find_repo_root(methodology_path, anchor);
        if (repo_root) {
            char dpath[1024];
            snprintf(dpath, sizeof(dpath),
                     "%s/dictionaries/qwen2.5-synth-msgpack-v1.dict", repo_root);
            load_zstd_dict_file(dpath);
            snprintf(dpath, sizeof(dpath),
                     "%s/dictionaries/qwen2.5-synth-protobuf-v1.dict", repo_root);
            load_zstd_dict_file(dpath);
            free(repo_root);
        } else {
            fprintf(stderr, "warning: could not locate repo root for dict loading; "
                            "dict-zstd cells will fail with UNKNOWN_HASH\n");
        }
    }
    char *commit = git_head_sha();

    /* libcurl init. */
    curl_global_init(CURL_GLOBAL_DEFAULT);
    CURL *curl = curl_easy_init();

    /* Open output file. */
    FILE *out = fopen(out_path, "w");
    if (!out) { perror("out"); return 1; }

    /* Emit envelope.
     *
     * For the methodology block we write the original file's text up to
     * the closing brace, append our `client` and `bench_tool` blocks,
     * then close. This is a hack, but the methodology JSON as written by
     * capture_methodology.py is line-organised and has these blocks at
     * the top level: substituting the entire blocks via printf is
     * unsafe. We splice into the existing JSON structure instead.
     *
     * Simpler implementation that mirrors the other ports' "fill in
     * client + bench_tool" semantics: write a fresh JSON document that
     * embeds the original methodology as a sub-object with our blocks
     * substituted. This duplicates fields but is structurally correct
     * and the aggregator validates by fingerprint. */
    fputs("{\n  \"schema_version\": \"1\",\n", out);
    fputs("  \"methodology\": ", out);
    /* Naive: emit the whole methodology then append a comment-via-key of
     * our blocks. Aggregator accepts both because it walks the methodology
     * as a dict. `client` + `bench_tool` keys appear once each (Python
     * json.load uses last-wins on duplicates, JS too). To keep it simple,
     * we strip the trailing `}` from methodology and append our blocks
     * as new keys. */
    {
        size_t L = strlen(methodology);
        /* Trim trailing whitespace + closing brace. */
        while (L > 0 && (methodology[L-1] == '\n' || methodology[L-1] == ' '
                         || methodology[L-1] == '\t')) L--;
        if (L > 0 && methodology[L-1] == '}') L--;
        fwrite(methodology, 1, L, out);
        fprintf(out,
            ",\n  \"client\": {\n"
            "    \"lang\": \"c\",\n"
            "    \"lib_name\": \"libcodec\",\n"
            "    \"lib_version\": \"%s\",\n"
            "    \"lib_commit\": \"%s\",\n"
            "    \"runtime\": \"libcurl/%s, %s\"\n"
            "  },\n"
            "  \"bench_tool\": {\n"
            "    \"name\": \"demo-c/codec-matrix\",\n"
            "    \"version\": \"0.1.0\",\n"
            "    \"commit\": \"%s\",\n"
            "    \"reps\": %d,\n"
            "    \"warmup_reps\": 0,\n"
            "    \"aggregation\": \"median\",\n"
            "    \"ttft_definition\": \"wall-clock from request POST to first received byte (curl WRITEFUNCTION first invocation)\",\n"
            "    \"wire_bytes_definition\": \"raw socket bytes received before any Content-Encoding decompression (curl with no CURLOPT_ACCEPT_ENCODING)\",\n"
            "    \"total_ms_definition\": \"wall-clock from request POST to last byte\"\n"
            "  }\n}",
            codec_version(), commit, curl_version(), codec_version(), commit, reps);
    }
    fputs(",\n  \"rows\": [\n", out);

    int total_rows = 0;
    for (int si = 0; si < n_sizes; si++) {
        int size = sizes[si];
        char *prompt = prompt_for_size(prompts_json, size);
        if (!prompt) {
            fprintf(stderr, "no canonical prompt for size=%d\n", size);
            return 1;
        }
        fprintf(stderr, ">>> size=%d  prompt: '", size);
        for (int i = 0; i < 60 && prompt[i]; i++) fputc(prompt[i], stderr);
        fputs(strlen(prompt) > 60 ? "...'\n" : "'\n", stderr);

        for (size_t pi = 0; pi < sizeof(PATHS) / sizeof(PATHS[0]); pi++) {
            const char *label = PATHS[pi][0];
            const char *fmt   = PATHS[pi][1];
            for (size_t ei = 0; ei < sizeof(ENCODINGS) / sizeof(ENCODINGS[0]); ei++) {
                const char *enc = ENCODINGS[ei];
                int rep_wire[16]; int n_rw = 0;
                double rep_ttft[16]; int n_rt = 0;
                double rep_total[16]; int n_rto = 0;
                int tokens = 0;
                char err[256] = {0};
                for (int r = 0; r < reps && r < 16; r++) {
                    cell_t c = {0};
                    run_one(curl, endpoint, model, prompt, size, fmt, enc, &c);
                    if (c.wire_bytes >= 0) rep_wire[n_rw++] = c.wire_bytes;
                    if (c.ttft_ms >= 0)   rep_ttft[n_rt++] = c.ttft_ms;
                    if (c.total_ms >= 0)  rep_total[n_rto++] = c.total_ms;
                    if (c.tokens > tokens) tokens = c.tokens;
                    if (c.error[0]) snprintf(err, sizeof(err), "%s", c.error);
                }
                if (total_rows > 0) fputs(",\n", out);
                fputs("    {\n", out);
                fprintf(out, "      \"size\": %d,\n", size);
                fprintf(out, "      \"format\": \"%s\",\n", fmt);
                fprintf(out, "      \"encoding\": \"%s\",\n", enc);
                if (n_rw > 0) fprintf(out, "      \"wire_bytes\": %d,\n", median_int(rep_wire, n_rw));
                else          fprintf(out, "      \"wire_bytes\": null,\n");
                if (n_rt > 0) fprintf(out, "      \"ttft_ms\": %.3f,\n", median_dbl(rep_ttft, n_rt));
                else          fprintf(out, "      \"ttft_ms\": null,\n");
                if (n_rto > 0) fprintf(out, "      \"total_ms\": %.3f,\n", median_dbl(rep_total, n_rto));
                else           fprintf(out, "      \"total_ms\": null,\n");
                fprintf(out, "      \"tokens_emitted\": %d,\n", tokens);
                /* re-sort to median order is fine; reviewers want min/max bracket. */
                fputs("  ", out); render_int_array(out, "rep_wire_bytes", rep_wire, n_rw);
                fputs("  ", out); render_dbl_array(out, "rep_ttft_ms", rep_ttft, n_rt);
                fputs("  ", out); render_dbl_array(out, "rep_total_ms", rep_total, n_rto);
                if (err[0]) {
                    /* JSON-escape err. Naive: only handles \" and \\. */
                    fputs("      \"error\": \"", out);
                    for (char *p = err; *p; p++) {
                        if (*p == '"' || *p == '\\') fputc('\\', out);
                        fputc(*p, out);
                    }
                    fputs("\"\n", out);
                } else {
                    fputs("      \"error\": null\n", out);
                }
                fputs("    }", out);
                fprintf(stderr,
                    "    %-25s %-8s size=%5d  wire=%d  ttft=%.1f  total=%.1f  tokens=%d  %s\n",
                    label, enc, size,
                    n_rw > 0 ? median_int(rep_wire, n_rw) : -1,
                    n_rt > 0 ? median_dbl(rep_ttft, n_rt) : -1,
                    n_rto > 0 ? median_dbl(rep_total, n_rto) : -1,
                    tokens, err[0] ? err : "");
                total_rows++;
            }
        }
        free(prompt);
    }
    fputs("\n  ]\n}\n", out);
    fclose(out);

    fprintf(stderr, "\nwrote %s (%d rows)\n", out_path, total_rows);
    free(commit);
    free(prompts_json);
    free(prompts_path);
    free(prompts_rel);
    free(endpoint);
    free(model);
    free(methodology);
    free_dict_registry();
    curl_easy_cleanup(curl);
    curl_global_cleanup();
    return 0;
}
