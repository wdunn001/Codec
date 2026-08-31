/*
 * codec.h: public C99 API for the Codec binary transport protocol.
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
#define CODEC_VERSION_MINOR 2
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
    CODEC_ERR_INVALID_UTF8 = -9,
    /* Returned by any text-encoder / translator entry point when the
     * library was built with -DCODEC_WITH_BPE_ENCODER=OFF (size-stripped
     * IoT / embedded builds). Decode-side APIs (Detokenizer, ToolWatcher,
     * stream decoders, frame codec, compression, safety-policy) work
     * unchanged. */
    CODEC_ERR_NOT_BUILT = -10
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

/*
 * Resolve a special-token name to its uint32 ID.
 *
 * Names are the keys from the map's `special_tokens` object: typical
 * examples: `"<|endoftext|>"`, `"<tool_call>"`, `"</tool_call>"`,
 * `"<|python_tag|>"`, `"<|im_start|>"`.
 *
 * Returns CODEC_OK + writes *out_id on hit, CODEC_ERR_NOT_FOUND on miss.
 *
 * This is the preferred way to bind structural markers (tool calls, role
 * boundaries, EOS tokens) before scanning a stream: resolve names to IDs
 * once at startup, then compare uint32s in the hot loop.
 */
codec_status_t codec_map_special_id(const codec_tokenizer_map_t *map,
                                    const char *name,
                                    uint32_t *out_id);

/* ── Tool-calling convention block (optional map field) ─────────────────── */
/*
 * Per-model tool-calling convention. Optional on a TokenizerMap; populated
 * by @codecai/maps-cli when it detects a known chat-template signature.
 * Mirror of `tool_calling` in the v2.1 tokenizer-map schema. See
 * spec/PROTOCOL.md § "Tool-call calling conventions in the map".
 *
 * Each `convention` value pins a specific argument layout, marker placement,
 * and result framing: the registry of valid values is closed (additive
 * point releases of the schema).
 */
typedef enum codec_tool_calling_convention {
    CODEC_TOOL_CALLING_CONVENTION_LLAMA3       = 1,
    CODEC_TOOL_CALLING_CONVENTION_QWEN25       = 2,
    CODEC_TOOL_CALLING_CONVENTION_PHI4         = 3,
    CODEC_TOOL_CALLING_CONVENTION_MISTRAL_NEMO = 4,
    CODEC_TOOL_CALLING_CONVENTION_DEEPSEEK_V3  = 5,
    CODEC_TOOL_CALLING_CONVENTION_DEEPSEEK_R1  = 6,
    CODEC_TOOL_CALLING_CONVENTION_CUSTOM       = 7,
} codec_tool_calling_convention_t;

typedef enum codec_tool_calling_args_format {
    CODEC_TOOL_CALLING_ARGS_JSON        = 1,
    CODEC_TOOL_CALLING_ARGS_PYTHON_ARGS = 2,
} codec_tool_calling_args_format_t;

typedef enum codec_tool_calling_result_format {
    CODEC_TOOL_CALLING_RESULT_TEXT = 1,
    CODEC_TOOL_CALLING_RESULT_JSON = 2,
} codec_tool_calling_result_format_t;

/*
 * Tool-calling block. Strings are owned by the map; lifetime is tied to
 * the map. `marker_start_name` and `marker_end_name` MUST appear as keys
 * in the map's `special_tokens` table: codec_map_from_json() returns
 * CODEC_ERR_VALIDATION on a tool_calling block whose markers don't
 * resolve.
 */
typedef struct codec_tool_calling {
    codec_tool_calling_convention_t    convention;
    codec_tool_calling_args_format_t   args_format;
    codec_tool_calling_result_format_t result_format;
    const char *marker_start_name;
    const char *marker_end_name;
} codec_tool_calling_t;

/*
 * Returns a pointer to the map's tool-calling block, or NULL if the map
 * doesn't declare one (the legacy/un-annotated case). The pointer is
 * valid for the lifetime of the map.
 *
 * Most callers will resolve the marker names to IDs via
 * codec_map_special_id() and then bind a codec_tool_watcher with the
 * resulting (start_id, end_id) pair.
 */
const codec_tool_calling_t *codec_map_tool_calling(
    const codec_tokenizer_map_t *map);

/* ── Codec frames ───────────────────────────────────────────────────────── */

/*
 * One tool call surfaced on a frame. Mirrors the openai-style
 * { id, name, arguments } shape used by every chat-tuned model in current
 * use; libcodec keeps `arguments` as the raw JSON string so the caller can
 * parse it with whatever JSON library suits its host environment.
 *
 * Lifetime: the strings are BORROWED: callers (e.g. an inference server
 * encoding tool calls into outbound frames) own the buffers. The encoder
 * reads the pointers; codec_frame_destroy does NOT free them. This matches
 * the borrow idiom that llama.cpp/sglang already use for finish_reason
 * via the null-before-destroy dance.
 */
typedef struct codec_tool_call {
    const char *name;            /* optional: NULL if absent */
    const char *arguments_json;  /* required: raw JSON body between markers */
    const char *id;              /* optional: server-generated, e.g. "tc_<hex>" */
} codec_tool_call_t;

typedef struct codec_frame {
    uint32_t *ids;                  /* heap-allocated array of `ids_len` token IDs */
    size_t    ids_len;
    bool      done;
    char     *finish_reason;        /* heap-allocated UTF-8 string, NULL if absent */
    /* Server-side tool-call detection (sglang PR #24557, vLLM #41765-tools,
     * llama.cpp #22757-tools). When the model emits a complete <start>..<end>
     * region in this chunk, the parsed result rides along on the same frame
     * whose `ids` come from immediately after the region. Multiple tool calls
     * in one frame are emitted as an array. Borrowed pointer: caller owns
     * both the array and its strings. */
    const codec_tool_call_t *tool_calls;
    size_t                   tool_calls_len;
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

/* ── Tool-call / region watcher ─────────────────────────────────────────── */
/*
 * codec_tool_watcher scans a token-ID stream for a delimited region (start
 * marker → end marker) without ever decoding the bytes to text. Most modern
 * chat-tuned models emit tool calls between special tokens: Qwen 2.5+ uses
 * <tool_call>/</tool_call>, Llama 3.1+ uses <|python_tag|>/<|eom_id|>,
 * Phi-4 uses <|tool|>/<|/tool|>, etc.: so an orchestrator can detect a
 * tool call by integer compare in the hot loop and only invoke the
 * detokenizer on the buffered span when it actually needs the JSON
 * arguments.
 *
 * The watcher is stateful across feed() calls: partial regions split
 * across frame boundaries are accumulated until the end marker arrives.
 *
 *   codec_tool_watcher_new(map, "<tool_call>", "</tool_call>", &w);
 *   codec_watcher_event_t *evs; size_t n;
 *   codec_tool_watcher_feed(w, frame.ids, frame.ids_len, &evs, &n);
 *   for (size_t i = 0; i < n; i++) {
 *       if (evs[i].kind == CODEC_WATCH_PASSTHROUGH) {
 *           // Forward evs[i].ids straight to the next agent: no decode.
 *       } else {
 *           // Tool call captured. Decode evs[i].ids only if you need the
 *           // arguments JSON; otherwise just route by tool-call presence.
 *       }
 *   }
 *
 * Lifetimes: the events array and any PASSTHROUGH `ids` pointers reference
 * the input buffer / watcher's internal storage and stay valid until the
 * next codec_tool_watcher_feed call (or until codec_tool_watcher_free).
 * Copy them out if you need them across feeds.
 */

typedef enum codec_watcher_event_kind {
    CODEC_WATCH_PASSTHROUGH = 0, /* IDs outside any watched region */
    CODEC_WATCH_REGION_END  = 1  /* a complete start..end region was captured */
} codec_watcher_event_kind_t;

typedef struct codec_watcher_event {
    codec_watcher_event_kind_t kind;
    const uint32_t            *ids;
    size_t                     ids_len;
} codec_watcher_event_t;

typedef struct codec_tool_watcher codec_tool_watcher_t;

/*
 * Create a watcher bound to a (start_name, end_name) pair of special-token
 * names that exist in the map's `special_tokens` table. Returns
 * CODEC_ERR_NOT_FOUND if either name isn't a registered special token:
 * the model may use plain text markers (older Mistral, GPT-2 era), in
 * which case scanning has to happen post-detokenize.
 */
codec_status_t codec_tool_watcher_new(const codec_tokenizer_map_t *map,
                                      const char *start_name,
                                      const char *end_name,
                                      codec_tool_watcher_t **out);

/*
 * Map-less constructor: bind directly to a (start_id, end_id) pair. Use
 * this from inference servers that already own the model's vocab (llama.cpp,
 * vLLM via the HF tokenizer, sglang via TokenizerManager) and don't want
 * to round-trip through a Codec tokenizer map JSON to resolve the marker
 * IDs they already have.
 */
codec_status_t codec_tool_watcher_new_with_ids(uint32_t start_id,
                                               uint32_t end_id,
                                               codec_tool_watcher_t **out);

/* Free the watcher. Safe to pass NULL. */
void codec_tool_watcher_free(codec_tool_watcher_t *w);

/* Drop any in-flight buffered region (e.g. between conversations). */
void codec_tool_watcher_reset(codec_tool_watcher_t *w);

/*
 * Feed N token IDs. *out_events is set to a watcher-owned events array of
 * length *out_len. Pass NULL/0 to flush state inspection without new bytes.
 * The caller does NOT free *out_events: the watcher owns it.
 */
codec_status_t codec_tool_watcher_feed(codec_tool_watcher_t *w,
                                       const uint32_t *ids, size_t n,
                                       codec_watcher_event_t **out_events,
                                       size_t *out_len);

/* Returns true iff the watcher is currently inside a region (start seen,
 * end not yet seen). Useful for "should I keep buffering text instead of
 * forwarding it" decisions outside the watcher's own buffer. */
bool codec_tool_watcher_inside(const codec_tool_watcher_t *w);

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
 *   CODEC_OK: *out filled with a complete frame
 *   CODEC_ERR_INCOMPLETE: no complete frame in the buffer yet
 *   negative: protocol error
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

/* ── Pre-tokenizer program ──────────────────────────────────────────────── */
/*
 * The pre-tokenizer program (v2.1 map field, see
 * spec/PRETOKENIZER_PROGRAM.md) is an ordered list of named ops that
 * splits input text into pieces before BPE merging. It exists so libcodec
 * can do BPE encoding without a Unicode regex engine: eight ops cover
 * every GPT-2-family and SentencePiece-metaspace tokenizer in current
 * use.
 *
 * libcodec parses the program out of the JSON map and exposes it to BPE
 * via the public API below. Most callers won't touch the program
 * directly; they'll just call codec_bpe_encode(). The interpreter is
 * exposed for advanced callers building custom encoders or tooling.
 */

typedef enum codec_pretok_kind {
    CODEC_PRETOK_LITERALS_CI     = 1,
    CODEC_PRETOK_LETTERS         = 2,
    CODEC_PRETOK_NUMBERS         = 3,
    CODEC_PRETOK_PUNCT_RUN       = 4,
    CODEC_PRETOK_NEWLINE_BLOCK   = 5,
    CODEC_PRETOK_TRAILING_WS     = 6,
    CODEC_PRETOK_WS_RUN          = 7,
    CODEC_PRETOK_METASPACE_SPLIT = 8,
} codec_pretok_kind_t;

typedef struct codec_pretok_op {
    codec_pretok_kind_t kind;
    union {
        struct { char **patterns; size_t count; } literals_ci;
        struct { int   lead_other; }              letters;
        struct { uint32_t max_run; }              numbers; /* 0 = unbounded */
        struct { int lead_space, trailing_newlines; } punct_run;
        struct { int prefix_first; }              metaspace_split;
    } u;
} codec_pretok_op_t;

typedef struct codec_pretok_program {
    int                version;     /* 1 for v1 op set */
    codec_pretok_op_t *ops;
    size_t             op_count;
} codec_pretok_program_t;

/* (offset, length) pair into the caller's input buffer. */
typedef struct codec_pretok_piece {
    size_t off;
    size_t len;
} codec_pretok_piece_t;

/* Run the program over UTF-8 input. Pieces alias the input buffer.
 * Free with codec_pretok_free_pieces(). For metaspace single-op
 * programs, returns CODEC_ERR_INVALID_ARG: use codec_pretok_run_metaspace
 * instead, which produces freshly-allocated prefixed pieces. */
codec_status_t codec_pretok_run_program(
    const codec_pretok_program_t *prog,
    const uint8_t *input, size_t input_len,
    codec_pretok_piece_t **out_pieces, size_t *out_count);

void codec_pretok_free_pieces(codec_pretok_piece_t *pieces);

/* Metaspace splitter: fresh ▁-prefixed pieces. Output pieces are
 * caller-owned; free with codec_pretok_free_metaspace_pieces(). */
codec_status_t codec_pretok_run_metaspace(
    const uint8_t *input, size_t input_len,
    int prefix_first,
    char ***out_pieces, size_t *out_count);

void codec_pretok_free_metaspace_pieces(char **pieces, size_t count);

/* ── BPE encoder ────────────────────────────────────────────────────────── */
/*
 * codec_bpe_encoder is a stateless handle over a tokenizer map. It
 * encodes UTF-8 text into a sequence of token IDs using the map's
 * pre-tokenizer program, BPE merges, and vocab. Bit-identical to the
 * other Codec clients (TS / Python / .NET) and to HuggingFace's
 * reference Rust tokenizer.
 *
 * Usage:
 *   codec_bpe_encoder_t *enc; codec_bpe_encoder_new(map, &enc);
 *   uint32_t *ids; size_t n;
 *   codec_bpe_encode(enc, text, text_len, &ids, &n);
 *   ... use ids ...
 *   free(ids);
 *   codec_bpe_encoder_free(enc);
 *
 * Construction fails (CODEC_ERR_VALIDATION) if the map lacks a
 * pre_tokenizer_program or doesn't carry a byte_level / metaspace
 * encoder. v1 maps and canonical-IR vocab-only maps aren't supported
 * by BPE: the LongestMatchTokenizer path is for those, and is not yet
 * exposed in the C client.
 */
typedef struct codec_bpe_encoder codec_bpe_encoder_t;

codec_status_t codec_bpe_encoder_new(const codec_tokenizer_map_t *map,
                                     codec_bpe_encoder_t **out);
void           codec_bpe_encoder_free(codec_bpe_encoder_t *enc);

/* Encode UTF-8 text to token IDs. Output array is caller-owned;
 * free with free(). */
codec_status_t codec_bpe_encode(codec_bpe_encoder_t *enc,
                                const char *text, size_t text_len,
                                uint32_t **out_ids, size_t *out_count);

/* ── Translator ─────────────────────────────────────────────────────────── */
/*
 * Cross-vocab agent-handoff pipe. Take Agent A's token IDs in vocab V_A,
 * produce Agent B's token IDs in vocab V_B, with no text ever leaving
 * the process. Internally:
 *
 *     ids_A → Detokenizer(V_A) → utf8 → BPETokenizer(V_B) → ids_B
 *
 * The text intermediate is purely local; agent-to-agent traffic still
 * carries only token IDs on the wire. Mirrors the @codecai/web Translator,
 * codecai's Translator, and Codec.Net's Translator: same word-boundary
 * buffering rules.
 *
 * Streaming caveat: BPE merges depend on context, so re-tokenizing
 * partial words mid-stream produces different IDs than re-tokenizing
 * the complete word. The translator buffers text until a safe boundary
 * (whitespace) before flushing through BPE. Pass partial=1 for streaming
 * chunks and partial=0 (or call codec_translator_finish) on the last
 * chunk so the buffer drains.
 *
 * Usage:
 *   codec_translator_t *tr;
 *   codec_translator_new(qwen_map, llama_map, &tr);
 *   uint32_t *llama_ids; size_t n;
 *   codec_translator_translate(tr, qwen_ids, qwen_n, 0, &llama_ids, &n);
 *   ... use llama_ids ...
 *   free(llama_ids);
 *   codec_translator_free(tr);
 */
typedef struct codec_translator codec_translator_t;

codec_status_t codec_translator_new(const codec_tokenizer_map_t *from_map,
                                    const codec_tokenizer_map_t *to_map,
                                    codec_translator_t **out);
void           codec_translator_free(codec_translator_t *tr);

/* Translate a chunk of source-vocab IDs to target-vocab IDs.
 *   partial=1: streaming: a trailing partial word stays buffered
 *   partial=0: final chunk: buffer drains
 * Output array is caller-owned; free with free(). out_ids may be NULL
 * (with out_count=0) if the streaming buffer hasn't reached a safe
 * boundary yet. */
codec_status_t codec_translator_translate(
    codec_translator_t *tr,
    const uint32_t *ids, size_t ids_count,
    int partial,
    uint32_t **out_ids, size_t *out_count);

/* End-of-stream flush. Equivalent to translate(empty, partial=0). */
codec_status_t codec_translator_finish(codec_translator_t *tr,
                                       uint32_t **out_ids, size_t *out_count);

/* Drop all internal state. Call between conversations. */
void           codec_translator_reset(codec_translator_t *tr);

#ifdef __cplusplus
}
#endif

#endif /* CODEC_H */
