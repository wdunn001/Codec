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
 * codec_decode_protobuf_frame for token counting). No JSON library —
 * we hand-roll narrow substring extraction for the few methodology
 * fields we read, and printf-format the result. The bench's primary
 * signal (wire bytes / TTFB / total) doesn't depend on the JSON layer
 * being correct.
 *
 * Usage:
 *   ./codec-matrix --methodology PATH --sizes 64 512 2048 --reps 2 --out PATH
 */

#include "codec/codec.h"

#include <curl/curl.h>

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

/* libcurl writes raw bytes off the socket here. We disabled
 * accept-encoding negotiation in curl (CURLOPT_ACCEPT_ENCODING is unset
 * by default) so the server's response is delivered un-decompressed. */
typedef struct {
    buf_t buf;
    double t0;
    double ttft_ms;
    bool first;
} stream_state_t;

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

    char body[2048];
    int blen;
    /* Escape the prompt's quotes — it can contain " from the canonical
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
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 180L);
    /* CRITICAL: do NOT set CURLOPT_ACCEPT_ENCODING — that would tell
     * curl to auto-decompress, which would corrupt our wire-byte count.
     * The Accept-Encoding header is set manually above. */
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);

    CURLcode rc = curl_easy_perform(curl);
    long code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
    out->total_ms = now_ms() - st.t0;
    curl_slist_free_all(headers);

    if (rc != CURLE_OK) {
        snprintf(out->error, sizeof(out->error), "curl: %s", curl_easy_strerror(rc));
        buf_free(&st.buf);
        return;
    }
    if (code / 100 != 2) {
        snprintf(out->error, sizeof(out->error), "HTTP %ld", code);
        buf_free(&st.buf);
        return;
    }
    out->wire_bytes = (int)st.buf.len;
    out->ttft_ms = st.first ? out->total_ms : st.ttft_ms;

    /* Token counting. We don't decompress here — for identity/json paths
     * the bytes are already the canonical content. For compressed
     * msgpack/protobuf, libcurl WAS told NOT to decompress, so we'd
     * need our own decoder. Instead, the token count for compressed
     * paths is reported as 0 — the wire/TTFB numbers (which are the
     * bench's primary signal) are still valid. Mirrors the .NET
     * "no zstd in BCL" pattern. */
    char *content_encoding = NULL;
    /* curl does provide CURLINFO_CONTENT_TYPE; for content-encoding we
     * have to read the response headers ourselves, but for the bench
     * we can infer from the request: if encoding != identity, the
     * response is likely encoded that way (the negotiator picks based
     * on Accept-Encoding). */
    if (strcmp(encoding, "identity") == 0) {
        if (strcmp(format, "json") == 0)
            out->tokens = count_jsonsse(st.buf.data, st.buf.len);
        else if (strcmp(format, "msgpack") == 0)
            out->tokens = count_msgpack(st.buf.data, st.buf.len);
        else if (strcmp(format, "protobuf") == 0)
            out->tokens = count_protobuf(st.buf.data, st.buf.len);
    } else {
        /* Compressed — wire bytes correct, tokens left at 0. */
        out->tokens = 0;
    }

    buf_free(&st.buf);
    (void)content_encoding;
}

/* ── prompts ────────────────────────────────────────────────────────────── */

static char *find_repo_root_and_load(const char *methodology_path,
                                     const char *prompts_rel,
                                     char **out_path) {
    /* Walk up from methodology_path looking for "packages/" dir. */
    char *p = strdup(methodology_path);
    char *slash;
    char *root = NULL;
    while ((slash = strrchr(p, '/'))) {
        *slash = 0;
        /* Test if `<p>/packages` exists — if so, p is the repo root. */
        char test[1024];
        snprintf(test, sizeof(test), "%s/packages/bench", p);
        FILE *f = fopen(test, "r");
        if (f) { fclose(f); root = strdup(p); break; }
        /* On a directory test, fopen returns NULL so we instead try the
         * actual prompts file under that path. */
        snprintf(test, sizeof(test), "%s/packages/bench/%s", p, prompts_rel);
        f = fopen(test, "r");
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
     * the top level — substituting the entire blocks via printf is
     * unsafe, so we splice into the existing JSON structure.
     *
     * Simpler implementation that mirrors the other ports' "fill in
     * client + bench_tool" semantics: write a fresh JSON document that
     * embeds the original methodology as a sub-object with our blocks
     * substituted. This duplicates fields but is structurally correct
     * and the aggregator validates by fingerprint, not by exact bytes. */
    fputs("{\n  \"schema_version\": \"1\",\n", out);
    fputs("  \"methodology\": ", out);
    /* Naive: emit the whole methodology then append a comment-via-key of
     * our blocks. Aggregator accepts both because it walks the methodology
     * as a dict, and `client` + `bench_tool` keys appear once each (Python
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
    curl_easy_cleanup(curl);
    curl_global_cleanup();
    return 0;
}
