// SPDX-License-Identifier: MIT
//
// codec-bench (.NET) - same shape as packages/demo-web (TypeScript),
// packages/demo-python, and the C demo. Runs the same prompt across
// 3 wire formats x 4 compression encodings, prints the wire-byte table.
//
// Usage:
//     dotnet run --project packages/demo-dotnet -- \
//         --url http://192.168.1.88:30000 \
//         --model Qwen/Qwen2.5-0.5B-Instruct \
//         --prompt "Explain entropy in one sentence:" \
//         --max-tokens 64

using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Codec;

namespace Codec.Bench;

internal static class Program
{
    static readonly (string Label, string Format)[] Paths =
    {
        ("JSON-SSE (default)", "json"),
        ("Codec msgpack",      "msgpack"),
        ("Codec protobuf",     "protobuf"),
    };

    static readonly string[] Encodings = { "identity", "gzip", "br", "zstd" };

    sealed class Cell
    {
        public required string PathLabel { get; init; }
        public required string Format { get; init; }
        public required string Encoding { get; init; }
        public string Status { get; set; } = "pending";
        public int? WireBytes { get; set; }
        public int? DecodedBytes { get; set; }
        public int Tokens { get; set; }
        public double? TtfbMs { get; set; }
        public double? TotalMs { get; set; }
        public string? Error { get; set; }
    }

    sealed class Args
    {
        public string Url = "http://192.168.1.88:30000";
        public string Model = "Qwen/Qwen2.5-0.5B-Instruct";
        public string Prompt = "Explain entropy in one sentence:";
        public int MaxTokens = 64;
    }

    static Args ParseArgs(string[] argv)
    {
        var a = new Args();
        for (int i = 0; i < argv.Length; i++)
        {
            switch (argv[i])
            {
                case "--url":         a.Url = argv[++i]; break;
                case "--model":       a.Model = argv[++i]; break;
                case "--prompt":      a.Prompt = argv[++i]; break;
                case "--max-tokens":  a.MaxTokens = int.Parse(argv[++i]); break;
            }
        }
        return a;
    }

    static string FmtBytes(int? n) => n switch
    {
        null => "-",
        < 1024 => $"{n} B",
        < 1_048_576 => $"{n / 1024.0:F1} KB",
        _ => $"{n / 1_048_576.0:F2} MB",
    };

    static string FmtMs(double? n) => n is null ? "-" : $"{n:F0} ms";

    /// <summary>
    /// Issue one streaming completion. Returns wire bytes (off the socket,
    /// pre-decompression) plus the decompressed body for token counting.
    /// </summary>
    static async Task<(byte[] Body, int WireBytes, double TtfbMs)>
    FetchStream(HttpClient http, string url, object body, string acceptEncoding)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, url + "/v1/completions");
        req.Headers.AcceptEncoding.Clear();
        if (acceptEncoding != "identity")
            req.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue(acceptEncoding));
        else
            req.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("identity"));
        req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        var sw = Stopwatch.StartNew();
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        var ttfb = sw.Elapsed.TotalMilliseconds;
        resp.EnsureSuccessStatusCode();

        // Read raw stream (no automatic decompression — see CreateClient below).
        using var raw = await resp.Content.ReadAsStreamAsync();
        using var ms = new MemoryStream();
        await raw.CopyToAsync(ms);
        var wire = (int)ms.Length;
        var compressed = ms.ToArray();

        var contentEncoding = resp.Content.Headers.ContentEncoding.FirstOrDefault() ?? "identity";
        byte[] decompressed = compressed;
        if (contentEncoding == "gzip")
        {
            using var input = new MemoryStream(compressed);
            using var gz = new GZipStream(input, CompressionMode.Decompress);
            using var outMs = new MemoryStream();
            await gz.CopyToAsync(outMs);
            decompressed = outMs.ToArray();
        }
        else if (contentEncoding == "br")
        {
            using var input = new MemoryStream(compressed);
            using var br = new BrotliStream(input, CompressionMode.Decompress);
            using var outMs = new MemoryStream();
            await br.CopyToAsync(outMs);
            decompressed = outMs.ToArray();
        }
        else if (contentEncoding == "zstd")
        {
            // .NET 8 BCL has no zstd. We treat zstd as a pass-through token
            // count failure here (decoder bytes count is approximated by
            // the wire size). The C and Python clients do better; this is a
            // known gap pending zstd support in BCL or a NuGet package.
            decompressed = compressed;
        }

        return (decompressed, wire, ttfb);
    }

    static int CountJsonSse(byte[] data)
    {
        var s = Encoding.UTF8.GetString(data);
        int n = 0;
        foreach (var line in s.Split('\n'))
        {
            if (line.StartsWith("data: ") && !line.Contains("[DONE]")) n++;
        }
        return n;
    }

    static async Task<int> CountMsgpack(byte[] data)
    {
        int n = 0;
        using var ms = new MemoryStream(data);
        await foreach (var frame in StreamDecoder.DecodeMsgpackStreamAsync(ms))
        {
            n += frame.Ids.Count;
        }
        return n;
    }

    static int CountProtobuf(byte[] data)
    {
        int n = 0;
        int pos = 0;
        while (pos + 4 <= data.Length)
        {
            int length = (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
            pos += 4;
            if (pos + length > data.Length) break;
            int bp = pos;
            int bend = pos + length;
            while (bp < bend)
            {
                long tag = ReadVarint(data, ref bp);
                int field = (int)(tag >> 3);
                int wt = (int)(tag & 0x07);
                if (field == 1 && wt == 2)
                {
                    long ln = ReadVarint(data, ref bp);
                    int end = bp + (int)ln;
                    while (bp < end)
                    {
                        ReadVarint(data, ref bp);
                        n++;
                    }
                }
                else if (wt == 0) ReadVarint(data, ref bp);
                else if (wt == 2) { long ln = ReadVarint(data, ref bp); bp += (int)ln; }
                else if (wt == 5) bp += 4;
                else if (wt == 1) bp += 8;
                else break;
            }
            pos = bend;
        }
        return n;
    }

    static long ReadVarint(byte[] data, ref int pos)
    {
        long n = 0; int shift = 0;
        while (true)
        {
            byte b = data[pos++];
            n |= (long)(b & 0x7F) << shift;
            if ((b & 0x80) == 0) return n;
            shift += 7;
        }
    }

    static async Task RunOne(HttpClient http, Args args, Cell cell)
    {
        cell.Status = "running";
        var body = new Dictionary<string, object>
        {
            ["model"] = args.Model,
            ["prompt"] = args.Prompt,
            ["max_tokens"] = args.MaxTokens,
            ["stream"] = true,
            ["temperature"] = 0.0,
        };
        if (cell.Format != "json") body["stream_format"] = cell.Format;

        var sw = Stopwatch.StartNew();
        try
        {
            var (decoded, wire, ttfb) = await FetchStream(http, args.Url, body, cell.Encoding);
            cell.WireBytes = wire;
            cell.DecodedBytes = decoded.Length;
            cell.TtfbMs = ttfb;
            cell.TotalMs = sw.Elapsed.TotalMilliseconds;
            cell.Tokens = cell.Format switch
            {
                "json"     => CountJsonSse(decoded),
                "msgpack"  => await CountMsgpack(decoded),
                "protobuf" => CountProtobuf(decoded),
                _          => 0,
            };
            cell.Status = "done";
        }
        catch (Exception e)
        {
            cell.Error = $"{e.GetType().Name}: {e.Message}";
            cell.Status = "error";
        }
    }

    static void Render(IList<IList<Cell>> grid)
    {
        int? baseline = grid[0][0].Status == "done" ? grid[0][0].WireBytes : null;

        // header
        var sb = new StringBuilder();
        sb.AppendLine();
        sb.Append($"{"path",-25}");
        foreach (var e in Encodings) sb.Append($"  {e,16}");
        sb.AppendLine();
        sb.AppendLine(new string('-', 25 + (16 + 2) * Encodings.Length));

        // rows
        foreach (var row in grid)
        {
            sb.Append($"{row[0].PathLabel,-25}");
            foreach (var c in row)
            {
                sb.Append("  ");
                if (c.Status == "pending")      sb.Append($"{"-",16}");
                else if (c.Status == "running") sb.Append($"{"running",16}");
                else if (c.Status == "error")   sb.Append($"{(c.Error?.Length > 16 ? c.Error[..16] : c.Error),16}");
                else                             sb.Append($"{FmtBytes(c.WireBytes),16}");
            }
            sb.AppendLine();
        }

        sb.AppendLine();
        sb.AppendLine("per cell: wire_bytes / tokens / B-per-tok / ttfb / total / ratio-vs-json");
        sb.AppendLine();

        foreach (var row in grid)
        {
            foreach (var c in row)
            {
                if (c.Status != "done" || c.WireBytes is null) continue;
                double ratio = baseline.HasValue && c.WireBytes > 0
                    ? (double)baseline.Value / c.WireBytes.Value : 0;
                double bpt = c.Tokens > 0 ? (double)c.WireBytes.Value / c.Tokens : 0;
                sb.AppendLine(
                    $"  {c.PathLabel,-25} {c.Encoding,-8} " +
                    $"{FmtBytes(c.WireBytes),10}  {c.Tokens,4} tok  " +
                    $"{bpt,6:F1} B/tok  {FmtMs(c.TtfbMs),7} TTFB  " +
                    $"{FmtMs(c.TotalMs),7} total  {ratio,5:F1}x");
            }
        }

        Console.Write(sb.ToString());
    }

    public static async Task<int> Main(string[] argv)
    {
        var args = ParseArgs(argv);
        Console.WriteLine($"target: {args.Url}");
        Console.WriteLine($"model:  {args.Model}");
        Console.WriteLine($"prompt: {args.Prompt}  (max_tokens={args.MaxTokens})");

        // Disable automatic decompression so we count compressed bytes off the wire.
        var handler = new HttpClientHandler { AutomaticDecompression = System.Net.DecompressionMethods.None };
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(120) };

        var grid = new List<IList<Cell>>();
        foreach (var (label, fmt) in Paths)
        {
            var row = new List<Cell>();
            foreach (var enc in Encodings)
                row.Add(new Cell { PathLabel = label, Format = fmt, Encoding = enc });
            grid.Add(row);
        }

        foreach (var row in grid)
        {
            foreach (var cell in row)
            {
                Console.Error.WriteLine($">>>  {cell.PathLabel} / {cell.Encoding}");
                await RunOne(http, args, cell);
                if (cell.Status == "done")
                    Console.Error.WriteLine($"     wire={FmtBytes(cell.WireBytes)} tokens={cell.Tokens} total={FmtMs(cell.TotalMs)}");
                else
                    Console.Error.WriteLine($"     {cell.Status}: {cell.Error}");
            }
        }

        Render(grid);
        return 0;
    }
}
