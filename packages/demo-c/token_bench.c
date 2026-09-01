/* SPDX-License-Identifier: MIT
 *
 * Per-language tokenize/detokenize micro-benchmark: C99.
 * Cross-language companion of codec_demo.token_bench (Python), demo/src/
 * token_bench.ts, demo-rust/src/token_bench.rs, demo-dotnet/TokenBench.cs,
 * demo-java/.../TokenBench.java.
 *
 * libcodec doesn't yet ship a BPE encoder (per top-level README; the C
 * client is detokenize-only for BPE), so this driver only times decode.
 * encode_* fields in the output are null.
 *
 * Usage:
 *   ./build/codec-token-bench \
 *     --map ../../codec-maps/maps/qwen/qwen2.json \
 *     --corpus ../bench/golden/qwen2.json \
 *     --reps 200 --warmup 20 \
 *     --out ../bench/results/<run-id>/token/c.json
 */
#define _POSIX_C_SOURCE 199309L

#include <codec/codec.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ── Helpers ────────────────────────────────────────────────────────────── */

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1.0e6;
}

static char *read_file(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[n] = '\0';
    if (out_len) *out_len = n;
    return buf;
}

static int cmp_double(const void *a, const void *b) {
    double da = *(const double *)a, db = *(const double *)b;
    return (da > db) - (da < db);
}

static double median(double *sorted, size_t n) {
    if (n == 0) return 0;
    size_t mid = n / 2;
    return (n % 2 == 0) ? (sorted[mid - 1] + sorted[mid]) / 2.0 : sorted[mid];
}

static double percentile(double *sorted, size_t n, double pct) {
    if (n == 0) return 0;
    size_t idx = (size_t)((pct / 100.0) * (n - 1) + 0.5);
    if (idx >= n) idx = n - 1;
    return sorted[idx];
}

/* Tiny ad-hoc JSON walker. We don't need a full parser: only need to
 * pull `samples[].ids[]` and `samples[].text` from a known-shape file. */
static const char *find_field(const char *s, const char *key) {
    size_t klen = strlen(key);
    while ((s = strstr(s, key)) != NULL) {
        if (s > (char *)0 && s[-1] == '"' && s[klen] == '"' && (s[klen + 1] == ':' || (s[klen + 1] == ' ' && s[klen + 2] == ':'))) {
            return s + klen + 1;
        }
        s++;
    }
    return NULL;
}

/* Parse an integer array `[1, 2, 3]` starting at `*pp`. Returns malloc'd
 * uint32_t* of length *n_out. `*pp` is advanced past the closing bracket. */
static uint32_t *parse_int_array(const char **pp, size_t *n_out) {
    const char *p = *pp;
    while (*p && *p != '[') p++;
    if (*p != '[') return NULL;
    p++;
    size_t cap = 16, n = 0;
    uint32_t *arr = malloc(cap * sizeof(uint32_t));
    while (*p && *p != ']') {
        while (*p == ' ' || *p == ',' || *p == '\n' || *p == '\r' || *p == '\t') p++;
        if (*p == ']') break;
        char *end;
        long v = strtol(p, &end, 10);
        if (end == p) break;
        if (n >= cap) { cap *= 2; arr = realloc(arr, cap * sizeof(uint32_t)); }
        arr[n++] = (uint32_t)v;
        p = end;
    }
    if (*p == ']') p++;
    *n_out = n;
    *pp = p;
    return arr;
}

/* Parse a JSON string literal starting at *pp. Returns malloc'd
 * NUL-terminated UTF-8 with escape sequences un-escaped (we only need
 * the common ones for this bench corpus: \", \\, \n, \t, \r). */
static char *parse_string(const char **pp) {
    const char *p = *pp;
    while (*p && *p != '"') p++;
    if (*p != '"') return NULL;
    p++;
    size_t cap = 64, n = 0;
    char *s = malloc(cap);
    while (*p && *p != '"') {
        char c = *p;
        if (c == '\\' && p[1]) {
            char esc = p[1];
            switch (esc) {
                case 'n': c = '\n'; break;
                case 't': c = '\t'; break;
                case 'r': c = '\r'; break;
                case '"': case '\\': case '/': c = esc; break;
                default: c = esc; break;
            }
            p += 2;
        } else {
            p++;
        }
        if (n + 1 >= cap) { cap *= 2; s = realloc(s, cap); }
        s[n++] = c;
    }
    if (*p == '"') p++;
    s[n] = '\0';
    *pp = p;
    return s;
}

/* ── Main ──────────────────────────────────────────────────────────────── */

int main(int argc, char **argv) {
    const char *map_path = NULL, *corpus_path = NULL, *out_path = NULL;
    int reps = 200, warmup = 20;
    for (int i = 1; i + 1 < argc; i++) {
        if (!strcmp(argv[i], "--map")) map_path = argv[++i];
        else if (!strcmp(argv[i], "--corpus")) corpus_path = argv[++i];
        else if (!strcmp(argv[i], "--out")) out_path = argv[++i];
        else if (!strcmp(argv[i], "--reps")) reps = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--warmup")) warmup = atoi(argv[++i]);
    }
    if (!map_path || !corpus_path || !out_path) {
        fprintf(stderr, "usage: %s --map <map.json> --corpus <golden.json> --out <out.json> [--reps N] [--warmup N]\n", argv[0]);
        return 2;
    }

    size_t map_len, corpus_len;
    char *map_text = read_file(map_path, &map_len);
    char *corpus_text = read_file(corpus_path, &corpus_len);
    if (!map_text || !corpus_text) {
        fprintf(stderr, "failed to read input files\n");
        return 1;
    }

    codec_tokenizer_map_t *map = NULL;
    if (codec_map_from_json(map_text, map_len, &map) != CODEC_OK) {
        fprintf(stderr, "failed to parse map\n");
        return 1;
    }

    /* Parse samples: array of {text, ids}. */
    size_t cap = 64, sample_count = 0;
    char **texts = malloc(cap * sizeof(char *));
    uint32_t **ids_array = malloc(cap * sizeof(uint32_t *));
    size_t *ids_lens = malloc(cap * sizeof(size_t));
    size_t total_text_bytes = 0, total_tokens = 0;

    const char *p = corpus_text;
    /* Find "samples": [ */
    const char *samples_key = find_field(p, "samples");
    if (samples_key) {
        p = samples_key;
        while (*p && *p != '[') p++;
        if (*p == '[') {
            p++;
            while (*p) {
                while (*p == ' ' || *p == ',' || *p == '\n' || *p == '\r' || *p == '\t') p++;
                if (*p != '{') break;
                p++;
                /* Look for "text": "..." then "ids": [...] */
                char *text = NULL;
                uint32_t *ids = NULL;
                size_t ids_n = 0;
                int depth = 1;
                while (*p && depth > 0) {
                    if (*p == '"') {
                        /* Check if this is a field name. */
                        const char *q = p;
                        if (!strncmp(q, "\"text\"", 6)) {
                            const char *r = q + 6;
                            while (*r && *r != '"') r++;
                            text = parse_string(&r);
                            p = r;
                            continue;
                        } else if (!strncmp(q, "\"ids\"", 5)) {
                            const char *r = q + 5;
                            ids = parse_int_array(&r, &ids_n);
                            p = r;
                            continue;
                        }
                        /* Skip generic string. */
                        p++;
                        while (*p && *p != '"') {
                            if (*p == '\\' && p[1]) p++;
                            p++;
                        }
                        if (*p == '"') p++;
                        continue;
                    }
                    if (*p == '{') depth++;
                    if (*p == '}') depth--;
                    p++;
                }
                if (text && ids) {
                    if (sample_count >= cap) {
                        cap *= 2;
                        texts = realloc(texts, cap * sizeof(char *));
                        ids_array = realloc(ids_array, cap * sizeof(uint32_t *));
                        ids_lens = realloc(ids_lens, cap * sizeof(size_t));
                    }
                    texts[sample_count] = text;
                    ids_array[sample_count] = ids;
                    ids_lens[sample_count] = ids_n;
                    total_text_bytes += strlen(text);
                    total_tokens += ids_n;
                    sample_count++;
                } else {
                    free(text);
                    free(ids);
                }
            }
        }
    }

    if (sample_count == 0) {
        fprintf(stderr, "no samples parsed from corpus\n");
        return 1;
    }

    codec_detokenizer_t *detok = NULL;
    if (codec_detokenizer_new(map, &detok) != CODEC_OK) {
        fprintf(stderr, "failed to create detokenizer\n");
        return 1;
    }
    codec_detokenize_opts_t opts = { .partial = false, .render_special = false };

    /* Warmup */
    for (int r = 0; r < warmup; r++) {
        for (size_t i = 0; i < sample_count; i++) {
            char *out = NULL; size_t out_len = 0;
            codec_detokenizer_render(detok, ids_array[i], ids_lens[i], opts, &out, &out_len);
            free(out);
        }
        codec_detokenizer_reset(detok);
    }

    /* Measured reps: decode only (no BPE encoder shipped in libcodec yet). */
    double *decode_ms = malloc((size_t)reps * sizeof(double));
    for (int r = 0; r < reps; r++) {
        double t0 = now_ms();
        for (size_t i = 0; i < sample_count; i++) {
            char *out = NULL; size_t out_len = 0;
            codec_detokenizer_render(detok, ids_array[i], ids_lens[i], opts, &out, &out_len);
            free(out);
        }
        codec_detokenizer_reset(detok);
        decode_ms[r] = now_ms() - t0;
    }

    qsort(decode_ms, (size_t)reps, sizeof(double), cmp_double);
    double dec_med = median(decode_ms, (size_t)reps);
    double dec_p99 = percentile(decode_ms, (size_t)reps, 99);
    double dec_tps = dec_med > 0 ? ((double)total_tokens / dec_med * 1000.0) : 0;

    /* Compute SHA256 of map + corpus for traceability. */
    /* libcodec exposes codec_safety_policy_verify_sha256, but we want the
     * raw hash; emit a simple FNV-1a hash labeled `hash64:` to avoid
     * pulling another dep into this tiny driver. */
    uint64_t map_h = 1469598103934665603ULL;
    for (size_t i = 0; i < map_len; i++) {
        map_h ^= (uint64_t)(uint8_t)map_text[i];
        map_h *= 1099511628211ULL;
    }
    uint64_t corp_h = 1469598103934665603ULL;
    for (size_t i = 0; i < corpus_len; i++) {
        corp_h ^= (uint64_t)(uint8_t)corpus_text[i];
        corp_h *= 1099511628211ULL;
    }

    /* Captured-at UTC */
    time_t t = time(NULL);
    struct tm gm; gmtime_r(&t, &gm);
    char captured_at[32];
    strftime(captured_at, sizeof(captured_at), "%Y-%m-%dT%H:%M:%SZ", &gm);

    /* libcodec version + map id */
    const char *map_id = codec_map_id(map);

    /* Emit JSON. */
    FILE *out = fopen(out_path, "wb");
    if (!out) { fprintf(stderr, "failed to open out\n"); return 1; }
    fprintf(out,
        "{\n"
        "  \"schema_version\": \"1\",\n"
        "  \"kind\": \"token_bench\",\n"
        "  \"captured_at\": \"%s\",\n"
        "  \"client\": {\n"
        "    \"lang\": \"c\",\n"
        "    \"lib_name\": \"libcodec\",\n"
        "    \"lib_version\": \"%s\",\n"
        "    \"runtime\": \"C99\"\n"
        "  },\n"
        "  \"map\": {\n"
        "    \"id\": \"%s\",\n"
        "    \"sha256\": \"hash64:%016lx\"\n"
        "  },\n"
        "  \"corpus\": {\n"
        "    \"path\": \"%s\",\n"
        "    \"sha256\": \"hash64:%016lx\",\n"
        "    \"samples\": %zu,\n"
        "    \"total_text_bytes\": %zu,\n"
        "    \"total_tokens\": %zu\n"
        "  },\n"
        "  \"reps\": %d,\n"
        "  \"warmup_reps\": %d,\n"
        "  \"encode_ms_total_median\": null,\n"
        "  \"encode_ms_total_p99\": null,\n"
        "  \"decode_ms_total_median\": %.6f,\n"
        "  \"decode_ms_total_p99\": %.6f,\n"
        "  \"encode_tokens_per_sec\": null,\n"
        "  \"decode_tokens_per_sec\": %.6f,\n"
        "  \"note\": \"libcodec is detokenize-only; encode_* are null pending C BPE encoder.\"\n"
        "}\n",
        captured_at,
        codec_version(),
        map_id ? map_id : "",
        (unsigned long)map_h,
        corpus_path,
        (unsigned long)corp_h,
        sample_count,
        total_text_bytes,
        total_tokens,
        reps, warmup,
        dec_med, dec_p99,
        dec_tps
    );
    fclose(out);

    fprintf(stderr,
        "  c       encode=  -    (n/a: no BPE encoder)  decode=%6.2f ms (%10.0f tok/s)  → %s\n",
        dec_med, dec_tps, out_path);

    /* Cleanup */
    for (size_t i = 0; i < sample_count; i++) {
        free(texts[i]);
        free(ids_array[i]);
    }
    free(texts); free(ids_array); free(ids_lens); free(decode_ms);
    codec_detokenizer_free(detok);
    codec_map_free(map);
    free(map_text); free(corpus_text);
    return 0;
}
