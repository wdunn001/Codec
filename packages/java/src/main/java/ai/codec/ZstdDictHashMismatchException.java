// SPDX-License-Identifier: MIT
package ai.codec;

/**
 * Raised when fetched zstd dict bytes don't hash to the URL's path component.
 *
 * <p>Treat as byte-tampering: never decompress. The expected hash comes
 * from the {@code <hex>} component of the
 * {@code .well-known/codec/dicts/<hex>.zstd} URL the caller passed to
 * {@link ZstdDictDiscovery#discover}.
 */
public final class ZstdDictHashMismatchException extends ZstdDictDiscoveryException {
    public final String expected;
    public final String actual;

    public ZstdDictHashMismatchException(String url, String expected, String actual) {
        super(
                "Zstd dict hash mismatch at " + url
                        + "\n  expected: " + expected
                        + "\n  actual:   " + actual,
                url);
        this.expected = expected;
        this.actual = actual;
    }
}
