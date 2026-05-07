// SPDX-License-Identifier: MIT
package ai.codec;

import java.util.Arrays;

/**
 * One streaming frame produced by a Codec-compliant server. Identical
 * shape across MessagePack and Protobuf wire modes; only serialization
 * differs.
 *
 * <p>Fields:
 * <ul>
 *   <li>{@code ids} — token IDs emitted by the model in this chunk.</li>
 *   <li>{@code done} — {@code true} on the final frame; no further frames follow.</li>
 *   <li>{@code finishReason} — Set on the final frame, e.g. {@code "length"},
 *       {@code "stop"}, {@code "eos_token"}, {@code "error"}.</li>
 * </ul>
 */
public record CodecFrame(int[] ids, boolean done, String finishReason) {

    public CodecFrame {
        if (ids == null) ids = new int[0];
    }

    /** Convenience constructor for non-terminal frames. */
    public static CodecFrame of(int[] ids) {
        return new CodecFrame(ids, false, null);
    }

    /** Convenience constructor for terminal frames. */
    public static CodecFrame ofTerminal(int[] ids, String finishReason) {
        return new CodecFrame(ids, true, finishReason);
    }

    @Override
    public String toString() {
        return "CodecFrame(ids=[" + joinInts(ids) + "], done=" + done
                + ", finish_reason=" + (finishReason == null ? "null" : finishReason) + ")";
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof CodecFrame other)) return false;
        return done == other.done
                && Arrays.equals(ids, other.ids)
                && java.util.Objects.equals(finishReason, other.finishReason);
    }

    @Override
    public int hashCode() {
        int result = Arrays.hashCode(ids);
        result = 31 * result + Boolean.hashCode(done);
        result = 31 * result + java.util.Objects.hashCode(finishReason);
        return result;
    }

    private static String joinInts(int[] arr) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < arr.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(arr[i]);
        }
        return sb.toString();
    }
}
