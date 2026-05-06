/* SPDX-License-Identifier: MIT
 *
 * BPE encoder — text → token IDs.
 *
 * Mirrors the algorithm used by @codecai/web's BPETokenizer, codecai's
 * BPETokenizer, and Codec.Net's BPETokenizer. All four implementations
 * are bit-identical to HuggingFace's reference Rust tokenizer for
 * Qwen-2 across the test fixtures.
 *
 * Algorithm (byte_level):
 *   1. Run the pre-tokenizer program to split input text into pieces.
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
 * map. The encode function returns a fresh array of IDs the caller
 * frees with free().
 */
#include "codec/codec.h"
#include "codec_internal.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Forward declarations from public header. */
struct codec_bpe_encoder {
    const codec_tokenizer_map_t *map;
    /* No further state — all per-encode work happens on the stack. */
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
    *out = e;
    return CODEC_OK;
}

void codec_bpe_encoder_free(codec_bpe_encoder_t *enc) {
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
 * in the array. Buffer bytes are unchanged — slices stay the same byte
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

/* Append IDs from the slices into the output buffer. Slices not in
 * the vocab are skipped — for byte_level this should never happen
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
        if (!hit) continue;  /* skip unknown — shouldn't happen for byte_level */

        if (*out_len == *out_cap) {
            size_t nc = *out_cap ? *out_cap * 2 : 32;
            uint32_t *grow = (uint32_t *)realloc(*out_ids, nc * sizeof(uint32_t));
            if (!grow) return CODEC_ERR_OUT_OF_MEMORY;
            *out_ids = grow;
            *out_cap = nc;
        }
        (*out_ids)[(*out_len)++] = id;
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

    /* Branch on encoder family — the pretok program tells us metaspace
     * vs GPT-2-family by its op shape. */
    int is_metaspace = (prog->op_count == 1
                        && prog->ops[0].kind == CODEC_PRETOK_METASPACE_SPLIT);

    if (is_metaspace) {
        char **pieces = NULL;
        size_t piece_count = 0;
        codec_status_t st = codec_pretok_run_metaspace(
            (const uint8_t *)text, text_len,
            prog->ops[0].u.metaspace_split.prefix_first,
            &pieces, &piece_count);
        if (st != CODEC_OK) return st;

        for (size_t i = 0; i < piece_count; i++) {
            st = encode_piece_metaspace(map, pieces[i], strlen(pieces[i]),
                                         &ids, &ids_cap, &ids_len);
            if (st != CODEC_OK) {
                codec_pretok_free_metaspace_pieces(pieces, piece_count);
                free(ids);
                return st;
            }
        }
        codec_pretok_free_metaspace_pieces(pieces, piece_count);
    } else {
        codec_pretok_piece_t *pieces = NULL;
        size_t piece_count = 0;
        codec_status_t st = codec_pretok_run_program(
            prog, (const uint8_t *)text, text_len, &pieces, &piece_count);
        if (st != CODEC_OK) return st;

        for (size_t i = 0; i < piece_count; i++) {
            st = encode_piece_byte_level(
                map,
                (const uint8_t *)text + pieces[i].off,
                pieces[i].len,
                &ids, &ids_cap, &ids_len);
            if (st != CODEC_OK) {
                codec_pretok_free_pieces(pieces);
                free(ids);
                return st;
            }
        }
        codec_pretok_free_pieces(pieces);
    }

    *out_ids   = ids;
    *out_count = ids_len;
    return CODEC_OK;
}
