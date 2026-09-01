// SPDX-License-Identifier: MIT
package ai.codec;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;

/**
 * Client-side helpers for the Codec compression contract.
 *
 * <p>Pairs with the server-side {@code codec_compression} modules in
 * sglang/vLLM: the server emits {@code Codec-Zstd-Dict: sha256:<hex>} on
 * every zstd response, the client validates that header against locally-
 * loaded dicts before decompressing. See
 * {@code spec/PROTOCOL.md} "Codec-Zstd-Dict response header" for the
 * full contract.
 *
 * <p>The actual zstd decompression is intentionally out of scope here:
 * the JDK's {@code java.net.http.HttpClient} doesn't auto-decompress
 * anything, and zstd needs the optional {@code com.github.luben:zstd-jni}
 * dependency, and either way the caller usually already has its own
 * HTTP plumbing. This class just gives you the small piece that's
 * specific to Codec: matching a response's declared dict hash to the
 * dict you've loaded.
 *
 * <p>Java twin of {@code codecai.compression} (Python),
 * {@code @codecai/web}'s {@code compression.ts}, and
 * {@code Codec.Compression} (.NET): same API shape, same error class.
 */
public final class Compression {
    private Compression() {}

    /**
     * Compute the canonical {@code Codec-Zstd-Dict} hash for
     * {@code dictBytes}.
     *
     * <p>Returns {@code sha256:<lowercase hex>}: same shape as the
     * server-side header value and the {@code hash} field in
     * tokenizer-map {@code zstd_dictionaries[]} entries.
     */
    public static String hashZstdDict(byte[] dictBytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(dictBytes);
            return "sha256:" + HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is required by every JVM; this can't happen.
            throw new IllegalStateException(e);
        }
    }

    /**
     * Pick the zstd dict to decompress this response with.
     *
     * <p>Headers are looked up case-insensitively (HTTP headers are not
     * case-sensitive: {@code HttpHeaders} is, plain {@code Map<String,
     * String>} isn't. We normalise here as a result).
     *
     * @param responseHeaders header map from the HTTP response. May use
     *     any casing for keys.
     * @param loadedDicts {@code {sha256_hash: dict_bytes}}: the dicts
     *     the client has loaded locally. Hashes follow the same
     *     {@code sha256:<hex>} format the server emits.
     * @return the matching dict's bytes when the response is
     *     {@code Content-Encoding: zstd} and the server's
     *     {@code Codec-Zstd-Dict} header points at a loaded dict; or
     *     {@code null} when the response isn't zstd (caller should pass
     *     through identity / let the HTTP stack handle other encodings).
     * @throws CodecZstdDictError when the response is zstd but:
     *     <ul>
     *       <li>the {@code Codec-Zstd-Dict} header is missing (per spec,
     *           the server MUST emit it on every zstd response)</li>
     *       <li>the header names a hash we haven't loaded: caller
     *           should fetch the dict from the tokenizer map's
     *           {@code zstd_dictionaries[]} entry whose {@code hash}
     *           matches, or retry the request with
     *           {@code Accept-Encoding: gzip} to downgrade to a no-dict
     *           path</li>
     *       <li>the header is malformed (not {@code sha256:<hex>})</li>
     *     </ul>
     */
    public static byte[] selectZstdDictForResponse(
            Map<String, String> responseHeaders,
            Map<String, byte[]> loadedDicts) {
        String enc = header(responseHeaders, "content-encoding");
        if (enc == null || !"zstd".equals(enc.strip().toLowerCase(Locale.ROOT))) {
            return null; // caller's HTTP stack handles gzip/br/identity
        }

        String declared = header(responseHeaders, "codec-zstd-dict");
        if (declared == null || declared.isEmpty()) {
            throw new CodecZstdDictError(
                    "Response is Content-Encoding: zstd but no Codec-Zstd-Dict "
                            + "header was present. Per spec/PROTOCOL.md the server MUST "
                            + "name the dict it used. Refusing to guess.");
        }

        declared = declared.strip();
        if (!declared.startsWith("sha256:") || declared.length() != "sha256:".length() + 64) {
            throw new CodecZstdDictError(
                    "Malformed Codec-Zstd-Dict value: \"" + declared + "\". "
                            + "Expected 'sha256:<64 hex chars>'.");
        }

        byte[] dict = loadedDicts.get(declared);
        if (dict == null) {
            throw new CodecZstdDictError(
                    "Server used zstd dict " + declared + " but it isn't loaded "
                            + "locally. Fetch it from the tokenizer map's "
                            + "zstd_dictionaries[] entry (the entry whose hash matches), "
                            + "or send Accept-Encoding: gzip to downgrade.");
        }
        return dict;
    }

    /**
     * Case-insensitive header lookup. {@code java.net.http.HttpHeaders}
     * is already case-insensitive, but plain {@code Map<String, String>}
     * isn't: this normalises for callers that pass a plain map.
     */
    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        String v = headers.get(name);
        if (v != null) return v;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) {
                return e.getValue();
            }
        }
        return null;
    }
}
