// SPDX-License-Identifier: MIT
package ai.codec;

/** Thrown when a fetched map doesn't match the expected hash. */
public final class TokenizerMapHashMismatchException extends RuntimeException {
    private final String expected;
    private final String actual;

    public TokenizerMapHashMismatchException(String expected, String actual) {
        super("TokenizerMap hash mismatch.\n  expected: " + expected + "\n  actual:   " + actual);
        this.expected = expected;
        this.actual = actual;
    }

    public String getExpected() { return expected; }
    public String getActual()   { return actual; }
}
