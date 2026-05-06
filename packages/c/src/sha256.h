/* SHA-256 implementation (public domain).
 * Adapted from Brad Conte's reference implementation:
 *   https://github.com/B-Con/crypto-algorithms
 * Self-contained, no external deps.
 */
#ifndef CODEC_SHA256_H
#define CODEC_SHA256_H

#include <stddef.h>
#include <stdint.h>

#define CODEC_SHA256_BLOCK_SIZE 32

typedef struct {
    uint8_t  data[64];
    uint32_t datalen;
    uint64_t bitlen;
    uint32_t state[8];
} codec_sha256_ctx;

void codec_sha256_init(codec_sha256_ctx *ctx);
void codec_sha256_update(codec_sha256_ctx *ctx, const uint8_t *data, size_t len);
void codec_sha256_final(codec_sha256_ctx *ctx, uint8_t hash[CODEC_SHA256_BLOCK_SIZE]);
void codec_sha256(const uint8_t *data, size_t len, uint8_t hash[CODEC_SHA256_BLOCK_SIZE]);

#endif
