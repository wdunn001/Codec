// SPDX-License-Identifier: MIT
package ai.codec;

/** Raised when a named special token isn't in the map. */
public final class ToolWatcherException extends RuntimeException {
    public ToolWatcherException(String message) {
        super(message);
    }
}
