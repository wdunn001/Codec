// SPDX-License-Identifier: MIT
//
// Per-language tokenize/detokenize micro-benchmark — Java.
// Cross-language companion of codec_demo.token_bench (Python) /
// demo/src/token_bench.ts / demo-rust/src/token_bench.rs /
// demo-dotnet/TokenBench.cs.
//
// Usage:
//   java -jar codec-bench.jar token-bench \
//     --map ../../codec-maps/maps/qwen/qwen2.json \
//     --corpus ../bench/golden/qwen2.json \
//     --reps 200 --warmup 20 \
//     --out ../bench/results/<run-id>/token/java.json
//
// Invoked from Bench.main when argv[0] == "token-bench".
package ai.codec.bench;

import ai.codec.BPETokenizer;
import ai.codec.Detokenizer;
import ai.codec.TokenizerMap;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class TokenBench {
    private TokenBench() { }

    public static int run(String[] args) throws Exception {
        Path mapPath = null, corpusPath = null, outPath = null;
        int reps = 200, warmup = 20;
        for (int i = 0; i < args.length - 1; i++) {
            switch (args[i]) {
                case "--map":     mapPath = Path.of(args[i + 1]); break;
                case "--corpus":  corpusPath = Path.of(args[i + 1]); break;
                case "--out":     outPath = Path.of(args[i + 1]); break;
                case "--reps":    reps = Integer.parseInt(args[i + 1]); break;
                case "--warmup":  warmup = Integer.parseInt(args[i + 1]); break;
                default: break;
            }
        }
        if (mapPath == null || corpusPath == null || outPath == null) {
            System.err.println("usage: token-bench --map <map.json> --corpus <golden.json> --out <out.json> [--reps N] [--warmup N]");
            return 2;
        }

        ObjectMapper mapper = new ObjectMapper();
        mapper.enable(SerializationFeature.INDENT_OUTPUT);

        byte[] mapBytes = Files.readAllBytes(mapPath);
        TokenizerMap map = TokenizerMap.fromJson(mapBytes);

        byte[] corpusBytes = Files.readAllBytes(corpusPath);
        JsonNode corpus = mapper.readTree(corpusBytes);
        JsonNode samples = corpus.get("samples");
        if (samples == null || !samples.isArray() || samples.size() == 0) {
            System.err.println("corpus has no samples");
            return 1;
        }

        BPETokenizer tok = new BPETokenizer(map);
        Detokenizer detok = new Detokenizer(map);

        List<String> texts = new ArrayList<>();
        List<int[]> refIds = new ArrayList<>();
        long totalTextBytes = 0, totalTokens = 0;
        for (JsonNode s : samples) {
            String text = s.get("text").asText("");
            texts.add(text);
            totalTextBytes += text.getBytes(StandardCharsets.UTF_8).length;

            JsonNode idsNode = s.get("ids");
            int[] ids = new int[idsNode.size()];
            for (int j = 0; j < ids.length; j++) ids[j] = idsNode.get(j).asInt();
            refIds.add(ids);
            totalTokens += ids.length;
        }

        // Warmup
        for (int r = 0; r < warmup; r++) {
            for (String t : texts) tok.encode(t);
            for (int[] ids : refIds) detok.render(ids);
        }

        double[] encodeMs = new double[reps];
        double[] decodeMs = new double[reps];
        for (int r = 0; r < reps; r++) {
            long t0 = System.nanoTime();
            for (String t : texts) tok.encode(t);
            encodeMs[r] = (System.nanoTime() - t0) / 1_000_000.0;

            long t1 = System.nanoTime();
            for (int[] ids : refIds) detok.render(ids);
            decodeMs[r] = (System.nanoTime() - t1) / 1_000_000.0;
        }

        double[] encSorted = encodeMs.clone();
        double[] decSorted = decodeMs.clone();
        Arrays.sort(encSorted);
        Arrays.sort(decSorted);

        double encMed = median(encSorted);
        double decMed = median(decSorted);
        double encP99 = percentile(encSorted, 99);
        double decP99 = percentile(decSorted, 99);

        String capturedAt = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'")
                .withZone(ZoneOffset.UTC).format(Instant.now());

        ObjectNode result = mapper.createObjectNode();
        result.put("schema_version", "1");
        result.put("kind", "token_bench");
        result.put("captured_at", capturedAt);

        ObjectNode client = result.putObject("client");
        client.put("lang", "java");
        client.put("lib_name", "ai.codec:codec");
        client.put("lib_version", BPETokenizer.class.getPackage().getImplementationVersion() != null
                ? BPETokenizer.class.getPackage().getImplementationVersion() : "unknown");
        client.put("runtime", "Java " + System.getProperty("java.version"));

        ObjectNode mapObj = result.putObject("map");
        mapObj.put("id", map.id);
        mapObj.put("vocab_size", map.vocabSize);
        mapObj.put("sha256", sha256Hex(mapBytes));

        ObjectNode corpusObj = result.putObject("corpus");
        corpusObj.put("path", corpusPath.toString());
        corpusObj.put("sha256", sha256Hex(corpusBytes));
        corpusObj.put("samples", samples.size());
        corpusObj.put("total_text_bytes", totalTextBytes);
        corpusObj.put("total_tokens", totalTokens);

        result.put("reps", reps);
        result.put("warmup_reps", warmup);
        result.put("encode_ms_total_median", encMed);
        result.put("encode_ms_total_p99", encP99);
        result.put("decode_ms_total_median", decMed);
        result.put("decode_ms_total_p99", decP99);
        if (encMed > 0) result.put("encode_tokens_per_sec", (double) totalTokens / encMed * 1000);
        else            result.putNull("encode_tokens_per_sec");
        if (decMed > 0) result.put("decode_tokens_per_sec", (double) totalTokens / decMed * 1000);
        else            result.putNull("decode_tokens_per_sec");

        Files.createDirectories(outPath.getParent());
        Files.writeString(outPath, mapper.writeValueAsString(result));

        long encTps = encMed > 0 ? Math.round(totalTokens / encMed * 1000) : 0;
        long decTps = decMed > 0 ? Math.round(totalTokens / decMed * 1000) : 0;
        System.err.printf(
            "  java    encode=%6.2f ms (%,d tok/s)  decode=%6.2f ms (%,d tok/s)  → %s%n",
            encMed, encTps, decMed, decTps, outPath
        );
        return 0;
    }

    private static double median(double[] sortedAsc) {
        if (sortedAsc.length == 0) return 0;
        int mid = sortedAsc.length / 2;
        return sortedAsc.length % 2 == 0
                ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2.0
                : sortedAsc[mid];
    }

    private static double percentile(double[] sortedAsc, double pct) {
        if (sortedAsc.length == 0) return 0;
        int idx = (int) Math.round((pct / 100.0) * (sortedAsc.length - 1));
        return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, idx))];
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(bytes);
            StringBuilder sb = new StringBuilder("sha256:");
            for (byte b : hash) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            return "sha256:error";
        }
    }
}
