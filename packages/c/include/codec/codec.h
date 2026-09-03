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

/* ── Export macro ───────────────────────────────────────────────────────── */
/*
 * CODEC_API annotates every symbol in the public API. It has to resolve
 * correctly in three situations.
 *
 * Building the shared library: the CMakeLists.txt build rule for the
 * codec_shared target defines CODEC_BUILD_SHARED as a PRIVATE compile
 * definition. PRIVATE means only codec_shared's own translation units see
 * it; consumers never do. CODEC_API expands to the compiler's export
 * attribute.
 *
 * Consuming the shared library: the same build rule also defines
 * CODEC_SHARED as an INTERFACE compile definition on codec_shared, so
 * CMake propagates it automatically to any target that links
 * codec::codec, including through find_package() and the installed
 * codec-targets.cmake. A consumer never has to define this by hand.
 * CODEC_API expands to the compiler's import attribute on Windows. On
 * ELF platforms a shared object exports every default-visibility symbol
 * without a matching import-side annotation, so CODEC_API expands to
 * nothing there.
 *
 * Building or consuming the static library: neither macro is defined, so
 * CODEC_API expands to nothing. C_VISIBILITY_PRESET hidden has no effect
 * on a static archive either way.
 *
 * Naming note: CMakeLists.txt also has an option() named
 * CODEC_BUILD_SHARED that picks whether the shared target is built at
 * all. That option lives in CMake's own variable namespace and is
 * resolved at configure time; it never becomes a preprocessor token, so
 * it cannot collide with the compile definition of the same name used
 * here. The consumer-facing macro is still given its own name,
 * CODEC_SHARED, so the build-side and consumer-side cases stay visually
 * distinct in this header.
 */
#ifndef CODEC_API
#  if defined(_WIN32) || defined(__CYGWIN__)
#    if defined(CODEC_BUILD_SHARED)
#      define CODEC_API __declspec(dllexport)
#    elif defined(CODEC_SHARED)
#      define CODEC_API __declspec(dllimport)
#    else
#      define CODEC_API
#    endif
#  elif defined(CODEC_BUILD_SHARED) && (defined(__GNUC__) || defined(__clang__))
#    define CODEC_API __attribute__((visibility("default")))
#  else
#    define CODEC_API
#  endif
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ── Versioning ─────────────────────────────────────────────────────────── */

#define CODEC_VERSION_MAJOR 0
#define CODEC_VERSION_MINOR 2
#define CODEC_VERSION_PATCH 0

CODEC_API const char *codec_version(void);

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
    CODEC_ERR_NOT_BUILT = -10,
    /* A `pre_tokenizer_program.version` this build does not understand.
     * See spec/PRETOKENIZER_PROGRAM.md's Versioning section: guessing at
     * an unrecognised program version's execution model is exactly the
     * silent wrong-shaped output this format exists to prevent. This
     * build understands version 1 (`ops`) and version 2 (`stages`). Any
     * other value, or a version-2 program with no `stages` array, fails
     * with this status at parse time or at codec_pretok_run_program()
     * time. It never falls back to executing a partial program. */
    CODEC_ERR_UNSUPPORTED_PRETOK_VERSION = -11
} codec_status_t;

/* Returns a static, human-readable description for `status`. */
CODEC_API const char *codec_status_str(codec_status_t status);

/* ── Buffer ─────────────────────────────────────────────────────────────── */

typedef struct codec_buffer {
    uint8_t *data;
    size_t   len;
} codec_buffer_t;

/* Free a buffer's contents (does not free the struct itself). */
CODEC_API void codec_buffer_free(codec_buffer_t *buf);

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
CODEC_API codec_status_t codec_map_from_json(const char *json, size_t len,
                                   codec_tokenizer_map_t **out);

/* Free a map allocated by `codec_map_from_json`. Safe to pass NULL. */
CODEC_API void codec_map_free(codec_tokenizer_map_t *map);

/* Read-only accessors. The strings returned point into the map; lifetime
 * is tied to the map. */
CODEC_API const char     *codec_map_id(const codec_tokenizer_map_t *map);
CODEC_API const char     *codec_map_version(const codec_tokenizer_map_t *map);
CODEC_API size_t          codec_map_vocab_size(const codec_tokenizer_map_t *map);
CODEC_API codec_encoder_t codec_map_encoder(const codec_tokenizer_map_t *map);

/*
 * Verify that `json` (the same bytes you parsed) matches `expected_hex`.
 * Accepts `sha256:<hex>` or bare `<hex>`. Constant-time compare.
 *
 * Returns CODEC_OK on match, CODEC_ERR_HASH_MISMATCH on mismatch.
 */
CODEC_API codec_status_t codec_map_verify_sha256(const char *json, size_t len,
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
CODEC_API codec_status_t codec_map_special_id(const codec_tokenizer_map_t *map,
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
CODEC_API const codec_tool_calling_t *codec_map_tool_calling(
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
CODEC_API void codec_frame_init(codec_frame_t *frame);

/* Free `ids` and `finish_reason`; zero the struct. Safe to call repeatedly. */
CODEC_API void codec_frame_destroy(codec_frame_t *frame);

/*
 * Encode a frame to a freshly allocated buffer in the given format.
 * On success, *out owns its bytes (free with codec_buffer_free).
 */
CODEC_API codec_status_t codec_encode_msgpack(const codec_frame_t *frame, codec_buffer_t *out);
CODEC_API codec_status_t codec_encode_protobuf(const codec_frame_t *frame, codec_buffer_t *out);

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
CODEC_API codec_status_t codec_decode_msgpack(const uint8_t *data, size_t len,
                                    codec_frame_t *out, size_t *consumed);
CODEC_API codec_status_t codec_decode_protobuf_frame(const uint8_t *data, size_t len,
                                           codec_frame_t *out);

/* ── Detokenizer ────────────────────────────────────────────────────────── */

typedef struct codec_detokenizer codec_detokenizer_t;

typedef struct codec_detokenize_opts {
    bool partial;        /* buffer trailing partial UTF-8 instead of replacing */
    bool render_special; /* emit special tokens as text */
} codec_detokenize_opts_t;

/* Build a stateful detokenizer bound to `map`. The detokenizer keeps a
 * reference to the map; the map must outlive the detokenizer. */
CODEC_API codec_status_t codec_detokenizer_new(const codec_tokenizer_map_t *map,
                                     codec_detokenizer_t **out);

/* Free a detokenizer. Safe to pass NULL. */
CODEC_API void codec_detokenizer_free(codec_detokenizer_t *detok);

/* Reset internal partial-byte buffer. Call between conversations. */
CODEC_API void codec_detokenizer_reset(codec_detokenizer_t *detok);

/*
 * Render a chunk of token IDs to UTF-8 text. Stateful across calls.
 *
 * On success *out is a heap-allocated NUL-terminated string. *out_len is
 * the strlen (not counting the NUL). Caller frees with `free()`.
 *
 * If opts.partial is true, trailing partial multi-byte UTF-8 sequences are
 * buffered for the next call.
 */
CODEC_API codec_status_t codec_detokenizer_render(codec_detokenizer_t *detok,
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
 *   // The generation loop knows when the stream is over; the watcher
 *   // does not. Call this once, after the last feed(), even (especially)
 *   // when the model hit its length limit mid tool-call:
 *   codec_tool_watcher_end(w, frame.finish_reason, &evs, &n);
 *
 * Lifetimes: the events array and any PASSTHROUGH / NESTED_START `ids`
 * pointers reference the input buffer passed to the most recent feed()
 * call. REGION_END / REGION_TRUNCATED / REGION_OVERFLOW `ids` pointers
 * reference the watcher's own region arena. Either way they stay valid
 * until the next codec_tool_watcher_feed or codec_tool_watcher_end call
 * (or until codec_tool_watcher_free). Copy them out if you need them
 * across feeds.
 *
 * Region buffer cap: a client that can make the model emit a start marker
 * without ever emitting the matching end marker would otherwise grow the
 * region buffer for the rest of the generation. codec_tool_watcher_new*
 * initialises the cap to CODEC_TOOL_WATCHER_DEFAULT_REGION_CAP; call
 * codec_tool_watcher_set_region_cap to change it. Hitting the cap does not
 * silently truncate: it emits a CODEC_WATCH_REGION_OVERFLOW event carrying
 * everything buffered so far, then keeps scanning (without buffering
 * further body tokens) for the end marker so passthrough can resync.
 *
 * Unterminated regions: feed() cannot know the stream has ended, so a
 * region still open when the last feed() returns is simply left buffered.
 * Call codec_tool_watcher_end() once you know no more tokens are coming.
 * If the watcher is still inside a region at that point, it emits a
 * CODEC_WATCH_REGION_TRUNCATED event carrying whatever was buffered (which
 * may be empty) and the finish_reason you pass in, so the caller can tell
 * "the model hit its length limit mid tool-call" (finish_reason "length")
 * apart from "the model emitted a malformed / truncated tool call on its
 * own" (any other finish_reason, or NULL if unknown).
 *
 * Nested start markers: a start marker seen while already inside a region
 * does not open a nested region (most chat models don't nest these
 * markers, and treating an inner start as a new region would silently
 * drop the outer content). It is dropped from the region body, but it is
 * not silently swallowed: it is surfaced as a CODEC_WATCH_NESTED_START
 * event so a caller that cares can see it happened.
 *
 * Known limitation, not yet handled: this watcher assumes the start
 * marker is exclusive to tool calls and a single end_id always confirms
 * one. That assumption breaks on formats where the same start marker
 * opens every assistant message and the closing token is what decides,
 * after the fact, whether the message was a tool call at all. gpt-oss
 * harmony is exactly this shape: <|start|> (200006) opens EVERY
 * assistant message (analysis, commentary preamble, a tool call, and the
 * final answer alike); <|channel|> (200005) and <|message|> (200008)
 * are structural, not tool-call-specific; and only the closing token
 * says what the message was: <|call|> (200012) confirms a tool call,
 * while <|end|> (200007) or <|return|> (200002) means it was not. Wiring
 * today's watcher with start_id = <|start|> and end_id = <|call|> would
 * open a region on every assistant turn and, on any non-tool-call turn,
 * never see <|call|>: the region would stay open and silently absorb
 * everything until some later real tool call finally closed it,
 * corrupting good output rather than dropping bad output. Supporting
 * this needs a set of closing tokens with different outcomes (a CONFIRM
 * close that emits CODEC_WATCH_REGION_END, and a REJECT close that
 * discards the buffered span and re-emits it as CODEC_WATCH_PASSTHROUGH
 * in its original position, since those tokens are real assistant
 * output the caller must still receive), not the current single end_id.
 * That is future work, deliberately out of scope here: the event kinds
 * above (PASSTHROUGH / REGION_END in particular) already cover both
 * outcomes, so adding it later is additive, not a rewrite of this enum.
 * Separately: DeepSeek-R1's markers such as <｜tool▁calls▁begin｜> use
 * full-width pipe characters (U+FF5C, not ASCII '|'); confirm the
 * resolved special-token IDs before wiring a watcher to them, the same
 * way you would for any other model.
 */

/* Default cap on the number of token IDs buffered inside one open region.
 * 65536 tokens is comfortably above any real tool-call payload while still
 * bounding worst-case per-watcher memory (65536 * sizeof(uint32_t) = 256
 * KiB) against a client that can make the model emit a start marker
 * without a matching end marker. */
#define CODEC_TOOL_WATCHER_DEFAULT_REGION_CAP ((size_t)65536)

typedef enum codec_watcher_event_kind {
    CODEC_WATCH_PASSTHROUGH      = 0, /* IDs outside any watched region */
    CODEC_WATCH_REGION_END       = 1, /* a complete start..end region was captured */
    CODEC_WATCH_REGION_TRUNCATED = 2, /* codec_tool_watcher_end() while still inside a region */
    CODEC_WATCH_REGION_OVERFLOW  = 3, /* region buffer hit its cap; ids is the capped prefix */
    CODEC_WATCH_NESTED_START     = 4  /* a start marker was seen while already inside a region */
} codec_watcher_event_kind_t;

typedef struct codec_watcher_event {
    codec_watcher_event_kind_t kind;
    const uint32_t            *ids;
    size_t                     ids_len;
    /* Only set (non-NULL) on CODEC_WATCH_REGION_TRUNCATED, and only when
     * the caller passed a non-NULL finish_reason to codec_tool_watcher_end.
     * Borrowed from the caller's argument: same lifetime as `ids` above. */
    const char                *finish_reason;
} codec_watcher_event_t;

typedef struct codec_tool_watcher codec_tool_watcher_t;

/*
 * Create a watcher bound to a (start_name, end_name) pair of special-token
 * names that exist in the map's `special_tokens` table. Returns
 * CODEC_ERR_NOT_FOUND if either name isn't a registered special token:
 * the model may use plain text markers (older Mistral, GPT-2 era), in
 * which case scanning has to happen post-detokenize.
 */
CODEC_API codec_status_t codec_tool_watcher_new(const codec_tokenizer_map_t *map,
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
CODEC_API codec_status_t codec_tool_watcher_new_with_ids(uint32_t start_id,
                                               uint32_t end_id,
                                               codec_tool_watcher_t **out);

/* Free the watcher. Safe to pass NULL. */
CODEC_API void codec_tool_watcher_free(codec_tool_watcher_t *w);

/* Drop any in-flight buffered region (e.g. between conversations). */
CODEC_API void codec_tool_watcher_reset(codec_tool_watcher_t *w);

/*
 * Feed N token IDs. *out_events is set to a watcher-owned events array of
 * length *out_len. Pass NULL/0 to flush state inspection without new bytes.
 * The caller does NOT free *out_events: the watcher owns it.
 */
CODEC_API codec_status_t codec_tool_watcher_feed(codec_tool_watcher_t *w,
                                       const uint32_t *ids, size_t n,
                                       codec_watcher_event_t **out_events,
                                       size_t *out_len);

/*
 * Signal end of stream. feed() has no way to know the stream is over, so
 * the caller must call this explicitly once (e.g. right after decoding a
 * frame whose `done` is true).
 *
 * If the watcher is currently inside a region, emits a single
 * CODEC_WATCH_REGION_TRUNCATED event carrying whatever was buffered (empty
 * if the stream ended right after the start marker) and the given
 * finish_reason (borrowed; pass NULL if unknown). If the watcher is not
 * inside a region, *out_len is set to 0: calling codec_tool_watcher_end on
 * a cleanly finished stream is a no-op.
 *
 * Like feed(), reuses and owns the watcher's events array: the caller does
 * NOT free *out_events. Safe to call more than once; the second call sees
 * no in-flight region and reports zero events.
 */
CODEC_API codec_status_t codec_tool_watcher_end(codec_tool_watcher_t *w,
                                      const char *finish_reason,
                                      codec_watcher_event_t **out_events,
                                      size_t *out_len);

/* Returns true iff the watcher is currently inside a region (start seen,
 * end not yet seen). Useful for "should I keep buffering text instead of
 * forwarding it" decisions outside the watcher's own buffer. */
CODEC_API bool codec_tool_watcher_inside(const codec_tool_watcher_t *w);

/*
 * Get / set the cap on the number of token IDs buffered inside one open
 * region. New watchers start at CODEC_TOOL_WATCHER_DEFAULT_REGION_CAP.
 * Passing 0 to the setter resets to that default (a cap of exactly 0 is
 * not a useful configuration: no region could ever buffer anything).
 * Changing the cap does not retroactively affect a region already in
 * progress beyond the next token fed to it.
 */
CODEC_API size_t codec_tool_watcher_region_cap(const codec_tool_watcher_t *w);
CODEC_API void   codec_tool_watcher_set_region_cap(codec_tool_watcher_t *w, size_t cap);

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

CODEC_API codec_status_t codec_msgpack_stream_new(codec_msgpack_stream_t **out);
CODEC_API void           codec_msgpack_stream_free(codec_msgpack_stream_t *dec);
CODEC_API codec_status_t codec_msgpack_stream_feed(codec_msgpack_stream_t *dec,
                                         const uint8_t *data, size_t len);
CODEC_API codec_status_t codec_msgpack_stream_next(codec_msgpack_stream_t *dec,
                                         codec_frame_t *out);

CODEC_API codec_status_t codec_protobuf_stream_new(codec_protobuf_stream_t **out);
CODEC_API void           codec_protobuf_stream_free(codec_protobuf_stream_t *dec);
CODEC_API codec_status_t codec_protobuf_stream_feed(codec_protobuf_stream_t *dec,
                                          const uint8_t *data, size_t len);
CODEC_API codec_status_t codec_protobuf_stream_next(codec_protobuf_stream_t *dec,
                                          codec_frame_t *out);

/* ── Pre-tokenizer program ──────────────────────────────────────────────── */
/*
 * The pre-tokenizer program (see spec/PRETOKENIZER_PROGRAM.md) is a
 * compiled description of a model's HuggingFace pre-tokenizer that
 * splits input text into pieces before BPE merging. It exists so
 * libcodec can do BPE encoding without a Unicode regex engine: a small,
 * named op/stage set covers every GPT-2-family, SentencePiece-metaspace,
 * and HuggingFace `Sequence` tokenizer in current use.
 *
 * Two program shapes exist, distinguished by `version`:
 *
 *   - v1 (`version == 1`): a flat, ordered list of `ops`. The whole
 *     program is one alternation scan over the raw input text. `ops` /
 *     `op_count` are populated; `stages` / `stage_count` are NULL / 0.
 *   - v2 (`version == 2`): an ordered list of `stages`, mirroring
 *     HuggingFace's `Sequence` pre-tokenizer exactly. Each stage
 *     transforms the full piece list the stage before it produced.
 *     `stages` / `stage_count` are populated; `ops` / `op_count` are
 *     NULL / 0. Required for SmolLM2, Falcon, DeepSeek-V3 and
 *     DeepSeek-R1: see spec/PRETOKENIZER_PROGRAM.md § Stages (v2).
 *
 * A `version` this build doesn't recognise (anything other than 1 or 2)
 * fails loudly at parse time, and again defensively at
 * codec_pretok_run_program() time, with CODEC_ERR_UNSUPPORTED_PRETOK_VERSION.
 * It never falls back to guessing an execution model.
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
    /* Case-sensitive literal alternatives: like LITERALS_CI but exact
     * case. Used by the older OpenAI tokenizers (p50k_base, r50k_base)
     * and by ByteLevel(use_regex=true)'s fixed internal op list, which a
     * v2 `alternation` stage runs for SmolLM2 and Falcon. */
    CODEC_PRETOK_LITERALS             = 9,
    /* `[!-\/:-@\[-`{-~][A-Za-z]+`: one ASCII punctuation char then 1+
     * ASCII letters. DeepSeek-V3's third `Split` stage's first
     * alternative; see spec/PRETOKENIZER_PROGRAM.md § punct_ascii_letters. */
    CODEC_PRETOK_PUNCT_ASCII_LETTERS  = 10,
    /* Case-boundary letter run (o200k_base, o200k_harmony,
     * mistral-nemo): splits "MyCamelCase" into "My"/"Camel"/"Case".
     * See spec/PRETOKENIZER_PROGRAM.md § letters_cased. Not used by any
     * of the four v2 Sequence maps; carried here because it is a v1 op
     * that libcodec never implemented, and its absence made three
     * published maps fail to load in C at all (CODEC_ERR_PARSE), not
     * merely mis-tokenize. */
    CODEC_PRETOK_LETTERS_CASED        = 11,
} codec_pretok_kind_t;

/* `letters_cased.kind`. TITLE matches `[Lu Lt Lm Lo M]* [Ll Lm Lo M]+`
 * (zero-or-more upper-cluster chars, then one-or-more lower-cluster
 * chars). UPPER matches `[Lu Lt Lm Lo M]+ [Ll Lm Lo M]*` (the reverse
 * minimum: at least one upper-cluster char, then zero-or-more lower). */
typedef enum codec_pretok_cased_kind {
    CODEC_PRETOK_CASED_TITLE = 0,
    CODEC_PRETOK_CASED_UPPER = 1,
} codec_pretok_cased_kind_t;

/* `letters.lead_other_class`: which class the optional `lead_other` lead
 * character must avoid. L_N (default) excludes \r \n \p{L} \p{N}. L_P_S
 * excludes \r \n \p{L} \p{P} \p{S} instead, admitting a digit or a bare
 * symbol at the lead position: DeepSeek-V3's third `Split` stage. */
typedef enum codec_pretok_lead_other_class {
    CODEC_PRETOK_LEAD_OTHER_L_N   = 0,
    CODEC_PRETOK_LEAD_OTHER_L_P_S = 1,
} codec_pretok_lead_other_class_t;

/* `letters.body`: the letter-run body class. L (default) is `\p{L}+`.
 * L_M is `[\p{L}\p{M}]+`: a base letter and a following combining mark
 * stay one piece. DeepSeek-V3's third `Split` stage. */
typedef enum codec_pretok_letters_body {
    CODEC_PRETOK_LETTERS_BODY_L   = 0,
    CODEC_PRETOK_LETTERS_BODY_L_M = 1,
} codec_pretok_letters_body_t;

/* `punct_run.charset`: the run's own body class. NOT_WS_L_N (default) is
 * the GPT-2-family complement class `[^\s\p{L}\p{N}]+`. P_S is
 * `[\p{P}\p{S}]+`: DeepSeek-V3's third `Split` stage names its
 * punctuation/symbol class explicitly, excluding combining marks and any
 * other category the complement class would otherwise sweep in. */
typedef enum codec_pretok_punct_charset {
    CODEC_PRETOK_PUNCT_CHARSET_NOT_WS_L_N = 0,
    CODEC_PRETOK_PUNCT_CHARSET_P_S        = 1,
} codec_pretok_punct_charset_t;

typedef struct codec_pretok_op {
    codec_pretok_kind_t kind;
    union {
        struct { char **patterns; size_t count; } literals_ci;
        struct { char **patterns; size_t count; } literals; /* case-sensitive */
        struct {
            int lead_other;
            int lead_space;   /* mutually exclusive with lead_other */
            codec_pretok_lead_other_class_t lead_other_class;
            codec_pretok_letters_body_t     body;
        } letters;
        struct { uint32_t max_run; int lead_space; } numbers; /* max_run 0 = unbounded */
        struct {
            int lead_space, trailing_newlines;
            codec_pretok_punct_charset_t charset;
            /* Overrides trailing_newlines with an explicit trailing
             * charset when non-NULL: o200k_base / mistral-nemo /
             * o200k_harmony trailing runs use "\r\n/" (note the `/`).
             * Each byte in the string is accepted in the trailing run,
             * ASCII-only (every published map's value is). NULL means
             * "use trailing_newlines instead", the pre-existing
             * behaviour. */
            char *trailing_chars;
        } punct_run;
        /* punct_ascii_letters carries no fields. */
        struct {
            codec_pretok_cased_kind_t kind;
            int      lead_other;
            char   **trailing_ci;       /* NULL if absent */
            size_t   trailing_ci_count;
        } letters_cased;
        struct { int prefix_first; } metaspace_split;
    } u;
} codec_pretok_op_t;

/* ── v2 stages ─────────────────────────────────────────────────────────── */

typedef enum codec_pretok_stage_kind {
    CODEC_PRETOK_STAGE_DIGITS_ISOLATE         = 1,
    CODEC_PRETOK_STAGE_DIGIT_TRIPLES_ISOLATE  = 2,
    CODEC_PRETOK_STAGE_PUNCTUATION_CONTIGUOUS = 3,
    CODEC_PRETOK_STAGE_CJK_ISOLATE            = 4,
    CODEC_PRETOK_STAGE_ALTERNATION            = 5,
} codec_pretok_stage_kind_t;

typedef enum codec_pretok_digits_mode {
    CODEC_PRETOK_DIGITS_INDIVIDUAL = 0,
    CODEC_PRETOK_DIGITS_GROUPED    = 1,
} codec_pretok_digits_mode_t;

typedef struct codec_pretok_stage {
    codec_pretok_stage_kind_t kind;
    union {
        /* max_run only meaningful for mode == GROUPED; 0 = unbounded. */
        struct { codec_pretok_digits_mode_t mode; uint32_t max_run; } digits_isolate;
        struct { codec_pretok_op_t *ops; size_t op_count; } alternation;
        /* digit_triples_isolate, punctuation_contiguous, cjk_isolate carry
         * no fields. */
    } u;
} codec_pretok_stage_t;

typedef struct codec_pretok_program {
    int version;                  /* 1 or 2; see § above */
    codec_pretok_op_t    *ops;    /* v1 only; NULL when version == 2 */
    size_t                op_count;
    codec_pretok_stage_t  *stages; /* v2 only; NULL when version == 1 */
    size_t                 stage_count;
} codec_pretok_program_t;

/* (offset, length) pair into the caller's input buffer. */
typedef struct codec_pretok_piece {
    size_t off;
    size_t len;
} codec_pretok_piece_t;

/* Run the program over UTF-8 input. Pieces alias the input buffer.
 * Free with codec_pretok_free_pieces(). For metaspace single-op
 * programs, returns CODEC_ERR_INVALID_ARG: use codec_pretok_run_metaspace
 * instead, which produces freshly-allocated prefixed pieces. Returns
 * CODEC_ERR_UNSUPPORTED_PRETOK_VERSION for a `version` other than 1 or 2:
 * see § Pre-tokenizer program above. */
CODEC_API codec_status_t codec_pretok_run_program(
    const codec_pretok_program_t *prog,
    const uint8_t *input, size_t input_len,
    codec_pretok_piece_t **out_pieces, size_t *out_count);

CODEC_API void codec_pretok_free_pieces(codec_pretok_piece_t *pieces);

/* Metaspace splitter: fresh ▁-prefixed pieces. Output pieces are
 * caller-owned; free with codec_pretok_free_metaspace_pieces(). */
CODEC_API codec_status_t codec_pretok_run_metaspace(
    const uint8_t *input, size_t input_len,
    int prefix_first,
    char ***out_pieces, size_t *out_count);

CODEC_API void codec_pretok_free_metaspace_pieces(char **pieces, size_t count);

/* ── BPE encoder ────────────────────────────────────────────────────────── */
/*
 * codec_bpe_encoder is a handle over a tokenizer map, built once and
 * reused across encode calls. It encodes UTF-8 text into a sequence of
 * token IDs using the map's special tokens, pre-tokenizer program, BPE
 * merges, and vocab. Bit-identical to the other Codec clients (TS /
 * Python / .NET) and to HuggingFace's reference Rust tokenizer.
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

CODEC_API codec_status_t codec_bpe_encoder_new(const codec_tokenizer_map_t *map,
                                     codec_bpe_encoder_t **out);
CODEC_API void           codec_bpe_encoder_free(codec_bpe_encoder_t *enc);

/* Encode UTF-8 text to token IDs. Output array is caller-owned;
 * free with free(). */
CODEC_API codec_status_t codec_bpe_encode(codec_bpe_encoder_t *enc,
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

CODEC_API codec_status_t codec_translator_new(const codec_tokenizer_map_t *from_map,
                                    const codec_tokenizer_map_t *to_map,
                                    codec_translator_t **out);
CODEC_API void           codec_translator_free(codec_translator_t *tr);

/* Translate a chunk of source-vocab IDs to target-vocab IDs.
 *   partial=1: streaming: a trailing partial word stays buffered
 *   partial=0: final chunk: buffer drains
 * Output array is caller-owned; free with free(). out_ids may be NULL
 * (with out_count=0) if the streaming buffer hasn't reached a safe
 * boundary yet. */
CODEC_API codec_status_t codec_translator_translate(
    codec_translator_t *tr,
    const uint32_t *ids, size_t ids_count,
    int partial,
    uint32_t **out_ids, size_t *out_count);

/* End-of-stream flush. Equivalent to translate(empty, partial=0). */
CODEC_API codec_status_t codec_translator_finish(codec_translator_t *tr,
                                       uint32_t **out_ids, size_t *out_count);

/* Drop all internal state. Call between conversations. */
CODEC_API void           codec_translator_reset(codec_translator_t *tr);

#ifdef __cplusplus
}
#endif

#endif /* CODEC_H */
