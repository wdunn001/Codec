// SPDX-License-Identifier: MIT
package ai.codec;

/**
 * Raised when {@code .well-known/codec/dicts/<hex>.zstd} discovery fails (v0.5+).
 *
 * <p>Covers: 404 from origin, malformed hash input, and HTTP transport
 * failures. The dict-discovery surface is hard-fail by design: see
 * {@code spec/WELL_KNOWN_DISCOVERY.md § Resolution failures}. Silent
 * fallback to identity bytes was the v0.4.1 sglang COPY-dicts regression
 * class this surface eliminates.
 */
public class ZstdDictDiscoveryException extends RuntimeException {
    public final String url;

    public ZstdDictDiscoveryException(String message) {
        super(message);
        this.url = null;
    }

    public ZstdDictDiscoveryException(String message, String url) {
        super(message);
        this.url = url;
    }

    /** Raised when {@code .well-known/codec/dicts/<hex>.zstd} returns 404. */
    public static final class NotFound extends ZstdDictDiscoveryException {
        public final int status;

        public NotFound(String url, int status) {
            super("No zstd dict at " + url + " (HTTP " + status + ")", url);
            this.status = status;
        }
    }
}
