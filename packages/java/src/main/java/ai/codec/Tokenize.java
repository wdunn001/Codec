// SPDX-License-Identifier: MIT
package ai.codec;

/** Top-level tokenizer factory. */
public final class Tokenize {
    private Tokenize() {}

    /**
     * Build the right tokenizer for the map. {@link BPETokenizer} when the
     * map has BPE data; otherwise {@link LongestMatchTokenizer}.
     */
    public static ITokenizer pick(TokenizerMap map) {
        return BPETokenizer.supports(map)
                ? new BPETokenizer(map)
                : new LongestMatchTokenizer(map);
    }

    /** One-shot encode using {@link #pick}. */
    public static int[] encode(TokenizerMap map, String text) {
        return pick(map).encode(text);
    }
}
