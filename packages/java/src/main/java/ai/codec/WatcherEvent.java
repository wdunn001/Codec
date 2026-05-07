// SPDX-License-Identifier: MIT
package ai.codec;

import java.util.Arrays;

/**
 * One event from {@link ToolWatcher#feed(long[])}.
 *
 * <p>{@code ids} is always a fresh array — safe to retain across
 * subsequent feed calls.
 *
 * <p>IDs are stored as {@code long} so the full uint32 range (up to
 * 4_294_967_295) is representable without wraparound; Java has no native
 * unsigned 32-bit integer type.
 */
public final class WatcherEvent {
    private final WatcherEventKind kind;
    private final long[] ids;

    public WatcherEvent(WatcherEventKind kind, long[] ids) {
        this.kind = kind;
        this.ids = ids;
    }

    public WatcherEventKind getKind() { return kind; }
    public long[] getIds() { return ids; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof WatcherEvent w)) return false;
        return kind == w.kind && Arrays.equals(ids, w.ids);
    }

    @Override
    public int hashCode() {
        return 31 * kind.hashCode() + Arrays.hashCode(ids);
    }

    @Override
    public String toString() {
        return "WatcherEvent(" + kind + ", ids=" + Arrays.toString(ids) + ")";
    }
}
