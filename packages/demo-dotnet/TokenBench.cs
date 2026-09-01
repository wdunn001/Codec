// SPDX-License-Identifier: MIT
//
// Per-language tokenize/detokenize micro-benchmark: .NET.
// Cross-language companion of codec_demo.token_bench (Python) /
// demo/src/token_bench.ts / demo-rust/src/token_bench.rs.
//
// Usage:
//   dotnet run --project packages/demo-dotnet -- token-bench \
//     --map ../../codec-maps/maps/qwen/qwen2.json \
//     --corpus ../bench/golden/qwen2.json \
//     --reps 200 --warmup 20 \
//     --out ../bench/results/<run-id>/token/dotnet.json
//
// Invoked from Program.cs when argv[0] == "token-bench".

using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Codec;

namespace Codec.Bench;

internal static class TokenBench
{
    public static int Run(string[] args)
    {
        var (mapPath, corpusPath, outPath, reps, warmup) = ParseArgs(args);

        var mapBytes = File.ReadAllBytes(mapPath);
        var map = TokenizerMap.FromJson(mapBytes);

        var corpusBytes = File.ReadAllBytes(corpusPath);
        var corpus = JsonSerializer.Deserialize<JsonElement>(corpusBytes);
        var samples = corpus.GetProperty("samples").EnumerateArray().ToList();
        if (samples.Count == 0)
        {
            Console.Error.WriteLine("corpus has no samples");
            return 1;
        }

        var tok = new BPETokenizer(map);
        var detok = new Detokenizer(map);

        var texts = samples.Select(s => s.GetProperty("text").GetString() ?? "").ToList();
        var refIds = samples.Select(s =>
            s.GetProperty("ids").EnumerateArray().Select(v => v.GetInt32()).ToArray()
        ).ToList();
        long totalTextBytes = texts.Sum(t => (long)Encoding.UTF8.GetByteCount(t));
        long totalTokens = refIds.Sum(ids => (long)ids.Length);

        // Warmup
        for (var r = 0; r < warmup; r++)
        {
            foreach (var t in texts) tok.Encode(t);
            foreach (var ids in refIds) detok.Render(ids);
        }

        var encodeMs = new double[reps];
        var decodeMs = new double[reps];
        var sw = new Stopwatch();
        for (var r = 0; r < reps; r++)
        {
            sw.Restart();
            foreach (var t in texts) tok.Encode(t);
            sw.Stop();
            encodeMs[r] = sw.Elapsed.TotalMilliseconds;

            sw.Restart();
            foreach (var ids in refIds) detok.Render(ids);
            sw.Stop();
            decodeMs[r] = sw.Elapsed.TotalMilliseconds;
        }

        Array.Sort(encodeMs);
        Array.Sort(decodeMs);
        var encMed = Median(encodeMs);
        var decMed = Median(decodeMs);
        var encP99 = Percentile(encodeMs, 99);
        var decP99 = Percentile(decodeMs, 99);

        var result = new
        {
            schema_version = "1",
            kind = "token_bench",
            captured_at = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
            client = new
            {
                lang = "dotnet",
                lib_name = "Codec.Net",
                lib_version = Assembly.GetAssembly(typeof(BPETokenizer))?
                    .GetName().Version?.ToString() ?? "unknown",
                runtime = $".NET {Environment.Version}",
            },
            map = new
            {
                id = map.Id,
                vocab_size = map.VocabSize,
                sha256 = Sha256Hex(mapBytes),
            },
            corpus = new
            {
                path = corpusPath,
                sha256 = Sha256Hex(corpusBytes),
                samples = samples.Count,
                total_text_bytes = totalTextBytes,
                total_tokens = totalTokens,
            },
            reps,
            warmup_reps = warmup,
            encode_ms_total_median = encMed,
            encode_ms_total_p99 = encP99,
            decode_ms_total_median = decMed,
            decode_ms_total_p99 = decP99,
            encode_tokens_per_sec = encMed > 0 ? (object)(totalTokens / encMed * 1000) : null!,
            decode_tokens_per_sec = decMed > 0 ? (object)(totalTokens / decMed * 1000) : null!,
        };

        Directory.CreateDirectory(Path.GetDirectoryName(outPath) ?? ".");
        var json = JsonSerializer.Serialize(
            result,
            new JsonSerializerOptions { WriteIndented = true }
        );
        File.WriteAllText(outPath, json);

        Console.Error.WriteLine(
            $"  dotnet  encode={encMed,6:F2} ms ({(long)(totalTokens / encMed * 1000):N0} tok/s)" +
            $"  decode={decMed,6:F2} ms ({(long)(totalTokens / decMed * 1000):N0} tok/s)" +
            $"  → {outPath}"
        );
        return 0;
    }

    private static (string map, string corpus, string outPath, int reps, int warmup) ParseArgs(string[] args)
    {
        string? map = null, corpus = null, outPath = null;
        var reps = 200;
        var warmup = 20;
        for (var i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--map": map = args[i + 1]; break;
                case "--corpus": corpus = args[i + 1]; break;
                case "--out": outPath = args[i + 1]; break;
                case "--reps": reps = int.Parse(args[i + 1]); break;
                case "--warmup": warmup = int.Parse(args[i + 1]); break;
            }
        }
        if (map is null || corpus is null || outPath is null)
            throw new ArgumentException("--map, --corpus, --out are required");
        return (map, corpus, outPath, reps, warmup);
    }

    private static double Median(double[] sortedAsc)
    {
        if (sortedAsc.Length == 0) return 0;
        var mid = sortedAsc.Length / 2;
        return sortedAsc.Length % 2 == 0
            ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2.0
            : sortedAsc[mid];
    }

    private static double Percentile(double[] sortedAsc, double pct)
    {
        if (sortedAsc.Length == 0) return 0;
        var idx = (int)Math.Round((pct / 100.0) * (sortedAsc.Length - 1));
        return sortedAsc[Math.Clamp(idx, 0, sortedAsc.Length - 1)];
    }

    private static string Sha256Hex(byte[] bytes)
    {
        var h = SHA256.HashData(bytes);
        var sb = new StringBuilder("sha256:");
        foreach (var b in h) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }
}
