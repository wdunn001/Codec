/*
 * codec_compression.h: client-side helpers for the Codec compression
 * contract.
 *
 * SPDX-License-Identifier: MIT
 *
 * Pairs with the server-side ``codec_compression`` modules in sglang /
 * vLLM and the Python / TS / Rust / Java / .NET helper twins. The server
 * emits ``Codec-Zstd-Dict: sha256:<hex>`` on every zstd response; this
 * module validates that header against locally-loaded dicts before the
 * caller feeds bytes into libzstd. See spec/PROTOCOL.md
 * "Codec-Zstd-Dict response header" for the full contract.
 *
 * Why this is a separate module: the actual zstd decompression is
 * intentionally out of scope here: libcurl / libsoup / a custom HTTP
 * stack all already own that path. libzstd is the standard library
 * for the decompression step itself. This module just exposes the small
 * piece that's specific to Codec: hashing a dict to its canonical
 * registry key and matching a response's declared dict hash to one of
 * the dicts the client has loaded.
 *
 * The "fail fast" stance matters: wrong-dict decompression produces
 * garbage bytes that msgpack / protobuf parsers downstream will
 * misinterpret: refuse to decompress with the wrong dict.
 */

#ifndef CODEC_COMPRESSION_H
#define CODEC_COMPRESSION_H

#include "codec.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Result codes for codec_select_zstd_dict_for_response. Distinct from
 * codec_status_t because the "not zstd" outcome is a *positive* signal
 *: the caller's HTTP stack should pass the body through to whatever
 * handles gzip / brotli / identity: not an error.
 */
typedef enum codec_zstd_dict_result {
    /* Response is Content-Encoding: zstd, Codec-Zstd-Dict header matches
     * a loaded dict. *out_dict_bytes / *out_dict_len point at the
     * matching dict (borrowed; lifetime tied to the loaded_dicts entry). */
    CODEC_ZSTD_DICT_OK              = 0,
    /* Response is not zstd. Caller passes through to its identity /
     * gzip / brotli handler. *out_dict_bytes / *out_dict_len untouched. */
    CODEC_ZSTD_DICT_NOT_ZSTD        = 1,
    /* Response is zstd but the server didn't emit the required
     * Codec-Zstd-Dict header. Per spec, the server MUST name the dict
     * it used. Refusing to guess. */
    CODEC_ZSTD_DICT_MISSING_HEADER  = 2,
    /* Codec-Zstd-Dict header value isn't shaped like ``sha256:<64 hex>``. */
    CODEC_ZSTD_DICT_MALFORMED_HASH  = 3,
    /* Codec-Zstd-Dict header names a hash the client hasn't loaded.
     * Caller should fetch the dict from the tokenizer map's
     * ``zstd_dictionaries[]`` entry whose ``hash`` matches, or retry
     * the request with ``Accept-Encoding: gzip`` to downgrade. */
    CODEC_ZSTD_DICT_UNKNOWN_HASH    = 4
} codec_zstd_dict_result_t;

/*
 * One (name, value) HTTP header pair. Pass the caller's response
 * headers as a flat array of these: keys are matched case-insensitively
 * so the caller doesn't have to pre-normalise.
 *
 * Strings are borrowed; the array and its contents must outlive the
 * codec_select_zstd_dict_for_response call.
 */
typedef struct codec_header_kv {
    const char *name;
    const char *value;
} codec_header_kv_t;

/*
 * One loaded dictionary entry. ``hash`` is the canonical
 * ``sha256:<lowercase 64-hex>`` form: same shape codec_hash_zstd_dict
 * produces and the server emits in Codec-Zstd-Dict.
 *
 * Strings + bytes are borrowed; the array and its contents must outlive
 * the codec_select_zstd_dict_for_response call. Most callers populate
 * this once at startup from disk-resident dict files and keep it for
 * the lifetime of the process.
 */
typedef struct codec_zstd_dict_entry {
    const char    *hash;        /* "sha256:<hex>" */
    const uint8_t *bytes;
    size_t         len;
} codec_zstd_dict_entry_t;

/*
 * Compute the canonical Codec-Zstd-Dict hash for ``bytes`` (length
 * ``len``). Writes ``"sha256:<lowercase 64-hex>\0"`` into ``out_hex``,
 * which MUST be at least CODEC_ZSTD_DICT_HASH_BUF_LEN bytes
 * (72: ``"sha256:"`` (7) + 64 hex chars + NUL).
 *
 * Returns 0 on success, non-zero on argument error (NULL pointers).
 *
 * The output shape mirrors:
 *   - the ``hash`` field in tokenizer-map ``zstd_dictionaries[]`` entries
 *   - the value of the server's ``Codec-Zstd-Dict`` response header
 *   - Python's ``hash_zstd_dict()`` return value
 * so it slots straight into the registry key used by
 * codec_select_zstd_dict_for_response.
 */
#define CODEC_ZSTD_DICT_HASH_BUF_LEN 72

int codec_hash_zstd_dict(const uint8_t *bytes, size_t len,
                         char out_hex[CODEC_ZSTD_DICT_HASH_BUF_LEN]);

/*
 * Pick the zstd dict to decompress this response with.
 *
 * Looks up Content-Encoding and Codec-Zstd-Dict in ``headers``
 * (case-insensitive name match). If the response is zstd-encoded AND
 * the declared dict hash matches one of ``loaded_dicts``, writes the
 * matching dict's bytes/len to *out_dict_bytes / *out_dict_len and
 * returns CODEC_ZSTD_DICT_OK.
 *
 * Returns CODEC_ZSTD_DICT_NOT_ZSTD when the response isn't zstd (caller
 * passes through to its identity / gzip / brotli handler).
 *
 * Returns CODEC_ZSTD_DICT_MISSING_HEADER / _MALFORMED_HASH /
 * _UNKNOWN_HASH for the documented server / configuration errors. A
 * wrong-dict decompression would produce garbage bytes that downstream
 * msgpack / protobuf parsers would misinterpret: refusing to
 * decompress is the safe default.
 *
 * out_dict_bytes / out_dict_len may be NULL if the caller only wants
 * the OK / error signal.
 *
 * Memory: the dict bytes are borrowed from the matching
 * ``loaded_dicts`` entry: no allocation, no caller-side free.
 */
codec_zstd_dict_result_t codec_select_zstd_dict_for_response(
    const codec_header_kv_t       *headers,
    size_t                         n_headers,
    const codec_zstd_dict_entry_t *loaded_dicts,
    size_t                         n_dicts,
    const uint8_t                **out_dict_bytes,
    size_t                        *out_dict_len);

/*
 * ── Discoverable zstd dictionaries (.well-known/codec/dicts/<sha>.zstd, v0.5+) ──
 *
 * libcodec is HTTP-agnostic: the caller owns the fetch (libcurl, libsoup,
 * a custom stack). This module gives you the two pieces that are specific
 * to Codec:
 *   - building the well-known URL from an origin + hash
 *   - verifying fetched bytes hash to the expected sha256
 *
 * Spec: spec/WELL_KNOWN_DISCOVERY.md § "Zstd dictionaries (v0.5+)".
 *
 * The discovery surface is hard-fail by design: silent fallback to
 * identity bytes was the v0.4.1 sglang COPY-dicts regression class this
 * surface eliminates.
 */

/*
 * Buffer length needed for the largest possible well-known URL with a
 * "reasonable" origin (origin up to 200 chars + ".well-known/codec/dicts/"
 * (23) + 64 hex + ".zstd" (5) + NUL).
 */
#define CODEC_WELL_KNOWN_DICT_URL_BUF_LEN 320

/*
 * Build the well-known URL for a zstd dict.
 *
 *   <origin>/.well-known/codec/dicts/<sha256-hex>.zstd
 *
 * ``origin`` is the HTTPS origin (trailing '/' stripped).
 * ``hash`` may be either ``sha256:<hex>`` or bare ``<hex>``; it is
 * validated for length (64 hex chars after the optional prefix) and
 * character set (lowercase hex; uppercase is normalised to lowercase on
 * its way into the URL).
 *
 * Writes the URL into ``out_url`` (NUL-terminated). ``out_url_buf_len``
 * MUST be at least CODEC_WELL_KNOWN_DICT_URL_BUF_LEN to fit any
 * reasonable origin.
 *
 * Returns CODEC_OK on success,
 *         CODEC_ERR_INVALID_ARG for NULL pointers / undersized buffer,
 *         CODEC_ERR_VALIDATION when ``hash`` is not the expected shape.
 */
codec_status_t codec_well_known_dict_url(
    const char *origin,
    const char *hash,
    char       *out_url,
    size_t      out_url_buf_len);

/*
 * Verify that ``bytes`` (length ``len``) hash to ``expected_hash``.
 *
 * ``expected_hash`` accepts either ``sha256:<hex>`` or bare ``<hex>``;
 * uppercase hex is accepted and matched case-insensitively.
 *
 * Returns CODEC_OK on match, CODEC_ERR_HASH_MISMATCH on mismatch,
 * CODEC_ERR_VALIDATION when ``expected_hash`` is not the expected shape,
 * CODEC_ERR_INVALID_ARG for NULL ``bytes`` / ``expected_hash``.
 *
 * Typical usage:
 *   1. codec_well_known_dict_url(...) to build the URL
 *   2. fetch the bytes with your HTTP stack of choice
 *   3. codec_verify_zstd_dict_bytes(...) to confirm the origin served
 *      the right bytes: never feed unverified bytes into a zstd decoder
 */
codec_status_t codec_verify_zstd_dict_bytes(
    const uint8_t *bytes,
    size_t         len,
    const char    *expected_hash);

#ifdef __cplusplus
}
#endif

#endif /* CODEC_COMPRESSION_H */
