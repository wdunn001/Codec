// SPDX-License-Identifier: MIT
package ai.codec;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

/**
 * MapLoader integration tests. Spins up a local HttpServer to serve
 * synthetic JSON, exercising the sha256 verify path.
 */
class MapLoaderTests {
    private HttpServer server;
    private int port;

    private static final String SAMPLE_JSON = "{\n"
            + "  \"id\": \"test/sample\",\n"
            + "  \"version\": \"2\",\n"
            + "  \"vocab_size\": 4,\n"
            + "  \"vocab\": { \"a\": 0, \"b\": 1 },\n"
            + "  \"encoder\": \"byte_level\"\n"
            + "}\n";

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        port = server.getAddress().getPort();
        server.createContext("/map.json", exchange -> {
            byte[] body = SAMPLE_JSON.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });
        server.start();
    }

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    @Test
    void loadsAndCachesMap() {
        String url = "http://127.0.0.1:" + port + "/map.json";
        TokenizerMap m = MapLoader.load(LoadOptions.builder()
                .url(url)
                .http(HttpClient.newHttpClient())
                .cache(new InMemoryMapCache())
                .build());
        assertEquals("test/sample", m.id);
        assertEquals(4, m.vocabSize);
    }

    @Test
    void verifyHashSucceedsForCorrectDigest() {
        String url = "http://127.0.0.1:" + port + "/map.json";
        String expected = MapLoader.sha256Hex(SAMPLE_JSON.getBytes(StandardCharsets.UTF_8));
        TokenizerMap m = MapLoader.load(LoadOptions.builder()
                .url(url)
                .hash("sha256:" + expected)
                .http(HttpClient.newHttpClient())
                .cache(new InMemoryMapCache())
                .build());
        assertEquals("test/sample", m.id);
    }

    @Test
    void verifyHashThrowsOnMismatch() {
        String url = "http://127.0.0.1:" + port + "/map.json";
        // Deliberately wrong hash: 64 zero hex chars.
        String wrong = "0000000000000000000000000000000000000000000000000000000000000000";
        assertThrows(TokenizerMapHashMismatchException.class, () ->
                MapLoader.load(LoadOptions.builder()
                        .url(url)
                        .hash("sha256:" + wrong)
                        .http(HttpClient.newHttpClient())
                        .cache(new InMemoryMapCache())
                        .build()));
    }

    @Test
    void cacheHitSkipsNetwork() throws Exception {
        // Stop the server, then serve from a pre-populated cache.
        InMemoryMapCache cache = new InMemoryMapCache();
        TokenizerMap fixture = TokenizerMap.fromJson(SAMPLE_JSON);
        cache.set("preloaded#", fixture);

        // Now stop the server so any network attempt would fail.
        server.stop(0);
        server = null;

        TokenizerMap m = MapLoader.load(LoadOptions.builder()
                .url("http://localhost:1/does-not-exist")
                .cache(cache)
                .cacheKey("preloaded#")
                .build());
        assertEquals("test/sample", m.id);
    }

    @Test
    void verifySha256UtilityMatches() {
        byte[] data = "hello".getBytes(StandardCharsets.UTF_8);
        String expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assertEquals(expected, MapLoader.sha256Hex(data));
        TokenizerMap.verifySha256(data, "sha256:" + expected);
        assertThrows(TokenizerMapHashMismatchException.class,
                () -> TokenizerMap.verifySha256(data,
                        "sha256:0000000000000000000000000000000000000000000000000000000000000000"));
    }
}
