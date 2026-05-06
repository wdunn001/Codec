// SPDX-License-Identifier: MIT
namespace Codec;

/// <summary>
/// Common interface every tokenizer implementation satisfies.
/// <see cref="BPETokenizer"/>, <see cref="LongestMatchTokenizer"/>, and
/// any external/wasm adapter all implement this.
/// </summary>
public interface ITokenizer
{
    /// <summary>Identifier of the underlying vocabulary.</summary>
    string Id { get; }

    /// <summary>Encode a string to a sequence of token IDs.</summary>
    int[] Encode(string text);
}
