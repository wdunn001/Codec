/* SPDX-License-Identifier: MIT
 *
 * Stubs for size-stripped builds (-DCODEC_WITH_BPE_ENCODER=OFF).
 *
 * Embedded / IoT consumers that only need decode-side libcodec
 * (Detokenizer, ToolWatcher, stream decoders, frame codec, compression,
 * safety-policy) can drop the BPE encoder + pre-tokenizer runtime + the
 * Unicode tables they depend on by passing `-DCODEC_WITH_BPE_ENCODER=OFF`
 * at CMake configure time. That cuts ~50 KB of compiled code + data from
 * the library — worthwhile on flash-budget microcontrollers and tools
 * built around the `@codecai/tool-kit` pre-cached pattern where runtime
 * BPE is never needed.
 *
 * This file provides the public-API symbols those callers' code may
 * still link against (so they don't have to ifdef their own code based
 * on build config), returning CODEC_ERR_NOT_BUILT consistently. The
 * lifecycle "free" entry points are safe no-ops; "new" / "translate" /
 * "encode" entry points return NOT_BUILT and leave out-pointers
 * untouched.
 *
 * Compiled only when CODEC_WITH_BPE_ENCODER=OFF. When ON, the real
 * implementations in bpe.c / pretok_program.c / translator.c +
 * codec_unicode_tables.c provide these symbols instead.
 */
#include "codec/codec.h"

#include <stddef.h>

/* ── Pretok program ─────────────────────────────────────────────────── */

codec_status_t codec_pretok_run_program(
    const codec_pretok_program_t *prog,
    const uint8_t *input, size_t input_len,
    codec_pretok_piece_t **out_pieces, size_t *out_count) {
    (void)prog; (void)input; (void)input_len;
    if (out_pieces) *out_pieces = NULL;
    if (out_count)  *out_count  = 0;
    return CODEC_ERR_NOT_BUILT;
}

void codec_pretok_free_pieces(codec_pretok_piece_t *pieces) {
    (void)pieces;
}

codec_status_t codec_pretok_run_metaspace(
    const uint8_t *input, size_t input_len, int prefix_first,
    char ***out_pieces, size_t *out_count) {
    (void)input; (void)input_len; (void)prefix_first;
    if (out_pieces) *out_pieces = NULL;
    if (out_count)  *out_count  = 0;
    return CODEC_ERR_NOT_BUILT;
}

void codec_pretok_free_metaspace_pieces(char **pieces, size_t count) {
    (void)pieces; (void)count;
}

/* ── BPE encoder ────────────────────────────────────────────────────── */

codec_status_t codec_bpe_encoder_new(const codec_tokenizer_map_t *map,
                                     codec_bpe_encoder_t **out) {
    (void)map;
    if (out) *out = NULL;
    return CODEC_ERR_NOT_BUILT;
}

void codec_bpe_encoder_free(codec_bpe_encoder_t *enc) {
    (void)enc;
}

codec_status_t codec_bpe_encode(codec_bpe_encoder_t *enc,
                                const char *text, size_t text_len,
                                uint32_t **out_ids, size_t *out_count) {
    (void)enc; (void)text; (void)text_len;
    if (out_ids)   *out_ids   = NULL;
    if (out_count) *out_count = 0;
    return CODEC_ERR_NOT_BUILT;
}

/* ── Translator ─────────────────────────────────────────────────────── */

codec_status_t codec_translator_new(const codec_tokenizer_map_t *from_map,
                                    const codec_tokenizer_map_t *to_map,
                                    codec_translator_t **out) {
    (void)from_map; (void)to_map;
    if (out) *out = NULL;
    return CODEC_ERR_NOT_BUILT;
}

void codec_translator_free(codec_translator_t *tr) {
    (void)tr;
}

codec_status_t codec_translator_translate(codec_translator_t *tr,
                                          const uint32_t *ids, size_t ids_count,
                                          int partial,
                                          uint32_t **out_ids, size_t *out_count) {
    (void)tr; (void)ids; (void)ids_count; (void)partial;
    if (out_ids)   *out_ids   = NULL;
    if (out_count) *out_count = 0;
    return CODEC_ERR_NOT_BUILT;
}

codec_status_t codec_translator_finish(codec_translator_t *tr,
                                       uint32_t **out_ids, size_t *out_count) {
    (void)tr;
    if (out_ids)   *out_ids   = NULL;
    if (out_count) *out_count = 0;
    return CODEC_ERR_NOT_BUILT;
}
