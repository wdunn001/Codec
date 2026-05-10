// SPDX-License-Identifier: MIT
package ai.codec;

/** Raised when a safety-policy descriptor fails the schema check. */
public final class SafetyPolicyValidationException extends RuntimeException {
    public SafetyPolicyValidationException(String message) {
        super("SafetyPolicyDescriptor validation failed: " + message);
    }
}
