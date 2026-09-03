/* SPDX-License-Identifier: MIT
 *
 * Fixture-driven ToolWatcher conformance test.
 *
 * packages/tool-watcher-conformance/fixtures/tool-watcher-events.json is
 * the cross-language source of truth for the ToolWatcher event contract:
 * every Codec ToolWatcher implementation (C, TypeScript, Python, Rust,
 * Java, .NET) must reproduce it exactly. This file loads it and replays
 * every case generically, the same way the other five languages' loaders
 * do: packages/web/test/tool-watcher.test.ts,
 * packages/python/tests/test_tool_watcher.py,
 * packages/rust/tests/tool_watcher_fixture_tests.rs,
 * packages/java/src/test/java/ai/codec/ToolWatcherFixtureTests.java,
 * packages/dotnet/test/Codec.Net.Tests/ToolWatcherFixtureTests.cs.
 *
 * Before this file existed, C's coverage of the fixture was a hand
 * mirror in test_tool_watcher.c: every case copied over by hand, by
 * name, by input shape, by expected events. The fixture grew three
 * cases (the "empty region" family) after a real defect: emit_region()
 * silently dropped a start marker immediately followed by an end
 * marker. A model that emitted an empty tool call therefore produced no
 * event at all in C. The other five languages all emitted REGION_END
 * with an empty body for that same input. The hand mirror did not pick
 * that up on its own; someone had to notice the fixture grew and go add
 * the case by hand. A loader that iterates whatever `cases` the fixture
 * contains can't have that gap: a new case is exercised the moment it
 * lands here, with no second commit required. See test_tool_watcher.c
 * for the C-specific concerns this file is additive to (arena
 * reallocation across regions, pointer-ownership / zero-copy
 * passthrough, the map-based constructor, the "never decodes tokens"
 * contract): none of those are expressible generically from the
 * fixture. That file stays.
 *
 * JSON: libcodec is C99 and dependency-free by design (see the
 * top-level README). Two ways to read the fixture were on the table:
 * (a) parse it at test time with the jsmn parser libcodec already
 * vendors, or (b) generate a C source file from it with a script and
 * have CI diff the generated file against a fresh regeneration to prove
 * it's current. (a) was chosen: a generated file nobody regenerates is
 * just a mirror with an extra step between the fixture and the drift.
 * jsmn is already a dependency of this test binary transitively (map.c
 * compiles it into libcodec; codec_safety_policy.c and
 * codec_version_signaling.c already reach its declarations the same
 * way this file does, via `#define JSMN_HEADER` before including
 * src/jsmn.h). No new dependency comes with this. Every new fixture
 * case is picked up automatically, the same way the other five
 * languages pick it up.
 */
#include "codec/codec.h"
#include "codec_test.h"

#define JSMN_HEADER
#include "jsmn.h"
#include "codec_jsmn_guard.h"

#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Fixture location ──────────────────────────────────────────────────── */
/*
 * test/CMakeLists.txt sets CODEC_FIXTURE_PATH unconditionally to the
 * absolute path of tool-watcher-events.json. The relative candidates
 * below are a fallback for running this binary directly (not via
 * ctest) from somewhere other than its build directory; mirrors
 * ToolWatcherFixtureTests.java's findFixtureFile().
 */
static const char *g_fixture_path_candidates[] = {
    "../tool-watcher-conformance/fixtures/tool-watcher-events.json",
    "../../tool-watcher-conformance/fixtures/tool-watcher-events.json",
    "packages/tool-watcher-conformance/fixtures/tool-watcher-events.json",
    "tool-watcher-conformance/fixtures/tool-watcher-events.json",
};

static char *read_whole_file(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long sz = ftell(f);
    if (sz < 0) { fclose(f); return NULL; }
    if (fseek(f, 0, SEEK_SET) != 0) { fclose(f); return NULL; }
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = (sz > 0) ? fread(buf, 1, (size_t)sz, f) : 0;
    fclose(f);
    if (got != (size_t)sz) { free(buf); return NULL; }
    buf[sz] = 0;
    *out_len = (size_t)sz;
    return buf;
}

static char *load_fixture_text(size_t *out_len, const char **out_path) {
    const char *env = getenv("CODEC_FIXTURE_PATH");
    if (env && *env) {
        char *txt = read_whole_file(env, out_len);
        if (txt) { *out_path = env; return txt; }
    }
    size_t n = sizeof(g_fixture_path_candidates) / sizeof(g_fixture_path_candidates[0]);
    for (size_t i = 0; i < n; i++) {
        char *txt = read_whole_file(g_fixture_path_candidates[i], out_len);
        if (txt) { *out_path = g_fixture_path_candidates[i]; return txt; }
    }
    return NULL;
}

/* ── Small jsmn walking helpers (same shapes map.c uses internally) ─────── */

/* Compare a jsmn string/primitive token to a literal (no escapes in the
 * literal; that's fine, every literal we compare against here is a bare
 * ASCII identifier). */
static int tok_eq(const char *json, const jsmntok_t *t, const char *lit) {
    if (t->type != JSMN_STRING && t->type != JSMN_PRIMITIVE) return 0;
    size_t lit_len = strlen(lit);
    size_t tok_len = (size_t)(t->end - t->start);
    if (tok_len != lit_len) return 0;
    return memcmp(json + t->start, lit, lit_len) == 0;
}

static int tok_is_null(const char *json, const jsmntok_t *t) {
    return tok_eq(json, t, "null");
}

/* Skip past the token subtree rooted at `idx`; returns the index right
 * after it. */
static size_t skip_subtree(const jsmntok_t *toks, size_t idx) {
    size_t remaining = 1;
    size_t i = idx;
    while (remaining > 0) {
        const jsmntok_t *t = &toks[i++];
        remaining--;
        if (t->type == JSMN_OBJECT) remaining += (size_t)t->size * 2;
        else if (t->type == JSMN_ARRAY) remaining += (size_t)t->size;
    }
    return i;
}

/* Find `key`'s value token index inside the object rooted at `obj_idx`.
 * Order-independent: walks all declared pairs. It does not depend on
 * the fixture writing keys in any particular order. */
static int obj_find(const char *json, const jsmntok_t *toks, size_t obj_idx,
                     const char *key, size_t *out_val_idx) {
    const jsmntok_t *obj = &toks[obj_idx];
    size_t pos = obj_idx + 1;
    for (int i = 0; i < obj->size; i++) {
        const jsmntok_t *k = &toks[pos];
        size_t val_idx = pos + 1;
        if (tok_eq(json, k, key)) { *out_val_idx = val_idx; return 1; }
        pos = skip_subtree(toks, val_idx);
    }
    return 0;
}

/* Decimal, non-negative, fits in uint32_t. Every numeric field in this
 * fixture (start_id, end_id, region_cap, token ids) is one. */
static int parse_u32(const char *json, const jsmntok_t *t, uint32_t *out) {
    if (t->type != JSMN_PRIMITIVE) return 0;
    size_t len = (size_t)(t->end - t->start);
    const char *s = json + t->start;
    if (len == 0) return 0;
    unsigned long v = 0;
    for (size_t i = 0; i < len; i++) {
        char c = s[i];
        if (c < '0' || c > '9') return 0;
        if (v > (ULONG_MAX - (unsigned long)(c - '0')) / 10) return 0;
        v = v * 10 + (unsigned long)(c - '0');
    }
    if (v > 0xFFFFFFFFul) return 0;
    *out = (uint32_t)v;
    return 1;
}

/* Raw-copy a JSMN_STRING token's text. Every string value in this fixture
 * (case names, event kinds, finish reasons) is a bare identifier: no
 * escape sequences. If that assumption is ever violated, this fails
 * loudly by returning NULL. It does not silently mis-decode. */
static char *tok_dup_str(const char *json, const jsmntok_t *t) {
    if (t->type != JSMN_STRING) return NULL;
    size_t len = (size_t)(t->end - t->start);
    for (size_t i = 0; i < len; i++) {
        if (json[t->start + i] == '\\') return NULL;
    }
    char *out = (char *)malloc(len + 1);
    if (!out) return NULL;
    if (len > 0) memcpy(out, json + t->start, len);
    out[len] = 0;
    return out;
}

static char *strdup_local(const char *s) {
    size_t len = strlen(s);
    char *out = (char *)malloc(len + 1);
    if (out) memcpy(out, s, len + 1);
    return out;
}

/* ── Normalized event: three fields. A kind name. An ids array. A
 * finish reason, present only for "truncated". codec.h documents a
 * memory model where those pointers alias storage that is only valid
 * until the *next* feed()/end() call. Two kinds point into the caller's
 * input buffer: PASSTHROUGH, NESTED_START. Three other kinds point into
 * the watcher's own arena instead: REGION_END, REGION_TRUNCATED,
 * REGION_OVERFLOW. This test accumulates every feed's events before
 * comparing at the end of the case. Each event therefore gets
 * deep-copied immediately after its feed()/end() call, before the next
 * call can invalidate it. Holding onto either kind of pointer past the
 * next call would read freed or overwritten memory. That is exactly the
 * kind of bug ASan/UBSan exist to catch. It could also masquerade as a
 * plain fixture mismatch: a silent read of garbage. ── */
typedef struct {
    char     *kind;          /* owned */
    uint32_t *ids;            /* owned, NULL iff ids_len == 0 */
    size_t    ids_len;
    char     *finish_reason;  /* owned, or NULL */
} norm_event_t;

typedef struct {
    norm_event_t *items;
    size_t        len;
    size_t        cap;
} norm_event_list_t;

static void nel_push(norm_event_list_t *l, const char *kind,
                      const uint32_t *ids, size_t ids_len,
                      const char *finish_reason) {
    if (l->len == l->cap) {
        size_t ncap = l->cap ? l->cap * 2 : 4;
        norm_event_t *ni = (norm_event_t *)realloc(l->items, ncap * sizeof(*ni));
        if (!ni) { CT_FAIL("out of memory growing event list"); return; }
        l->items = ni;
        l->cap = ncap;
    }
    norm_event_t *e = &l->items[l->len++];
    e->kind = strdup_local(kind);
    e->ids_len = ids_len;
    e->ids = NULL;
    if (ids_len > 0) {
        e->ids = (uint32_t *)malloc(ids_len * sizeof(uint32_t));
        if (!e->ids) { CT_FAIL("out of memory copying ids"); return; }
        memcpy(e->ids, ids, ids_len * sizeof(uint32_t));
    }
    e->finish_reason = finish_reason ? strdup_local(finish_reason) : NULL;
}

static void nel_free(norm_event_list_t *l) {
    for (size_t i = 0; i < l->len; i++) {
        free(l->items[i].kind);
        free(l->items[i].ids);
        free(l->items[i].finish_reason);
    }
    free(l->items);
    l->items = NULL;
    l->len = 0;
    l->cap = 0;
}

/* Maps every codec_watcher_event_kind_t to the fixture's string form. No
 * default arm: -Wswitch flags a new enumerator left unhandled here at
 * compile time. The CT_FAIL below is the runtime backstop. Either way,
 * a kind this function can't name can't accidentally compare equal to
 * a fixture string it was never meant to match. An unrecognized actual
 * kind fails the case. It does not silently pass. */
static const char *kind_str(codec_watcher_event_kind_t k) {
    switch (k) {
        case CODEC_WATCH_PASSTHROUGH:      return "passthrough";
        case CODEC_WATCH_REGION_END:       return "region";
        case CODEC_WATCH_REGION_TRUNCATED: return "truncated";
        case CODEC_WATCH_REGION_OVERFLOW:  return "overflow";
        case CODEC_WATCH_NESTED_START:     return "nested_start";
    }
    CT_FAIL("unhandled codec_watcher_event_kind_t value: %d", (int)k);
    return "??unhandled-kind??";
}

static void collect_events(norm_event_list_t *l, const codec_watcher_event_t *evs, size_t n) {
    for (size_t i = 0; i < n; i++) {
        const char *finish_reason = NULL;
        if (evs[i].kind == CODEC_WATCH_REGION_TRUNCATED) finish_reason = evs[i].finish_reason;
        nel_push(l, kind_str(evs[i].kind), evs[i].ids, evs[i].ids_len, finish_reason);
    }
}

/* ── Comparison ─────────────────────────────────────────────────────────── */

static void compare_case(const char *case_name, const norm_event_list_t *actual,
                          const norm_event_list_t *expected) {
    if (actual->len != expected->len) {
        CT_FAIL("case \"%s\": event count mismatch: actual=%zu expected=%zu",
                case_name, actual->len, expected->len);
    }
    size_t n = actual->len < expected->len ? actual->len : expected->len;
    for (size_t i = 0; i < n; i++) {
        const norm_event_t *a = &actual->items[i];
        const norm_event_t *e = &expected->items[i];
        if (strcmp(a->kind, e->kind) != 0) {
            CT_FAIL("case \"%s\" event %zu: kind mismatch: actual=%s expected=%s",
                    case_name, i, a->kind, e->kind);
            continue;
        }
        if (a->ids_len != e->ids_len) {
            CT_FAIL("case \"%s\" event %zu (%s): ids length mismatch: actual=%zu expected=%zu",
                    case_name, i, a->kind, a->ids_len, e->ids_len);
        } else {
            for (size_t k = 0; k < a->ids_len; k++) {
                if (a->ids[k] != e->ids[k]) {
                    CT_FAIL("case \"%s\" event %zu (%s): id[%zu] mismatch: actual=%u expected=%u",
                            case_name, i, a->kind, k, a->ids[k], e->ids[k]);
                }
            }
        }
        int a_has_fr = a->finish_reason != NULL;
        int e_has_fr = e->finish_reason != NULL;
        if (a_has_fr != e_has_fr || (a_has_fr && strcmp(a->finish_reason, e->finish_reason) != 0)) {
            CT_FAIL("case \"%s\" event %zu (%s): finish_reason mismatch: actual=%s expected=%s",
                    case_name, i, a->kind,
                    a->finish_reason ? a->finish_reason : "(null)",
                    e->finish_reason ? e->finish_reason : "(null)");
        }
    }
}

/* ── Running one fixture case ──────────────────────────────────────────── */

static void run_case(const char *json, const jsmntok_t *toks, size_t case_idx,
                      uint32_t start_id, uint32_t end_id,
                      char *name_out, size_t name_out_sz) {
    size_t name_idx, cap_idx, feeds_idx, end_idx, events_idx;
    int has_cap = obj_find(json, toks, case_idx, "region_cap", &cap_idx);
    int has_end = obj_find(json, toks, case_idx, "end", &end_idx);

    if (!obj_find(json, toks, case_idx, "name", &name_idx)) {
        CT_FAIL("case at token %zu: missing \"name\"", case_idx);
        snprintf(name_out, name_out_sz, "??missing-name??");
        return;
    }
    char *name = tok_dup_str(json, &toks[name_idx]);
    if (!name) {
        CT_FAIL("case at token %zu: \"name\" is not a plain string", case_idx);
        snprintf(name_out, name_out_sz, "??bad-name??");
        return;
    }
    snprintf(name_out, name_out_sz, "%s", name);

    if (!obj_find(json, toks, case_idx, "feeds", &feeds_idx)) {
        CT_FAIL("case \"%s\": missing \"feeds\"", name);
        free(name);
        return;
    }
    if (!obj_find(json, toks, case_idx, "events", &events_idx)) {
        CT_FAIL("case \"%s\": missing \"events\"", name);
        free(name);
        return;
    }

    codec_tool_watcher_t *w = NULL;
    if (codec_tool_watcher_new_with_ids(start_id, end_id, &w) != CODEC_OK) {
        CT_FAIL("case \"%s\": codec_tool_watcher_new_with_ids failed", name);
        free(name);
        return;
    }

    if (has_cap && !tok_is_null(json, &toks[cap_idx])) {
        uint32_t cap;
        if (!parse_u32(json, &toks[cap_idx], &cap)) {
            CT_FAIL("case \"%s\": bad region_cap", name);
        } else {
            codec_tool_watcher_set_region_cap(w, (size_t)cap);
        }
    }

    norm_event_list_t actual;
    memset(&actual, 0, sizeof(actual));

    /* feeds: array of arrays of token ids. One codec_tool_watcher_feed()
     * call per inner array, in order; every returned event is deep-copied
     * into `actual` before the next feed() call reuses/invalidates the
     * storage those events point into. */
    const jsmntok_t *feeds_tok = &toks[feeds_idx];
    size_t pos = feeds_idx + 1;
    for (int fi = 0; fi < feeds_tok->size; fi++) {
        const jsmntok_t *arr = &toks[pos];
        size_t n_ids = (size_t)arr->size;
        uint32_t *ids = NULL;
        if (n_ids > 0) {
            ids = (uint32_t *)malloc(n_ids * sizeof(uint32_t));
            size_t ip = pos + 1;
            for (size_t k = 0; k < n_ids; k++) {
                uint32_t v = 0;
                if (!parse_u32(json, &toks[ip], &v)) {
                    CT_FAIL("case \"%s\": bad token id in feeds[%d][%zu]", name, fi, k);
                }
                ids[k] = v;
                ip = skip_subtree(toks, ip);
            }
        }

        codec_watcher_event_t *evs = NULL;
        size_t n_evs = 0;
        if (codec_tool_watcher_feed(w, ids, n_ids, &evs, &n_evs) != CODEC_OK) {
            CT_FAIL("case \"%s\": feed() call %d returned an error", name, fi);
        } else {
            collect_events(&actual, evs, n_evs);
        }
        free(ids);
        pos = skip_subtree(toks, pos);
    }

    /* end: null means "don't call end()"; an object means call it once
     * with its (possibly absent/null) finish_reason. */
    if (has_end && !tok_is_null(json, &toks[end_idx])) {
        char *finish_reason = NULL;
        size_t fr_idx;
        if (obj_find(json, toks, end_idx, "finish_reason", &fr_idx)
            && !tok_is_null(json, &toks[fr_idx])) {
            finish_reason = tok_dup_str(json, &toks[fr_idx]);
            if (!finish_reason) CT_FAIL("case \"%s\": bad end.finish_reason", name);
        }

        codec_watcher_event_t *evs = NULL;
        size_t n_evs = 0;
        if (codec_tool_watcher_end(w, finish_reason, &evs, &n_evs) != CODEC_OK) {
            CT_FAIL("case \"%s\": end() returned an error", name);
        } else {
            collect_events(&actual, evs, n_evs);
        }
        free(finish_reason);
    }

    codec_tool_watcher_free(w);

    /* Expected events, parsed straight from the fixture. */
    norm_event_list_t expected;
    memset(&expected, 0, sizeof(expected));

    const jsmntok_t *events_tok = &toks[events_idx];
    pos = events_idx + 1;
    for (int ei = 0; ei < events_tok->size; ei++) {
        size_t ev_idx = pos;
        char *kind = NULL;
        uint32_t *ids = NULL;
        size_t n_ids = 0;
        char *finish_reason = NULL;

        size_t kind_idx;
        if (!obj_find(json, toks, ev_idx, "kind", &kind_idx)) {
            CT_FAIL("case \"%s\": events[%d] missing \"kind\"", name, ei);
        } else {
            kind = tok_dup_str(json, &toks[kind_idx]);
            if (!kind) CT_FAIL("case \"%s\": events[%d].kind is not a plain string", name, ei);
        }

        size_t ids_idx;
        if (!obj_find(json, toks, ev_idx, "ids", &ids_idx)) {
            CT_FAIL("case \"%s\": events[%d] missing \"ids\"", name, ei);
        } else {
            const jsmntok_t *ids_arr = &toks[ids_idx];
            n_ids = (size_t)ids_arr->size;
            if (n_ids > 0) {
                ids = (uint32_t *)malloc(n_ids * sizeof(uint32_t));
                size_t ip = ids_idx + 1;
                for (size_t k = 0; k < n_ids; k++) {
                    uint32_t v = 0;
                    if (!parse_u32(json, &toks[ip], &v)) {
                        CT_FAIL("case \"%s\": bad token id in events[%d].ids[%zu]", name, ei, k);
                    }
                    ids[k] = v;
                    ip = skip_subtree(toks, ip);
                }
            }
        }

        /* Per the fixture schema, finish_reason only ever appears (and
         * only ever matters) on a "truncated" event; ignore it otherwise,
         * matching every other language's loader. */
        if (kind && strcmp(kind, "truncated") == 0) {
            size_t fr_idx;
            if (obj_find(json, toks, ev_idx, "finish_reason", &fr_idx)
                && !tok_is_null(json, &toks[fr_idx])) {
                finish_reason = tok_dup_str(json, &toks[fr_idx]);
            }
        }

        nel_push(&expected, kind ? kind : "??missing-kind??", ids, n_ids, finish_reason);
        free(kind);
        free(ids);
        free(finish_reason);

        pos = skip_subtree(toks, pos);
    }

    compare_case(name, &actual, &expected);

    nel_free(&actual);
    nel_free(&expected);
    free(name);
}

/* ── main ───────────────────────────────────────────────────────────────── */

int main(void) {
    size_t json_len = 0;
    const char *used_path = NULL;
    char *json = load_fixture_text(&json_len, &used_path);
    if (!json) {
        CT_FAIL("could not locate tool-watcher-events.json "
                "(checked CODEC_FIXTURE_PATH and relative fallbacks); "
                "set CODEC_FIXTURE_PATH to override");
        CT_DONE();
    }
    fprintf(stdout, "fixture: %s\n", used_path);

    /* Two-pass jsmn parse: count tokens, then allocate and parse for
     * real. Same pattern map.c uses for codec_map_from_json. */
    jsmn_parser p;
    jsmn_init(&p);
    int ntok = jsmn_parse(&p, json, json_len, NULL, 0);
    if (ntok < 0) {
        CT_FAIL("jsmn_parse (count pass) failed: %d", ntok);
        free(json);
        CT_DONE();
    }
    jsmntok_t *toks = (jsmntok_t *)malloc(sizeof(jsmntok_t) * (size_t)(ntok > 0 ? ntok : 1));
    if (!toks) {
        CT_FAIL("out of memory allocating %d jsmn tokens", ntok);
        free(json);
        CT_DONE();
    }
    jsmn_init(&p);
    ntok = jsmn_parse(&p, json, json_len, toks, (unsigned int)ntok);
    if (ntok < 0) {
        CT_FAIL("jsmn_parse (fill pass) failed: %d", ntok);
        free(toks);
        free(json);
        CT_DONE();
    }
    if (!codec_jsmn_tree_complete(toks, (size_t)ntok)) {
        CT_FAIL("fixture JSON failed the jsmn structural-completeness check");
        free(toks);
        free(json);
        CT_DONE();
    }
    if (ntok == 0 || toks[0].type != JSMN_OBJECT) {
        CT_FAIL("fixture root is not a JSON object");
        free(toks);
        free(json);
        CT_DONE();
    }

    size_t start_idx, end_idx, cases_idx;
    if (!obj_find(json, toks, 0, "start_id", &start_idx)
        || !obj_find(json, toks, 0, "end_id", &end_idx)
        || !obj_find(json, toks, 0, "cases", &cases_idx)) {
        CT_FAIL("fixture is missing start_id / end_id / cases at the top level");
        free(toks);
        free(json);
        CT_DONE();
    }

    uint32_t start_id = 0, end_id = 0;
    if (!parse_u32(json, &toks[start_idx], &start_id)) CT_FAIL("fixture start_id is not a plain integer");
    if (!parse_u32(json, &toks[end_idx], &end_id)) CT_FAIL("fixture end_id is not a plain integer");

    const jsmntok_t *cases_tok = &toks[cases_idx];
    if (cases_tok->type != JSMN_ARRAY) {
        CT_FAIL("fixture \"cases\" is not an array");
        free(toks);
        free(json);
        CT_DONE();
    }

    int n_cases = cases_tok->size;
    fprintf(stdout, "fixture cases: %d (start_id=%u end_id=%u)\n", n_cases, start_id, end_id);
    /* A loader that silently accepts zero cases would "pass" vacuously
     * and defeat the whole point of this file. */
    CT_TRUE(n_cases > 0);

    size_t pos = cases_idx + 1;
    for (int ci = 0; ci < n_cases; ci++) {
        char name_buf[160];
        int before = _codec_test_failures;
        run_case(json, toks, pos, start_id, end_id, name_buf, sizeof(name_buf));
        int delta = _codec_test_failures - before;
        fprintf(stdout, "%s fixture_case: %s\n", delta == 0 ? "PASS" : "FAIL", name_buf);
        pos = skip_subtree(toks, pos);
    }

    free(toks);
    free(json);
    CT_DONE();
}
