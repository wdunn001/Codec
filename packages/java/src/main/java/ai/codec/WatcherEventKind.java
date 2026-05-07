// SPDX-License-Identifier: MIT
package ai.codec;

/** Kind of event emitted by {@link ToolWatcher#feed(long[])}. */
public enum WatcherEventKind {
    /** Token IDs outside any watched region. Forward as-is. */
    PASSTHROUGH,
    /** A complete start..end region with markers excluded. */
    REGION
}
