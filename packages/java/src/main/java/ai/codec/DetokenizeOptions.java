// SPDX-License-Identifier: MIT
package ai.codec;

/**
 * Options for {@link Detokenizer#render}.
 */
public final class DetokenizeOptions {
    public final boolean partial;
    public final boolean renderSpecial;

    public DetokenizeOptions(boolean partial, boolean renderSpecial) {
        this.partial = partial;
        this.renderSpecial = renderSpecial;
    }

    public static DetokenizeOptions defaults() {
        return new DetokenizeOptions(false, false);
    }

    public static DetokenizeOptions partial(boolean partial) {
        return new DetokenizeOptions(partial, false);
    }

    public static DetokenizeOptions partialAndSpecial(boolean partial, boolean renderSpecial) {
        return new DetokenizeOptions(partial, renderSpecial);
    }
}
