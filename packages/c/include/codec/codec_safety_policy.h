/*
 * codec_safety_policy.h: public API for the safety-policy descriptor.
 *
 * SPDX-License-Identifier: MIT
 *
 * Lean C port of @codecai/web's safety_policy module + its Python /
 * Rust / .NET / Java twins. Same descriptor shape; same field
 * semantics; same URL convention. The C surface is intentionally
 * lighter than the higher-level languages: embedded / FFI consumers
 * typically *receive* descriptors and verify hashes; descriptor
 * publishing happens upstream in TS / Python / Rust / .NET / Java.
 *
 * Public surface (slice 11, libcodec leg):
 *
 *   - codec_safety_policy_t   (opaque)
 *   - codec_safety_policy_from_json(...)
 *   - field accessors (id / version / category count / classifier family / ...)
 *   - codec_safety_policy_well_known_url(...)
 *   - codec_safety_policy_well_known_hash_url(...)
 *   - codec_safety_policy_verify_sha256(...)   ← matches existing
 *                                                codec_map_verify_sha256
 *   - codec_safety_policy_free(...)
 *
 * Notes:
 *   - Strings returned by accessors are owned by the
 *     codec_safety_policy_t and live until codec_safety_policy_free().
 *   - This port does NOT emit canonical bytes. Callers that need to
 *     publish a descriptor go through TS / Python / Rust / .NET / Java;
 *     C clients verify by hash against bytes received on the wire.
 */

#ifndef CODEC_SAFETY_POLICY_H
#define CODEC_SAFETY_POLICY_H

#include "codec.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Fixed base path under which Codec safety-policy documents live. */
#define CODEC_SAFETY_POLICY_WELL_KNOWN_BASE "/.well-known/codec/policies"

/* Action a category requests when its threshold fires. */
typedef enum codec_safety_action {
    CODEC_SAFETY_ACTION_UNKNOWN    = 0,
    CODEC_SAFETY_ACTION_STOP       = 1,
    CODEC_SAFETY_ACTION_REDACT     = 2,
    CODEC_SAFETY_ACTION_REGENERATE = 3,
    CODEC_SAFETY_ACTION_FLAG       = 4
} codec_safety_action_t;

/* Where the classifier runs. */
typedef enum codec_classifier_host {
    CODEC_CLASSIFIER_HOST_UNSET  = 0,
    CODEC_CLASSIFIER_HOST_SERVER = 1,
    CODEC_CLASSIFIER_HOST_CLIENT = 2,
    CODEC_CLASSIFIER_HOST_BOTH   = 3
} codec_classifier_host_t;

/* Opaque handle to a parsed descriptor. */
typedef struct codec_safety_policy codec_safety_policy_t;

/*
 * Parse + validate a JSON byte slice into a typed descriptor.
 *
 * Returns CODEC_OK and writes a freshly-allocated handle to *out on
 * success. Returns CODEC_ERR_PARSE for JSON parse failure or
 * CODEC_ERR_VALIDATION for shape violations. The caller frees with
 * codec_safety_policy_free.
 */
CODEC_API codec_status_t codec_safety_policy_from_json(const char *json, size_t len,
                                             codec_safety_policy_t **out);

CODEC_API void codec_safety_policy_free(codec_safety_policy_t *policy);

/* ── Accessors (strings owned by the policy; valid until free) ─────────── */

CODEC_API const char *codec_safety_policy_id(const codec_safety_policy_t *policy);
CODEC_API const char *codec_safety_policy_version(const codec_safety_policy_t *policy);

CODEC_API size_t codec_safety_policy_tokenizer_count(const codec_safety_policy_t *policy);
CODEC_API const char *codec_safety_policy_tokenizer(const codec_safety_policy_t *policy,
                                          size_t index);

CODEC_API size_t codec_safety_policy_category_count(const codec_safety_policy_t *policy);
CODEC_API const char *codec_safety_policy_category_name(const codec_safety_policy_t *policy,
                                              size_t index);
CODEC_API codec_safety_action_t codec_safety_policy_category_action(
    const codec_safety_policy_t *policy, size_t index);
CODEC_API const char *codec_safety_policy_category_description(
    const codec_safety_policy_t *policy, size_t index);

CODEC_API const char *codec_safety_policy_classifier_family(const codec_safety_policy_t *policy);
CODEC_API codec_classifier_host_t codec_safety_policy_classifier_host(
    const codec_safety_policy_t *policy);

CODEC_API const char *codec_safety_policy_category_registry(const codec_safety_policy_t *policy);
CODEC_API const char *codec_safety_policy_published_at(const codec_safety_policy_t *policy);

/* ── URL builders ──────────────────────────────────────────────────────── */

/*
 * Per-policy URL by mutable id (e.g. "acme/strict-v3").
 * Writes "<origin>/.well-known/codec/policies/<id>.json" into `out`
 * (a caller-provided buffer of `out_cap` bytes including the null
 * terminator). Returns CODEC_OK on success, CODEC_ERR_INVALID_ARG if
 * the id fails the [a-z0-9._/-]+ check or contains a path-traversal
 * segment, CODEC_ERR_TRUNCATED if `out_cap` is too small.
 */
CODEC_API codec_status_t codec_safety_policy_well_known_url(const char *origin,
                                                  const char *policy_id,
                                                  char *out, size_t out_cap);

/*
 * Content-addressed URL by sha256 hex (no "sha256:" prefix; expects
 * 64 lowercase hex chars).
 */
CODEC_API codec_status_t codec_safety_policy_well_known_hash_url(const char *origin,
                                                       const char *hash_hex,
                                                       char *out, size_t out_cap);

/* ── Hash verification ─────────────────────────────────────────────────── */

/*
 * Verify that `bytes` hashes to `expected_hash`. `expected_hash` MAY
 * be in `sha256:<hex>` or bare `<hex>` form. Returns CODEC_OK on
 * match, CODEC_ERR_HASH_MISMATCH on mismatch, CODEC_ERR_INVALID_ARG
 * on malformed expected hash.
 *
 * Mirrors the existing codec_map_verify_sha256 contract, so callers
 * that already wire that for tokenizer maps drop this in for safety
 * policies with no surprises.
 */
CODEC_API codec_status_t codec_safety_policy_verify_sha256(const char *bytes, size_t len,
                                                 const char *expected_hash);

#ifdef __cplusplus
}
#endif

#endif /* CODEC_SAFETY_POLICY_H */
