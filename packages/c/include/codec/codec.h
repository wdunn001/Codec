/*
 * codec.h — public C99 API for the Codec binary transport protocol.
 *
 * SPDX-License-Identifier: MIT
 *
 * https://github.com/wdunn001/Codec
 */
#ifndef CODEC_H
#define CODEC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Versioning ─────────────────────────────────────────────────────────── */

#define CODEC_VERSION_MAJOR 0
#define CODEC_VERSION_MINOR 1
#define CODEC_VERSION_PATCH 0

const char *codec_version(void);

/* ── Status / errors ────────────────────────────────────────────────────── */

typedef enum codec_status {
    CODEC_OK = 0,
    CODEC_ERR_INVALID_ARG = -1,
    CODEC_ERR_PARSE = -2,
    CODEC_ERR_VALIDATION = -3,
    CODEC_ERR_HASH_MISMATCH = -4,
    CODEC_ERR_INCOMPLETE = -5,
    CODEC_ERR_OUT_OF_MEMORY = -6,
    CODEC_ERR_NOT_FOUND = -7,
    CODEC_ERR_TRUNCATED = -8,
    CODEC_ERR_INVALID_UTF8 = -9
} codec_status_t;

/* Returns a static, human-readable description for `status`. */
const char *codec_status_str(codec_status_t status);

/* ── Buffer ─────────────────────────────────────────────────────────────── */

typedef struct codec_buffer {
    uint8_t *data;
    size_t   len;
} codec_buffer_t;

/* Free a buffer's contents (does not free the struct itself). */
void codec_buffer_free(codec_buffer_t *buf);

/* ── Tokenizer map ──────────────────────────────────────────────────────── */

typedef enum codec_encoder {
    CODEC_ENCODER_NONE = 0,        /* identity / vocab is decoded text */
    CODEC_ENCODER_BYTE_LEVEL = 1,  /* GPT-2 byte→unicode (Llama-3, Qwen, ...) */
    CODEC_ENCODER_METASPACE = 2    /* ▁ as space prefix (Llama-2, Mistral, ...) */
} codec_encoder_t;

/* Opaque tokenizer map. Built by `codec_map_from_json`. */
typedef struct codec_tokenizer_map codec_tokenizer_map_t;

/*
 * Parse a TokenizerMap from a UTF-8 JSON byte buffer. The buffer can be
 * released after this call returns.
 *
 *   *out  is set to a heap-allocated map on success.
 *   Caller frees with `codec_map_free`.
 */
codec_status_t codec_map_from_json(const char *json, size_t len,
                                   codec_tokenizer_map_t **out);

/* Free a map allocated by `codec_map_from_json`. Safe to pass NULL. */
void codec_map_free(codec_tokenizer_map_t *map);

/* Read-only accessors. The strings returned point into the map; lifetime
 * is tied to the map. */
const char     *codec_map_id(const codec_tokenizer_map_t *map);
const char     *codec_map_version(const codec_tokenizer_map_t *map);
size_t          codec_map_vocab_size(const codec_tokenizer_map_t *map);
codec_encoder_t codec_map_encoder(const codec_tokenizer_map_t *map);

/*
 * Verify that `json` (the same bytes you parsed) matches `expected_hex`.
 * Accepts `sha256:<hex>` or bare `<hex>`. Constant-time compare.
 *
 * Returns CODEC_OK on match, CODEC_ERR_HASH_MISMATCH on mismatch.
 */
codec_status_t codec_map_verify_sha256(const char *json, size_t len,
                                       const char *expected_hex);

/* ── Codec frames ───────────────────────────────────────────────────────── */

typedef struct codec_frame {
    uint32_t *ids;          /* heap-allocated array of `ids_len` token IDs */
    size_t    ids_len;
    bool      done;
    char     *finish_reason; /* heap-allocated UTF-8 string, NULL if absent */
} codec_frame_t;

/* Initialise to zero. */
void codec_frame_init(codec_frame_t *frame);

/* Free `ids` and `finish_reason`; zero the struct. Safe to call repeatedly. */
void codec_frame_destroy(codec_frame_t *frame);

/*
 * Encode a frame to a freshly allocated buffer in the given format.
 * On success, *out owns its bytes (free with codec_buffer_free).
 */
codec_status_t codec_encode_msgpack(const codec_frame_t *frame, codec_buffer_t *out);
codec_status_t codec_encode_protobuf(const codec_frame_t *frame, codec_buffer_t *out);

/*
 * Decode a single, complete frame from `data`. `out` is filled; caller is
 * responsible for `codec_frame_destroy(out)` even on error.
 *
 * codec_decode_msgpack: on success *consumed is set to the number of bytes
 * consumed (so the caller can advance their stream cursor).
 *
 * codec_decode_protobuf_frame: takes a payload WITHOUT the 4-byte length
 * prefix. For a length-prefixed frame, peel the prefix yourself and call
 * with `data + 4` and the prefix value.
 */
codec_status_t codec_decode_msgpack(const uint8_t *data, size_t len,
                                    codec_frame_t *out, size_t *consumed);
codec_status_t codec_decode_protobuf_frame(const uint8_t *data, size_t len,
                                           codec_frame_t *out);

/* ── Detokenizer ────────────────────────────────────────────────────────── */

typedef struct codec_detokenizer codec_detokenizer_t;

typedef struct codec_detokenize_opts {
    bool partial;        /* buffer trailing partial UTF-8 instead of replacing */
    bool render_special; /* emit special tokens as text */
} codec_detokenize_opts_t;

/* Build a stateful detokenizer bound to `map`. The detokenizer keeps a
 * reference to the map; the map must outlive the detokenizer. */
codec_status_t codec_detokenizer_new(const codec_tokenizer_map_t *map,
                                     codec_detokenizer_t **out);

/* Free a detokenizer. Safe to pass NULL. */
void codec_detokenizer_free(codec_detokenizer_t *detok);

/* Reset internal partial-byte buffer. Call between conversations. */
void codec_detokenizer_reset(codec_detokenizer_t *detok);

/*
 * Render a chunk of token IDs to UTF-8 text. Stateful across calls.
 *
 * On success *out is a heap-allocated NUL-terminated string. *out_len is
 * the strlen (not counting the NUL). Caller frees with `free()`.
 *
 * If opts.partial is true, trailing partial multi-byte UTF-8 sequences are
 * buffered for the next call.
 */
codec_status_t codec_detokenizer_render(codec_detokenizer_t *detok,
                                        const uint32_t *ids, size_t ids_len,
                                        codec_detokenize_opts_t opts,
                                        char **out, size_t *out_len);

/* ── Stream decoders ────────────────────────────────────────────────────── */

/*
 * Incremental stream decoders. Feed bytes as they arrive; pop frames as
 * they become complete.
 *
 * Lifecycle:
 *   1. codec_msgpack_stream_new() / codec_protobuf_stream_new()
 *   2. while reading bytes:
 *        codec_*_stream_feed(dec, bytes, len);
 *        while (codec_*_stream_next(dec, &frame) == CODEC_OK) {
 *            ... use frame ...
 *            codec_frame_destroy(&frame);
 *        }
 *   3. codec_*_stream_free(dec);
 *
 * codec_*_stream_next returns:
 *   CODEC_OK            — *out filled with a complete frame
 *   CODEC_ERR_INCOMPLETE — no complete frame in the buffer yet
 *   negative            — protocol error
 */

typedef struct codec_msgpack_stream codec_msgpack_stream_t;
typedef struct codec_protobuf_stream codec_protobuf_stream_t;

codec_status_t codec_msgpack_stream_new(codec_msgpack_stream_t **out);
void           codec_msgpack_stream_free(codec_msgpack_stream_t *dec);
codec_status_t codec_msgpack_stream_feed(codec_msgpack_stream_t *dec,
                                         const uint8_t *data, size_t len);
codec_status_t codec_msgpack_stream_next(codec_msgpack_stream_t *dec,
                                         codec_frame_t *out);

codec_status_t codec_protobuf_stream_new(codec_protobuf_stream_t **out);
void           codec_protobuf_stream_free(codec_protobuf_stream_t *dec);
codec_status_t codec_protobuf_stream_feed(codec_protobuf_stream_t *dec,
                                          const uint8_t *data, size_t len);
codec_status_t codec_protobuf_stream_next(codec_protobuf_stream_t *dec,
                                          codec_frame_t *out);

#ifdef __cplusplus
}
#endif

#endif /* CODEC_H */
