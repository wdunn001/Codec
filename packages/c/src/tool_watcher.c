/* Tool-call / region watcher.
 *
 * Scans a token-ID stream for a (start_id, end_id) pair without going
 * through the detokenizer. Emits passthrough runs (everything outside any
 * watched region) and complete regions (everything between start and end,
 * markers excluded) as a flat array of events per feed() call.
 *
 * Memory model:
 *   - PASSTHROUGH events point directly into the caller's input buffer;
 *     valid only until the next feed() call.
 *   - REGION_END events point into the watcher's own buffer; valid until
 *     the next feed() call (or watcher_free).
 *   - The events array is owned by the watcher and reused across calls;
 *     the caller MUST NOT free it.
 *
 * Edge cases handled:
 *   - Region split across multiple feeds: state survives between calls,
 *     buffer continues accumulating until end token arrives.
 *   - Stray end_id outside a region: ignored (passes through as-is).
 *   - Nested start_id inside an active region: ignored. Most chat models
 *     don't nest these markers, and treating an inner start as a new
 *     region would silently drop the outer content.
 */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stdlib.h>
#include <string.h>

struct codec_tool_watcher {
    uint32_t start_id;
    uint32_t end_id;
    bool     inside;

    /* Captured-region arena. Every region completed during the current
     * feed() keeps its own span here, because the REGION_END events handed
     * back to the caller point into it and must all stay valid until the
     * next feed(). Resetting per region (the original design) made the
     * second region alias and then realloc out from under the first.
     * `region_start` is where the region currently being captured begins. */
    uint32_t *region_buf;
    size_t    region_len;
    size_t    region_cap;
    size_t    region_start;

    /* Events array reused across feed() calls. */
    codec_watcher_event_t *events;
    size_t                 events_len;
    size_t                 events_cap;
    /* Parallel to `events`. For a REGION_END event this holds the region's
     * offset into region_buf; every other event kind holds NO_REGION. The
     * arena can move under realloc mid-feed, so the pointers are resolved
     * once at the end of feed() rather than at emit time. */
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
    /* Skip degenerate empty events — they add noise without information. */
    if (len == 0) return 1;
    if (!events_reserve(w, w->events_len + 1)) return 0;
    w->events[w->events_len].kind    = kind;
    w->events[w->events_len].ids     = ids;
    w->events[w->events_len].ids_len = len;
    w->event_region_off[w->events_len] = WATCHER_NO_REGION;
    w->events_len++;
    return 1;
}

/* Emit a REGION_END for the arena span [off, off + len). The `ids` pointer
 * is filled in after the feed loop, once the arena has stopped moving. */
static int emit_region(codec_tool_watcher_t *w, size_t off, size_t len) {
    if (len == 0) return 1;
    if (!events_reserve(w, w->events_len + 1)) return 0;
    w->events[w->events_len].kind    = CODEC_WATCH_REGION_END;
    w->events[w->events_len].ids     = NULL;
    w->events[w->events_len].ids_len = len;
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
    w->start_id = start_id;
    w->end_id   = end_id;
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
    w->inside     = false;
    w->region_len = 0;
    w->region_start = 0;
    w->events_len = 0;
}

bool codec_tool_watcher_inside(const codec_tool_watcher_t *w) {
    return w && w->inside;
}

codec_status_t codec_tool_watcher_feed(codec_tool_watcher_t *w,
                                       const uint32_t *ids, size_t n,
                                       codec_watcher_event_t **out_events,
                                       size_t *out_len) {
    if (!w) return CODEC_ERR_INVALID_ARG;
    /* Reset events from previous call — pointers issued earlier are now
     * stale (the input buffer has rolled over and the region buffer may
     * have been overwritten). */
    w->events_len = 0;

    /* Recycle the arena. Spans captured for the previous call's events are
     * dead now, but a region still in progress has to survive — it may span
     * any number of feeds. Slide it down to offset 0 and drop the rest. */
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
                 * consumed — orchestrators don't want to forward the
                 * "begin tool call" token to the next agent. */
                if (i > pt_start) {
                    if (!emit(w, CODEC_WATCH_PASSTHROUGH,
                              &ids[pt_start], i - pt_start)) {
                        return CODEC_ERR_OUT_OF_MEMORY;
                    }
                }
                w->inside       = true;
                w->region_start = w->region_len;
                /* pt_start gets re-anchored when we exit the region. */
            }
            /* else: token continues the passthrough run; no action. */
        } else {
            if (id == w->end_id) {
                /* Region complete. Record the arena span rather than a
                 * pointer — a later region in this same feed can realloc
                 * the arena, which would dangle any pointer taken now. */
                if (!emit_region(w, w->region_start,
                                 w->region_len - w->region_start)) {
                    return CODEC_ERR_OUT_OF_MEMORY;
                }
                w->inside   = false;
                pt_start    = i + 1;  /* passthrough resumes after end marker */
            } else if (id == w->start_id) {
                /* Nested start; ignore — see file comment. */
            } else {
                if (!region_buf_reserve(w, w->region_len + 1)) {
                    return CODEC_ERR_OUT_OF_MEMORY;
                }
                w->region_buf[w->region_len++] = id;
            }
        }
    }

    /* Trailing passthrough run, if any. Only emitted when we end OUTSIDE
     * a region — if we end mid-region, the data stays buffered. */
    if (!w->inside && pt_start < n) {
        if (!emit(w, CODEC_WATCH_PASSTHROUGH,
                  &ids[pt_start], n - pt_start)) {
            return CODEC_ERR_OUT_OF_MEMORY;
        }
    }

    /* The arena is final now. Turn the recorded spans into pointers. */
    for (size_t e = 0; e < w->events_len; e++) {
        if (w->event_region_off[e] == WATCHER_NO_REGION) continue;
        w->events[e].ids = w->region_buf + w->event_region_off[e];
    }

    if (out_events) *out_events = w->events;
    if (out_len)    *out_len    = w->events_len;
    return CODEC_OK;
}
