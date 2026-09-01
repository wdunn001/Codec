// SPDX-License-Identifier: MIT
//
// codec-bench (Java): same shape as packages/demo-web (TypeScript),
// packages/demo-python, packages/demo-dotnet, packages/demo-c,
// packages/demo-rust. Runs the same prompt across 3 wire formats × 4
// compression encodings, prints the wire-byte table.
//
// Usage:
//     java -jar packages/demo-java/target/codec-bench.jar \
//         --url http://192.168.1.88:30000 \
//         --model Qwen/Qwen2.5-0.5B-Instruct \
//         --prompt "Explain entropy in one sentence:" \
//         --max-tokens 64

package ai.codec.bench;

import ai.codec.CodecFrame;
import ai.codec.StreamDecoder;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

public final class Bench {

    private static final String[][] PATHS = {
            { "JSON-SSE (default)", "json" },
            { "Codec msgpack",      "msgpack" },
            { "Codec protobuf",     "protobuf" },
    };

    private static final String[] ENCODINGS = { "identity", "gzip", "br", "zstd" };

    static final class Cell {
        final String pathLabel;
        final String format;
        final String encoding;
        String status = "pending";
        Integer wireBytes;
        Integer decodedBytes;
        int tokens;
        Double ttfbMs;
        Double totalMs;
        String error;
        Cell(String pathLabel, String format, String encoding) {
            this.pathLabel = pathLabel;
            this.format = format;
            this.encoding = encoding;
        }
    }

    static final class Args {
        String url = "http://192.168.1.88:30000";
        String model = "Qwen/Qwen2.5-0.5B-Instruct";
        String prompt = "Explain entropy in one sentence:";
        int maxTokens = 64;
    }

    static Args parseArgs(String[] argv) {
        Args a = new Args();
        for (int i = 0; i < argv.length; i++) {
            switch (argv[i]) {
                case "--url"        -> a.url        = argv[++i];
                case "--model"      -> a.model      = argv[++i];
                case "--prompt"     -> a.prompt     = argv[++i];
                case "--max-tokens" -> a.maxTokens  = Integer.parseInt(argv[++i]);
                default -> { /* ignore unknown */ }
            }
        }
        return a;
    }

    static String fmtBytes(Integer n) {
        if (n == null) return "-";
        if (n < 1024)         return n + " B";
        if (n < 1_048_576)    return String.format("%.1f KB", n / 1024.0);
        return String.format("%.2f MB", n / 1_048_576.0);
    }

    static String fmtMs(Double n) {
        return n == null ? "-" : String.format("%.0f ms", n);
    }

    static final class FetchResult {
        final byte[] body;
        final int wireBytes;
        final double ttfbMs;
        FetchResult(byte[] body, int wireBytes, double ttfbMs) {
            this.body = body; this.wireBytes = wireBytes; this.ttfbMs = ttfbMs;
        }
    }

    /** Issue one streaming completion. Returns wire bytes (off the socket,
     *  pre-decompression) plus the decompressed body for token counting. */
    static FetchResult fetchStream(HttpClient http, String url, String jsonBody,
                                   String acceptEncoding) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url + "/v1/completions"))
                .timeout(Duration.ofSeconds(120))
                .header("Content-Type", "application/json")
                .header("Accept-Encoding", acceptEncoding)
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
                .build();

        long start = System.nanoTime();
        HttpResponse<InputStream> resp = http.send(req,
                HttpResponse.BodyHandlers.ofInputStream());
        double ttfbMs = (System.nanoTime() - start) / 1_000_000.0;
        if (resp.statusCode() / 100 != 2) {
            throw new RuntimeException("HTTP " + resp.statusCode());
        }

        // Buffer raw stream to count compressed bytes off the wire.
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        byte[] tmp = new byte[8192];
        try (InputStream is = resp.body()) {
            int r;
            while ((r = is.read(tmp)) != -1) raw.write(tmp, 0, r);
        }
        byte[] compressed = raw.toByteArray();
        int wire = compressed.length;

        String contentEncoding = resp.headers()
                .firstValue("Content-Encoding").orElse("identity").toLowerCase();
        byte[] decompressed = switch (contentEncoding) {
            case "gzip" -> readAll(new GZIPInputStream(new ByteArrayInputStream(compressed)));
            case "br"   -> readAll(new BrotliInputStream(new ByteArrayInputStream(compressed)));
            case "zstd" -> readAll(new ZstdInputStream(new ByteArrayInputStream(compressed)));
            default     -> compressed;
        };

        return new FetchResult(decompressed, wire, ttfbMs);
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

    static int countJsonSse(byte[] data) {
        String s = new String(data, StandardCharsets.UTF_8);
        int n = 0;
        for (String line : s.split("\n")) {
            if (line.startsWith("data: ") && !line.contains("[DONE]")) n++;
        }
        return n;
    }

    static int countMsgpack(byte[] data) {
        int n = 0;
        Iterator<CodecFrame> it = StreamDecoder.decodeMsgpackStream(
                new ByteArrayInputStream(data));
        while (it.hasNext()) n += it.next().ids().length;
        return n;
    }

    static int countProtobuf(byte[] data) {
        int n = 0;
        Iterator<CodecFrame> it = StreamDecoder.decodeProtobufStream(
                new ByteArrayInputStream(data));
        while (it.hasNext()) n += it.next().ids().length;
        return n;
    }

    static void runOne(HttpClient http, ObjectMapper json, Args args, Cell cell) {
        cell.status = "running";
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", args.model);
        body.put("prompt", args.prompt);
        body.put("max_tokens", args.maxTokens);
        body.put("stream", true);
        body.put("temperature", 0.0);
        if (!"json".equals(cell.format)) body.put("stream_format", cell.format);

        long started = System.nanoTime();
        try {
            String jsonBody = json.writeValueAsString(body);
            FetchResult r = fetchStream(http, args.url, jsonBody, cell.encoding);
            cell.wireBytes = r.wireBytes;
            cell.decodedBytes = r.body.length;
            cell.ttfbMs = r.ttfbMs;
            cell.totalMs = (System.nanoTime() - started) / 1_000_000.0;
            cell.tokens = switch (cell.format) {
                case "json"     -> countJsonSse(r.body);
                case "msgpack"  -> countMsgpack(r.body);
                case "protobuf" -> countProtobuf(r.body);
                default         -> 0;
            };
            cell.status = "done";
        } catch (Exception e) {
            cell.error = e.getClass().getSimpleName() + ": " + e.getMessage();
            cell.status = "error";
        }
    }

    static void render(List<List<Cell>> grid) {
        Integer baseline = "done".equals(grid.get(0).get(0).status)
                ? grid.get(0).get(0).wireBytes : null;

        StringBuilder sb = new StringBuilder("\n");
        sb.append(String.format("%-25s", "path"));
        for (String e : ENCODINGS) sb.append(String.format("  %16s", e));
        sb.append('\n');
        sb.append("-".repeat(25 + (16 + 2) * ENCODINGS.length)).append('\n');

        for (List<Cell> row : grid) {
            sb.append(String.format("%-25s", row.get(0).pathLabel));
            for (Cell c : row) {
                sb.append("  ");
                switch (c.status) {
                    case "pending" -> sb.append(String.format("%16s", "-"));
                    case "running" -> sb.append(String.format("%16s", "running"));
                    case "error"   -> {
                        String msg = c.error == null ? "error" : c.error;
                        if (msg.length() > 16) msg = msg.substring(0, 16);
                        sb.append(String.format("%16s", msg));
                    }
                    default        -> sb.append(String.format("%16s", fmtBytes(c.wireBytes)));
                }
            }
            sb.append('\n');
        }

        sb.append("\nper cell: wire_bytes / tokens / B-per-tok / ttfb / total / ratio-vs-json\n\n");

        for (List<Cell> row : grid) {
            for (Cell c : row) {
                if (!"done".equals(c.status) || c.wireBytes == null) continue;
                double ratio = (baseline != null && c.wireBytes > 0)
                        ? (double) baseline / c.wireBytes : 0.0;
                double bpt = c.tokens > 0 ? (double) c.wireBytes / c.tokens : 0.0;
                sb.append(String.format(
                        "  %-25s %-8s %10s  %4d tok  %6.1f B/tok  %7s TTFB  %7s total  %5.1fx%n",
                        c.pathLabel, c.encoding, fmtBytes(c.wireBytes), c.tokens, bpt,
                        fmtMs(c.ttfbMs), fmtMs(c.totalMs), ratio));
            }
        }

        System.out.print(sb);
    }

    public static void main(String[] argv) throws Exception {
        // Token-bench subcommand: dispatch before normal arg parsing so
        // the token-bench has its own --map / --corpus / --reps flags.
        if (argv.length > 0 && "token-bench".equals(argv[0])) {
            String[] rest = new String[argv.length - 1];
            System.arraycopy(argv, 1, rest, 0, rest.length);
            System.exit(TokenBench.run(rest));
            return;
        }

        // Dispatch: if --methodology is given, run the SCHEMA-v1 matrix mode.
        // Otherwise fall through to the legacy ad-hoc grid bench.
        MatrixRun.MatrixArgs matrixArgs = MatrixRun.parseMatrixArgs(argv);
        if (matrixArgs != null) {
            MatrixRun.run(matrixArgs);
            return;
        }

        Args args = parseArgs(argv);
        System.err.println("target: " + args.url);
        System.err.println("model:  " + args.model);
        System.err.println("prompt: " + args.prompt + "  (max_tokens=" + args.maxTokens + ")");

        // No automatic decompression: JDK HttpClient doesn't auto-decompress,
        // so wire bytes are exactly what's off the socket.
        HttpClient http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        ObjectMapper json = new ObjectMapper();

        List<List<Cell>> grid = new ArrayList<>();
        for (String[] p : PATHS) {
            List<Cell> row = new ArrayList<>();
            for (String enc : ENCODINGS) row.add(new Cell(p[0], p[1], enc));
            grid.add(row);
        }

        for (List<Cell> row : grid) {
            for (Cell cell : row) {
                System.err.println(">>>  " + cell.pathLabel + " / " + cell.encoding);
                runOne(http, json, args, cell);
                if ("done".equals(cell.status)) {
                    System.err.println("     wire=" + fmtBytes(cell.wireBytes)
                            + " tokens=" + cell.tokens
                            + " total=" + fmtMs(cell.totalMs));
                } else {
                    System.err.println("     " + cell.status + ": "
                            + (cell.error == null ? "" : cell.error));
                }
            }
        }

        render(grid);
    }
}
