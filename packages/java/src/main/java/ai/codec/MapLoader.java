// SPDX-License-Identifier: MIT
package ai.codec;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * Fetch, verify, and cache tokenizer maps.
 *
 * <p>Maps are content-addressed: the URL is untrusted and the sha256 hash
 * is the trust anchor. Cache hits skip the network entirely.
 */
public final class MapLoader {
    private MapLoader() {}

    private static final MapCache DEFAULT_CACHE = new InMemoryMapCache();
    private static final HttpClient DEFAULT_HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(30))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    /** Synchronously fetch, verify, and cache a tokenizer map. Cache hits skip the network. */
    public static TokenizerMap load(LoadOptions opts) {
        try {
            return loadAsync(opts).get();
        } catch (Exception e) {
            Throwable c = e.getCause() != null ? e.getCause() : e;
            if (c instanceof TokenizerMapHashMismatchException tm) throw tm;
            if (c instanceof TokenizerMapValidationException tv) throw tv;
            if (c instanceof RuntimeException re) throw re;
            throw new RuntimeException(c);
        }
    }

    /** Asynchronously fetch, verify, and cache a tokenizer map. */
    public static CompletableFuture<TokenizerMap> loadAsync(LoadOptions opts) {
        MapCache cache = opts.cache() != null ? opts.cache() : DEFAULT_CACHE;
        HttpClient http = opts.http() != null ? opts.http() : DEFAULT_HTTP;
        String cacheKey = opts.cacheKey() != null
                ? opts.cacheKey()
                : (opts.url() + "#" + (opts.hash() != null ? opts.hash() : ""));

        Optional<TokenizerMap> cached = cache.get(cacheKey);
        if (cached.isPresent()) {
            return CompletableFuture.completedFuture(cached.get());
        }

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(opts.url()))
                .header("Accept", "application/json")
                // gzip is the only encoding the JDK HttpClient handles transparently
                // when set explicitly via response decoder. We let the server pick.
                .header("Accept-Encoding", "gzip")
                .GET()
                .build();

        return http.sendAsync(req, HttpResponse.BodyHandlers.ofByteArray())
                .thenApply(resp -> {
                    int code = resp.statusCode();
                    if (code < 200 || code >= 300)
                        throw new RuntimeException("MapLoader: HTTP " + code + " from " + opts.url());

                    byte[] bytes = decodeBody(resp);

                    if (opts.hash() != null) {
                        String expected = parseHash(opts.hash());
                        String actual = sha256Hex(bytes);
                        if (!expected.equalsIgnoreCase(actual))
                            throw new TokenizerMapHashMismatchException(expected, actual);
                    }

                    TokenizerMap map = TokenizerMap.fromJson(bytes);
                    cache.set(cacheKey, map);
                    return map;
                });
    }

    /** Decode response body honoring optional gzip Content-Encoding. */
    private static byte[] decodeBody(HttpResponse<byte[]> resp) {
        Optional<String> enc = resp.headers().firstValue("content-encoding");
        byte[] body = resp.body();
        if (enc.isEmpty()) return body;
        String e = enc.get().toLowerCase(Locale.ROOT);
        if (e.equals("gzip")) {
            try (java.util.zip.GZIPInputStream gz = new java.util.zip.GZIPInputStream(new java.io.ByteArrayInputStream(body));
                 java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
                byte[] tmp = new byte[8 * 1024];
                int n;
                while ((n = gz.read(tmp)) > 0) out.write(tmp, 0, n);
                return out.toByteArray();
            } catch (IOException ioe) {
                throw new RuntimeException("MapLoader: gzip decode failed: " + ioe.getMessage(), ioe);
            }
        }
        // Other encodings (br, zstd, deflate) are not handled by the JDK HttpClient;
        // we don't request them above.
        return body;
    }

    static String sha256Hex(byte[] bytes) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(bytes);
            StringBuilder sb = new StringBuilder(64);
            for (byte b : hash) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 unavailable", e);
        }
    }

    static String parseHash(String hash) {
        int colon = hash.indexOf(':');
        if (colon < 0) return hash.toLowerCase(Locale.ROOT);
        String algo = hash.substring(0, colon).toLowerCase(Locale.ROOT);
        if (!algo.equals("sha256"))
            throw new UnsupportedOperationException("Unsupported hash algorithm: " + algo + " (only sha256 supported)");
        return hash.substring(colon + 1).toLowerCase(Locale.ROOT);
    }
}
