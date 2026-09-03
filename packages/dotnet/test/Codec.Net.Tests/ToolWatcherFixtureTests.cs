// SPDX-License-Identifier: MIT
//
// Fixture-driven ToolWatcher conformance tests.
//
// packages/tool-watcher-conformance/fixtures/tool-watcher-events.json is
// the cross-language source of truth for the event contract: every Codec
// ToolWatcher implementation must reproduce it exactly. Every case there
// runs here too, generically, so this file can't silently fall out of
// sync with it the way a hand-mirrored test can. See ToolWatcherTests.cs
// for the hand-written tests covering .NET-specific concerns (the int[]
// overload, exception types, etc.); those stay, this is additive.
//
// Mirrors packages/web/test/tool-watcher.test.ts and
// packages/python/tests/test_tool_watcher.py's fixture loaders. Uses
// System.Text.Json (BCL, no new package reference) to read the fixture.
using System.Text.Json;
using System.Text.Json.Serialization;
using Xunit;

namespace Codec.Tests;

file sealed class FixtureRoot
{
    [JsonPropertyName("start_id")]
    public uint StartId { get; init; }

    [JsonPropertyName("end_id")]
    public uint EndId { get; init; }

    [JsonPropertyName("cases")]
    public List<FixtureCase> Cases { get; init; } = new();
}

file sealed class FixtureCase
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("region_cap")]
    public int? RegionCap { get; init; }

    [JsonPropertyName("feeds")]
    public List<List<uint>> Feeds { get; init; } = new();

    [JsonPropertyName("end")]
    public EndSpec? End { get; init; }

    [JsonPropertyName("events")]
    public List<EventSpec> Events { get; init; } = new();
}

file sealed class EndSpec
{
    [JsonPropertyName("finish_reason")]
    public string? FinishReason { get; init; }
}

file sealed class EventSpec
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "";

    [JsonPropertyName("ids")]
    public List<uint> Ids { get; init; } = new();

    [JsonPropertyName("finish_reason")]
    public string? FinishReason { get; init; }
}

/// <summary>Normalized event: kind name, ids, and (only for "truncated") finish reason.</summary>
file sealed record NormEvent(string Kind, IReadOnlyList<uint> Ids, string? FinishReason)
{
    public bool Equals(NormEvent? other) =>
        other is not null && Kind == other.Kind && Ids.SequenceEqual(other.Ids) && FinishReason == other.FinishReason;

    public override int GetHashCode() => Kind.GetHashCode();

    public override string ToString() =>
        $"{{kind={Kind}, ids=[{string.Join(",", Ids)}], finishReason={FinishReason ?? "null"}}}";
}

public class ToolWatcherFixtureTests
{
    private static readonly Lazy<FixtureRoot> Fixture = new(LoadFixture);

    private static string FindFixturePath()
    {
        var env = Environment.GetEnvironmentVariable("CODEC_FIXTURE_PATH");
        if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;

        // Walk up from the test binary's output directory until we find
        // the repo root (identified by packages/tool-watcher-conformance).
        // Robust to Debug/Release and any future obj/bin layout change,
        // unlike a fixed "../../../.." chain.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "packages", "tool-watcher-conformance",
                "fixtures", "tool-watcher-events.json");
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new FileNotFoundException(
            "could not locate tool-watcher-events.json by walking up from " + AppContext.BaseDirectory +
            "; set CODEC_FIXTURE_PATH to override");
    }

    private static FixtureRoot LoadFixture()
    {
        var path = FindFixturePath();
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<FixtureRoot>(json)
            ?? throw new InvalidOperationException($"failed to parse fixture at {path}");
    }

    private static TokenizerMap FixtureMap(uint startId, uint endId) => new()
    {
        Id = "test/fixture",
        Version = "2",
        VocabSize = 100,
        Encoder = "byte_level",
        Vocab = new(),
        SpecialTokens = new() { ["<start>"] = (int)startId, ["<end>"] = (int)endId },
    };

    /// <summary>
    /// Maps every WatcherEventKind to the fixture's string form. The
    /// default arm throws rather than silently dropping or
    /// miscategorizing an event of an unrecognized kind: a new enum
    /// variant must be handled here explicitly.
    /// </summary>
    private static string KindStr(WatcherEventKind kind) => kind switch
    {
        WatcherEventKind.Passthrough => "passthrough",
        WatcherEventKind.Region => "region",
        WatcherEventKind.Truncated => "truncated",
        WatcherEventKind.Overflow => "overflow",
        WatcherEventKind.NestedStart => "nested_start",
        _ => throw new InvalidOperationException($"unhandled WatcherEventKind: {kind}"),
    };

    private static List<NormEvent> Normalize(IReadOnlyList<WatcherEvent> events)
    {
        var result = new List<NormEvent>(events.Count);
        foreach (var ev in events)
        {
            var kind = KindStr(ev.Kind);
            var finishReason = kind == "truncated" ? ev.FinishReason : null;
            result.Add(new NormEvent(kind, ev.Ids.ToArray(), finishReason));
        }
        return result;
    }

    public static IEnumerable<object[]> FixtureCaseNames()
    {
        foreach (var c in Fixture.Value.Cases)
            yield return new object[] { c.Name };
    }

    [Theory]
    [MemberData(nameof(FixtureCaseNames))]
    public void FixtureCase(string name)
    {
        var fixture = Fixture.Value;
        var c = fixture.Cases.Single(x => x.Name == name);

        var map = FixtureMap(fixture.StartId, fixture.EndId);
        var w = new ToolWatcher(map, "<start>", "<end>", c.RegionCap ?? ToolWatcher.DefaultRegionCap);

        var actual = new List<NormEvent>();
        foreach (var feedIds in c.Feeds)
            actual.AddRange(Normalize(w.Feed(feedIds)));
        if (c.End is not null)
            actual.AddRange(Normalize(w.End(c.End.FinishReason)));

        var expected = c.Events
            .Select(e => new NormEvent(e.Kind, e.Ids, e.Kind == "truncated" ? e.FinishReason : null))
            .ToList();

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void FixtureHasCases()
    {
        Assert.NotEmpty(Fixture.Value.Cases);
    }
}
