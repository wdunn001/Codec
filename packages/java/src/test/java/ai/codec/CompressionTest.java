// SPDX-License-Identifier: MIT
package ai.codec;

import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Parity tests for the dict-zstd contract. Mirrors the Python suite in
 * {@code packages/python/tests/test_compression.py}, the TS suite in
 * {@code packages/web/test/compression.test.ts}, and the .NET suite.
 *
 * <p>Fixture is {@code packages/bench/fixtures/dict-zstd-interop/} — the
 * cross-client interop reference: every Codec client must agree on the
 * hash of {@code dict.bin} and select it for the canned headers.
 */
class CompressionTest {

    private static final String EXPECTED_DICT_HASH =
            "sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db";

    /** Locate the shared interop fixture; tests run from packages/java/. */
    private static Path fixtureDir() {
        String[] candidates = {
                "../bench/fixtures/dict-zstd-interop",
                "packages/bench/fixtures/dict-zstd-interop",
                System.getProperty("user.dir") + "/../bench/fixtures/dict-zstd-interop",
                "/mnt/h/dev/Project Codec/Codec/packages/bench/fixtures/dict-zstd-interop",
        };
        for (String c : candidates) {
            File f = new File(c);
            if (f.isDirectory()) return f.toPath().toAbsolutePath().normalize();
        }
        throw new IllegalStateException(
                "Couldn't locate packages/bench/fixtures/dict-zstd-interop relative to "
                        + Paths.get(".").toAbsolutePath());
    }

    private static byte[] loadDictBin() throws Exception {
        return Files.readAllBytes(fixtureDir().resolve("dict.bin"));
    }

    // ── hashZstdDict ────────────────────────────────────────────────────────

    @Test
    void hashZstdDict_matchesInteropFixture() throws Exception {
        byte[] dict = loadDictBin();
        String h = Compression.hashZstdDict(dict);
        assertEquals(EXPECTED_DICT_HASH, h,
                "dict.bin hash must match the interop manifest — every Codec "
                        + "client computes the same digest for this byte sequence");
    }

    @Test
    void hashZstdDict_emptyInput_returnsKnownSha256() {
        // sha256("") is well-known — sanity check that we're not off-by-one
        // on the encoding format.
        String h = Compression.hashZstdDict(new byte[0]);
        assertEquals(
                "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                h);
    }

    @Test
    void hashZstdDict_lowercaseHex() {
        // The spec says "lowercase hex". Make sure we never emit uppercase
        // — a server validating the inbound header against ours must match.
        String h = Compression.hashZstdDict(new byte[]{1, 2, 3, 4});
        assertTrue(h.startsWith("sha256:"), "must have sha256: prefix");
        String hex = h.substring("sha256:".length());
        assertEquals(64, hex.length(), "sha256 hex is 64 chars");
        assertEquals(hex.toLowerCase(), hex, "hex must be lowercase");
    }

    // ── selectZstdDictForResponse ───────────────────────────────────────────

    @Test
    void select_returnsDict_whenBothHeadersPresentAndLoaded() throws Exception {
        byte[] dict = loadDictBin();
        Map<String, byte[]> loaded = new HashMap<>();
        loaded.put(EXPECTED_DICT_HASH, dict);

        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Encoding", "zstd");
        headers.put("Codec-Zstd-Dict", EXPECTED_DICT_HASH);

        byte[] result = Compression.selectZstdDictForResponse(headers, loaded);
        assertNotNull(result);
        assertArrayEquals(dict, result);
    }

    @Test
    void select_caseInsensitiveHeaders() throws Exception {
        byte[] dict = loadDictBin();
        Map<String, byte[]> loaded = new HashMap<>();
        loaded.put(EXPECTED_DICT_HASH, dict);

        // HTTP headers are case-insensitive — caller might pass any casing.
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("content-encoding", "ZSTD");
        headers.put("codec-zstd-dict", EXPECTED_DICT_HASH);

        byte[] result = Compression.selectZstdDictForResponse(headers, loaded);
        assertArrayEquals(dict, result);
    }

    @Test
    void select_returnsNull_whenNotZstd() {
        Map<String, byte[]> loaded = new HashMap<>();
        Map<String, String> headers = new LinkedHashMap<>();

        // identity (no header)
        assertNull(Compression.selectZstdDictForResponse(headers, loaded));

        // gzip
        headers.put("Content-Encoding", "gzip");
        assertNull(Compression.selectZstdDictForResponse(headers, loaded));

        // brotli
        headers.put("Content-Encoding", "br");
        assertNull(Compression.selectZstdDictForResponse(headers, loaded));
    }

    @Test
    void select_throws_whenZstdButNoDictHeader() {
        Map<String, byte[]> loaded = new HashMap<>();
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Encoding", "zstd");
        // no Codec-Zstd-Dict — server protocol error per spec
        CodecZstdDictError ex = assertThrows(CodecZstdDictError.class,
                () -> Compression.selectZstdDictForResponse(headers, loaded));
        assertTrue(ex.getMessage().contains("Codec-Zstd-Dict"));
    }

    @Test
    void select_throws_whenHeaderMalformed() {
        Map<String, byte[]> loaded = new HashMap<>();
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Encoding", "zstd");

        // wrong prefix
        headers.put("Codec-Zstd-Dict", "md5:abc123");
        assertThrows(CodecZstdDictError.class,
                () -> Compression.selectZstdDictForResponse(headers, loaded));

        // wrong hex length
        headers.put("Codec-Zstd-Dict", "sha256:deadbeef");
        assertThrows(CodecZstdDictError.class,
                () -> Compression.selectZstdDictForResponse(headers, loaded));

        // missing colon
        headers.put("Codec-Zstd-Dict",
                "sha256" + "29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db");
        assertThrows(CodecZstdDictError.class,
                () -> Compression.selectZstdDictForResponse(headers, loaded));
    }

    @Test
    void select_throws_whenHashNotLoaded() {
        Map<String, byte[]> loaded = new HashMap<>(); // empty registry
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Encoding", "zstd");
        headers.put("Codec-Zstd-Dict", EXPECTED_DICT_HASH);

        CodecZstdDictError ex = assertThrows(CodecZstdDictError.class,
                () -> Compression.selectZstdDictForResponse(headers, loaded));
        assertTrue(ex.getMessage().contains(EXPECTED_DICT_HASH),
                "error must name the missing hash so caller can fetch it");
    }
}
