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
using System.Text.Json.Nodes;
using Codec;
using ZstdSharp;

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

    // ── Codec-Zstd-Dict client-side registry ───────────────────────────────
    // Hash → bytes for any dict the bench has loaded locally. Keys MUST
    // follow the canonical "sha256:<hex>" shape the server emits in the
    // Codec-Zstd-Dict response header. Populated by LoadZstdDictFiles()
    // below; Main() invokes that on startup with the reference dicts from
    // <repo>/dictionaries/.
    static readonly Dictionary<string, byte[]> ZstdDicts =
        new(StringComparer.Ordinal);

    /// <summary>
    /// Load each dict file into the client-side registry, keyed by its
    /// sha256. Missing files are silently skipped: the bench then
    /// decompresses successfully only on cells whose Codec-Zstd-Dict
    /// header matches a hash we have. Same shape as
    /// <c>codec_demo.load_zstd_dict_files</c> in demo-python.
    /// </summary>
    static void LoadZstdDictFiles(params string[] paths)
    {
        foreach (var p in paths)
        {
            if (string.IsNullOrEmpty(p) || !File.Exists(p)) continue;
            try
            {
                var b = File.ReadAllBytes(p);
                ZstdDicts[Compression.HashZstdDict(b)] = b;
            }
            catch (IOException) { /* missing dict → cell decode fails, not fatal */ }
        }
    }

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

        // SCHEMA-v1 matrix mode (mirrors matrix_run.py / matrix_run.ts).
        public string? MethodologyPath = null;
        public string? OutPath = null;
        public int[] Sizes = new[] { 64, 512, 2048 };
        public int Reps = 2;
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
                case "--methodology": a.MethodologyPath = argv[++i]; break;
                case "--out":         a.OutPath = argv[++i]; break;
                case "--reps":        a.Reps = int.Parse(argv[++i]); break;
                case "--sizes":
                    var sizes = new List<int>();
                    while (i + 1 < argv.Length && int.TryParse(argv[i + 1], out var sz))
                    {
                        sizes.Add(sz);
                        i++;
                    }
                    if (sizes.Count > 0) a.Sizes = sizes.ToArray();
                    break;
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

        // Read raw stream (no automatic decompression: see CreateClient below).
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
            // Server-side dict-zstd: the response advertises which dict
            // it used via Codec-Zstd-Dict (spec/PROTOCOL.md §Pre-trained
            // ZSTD dictionaries). We hand the headers to Compression.
            // SelectZstdDictForResponse which:
            //   - returns the dict bytes when both headers are right,
            //   - throws CodecZstdDictException on missing / malformed /
            //     unknown-hash header,
            //   - returns null only for non-zstd responses (we already
            //     branched, so that path is unreachable here).
            // We then plug the dict into ZstdSharp's Decompressor so the
            // tokens-per-cell number reflects the real decoded payload
            // instead of being approximated to wire bytes.
            var hdrs = CollectHeaders(resp);
            var dictBytes = Compression.SelectZstdDictForResponse(hdrs, ZstdDicts);
            using var dec = new Decompressor();
            if (dictBytes is not null) dec.LoadDictionary(dictBytes);
            decompressed = dec.Unwrap(compressed).ToArray();
        }

        return (decompressed, wire, ttfb);
    }

    /// <summary>
    /// Flatten response + content headers into a single case-insensitive
    /// dict for <see cref="Compression.SelectZstdDictForResponse"/>. We
    /// only care about Content-Encoding (Content header) and
    /// Codec-Zstd-Dict (Response header in our server impl, but some
    /// proxies move it to Content; check both buckets).
    /// </summary>
    static Dictionary<string, string> CollectHeaders(HttpResponseMessage resp)
    {
        var h = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in resp.Headers)
            h[kv.Key] = string.Join(",", kv.Value);
        foreach (var kv in resp.Content.Headers)
            h[kv.Key] = string.Join(",", kv.Value);
        return h;
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

        // Phase 1: fetch + wire/TTFB/total. These are the bench's primary
        // signal and MUST land regardless of any downstream decompression
        // or decoding failure (e.g. dict-zstd response when no matching
        // dict is loaded client-side, or .NET 8 BCL's lack of native zstd).
        var sw = Stopwatch.StartNew();
        byte[] decoded;
        try
        {
            var fetched = await FetchStream(http, args.Url, body, cell.Encoding);
            decoded = fetched.Body;
            cell.WireBytes = fetched.WireBytes;
            cell.TtfbMs = fetched.TtfbMs;
            cell.TotalMs = sw.Elapsed.TotalMilliseconds;
            cell.DecodedBytes = decoded.Length;
        }
        catch (Exception e)
        {
            cell.Error = $"{e.GetType().Name}: {e.Message}";
            cell.Status = "error";
            return;
        }

        // Phase 2: token counting: best-effort. Failure here records the
        // error string but leaves wire/TTFB/total intact (cell.Status =
        // done_undecoded). Mirrors the Python codec_demo behaviour.
        try
        {
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
            cell.Tokens = 0;
            cell.Error = $"decode {cell.Encoding}: {e.GetType().Name}: {e.Message}";
            cell.Status = "done_undecoded";
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

    // ── SCHEMA-v1 matrix mode (mirrors matrix_run.py / matrix_run.ts) ──────
    //
    // Consumes a methodology JSON written by capture_methodology.py and emits
    // a SCHEMA-v1 result JSON keyed by (path, encoding, size, rep). Wire
    // bytes are sums of raw socket reads BEFORE Content-Encoding decompression
    // (HttpClientHandler.AutomaticDecompression = None). Decompression is
    // best-effort for token counting only and never overrides wire/TTFB.

    static string Sh(string cmd, string args)
    {
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = cmd, Arguments = args,
                RedirectStandardOutput = true, UseShellExecute = false,
            };
            using var p = System.Diagnostics.Process.Start(psi)!;
            var s = p.StandardOutput.ReadToEnd().Trim();
            p.WaitForExit(15_000);
            return s;
        }
        catch { return ""; }
    }

    static double Median(List<double> xs)
    {
        if (xs.Count == 0) return double.NaN;
        var s = xs.OrderBy(x => x).ToList();
        var m = s.Count / 2;
        return s.Count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2.0;
    }

    static int MedianInt(List<int> xs)
    {
        if (xs.Count == 0) return 0;
        var s = xs.OrderBy(x => x).ToList();
        var m = s.Count / 2;
        return s.Count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    static async Task<int> RunMatrixAsync(Args args)
    {
        if (args.MethodologyPath is null || args.OutPath is null)
        {
            Console.Error.WriteLine("matrix mode requires --methodology and --out");
            return 1;
        }

        var methodologyJson = await File.ReadAllTextAsync(args.MethodologyPath);
        using var methodology = JsonDocument.Parse(methodologyJson);
        var methodologyRoot = methodology.RootElement.Clone();

        // Repo root: derive from this assembly's path. demo-dotnet/bin/.../codec-bench.dll
        // → packages/demo-dotnet → repo root is up 2 from packages/demo-dotnet/.
        // Caller can override with absolute paths in methodology if needed.
        var asmDir = Path.GetDirectoryName(typeof(Program).Assembly.Location)!;
        var repoRoot = Path.GetFullPath(Path.Combine(asmDir, "..", "..", "..", "..", ".."));

        var promptsRel = methodologyRoot.GetProperty("workload").GetProperty("prompts_file").GetString()!;
        var promptsPath = Path.Combine(repoRoot, "packages", "bench", promptsRel);
        if (!File.Exists(promptsPath))
        {
            Console.Error.WriteLine($"prompts file not found: {promptsPath}");
            return 1;
        }
        var promptsJson = await File.ReadAllTextAsync(promptsPath);
        using var promptsDoc = JsonDocument.Parse(promptsJson);
        var prompts = promptsDoc.RootElement.GetProperty("prompts").Clone();

        var endpoint = methodologyRoot.GetProperty("engine").GetProperty("endpoint").GetString()!;
        var model = methodologyRoot.GetProperty("model").GetProperty("id").GetString()!;

        // Build the result object.
        var commit = Sh("git", "rev-parse HEAD");
        var clientBlock = new Dictionary<string, object?>
        {
            ["lang"] = "dotnet",
            ["lib_name"] = "Codec.Net",
            ["lib_version"] = typeof(Codec.StreamDecoder).Assembly.GetName().Version?.ToString() ?? "0.2.0",
            ["lib_commit"] = commit,
            ["runtime"] = $".NET {Environment.Version} / {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}",
        };
        var benchToolBlock = new Dictionary<string, object?>
        {
            ["name"] = "demo-dotnet/codec-bench MatrixRun",
            ["version"] = "0.1.0",
            ["commit"] = commit,
            ["reps"] = args.Reps,
            ["warmup_reps"] = 0,
            ["aggregation"] = "median",
            ["ttft_definition"] = "wall-clock from request POST to first received byte (HttpClient ResponseHeadersRead, before decompression)",
            ["wire_bytes_definition"] = "raw socket bytes received before any Content-Encoding decompression (HttpClientHandler.AutomaticDecompression=None)",
            ["total_ms_definition"] = "wall-clock from request POST to last byte",
        };

        // Replicate methodology with our blocks substituted (do NOT touch other fields).
        var methodologyCopy = JsonNode.Parse(methodologyJson)!.AsObject();
        methodologyCopy["client"] = JsonSerializer.SerializeToNode(clientBlock);
        methodologyCopy["bench_tool"] = JsonSerializer.SerializeToNode(benchToolBlock);

        var handler = new HttpClientHandler { AutomaticDecompression = System.Net.DecompressionMethods.None };
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(180) };

        var rows = new List<Dictionary<string, object?>>();
        foreach (var size in args.Sizes)
        {
            if (!prompts.TryGetProperty(size.ToString(), out var promptElem))
            {
                Console.Error.WriteLine($"no canonical prompt defined for size={size}");
                return 1;
            }
            var prompt = promptElem.GetString()!;
            Console.Error.WriteLine($">>> size={size}  prompt: '{(prompt.Length > 60 ? prompt[..60] + "..." : prompt)}'");

            foreach (var (label, fmt) in Paths)
            {
                foreach (var enc in Encodings)
                {
                    var repWire = new List<int>();
                    var repTtft = new List<double>();
                    var repTotal = new List<double>();
                    int tokens = 0;
                    string? error = null;
                    for (int r = 0; r < args.Reps; r++)
                    {
                        var cell = new Cell
                        {
                            PathLabel = label, Format = fmt, Encoding = enc, Status = "pending",
                        };
                        var thisArgs = new Args
                        {
                            Url = endpoint, Model = model, Prompt = prompt, MaxTokens = size,
                        };
                        await RunOne(http, thisArgs, cell);
                        // Both "done" and "done_undecoded" land wire/TTFB/total.
                        // Only hard "error" status (HTTP failure, etc.) skips them.
                        if ((cell.Status == "done" || cell.Status == "done_undecoded")
                            && cell.WireBytes is not null)
                        {
                            repWire.Add(cell.WireBytes.Value);
                            if (cell.TtfbMs.HasValue) repTtft.Add(cell.TtfbMs.Value);
                            if (cell.TotalMs.HasValue) repTotal.Add(cell.TotalMs.Value);
                            tokens = Math.Max(tokens, cell.Tokens);
                            // Surface decode error on the row so reviewers see it.
                            if (cell.Status == "done_undecoded" && cell.Error is not null)
                                error = cell.Error;
                        }
                        else
                        {
                            error = cell.Error;
                        }
                    }

                    var row = new Dictionary<string, object?>
                    {
                        ["size"] = size,
                        ["format"] = fmt,
                        ["encoding"] = enc,
                        ["wire_bytes"] = repWire.Count > 0 ? (int?)MedianInt(repWire) : null,
                        ["ttft_ms"] = repTtft.Count > 0 ? (double?)Median(repTtft) : null,
                        ["total_ms"] = repTotal.Count > 0 ? (double?)Median(repTotal) : null,
                        ["tokens_emitted"] = tokens,
                        ["rep_wire_bytes"] = repWire,
                        ["rep_ttft_ms"] = repTtft,
                        ["rep_total_ms"] = repTotal,
                        ["error"] = error,
                    };
                    rows.Add(row);
                    Console.Error.WriteLine(
                        $"    {label,-25} {enc,-8} size={size,5}  wire={row["wire_bytes"]}  " +
                        $"ttft={(repTtft.Count > 0 ? Median(repTtft).ToString("F1") : "-")}  " +
                        $"total={(repTotal.Count > 0 ? Median(repTotal).ToString("F1") : "-")}  tokens={tokens}");
                }
            }
        }

        var output = new JsonObject
        {
            ["schema_version"] = "1",
            ["methodology"] = methodologyCopy,
            ["rows"] = JsonSerializer.SerializeToNode(rows),
        };

        Directory.CreateDirectory(Path.GetDirectoryName(args.OutPath)!);
        await File.WriteAllTextAsync(args.OutPath,
            output.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Console.Error.WriteLine($"\nwrote {args.OutPath} ({rows.Count} rows)");
        return 0;
    }

    /// <summary>
    /// Resolve <c>&lt;repo-root&gt;/dictionaries/</c> relative to this
    /// assembly. Mirrors the path-walk in
    /// <c>RunMatrixAsync</c>: codec-bench.dll lives at
    /// <c>packages/demo-dotnet/bin/.../codec-bench.dll</c>, so the repo
    /// root is five hops up.
    /// </summary>
    static string ResolveDictionariesDir()
    {
        var asmDir = Path.GetDirectoryName(typeof(Program).Assembly.Location)!;
        var repoRoot = Path.GetFullPath(Path.Combine(asmDir, "..", "..", "..", "..", ".."));
        return Path.Combine(repoRoot, "dictionaries");
    }

    public static async Task<int> Main(string[] argv)
    {
        // Token-bench subcommand: dispatch before normal arg parsing so
        // the token-bench has its own --map / --corpus / --reps flags.
        if (argv.Length > 0 && argv[0] == "token-bench")
            return TokenBench.Run(argv.Skip(1).ToArray());

        var args = ParseArgs(argv);

        // Load reference zstd dicts so the client can decompress dict-zstd
        // responses. The bench harness ships the canonical Qwen2.5 dicts
        // at repo-root/dictionaries/. If the server is configured to use a
        // different dict, the wire/ttft numbers still land: only the
        // decoded-tokens count drops to 0 and the row carries a
        // Codec-Zstd-Dict mismatch error so reviewers see it.
        // Mirrors codec_demo.matrix_run (Python) and the TS bench.
        var dictDir = ResolveDictionariesDir();
        LoadZstdDictFiles(
            Path.Combine(dictDir, "qwen2.5-synth-msgpack-v1.dict"),
            Path.Combine(dictDir, "qwen2.5-synth-protobuf-v1.dict"));

        // Dispatch: if --methodology is given, run the SCHEMA-v1 matrix
        // mode. Otherwise fall through to the legacy ad-hoc grid bench
        // (kept for quick interactive use; not part of the cross-stack
        // matrix harness).
        if (args.MethodologyPath is not null)
            return await RunMatrixAsync(args);

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
