// SPDX-License-Identifier: MIT
package ai.codec;

/** Raised when the fetched bytes don't hash to the expected value. */
public final class SafetyPolicyHashMismatchException extends RuntimeException {
    public final String expected;
    public final String actual;

    public SafetyPolicyHashMismatchException(String expected, String actual) {
        super("SafetyPolicyDescriptor hash mismatch.\n  expected: " + expected + "\n  actual:   " + actual);
        this.expected = expected;
        this.actual = actual;
    }
}
