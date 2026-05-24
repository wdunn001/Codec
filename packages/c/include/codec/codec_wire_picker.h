/*
 * codec_wire_picker.h — C port of the @codecai/wire-compress picker.
 *
 * SPDX-License-Identifier: MIT
 *
 * Cross-language twin of:
 *   - TypeScript: packages/wire-compress/src/index.ts (reference impl)
 *   - .NET:       packages/dotnet/src/Codec.Net/Picker.cs
 *   - Python:     packages/python/src/codecai/wire_compress.py  (planned)
 *
 * Decides which Content-Encoding (gzip / brotli / dict-zstd / identity)
 * to apply to a streaming response, given the client's Accept-Encoding
 * header + estimated payload size + the two zstd gates (dict loaded,
 * middleware streaming-mode confirmed).
 *
 * The hard rule (cross-language): DICTLESS ZSTD IS NEVER CHOSEN. It has
 * roughly the same compression ratio as gzip on Codec / small-JSON
 * envelopes (bench/RESULTS.md §1f) but +334× TTFT on shipped buffered
 * middleware (RESULTS.md §1d). Dict-trained zstd hits 60-80% on small
 * JSON envelopes; dictless misses 30%. So:
 *
 *   zstd     → only when has_dict=true AND zstd_enabled=true AND client
 *              advertised zstd AND per-stack profile didn't drop it
 *   gzip     → universal default whenever any zstd gate fails
 *   brotli   → fallback only (gzip is preferred over br at every size on
 *              streaming small-frame workloads)
 *   identity → last resort
 *
 * Design constraints:
 *   - No malloc — all outputs are caller-owned fixed-size structs / enums.
 *     ESP32 / Cortex-M friendly, deterministic, safe for hot paths.
 *   - Stateless — every call is independent; no thread-locals.
 *   - C99 strict — no compiler-specific extensions, no _Generic, no
 *     designated-initializer-only constructs in the public surface.
 *
 * Conformance: the test suite in packages/c/test/test_wire_picker.c
 * replays the shared vector set
 * (packages/wire-compress/test/conformance-vectors.json) against this
 * picker; CI fails if any case diverges from the TS reference.
 */

#ifndef CODEC_WIRE_PICKER_H
#define CODEC_WIRE_PICKER_H

#include "codec.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ── Encoding enum ───────────────────────────────────────────────────────── */

/*
 * The four Content-Encoding values the picker chooses between. Values are
 * stable wire identifiers — never renumber. Mirrors the TS string union
 * (the canonical names are returned by codec_wire_encoding_name).
 */
typedef enum codec_wire_encoding {
    CODEC_WIRE_ENC_IDENTITY = 0,
    CODEC_WIRE_ENC_GZIP     = 1,
    CODEC_WIRE_ENC_BR       = 2,
    CODEC_WIRE_ENC_ZSTD     = 3
} codec_wire_encoding_t;

/* Canonical wire name ("identity"/"gzip"/"br"/"zstd"). Static string —
 * never freed. Returns "?" for out-of-range input. */
const char *codec_wire_encoding_name(codec_wire_encoding_t enc);

/* ── Reason codes ────────────────────────────────────────────────────────── */

/*
 * Closed enum of pick() decisions (v0.5 contract). Use this for dashboard
 * grouping / structured logging. Additive only — never renumber, never
 * remove existing values. Mirrors the TS PickReasonCode string union.
 */
typedef enum codec_wire_pick_reason {
    /* Both zstd gates passed, no per-stack override. */
    CODEC_WIRE_REASON_DICT_ZSTD_DEFAULT          = 0,
    /* Per-stack profile downgraded zstd (e.g. sglang ttftRatio > threshold). */
    CODEC_WIRE_REASON_PER_STACK_OVERRODE_ZSTD    = 1,
    /* Zstd gated off because client didn't advertise it. */
    CODEC_WIRE_REASON_GZIP_NO_ZSTD_IN_ACCEPT     = 2,
    /* Zstd gated off because has_dict=false. */
    CODEC_WIRE_REASON_GZIP_NO_DICT               = 3,
    /* Zstd gated off because zstd_enabled=false. */
    CODEC_WIRE_REASON_GZIP_MIDDLEWARE_DISABLED   = 4,
    /* Content sample suggested low entropy + br outperforms gzip. */
    CODEC_WIRE_REASON_BR_CONTENT_SAMPLE_LOW_ENTROPY = 5,
    /* Br is the only non-identity option. */
    CODEC_WIRE_REASON_BR_FALLBACK_NO_GZIP        = 6,
    /* Per-stack profile downgraded br. */
    CODEC_WIRE_REASON_PER_STACK_OVERRODE_BR      = 7,
    /* Client supports nothing compressible. */
    CODEC_WIRE_REASON_IDENTITY_LAST_RESORT       = 8
} codec_wire_pick_reason_t;

/* Wire-format snake_case name for `code`. Static string. */
const char *codec_wire_pick_reason_name(codec_wire_pick_reason_t code);

/* ── Stack profile ───────────────────────────────────────────────────────── */

/*
 * Per-encoding measured compression characteristics for a specific
 * gateway stack. Mirrors the TS EncodingChars struct.
 *
 *   wire_coeff  measured `compressed_bytes / raw_codec_bytes` (lower = better)
 *   ttft_ratio  measured `compressed_TTFT / raw_codec_TTFT`   (1.0 = streams)
 *
 * Use ttft_ratio = 0 to signal "encoding not supported on this stack" —
 * the picker treats such entries as missing.
 */
typedef struct codec_wire_encoding_chars {
    double wire_coeff;
    double ttft_ratio;
} codec_wire_encoding_chars_t;

/*
 * Per-stack profile. The three indices correspond to gzip, br, zstd
 * (identity is implicitly always available). Set ttft_ratio = 0 to mark
 * "not supported by this stack".
 */
typedef struct codec_wire_stack_profile {
    const char *name;
    codec_wire_encoding_chars_t gzip;
    codec_wire_encoding_chars_t br;
    codec_wire_encoding_chars_t zstd;
} codec_wire_stack_profile_t;

/* Built-in profiles. Lock-stepped with the TS STACK_PROFILES table. */
extern const codec_wire_stack_profile_t CODEC_WIRE_STACK_PROFILE_DEFAULT;
extern const codec_wire_stack_profile_t CODEC_WIRE_STACK_PROFILE_SGLANG;
extern const codec_wire_stack_profile_t CODEC_WIRE_STACK_PROFILE_LLAMA_CPP;

/* Look up a profile by stack name. Returns DEFAULT for NULL / unknown. */
const codec_wire_stack_profile_t *codec_wire_profile_for(const char *name);

/* ── Picker input / output ──────────────────────────────────────────────── */

/*
 * Picker constants. Cross-language identical:
 *   MAX_TTFT_RATIO       — per-stack profile drop threshold
 *   LOW_ENTROPY_THRESHOLD — content-aware tiebreaker boundary (bits/byte)
 */
#define CODEC_WIRE_MAX_TTFT_RATIO       5.0
#define CODEC_WIRE_LOW_ENTROPY_THRESHOLD 3.0

/*
 * Picker input. Aggregates everything the picker needs in one struct so
 * the C99 designated-initializer call site reads exactly like the TS one:
 *
 *   codec_wire_pick_input_t in = {
 *       .accept_encoding = "gzip, br, zstd",
 *       .estimated_size  = 1024,
 *       .zstd_has_dict   = true,
 *       .zstd_enabled    = true,
 *   };
 *   codec_wire_pick_result_t r;
 *   codec_wire_pick(&in, &r);
 *
 * Fields left zero-initialized adopt these defaults:
 *   accept_encoding   NULL  → unspecified header (identity-only)
 *   interactive       false → treated as true unless explicit (see flag below)
 *   zstd_enabled      false → treated as true unless interactive_set / explicit
 *   ...
 *
 * Because C has no `undefined`, defaults are encoded via the explicit
 * `*_set` companion flags (defensive — callers using
 * designated-initializer init don't have to remember every default).
 */
typedef struct codec_wire_pick_input {
    /* The Accept-Encoding header value, or NULL if absent. */
    const char *accept_encoding;

    /* Best estimate of total response size (tokens or bytes; calibrate
     * to the active stack profile). */
    int estimated_size;

    /* Optional server-side capability restriction. If
     * server_supports_set=true, only encodings flagged here are eligible
     * candidates. Default: all four enabled. */
    bool server_supports_set;
    bool server_supports_identity;
    bool server_supports_gzip;
    bool server_supports_br;
    bool server_supports_zstd;

    /* Interactive (default true) — avoids encodings that buffer the
     * whole response. Set `interactive_set=true` to make the picker
     * honour the `interactive` field; otherwise the default of true
     * applies. */
    bool interactive_set;
    bool interactive;

    /* Explicit opt-out from zstd when middleware is known to buffer.
     * Default true (v0.5 contract). Set `zstd_enabled_set=true` to
     * override; otherwise the default of true applies. */
    bool zstd_enabled_set;
    bool zstd_enabled;

    /* Whether the server has a pre-trained zstd dict loaded for THIS
     * request's (tokenizer_id, stream_format). The primary zstd gate.
     * Default false — without a dict, no-dict zstd is NEVER chosen. */
    bool zstd_has_dict;

    /* Optional per-stack profile pointer. NULL → DEFAULT. */
    const codec_wire_stack_profile_t *stack_profile;

    /* Optional content sample (first N bytes of the response). When
     * sample_bytes != NULL AND sample_len > 0 AND both br + zstd are
     * viable, low-entropy → br, high-entropy → dict-zstd. */
    const uint8_t *sample_bytes;
    size_t         sample_len;
} codec_wire_pick_input_t;

/*
 * Picker output. Stateless, caller-owned. The `considered` array is
 * fixed-capacity (max four encodings); `considered_count` says how many
 * are valid. The `reason` buffer is filled with a NUL-terminated
 * human-readable expansion of `reason_code` (truncated if it doesn't
 * fit — but the buffer is sized for the longest message produced by the
 * picker).
 */
#define CODEC_WIRE_REASON_BUF_LEN 192

typedef struct codec_wire_pick_result {
    codec_wire_encoding_t        encoding;
    codec_wire_pick_reason_t     reason_code;
    char                         reason[CODEC_WIRE_REASON_BUF_LEN];
    codec_wire_encoding_t        considered[4];
    size_t                       considered_count;
} codec_wire_pick_result_t;

/*
 * Pick the best Content-Encoding for a streaming response.
 *
 * Returns CODEC_OK on success (always; the picker never fails — it
 * falls back to identity in the worst case). Returns
 * CODEC_ERR_INVALID_ARG only for NULL inputs.
 *
 * Thread-safe, reentrant, no allocation.
 */
codec_status_t codec_wire_pick(const codec_wire_pick_input_t *input,
                               codec_wire_pick_result_t      *out_result);

/* ── Parse / build helpers ──────────────────────────────────────────────── */

/*
 * Parse an Accept-Encoding header into a fixed-size acceptance bitmap
 * (ordered by q-value desc inside the bitmap's encoding slot doesn't
 * apply here — the picker only cares whether each encoding is accepted,
 * not its q-value once q>0).
 *
 * Sets `*out_unspecified` to true iff `header == NULL` (RFC 7231
 * fallback). For a NULL header, only identity is accepted.
 */
typedef struct codec_wire_client_support {
    bool accepts_identity;
    bool accepts_gzip;
    bool accepts_br;
    bool accepts_zstd;
    bool unspecified;
} codec_wire_client_support_t;

codec_status_t codec_wire_parse_accept_encoding(
    const char                       *header,
    codec_wire_client_support_t      *out_support);

/*
 * Build the Accept-Encoding header a client should send. Writes a
 * NUL-terminated string into `out_buf`. Returns CODEC_OK on success,
 * CODEC_ERR_INVALID_ARG if the buffer is too small for the canonical
 * output (max length is "gzip;q=1.0, br;q=0.5, zstd;q=0.3" = 33 chars
 * + NUL = 34, so 64 is comfortably enough for all callers).
 */
#define CODEC_WIRE_ACCEPT_ENCODING_BUF_LEN 64

codec_status_t codec_wire_build_accept_encoding(
    bool   want_gzip,
    bool   want_br,
    bool   want_zstd,
    char  *out_buf,
    size_t out_buf_len);

/*
 * Shannon entropy of `bytes` in bits/byte. Uniform random ≈ 8.0;
 * English text ≈ 4-5; long runs of one byte → near 0. Returns 0 for
 * empty input. Branch-free hot loop suitable for inlining in a
 * compression hot path.
 */
double codec_wire_shannon_entropy_bits_per_byte(const uint8_t *bytes,
                                                size_t         len);

#ifdef __cplusplus
}
#endif

#endif /* CODEC_WIRE_PICKER_H */
