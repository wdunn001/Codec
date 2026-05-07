// SPDX-License-Identifier: MIT
package ai.codec;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/** Default in-memory {@link MapCache}. Thread-safe via synchronized access. */
public final class InMemoryMapCache implements MapCache {
    private final Map<String, TokenizerMap> store = new HashMap<>();

    @Override
    public synchronized Optional<TokenizerMap> get(String key) {
        return Optional.ofNullable(store.get(key));
    }

    @Override
    public synchronized void set(String key, TokenizerMap map) {
        store.put(key, map);
    }
}
