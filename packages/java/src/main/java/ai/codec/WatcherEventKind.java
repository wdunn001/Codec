// SPDX-License-Identifier: MIT
package ai.codec;

/** Kind of event emitted by {@link ToolWatcher#feed(long[])} / {@link ToolWatcher#end(String)}. */
public enum WatcherEventKind {
    /** Token IDs outside any watched region. Forward as-is. */
    PASSTHROUGH,
    /** A complete start..end region with markers excluded. */
    REGION,
    /** Emitted only by {@link ToolWatcher#end(String)}, when the stream finished while still inside a region. */
    TRUNCATED,
    /** The region buffer hit its configured cap. */
    OVERFLOW,
    /** A start marker was seen while already inside a region. */
    NESTED_START
}
