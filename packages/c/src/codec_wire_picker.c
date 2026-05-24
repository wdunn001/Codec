/*
 * codec_wire_picker.c — implementation of the wire-compress picker.
 *
 * SPDX-License-Identifier: MIT
 *
 * Mirrors packages/wire-compress/src/index.ts at v0.5.0. See the header
 * file (codec_wire_picker.h) for the cross-language contract.
 */

#include "codec/codec_wire_picker.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Stack profile constants ────────────────────────────────────────────── */

const codec_wire_stack_profile_t CODEC_WIRE_STACK_PROFILE_DEFAULT = {
    .name = "default",
    .gzip = { .wire_coeff = 0.05,  .ttft_ratio = 1.0 },
    .br   = { .wire_coeff = 0.5,   .ttft_ratio = 1.0 },
    .zstd = { .wire_coeff = 0.04,  .ttft_ratio = 1.0 },
};

const codec_wire_stack_profile_t CODEC_WIRE_STACK_PROFILE_SGLANG = {
    .name = "sglang",
    .gzip = { .wire_coeff = 0.023, .ttft_ratio = 1.0 },
    .br   = { .wire_coeff = 0.733, .ttft_ratio = 1.0 },
    .zstd = { .wire_coeff = 0.017, .ttft_ratio = 1.0 },
};

const codec_wire_stack_profile_t CODEC_WIRE_STACK_PROFILE_LLAMA_CPP = {
    .name = "llama.cpp",
    .gzip = { .wire_coeff = 1.0, .ttft_ratio = 1.0 },
    .br   = { .wire_coeff = 1.0, .ttft_ratio = 1.0 },
    .zstd = { .wire_coeff = 1.0, .ttft_ratio = 1.0 },
};

const codec_wire_stack_profile_t *codec_wire_profile_for(const char *name) {
    if (!name) return &CODEC_WIRE_STACK_PROFILE_DEFAULT;
    if (strcmp(name, "default")   == 0) return &CODEC_WIRE_STACK_PROFILE_DEFAULT;
    if (strcmp(name, "sglang")    == 0) return &CODEC_WIRE_STACK_PROFILE_SGLANG;
    if (strcmp(name, "llama.cpp") == 0) return &CODEC_WIRE_STACK_PROFILE_LLAMA_CPP;
    return &CODEC_WIRE_STACK_PROFILE_DEFAULT;
}

/* ── Name tables ────────────────────────────────────────────────────────── */

static const char *const ENCODING_NAMES[] = {
    [CODEC_WIRE_ENC_IDENTITY] = "identity",
    [CODEC_WIRE_ENC_GZIP]     = "gzip",
    [CODEC_WIRE_ENC_BR]       = "br",
    [CODEC_WIRE_ENC_ZSTD]     = "zstd",
};

const char *codec_wire_encoding_name(codec_wire_encoding_t enc) {
    if ((int)enc < 0 || (int)enc > CODEC_WIRE_ENC_ZSTD) return "?";
    return ENCODING_NAMES[enc];
}

static const char *const REASON_NAMES[] = {
    [CODEC_WIRE_REASON_DICT_ZSTD_DEFAULT]          = "dict_zstd_default",
    [CODEC_WIRE_REASON_PER_STACK_OVERRODE_ZSTD]    = "per_stack_overrode_zstd",
    [CODEC_WIRE_REASON_GZIP_NO_ZSTD_IN_ACCEPT]     = "gzip_no_zstd_in_accept",
    [CODEC_WIRE_REASON_GZIP_NO_DICT]               = "gzip_no_dict",
    [CODEC_WIRE_REASON_GZIP_MIDDLEWARE_DISABLED]   = "gzip_middleware_disabled",
    [CODEC_WIRE_REASON_BR_CONTENT_SAMPLE_LOW_ENTROPY] = "br_content_sample_low_entropy",
    [CODEC_WIRE_REASON_BR_FALLBACK_NO_GZIP]        = "br_fallback_no_gzip",
    [CODEC_WIRE_REASON_PER_STACK_OVERRODE_BR]      = "per_stack_overrode_br",
    [CODEC_WIRE_REASON_IDENTITY_LAST_RESORT]       = "identity_last_resort",
};

const char *codec_wire_pick_reason_name(codec_wire_pick_reason_t code) {
    if ((int)code < 0 || (int)code > CODEC_WIRE_REASON_IDENTITY_LAST_RESORT) return "?";
    return REASON_NAMES[code];
}

/* ── Parse helpers ──────────────────────────────────────────────────────── */

static char ascii_lower(char c) {
    return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
}

/* Case-insensitive compare of a [s, e) span against a NUL-terminated
 * literal. */
static int span_ci_eq(const char *s, size_t len, const char *lit) {
    if (strlen(lit) != len) return 0;
    for (size_t i = 0; i < len; i++) {
        if (ascii_lower(s[i]) != ascii_lower(lit[i])) return 0;
    }
    return 1;
}

/* Skip ASCII whitespace forward. */
static const char *skip_ws(const char *p, const char *end) {
    while (p < end && (*p == ' ' || *p == '\t')) p++;
    return p;
}

/* Trim trailing ASCII whitespace. */
static const char *rtrim(const char *start, const char *end) {
    while (end > start && (end[-1] == ' ' || end[-1] == '\t')) end--;
    return end;
}

/*
 * Walk a header value, calling `visit(name, name_len, q, user)` for each
 * comma-separated entry that wasn't dropped (q > 0 and recognized).
 * Identity-q0 / *-q0 handling is done by the caller via the
 * `identity_forbidden_out` pointer.
 */
static codec_status_t parse_accept_encoding_internal(
    const char                  *header,
    codec_wire_client_support_t *out)
{
    if (!out) return CODEC_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));

    if (!header) {
        out->accepts_identity = true;
        out->unspecified = true;
        return CODEC_OK;
    }

    size_t hlen = strlen(header);
    const char *end = header + hlen;
    const char *p = header;
    int any_entry_seen = 0;
    int identity_forbidden = 0;
    int star_with_q0 = 0;
    int explicit_count = 0; /* explicit non-* entries with q>0 */

    while (p < end) {
        /* Find comma. */
        const char *comma = memchr(p, ',', (size_t)(end - p));
        const char *entry_end = comma ? comma : end;
        const char *entry_start = skip_ws(p, entry_end);
        const char *entry_real_end = rtrim(entry_start, entry_end);

        if (entry_start < entry_real_end) {
            any_entry_seen = 1;

            /* Split on ';' — name is the head. */
            const char *semi = memchr(entry_start, ';', (size_t)(entry_real_end - entry_start));
            const char *name_end = semi ? semi : entry_real_end;
            const char *name_real_end = rtrim(entry_start, name_end);
            size_t name_len = (size_t)(name_real_end - entry_start);

            /* Parse q-value (default 1.0) by scanning ;q=... params. */
            double q = 1.0;
            const char *param_p = semi;
            while (param_p && param_p < entry_real_end) {
                param_p++; /* skip ';' */
                param_p = skip_ws(param_p, entry_real_end);
                const char *next_semi = memchr(param_p, ';', (size_t)(entry_real_end - param_p));
                const char *param_end = next_semi ? next_semi : entry_real_end;
                const char *param_real_end = rtrim(param_p, param_end);
                if (param_real_end - param_p >= 2
                    && (param_p[0] == 'q' || param_p[0] == 'Q')) {
                    const char *eq = param_p + 1;
                    eq = skip_ws(eq, param_real_end);
                    if (eq < param_real_end && *eq == '=') {
                        eq++;
                        eq = skip_ws(eq, param_real_end);
                        char numbuf[16];
                        size_t numlen = (size_t)(param_real_end - eq);
                        if (numlen > 0 && numlen < sizeof(numbuf)) {
                            memcpy(numbuf, eq, numlen);
                            numbuf[numlen] = 0;
                            char *endp = NULL;
                            double v = strtod(numbuf, &endp);
                            if (endp != numbuf) q = v;
                        }
                    }
                }
                param_p = next_semi;
            }

            /* Identify the name. */
            int is_star = (name_len == 1 && entry_start[0] == '*');
            int is_identity = span_ci_eq(entry_start, name_len, "identity");
            int is_gzip     = span_ci_eq(entry_start, name_len, "gzip");
            int is_br       = span_ci_eq(entry_start, name_len, "br");
            int is_zstd     = span_ci_eq(entry_start, name_len, "zstd");

            if (is_identity && q == 0.0) identity_forbidden = 1;
            if (is_star && q == 0.0) star_with_q0 = 1;

            if (q > 0.0) {
                if (is_identity) { out->accepts_identity = true; explicit_count++; }
                else if (is_gzip) { out->accepts_gzip = true; explicit_count++; }
                else if (is_br)   { out->accepts_br   = true; explicit_count++; }
                else if (is_zstd) { out->accepts_zstd = true; explicit_count++; }
            }
        }

        if (!comma) break;
        p = comma + 1;
    }

    /* identity is implicit unless explicitly disabled. The
     * `*;q=0 with no explicit accepts` branch mirrors the TS
     * behaviour exactly. */
    if (!any_entry_seen) {
        /* Empty header → no accepts, no identity. */
        return CODEC_OK;
    }
    if (!identity_forbidden) {
        if (!(star_with_q0 && explicit_count == 0)) {
            out->accepts_identity = true;
        }
    }
    return CODEC_OK;
}

codec_status_t codec_wire_parse_accept_encoding(
    const char                  *header,
    codec_wire_client_support_t *out)
{
    return parse_accept_encoding_internal(header, out);
}

/* ── Build helper ───────────────────────────────────────────────────────── */

codec_status_t codec_wire_build_accept_encoding(
    bool   want_gzip,
    bool   want_br,
    bool   want_zstd,
    char  *out_buf,
    size_t out_buf_len)
{
    if (!out_buf || out_buf_len < CODEC_WIRE_ACCEPT_ENCODING_BUF_LEN)
        return CODEC_ERR_INVALID_ARG;
    out_buf[0] = 0;
    int first = 1;
    if (want_gzip) {
        strcat(out_buf, "gzip;q=1.0");
        first = 0;
    }
    if (want_br) {
        if (!first) strcat(out_buf, ", ");
        strcat(out_buf, "br;q=0.5");
        first = 0;
    }
    if (want_zstd) {
        if (!first) strcat(out_buf, ", ");
        strcat(out_buf, "zstd;q=0.3");
    }
    return CODEC_OK;
}

/* ── Shannon entropy ────────────────────────────────────────────────────── */

double codec_wire_shannon_entropy_bits_per_byte(const uint8_t *bytes, size_t len) {
    if (!bytes || len == 0) return 0.0;
    uint32_t counts[256] = {0};
    for (size_t i = 0; i < len; i++) counts[bytes[i]]++;
    double h = 0.0;
    double n = (double)len;
    for (int b = 0; b < 256; b++) {
        uint32_t c = counts[b];
        if (c == 0) continue;
        double p = (double)c / n;
        h -= p * (log(p) / log(2.0));
    }
    return h;
}

/* ── Picker ─────────────────────────────────────────────────────────────── */

static void append_considered(codec_wire_pick_result_t *r, codec_wire_encoding_t e) {
    if (r->considered_count < 4) r->considered[r->considered_count++] = e;
}

/* Sort 0..3 considered slots ascending by wire-name (matches TS .sort()). */
static int enc_name_cmp(const void *a, const void *b) {
    codec_wire_encoding_t ea = *(const codec_wire_encoding_t *)a;
    codec_wire_encoding_t eb = *(const codec_wire_encoding_t *)b;
    return strcmp(codec_wire_encoding_name(ea), codec_wire_encoding_name(eb));
}

static codec_wire_pick_reason_t fallback_reason_for_no_zstd(
    bool zstd_in_accept, bool has_dict, bool enabled) {
    if (!zstd_in_accept) return CODEC_WIRE_REASON_GZIP_NO_ZSTD_IN_ACCEPT;
    if (!has_dict)       return CODEC_WIRE_REASON_GZIP_NO_DICT;
    if (!enabled)        return CODEC_WIRE_REASON_GZIP_MIDDLEWARE_DISABLED;
    return CODEC_WIRE_REASON_GZIP_NO_ZSTD_IN_ACCEPT;
}

static void format_reason(codec_wire_pick_result_t *r,
                          codec_wire_pick_reason_t  code,
                          const codec_wire_stack_profile_t *stack,
                          bool                      interactive,
                          int                       estimated_size,
                          double                    entropy_or_neg1)
{
    r->reason_code = code;
    const char *who = interactive ? "interactive" : "agent";
    switch (code) {
    case CODEC_WIRE_REASON_DICT_ZSTD_DEFAULT:
        snprintf(r->reason, sizeof(r->reason),
                 "dict-zstd (both gates passed; stack=%s; %s; size=%d)",
                 stack->name, who, estimated_size);
        break;
    case CODEC_WIRE_REASON_PER_STACK_OVERRODE_ZSTD:
        snprintf(r->reason, sizeof(r->reason),
                 "gzip (stack=%s ttftRatio for zstd > %.0f; size=%d)",
                 stack->name, (double)CODEC_WIRE_MAX_TTFT_RATIO, estimated_size);
        break;
    case CODEC_WIRE_REASON_GZIP_NO_ZSTD_IN_ACCEPT:
        snprintf(r->reason, sizeof(r->reason),
                 "gzip (no zstd in client Accept-Encoding; stack=%s; size=%d)",
                 stack->name, estimated_size);
        break;
    case CODEC_WIRE_REASON_GZIP_NO_DICT:
        snprintf(r->reason, sizeof(r->reason),
                 "gzip (no dict for this request; stack=%s; size=%d)",
                 stack->name, estimated_size);
        break;
    case CODEC_WIRE_REASON_GZIP_MIDDLEWARE_DISABLED:
        snprintf(r->reason, sizeof(r->reason),
                 "gzip (middleware not confirmed streaming; stack=%s; size=%d)",
                 stack->name, estimated_size);
        break;
    case CODEC_WIRE_REASON_BR_CONTENT_SAMPLE_LOW_ENTROPY:
        snprintf(r->reason, sizeof(r->reason),
                 "br (content sample entropy=%.2f < %.1f; %s; size=%d)",
                 entropy_or_neg1, (double)CODEC_WIRE_LOW_ENTROPY_THRESHOLD,
                 who, estimated_size);
        break;
    case CODEC_WIRE_REASON_BR_FALLBACK_NO_GZIP:
        snprintf(r->reason, sizeof(r->reason),
                 "br fallback (no gzip in candidate set; stack=%s; size=%d)",
                 stack->name, estimated_size);
        break;
    case CODEC_WIRE_REASON_PER_STACK_OVERRODE_BR:
        snprintf(r->reason, sizeof(r->reason),
                 "per_stack_overrode_br (stack=%s)", stack->name);
        break;
    case CODEC_WIRE_REASON_IDENTITY_LAST_RESORT:
        snprintf(r->reason, sizeof(r->reason),
                 "client supports nothing compressible; identity (stack=%s)",
                 stack->name);
        break;
    }
}

codec_status_t codec_wire_pick(const codec_wire_pick_input_t *in,
                               codec_wire_pick_result_t      *out_result)
{
    if (!in || !out_result) return CODEC_ERR_INVALID_ARG;

    memset(out_result, 0, sizeof(*out_result));

    const codec_wire_stack_profile_t *stack =
        in->stack_profile ? in->stack_profile : &CODEC_WIRE_STACK_PROFILE_DEFAULT;

    bool zstd_enabled = in->zstd_enabled_set ? in->zstd_enabled : true;
    bool interactive  = in->interactive_set  ? in->interactive  : true;

    /* Server-side candidate set (defaults to all four). */
    bool server_identity = in->server_supports_set ? in->server_supports_identity : true;
    bool server_gzip     = in->server_supports_set ? in->server_supports_gzip     : true;
    bool server_br       = in->server_supports_set ? in->server_supports_br       : true;
    bool server_zstd     = in->server_supports_set ? in->server_supports_zstd     : true;

    /* Parse Accept-Encoding. */
    codec_wire_client_support_t client;
    codec_status_t s = parse_accept_encoding_internal(in->accept_encoding, &client);
    if (s != CODEC_OK) return s;

    /* Intersect client × server. */
    bool cand_identity = client.accepts_identity && server_identity;
    bool cand_gzip     = client.accepts_gzip     && server_gzip;
    bool cand_br       = client.accepts_br       && server_br;
    bool cand_zstd     = client.accepts_zstd     && server_zstd;

    /* ── Stage 1: hard zstd gates ──────────────────────────────────────── */
    bool zstd_in_accept_before_dropping = cand_zstd;
    codec_wire_pick_reason_t dropped_zstd_reason = (codec_wire_pick_reason_t)-1;
    if (!cand_zstd) {
        dropped_zstd_reason = CODEC_WIRE_REASON_GZIP_NO_ZSTD_IN_ACCEPT;
    } else if (!in->zstd_has_dict) {
        cand_zstd = false;
        dropped_zstd_reason = CODEC_WIRE_REASON_GZIP_NO_DICT;
    } else if (!zstd_enabled) {
        cand_zstd = false;
        dropped_zstd_reason = CODEC_WIRE_REASON_GZIP_MIDDLEWARE_DISABLED;
    }

    /* ── Stage 2: per-stack profile drops ──────────────────────────────── */
    bool per_stack_overrode_zstd = false;
    bool per_stack_overrode_br = false;
    if (cand_zstd && stack->zstd.ttft_ratio > CODEC_WIRE_MAX_TTFT_RATIO) {
        cand_zstd = false;
        per_stack_overrode_zstd = true;
    }
    if (cand_br && stack->br.ttft_ratio > CODEC_WIRE_MAX_TTFT_RATIO) {
        cand_br = false;
        per_stack_overrode_br = true;
    }
    if (cand_gzip && stack->gzip.ttft_ratio > CODEC_WIRE_MAX_TTFT_RATIO) {
        cand_gzip = false;
    }

    /* Considered set, sorted ascending by wire name (matches TS .sort()). */
    if (cand_br)       append_considered(out_result, CODEC_WIRE_ENC_BR);
    if (cand_gzip)     append_considered(out_result, CODEC_WIRE_ENC_GZIP);
    if (cand_identity) append_considered(out_result, CODEC_WIRE_ENC_IDENTITY);
    if (cand_zstd)     append_considered(out_result, CODEC_WIRE_ENC_ZSTD);
    qsort(out_result->considered, out_result->considered_count,
          sizeof(codec_wire_encoding_t), enc_name_cmp);

    /* ── Stage 3: content-aware tiebreaker ─────────────────────────────── */
    if (in->sample_bytes && in->sample_len > 0 && cand_br && cand_zstd) {
        double ent = codec_wire_shannon_entropy_bits_per_byte(in->sample_bytes, in->sample_len);
        if (ent < CODEC_WIRE_LOW_ENTROPY_THRESHOLD) {
            out_result->encoding = CODEC_WIRE_ENC_BR;
            format_reason(out_result, CODEC_WIRE_REASON_BR_CONTENT_SAMPLE_LOW_ENTROPY,
                          stack, interactive, in->estimated_size, ent);
            return CODEC_OK;
        }
        /* High entropy → fall through to zstd-wins. */
    }

    if (cand_zstd) {
        out_result->encoding = CODEC_WIRE_ENC_ZSTD;
        format_reason(out_result, CODEC_WIRE_REASON_DICT_ZSTD_DEFAULT,
                      stack, interactive, in->estimated_size, -1.0);
        return CODEC_OK;
    }

    if (per_stack_overrode_zstd && cand_gzip) {
        out_result->encoding = CODEC_WIRE_ENC_GZIP;
        format_reason(out_result, CODEC_WIRE_REASON_PER_STACK_OVERRODE_ZSTD,
                      stack, interactive, in->estimated_size, -1.0);
        return CODEC_OK;
    }

    if (cand_gzip) {
        codec_wire_pick_reason_t code =
            (dropped_zstd_reason == (codec_wire_pick_reason_t)-1)
            ? CODEC_WIRE_REASON_GZIP_NO_ZSTD_IN_ACCEPT
            : fallback_reason_for_no_zstd(
                zstd_in_accept_before_dropping, in->zstd_has_dict, zstd_enabled);
        out_result->encoding = CODEC_WIRE_ENC_GZIP;
        format_reason(out_result, code, stack, interactive, in->estimated_size, -1.0);
        return CODEC_OK;
    }

    if (cand_br) {
        out_result->encoding = CODEC_WIRE_ENC_BR;
        format_reason(out_result, CODEC_WIRE_REASON_BR_FALLBACK_NO_GZIP,
                      stack, interactive, in->estimated_size, -1.0);
        return CODEC_OK;
    }

    (void)per_stack_overrode_br;
    out_result->encoding = CODEC_WIRE_ENC_IDENTITY;
    format_reason(out_result, CODEC_WIRE_REASON_IDENTITY_LAST_RESORT,
                  stack, interactive, in->estimated_size, -1.0);
    return CODEC_OK;
}
