/* Internal-only definitions. Not part of the public API. */
#ifndef CODEC_INTERNAL_H
#define CODEC_INTERNAL_H

#include "codec/codec.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Internal map representation. We store the id→token reverse mapping eagerly
 * because the detokenizer hits it on every token. Vocab and merges are
 * deferred to v0.2 (they're only needed for BPE).
 *
 * For byte_level maps, `entries[id].bytes` is the result of decoding the
 * raw GPT-2-encoded vocab key. For metaspace, it's the ▁→' '-replaced text.
 * For identity, it's the vocab key as-is (or the v1 `tokens` dict value).
 *
 * Empty entries (`bytes == NULL`) are skipped and rendered as U+FFFD.
 */
typedef struct codec_id_entry {
    uint8_t *bytes;
    size_t   len;
} codec_id_entry_t;

/* Raw vocab entry: stores the *encoded* form (Ġworld, ▁world) for
 * BPE lookup. Distinct from the decoded `entries` table the detokenizer
 * uses. Sorted lexically by raw_key so BPE can bsearch piece -> id. */
typedef struct codec_bpe_vocab_entry {
    char    *raw_key;
    uint32_t id;
} codec_bpe_vocab_entry_t;

/* Merge entry: "left right" plus its priority rank (rank 0 = highest
 * priority). Sorted lexically by `pair` so BPE's inner loop can bsearch
 * "is this pair mergeable?" in O(log N). */
typedef struct codec_bpe_merge_entry {
    char    *pair;
    uint32_t rank;
} codec_bpe_merge_entry_t;

struct codec_tokenizer_map {
    char            *id;
    char            *version;
    size_t           vocab_size;
    codec_encoder_t  encoder;

    codec_id_entry_t *entries;       /* indexed by token ID */
    size_t            entries_cap;   /* allocated length (max_id + 1) */

    int32_t  byte_fallback_start;    /* -1 if absent */
    int32_t  byte_fallback_end;      /* -1 if absent */

    /* Special tokens with their names retained. Callers can therefore
     * resolve a name like "<tool_call>" to its ID without round-tripping through
     * the detokenizer. The names are shallow-copied during JSON parse. */
    struct codec_special_entry {
        char    *name;
        uint32_t id;
    } *specials;
    size_t       special_count;

    /* BPE: present only when the JSON map carries v2 vocab + merges.
     * NULL/zero on v1-only or canonical-IR maps. */
    codec_bpe_vocab_entry_t *bpe_vocab;       /* sorted by raw_key */
    size_t                   bpe_vocab_count;

    codec_bpe_merge_entry_t *bpe_merges;      /* sorted by pair */
    size_t                   bpe_merges_count;

    /* Pre-tokenizer program (v2.1, optional). Owned by the map; the
     * BPE encoder runs it via codec_pretok_run_program. NULL when the
     * map only carries pre_tokenizer_pattern (legacy regex form),
     * which libcodec doesn't support: BPE construction fails on
     * such maps. */
    codec_pretok_program_t  *pretok_program;

    /* Tool-calling convention (optional, v2 maps and later). Owned by
     * the map; the marker-name strings are duplicated from the JSON
     * input so the parsed token buffer can be freed. NULL when the map
     * doesn't declare a tool_calling block. */
    codec_tool_calling_t    *tool_calling;
};

/* GPT-2 byte ↔ unicode helpers used by both map.c and BPE. */
void  codec_byte_unicode_init(void);
char *codec_decode_byte_level_token(const char *raw, size_t raw_len, size_t *out_len);
char *codec_encode_byte_level(const uint8_t *bytes, size_t bytes_len, size_t *out_len);

/* UTF-8 strict decode for a single sequence; returns 0 if invalid. */
int   codec_utf8_seq_len(uint8_t lead);

/* Hex helpers for SHA-256 verification. */
int   codec_hex_to_byte(char hi, char lo);
void  codec_bytes_to_hex(const uint8_t *bytes, size_t len, char *hex_out);

/* Internal map accessors shared with detokenize.c, tool_watcher.c, etc. */
const codec_id_entry_t *codec_map_entry(const codec_tokenizer_map_t *m, uint32_t id);
int                     codec_map_is_special(const codec_tokenizer_map_t *m, uint32_t id);
int32_t                 codec_map_byte_fallback_start(const codec_tokenizer_map_t *m);
int32_t                 codec_map_byte_fallback_end(const codec_tokenizer_map_t *m);

/* Unicode property tables (generated: see scripts/gen-unicode-tables.py).
 * Used by the pre-tokenizer program runtime to query character classes
 * without a regex engine. Mark / Punct / Symbol back the v2 composite
 * classes (L_M, l_p_s, p_s): see spec/PRETOKENIZER_PROGRAM.md § Class
 * membership. */
bool codec_unicode_is_letter(uint32_t cp);
bool codec_unicode_is_number(uint32_t cp);
bool codec_unicode_is_ws(uint32_t cp);
bool codec_unicode_is_mark(uint32_t cp);
bool codec_unicode_is_punct(uint32_t cp);
bool codec_unicode_is_symbol(uint32_t cp);
/* letters_cased "upper cluster" (Lu ∪ Lt ∪ Lm ∪ Lo ∪ M) and "lower
 * cluster" (Ll ∪ Lm ∪ Lo ∪ M). Lm/Lo/M sit in both clusters; that
 * overlap is what makes the case-boundary matcher backtrack. See
 * spec/PRETOKENIZER_PROGRAM.md § letters_cased. */
bool codec_unicode_is_letter_cased_upper(uint32_t cp);
bool codec_unicode_is_letter_cased_lower(uint32_t cp);

/* BPE-side accessors (used by bpe.c). */
int  codec_bpe_vocab_lookup(const codec_tokenizer_map_t *m,
                            const char *raw_key, uint32_t *out_id);
int  codec_bpe_merge_rank(const codec_tokenizer_map_t *m,
                          const char *pair, uint32_t *out_rank);
const codec_pretok_program_t *codec_map_pretok_program(
    const codec_tokenizer_map_t *m);

#endif /* CODEC_INTERNAL_H */
