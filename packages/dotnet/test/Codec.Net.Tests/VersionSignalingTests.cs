using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Codec;
using Xunit;

namespace Codec.Net.Tests;

public class VersionSignalingTests
{
    private const string Origin = "https://server.test";

    private static HttpResponseMessage JsonResp(string body, HttpStatusCode status)
    {
        return new HttpResponseMessage(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }

    // ── AddClientVersionHeader ──────────────────────────────────────────

    [Fact]
    public void AddClientVersionHeader_StampsHeaderWhenAbsent()
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://x.test/");
        VersionSignaling.AddClientVersionHeader(req);
        Assert.Contains(
            VersionSignaling.CodecClientVersion,
            req.Headers.GetValues(VersionSignaling.CodecClientVersionHeader));
    }

    [Fact]
    public void AddClientVersionHeader_PreservesCallerSetValue()
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://x.test/");
        req.Headers.Add(VersionSignaling.CodecClientVersionHeader, "0.3");
        VersionSignaling.AddClientVersionHeader(req);
        var values = req.Headers.GetValues(VersionSignaling.CodecClientVersionHeader).ToList();
        Assert.Single(values);
        Assert.Equal("0.3", values[0]);
    }

    [Fact]
    public void AddClientVersionHeader_RespectsOverride()
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://x.test/");
        VersionSignaling.AddClientVersionHeader(req, "0.2");
        Assert.Contains("0.2",
            req.Headers.GetValues(VersionSignaling.CodecClientVersionHeader));
    }

    [Fact]
    public void WellKnownUrl_TrimsTrailingSlash()
    {
        Assert.Equal(
            "https://x.test/.well-known/codec/version-policy.json",
            VersionSignaling.WellKnownVersionPolicyUrl("https://x.test/"));
    }

    // ── ParseVersionRequiredAsync ───────────────────────────────────────

    private const string ValidBody = @"{
        ""error"": ""codec_version_required"",
        ""minimum_version"": ""0.4"",
        ""required_features"": [""safety-policy-enforcement""],
        ""client_version"": ""0.3"",
        ""docs_url"": ""https://codecai.net/docs/version-negotiation/"",
        ""deployment_id"": ""lab-test""
    }";

    [Fact]
    public async Task ParseVersionRequired_ReturnsNullForNon426()
    {
        using var resp = JsonResp("{\"ok\":true}", HttpStatusCode.OK);
        var err = await VersionSignaling.ParseVersionRequiredAsync(resp);
        Assert.Null(err);
    }

    [Fact]
    public async Task ParseVersionRequired_ReturnsTypedExceptionFor426()
    {
        using var resp = JsonResp(ValidBody, HttpStatusCode.UpgradeRequired);
        var err = await VersionSignaling.ParseVersionRequiredAsync(resp);
        Assert.NotNull(err);
        Assert.Equal("0.4", err!.MinimumVersion);
        Assert.Equal("0.3", err.ClientVersion);
        Assert.Equal(new[] { "safety-policy-enforcement" }, err.RequiredFeatures);
        Assert.Equal("https://codecai.net/docs/version-negotiation/", err.DocsUrl);
        Assert.Equal("lab-test", err.DeploymentId);
        Assert.Contains("requires v0.4", err.Message);
        Assert.Contains("safety-policy-enforcement", err.Message);
        Assert.Contains("speaks v0.3", err.Message);
    }

    [Fact]
    public async Task ParseVersionRequired_ThrowsOnNonJsonBody()
    {
        using var resp = new HttpResponseMessage(HttpStatusCode.UpgradeRequired)
        {
            Content = new StringContent("plain text refusal", Encoding.UTF8, "text/plain"),
        };
        await Assert.ThrowsAsync<FormatException>(async () =>
            await VersionSignaling.ParseVersionRequiredAsync(resp));
    }

    [Fact]
    public async Task ParseVersionRequired_ThrowsOnUnrecognizedShape()
    {
        using var resp = JsonResp(
            "{\"error\":\"something_else\",\"foo\":1}",
            HttpStatusCode.UpgradeRequired);
        await Assert.ThrowsAsync<FormatException>(async () =>
            await VersionSignaling.ParseVersionRequiredAsync(resp));
    }

    [Fact]
    public async Task ParseVersionRequired_HandlesEmptyRequiredFeatures()
    {
        var body = @"{
            ""error"": ""codec_version_required"",
            ""minimum_version"": ""0.4"",
            ""required_features"": [],
            ""client_version"": ""0.3""
        }";
        using var resp = JsonResp(body, HttpStatusCode.UpgradeRequired);
        var err = await VersionSignaling.ParseVersionRequiredAsync(resp);
        Assert.NotNull(err);
        Assert.Empty(err!.RequiredFeatures);
        Assert.DoesNotContain("requires:", err.Message);
    }

    // ── DiscoverVersionPolicyAsync ──────────────────────────────────────

    private sealed class StubHandler : HttpMessageHandler
    {
        public Func<HttpRequestMessage, HttpResponseMessage> Reply { get; init; } = default!;
        public HttpRequestMessage? LastRequest { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
        {
            LastRequest = request;
            return Task.FromResult(Reply(request));
        }
    }

    [Fact]
    public async Task Discover_ReturnsNullOn404()
    {
        var handler = new StubHandler
        {
            Reply = _ => new HttpResponseMessage(HttpStatusCode.NotFound),
        };
        using var client = new HttpClient(handler);
        var doc = await VersionSignaling.DiscoverVersionPolicyAsync(Origin, client);
        Assert.Null(doc);
    }

    [Fact]
    public async Task Discover_ParsesValidDocument()
    {
        var body = @"{
            ""minimum_version"": ""0.4"",
            ""required_features"": [""safety-policy-enforcement""],
            ""deployment_id"": ""acme-prod"",
            ""docs_url"": ""https://codecai.net/docs/version-negotiation/""
        }";
        var handler = new StubHandler
        {
            Reply = _ => JsonResp(body, HttpStatusCode.OK),
        };
        using var client = new HttpClient(handler);
        var doc = await VersionSignaling.DiscoverVersionPolicyAsync(Origin, client);
        Assert.NotNull(doc);
        Assert.Equal("0.4", doc!.MinimumVersion);
        Assert.Equal(new[] { "safety-policy-enforcement" }, doc.RequiredFeatures);
        Assert.Equal("acme-prod", doc.DeploymentId);
    }

    [Fact]
    public async Task Discover_ThrowsOn5xx()
    {
        var handler = new StubHandler
        {
            Reply = _ => new HttpResponseMessage(HttpStatusCode.BadGateway),
        };
        using var client = new HttpClient(handler);
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await VersionSignaling.DiscoverVersionPolicyAsync(Origin, client));
    }

    [Fact]
    public async Task Discover_StampsClientVersionHeader()
    {
        var handler = new StubHandler
        {
            Reply = _ => new HttpResponseMessage(HttpStatusCode.NotFound),
        };
        using var client = new HttpClient(handler);
        await VersionSignaling.DiscoverVersionPolicyAsync(Origin, client);
        Assert.Contains(
            VersionSignaling.CodecClientVersion,
            handler.LastRequest!.Headers.GetValues(VersionSignaling.CodecClientVersionHeader));
    }

    // ── Matrix: client × server config ──────────────────────────────────

    public static IEnumerable<object[]> MatrixCases()
    {
        var clients = new[] { "0.2", "0.3", "0.4", "0.5" };

        // default-off: no refusal for any client
        foreach (var cv in clients) yield return new object[] { "default-off", cv, false, Array.Empty<string>() };

        // safety-enforced: v0.2 + v0.3 refused with safety-policy-enforcement
        foreach (var cv in clients)
        {
            bool refused = cv == "0.2" || cv == "0.3";
            yield return new object[] {
                "safety-enforced", cv, refused,
                new[] { "safety-policy-enforcement" } };
        }

        // version-policy-strict: v0.2 + v0.3 refused with no specific feature
        foreach (var cv in clients)
        {
            bool refused = cv == "0.2" || cv == "0.3";
            yield return new object[] {
                "version-policy-strict", cv, refused, Array.Empty<string>() };
        }
    }

    [Theory]
    [MemberData(nameof(MatrixCases))]
    public async Task Matrix_RefusalAndBody(
        string serverName, string clientVersion, bool refused, string[] requiredFeatures)
    {
        if (refused)
        {
            var featuresJson = string.Join(",", requiredFeatures.Select(f => $"\"{f}\""));
            var body =
                "{\"error\":\"codec_version_required\","
                + "\"minimum_version\":\"0.4\","
                + $"\"required_features\":[{featuresJson}],"
                + $"\"client_version\":\"{clientVersion}\"}}";
            using var resp = JsonResp(body, HttpStatusCode.UpgradeRequired);
            var err = await VersionSignaling.ParseVersionRequiredAsync(resp);
            Assert.NotNull(err);
            Assert.Equal("0.4", err!.MinimumVersion);
            Assert.Equal(clientVersion, err.ClientVersion);
            Assert.Equal(requiredFeatures, err.RequiredFeatures);
        }
        else
        {
            using var resp = JsonResp("{\"ok\":true}", HttpStatusCode.OK);
            var err = await VersionSignaling.ParseVersionRequiredAsync(resp);
            Assert.Null(err);
        }
    }
}
