// SPDX-License-Identifier: MIT
//
// SCHEMA-v1 matrix runner for the Java client. Mirrors:
//   packages/demo-python/src/codec_demo/matrix_run.py
//   packages/demo/src/matrix_run.ts
//   packages/demo-dotnet/Program.cs (matrix mode)
//   packages/demo-rust/src/matrix_run.rs
//
// Reads a methodology JSON written by capture_methodology.py and emits
// a SCHEMA-v1 result JSON. JDK HttpClient doesn't auto-decompress, so
// wire bytes are exactly what's off the socket: no special config
// needed. Decompression is best-effort for token counting and never
// overrides wire/TTFB on failure (e.g. zstd dict mismatch when no
// matching dict is loaded client-side).

package ai.codec.bench;

import ai.codec.CodecFrame;
import ai.codec.CodecZstdDictError;
import ai.codec.Compression;
import ai.codec.StreamDecoder;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.github.luben.zstd.ZstdDictDecompress;
import com.github.luben.zstd.ZstdInputStream;
import org.brotli.dec.BrotliInputStream;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.GZIPInputStream;

public final class MatrixRun {

    private static final String[][] PATHS = {
            { "JSON-SSE (default)", "json" },
            { "Codec msgpack",      "msgpack" },
            { "Codec protobuf",     "protobuf" },
    };
    private static final String[] ENCODINGS = { "identity", "gzip", "br", "zstd" };

    /**
     * Hash → raw dict bytes for any zstd dict the bench has loaded
     * locally. Keys MUST follow the canonical {@code sha256:<hex>} shape
     * the server emits in the {@code Codec-Zstd-Dict} response header.
     * Populated by {@link #loadZstdDictFiles(String...)} at bench
     * startup with the reference dicts from {@code dictionaries/}.
     */
    static final Map<String, byte[]> ZSTD_DICTS = new ConcurrentHashMap<>();

    /**
     * Load each dict file into {@link #ZSTD_DICTS}, keyed by its sha256.
     * Missing files are silently skipped: the bench then decompresses
     * successfully only on cells whose {@code Codec-Zstd-Dict} header
     * matches a hash we have. Called from {@link #run(MatrixArgs)} before
     * the matrix loop begins.
     *
     * <p>Mirrors {@code codec_demo.load_zstd_dict_files} in
     * packages/demo-python.
     */
    static void loadZstdDictFiles(String... paths) {
        for (String p : paths) {
            if (p == null || p.isEmpty()) continue;
            Path path = Paths.get(p);
            if (!Files.isRegularFile(path)) continue;
            try {
                byte[] bytes = Files.readAllBytes(path);
                ZSTD_DICTS.put(Compression.hashZstdDict(bytes), bytes);
            } catch (Exception e) {
                // Best-effort: a missing/unreadable dict just means the
                // matching zstd cell will report dict-not-loaded.
                System.err.println("loadZstdDictFiles: skipping " + p + ": "
                        + e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }
    }

    static final class MatrixArgs {
        String methodology;
        String out;
        int[] sizes = new int[] { 64, 512, 2048 };
        int reps = 2;
    }

    /** Parse SCHEMA-v1 matrix args. Returns null if --methodology is missing
     *  (caller should fall back to legacy mode). */
    public static MatrixArgs parseMatrixArgs(String[] argv) {
        MatrixArgs a = new MatrixArgs();
        List<Integer> sizes = new ArrayList<>();
        for (int i = 0; i < argv.length; i++) {
            switch (argv[i]) {
                case "--methodology" -> a.methodology = argv[++i];
                case "--out"         -> a.out         = argv[++i];
                case "--reps"        -> a.reps        = Integer.parseInt(argv[++i]);
                case "--sizes"       -> {
                    while (i + 1 < argv.length) {
                        try { sizes.add(Integer.parseInt(argv[i + 1])); i++; }
                        catch (NumberFormatException nfe) { break; }
                    }
                }
                default -> { /* ignore: legacy mode owns the rest */ }
            }
        }
        if (a.methodology == null || a.out == null) return null;
        if (!sizes.isEmpty()) a.sizes = sizes.stream().mapToInt(Integer::intValue).toArray();
        return a;
    }

    static String sh(String... cmd) {
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
            Process p = pb.start();
            byte[] out = p.getInputStream().readAllBytes();
            p.waitFor();
            return new String(out, StandardCharsets.UTF_8).strip();
        } catch (Exception e) { return ""; }
    }

    static double median(List<Double> xs) {
        if (xs.isEmpty()) return Double.NaN;
        List<Double> s = new ArrayList<>(xs);
        s.sort(Double::compareTo);
        int m = s.size() / 2;
        return s.size() % 2 == 1 ? s.get(m) : (s.get(m - 1) + s.get(m)) / 2.0;
    }

    static int medianInt(List<Integer> xs) {
        if (xs.isEmpty()) return 0;
        List<Integer> s = new ArrayList<>(xs);
        s.sort(Integer::compareTo);
        int m = s.size() / 2;
        return s.size() % 2 == 1 ? s.get(m) : (s.get(m - 1) + s.get(m)) / 2;
    }

    static int countJsonSse(byte[] data) {
        String str = new String(data, StandardCharsets.UTF_8);
        int n = 0;
        for (String line : str.split("\n"))
            if (line.startsWith("data: ") && !line.contains("[DONE]")) n++;
        return n;
    }

    static int countMsgpack(byte[] data) {
        int n = 0;
        Iterator<CodecFrame> it = StreamDecoder.decodeMsgpackStream(new ByteArrayInputStream(data));
        while (it.hasNext()) n += it.next().ids().length;
        return n;
    }

    static int countProtobuf(byte[] data) {
        int n = 0;
        Iterator<CodecFrame> it = StreamDecoder.decodeProtobufStream(new ByteArrayInputStream(data));
        while (it.hasNext()) n += it.next().ids().length;
        return n;
    }

    static byte[] readAll(InputStream is) throws Exception {
        try (is) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] tmp = new byte[8192];
            int r;
            while ((r = is.read(tmp)) != -1) out.write(tmp, 0, r);
            return out.toByteArray();
        }
    }

    static final class CellResult {
        Integer wireBytes;
        Double  ttftMs;
        Double  totalMs;
        int     tokens;
        String  error;
    }

    /** Decompress per Content-Encoding. Returns the raw bytes on failure
     *  with an error string; never throws.
     *
     *  <p>For zstd, looks up the server's {@code Codec-Zstd-Dict} header
     *  against {@link #ZSTD_DICTS} via
     *  {@link Compression#selectZstdDictForResponse} and decompresses
     *  with that dict: bare {@code ZstdInputStream(...)} (no dict) only
     *  works against no-dict servers, and the v0.4 bench fleet emits
     *  dict-zstd, so the no-dict path produced
     *  "ZstdIOException: Dictionary mismatch" before this rewire. */
    static byte[] tryDecode(String contentEncoding,
                            byte[] compressed,
                            Map<String, String> responseHeaders,
                            String[] errOut) {
        try {
            return switch (contentEncoding) {
                case "gzip" -> readAll(new GZIPInputStream(new ByteArrayInputStream(compressed)));
                case "br"   -> readAll(new BrotliInputStream(new ByteArrayInputStream(compressed)));
                case "zstd" -> decodeZstd(compressed, responseHeaders);
                default     -> compressed;
            };
        } catch (CodecZstdDictError dictErr) {
            // Spec-defined failure (header missing/malformed/unknown
            // hash). Surface the message verbatim: it's already shaped
            // for operators.
            errOut[0] = dictErr.getClass().getSimpleName() + ": " + dictErr.getMessage();
            return compressed;
        } catch (Exception e) {
            errOut[0] = e.getClass().getSimpleName() + ": " + e.getMessage();
            return compressed;
        }
    }

    /** zstd path: pick the dict via the production helper, then stream-
     *  decompress with zstd-jni's {@link ZstdDictDecompress} for dict
     *  reuse (parsing the 16 KB dict once per stream is fine; parsing it
     *  once per chunk would not be). */
    private static byte[] decodeZstd(byte[] compressed,
                                     Map<String, String> responseHeaders) throws Exception {
        byte[] dict = Compression.selectZstdDictForResponse(responseHeaders, ZSTD_DICTS);
        ZstdInputStream zis = new ZstdInputStream(new ByteArrayInputStream(compressed));
        if (dict != null) {
            // ZstdDictDecompress holds a native-side parsed dict: reuse
            // it across the stream rather than re-parsing on every chunk.
            try (ZstdDictDecompress parsed = new ZstdDictDecompress(dict)) {
                zis.setDict(parsed);
                return readAll(zis);
            }
        }
        // No dict needed (shouldn't happen on v0.4+ servers, but the
        // helper returns null for non-zstd; on zstd it either returns
        // the dict bytes or throws). Kept defensive for older servers.
        return readAll(zis);
    }

    static CellResult runOne(HttpClient http, ObjectMapper json,
                             String endpoint, String model, String prompt,
                             int size, String format, String encoding) {
        CellResult r = new CellResult();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("prompt", prompt);
        body.put("max_tokens", size);
        body.put("stream", true);
        body.put("temperature", 0.0);
        if (!"json".equals(format)) body.put("stream_format", format);

        long t0 = System.nanoTime();
        byte[] compressed;
        String contentEncoding;
        Map<String, String> respHeaders = new LinkedHashMap<>();
        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(endpoint + "/v1/completions"))
                    .timeout(Duration.ofSeconds(180))
                    .header("Content-Type", "application/json")
                    .header("Accept-Encoding", encoding)
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                    .build();
            HttpResponse<InputStream> resp = http.send(req,
                    HttpResponse.BodyHandlers.ofInputStream());
            r.ttftMs = (System.nanoTime() - t0) / 1_000_000.0;
            if (resp.statusCode() / 100 != 2) {
                r.totalMs = (System.nanoTime() - t0) / 1_000_000.0;
                r.error = "HTTP " + resp.statusCode();
                return r;
            }
            ByteArrayOutputStream raw = new ByteArrayOutputStream();
            byte[] tmp = new byte[8192];
            try (InputStream is = resp.body()) {
                int n;
                while ((n = is.read(tmp)) != -1) raw.write(tmp, 0, n);
            }
            compressed = raw.toByteArray();
            r.wireBytes = compressed.length;
            r.totalMs = (System.nanoTime() - t0) / 1_000_000.0;
            contentEncoding = resp.headers().firstValue("Content-Encoding")
                    .orElse("identity").toLowerCase();
            // Snapshot all response headers (lowercase keys, first value)
            // so tryDecode can look up Codec-Zstd-Dict case-insensitively.
            resp.headers().map().forEach((k, vs) -> {
                if (vs != null && !vs.isEmpty())
                    respHeaders.put(k.toLowerCase(), vs.get(0));
            });
        } catch (Exception e) {
            r.error = e.getClass().getSimpleName() + ": " + e.getMessage();
            return r;
        }

        // Wire/TTFB/total preserved past this point regardless of decode outcome.
        String[] decodeErr = new String[1];
        byte[] decoded = tryDecode(contentEncoding, compressed, respHeaders, decodeErr);
        if (decodeErr[0] != null) {
            r.error = "decode " + contentEncoding + ": " + decodeErr[0];
            r.tokens = 0;
        } else {
            try {
                r.tokens = switch (format) {
                    case "json"     -> countJsonSse(decoded);
                    case "msgpack"  -> countMsgpack(decoded);
                    case "protobuf" -> countProtobuf(decoded);
                    default         -> 0;
                };
            } catch (Exception e) {
                r.tokens = 0;
                r.error = "count " + format + ": " + e.getClass().getSimpleName() + ": " + e.getMessage();
            }
        }
        return r;
    }

    public static void run(MatrixArgs args) throws Exception {
        // Two mappers: one compact for HTTP request bodies (sglang's parser
        // is strict about request formats); one indented for the SCHEMA-v1
        // output JSON.
        ObjectMapper json = new ObjectMapper();
        ObjectMapper jsonOut = new ObjectMapper();
        jsonOut.configure(SerializationFeature.INDENT_OUTPUT, true);

        Path methodologyPath = Paths.get(args.methodology).toAbsolutePath();
        ObjectNode methodology = (ObjectNode) json.readTree(methodologyPath.toFile());

        // Repo root from this class's CodeSource. Two layouts to handle:
        //   - fat jar at packages/demo-java/target/codec-bench.jar
        //     → 3 getParent calls (target/ → demo-java/ → packages/ → root)
        //   - exploded classes at packages/demo-java/target/classes/ai/codec/bench/...
        //     → can be reached either way; we walk up looking for "packages".
        Path repoRoot;
        try {
            URI uri = MatrixRun.class.getProtectionDomain().getCodeSource().getLocation().toURI();
            Path codeSource = Paths.get(uri);
            Path candidate = codeSource;
            // Walk up until we land on a directory whose child is "packages",
            // which by convention is the repo root.
            while (candidate != null && candidate.getParent() != null) {
                if (candidate.getFileName() != null
                        && "packages".equals(candidate.getFileName().toString())) {
                    candidate = candidate.getParent();
                    break;
                }
                candidate = candidate.getParent();
            }
            repoRoot = candidate != null ? candidate : Paths.get(".").toAbsolutePath();
        } catch (Exception e) {
            repoRoot = Paths.get(".").toAbsolutePath();
        }

        String promptsRel = methodology.path("workload").path("prompts_file").asText();
        Path promptsPath = repoRoot.resolve("packages").resolve("bench").resolve(promptsRel);
        ObjectNode prompts = (ObjectNode) json.readTree(promptsPath.toFile()).path("prompts");

        // Pre-load the reference zstd dictionaries so the bench can
        // actually decompress the `zstd` cells (v0.4 servers emit
        // dict-zstd with Codec-Zstd-Dict). Without these, the zstd
        // column reports "ZstdIOException: Dictionary mismatch" and
        // tokens=0 even though wire/TTFB are fine. The Python /
        // TS / Rust / .NET / C bench clients all do the same priming
        // step against `dictionaries/`.
        Path dictsDir = repoRoot.resolve("dictionaries");
        loadZstdDictFiles(
                dictsDir.resolve("qwen2.5-synth-msgpack-v1.dict").toString(),
                dictsDir.resolve("qwen2.5-synth-protobuf-v1.dict").toString());
        if (ZSTD_DICTS.isEmpty()) {
            System.err.println("WARNING: no zstd dicts loaded from " + dictsDir
                    + ": zstd cells will fail with 'dict not loaded'");
        } else {
            System.err.println("loaded " + ZSTD_DICTS.size() + " zstd dict(s) from " + dictsDir);
        }

        String endpoint = methodology.path("engine").path("endpoint").asText();
        String model = methodology.path("model").path("id").asText();

        String commit = sh("git", "rev-parse", "HEAD");
        ObjectNode clientBlock = json.createObjectNode();
        clientBlock.put("lang", "java");
        clientBlock.put("lib_name", "codec");
        clientBlock.put("lib_version", "0.1.0");
        clientBlock.put("lib_commit", commit);
        clientBlock.put("runtime",
                "JDK " + Runtime.version() + " / java.net.http / Jackson");
        methodology.set("client", clientBlock);

        ObjectNode benchTool = json.createObjectNode();
        benchTool.put("name", "demo-java/codec-bench MatrixRun");
        benchTool.put("version", "0.1.0");
        benchTool.put("commit", commit);
        benchTool.put("reps", args.reps);
        benchTool.put("warmup_reps", 0);
        benchTool.put("aggregation", "median");
        benchTool.put("ttft_definition",
                "wall-clock from HttpClient.send() return to first received byte");
        benchTool.put("wire_bytes_definition",
                "raw socket bytes from HttpResponse InputStream before any Content-Encoding decompression");
        benchTool.put("total_ms_definition",
                "wall-clock from request POST to last byte");
        methodology.set("bench_tool", benchTool);

        // Force HTTP/1.1: JDK HttpClient defaults to HTTP/2 but the
        // codec-supervisor's uvicorn proxy (sglang's parent process)
        // returns "Invalid HTTP request received." on h2 attempts.
        // sglang itself uses uvicorn-with-h11 on :30000; the supervisor
        // proxy on :8080 → :30000 is the layer that's strict about h1.
        HttpClient http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(10))
                .build();

        ArrayNode rows = json.createArrayNode();
        for (int size : args.sizes) {
            JsonNode promptNode = prompts.path(String.valueOf(size));
            if (promptNode.isMissingNode() || !promptNode.isTextual()) {
                System.err.println("no canonical prompt defined for size=" + size);
                System.exit(1);
            }
            String prompt = promptNode.asText();
            System.err.println(">>> size=" + size + "  prompt: '" +
                    (prompt.length() > 60 ? prompt.substring(0, 60) + "..." : prompt) + "'");

            for (String[] p : PATHS) {
                String label = p[0], format = p[1];
                for (String enc : ENCODINGS) {
                    List<Integer> repWire = new ArrayList<>();
                    List<Double>  repTtft = new ArrayList<>();
                    List<Double>  repTotal = new ArrayList<>();
                    int tokens = 0;
                    String error = null;
                    for (int r = 0; r < args.reps; r++) {
                        CellResult cr = runOne(http, json, endpoint, model, prompt,
                                size, format, enc);
                        if (cr.wireBytes != null) repWire.add(cr.wireBytes);
                        if (cr.ttftMs != null)    repTtft.add(cr.ttftMs);
                        if (cr.totalMs != null)   repTotal.add(cr.totalMs);
                        if (cr.tokens > tokens)   tokens = cr.tokens;
                        if (cr.error != null)     error = cr.error;
                    }
                    ObjectNode row = json.createObjectNode();
                    row.put("size", size);
                    row.put("format", format);
                    row.put("encoding", enc);
                    if (repWire.isEmpty())  row.putNull("wire_bytes");  else row.put("wire_bytes", medianInt(repWire));
                    if (repTtft.isEmpty())  row.putNull("ttft_ms");    else row.put("ttft_ms", median(repTtft));
                    if (repTotal.isEmpty()) row.putNull("total_ms");   else row.put("total_ms", median(repTotal));
                    row.put("tokens_emitted", tokens);
                    ArrayNode rwArr = row.putArray("rep_wire_bytes");
                    for (Integer x : repWire) rwArr.add(x);
                    ArrayNode rtArr = row.putArray("rep_ttft_ms");
                    for (Double x : repTtft)  rtArr.add(x);
                    ArrayNode rtoArr = row.putArray("rep_total_ms");
                    for (Double x : repTotal) rtoArr.add(x);
                    if (error == null) row.putNull("error"); else row.put("error", error);
                    rows.add(row);
                    System.err.printf("    %-25s %-8s size=%5d  wire=%s  ttft=%s  total=%s  tokens=%d%n",
                            label, enc, size,
                            row.get("wire_bytes"), row.get("ttft_ms"), row.get("total_ms"), tokens);
                }
            }
        }

        ObjectNode out = json.createObjectNode();
        out.put("schema_version", "1");
        out.set("methodology", methodology);
        out.set("rows", rows);

        Path outPath = Paths.get(args.out).toAbsolutePath();
        Files.createDirectories(outPath.getParent());
        jsonOut.writerWithDefaultPrettyPrinter().writeValue(outPath.toFile(), out);
        System.err.println("\nwrote " + outPath + " (" + rows.size() + " rows)");
    }
}
