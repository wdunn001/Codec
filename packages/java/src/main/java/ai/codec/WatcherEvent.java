// SPDX-License-Identifier: MIT
package ai.codec;

import java.util.Arrays;
import java.util.Objects;

/**
 * One event from {@link ToolWatcher#feed(long[])} / {@link ToolWatcher#end(String)}.
 *
 * <p>{@code ids} is always a fresh array: safe to retain across
 * subsequent feed calls.
 *
 * <p>IDs are stored as {@code long} so the full uint32 range (up to
 * 4_294_967_295) is representable without wraparound; Java has no native
 * unsigned 32-bit integer type.
 *
 * <p>{@code finishReason} is set only on {@link WatcherEventKind#TRUNCATED}
 * events, and only when the caller passed one to {@link ToolWatcher#end}.
 * {@code null} otherwise.
 */
public final class WatcherEvent {
    private final WatcherEventKind kind;
    private final long[] ids;
    private final String finishReason;

    public WatcherEvent(WatcherEventKind kind, long[] ids) {
        this(kind, ids, null);
    }

    public WatcherEvent(WatcherEventKind kind, long[] ids, String finishReason) {
        this.kind = kind;
        this.ids = ids;
        this.finishReason = finishReason;
    }

    public WatcherEventKind getKind() { return kind; }
    public long[] getIds() { return ids; }
    public String getFinishReason() { return finishReason; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof WatcherEvent w)) return false;
        return kind == w.kind && Arrays.equals(ids, w.ids)
                && Objects.equals(finishReason, w.finishReason);
    }

    @Override
    public int hashCode() {
        int h = 31 * kind.hashCode() + Arrays.hashCode(ids);
        return 31 * h + Objects.hashCode(finishReason);
    }

    @Override
    public String toString() {
        return "WatcherEvent(" + kind + ", ids=" + Arrays.toString(ids)
                + ", finishReason=" + finishReason + ")";
    }
}
