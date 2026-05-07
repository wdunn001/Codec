// SPDX-License-Identifier: MIT
package ai.codec;

/** Thrown by {@link TokenizerMap#validate} on schema violations. */
public final class TokenizerMapValidationException extends RuntimeException {
    public TokenizerMapValidationException(String message) {
        super("TokenizerMap validation failed: " + message);
    }
}
