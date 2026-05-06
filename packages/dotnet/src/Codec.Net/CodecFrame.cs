// SPDX-License-Identifier: MIT
namespace Codec;

/// <summary>
/// One streaming frame produced by a Codec-compliant server. Identical
/// shape across MessagePack and Protobuf wire modes; only serialization
/// differs.
/// </summary>
public sealed class CodecFrame
{
    /// <summary>Token IDs emitted by the model in this chunk.</summary>
    public IReadOnlyList<int> Ids { get; init; } = Array.Empty<int>();

    /// <summary><c>true</c> on the final frame — no further frames follow.</summary>
    public bool Done { get; init; }

    /// <summary>
    /// Set on the final frame. e.g. <c>"length"</c>, <c>"stop"</c>,
    /// <c>"eos_token"</c>, <c>"error"</c>.
    /// </summary>
    public string? FinishReason { get; init; }

    public override string ToString() =>
        $"CodecFrame(ids=[{string.Join(",", Ids)}], done={Done}, finish_reason={FinishReason ?? "null"})";
}

/// <summary>Pluggable cache for loaded maps.</summary>
public interface IMapCache
{
    /// <summary>Returns the cached map for <paramref name="key"/>, or null.</summary>
    Task<TokenizerMap?> GetAsync(string key, CancellationToken ct = default);

    /// <summary>Stores <paramref name="map"/> under <paramref name="key"/>.</summary>
    Task SetAsync(string key, TokenizerMap map, CancellationToken ct = default);
}

/// <summary>Default in-memory <see cref="IMapCache"/>.</summary>
public sealed class MemoryMapCache : IMapCache
{
    private readonly Dictionary<string, TokenizerMap> _store = new();
    private readonly object _lock = new();

    public Task<TokenizerMap?> GetAsync(string key, CancellationToken ct = default)
    {
        lock (_lock) return Task.FromResult(_store.TryGetValue(key, out var v) ? v : null);
    }

    public Task SetAsync(string key, TokenizerMap map, CancellationToken ct = default)
    {
        lock (_lock) _store[key] = map;
        return Task.CompletedTask;
    }
}
