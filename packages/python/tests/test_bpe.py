"""BPE tokenizer tests — mirror packages/web/test/bpe.test.ts."""
from __future__ import annotations

import json

import pytest

from codecai import (
    BPETokenizer,
    Detokenizer,
    TokenizerMap,
    encode_byte_level_chars,
)

from .fixtures import find_qwen_map


def make_byte_level_fixture() -> TokenizerMap:
    space = encode_byte_level_chars(b"\x20")  # → "Ġ"
    vocab = {
        "h": 0, "e": 1, "l": 2, "o": 3,
        "w": 4, "r": 5, "d": 6,
        space: 7,
        "!": 8,
        "he": 9, "hel": 10, "hell": 11, "hello": 12,
        "wo": 13, "wor": 14, "worl": 15, "world": 16,
        space + "world": 17,
    }
    merges = [
        "h e", "he l", "hel l", "hell o",
        "w o", "wo r", "wor l", "worl d",
        space + " world",
    ]
    return TokenizerMap(
        id="test/byte_level",
        version="2",
        vocab_size=len(vocab),
        vocab=vocab,
        encoder="byte_level",
        merges=merges,
        # Llama-3-style simplified pre-tokenizer.
        pre_tokenizer_pattern=r" ?[A-Za-z]+| ?[^A-Za-z\s]+|\s+",
    )


def test_byte_level_encodes_hello_world_exactly():
    m = make_byte_level_fixture()
    tok = BPETokenizer(m)
    # Pre-tokenize: ["hello", " world", "!"] → [12, 17, 8]
    assert tok.encode("hello world!") == [12, 17, 8]


def test_byte_level_round_trips_through_detokenizer():
    m = make_byte_level_fixture()
    tok = BPETokenizer(m)
    detok = Detokenizer(m)
    assert detok.render(tok.encode("hello world!")) == "hello world!"


def test_merges_greedily_by_priority_not_left_to_right():
    # Priority matters: "b c" before "a b" gives [a, bc] not [ab, c].
    vocab = {"a": 0, "b": 1, "c": 2, "ab": 3, "bc": 4, "abc": 5}
    merges = ["b c", "a b"]
    m = TokenizerMap(
        id="test/priority",
        version="2",
        vocab_size=6,
        vocab=vocab,
        encoder="byte_level",
        merges=merges,
        pre_tokenizer_pattern=r"\S+",
    )
    tok = BPETokenizer(m)
    assert tok.encode("abc") == [0, 4]


# ── Real Qwen-2 round-trip ──────────────────────────────────────────────────


def _have_qwen() -> bool:
    return find_qwen_map() is not None


@pytest.mark.skipif(not _have_qwen(), reason="codec-maps/qwen2.json not present locally")
def test_qwen_round_trips_ascii_and_code():
    path = find_qwen_map()
    assert path is not None
    with open(path, "r", encoding="utf-8") as f:
        m = TokenizerMap.from_json(f.read())
    tok = BPETokenizer(m)
    detok = Detokenizer(m)
    samples = [
        "Hello, world!",
        "Explain entropy in one sentence.",
        "def add(a, b):\n    return a + b",
        "Multiple   spaces   between   words.",
    ]
    for s in samples:
        ids = tok.encode(s)
        assert detok.render(ids) == s


@pytest.mark.skipif(not _have_qwen(), reason="codec-maps/qwen2.json not present locally")
def test_qwen_round_trips_unicode():
    path = find_qwen_map()
    assert path is not None
    with open(path, "r", encoding="utf-8") as f:
        m = TokenizerMap.from_json(f.read())
    tok = BPETokenizer(m)
    detok = Detokenizer(m)
    samples = ["🚀 launch", "日本語のテキスト", "Café résumé naïve"]
    for s in samples:
        ids = tok.encode(s)
        assert detok.render(ids) == s


# ── HF reference comparison (if tokenizers package is installed) ────────────


def _have_hf() -> bool:
    try:
        import tokenizers  # noqa: F401
        return True
    except ImportError:
        return False


@pytest.mark.skipif(not (_have_qwen() and _have_hf()), reason="needs codec-maps + tokenizers")
def test_qwen_matches_hf_reference():
    """Ground-truth check: our IDs should exactly match HuggingFace's."""
    from tokenizers import Tokenizer

    path = find_qwen_map()
    assert path is not None
    with open(path, "r", encoding="utf-8") as f:
        m = TokenizerMap.from_json(f.read())
    tok = BPETokenizer(m)

    hf = Tokenizer.from_pretrained("Qwen/Qwen2.5-7B-Instruct")
    samples = [
        "Hello, world!",
        "def add(a, b):\n    return a + b",
        "🚀 launch",
        "日本語",
    ]
    for s in samples:
        ours = tok.encode(s)
        ref = hf.encode(s, add_special_tokens=False).ids
        assert ours == ref, f"mismatch on {s!r}: ours={ours} ref={ref}"
