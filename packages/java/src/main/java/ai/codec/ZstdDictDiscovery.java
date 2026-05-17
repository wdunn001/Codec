// SPDX-License-Identifier: MIT
package ai.codec;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;

/**
 * Discoverable zstd dictionary surface (v0.5+).
 *
 * <p>Spec: {@code spec/WELL_KNOWN_DISCOVERY.md § "Zstd dictionaries (v0.5+)"}.
 *
 * <p>Java twin of {@code codecai.discover_zstd_dict} (Python),
 * {@code @codecai/web#discoverZstdDict} (TypeScript),
 * {@code codec_rs::discover_zstd_dict} (Rust), and
 * {@code Codec.ZstdDictDiscovery.DiscoverAsync} (.NET).
 *
 * <p>The discovery surface is hard-fail by design — silent fallback to
 * identity bytes was the v0.4.1 sglang COPY-dicts regression class this
 * surface eliminates.
 */
public final class ZstdDictDiscovery {
    private ZstdDictDiscovery() {}

    /** Fixed base path under which Codec dict documents live. */
    public static final String DICTS_WELL_KNOWN_BASE = "/.well-known/codec/dicts";

    private static final Pattern DICT_HASH_RE = Pattern.compile("^[0-9a-f]{64}$");

    /**
     * Per-dict document URL for an origin + sha256 hash (v0.5+).
     *
     * <p>Accepts either {@code sha256:<hex>} or bare {@code <hex>}.
     * Returns {@code <origin>/.well-known/codec/dicts/<sha256-hex>.zstd}.
     *
     * @throws ZstdDictDiscoveryException when the hash input is not the
     *     expected 64-hex-char sha256 form.
     */
    public static String wellKnownDictUrl(String origin, String hash) {
        String hex = parseDictHash(hash);
        return stripTrailingSlash(origin) + DICTS_WELL_KNOWN_BASE + "/" + hex + ".zstd";
    }

    /**
     * Synchronously resolve a zstd dictionary via
     * {@code .well-known/codec/dicts/<hex>.zstd} (v0.5+).
     *
     * <p>Fetches the bytes, verifies they hash to the URL's path
     * component, returns the raw dict bytes ready to feed into a zstd
     * decoder (e.g. {@code com.github.luben.zstd.ZstdDictDecompress}).
     *
     * @param origin HTTPS origin serving the dict (e.g. {@code https://codec.example}).
     * @param hash SHA-256 hash, as {@code sha256:<hex>} or bare {@code <hex>}.
     * @throws ZstdDictDiscoveryException on 404 from origin or malformed
     *     hash input (caught before any HTTP request).
     * @throws ZstdDictHashMismatchException when origin served bytes
     *     that don't hash to the URL's path component.
     */
    public static byte[] discover(String origin, String hash) {
        return discover(origin, hash, defaultHttp());
    }

    /** {@link #discover(String, String)} with a caller-supplied {@link HttpClient}. */
    public static byte[] discover(String origin, String hash, HttpClient http) {
        String expected = parseDictHash(hash);
        String url = wellKnownDictUrl(origin, hash);
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                .GET()
                .timeout(Duration.ofSeconds(30))
                .build();
        try {
            HttpResponse<byte[]> resp = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
            return verifyOrThrow(resp.statusCode(), resp.body(), url, expected);
        } catch (java.io.IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new ZstdDictDiscoveryException(
                    "HTTP error fetching " + url + ": " + e.getMessage(), url);
        }
    }

    /** Async variant of {@link #discover(String, String, HttpClient)}. */
    public static CompletableFuture<byte[]> discoverAsync(
            String origin, String hash, HttpClient http) {
        String expected;
        String url;
        try {
            expected = parseDictHash(hash);
            url = wellKnownDictUrl(origin, hash);
        } catch (ZstdDictDiscoveryException e) {
            return CompletableFuture.failedFuture(e);
        }
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                .GET()
                .timeout(Duration.ofSeconds(30))
                .build();
        return http.sendAsync(req, HttpResponse.BodyHandlers.ofByteArray())
                .thenApply(resp -> verifyOrThrow(resp.statusCode(), resp.body(), url, expected));
    }

    private static byte[] verifyOrThrow(int status, byte[] body, String url, String expected) {
        if (status == 404) {
            throw new ZstdDictDiscoveryException.NotFound(url, status);
        }
        if (status < 200 || status >= 300) {
            throw new ZstdDictDiscoveryException(
                    "Failed to fetch " + url + ": HTTP " + status, url);
        }
        String actual = sha256HexBytes(body);
        if (!actual.equals(expected)) {
            throw new ZstdDictHashMismatchException(url, expected, actual);
        }
        return body;
    }

    private static String parseDictHash(String hash) {
        String s = hash.trim();
        if (s.startsWith("sha256:")) s = s.substring("sha256:".length());
        s = s.toLowerCase(Locale.ROOT);
        if (!DICT_HASH_RE.matcher(s).matches()) {
            throw new ZstdDictDiscoveryException(
                    "Invalid dict hash '" + hash + "': expected 'sha256:<64 hex>' or '<64 hex>'");
        }
        return s;
    }

    private static String sha256HexBytes(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    private static HttpClient defaultHttp() {
        return HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }
}
