// SPDX-License-Identifier: MIT
package ai.codec;

import java.util.Optional;

/**
 * Pluggable cache for loaded maps. Implement to back the cache with
 * IndexedDB, a key-value store, disk, or any other storage.
 */
public interface MapCache {
    /** Returns the cached map for {@code key}, or empty. */
    Optional<TokenizerMap> get(String key);

    /** Stores {@code map} under {@code key}. */
    void set(String key, TokenizerMap map);
}
