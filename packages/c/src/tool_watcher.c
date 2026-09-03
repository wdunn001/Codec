/* Tool-call / region watcher.
 *
 * Scans a token-ID stream for a (start_id, end_id) pair without going
 * through the detokenizer. Emits passthrough runs (everything outside any
 * watched region) and complete regions (everything between start and end,
 * markers excluded) as a flat, stream-ordered array of events per feed()
 * call.
 *
 * Memory model:
 *   - PASSTHROUGH and NESTED_START events point directly into the
 *     caller's input buffer; valid only until the next feed() or end()
 *     call.
 *   - REGION_END, REGION_TRUNCATED and REGION_OVERFLOW events point into
 *     the watcher's own arena; valid until the next feed() or end() call
 *     (or watcher_free).
 *   - The events array is owned by the watcher and reused across calls;
 *     the caller MUST NOT free it.
 *
 * Edge cases handled:
 *   - Region split across multiple feeds: state survives between calls,
 *     buffer continues accumulating until end token arrives.
 *   - Stray end_id outside a region: ignored (passes through as-is).
 *   - Nested start_id inside an active region: dropped from the region
 *     body (most chat models don't nest these markers, and treating an
 *     inner start as a new region would silently drop the outer content)
 *     but surfaced as a CODEC_WATCH_NESTED_START event so it isn't
 *     swallowed without a trace.
 *   - Region buffer exceeding its configured cap: stops growing the
 *     buffer and emits CODEC_WATCH_REGION_OVERFLOW with what was captured
 *     so far, then keeps scanning (without buffering) for the end marker.
 *   - Stream ending while still inside a region: feed() cannot know the
 *     stream is over. The caller must call codec_tool_watcher_end(), which
 *     emits CODEC_WATCH_REGION_TRUNCATED for whatever was buffered instead
 *     of silently dropping it.
 */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stdlib.h>
#include <string.h>

struct codec_tool_watcher {
    uint32_t start_id;
    uint32_t end_id;
    bool     inside;
    /* True once the in-progress region has hit region_cap_max and emitted
     * its CODEC_WATCH_REGION_OVERFLOW event. While set, incoming body
     * tokens are dropped (not buffered, not re-reported) until end_id
     * closes the region. */
    bool     region_capped;
    /* Configurable cap on region_len - region_start. See
     * codec_tool_watcher_set_region_cap. */
    size_t   region_cap_max;

    /* Captured-region arena. The REGION_END/REGION_TRUNCATED/
     * REGION_OVERFLOW events handed back to the caller point into it and
     * must all stay valid until the next feed()/end(). Every region
     * completed (or overflowed, or truncated) during the current call
     * therefore keeps its own span here. Resetting per region (the
     * original design) made the second region alias and then realloc out
     * from under the first.
     * `region_start` is where the region currently being captured begins. */
    uint32_t *region_buf;
    size_t    region_len;
    size_t    region_cap;
    size_t    region_start;

    /* Events array reused across feed()/end() calls. */
    codec_watcher_event_t *events;
    size_t                 events_len;
    size_t                 events_cap;
    /* Parallel to `events`. For a REGION_END/REGION_TRUNCATED/
     * REGION_OVERFLOW event this holds the region's offset into
     * region_buf; every other event kind holds NO_REGION. The arena can
     * move under realloc mid-feed. The pointers are resolved once, at the
     * end of feed()/end(). */
    size_t                *event_region_off;
    size_t                 event_region_off_cap;
};

#define WATCHER_NO_REGION ((size_t)-1)

static int region_buf_reserve(codec_tool_watcher_t *w, size_t need) {
    if (w->region_cap >= need) return 1;
    size_t cap = w->region_cap ? w->region_cap : 16;
    while (cap < need) cap *= 2;
    uint32_t *p = (uint32_t *)realloc(w->region_buf, cap * sizeof(uint32_t));
    if (!p) return 0;
    w->region_buf = p;
    w->region_cap = cap;
    return 1;
}

static int events_reserve(codec_tool_watcher_t *w, size_t need) {
    if (w->events_cap >= need) return 1;
    size_t cap = w->events_cap ? w->events_cap : 4;
    while (cap < need) cap *= 2;
    codec_watcher_event_t *p = (codec_watcher_event_t *)realloc(
        w->events, cap * sizeof(codec_watcher_event_t));
    if (!p) return 0;
    w->events = p;
    w->events_cap = cap;
    if (w->event_region_off_cap < cap) {
        size_t *q = (size_t *)realloc(w->event_region_off, cap * sizeof(size_t));
        if (!q) return 0;
        w->event_region_off = q;
        w->event_region_off_cap = cap;
    }
    return 1;
}

static int emit(codec_tool_watcher_t *w,
                codec_watcher_event_kind_t kind,
                const uint32_t *ids, size_t len) {
    /* Skip degenerate empty events: they add noise without information.
     * Only PASSTHROUGH and NESTED_START come through here, and neither
     * can legitimately be empty (the passthrough guards require
     * i > pt_start / pt_start < n, and a nested start is always one
     * token). Region-bearing events go through emit_region(), which
     * deliberately does NOT suppress empty spans. */
    if (len == 0) return 1;
    if (!events_reserve(w, w->events_len + 1)) return 0;
    w->events[w->events_len].kind          = kind;
    w->events[w->events_len].ids           = ids;
    w->events[w->events_len].ids_len       = len;
    w->events[w->events_len].finish_reason = NULL;
    w->event_region_off[w->events_len] = WATCHER_NO_REGION;
    w->events_len++;
    return 1;
}

/* Emit a REGION_END or REGION_OVERFLOW event for the arena span
 * [off, off + len). The `ids` pointer is filled in after the feed loop,
 * once the arena has stopped moving.
 *
 * Unlike emit(), a zero-length span IS emitted. An empty region
 * (start marker immediately followed by end marker) is a real, complete
 * region: the model emitted a syntactically well-formed but empty tool
 * call. Suppressing the event would make that indistinguishable from
 * "no tool call happened", which is the same class of silent swallow
 * that REGION_TRUNCATED and NESTED_START exist to prevent. The other
 * five implementations (TypeScript, Python, Rust, Java, .NET) all emit
 * it; see packages/tool-watcher-conformance. `ids` is NULL when len is
 * 0, matching the empty-body REGION_TRUNCATED contract in
 * codec_tool_watcher_end.
 *
 * REGION_OVERFLOW is never zero-length: region_cap_max is normalised to
 * at least 1 by codec_tool_watcher_set_region_cap, so the cap check
 * cannot fire before the first body token is buffered. */
static int emit_region(codec_tool_watcher_t *w,
                       codec_watcher_event_kind_t kind,
                       size_t off, size_t len) {
    if (!events_reserve(w, w->events_len + 1)) return 0;
    w->events[w->events_len].kind          = kind;
    w->events[w->events_len].ids           = NULL;
    w->events[w->events_len].ids_len       = len;
    w->events[w->events_len].finish_reason = NULL;
    w->event_region_off[w->events_len] = off;
    w->events_len++;
    return 1;
}

codec_status_t codec_tool_watcher_new(const codec_tokenizer_map_t *map,
                                      const char *start_name,
                                      const char *end_name,
                                      codec_tool_watcher_t **out) {
    if (!map || !start_name || !end_name || !out) return CODEC_ERR_INVALID_ARG;

    uint32_t start_id, end_id;
    codec_status_t s1 = codec_map_special_id(map, start_name, &start_id);
    if (s1 != CODEC_OK) return s1;
    codec_status_t s2 = codec_map_special_id(map, end_name, &end_id);
    if (s2 != CODEC_OK) return s2;

    return codec_tool_watcher_new_with_ids(start_id, end_id, out);
}

codec_status_t codec_tool_watcher_new_with_ids(uint32_t start_id,
                                               uint32_t end_id,
                                               codec_tool_watcher_t **out) {
    if (!out) return CODEC_ERR_INVALID_ARG;
    codec_tool_watcher_t *w = (codec_tool_watcher_t *)calloc(1, sizeof(*w));
    if (!w) return CODEC_ERR_OUT_OF_MEMORY;
    w->start_id       = start_id;
    w->end_id         = end_id;
    w->region_cap_max = CODEC_TOOL_WATCHER_DEFAULT_REGION_CAP;
    *out = w;
    return CODEC_OK;
}

void codec_tool_watcher_free(codec_tool_watcher_t *w) {
    if (!w) return;
    free(w->event_region_off);
    free(w->region_buf);
    free(w->events);
    free(w);
}

void codec_tool_watcher_reset(codec_tool_watcher_t *w) {
    if (!w) return;
    w->inside        = false;
    w->region_capped = false;
    w->region_len    = 0;
    w->region_start  = 0;
    w->events_len    = 0;
}

bool codec_tool_watcher_inside(const codec_tool_watcher_t *w) {
    return w && w->inside;
}

size_t codec_tool_watcher_region_cap(const codec_tool_watcher_t *w) {
    return w ? w->region_cap_max : 0;
}

void codec_tool_watcher_set_region_cap(codec_tool_watcher_t *w, size_t cap) {
    if (!w) return;
    w->region_cap_max = cap ? cap : CODEC_TOOL_WATCHER_DEFAULT_REGION_CAP;
}

codec_status_t codec_tool_watcher_feed(codec_tool_watcher_t *w,
                                       const uint32_t *ids, size_t n,
                                       codec_watcher_event_t **out_events,
                                       size_t *out_len) {
    if (!w) return CODEC_ERR_INVALID_ARG;
    /* Reset events from previous call: pointers issued earlier are now
     * stale (the input buffer has rolled over and the region buffer may
     * have been overwritten). */
    w->events_len = 0;

    /* Recycle the arena. Spans captured for the previous call's events are
     * dead now. A region still in progress may span any number of feeds.
     * It has to survive. Slide it down to offset 0 and drop the rest. */
    if (w->inside) {
        if (w->region_start > 0) {
            memmove(w->region_buf, w->region_buf + w->region_start,
                    (w->region_len - w->region_start) * sizeof(uint32_t));
            w->region_len -= w->region_start;
            w->region_start = 0;
        }
    } else {
        w->region_len   = 0;
        w->region_start = 0;
    }

    /* `pt_start` is the start index of the current passthrough run within
     * `ids`. We emit a passthrough event whenever we transition into a
     * region or finish processing the input. */
    size_t pt_start = 0;

    for (size_t i = 0; i < n; i++) {
        uint32_t id = ids[i];

        if (!w->inside) {
            if (id == w->start_id) {
                /* Flush any passthrough run accumulated up to (but not
                 * including) the start marker. The marker itself is
                 * consumed: orchestrators don't want to forward the
                 * "begin tool call" token to the next agent. */
                if (i > pt_start) {
                    if (!emit(w, CODEC_WATCH_PASSTHROUGH,
                              &ids[pt_start], i - pt_start)) {
                        return CODEC_ERR_OUT_OF_MEMORY;
                    }
                }
                w->inside       = true;
                w->region_capped = false;
                w->region_start = w->region_len;
                /* pt_start gets re-anchored when we exit the region. */
            }
            /* else: token continues the passthrough run; no action. */
        } else {
            if (id == w->end_id) {
                /* Region complete. Record the arena span, unless the
                 * region already overflowed: that case was reported once,
                 * at the moment the cap was hit, and the caller doesn't
                 * need a second event for the same region. */
                if (!w->region_capped) {
                    if (!emit_region(w, CODEC_WATCH_REGION_END, w->region_start,
                                     w->region_len - w->region_start)) {
                        return CODEC_ERR_OUT_OF_MEMORY;
                    }
                }
                w->inside        = false;
                w->region_capped = false;
                pt_start         = i + 1;  /* passthrough resumes after end marker */
            } else if (id == w->start_id) {
                /* Nested start: dropped from the region body (see file
                 * comment) but surfaced so it isn't silently swallowed.
                 * Aliases the caller's input buffer, like PASSTHROUGH. */
                if (!emit(w, CODEC_WATCH_NESTED_START, &ids[i], 1)) {
                    return CODEC_ERR_OUT_OF_MEMORY;
                }
            } else if (w->region_capped) {
                /* Already reported CODEC_WATCH_REGION_OVERFLOW for this
                 * region. Keep scanning for end_id without buffering
                 * further body tokens: memory stays bounded. */
            } else if (w->region_len - w->region_start >= w->region_cap_max) {
                /* Cap hit on this token. Report what's buffered so far,
                 * then stop growing: do not silently truncate. */
                if (!emit_region(w, CODEC_WATCH_REGION_OVERFLOW, w->region_start,
                                 w->region_len - w->region_start)) {
                    return CODEC_ERR_OUT_OF_MEMORY;
                }
                w->region_capped = true;
            } else {
                if (!region_buf_reserve(w, w->region_len + 1)) {
                    return CODEC_ERR_OUT_OF_MEMORY;
                }
                w->region_buf[w->region_len++] = id;
            }
        }
    }

    /* Trailing passthrough run, if any. Only emitted when we end OUTSIDE
     * a region: if we end mid-region, the data stays buffered. */
    if (!w->inside && pt_start < n) {
        if (!emit(w, CODEC_WATCH_PASSTHROUGH,
                  &ids[pt_start], n - pt_start)) {
            return CODEC_ERR_OUT_OF_MEMORY;
        }
    }

    /* The arena is final now. Turn the recorded spans into pointers. */
    for (size_t e = 0; e < w->events_len; e++) {
        if (w->event_region_off[e] == WATCHER_NO_REGION) continue;
        w->events[e].ids = w->events[e].ids_len
            ? w->region_buf + w->event_region_off[e]
            : NULL;
    }

    if (out_events) *out_events = w->events;
    if (out_len)    *out_len    = w->events_len;
    return CODEC_OK;
}

codec_status_t codec_tool_watcher_end(codec_tool_watcher_t *w,
                                      const char *finish_reason,
                                      codec_watcher_event_t **out_events,
                                      size_t *out_len) {
    if (!w) return CODEC_ERR_INVALID_ARG;
    w->events_len = 0;

    if (w->inside) {
        /* Built by hand rather than through emit_region() because this is
         * the only event that carries a finish_reason. An empty body
         * (stream ended right after the start marker) is emitted, not
         * suppressed: that is exactly the case this event exists to
         * report. */
        size_t len = w->region_len - w->region_start;
        if (!events_reserve(w, w->events_len + 1)) {
            return CODEC_ERR_OUT_OF_MEMORY;
        }
        size_t idx = w->events_len;
        w->events[idx].kind          = CODEC_WATCH_REGION_TRUNCATED;
        w->events[idx].ids           = NULL; /* resolved below */
        w->events[idx].ids_len       = len;
        w->events[idx].finish_reason = finish_reason;
        w->event_region_off[idx]     = w->region_start;
        w->events_len++;

        w->inside        = false;
        w->region_capped = false;
        w->region_len    = 0;
        w->region_start  = 0;
    }

    for (size_t e = 0; e < w->events_len; e++) {
        if (w->event_region_off[e] == WATCHER_NO_REGION) continue;
        w->events[e].ids = w->events[e].ids_len
            ? w->region_buf + w->event_region_off[e]
            : NULL;
    }

    if (out_events) *out_events = w->events;
    if (out_len)    *out_len    = w->events_len;
    return CODEC_OK;
}
