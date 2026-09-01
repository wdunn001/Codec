/* SPDX-License-Identifier: MIT
 *
 * Structural completeness check for a jsmn token array.
 *
 * jsmn does not require an object's declared `size` to be backed by the
 * child tokens it actually emitted. The input `{"a"}` parses cleanly and
 * yields two tokens: an OBJECT of size 1 and a STRING. The terminal check
 * only looks for tokens left with `end == -1`. Both of these are closed.
 * No JSMN_ERROR_PART is raised.
 *
 * Every token walker in this library assumes the opposite: an OBJECT
 * of size N is followed by exactly 2N tokens; an ARRAY of size N by
 * exactly N. On a short object they read `toks[pos + 1]` past the end of
 * an array that was allocated to hold exactly the parsed token count.
 * That is a heap overread. In map.c and codec_version_signaling.c the
 * garbage `start` / `end` it produces is then used as an offset and length
 * into the JSON buffer. That turns it into a disclosure primitive.
 *
 * Validating the shape once up front covers all ~15 read sites at once.
 * If a walk of the whole token forest consumes exactly
 * `n` tokens without ever running past `n`, then every parent's declared
 * size is backed by real children and the walkers cannot index out.
 *
 * Header-only and static so each translation unit gets its own copy. The
 * jsmn implementation lives in map.c; the other consumers include jsmn.h
 * under JSMN_HEADER. A shared non-inline symbol would need a fourth
 * translation unit for no benefit.
 */
#ifndef CODEC_JSMN_GUARD_H
#define CODEC_JSMN_GUARD_H

#include <stddef.h>

/*
 * Returns 1 when the token forest in `toks[0..n)` is structurally complete,
 * 0 otherwise. Note that key STRING tokens carry `size == 1` in this
 * vendored jsmn (the `:` sets toksuper to the key; the value then
 * increments it). The accounting below deliberately ignores that: the
 * walkers model a pair as "key token plus one subtree". Only OBJECT and
 * ARRAY contribute to the pending count.
 */
static int codec_jsmn_tree_complete(const jsmntok_t *toks, size_t n) {
    size_t i = 0;
    while (i < n) {
        size_t remaining = 1;
        while (remaining > 0) {
            if (i >= n) return 0;
            const jsmntok_t *t = &toks[i++];
            remaining--;
            if (t->size < 0) return 0;
            if (t->type == JSMN_OBJECT) {
                remaining += (size_t)t->size * 2;
            } else if (t->type == JSMN_ARRAY) {
                remaining += (size_t)t->size;
            }
        }
    }
    return 1;
}

#endif /* CODEC_JSMN_GUARD_H */
