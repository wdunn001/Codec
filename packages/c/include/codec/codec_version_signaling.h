/*
 * codec_version_signaling.h — Codec v0.4 version negotiation, C client side.
 *
 * SPDX-License-Identifier: MIT
 *
 * C mirror of @codecai/web's version-signaling.ts and codecai's
 * version_signaling.py. See spec/versions/v0.4.md:
 *   § Version Compatibility Signaling
 *   § Capabilities are opt-on at the server
 *   § Graceful downgrade
 *
 * libcodec stays HTTP-transport-agnostic — callers feed body bytes
 * (from libcurl, raw sockets, FFI, whatever) into the parsers here
 * and get structured data back. No HTTP client embedded.
 *
 * Public surface:
 *
 *   - CODEC_CLIENT_VERSION                            "0.4"
 *   - CODEC_CLIENT_VERSION_HEADER_NAME                "Codec-Client-Version"
 *   - CODEC_MIN_VERSION_HEADER_NAME                   "Codec-Min-Version"
 *   - CODEC_REQUIRED_FEATURES_HEADER_NAME             "Codec-Required-Features"
 *
 *   - codec_version_required_body_t       parsed 426 body
 *   - codec_version_required_parse(...)   from JSON bytes
 *   - codec_version_required_free(...)
 *
 *   - codec_version_policy_doc_t          parsed .well-known doc
 *   - codec_version_policy_parse(...)
 *   - codec_version_policy_free(...)
 *
 *   - codec_well_known_version_policy_url(...)
 *
 * All "ok / err" returns use the existing codec_status_t convention.
 */
#ifndef CODEC_VERSION_SIGNALING_H
#define CODEC_VERSION_SIGNALING_H

#include <stddef.h>

#include "codec/codec.h"  /* codec_status_t */

#ifdef __cplusplus
extern "C" {
#endif

#define CODEC_CLIENT_VERSION                  "0.4"
#define CODEC_CLIENT_VERSION_HEADER_NAME      "Codec-Client-Version"
#define CODEC_MIN_VERSION_HEADER_NAME         "Codec-Min-Version"
#define CODEC_REQUIRED_FEATURES_HEADER_NAME   "Codec-Required-Features"

/**
 * Parsed body of a v0.4 server's 426 Upgrade Required response.
 *
 * Strings are owned by the struct and live until
 * codec_version_required_free(). required_features is an array of
 * required_features_count NUL-terminated strings, also owned.
 */
typedef struct {
    char *error;             /* always "codec_version_required" for valid bodies */
    char *minimum_version;
    char *client_version;
    char **required_features;     /* may be NULL when count == 0 */
    size_t required_features_count;
    char *docs_url;          /* may be NULL */
    char *deployment_id;     /* may be NULL */
} codec_version_required_body_t;

/**
 * Parse a JSON body bytes into a body struct.
 *
 * @param json_bytes    JSON UTF-8 bytes
 * @param json_len      length of json_bytes in bytes
 * @param out           on success, populated with owned strings.
 *                      Caller MUST call codec_version_required_free().
 * @return CODEC_OK on a valid v0.4 body;
 *         CODEC_ERR_VALIDATION if the JSON is not the expected v0.4 shape;
 *         CODEC_ERR_PARSE if the JSON itself is malformed;
 *         CODEC_ERR_INVALID_ARG if pointers are NULL.
 */
codec_status_t codec_version_required_parse(
    const char *json_bytes,
    size_t json_len,
    codec_version_required_body_t *out);

/** Release all owned strings. Safe to call on a zero-initialized struct. */
void codec_version_required_free(codec_version_required_body_t *body);

/**
 * Parsed .well-known/codec/version-policy.json document.
 */
typedef struct {
    char *minimum_version;
    char **required_features;
    size_t required_features_count;
    char *deployment_id;     /* may be NULL */
    char *docs_url;          /* may be NULL */
    char *valid_until;       /* may be NULL */
} codec_version_policy_doc_t;

codec_status_t codec_version_policy_parse(
    const char *json_bytes,
    size_t json_len,
    codec_version_policy_doc_t *out);

void codec_version_policy_free(codec_version_policy_doc_t *doc);

/**
 * Build the well-known URL for an origin into `out_buf` (NUL-terminated).
 * Returns CODEC_OK on success, CODEC_ERR_TRUNCATED if buf_size is
 * insufficient (in which case `out_buf` is left untouched).
 */
codec_status_t codec_well_known_version_policy_url(
    const char *origin,
    char *out_buf,
    size_t buf_size);

#ifdef __cplusplus
}
#endif

#endif /* CODEC_VERSION_SIGNALING_H */
