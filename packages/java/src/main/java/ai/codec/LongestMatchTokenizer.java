// SPDX-License-Identifier: MIT
package ai.codec;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Vocab-only longest-prefix-match tokenizer. Walks input left-to-right,
 * emitting the ID of the longest vocab fragment that matches at each
 * position. Suitable for canonical-IR / synthetic test maps. NOT
 * BPE-correct for real model vocabs: use {@link BPETokenizer} for those.
 */
public final class LongestMatchTokenizer implements ITokenizer {
    private final String id;
    private final Map<String, Integer> fragmentToId = new HashMap<>();
    private final int maxFragmentLength;
    private final Map<String, Integer> specialFragmentToId = new HashMap<>();

    public LongestMatchTokenizer(TokenizerMap map) {
        this.id = map.id;
        int maxLen = 1;

        if (map.vocab != null) {
            for (Map.Entry<String, Integer> e : map.vocab.entrySet()) {
                String fragment = e.getKey();
                if (fragment == null || fragment.isEmpty()) continue;
                fragmentToId.put(fragment, e.getValue());
                if (fragment.length() > maxLen) maxLen = fragment.length();
            }
        }
        if (map.tokens != null) {
            for (Map.Entry<String, String> e : map.tokens.entrySet()) {
                String fragment = e.getValue();
                if (fragment == null || fragment.isEmpty()) continue;
                int parsedId;
                try { parsedId = Integer.parseInt(e.getKey()); }
                catch (NumberFormatException ex) { continue; }
                fragmentToId.put(fragment, parsedId);
                if (fragment.length() > maxLen) maxLen = fragment.length();
            }
        }
        this.maxFragmentLength = maxLen;

        if (map.specialTokens != null) {
            for (Map.Entry<String, Integer> e : map.specialTokens.entrySet()) {
                String name = e.getKey();
                int v = e.getValue();
                specialFragmentToId.put(name, v);
                if (!name.startsWith("<"))
                    specialFragmentToId.put("<|" + name + "|>", v);
            }
        }
    }

    @Override public String getId() { return id; }

    @Override
    public int[] encode(String text) {
        List<Integer> output = new ArrayList<>();
        int pos = 0;
        int n = text.length();

        while (pos < n) {
            // Specials win.
            boolean consumed = false;
            for (Map.Entry<String, Integer> e : specialFragmentToId.entrySet()) {
                String frag = e.getKey();
                if (text.regionMatches(pos, frag, 0, frag.length())) {
                    output.add(e.getValue());
                    pos += frag.length();
                    consumed = true;
                    break;
                }
            }
            if (consumed) continue;

            int remaining = n - pos;
            int tryUpTo = Math.min(maxFragmentLength, remaining);
            int matchedId = -1;
            int matchedLen = 0;
            for (int len = tryUpTo; len >= 1; len--) {
                String candidate = text.substring(pos, pos + len);
                Integer id = fragmentToId.get(candidate);
                if (id != null) {
                    matchedId = id;
                    matchedLen = len;
                    break;
                }
            }

            if (matchedId == -1) {
                output.add(0); // UNK
                pos += 1;
            } else {
                output.add(matchedId);
                pos += matchedLen;
            }
        }
        int[] arr = new int[output.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = output.get(i);
        return arr;
    }
}
