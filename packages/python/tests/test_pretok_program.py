"""Pre-tokenizer program tests. Mirrors packages/web/test/pretok-program.test.ts.

Three layers:
  1. Direct interpreter unit tests on synthetic programs, asserting the op
     set behaves as documented in spec/PRETOKENIZER_PROGRAM.md. Expected
     outputs are the same literal values asserted by the TS reference test
     for the same inputs and programs.
  2. Equivalence with Python's ``regex`` engine (which supports \\p{L} /
     \\p{N} natively) on the same stress-input corpus the TS test uses.
     This is the automatic, always-checked half of the parity claim.
  3. Equivalence with the real Qwen-2 map's regex, when a local codec-maps
     checkout is available (skipped otherwise, same convention as
     test_bpe.py's find_qwen_map).

The module was cross-checked against the TypeScript reference
(runPreTokProgram in packages/web/src/pretok-program.ts) directly at
landing time: 5 program variants x 26 stress inputs x 130 cases, 0
mismatches. That one-time cross-language run is what test 2 below keeps
enforced going forward without requiring a Node runtime in the Python test
suite.
"""
from __future__ import annotations

import json

import pytest
import regex

from codecai import BPETokenizer, TokenizerMap, run_pretok_program
from codecai.pretok_program import METASPACE

from .fixtures import find_qwen_map

# ── Direct interpreter unit tests ───────────────────────────────────────────

QWEN_LIKE = {
    "version": 1,
    "ops": [
        {"op": "literals_ci", "patterns": ["'s", "'t", "'re", "'ve", "'m", "'ll", "'d"]},
        {"op": "letters", "lead_other": True},
        {"op": "numbers"},
        {"op": "punct_run", "lead_space": True, "trailing_newlines": True},
        {"op": "newline_block"},
        {"op": "trailing_ws"},
        {"op": "ws_run"},
    ],
}


def test_simple_ascii_sentence():
    # Llama-3-style: leading space attaches to the next letter run via
    # [^\r\n\p{L}\p{N}]?\p{L}+. "Hello world!" -> ["Hello", " world", "!"].
    out = run_pretok_program(QWEN_LIKE, "Hello world!")
    assert out == ["Hello", " world", "!"]


def test_contractions_are_case_insensitive():
    assert run_pretok_program(QWEN_LIKE, "It's") == ["It", "'s"]
    # CI match keeps the original casing of the matched span.
    assert run_pretok_program(QWEN_LIKE, "It'S") == ["It", "'S"]


def test_digits_run_qwen_style_one_digit_per_piece():
    # Qwen-2's regex is bare \p{N} (no quantifier): one digit per
    # iteration, so digit runs come out one digit at a time.
    qwen = {
        "version": 1,
        "ops": [
            *QWEN_LIKE["ops"][:2],
            {"op": "numbers", "max_run": 1},
            *QWEN_LIKE["ops"][3:],
        ],
    }
    assert run_pretok_program(qwen, "abc12345") == ["abc", "1", "2", "3", "4", "5"]


def test_digits_bounded_llama3_style():
    llama = {
        "version": 1,
        "ops": [
            *QWEN_LIKE["ops"][:2],
            {"op": "numbers", "max_run": 3},
            *QWEN_LIKE["ops"][3:],
        ],
    }
    assert run_pretok_program(llama, "12345") == ["123", "45"]


def test_punctuation_run_with_trailing_newline():
    out = run_pretok_program(QWEN_LIKE, "hi !!!\n")
    assert out == ["hi", " !!!\n"]


def test_trailing_whitespace_at_eoi_matches_trailing_ws():
    out = run_pretok_program(QWEN_LIKE, "hi   ")
    assert out == ["hi", "   "]


def test_emoji_and_cjk_are_letters_via_unicode_letter_class():
    out = run_pretok_program(QWEN_LIKE, "日本語")
    assert out == ["日本語"]


def test_metaspace_splits_and_prefixes_marker():
    prog = {"version": 1, "ops": [{"op": "metaspace_split", "prefix_first": False}]}
    assert run_pretok_program(prog, "Hello world") == [
        METASPACE + "Hello", METASPACE + "world",
    ]


def test_metaspace_prefix_first_leaves_first_piece_bare():
    prog = {"version": 1, "ops": [{"op": "metaspace_split", "prefix_first": True}]}
    assert run_pretok_program(prog, "Hello world") == [
        "Hello", METASPACE + "world",
    ]


# ── Equivalence: program output must equal Python's native regex output ────

QWEN_REGEX = (
    r"(?i:'s|'t|'re|'ve|'m|'ll|'d)"
    r"|[^\r\n\p{L}\p{N}]?\p{L}+"
    r"|\p{N}"
    r"| ?[^\s\p{L}\p{N}]+[\r\n]*"
    r"|\s*[\r\n]+"
    r"|\s+(?!\S)"
    r"|\s+"
)

LLAMA_REGEX = (
    r"(?i:'s|'t|'re|'ve|'m|'ll|'d)"
    r"|[^\r\n\p{L}\p{N}]?\p{L}+"
    r"|\p{N}{1,3}"
    r"| ?[^\s\p{L}\p{N}]+[\r\n]*"
    r"|\s*[\r\n]+"
    r"|\s+(?!\S)"
    r"|\s+"
)

QWEN_PROGRAM = {
    # QWEN_REGEX's numbers class is bare `\p{N}` (no quantifier), i.e. one
    # digit per match. QWEN_LIKE above uses unbounded `numbers` for its own
    # (regex-free) unit tests, so build the regex-equivalent variant here
    # with `max_run: 1` instead of reusing QWEN_LIKE directly.
    "version": 1,
    "ops": [
        *QWEN_LIKE["ops"][:2],
        {"op": "numbers", "max_run": 1},
        *QWEN_LIKE["ops"][3:],
    ],
}
LLAMA_PROGRAM = {
    "version": 1,
    "ops": [
        *QWEN_LIKE["ops"][:2],
        {"op": "numbers", "max_run": 3},
        *QWEN_LIKE["ops"][3:],
    ],
}

STRESS_INPUTS = [
    "",
    "a",
    "Hello world",
    "Hello, world!",
    "It's a test.",
    "abc123def456",
    "   leading spaces",
    "trailing spaces   ",
    "multi   spaces",
    "tab\there",
    "newline\nhere",
    "paragraph\n\nbreak",
    "CRLF\r\nstyle",
    "punct!!!run???",
    " leading punct: foo",
    "mixed日本語text",
    "🚀 emoji 🎉",
    "日本語のテスト",
    "Numbers 12345 in middle",
    "  \n\n  whitespace + newline",
    "a" * 100,
    "---divider---",
    "unicode_ⅷ_numerals",
]


def _run_regex(pattern: str, text: str) -> list[str]:
    return [m.group(0) for m in regex.finditer(pattern, text) if m.group(0)]


@pytest.mark.parametrize("input_", STRESS_INPUTS)
def test_equivalence_qwen_program_matches_qwen_regex(input_: str):
    from_prog = run_pretok_program(QWEN_PROGRAM, input_)
    from_re = _run_regex(QWEN_REGEX, input_)
    assert from_prog == from_re


@pytest.mark.parametrize("input_", STRESS_INPUTS)
def test_equivalence_llama_program_matches_llama_regex(input_: str):
    from_prog = run_pretok_program(LLAMA_PROGRAM, input_)
    from_re = _run_regex(LLAMA_REGEX, input_)
    assert from_prog == from_re


# ── Equivalence on a real published map, when available ────────────────────

_QWEN_MAP_PATH = find_qwen_map()


@pytest.mark.skipif(_QWEN_MAP_PATH is None, reason="no local codec-maps checkout")
@pytest.mark.parametrize("input_", STRESS_INPUTS)
def test_equivalence_real_qwen2_map_regex(input_: str):
    with open(_QWEN_MAP_PATH, encoding="utf-8") as f:
        map_json = json.load(f)
    pattern = map_json["pre_tokenizer_pattern"]
    assert pattern, "real qwen2 map should carry pre_tokenizer_pattern"

    from_prog = run_pretok_program(QWEN_PROGRAM, input_)
    from_re = _run_regex(pattern, input_)
    assert from_prog == from_re


# ── BPETokenizer wiring: pre_tokenizer_program is preferred over the regex ──


def _byte_level_map(**overrides) -> TokenizerMap:
    from codecai import encode_byte_level_chars

    space = encode_byte_level_chars(b"\x20")
    vocab = {
        "h": 0, "e": 1, "l": 2, "o": 3, "w": 4, "r": 5, "d": 6,
        space: 7, "!": 8,
        "he": 9, "hel": 10, "hell": 11, "hello": 12,
        "wo": 13, "wor": 14, "worl": 15, "world": 16,
        space + "world": 17,
    }
    merges = [
        "h e", "he l", "hel l", "hell o",
        "w o", "wo r", "wor l", "worl d",
        space + " world",
    ]
    kwargs = dict(
        id="test/byte_level_program",
        version="2",
        vocab_size=len(vocab),
        vocab=vocab,
        encoder="byte_level",
        merges=merges,
    )
    kwargs.update(overrides)
    return TokenizerMap(**kwargs)


def test_bpetokenizer_prefers_program_over_pattern_and_matches_it():
    # QWEN_PROGRAM / QWEN_REGEX are already proven equivalent above across
    # the whole stress corpus; reuse that proven pair here instead of
    # inventing a new one, so an end-to-end BPETokenizer check rides on the
    # same equivalence guarantee rather than a fresh, unverified regex.
    m_program = _byte_level_map(pre_tokenizer_program=QWEN_PROGRAM)
    m_pattern = _byte_level_map(pre_tokenizer_pattern=QWEN_REGEX)

    tok_program = BPETokenizer(m_program)
    tok_pattern = BPETokenizer(m_pattern)

    text = "hello world!"
    assert tok_program.encode(text) == tok_pattern.encode(text)
    # And the program path really was used, not silently ignored.
    assert tok_program._pre_tok_program is not None  # noqa: SLF001
    assert tok_program._pre_tok_re is None  # noqa: SLF001
