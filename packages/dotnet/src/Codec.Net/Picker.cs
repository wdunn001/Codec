// SPDX-License-Identifier: MIT
//
// Picker.cs — .NET port of the @codecai/wire-compress picker (TS reference).
//
// Mirrors packages/wire-compress/src/index.ts at v0.5.0. Decides which
// Content-Encoding (gzip / br / dict-zstd / identity) to apply to a
// streaming response given:
//
//   - the client's Accept-Encoding header
//   - the estimated payload size
//   - whether the server has a pre-trained zstd dictionary loaded for the
//     (tokenizer_id, stream_format) of THIS request
//   - whether the gateway middleware uses streaming-zstd-with-flush
//     (not buffered finalisation)
//
// The hard rule (cross-language): dictless zstd is NEVER chosen. It has
// roughly the same compression ratio as gzip on Codec / small-JSON
// envelopes (bench/RESULTS.md §1f) but +334× TTFT on shipped buffered
// middleware (RESULTS.md §1d). Dict-trained zstd hits 60-80% on small
// JSON envelopes; dictless misses 30%. So:
//
//   zstd     → only when `ZstdHasDict=true` AND `ZstdEnabled=true`
//                AND the client advertised zstd
//   gzip     → universal default whenever any zstd gate fails
//   brotli   → fallback only (gzip is preferred over br at every size on
//              streaming small-frame workloads)
//   identity → last resort
//
// This file MUST stay in lock-step with the TS reference. The conformance
// suite in test/Codec.Net.Tests/PickerConformanceTests.cs replays the
// shared vector set at packages/wire-compress/test/conformance-vectors.json
// against this picker; CI fails if any case diverges.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Codec.Wire;

/// <summary>Content-Encoding values the picker chooses between.</summary>
public enum Encoding
{
    Identity,
    Gzip,
    Br,
    Zstd,
}

/// <summary>
/// Closed enum of pick() decisions (v0.5 contract). Use this for dashboard
/// grouping; the <see cref="PickResult.Reason"/> string carries the
/// human-readable expansion. Additive only — never reassign, never remove.
/// </summary>
public enum PickReasonCode
{
    /// <summary>Both zstd gates passed, no per-stack override.</summary>
    DictZstdDefault,
    /// <summary>Per-stack profile downgraded zstd (e.g. sglang ttftRatio > threshold).</summary>
    PerStackOverrodeZstd,
    /// <summary>Zstd gated off because client didn't advertise it.</summary>
    GzipNoZstdInAccept,
    /// <summary>Zstd gated off because ZstdHasDict=false (no dict for this request).</summary>
    GzipNoDict,
    /// <summary>Zstd gated off because ZstdEnabled=false (middleware not confirmed streaming).</summary>
    GzipMiddlewareDisabled,
    /// <summary>Content sample suggested low entropy + br outperforms gzip on that.</summary>
    BrContentSampleLowEntropy,
    /// <summary>Br is the only non-identity option (no gzip / no zstd accepted).</summary>
    BrFallbackNoGzip,
    /// <summary>Per-stack profile downgraded br (e.g. sglang's broken per-frame compression).</summary>
    PerStackOverrodeBr,
    /// <summary>Client supports nothing compressible. Last-resort.</summary>
    IdentityLastResort,
}

/// <summary>
/// Per-encoding measured compression characteristics for a specific
/// gateway stack. Mirrors the TS <c>EncodingChars</c> struct.
/// </summary>
public readonly record struct EncodingChars(double WireCoeff, double TtftRatio);

/// <summary>
/// Per-stack measured compression characteristics. Lets the picker tune
/// itself for the gateway it's actually running behind instead of
/// assuming sglang-shaped numbers everywhere. Mirrors the TS
/// <c>StackProfile</c> struct.
/// </summary>
public sealed class StackProfile
{
    public StackProfile(string name, IReadOnlyDictionary<Encoding, EncodingChars> encodings)
    {
        Name = name;
        Encodings = encodings;
    }

    /// <summary>Stack name, for logging/diagnostics.</summary>
    public string Name { get; }

    /// <summary>
    /// Per-encoding characterisation. Encodings missing here are assumed
    /// unsupported. Keys must be one of <see cref="Encoding.Gzip"/>,
    /// <see cref="Encoding.Br"/>, <see cref="Encoding.Zstd"/>.
    /// </summary>
    public IReadOnlyDictionary<Encoding, EncodingChars> Encodings { get; }
}

/// <summary>
/// Built-in stack profiles. Mirrors the TS <c>STACK_PROFILES</c> table.
/// Values are kept in lock-step with the TS source; see the conformance
/// suite for the vector check.
/// </summary>
public static class StackProfiles
{
    /// <summary>
    /// Conservative default — assumes typical streaming-aware gzip,
    /// working zstd with the v0.5 contract (sglang/vllm/llamacpp all
    /// stream zstd correctly at v0.4.1+), and a br implementation of
    /// unknown quality.
    /// </summary>
    public static readonly StackProfile Default = new("default",
        new Dictionary<Encoding, EncodingChars>
        {
            [Encoding.Gzip] = new(0.05, 1.0),
            [Encoding.Br] = new(0.5, 1.0),
            [Encoding.Zstd] = new(0.04, 1.0),
        });

    public static readonly StackProfile Sglang = new("sglang",
        new Dictionary<Encoding, EncodingChars>
        {
            [Encoding.Gzip] = new(0.023, 1.0),
            [Encoding.Br] = new(0.733, 1.0),
            [Encoding.Zstd] = new(0.017, 1.0),
        });

    public static readonly StackProfile LlamaCpp = new("llama.cpp",
        new Dictionary<Encoding, EncodingChars>
        {
            [Encoding.Gzip] = new(1.0, 1.0),
            [Encoding.Br] = new(1.0, 1.0),
            [Encoding.Zstd] = new(1.0, 1.0),
        });

    private static readonly Dictionary<string, StackProfile> ByName =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["default"] = Default,
            ["sglang"] = Sglang,
            ["llama.cpp"] = LlamaCpp,
        };

    /// <summary>Look up a profile by stack name. Falls back to default if unknown.</summary>
    public static StackProfile For(string? stackName)
    {
        if (string.IsNullOrEmpty(stackName)) return Default;
        return ByName.TryGetValue(stackName, out var p) ? p : Default;
    }
}

/// <summary>
/// Per-stack profiles where an encoding with ttftRatio above this gets
/// dropped. Mirrors TS <c>MAX_TTFT_RATIO = 5</c>.
/// </summary>
public static class PickerConstants
{
    public const double MaxTtftRatio = 5.0;
    public const double LowEntropyThreshold = 3.0;
}

/// <summary>Parsed Accept-Encoding view.</summary>
public sealed class ClientSupport
{
    public ClientSupport(IReadOnlyList<Encoding> accepted, bool unspecified)
    {
        Accepted = accepted;
        Unspecified = unspecified;
    }

    /// <summary>Encodings the client accepts, ordered by preference (q-value desc).</summary>
    public IReadOnlyList<Encoding> Accepted { get; }

    /// <summary>True iff the client sent no Accept-Encoding at all.</summary>
    public bool Unspecified { get; }
}

/// <summary>Inputs to <see cref="Picker.Pick"/>. Mirrors TS <c>PickInput</c>.</summary>
public sealed class PickInput
{
    /// <summary>The Accept-Encoding header value, or null if absent.</summary>
    public string? AcceptEncoding { get; init; }

    /// <summary>Best estimate of total response size (tokens or bytes, calibrate to thresholds).</summary>
    public int EstimatedSize { get; init; }

    /// <summary>
    /// Restrict the candidate set the server is willing to apply (e.g. if
    /// the server doesn't have a zstd encoder available). Defaults to all four.
    /// </summary>
    public IReadOnlyCollection<Encoding>? ServerSupports { get; init; }

    /// <summary>Interactive (default true) → avoids encodings that buffer the whole response.</summary>
    public bool Interactive { get; init; } = true;

    /// <summary>
    /// Explicit opt-out from zstd when middleware is known to buffer.
    /// Default true (v0.5 contract — sglang/vllm/llamacpp all stream zstd
    /// correctly at v0.4.1+; operators with confirmed buffered-zstd
    /// middleware MUST set this false).
    /// </summary>
    public bool ZstdEnabled { get; init; } = true;

    /// <summary>
    /// Whether the server has a pre-trained zstd dict loaded for THIS
    /// request's (tokenizer_id, stream_format). The primary zstd gate.
    /// Default false — without a dict, no-dict zstd is NEVER chosen
    /// (same bytes as gzip, much worse TTFB on buffered middleware).
    /// </summary>
    public bool ZstdHasDict { get; init; }

    /// <summary>Optional per-stack profile. Defaults to <see cref="StackProfiles.Default"/>.</summary>
    public StackProfile? StackProfile { get; init; }

    /// <summary>
    /// Optional content sample (first N bytes of the response). When
    /// provided AND both br + zstd are viable, low-entropy → br,
    /// high-entropy → dict-zstd.
    /// </summary>
    public ReadOnlyMemory<byte>? SampleBytes { get; init; }
}

/// <summary>Output of <see cref="Picker.Pick"/>. Mirrors TS <c>PickOutput</c>.</summary>
public sealed class PickResult
{
    public PickResult(Encoding encoding, PickReasonCode reasonCode, string reason,
        IReadOnlyList<Encoding> considered)
    {
        Encoding = encoding;
        ReasonCode = reasonCode;
        Reason = reason;
        Considered = considered;
    }

    public Encoding Encoding { get; }
    public PickReasonCode ReasonCode { get; }
    public string Reason { get; }
    public IReadOnlyList<Encoding> Considered { get; }
}

/// <summary>
/// The wire-compress picker. Static class; instances aren't useful.
/// See file header for the cross-language contract.
/// </summary>
public static class Picker
{
    private static readonly Regex QValueRe = new(@"^q\s*=\s*([0-9.]+)$", RegexOptions.Compiled);

    /// <summary>
    /// Parse an Accept-Encoding header into an ordered list of encodings
    /// the client accepts, dropping anything with q=0 and sorting by
    /// q-value desc. Mirrors TS <c>parseAcceptEncoding</c>.
    /// </summary>
    public static ClientSupport ParseAcceptEncoding(string? header)
    {
        if (header is null)
            return new ClientSupport(new[] { Encoding.Identity }, unspecified: true);

        var parts = header.Split(',', StringSplitOptions.RemoveEmptyEntries);
        var trimmed = new List<string>(parts.Length);
        foreach (var p in parts)
        {
            var t = p.Trim();
            if (t.Length > 0) trimmed.Add(t);
        }
        if (trimmed.Count == 0)
            return new ClientSupport(new[] { Encoding.Identity }, unspecified: false);

        var entries = new List<(string Name, double Q, int Order)>();
        bool starSeen = false;
        double starQ = 0;
        int orderCounter = 0;

        foreach (var part in trimmed)
        {
            var segs = part.Split(';');
            var rawName = segs[0].Trim().ToLowerInvariant();
            double q = 1.0;
            for (int i = 1; i < segs.Length; i++)
            {
                var m = QValueRe.Match(segs[i].Trim());
                if (m.Success &&
                    double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var qv))
                {
                    q = qv;
                }
            }
            if (rawName == "*")
            {
                starSeen = true;
                starQ = q;
                continue;
            }
            if (q > 0) entries.Add((rawName, q, orderCounter++));
        }

        // Stable sort by q desc (use Order as tiebreaker for stability).
        entries.Sort((a, b) =>
        {
            int cmp = b.Q.CompareTo(a.Q);
            return cmp != 0 ? cmp : a.Order.CompareTo(b.Order);
        });

        var accepted = new List<Encoding>();
        foreach (var (name, _, _) in entries)
        {
            if (TryParseEncoding(name, out var e) && !accepted.Contains(e))
                accepted.Add(e);
        }

        // identity is implicit unless explicitly disabled.
        bool identityForbidden = false;
        foreach (var part in trimmed)
        {
            if (Regex.IsMatch(part, @"^identity\s*;\s*q\s*=\s*0", RegexOptions.IgnoreCase))
            {
                identityForbidden = true;
                break;
            }
        }
        if (!identityForbidden && starSeen && starQ == 0 && accepted.Count == 0)
            identityForbidden = true;
        if (!identityForbidden && !accepted.Contains(Encoding.Identity))
            accepted.Add(Encoding.Identity);

        return new ClientSupport(accepted, unspecified: false);
    }

    /// <summary>Pick the best Content-Encoding for a streaming response.</summary>
    public static PickResult Pick(PickInput input)
    {
        var stack = input.StackProfile ?? StackProfiles.Default;
        var serverCandidates = new HashSet<Encoding>(
            input.ServerSupports ?? new[] { Encoding.Identity, Encoding.Gzip, Encoding.Br, Encoding.Zstd });

        var client = ParseAcceptEncoding(input.AcceptEncoding);
        var candidates = new HashSet<Encoding>();
        foreach (var enc in client.Accepted)
            if (serverCandidates.Contains(enc)) candidates.Add(enc);

        // ── Stage 1: hard zstd gates ────────────────────────────────────────
        PickReasonCode? droppedZstdReason = null;
        if (!candidates.Contains(Encoding.Zstd))
        {
            droppedZstdReason = PickReasonCode.GzipNoZstdInAccept;
        }
        else if (!input.ZstdHasDict)
        {
            candidates.Remove(Encoding.Zstd);
            droppedZstdReason = PickReasonCode.GzipNoDict;
        }
        else if (!input.ZstdEnabled)
        {
            candidates.Remove(Encoding.Zstd);
            droppedZstdReason = PickReasonCode.GzipMiddlewareDisabled;
        }

        // ── Stage 2: per-stack profile drops ────────────────────────────────
        bool perStackOverrodeZstd = false;
        bool perStackOverrodeBr = false;
        foreach (var enc in new[] { Encoding.Zstd, Encoding.Br, Encoding.Gzip })
        {
            if (!candidates.Contains(enc)) continue;
            if (stack.Encodings.TryGetValue(enc, out var chars)
                && chars.TtftRatio > PickerConstants.MaxTtftRatio)
            {
                candidates.Remove(enc);
                if (enc == Encoding.Zstd) perStackOverrodeZstd = true;
                if (enc == Encoding.Br) perStackOverrodeBr = true;
            }
        }

        var considered = new List<Encoding>(candidates);
        considered.Sort((a, b) => string.Compare(EncodingName(a), EncodingName(b), StringComparison.Ordinal));

        // ── Stage 3: content-aware tiebreaker ───────────────────────────────
        if (input.SampleBytes is { } sample
            && sample.Length > 0
            && candidates.Contains(Encoding.Br)
            && candidates.Contains(Encoding.Zstd))
        {
            double ent = ShannonEntropyBitsPerByte(sample.Span);
            if (ent < PickerConstants.LowEntropyThreshold)
            {
                return new PickResult(
                    Encoding.Br,
                    PickReasonCode.BrContentSampleLowEntropy,
                    $"br (content sample entropy={ent.ToString("F2", CultureInfo.InvariantCulture)} < {PickerConstants.LowEntropyThreshold}; "
                    + $"{(input.Interactive ? "interactive" : "agent")}; size={input.EstimatedSize})",
                    considered);
            }
            // High entropy → fall through to the default zstd-wins branch.
        }

        if (candidates.Contains(Encoding.Zstd))
        {
            return new PickResult(
                Encoding.Zstd,
                PickReasonCode.DictZstdDefault,
                $"dict-zstd (both gates passed; stack={stack.Name}; "
                + $"{(input.Interactive ? "interactive" : "agent")}; size={input.EstimatedSize})",
                considered);
        }

        if (perStackOverrodeZstd && candidates.Contains(Encoding.Gzip))
        {
            return new PickResult(
                Encoding.Gzip,
                PickReasonCode.PerStackOverrodeZstd,
                $"gzip (stack={stack.Name} ttftRatio for zstd > {PickerConstants.MaxTtftRatio}; "
                + $"size={input.EstimatedSize})",
                considered);
        }

        if (candidates.Contains(Encoding.Gzip))
        {
            var code = droppedZstdReason ?? PickReasonCode.GzipNoZstdInAccept;
            return new PickResult(
                Encoding.Gzip,
                code,
                $"gzip ({ReasonText(code)}; stack={stack.Name}; size={input.EstimatedSize})",
                considered);
        }

        if (candidates.Contains(Encoding.Br))
        {
            return new PickResult(
                Encoding.Br,
                PickReasonCode.BrFallbackNoGzip,
                $"br fallback (no gzip in candidate set; stack={stack.Name}; size={input.EstimatedSize})",
                considered);
        }

        _ = perStackOverrodeBr;
        return new PickResult(
            Encoding.Identity,
            PickReasonCode.IdentityLastResort,
            $"client supports nothing compressible; identity (stack={stack.Name})",
            considered);
    }

    /// <summary>Build the Accept-Encoding header a client should send.</summary>
    public static string BuildAcceptEncoding(bool gzip = true, bool br = true, bool zstd = false)
    {
        var parts = new List<string>(3);
        if (gzip) parts.Add("gzip;q=1.0");
        if (br) parts.Add("br;q=0.5");
        if (zstd) parts.Add("zstd;q=0.3");
        return string.Join(", ", parts);
    }

    /// <summary>
    /// Pretty-print the threshold rule for documentation / log lines.
    /// Kept in sync with the TS <c>describeRule</c> output line-for-line.
    /// </summary>
    public static string DescribeRule() =>
        string.Join('\n', new[]
        {
            "wire-compress policy:",
            "  zstd     → chosen ONLY when both gates pass for this request:",
            "              1. ZstdHasDict: server has a pre-trained dict for the",
            "                 (tokenizer_id, stream_format) of this response",
            "              2. ZstdEnabled: middleware uses streaming-zstd-with-flush",
            "                 (not buffered finalisation; see RESULTS.md §1d)",
            "             with both true, zstd-with-dict beats gzip on bytes (16-38%",
            "             smaller, RESULTS.md §1g) at +0.13 ms streaming-TTFB",
            "  gzip     → universal default; what you ship when no dict is loaded.",
            "             zstd-no-dict is NEVER chosen — bytes ≈ gzip but TTFB cliff",
            "             on shipped middleware. Dict is the precondition, not an",
            "             optimization on top.",
            "  brotli   → fallback when client doesn't accept gzip (Safari/iOS edge)",
            "  identity → last resort only",
        });

    /// <summary>
    /// Shannon entropy in bits/byte. Uniform random ≈ 8.0; English text
    /// ≈ 4-5; long runs of one byte → near 0.
    /// </summary>
    public static double ShannonEntropyBitsPerByte(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length == 0) return 0.0;
        Span<int> counts = stackalloc int[256];
        foreach (var b in bytes) counts[b]++;
        double h = 0.0;
        double n = bytes.Length;
        for (int b = 0; b < 256; b++)
        {
            int c = counts[b];
            if (c == 0) continue;
            double p = c / n;
            h -= p * Math.Log2(p);
        }
        return h;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    internal static bool TryParseEncoding(string s, out Encoding enc)
    {
        switch (s)
        {
            case "identity": enc = Encoding.Identity; return true;
            case "gzip": enc = Encoding.Gzip; return true;
            case "br": enc = Encoding.Br; return true;
            case "zstd": enc = Encoding.Zstd; return true;
            default: enc = Encoding.Identity; return false;
        }
    }

    /// <summary>Wire-format name (matches the TS <c>Encoding</c> string literals).</summary>
    public static string EncodingName(Encoding enc) => enc switch
    {
        Encoding.Identity => "identity",
        Encoding.Gzip => "gzip",
        Encoding.Br => "br",
        Encoding.Zstd => "zstd",
        _ => throw new ArgumentOutOfRangeException(nameof(enc)),
    };

    /// <summary>Reason-code wire-format name (matches the TS <c>PickReasonCode</c> string literals).</summary>
    public static string ReasonCodeName(PickReasonCode code) => code switch
    {
        PickReasonCode.DictZstdDefault => "dict_zstd_default",
        PickReasonCode.PerStackOverrodeZstd => "per_stack_overrode_zstd",
        PickReasonCode.GzipNoZstdInAccept => "gzip_no_zstd_in_accept",
        PickReasonCode.GzipNoDict => "gzip_no_dict",
        PickReasonCode.GzipMiddlewareDisabled => "gzip_middleware_disabled",
        PickReasonCode.BrContentSampleLowEntropy => "br_content_sample_low_entropy",
        PickReasonCode.BrFallbackNoGzip => "br_fallback_no_gzip",
        PickReasonCode.PerStackOverrodeBr => "per_stack_overrode_br",
        PickReasonCode.IdentityLastResort => "identity_last_resort",
        _ => throw new ArgumentOutOfRangeException(nameof(code)),
    };

    private static string ReasonText(PickReasonCode code) => code switch
    {
        PickReasonCode.GzipNoZstdInAccept => "no zstd in client Accept-Encoding",
        PickReasonCode.GzipNoDict => "no dict for this request",
        PickReasonCode.GzipMiddlewareDisabled => "middleware not confirmed streaming",
        _ => ReasonCodeName(code),
    };
}
