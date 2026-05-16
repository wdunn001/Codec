// SPDX-License-Identifier: MIT
package ai.codec;

/**
 * Raised when the server's {@code Codec-Zstd-Dict} response header doesn't
 * match any dict the client has loaded, is missing on a zstd response, or
 * is malformed.
 *
 * <p>A wrong-dict decompression would produce garbage bytes that
 * downstream parsers (msgpack/protobuf) would misinterpret — fail fast
 * instead. See {@code spec/PROTOCOL.md} "Codec-Zstd-Dict response header"
 * for the full contract.
 *
 * <p>Java twin of {@code codecai.compression.CodecZstdDictError} (Python),
 * {@code @codecai/web}'s equivalent, and {@code Codec.Compression.CodecZstdDictError}
 * (.NET). Modeled as a {@link RuntimeException} to match the sibling
 * {@link SafetyPolicyHashMismatchException} / {@link TokenizerMapHashMismatchException}
 * pattern in this package — content-addressing failures are unchecked.
 */
public final class CodecZstdDictError extends RuntimeException {
    public CodecZstdDictError(String message) {
        super(message);
    }
}
