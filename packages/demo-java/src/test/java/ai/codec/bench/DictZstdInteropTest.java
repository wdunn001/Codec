// SPDX-License-Identifier: MIT
package ai.codec.bench;

import ai.codec.CodecFrame;
import ai.codec.Compression;
import ai.codec.StreamDecoder;
import com.github.luben.zstd.ZstdDictDecompress;
import com.github.luben.zstd.ZstdInputStream;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * End-to-end check of the dict-zstd path on the shared interop fixture.
 *
 * <p>Mirrors the equivalent test in demo-python / demo-dotnet / demo-rust:
 * load {@code dict.bin}, register it under its sha256, decompress
 * {@code compressed.bin} with that dict, assert the output is byte-
 * identical to {@code decompressed.bin}, msgpack-parse it, and assert
 * the token-ID sequence matches the manifest.
 *
 * <p>This is the test that catches a regression where the bench reverts
 * to bare {@code new ZstdInputStream(...)} (no dict): wrong-dict
 * decompression succeeds at the zstd layer but produces garbage bytes
 * that msgpack-parsing then misinterprets.
 */
class DictZstdInteropTest {

    private static final String EXPECTED_DICT_HASH =
            "sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db";

    private static final int[] EXPECTED_FIRST_10_IDS = {
            53365, 1593, 7552, 57218, 5371, 37, 11278, 43, 9909, 2773
    };

    private static final int EXPECTED_TOKEN_COUNT = 32;

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

    private static byte[] readAll(InputStream is) throws Exception {
        try (is) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] tmp = new byte[8192];
            int r;
            while ((r = is.read(tmp)) != -1) out.write(tmp, 0, r);
            return out.toByteArray();
        }
    }

    @Test
    void decompressedBytesAreByteIdentical_andMsgpackTokensMatch() throws Exception {
        Path dir = fixtureDir();
        byte[] dict = Files.readAllBytes(dir.resolve("dict.bin"));
        byte[] compressed = Files.readAllBytes(dir.resolve("compressed.bin"));
        byte[] expectedDecompressed = Files.readAllBytes(dir.resolve("decompressed.bin"));

        // 1. Hash matches the manifest: same digest every Codec client computes.
        assertEquals(EXPECTED_DICT_HASH, Compression.hashZstdDict(dict));

        // 2. selectZstdDictForResponse picks our dict for the canned headers.
        Map<String, byte[]> registry = new HashMap<>();
        registry.put(EXPECTED_DICT_HASH, dict);

        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Encoding", "zstd");
        headers.put("Codec-Zstd-Dict", EXPECTED_DICT_HASH);

        byte[] picked = Compression.selectZstdDictForResponse(headers, registry);
        assertNotNull(picked, "dict must be selected when both headers point at a loaded dict");
        assertArrayEquals(dict, picked);

        // 3. Stream-decompress with that dict via zstd-jni's
        //    ZstdDictDecompress + ZstdInputStream.setDict(...): same path
        //    MatrixRun.decodeZstd uses for real responses.
        byte[] decompressed;
        try (ZstdDictDecompress parsed = new ZstdDictDecompress(picked)) {
            ZstdInputStream zis = new ZstdInputStream(new ByteArrayInputStream(compressed));
            zis.setDict(parsed);
            decompressed = readAll(zis);
        }
        assertArrayEquals(expectedDecompressed, decompressed,
                "decompressed bytes must be byte-identical to the fixture's decompressed.bin");

        // 4. Msgpack-parse and check the token-ID sequence matches the manifest.
        List<Integer> ids = new ArrayList<>();
        Iterator<CodecFrame> it =
                StreamDecoder.decodeMsgpackStream(new ByteArrayInputStream(decompressed));
        while (it.hasNext()) {
            for (int id : it.next().ids()) ids.add(id);
        }
        assertEquals(EXPECTED_TOKEN_COUNT, ids.size(),
                "expected " + EXPECTED_TOKEN_COUNT + " token IDs from msgpack-parsed frames");
        for (int i = 0; i < EXPECTED_FIRST_10_IDS.length; i++) {
            assertEquals(EXPECTED_FIRST_10_IDS[i], (int) ids.get(i),
                    "token id at index " + i + " must match manifest");
        }
    }

    @Test
    void matrixRunDictRegistry_loadsReferenceDicts() {
        // Smoke test for MatrixRun.loadZstdDictFiles: feed it the
        // interop fixture's dict.bin and assert it lands in the registry
        // under the expected hash.
        Path dictPath = fixtureDir().resolve("dict.bin");
        MatrixRun.ZSTD_DICTS.clear();
        MatrixRun.loadZstdDictFiles(dictPath.toString());
        assertEquals(1, MatrixRun.ZSTD_DICTS.size());
        assertNotNull(MatrixRun.ZSTD_DICTS.get(EXPECTED_DICT_HASH));
    }
}
