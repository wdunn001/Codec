// SPDX-License-Identifier: MIT
package ai.codec;

/** Raised when a discovery document is malformed or absent. */
public class SafetyPolicyDiscoveryException extends RuntimeException {
    public SafetyPolicyDiscoveryException(String message) {
        super(message);
    }

    /** Raised when the discovery URL returns 404. */
    public static final class NotFound extends SafetyPolicyDiscoveryException {
        public final String url;
        public final int status;

        public NotFound(String url, int status) {
            super("No safety-policy document at " + url + " (HTTP " + status + ")");
            this.url = url;
            this.status = status;
        }
    }
}
