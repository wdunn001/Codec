// SPDX-License-Identifier: MIT
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;
using Codec;

namespace Codec.Net.Tests;

public class SafetyPolicyTests
{
    private const string Origin = "https://acme.test";

    private static SafetyPolicyDescriptor BuildValid() => new()
    {
        Id = "acme/strict-v3",
        Version = "1",
        Tokenizers = new[] { "meta-llama/llama-3" },
        Categories = new[]
        {
            new SafetyCategory { Name = "secrets", Action = "stop" },
            new SafetyCategory { Name = "pii", Action = "redact", Description = "Email and phone." },
        },
        Classifier = new SafetyClassifierBlock
        {
            Family = "llama-guard-3-1b",
            Host = "server",
            RequiresEngineFeatures = new[] { "logits_processor", "sampling_chain" },
        },
        RulesSummary = new SafetyRulesSummary
        {
            BannedTokenIdCount = 4128,
            RegexPatternCount = 47,
        },
        ClientHooks = new SafetyClientHooksBlock
        {
            PrefilterCategories = new[] { "secrets", "pii" },
            ClientClassifierFamily = "prompt-guard-86m",
        },
        PublishedAt = "2026-05-09T00:00:00Z",
    };

    private static byte[] Serialize(SafetyPolicyDescriptor d)
        => SafetyPolicy.CanonicalBytes(d);

    private static byte[] SerializeJson(object o)
        => JsonSerializer.SerializeToUtf8Bytes(o);

    // ── Validation ─────────────────────────────────────────────────────────

    [Fact]
    public void Validate_AcceptsMinimalValidDescriptor()
    {
        var bytes = Serialize(BuildValid());
        using var doc = JsonDocument.Parse(bytes);
        SafetyPolicy.Validate(doc.RootElement);  // no throw
    }

    [Fact]
    public void Validate_RejectsMissingRequiredFields()
    {
        using var doc = JsonDocument.Parse("{}");
        Assert.Throws<SafetyPolicyValidationException>(() => SafetyPolicy.Validate(doc.RootElement));
    }

    [Fact]
    public void Validate_RejectsBadCategoryName()
    {
        using var doc = JsonDocument.Parse(SerializeJson(new
        {
            id = "x/y",
            version = "1",
            tokenizers = new[] { "t" },
            categories = new[] { new { name = "BadCaps", action = "stop" } },
            classifier = new { family = "f" },
        }));
        Assert.Throws<SafetyPolicyValidationException>(() => SafetyPolicy.Validate(doc.RootElement));
    }

    [Fact]
    public void Validate_RejectsUnknownAction()
    {
        using var doc = JsonDocument.Parse(SerializeJson(new
        {
            id = "x/y",
            version = "1",
            tokenizers = new[] { "t" },
            categories = new[] { new { name = "secrets", action = "banhammer" } },
            classifier = new { family = "f" },
        }));
        Assert.Throws<SafetyPolicyValidationException>(() => SafetyPolicy.Validate(doc.RootElement));
    }

    [Fact]
    public void Validate_RejectsUnknownEngineFeature()
    {
        using var doc = JsonDocument.Parse(SerializeJson(new
        {
            id = "x/y",
            version = "1",
            tokenizers = new[] { "t" },
            categories = new[] { new { name = "secrets", action = "stop" } },
            classifier = new { family = "f", requires_engine_features = new[] { "weather_api" } },
        }));
        Assert.Throws<SafetyPolicyValidationException>(() => SafetyPolicy.Validate(doc.RootElement));
    }

    // ── Hashing ────────────────────────────────────────────────────────────

    [Fact]
    public void Hash_IsDeterministicForIdenticalInput()
    {
        var d = BuildValid();
        Assert.Equal(SafetyPolicy.Hash(d), SafetyPolicy.Hash(d));
        Assert.StartsWith("sha256:", SafetyPolicy.Hash(d));
        Assert.Equal(64, SafetyPolicy.Hash(d).Substring(7).Length);
    }

    [Fact]
    public void Hash_DiffersWhenCategoryActionChanges()
    {
        var d1 = BuildValid();
        var d2 = d1 with
        {
            Categories = new[]
            {
                new SafetyCategory { Name = "secrets", Action = "flag" },
                new SafetyCategory { Name = "pii", Action = "redact", Description = "Email and phone." },
            },
        };
        Assert.NotEqual(SafetyPolicy.Hash(d1), SafetyPolicy.Hash(d2));
    }

    [Fact]
    public void CanonicalBytes_2SpaceIndentTrailingNewline()
    {
        var raw = SafetyPolicy.CanonicalBytes(BuildValid());
        var text = Encoding.UTF8.GetString(raw);
        Assert.EndsWith("\n", text);
        Assert.Contains("\n  ", text);
        // Round-trips through JSON.
        using var doc = JsonDocument.Parse(text);
        Assert.Equal(JsonValueKind.Object, doc.RootElement.ValueKind);
    }

    // ── URL builders ───────────────────────────────────────────────────────

    [Fact]
    public void WellKnownPolicyUrl_PreservesSlashes()
    {
        Assert.Equal(
            "https://acme.example/.well-known/codec/policies/acme/strict-v3.json",
            SafetyPolicy.WellKnownPolicyUrl("https://acme.example/", "acme/strict-v3"));
    }

    [Fact]
    public void WellKnownPolicyUrl_RejectsTraversal()
    {
        Assert.Throws<SafetyPolicyDiscoveryException>(
            () => SafetyPolicy.WellKnownPolicyUrl("https://acme.example", "../etc"));
        Assert.Throws<SafetyPolicyDiscoveryException>(
            () => SafetyPolicy.WellKnownPolicyUrl("https://acme.example", "/abs"));
        Assert.Throws<SafetyPolicyDiscoveryException>(
            () => SafetyPolicy.WellKnownPolicyUrl("https://acme.example", "trailing/"));
    }

    [Fact]
    public void WellKnownPolicyUrl_RejectsBadCharset()
    {
        Assert.Throws<SafetyPolicyDiscoveryException>(
            () => SafetyPolicy.WellKnownPolicyUrl("https://acme.example", "Acme/Strict"));
    }

    [Fact]
    public void WellKnownPolicyHashUrl_UsesSha256Path()
    {
        var hex = new string('a', 64);
        Assert.Equal(
            $"https://acme.example/.well-known/codec/policies/sha256/{hex}.json",
            SafetyPolicy.WellKnownPolicyHashUrl("https://acme.example", hex));
    }

    [Fact]
    public void WellKnownPolicyHashUrl_RejectsMalformedHex()
    {
        Assert.Throws<SafetyPolicyDiscoveryException>(
            () => SafetyPolicy.WellKnownPolicyHashUrl("https://acme.example", "not-hex"));
    }

    // ── Loader (mock HttpClient) ───────────────────────────────────────────

    private static HttpClient MakeMockHttp(Dictionary<string, (HttpStatusCode status, byte[] body)> routes)
    {
        var handler = new MockHandler(routes);
        return new HttpClient(handler);
    }

    private sealed class MockHandler : HttpMessageHandler
    {
        private readonly Dictionary<string, (HttpStatusCode status, byte[] body)> _routes;
        public MockHandler(Dictionary<string, (HttpStatusCode, byte[])> routes) { _routes = routes; }
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.ToString();
            if (_routes.TryGetValue(url, out var route))
            {
                return Task.FromResult(new HttpResponseMessage(route.status)
                {
                    Content = new ByteArrayContent(route.body),
                });
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }

    [Fact]
    public async Task LoadAsync_FetchesAndValidates()
    {
        var url = $"{Origin}/policies/acme.json";
        var bytes = SafetyPolicy.CanonicalBytes(BuildValid());
        using var http = MakeMockHttp(new() { [url] = (HttpStatusCode.OK, bytes) });
        var d = await SafetyPolicy.LoadAsync(url, http: http);
        Assert.Equal("acme/strict-v3", d.Id);
    }

    [Fact]
    public async Task LoadAsync_VerifiesHash()
    {
        var url = $"{Origin}/policies/acme.json";
        var bytes = SafetyPolicy.CanonicalBytes(BuildValid());
        var hex = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var goodHash = $"sha256:{hex}";
        using var http = MakeMockHttp(new() { [url] = (HttpStatusCode.OK, bytes) });
        var d = await SafetyPolicy.LoadAsync(url, hash: goodHash, http: http);
        Assert.Equal("acme/strict-v3", d.Id);

        var wrongHash = "sha256:" + new string('b', 64);
        using var http2 = MakeMockHttp(new() { [url] = (HttpStatusCode.OK, bytes) });
        await Assert.ThrowsAsync<SafetyPolicyHashMismatchException>(
            () => SafetyPolicy.LoadAsync(url, hash: wrongHash, http: http2));
    }

    // ── Discovery ──────────────────────────────────────────────────────────

    [Fact]
    public async Task DiscoverAsync_ResolvesInlineDescriptor()
    {
        var url = SafetyPolicy.WellKnownPolicyUrl(Origin, "acme/strict-v3");
        var bytes = SafetyPolicy.CanonicalBytes(BuildValid());
        using var http = MakeMockHttp(new() { [url] = (HttpStatusCode.OK, bytes) });
        var d = await SafetyPolicy.DiscoverAsync(Origin, "acme/strict-v3", http: http);
        Assert.Equal("acme/strict-v3", d.Id);
    }

    [Fact]
    public async Task DiscoverAsync_404RaisesNotFound()
    {
        using var http = MakeMockHttp(new());
        await Assert.ThrowsAsync<SafetyPolicyDiscoveryNotFoundException>(
            () => SafetyPolicy.DiscoverAsync(Origin, "acme/strict-v3", http: http));
    }

    [Fact]
    public async Task DiscoverAsync_WithHashHitsContentAddressedSibling()
    {
        var bytes = SafetyPolicy.CanonicalBytes(BuildValid());
        var hex = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var hashUrl = SafetyPolicy.WellKnownPolicyHashUrl(Origin, hex);
        using var http = MakeMockHttp(new() { [hashUrl] = (HttpStatusCode.OK, bytes) });
        var d = await SafetyPolicy.DiscoverAsync(Origin, "acme/strict-v3", $"sha256:{hex}", http: http);
        Assert.Equal("acme/strict-v3", d.Id);
    }

    [Fact]
    public async Task DiscoverAsync_WithHashRejectsBytesMismatch()
    {
        var wrongHex = new string('c', 64);
        var hashUrl = SafetyPolicy.WellKnownPolicyHashUrl(Origin, wrongHex);
        // The fetched bytes hash to something OTHER than wrongHex.
        var bytes = SafetyPolicy.CanonicalBytes(BuildValid());
        using var http = MakeMockHttp(new() { [hashUrl] = (HttpStatusCode.OK, bytes) });
        await Assert.ThrowsAsync<SafetyPolicyHashMismatchException>(
            () => SafetyPolicy.DiscoverAsync(Origin, "acme/strict-v3", $"sha256:{wrongHex}", http: http));
    }

    [Fact]
    public async Task DiscoverAsync_RejectsInlineIdMismatch()
    {
        var url = SafetyPolicy.WellKnownPolicyUrl(Origin, "acme/strict-v3");
        var d = BuildValid() with { Id = "someone-else/v1" };
        var bytes = SafetyPolicy.CanonicalBytes(d);
        using var http = MakeMockHttp(new() { [url] = (HttpStatusCode.OK, bytes) });
        await Assert.ThrowsAsync<SafetyPolicyDiscoveryException>(
            () => SafetyPolicy.DiscoverAsync(Origin, "acme/strict-v3", http: http));
    }

    [Fact]
    public void RoundTrip_DescriptorBytesParse()
    {
        var d = BuildValid();
        var bytes = SafetyPolicy.CanonicalBytes(d);
        var d2 = SafetyPolicy.FromJson(bytes);
        Assert.Equal(d.Id, d2.Id);
        Assert.Equal(d.Categories.Count, d2.Categories.Count);
        Assert.Equal(d.Classifier.Family, d2.Classifier.Family);
    }
}
