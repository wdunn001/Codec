// SPDX-License-Identifier: MIT
package ai.codec;

/**
 * Common interface every tokenizer implementation satisfies.
 * {@link BPETokenizer}, {@link LongestMatchTokenizer}, and any
 * external/wasm adapter all implement this.
 */
public interface ITokenizer {
    /** Identifier of the underlying vocabulary. */
    String getId();

    /** Encode a string to a sequence of token IDs. */
    int[] encode(String text);
}
