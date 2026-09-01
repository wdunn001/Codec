// SPDX-License-Identifier: MIT
using Xunit;

namespace Codec.Tests;

public class BPETests
{
    private static TokenizerMap MakeByteLevelFixture()
    {
        // Tiny synthetic byte_level map: single space encodes to "Ġ" via GPT-2.
        var space = ByteEncoder.EncodeByteLevelChars(new byte[] { 0x20 });
        var vocab = new Dictionary<string, int>
        {
            { "h", 0 }, { "e", 1 }, { "l", 2 }, { "o", 3 },
            { "w", 4 }, { "r", 5 }, { "d", 6 },
            { space, 7 },
            { "!", 8 },
            { "he", 9 }, { "hel", 10 }, { "hell", 11 }, { "hello", 12 },
            { "wo", 13 }, { "wor", 14 }, { "worl", 15 }, { "world", 16 },
            { space + "world", 17 },
        };
        var merges = new List<string>
        {
            "h e",
            "he l",
            "hel l",
            "hell o",
            "w o",
            "wo r",
            "wor l",
            "worl d",
            space + " world",
        };
        return new TokenizerMap
        {
            Id = "test/byte_level",
            Version = "2",
            VocabSize = vocab.Count,
            Vocab = vocab,
            Encoder = "byte_level",
            Merges = merges,
            // Llama-3-style simplified pre-tokenizer: word + maybe-leading-space.
            PreTokenizerPattern = " ?[A-Za-z]+| ?[^A-Za-z\\s]+|\\s+",
        };
    }

    [Fact]
    public void EncodesHelloWorldExactly()
    {
        var map = MakeByteLevelFixture();
        var tok = new BPETokenizer(map);
        var ids = tok.Encode("hello world!");
        // Pre-tokenize: ["hello", " world", "!"] → [12, 17, 8]
        Assert.Equal(new[] { 12, 17, 8 }, ids);
    }

    [Fact]
    public void RoundTripsThroughDetokenizer()
    {
        var map = MakeByteLevelFixture();
        var tok = new BPETokenizer(map);
        var detok = new Detokenizer(map);
        var text = "hello world!";
        Assert.Equal(text, detok.Render(tok.Encode(text)));
    }

    [Fact]
    public void MergesGreedilyByPriorityNotLeftToRight()
    {
        // Build a fixture where merge priority matters.
        var vocab = new Dictionary<string, int>
        {
            { "a", 0 }, { "b", 1 }, { "c", 2 },
            { "ab", 3 }, { "bc", 4 }, { "abc", 5 },
        };
        // "b c" first (lower index = higher priority).
        // Greedy left-to-right: "ab" + "c" → [3, 2].
        // Priority-correct: "a" + "bc" → [0, 4].
        var merges = new List<string> { "b c", "a b" };
        var map = new TokenizerMap
        {
            Id = "test/priority",
            Version = "2",
            VocabSize = 6,
            Vocab = vocab,
            Encoder = "byte_level",
            Merges = merges,
            PreTokenizerPattern = "\\S+",
        };
        var tok = new BPETokenizer(map);
        Assert.Equal(new[] { 0, 4 }, tok.Encode("abc"));
    }

    [Fact]
    public void RoundTripsRealQwenMapForUnicode()
    {
        var path = Fixtures.FindQwenMap();
        if (path is null) return; // gracefully skip when codec-maps is absent

        var map = TokenizerMap.FromJson(File.ReadAllBytes(path));
        var tok = new BPETokenizer(map);
        var detok = new Detokenizer(map);

        var samples = new[]
        {
            "Hello, world!",
            "Explain entropy in one sentence.",
            "def add(a, b):\n    return a + b",
            "Multiple   spaces   between   words.",
            "🚀 launch",
            "日本語のテキスト",
            "Café résumé naïve",
        };
        foreach (var s in samples)
        {
            var ids = tok.Encode(s);
            Assert.Equal(s, detok.Render(ids));
        }
    }

    [Fact]
    public void ChatTemplateAndFimSpecialsEmitAtomicIds()
    {
        // Regression guard for the special-token pre-scan. Reference IDs
        // come from HuggingFace `tokenizers` 0.23.1 reading
        // Qwen-2.5-0.5B-Instruct's tokenizer.json: the encoder must emit
        // each `<|...|>` delimiter as a single atomic vocab ID, not as 6
        // byte-level tokens.
        var path = Fixtures.FindQwenMap();
        if (path is null) return; // skip when codec-maps is absent

        var map = TokenizerMap.FromJson(File.ReadAllBytes(path));
        var tok = new BPETokenizer(map);

        Assert.Equal(
            new[] { 151644, 872, 198, 3838, 374, 220, 17, 10, 17, 30, 151645 },
            tok.Encode("<|im_start|>user\nWhat is 2+2?<|im_end|>"));
        Assert.Equal(
            new[] { 151659, 750, 15229, 2075, 1648, 151661, 262, 470, 856, 151660, 198 },
            tok.Encode("<|fim_prefix|>def foo(x):<|fim_suffix|>    return x<|fim_middle|>\n"));
        Assert.Equal(
            new[] { 151644, 8948, 198, 2610, 525, 10950, 13, 151645, 198, 151644, 872, 198, 9707, 151645 },
            tok.Encode("<|im_start|>system\nYou are helpful.<|im_end|>\n<|im_start|>user\nHello<|im_end|>"));
    }
}
