/* SPDX-License-Identifier: MIT
 *
 * BPE encoder: text → token IDs.
 *
 * Mirrors the algorithm used by @codecai/web's BPETokenizer, codecai's
 * BPETokenizer, and Codec.Net's BPETokenizer. All four implementations
 * are bit-identical to HuggingFace's reference Rust tokenizer for
 * Qwen-2 across the test fixtures.
 *
 * Algorithm:
 *   0. Special-token pre-scan: split the input on any literal special
 *      token (declared in `special_tokens`, or a `vocab` key shaped
 *      like a `<|...|>` delimiter) before pre-tokenization runs. Each
 *      match is emitted as its atomic vocab ID; the spans between
 *      matches go through steps 1-4 below. Mirrors HuggingFace's
 *      `AddedVocabulary` splitter, which runs before the normalizer and
 *      the pre-tokenizer. Required for chat templates
 *      (`<|im_start|>...<|im_end|>`) and similar delimiters to round-trip:
 *      without it they'd byte-encode as ordinary text instead of
 *      resolving to their one reserved ID.
 *
 * Algorithm (byte_level, steps 1-4 run per span from step 0):
 *   1. Run the pre-tokenizer program to split the span into pieces.
 *   2. For each piece, byte-level encode (UTF-8 bytes → GPT-2
 *      codepoints → UTF-8). Each codepoint of the encoded piece is
 *      one initial BPE token.
 *   3. Apply BPE merges: greedily merge the lowest-rank (highest
 *      priority) adjacent pair, repeatedly, until no merge applies.
 *   4. Look up each final token in the vocab to get the ID.
 *
 * Algorithm (metaspace): step 1 is metaspace_split, step 2 is identity
 * (already in vocab space). Steps 3-4 same as byte_level.
 *
 * Memory model: codec_bpe_encoder_t holds a precomputed view over the
 * map, including the special-token trie built once at construction
 * (see build_special_trie below). The encode function returns a fresh
 * array of IDs the caller frees with free().
 */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ── Special-token pre-scan ────────────────────────────────────────────── */
/*
 * HuggingFace's `AddedVocabulary` splitter runs before the normalizer and
 * before the pre-tokenizer: any special token (`<|im_start|>`, `<think>`,
 * FIM markers, tool-call delimiters, ...) that appears literally in the
 * input text is sliced out and emitted as its atomic vocab ID, never fed
 * through BPE. `packages/web/src/bpe.ts` implements this as a single
 * regex built from two sources: the map's declared `special_tokens`, plus
 * any `vocab` key shaped like a delimiter (`<|body|>`), for maps whose
 * chat-template revision shipped before `special_tokens` caught up. This
 * scanner mirrors both sources and their priority: a declared special
 * token wins over a same-named vocab entry.
 *
 * Matching needs to answer one question at every input position: "does
 * any special token start exactly here, and if several do, which is
 * longest?" A byte trie answers that directly. We don't need full
 * Aho-Corasick failure links: those exist to find matches anywhere a
 * pattern is a suffix of the scanned prefix (arbitrary-position substring
 * search). Here we only ever probe an anchored start, so a plain trie
 * descent from the root at each candidate position is enough, and it
 * naturally handles two special tokens overlapping or one being a prefix
 * of another: the walk simply keeps the deepest `is_end` node it passed
 * through, which is exactly the longest match starting there.
 *
 * Cost per position is bounded by the trie's maximum depth (the longest
 * special token's byte length, a small constant independent of input
 * size), and at most maps the first byte only reaches a trie edge for a
 * handful of lead bytes (almost always just `<`), so the common case is
 * one failed lookup per position. `codec-supervisor`'s Python
 * Aho-Corasick matcher (`safety_aho_corasick.py`) is the prior art in
 * this codebase for multi-token matching at this shape; this is its
 * anchored-match cousin, kept dependency-free in C99. This is also
 * exactly the class of bug `match_letters_cased`'s O(n^2) allocation
 * fix warns against: sizing anything to "the rest of the input" at every
 * cursor position. The trie walk below never does that; it always stops
 * within a few dozen bytes.
 */

typedef struct special_trie_edge {
    unsigned char byte;
    uint32_t      child;
} special_trie_edge_t;

typedef struct special_trie_node {
    special_trie_edge_t *edges;
    uint32_t              edge_count;
    uint32_t              edge_cap;
    int                    is_end;  /* 1 if a special token ends exactly here */
    uint32_t               id;      /* valid iff is_end */
} special_trie_node_t;

typedef struct codec_special_trie {
    special_trie_node_t *nodes;
    size_t                node_count;
    size_t                node_cap;
} codec_special_trie_t;

static codec_status_t trie_new(codec_special_trie_t **out) {
    codec_special_trie_t *t = (codec_special_trie_t *)calloc(1, sizeof(*t));
    if (!t) return CODEC_ERR_OUT_OF_MEMORY;
    /* Node 0 is the root; it starts with no edges. */
    t->nodes = (special_trie_node_t *)calloc(1, sizeof(*t->nodes));
    if (!t->nodes) { free(t); return CODEC_ERR_OUT_OF_MEMORY; }
    t->node_count = 1;
    t->node_cap   = 1;
    *out = t;
    return CODEC_OK;
}

static void trie_free(codec_special_trie_t *t) {
    if (!t) return;
    for (size_t i = 0; i < t->node_count; i++) free(t->nodes[i].edges);
    free(t->nodes);
    free(t);
}

/* Append a fresh node, growing the node array as needed. Returns its
 * index via `out_idx`. Node indices stay valid across growth; raw
 * pointers into `t->nodes` do not, so callers must re-index after any
 * call that might append a node. */
static codec_status_t trie_new_node(codec_special_trie_t *t, uint32_t *out_idx) {
    if (t->node_count == t->node_cap) {
        size_t new_cap = t->node_cap ? t->node_cap * 2 : 16;
        special_trie_node_t *grow = (special_trie_node_t *)realloc(
            t->nodes, new_cap * sizeof(*t->nodes));
        if (!grow) return CODEC_ERR_OUT_OF_MEMORY;
        memset(grow + t->node_cap, 0, (new_cap - t->node_cap) * sizeof(*grow));
        t->nodes    = grow;
        t->node_cap = new_cap;
    }
    *out_idx = (uint32_t)t->node_count;
    t->node_count++;
    return CODEC_OK;
}

/* Linear scan: branching factor per node is small in practice (the
 * alphabet of bytes that ever start or continue a special token is
 * tiny), so this stays effectively O(1) without the bookkeeping of a
 * sorted/binary-searched edge list. */
static int trie_find_child(const special_trie_node_t *node, unsigned char b) {
    for (uint32_t i = 0; i < node->edge_count; i++) {
        if (node->edges[i].byte == b) return (int)node->edges[i].child;
    }
    return -1;
}

static codec_status_t trie_add_edge(codec_special_trie_t *t, uint32_t node_idx,
                                    unsigned char b, uint32_t child_idx) {
    special_trie_node_t *node = &t->nodes[node_idx];
    if (node->edge_count == node->edge_cap) {
        uint32_t new_cap = node->edge_cap ? node->edge_cap * 2 : 4;
        special_trie_edge_t *grow = (special_trie_edge_t *)realloc(
            node->edges, new_cap * sizeof(*node->edges));
        if (!grow) return CODEC_ERR_OUT_OF_MEMORY;
        node->edges     = grow;
        node->edge_cap  = new_cap;
    }
    node->edges[node->edge_count].byte  = b;
    node->edges[node->edge_count].child = child_idx;
    node->edge_count++;
    return CODEC_OK;
}

static codec_status_t trie_insert(codec_special_trie_t *t,
                                  const char *s, size_t len, uint32_t id) {
    uint32_t cur = 0; /* root */
    for (size_t i = 0; i < len; i++) {
        unsigned char b = (unsigned char)s[i];
        int existing = trie_find_child(&t->nodes[cur], b);
        if (existing >= 0) {
            cur = (uint32_t)existing;
            continue;
        }
        uint32_t new_idx;
        codec_status_t st = trie_new_node(t, &new_idx);
        if (st != CODEC_OK) return st;
        st = trie_add_edge(t, cur, b, new_idx);
        if (st != CODEC_OK) return st;
        cur = new_idx;
    }
    /* First insertion of a given string wins: mirrors bpe.ts giving
     * declared `special_tokens` priority over a same-named vocab entry
     * by inserting specials first and skipping vocab duplicates. */
    if (!t->nodes[cur].is_end) {
        t->nodes[cur].is_end = 1;
        t->nodes[cur].id     = id;
    }
    return CODEC_OK;
}

/* Match `<|body|>` where `body` is non-empty and identifier-like
 * (letters/digits/`_`/`-`). Mirrors `isDelimiterShape` in
 * packages/web/src/bpe.ts exactly, including the length-4 floor that
 * excludes pathological vocab entries like Falcon's `<|>` that share
 * the start/end pair but have no body. */
static int is_delimiter_shape(const char *s, size_t len) {
    if (len <= 4) return 0;
    if (s[0] != '<' || s[1] != '|') return 0;
    if (s[len - 2] != '|' || s[len - 1] != '>') return 0;
    for (size_t i = 2; i + 2 < len; i++) {
        unsigned char c = (unsigned char)s[i];
        int ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                 (c >= '0' && c <= '9') || c == '_' || c == '-';
        if (!ok) return 0;
    }
    return 1;
}

/* Build the special-token scanner for `map`: declared `special_tokens`
 * first (priority), then any vocab key shaped like a delimiter that
 * isn't already declared. Returns `*out == NULL` (not an error) when
 * there is nothing to scan for, so callers can skip the pre-scan
 * entirely for maps with no special tokens. */
static codec_status_t build_special_trie(const codec_tokenizer_map_t *map,
                                         codec_special_trie_t **out) {
    *out = NULL;
    if ((!map->specials || map->special_count == 0) &&
        (!map->bpe_vocab || map->bpe_vocab_count == 0)) {
        return CODEC_OK;
    }

    codec_special_trie_t *t = NULL;
    codec_status_t st = trie_new(&t);
    if (st != CODEC_OK) return st;

    size_t inserted = 0;
    for (size_t i = 0; i < map->special_count; i++) {
        const char *name = map->specials[i].name;
        size_t len = name ? strlen(name) : 0;
        if (len == 0) continue;
        st = trie_insert(t, name, len, map->specials[i].id);
        if (st != CODEC_OK) { trie_free(t); return st; }
        inserted++;
    }

    for (size_t i = 0; i < map->bpe_vocab_count; i++) {
        const char *key = map->bpe_vocab[i].raw_key;
        size_t len = key ? strlen(key) : 0;
        if (!is_delimiter_shape(key, len)) continue;
        int already_declared = 0;
        for (size_t j = 0; j < map->special_count; j++) {
            if (map->specials[j].name && strcmp(map->specials[j].name, key) == 0) {
                already_declared = 1;
                break;
            }
        }
        if (already_declared) continue;
        st = trie_insert(t, key, len, map->bpe_vocab[i].id);
        if (st != CODEC_OK) { trie_free(t); return st; }
        inserted++;
    }

    if (inserted == 0) { trie_free(t); return CODEC_OK; }
    *out = t;
    return CODEC_OK;
}

/* Longest special token starting exactly at `text[start]`. Returns 0
 * (no match) or 1, with `*out_id` / `*out_len` set on a match. The walk
 * stops as soon as the trie has no edge for the next byte, so its cost
 * is bounded by the trie's depth, not by the remaining input length. */
static int trie_longest_match(const codec_special_trie_t *t,
                              const char *text, size_t text_len, size_t start,
                              uint32_t *out_id, size_t *out_len) {
    if (!t) return 0;
    uint32_t cur = 0;
    int found = 0;
    for (size_t pos = start; pos < text_len; pos++) {
        unsigned char b = (unsigned char)text[pos];
        int child = trie_find_child(&t->nodes[cur], b);
        if (child < 0) break;
        cur = (uint32_t)child;
        if (t->nodes[cur].is_end) {
            *out_id  = t->nodes[cur].id;
            *out_len = pos - start + 1;
            found = 1;
        }
    }
    return found;
}

/* Forward declarations from public header. */
struct codec_bpe_encoder {
    const codec_tokenizer_map_t *map;
    /* NULL when the map has no special tokens to scan for; every real
     * chat-template model has at least one, so this is populated in
     * practice. Built once at construction, reused across encode calls. */
    codec_special_trie_t *specials;
};

/* ── Public lifecycle ──────────────────────────────────────────────────── */

codec_status_t codec_bpe_encoder_new(const codec_tokenizer_map_t *map,
                                     codec_bpe_encoder_t **out) {
    if (!map || !out) return CODEC_ERR_INVALID_ARG;
    /* Hard requirements: vocab + merges + (program OR pattern, but we
     * support program only). */
    if (!codec_map_pretok_program(map))     return CODEC_ERR_VALIDATION;
    /* Encoder must be byte_level or metaspace; identity / canonical
     * vocab maps don't have BPE merges. */
    codec_encoder_t enc = codec_map_encoder(map);
    if (enc != CODEC_ENCODER_BYTE_LEVEL && enc != CODEC_ENCODER_METASPACE) {
        return CODEC_ERR_VALIDATION;
    }
    codec_bpe_encoder_t *e = (codec_bpe_encoder_t *)calloc(1, sizeof(*e));
    if (!e) return CODEC_ERR_OUT_OF_MEMORY;
    e->map = map;
    codec_status_t st = build_special_trie(map, &e->specials);
    if (st != CODEC_OK) { free(e); return st; }
    *out = e;
    return CODEC_OK;
}

void codec_bpe_encoder_free(codec_bpe_encoder_t *enc) {
    if (!enc) return;
    trie_free(enc->specials);
    free(enc);
}

/* ── Working representation: a list of token slices ────────────────────── */
/*
 * During BPE we keep the piece as a list of (offset, length) slices into
 * a working buffer that holds the byte-level-encoded piece. Merging two
 * adjacent slices is just `len[i] += len[i+1]; shift the rest left`.
 *
 * For metaspace, the working buffer is the piece itself (already in
 * vocab space). For byte_level, the working buffer is the byte-level
 * encoding of the piece. In both cases, initial slices are one
 * codepoint each.
 */

typedef struct {
    size_t off;
    size_t len;
} bpe_slice_t;

/* Walk a UTF-8 string, emit one slice per codepoint. */
static codec_status_t init_slices_per_codepoint(
    const char *s, size_t n,
    bpe_slice_t **out_slices, size_t *out_count)
{
    /* Worst case: every byte is its own codepoint. */
    bpe_slice_t *sl = (bpe_slice_t *)malloc(n * sizeof(bpe_slice_t));
    if (!sl && n > 0) return CODEC_ERR_OUT_OF_MEMORY;
    size_t count = 0;
    size_t i = 0;
    while (i < n) {
        size_t cp_len;
        uint8_t lead = (uint8_t)s[i];
        if (lead < 0x80)               cp_len = 1;
        else if ((lead & 0xE0) == 0xC0) cp_len = 2;
        else if ((lead & 0xF0) == 0xE0) cp_len = 3;
        else if ((lead & 0xF8) == 0xF0) cp_len = 4;
        else                            cp_len = 1; /* malformed; advance one byte */
        if (i + cp_len > n) cp_len = n - i;
        sl[count].off = i;
        sl[count].len = cp_len;
        count++;
        i += cp_len;
    }
    *out_slices = sl;
    *out_count  = count;
    return CODEC_OK;
}

/* Apply BPE merges until no more apply. The buffer `s` is mutated:
 * we overwrite it in-place to concatenate adjacent slices. Specifically,
 * a merge of slices i and i+1 keeps slices[i].off but extends slices[i].len
 * to include the next slice. We then shift all later slices down by one
 * in the array. Buffer bytes are unchanged: slices stay the same byte
 * offsets, just longer. */
static void apply_merges(const codec_tokenizer_map_t *map,
                         const char *buf,
                         bpe_slice_t *slices, size_t *count) {
    /* Reusable scratch for the "left right" pair lookup keys. We grow
     * it lazily; max needed is 2*max_slice_len + 1 (separator + NUL). */
    char  *pair_buf = NULL;
    size_t pair_cap = 0;

    while (*count >= 2) {
        size_t best_i = SIZE_MAX;
        uint32_t best_rank = UINT32_MAX;

        for (size_t i = 0; i + 1 < *count; i++) {
            size_t need = slices[i].len + 1 + slices[i + 1].len + 1;
            if (need > pair_cap) {
                size_t new_cap = pair_cap ? pair_cap * 2 : 64;
                while (new_cap < need) new_cap *= 2;
                char *grow = (char *)realloc(pair_buf, new_cap);
                if (!grow) { free(pair_buf); return; }
                pair_buf = grow;
                pair_cap = new_cap;
            }
            memcpy(pair_buf, buf + slices[i].off, slices[i].len);
            pair_buf[slices[i].len] = ' ';
            memcpy(pair_buf + slices[i].len + 1,
                   buf + slices[i + 1].off, slices[i + 1].len);
            pair_buf[slices[i].len + 1 + slices[i + 1].len] = '\0';

            uint32_t rank;
            if (codec_bpe_merge_rank(map, pair_buf, &rank)) {
                if (rank < best_rank) {
                    best_rank = rank;
                    best_i    = i;
                }
            }
        }
        if (best_i == SIZE_MAX) break;

        /* Merge ALL non-overlapping occurrences of the best pair in one
         * pass. Matches HuggingFace reference behavior. */
        const char *target_left  = buf + slices[best_i].off;
        size_t      target_left_len  = slices[best_i].len;
        const char *target_right = buf + slices[best_i + 1].off;
        size_t      target_right_len = slices[best_i + 1].len;

        size_t write = 0;
        size_t i = 0;
        while (i < *count) {
            int can_merge_here = 0;
            if (i + 1 < *count
                && slices[i].len == target_left_len
                && slices[i + 1].len == target_right_len
                && memcmp(buf + slices[i].off, target_left, target_left_len) == 0
                && memcmp(buf + slices[i + 1].off, target_right, target_right_len) == 0) {
                can_merge_here = 1;
            }
            if (can_merge_here) {
                /* Concatenated slice: combined offset = left.off, len = sum. */
                slices[write].off = slices[i].off;
                slices[write].len = slices[i].len + slices[i + 1].len;
                write++;
                i += 2;
            } else {
                slices[write++] = slices[i++];
            }
        }
        *count = write;
    }

    free(pair_buf);
}

/* Append one ID to the output buffer, growing it as needed. Shared by
 * emit_ids() (per-piece BPE output) and the special-token pre-scan
 * (atomic IDs emitted straight from a trie match, no BPE involved). */
static codec_status_t ids_push(uint32_t **out_ids, size_t *out_cap, size_t *out_len,
                               uint32_t id) {
    if (*out_len == *out_cap) {
        size_t nc = *out_cap ? *out_cap * 2 : 32;
        uint32_t *grow = (uint32_t *)realloc(*out_ids, nc * sizeof(uint32_t));
        if (!grow) return CODEC_ERR_OUT_OF_MEMORY;
        *out_ids = grow;
        *out_cap = nc;
    }
    (*out_ids)[(*out_len)++] = id;
    return CODEC_OK;
}

/* Append IDs from the slices into the output buffer. Slices not in
 * the vocab are skipped: for byte_level this should never happen
 * because every byte's encoded codepoint is in the vocab. */
static codec_status_t emit_ids(const codec_tokenizer_map_t *map,
                               const char *buf,
                               const bpe_slice_t *slices, size_t count,
                               uint32_t **out_ids, size_t *out_cap, size_t *out_len)
{
    for (size_t i = 0; i < count; i++) {
        /* Build a NUL-terminated copy of the slice for the lookup. We
         * could store a flat-array form but the lookup uses bsearch
         * with strcmp, so the key needs a sentinel. */
        char tmp_stack[256];
        char *tmp = tmp_stack;
        char *tmp_heap = NULL;
        if (slices[i].len + 1 > sizeof(tmp_stack)) {
            tmp_heap = (char *)malloc(slices[i].len + 1);
            if (!tmp_heap) return CODEC_ERR_OUT_OF_MEMORY;
            tmp = tmp_heap;
        }
        memcpy(tmp, buf + slices[i].off, slices[i].len);
        tmp[slices[i].len] = '\0';

        uint32_t id;
        int hit = codec_bpe_vocab_lookup(map, tmp, &id);
        free(tmp_heap);
        if (!hit) continue;  /* skip unknown: shouldn't happen for byte_level */

        codec_status_t st = ids_push(out_ids, out_cap, out_len, id);
        if (st != CODEC_OK) return st;
    }
    return CODEC_OK;
}

/* Encode one piece (post-pretok). Appends IDs to *out_ids. */
static codec_status_t encode_piece_byte_level(
    const codec_tokenizer_map_t *map,
    const uint8_t *piece, size_t piece_len,
    uint32_t **out_ids, size_t *out_cap, size_t *out_len)
{
    /* Step 2: byte-level encode → working buffer of GPT-2 codepoints. */
    size_t enc_len;
    char *enc = codec_encode_byte_level(piece, piece_len, &enc_len);
    if (!enc) return CODEC_ERR_OUT_OF_MEMORY;

    /* Step 3: BPE merges. */
    bpe_slice_t *slices = NULL;
    size_t count = 0;
    codec_status_t st = init_slices_per_codepoint(enc, enc_len, &slices, &count);
    if (st != CODEC_OK) { free(enc); return st; }

    apply_merges(map, enc, slices, &count);

    /* Step 4: emit IDs. */
    st = emit_ids(map, enc, slices, count, out_ids, out_cap, out_len);

    free(slices);
    free(enc);
    return st;
}

static codec_status_t encode_piece_metaspace(
    const codec_tokenizer_map_t *map,
    const char *piece, size_t piece_len,
    uint32_t **out_ids, size_t *out_cap, size_t *out_len)
{
    /* Step 2: identity (piece is already in vocab space). Working buffer
     * is the piece itself; no copy. */
    bpe_slice_t *slices = NULL;
    size_t count = 0;
    codec_status_t st = init_slices_per_codepoint(piece, piece_len, &slices, &count);
    if (st != CODEC_OK) return st;

    apply_merges(map, piece, slices, &count);

    st = emit_ids(map, piece, slices, count, out_ids, out_cap, out_len);
    free(slices);
    return st;
}

/* Run the pre-tokenizer + BPE pipeline over one plain-text span (a run
 * of input with no special token in it) and append its IDs to *out_ids.
 * `is_first_chunk` is true only for the span that opens the whole
 * encode() call: it is the metaspace `prefix_first` scheme's own
 * "first" concept, and it must stay anchored to the whole encode, not
 * reset at every special-token boundary. Concretely: `mistralai/mistral-v3`
 * and `mistralai/mixtral` only synthesize their leading ▁ once, at the
 * very start of input; a chat template's `<|im_start|>` in the middle
 * of the text must not make the word right after it look like a fresh
 * "start of input" and get a second synthetic ▁. Passing `prefix_first
 * = 1` unconditionally for every later span reproduces the plain
 * (no-synthesis) per-word ▁ behavior every prepend scheme falls back to
 * once it isn't the very first word of the whole encode: see
 * `codec_pretok_run_metaspace`'s `is_first` bookkeeping, where
 * `prefix_first && is_first` is the only thing that ever suppresses a
 * word's ▁ prefix. Byte_level ignores `is_first_chunk` entirely: its
 * pre-tokenizer program has no equivalent leading-prepend concept. */
static codec_status_t encode_span(
    const codec_tokenizer_map_t *map,
    const codec_pretok_program_t *prog,
    int is_metaspace,
    const char *chunk, size_t chunk_len,
    int is_first_chunk,
    uint32_t **out_ids, size_t *out_cap, size_t *out_len)
{
    if (chunk_len == 0) return CODEC_OK;

    if (is_metaspace) {
        int prefix_first = is_first_chunk
            ? prog->ops[0].u.metaspace_split.prefix_first
            : 1;
        char **pieces = NULL;
        size_t piece_count = 0;
        codec_status_t st = codec_pretok_run_metaspace(
            (const uint8_t *)chunk, chunk_len, prefix_first,
            &pieces, &piece_count);
        if (st != CODEC_OK) return st;

        for (size_t i = 0; i < piece_count; i++) {
            st = encode_piece_metaspace(map, pieces[i], strlen(pieces[i]),
                                         out_ids, out_cap, out_len);
            if (st != CODEC_OK) {
                codec_pretok_free_metaspace_pieces(pieces, piece_count);
                return st;
            }
        }
        codec_pretok_free_metaspace_pieces(pieces, piece_count);
        return CODEC_OK;
    }

    codec_pretok_piece_t *pieces = NULL;
    size_t piece_count = 0;
    codec_status_t st = codec_pretok_run_program(
        prog, (const uint8_t *)chunk, chunk_len, &pieces, &piece_count);
    if (st != CODEC_OK) return st;

    for (size_t i = 0; i < piece_count; i++) {
        st = encode_piece_byte_level(
            map,
            (const uint8_t *)chunk + pieces[i].off,
            pieces[i].len,
            out_ids, out_cap, out_len);
        if (st != CODEC_OK) {
            codec_pretok_free_pieces(pieces);
            return st;
        }
    }
    codec_pretok_free_pieces(pieces);
    return CODEC_OK;
}

/* ── Public encode ─────────────────────────────────────────────────────── */

codec_status_t codec_bpe_encode(codec_bpe_encoder_t *enc,
                                const char *text, size_t text_len,
                                uint32_t **out_ids, size_t *out_count)
{
    if (!enc || (!text && text_len > 0) || !out_ids || !out_count) {
        return CODEC_ERR_INVALID_ARG;
    }
    *out_ids   = NULL;
    *out_count = 0;
    if (text_len == 0) return CODEC_OK;

    const codec_tokenizer_map_t *map = enc->map;
    const codec_pretok_program_t *prog = codec_map_pretok_program(map);
    if (!prog) return CODEC_ERR_VALIDATION;

    uint32_t *ids = NULL;
    size_t    ids_cap = 0, ids_len = 0;

    /* Branch on encoder family: the pretok program tells us metaspace
     * vs GPT-2-family by its op shape. Metaspace is v1-only (a v2
     * program's op_count is always 0; see codec.h), but the version
     * check is spelled out here too so this stays correct even if that
     * invariant ever changes. */
    int is_metaspace = (prog->version == 1 && prog->op_count == 1
                        && prog->ops[0].kind == CODEC_PRETOK_METASPACE_SPLIT);

    if (enc->specials == NULL) {
        /* No special tokens declared for this map: the whole input is
         * one plain-text span, exactly the pre-existing behavior. */
        codec_status_t st = encode_span(map, prog, is_metaspace,
                                        text, text_len, 1,
                                        &ids, &ids_cap, &ids_len);
        if (st != CODEC_OK) { free(ids); return st; }
        *out_ids   = ids;
        *out_count = ids_len;
        return CODEC_OK;
    }

    /* Special-token pre-scan: split on any literal special-token match
     * before pre-tokenization/BPE runs, exactly mirroring HuggingFace's
     * `AddedVocabulary` splitter (and `packages/web/src/bpe.ts`'s
     * `encode()`). Each match is emitted as its atomic vocab ID; the
     * plain-text spans between matches go through the normal pipeline. */
    size_t cursor = 0;          /* start of the pending plain-text span */
    size_t pos = 0;              /* scan cursor */
    int is_first_chunk = 1;
    while (pos < text_len) {
        uint32_t special_id;
        size_t match_len;
        if (trie_longest_match(enc->specials, text, text_len, pos,
                               &special_id, &match_len)) {
            if (pos > cursor) {
                codec_status_t st = encode_span(map, prog, is_metaspace,
                                                text + cursor, pos - cursor,
                                                is_first_chunk,
                                                &ids, &ids_cap, &ids_len);
                if (st != CODEC_OK) { free(ids); return st; }
                is_first_chunk = 0;
            }
            codec_status_t st = ids_push(&ids, &ids_cap, &ids_len, special_id);
            if (st != CODEC_OK) { free(ids); return st; }
            pos += match_len;
            cursor = pos;
        } else {
            pos++;
        }
    }
    if (cursor < text_len) {
        codec_status_t st = encode_span(map, prog, is_metaspace,
                                        text + cursor, text_len - cursor,
                                        is_first_chunk,
                                        &ids, &ids_cap, &ids_len);
        if (st != CODEC_OK) { free(ids); return st; }
    }

    *out_ids   = ids;
    *out_count = ids_len;
    return CODEC_OK;
}
