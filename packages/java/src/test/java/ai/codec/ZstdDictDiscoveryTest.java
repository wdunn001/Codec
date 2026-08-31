// SPDX-License-Identifier: MIT
package ai.codec;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * URL-builder + hash-validation tests for the v0.5 discoverable zstd
 * dictionary surface. Mirrors the Python, TypeScript, Rust, and .NET
 * test suites: same input vectors so cross-client parity is auditable.
 *
 * <p>Per the existing convention (see {@link MapLoaderTests}), network
 * round-trips are not exercised here; the cross-stack bench cohort is
 * where real-server interop gets covered.
 */
class ZstdDictDiscoveryTest {
    private static String repeat(char c, int n) {
        char[] arr = new char[n];
        java.util.Arrays.fill(arr, c);
        return new String(arr);
    }

    @Test
    void wellKnownDictUrlStripsSha256Prefix() {
        String h = repeat('a', 64);
        assertEquals(
                "https://codec.example/.well-known/codec/dicts/" + h + ".zstd",
                ZstdDictDiscovery.wellKnownDictUrl("https://codec.example", "sha256:" + h));
    }

    @Test
    void wellKnownDictUrlAcceptsBareHex() {
        String h = repeat('b', 64);
        assertEquals(
                "https://codec.example/.well-known/codec/dicts/" + h + ".zstd",
                ZstdDictDiscovery.wellKnownDictUrl("https://codec.example", h));
    }

    @Test
    void wellKnownDictUrlStripsTrailingSlash() {
        String h = repeat('c', 64);
        assertEquals(
                "https://codec.example/.well-known/codec/dicts/" + h + ".zstd",
                ZstdDictDiscovery.wellKnownDictUrl("https://codec.example/", h));
    }

    @Test
    void wellKnownDictUrlNormalisesUppercaseHex() {
        String upper = repeat('D', 64);
        String expected = repeat('d', 64);
        assertEquals(
                "https://codec.example/.well-known/codec/dicts/" + expected + ".zstd",
                ZstdDictDiscovery.wellKnownDictUrl("https://codec.example", upper));
    }

    @Test
    void wellKnownDictUrlRejectsShortHash() {
        assertThrows(
                ZstdDictDiscoveryException.class,
                () -> ZstdDictDiscovery.wellKnownDictUrl("https://codec.example", "deadbeef"));
    }

    @Test
    void wellKnownDictUrlRejectsWrongAlgorithm() {
        assertThrows(
                ZstdDictDiscoveryException.class,
                () -> ZstdDictDiscovery.wellKnownDictUrl(
                        "https://codec.example", "md5:" + repeat('a', 32)));
    }

    @Test
    void wellKnownDictUrlRejectsNonHexChars() {
        assertThrows(
                ZstdDictDiscoveryException.class,
                () -> ZstdDictDiscovery.wellKnownDictUrl("https://codec.example", repeat('z', 64)));
    }
}
