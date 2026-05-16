// SPDX-License-Identifier: MIT
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace Codec;

/// <summary>
/// Client-side helpers for the Codec compression contract.
///
/// .NET twin of <c>codecai.compression</c> (Python) and the Java /
/// TypeScript / Rust equivalents: the server emits
/// <c>Codec-Zstd-Dict: sha256:&lt;hex&gt;</c> on every zstd response, the
/// client validates that header against locally-loaded dicts before
/// decompressing. See <c>spec/PROTOCOL.md</c> "Codec-Zstd-Dict response
/// header" for the full contract.
///
/// The actual zstd decompression is intentionally out of scope here — the
/// BCL has gzip + brotli built in, zstd needs a third-party package
/// (ZstdSharp.Port / ZstdNet / native bindings), and either way the
/// caller usually already has its own HTTP plumbing. This class gives you
/// the small piece that is specific to Codec: matching a response's
/// declared dict hash to the dict you have loaded.
/// </summary>
public static class Compression
{
    /// <summary>
    /// Compute the canonical Codec-Zstd-Dict hash for <paramref name="bytes"/>.
    /// Returns <c>sha256:&lt;lowercase hex&gt;</c> — same shape as the
    /// server-side header value and the <c>hash</c> field in tokenizer-map
    /// <c>zstd_dictionaries[]</c> entries.
    /// </summary>
    public static string HashZstdDict(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        var sb = new StringBuilder("sha256:", 7 + 64);
        foreach (var b in hash) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    /// <summary>
    /// Pick the zstd dict to decompress this response with.
    /// </summary>
    /// <param name="responseHeaders">Response headers. Lookups are
    /// case-insensitive — HTTP header names are case-insensitive per
    /// RFC 7230 §3.2 and most .NET HTTP layers expose a case-insensitive
    /// view, but a caller-supplied <see cref="Dictionary{TKey,TValue}"/>
    /// with the default comparer is normalised here.</param>
    /// <param name="loadedDicts">
    /// <c>{sha256_hash: dict_bytes}</c> — the dicts the client has loaded
    /// locally. Hashes follow the same <c>sha256:&lt;hex&gt;</c> format
    /// the server emits.</param>
    /// <returns>
    /// The matching dict's bytes when the response is
    /// <c>Content-Encoding: zstd</c> and the server's
    /// <c>Codec-Zstd-Dict</c> header points at a loaded dict; or
    /// <c>null</c> when the response is not zstd (the caller's HTTP
    /// stack handles gzip / br / identity).
    /// </returns>
    /// <exception cref="CodecZstdDictException">
    /// Thrown when the response is zstd but:
    /// <list type="bullet">
    /// <item>the <c>Codec-Zstd-Dict</c> header is missing (per spec the
    /// server MUST emit it on every zstd response),</item>
    /// <item>the header is malformed (not <c>sha256:&lt;hex&gt;</c>),</item>
    /// <item>the header names a hash we have not loaded — the caller
    /// should fetch the dict from the tokenizer map's
    /// <c>zstd_dictionaries[]</c> entry whose <c>hash</c> matches, or
    /// retry the request with <c>Accept-Encoding: gzip</c> to downgrade
    /// to a no-dict path.</item>
    /// </list>
    /// A wrong-dict decompression would produce garbage bytes that
    /// downstream parsers would misinterpret — fail fast instead.
    /// </exception>
    public static byte[]? SelectZstdDictForResponse(
        IDictionary<string, string> responseHeaders,
        IDictionary<string, byte[]> loadedDicts)
    {
        var enc = GetHeader(responseHeaders, "content-encoding");
        if (enc is null || !enc.Trim().Equals("zstd", StringComparison.OrdinalIgnoreCase))
            return null; // caller's HTTP stack handles gzip/br/identity

        var declared = GetHeader(responseHeaders, "codec-zstd-dict");
        if (string.IsNullOrEmpty(declared))
            throw new CodecZstdDictException(
                "Response is Content-Encoding: zstd but no Codec-Zstd-Dict "
                + "header was present. Per spec/PROTOCOL.md the server MUST "
                + "name the dict it used. Refusing to guess.");

        declared = declared.Trim();
        if (!declared.StartsWith("sha256:", StringComparison.Ordinal)
            || declared.Length != "sha256:".Length + 64)
        {
            throw new CodecZstdDictException(
                $"Malformed Codec-Zstd-Dict value: '{declared}'. "
                + "Expected 'sha256:<64 hex chars>'.");
        }

        if (!TryGetLoadedDict(loadedDicts, declared, out var dictBytes))
        {
            throw new CodecZstdDictException(
                $"Server used zstd dict {declared} but it isn't loaded "
                + "locally. Fetch it from the tokenizer map's "
                + "zstd_dictionaries[] entry (the entry whose hash "
                + "matches), or send Accept-Encoding: gzip to downgrade.");
        }
        return dictBytes;
    }

    /// <summary>Case-insensitive header lookup over a plain dict.</summary>
    private static string? GetHeader(IDictionary<string, string> headers, string name)
    {
        if (headers.TryGetValue(name, out var v)) return v;
        foreach (var kv in headers)
        {
            if (string.Equals(kv.Key, name, StringComparison.OrdinalIgnoreCase))
                return kv.Value;
        }
        return null;
    }

    /// <summary>
    /// Loaded-dict lookup. Keys are <c>sha256:&lt;hex&gt;</c>; both the
    /// declared header and the registry keys are normalised to lowercase
    /// hex per the spec, so an ordinal match suffices for the common
    /// path. We still fall through to an ordinal-ignore-case scan to
    /// defend against callers that key the registry with mixed case.
    /// </summary>
    private static bool TryGetLoadedDict(
        IDictionary<string, byte[]> loadedDicts, string declared, out byte[] dictBytes)
    {
        if (loadedDicts.TryGetValue(declared, out var v1))
        {
            dictBytes = v1;
            return true;
        }
        foreach (var kv in loadedDicts)
        {
            if (string.Equals(kv.Key, declared, StringComparison.OrdinalIgnoreCase))
            {
                dictBytes = kv.Value;
                return true;
            }
        }
        dictBytes = Array.Empty<byte>();
        return false;
    }
}

/// <summary>
/// Raised when the server's <c>Codec-Zstd-Dict</c> header does not match
/// any dict the client has loaded, or is missing on a zstd response.
///
/// A wrong-dict decompression would produce garbage bytes that downstream
/// parsers (msgpack, protobuf) would misinterpret — fail fast instead.
/// </summary>
public class CodecZstdDictException : Exception
{
    public CodecZstdDictException(string message) : base(message) { }
    public CodecZstdDictException(string message, Exception inner) : base(message, inner) { }
}
