"""Pre-tokenizer program tests, structured like packages/web/test/pretok-program.test.ts.

The TypeScript reference is NOT used as the oracle here. At the time this
file was written, TypeScript's whitespace class and its metaspace splitter
had both been found to disagree with the C and Rust runtimes (see
packages/python/src/codecai/pretok_program.py's module docstring and
commit 79e93ec). That commit fixed the whitespace side in TypeScript.
Testing Python against TypeScript would have pinned Python to
TypeScript's own bugs. Every check below uses one of three oracles
instead:

  1. Direct interpreter unit tests against spec/PRETOKENIZER_PROGRAM.md's
     documented op behavior, using inputs and expected outputs confirmed
     against the C runtime (packages/c/src/pretok_program.c).
  2. Equivalence with Python's own ``regex`` engine (which supports
     \\p{L} / \\p{N} / \\p{White_Space} natively) over a stress-input
     corpus.
  3. Equivalence with the real Qwen-2 map's regex, when a local codec-maps
     checkout is available (skipped otherwise, same convention as
     test_bpe.py's find_qwen_map).

The metaspace splitter's handling of a whitespace run longer than one code
point (e.g. consecutive newlines) is a separate, still-open question: C
and Rust agree with each other there, but neither has been confirmed
against HuggingFace's own ``Metaspace`` reference. That case is
deliberately left unpinned below; see the skipped test near the bottom
of this file and the docstring on ``_run_metaspace`` in
pretok_program.py.
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
    # iteration. Digit runs therefore come out one digit at a time.
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
    # No newline involved. This input is therefore not affected by the
    # open metaspace question below; TS, C, and Rust all agree here.
    prog = {"version": 1, "ops": [{"op": "metaspace_split", "prefix_first": False}]}
    assert run_pretok_program(prog, "Hello world") == [
        METASPACE + "Hello", METASPACE + "world",
    ]


def test_metaspace_prefix_first_leaves_first_piece_bare():
    # Same note as above: no newline is involved. This case is therefore
    # unaffected by the open question.
    prog = {"version": 1, "ops": [{"op": "metaspace_split", "prefix_first": True}]}
    assert run_pretok_program(prog, "Hello world") == [
        "Hello", METASPACE + "world",
    ]


# ── Whitespace class must be exactly Unicode White_Space ───────────────────
#
# spec/PRETOKENIZER_PROGRAM.md § Class membership pins the whitespace class
# to `\p{White_Space}` plus the usual ASCII fallbacks. TypeScript's native
# `\s` disagreed with that on two code points (excluded U+0085 NEXT LINE,
# included U+FEFF ZERO WIDTH NO-BREAK SPACE) until commit 79e93ec. The
# oracle here is the literal Unicode White_Space list, confirmed against
# the C runtime. It is not a regex. It cannot drift with whatever the
# implementation happens to use.

WHITE_SPACE_CODE_POINTS = [
    0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x0085, 0x00A0,
    0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
    0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F,
    0x3000,
]

# Zero-width or invisible characters that are NOT White_Space.
NOT_WHITE_SPACE_CODE_POINTS = [0xFEFF, 0x200B, 0x180E, 0x2060, 0x00AD]


def _treats_as_whitespace(cp: int) -> bool:
    """With QWEN_LIKE, ``a<cp>!`` splits three ways when cp is whitespace
    (punct_run stops at it) and two ways when it is not (punct_run
    absorbs it with the ``!``)."""
    pieces = run_pretok_program(QWEN_LIKE, f"a{chr(cp)}!")
    return len(pieces) == 3


@pytest.mark.parametrize("cp", [cp for cp in WHITE_SPACE_CODE_POINTS if cp != 0x20])
def test_white_space_code_points_split(cp: int):
    # 0x20 is excluded: punct_run's lead_space consumes it either way.
    # This probe can't distinguish the two classes using 0x20.
    assert _treats_as_whitespace(cp) is True, f"U+{cp:04X} is White_Space and must split"


@pytest.mark.parametrize("cp", NOT_WHITE_SPACE_CODE_POINTS)
def test_non_white_space_code_points_do_not_split(cp: int):
    assert _treats_as_whitespace(cp) is False, f"U+{cp:04X} is not White_Space and must not split"


def test_u0085_next_line_is_whitespace():
    # Confirmed against the C runtime. That produces ['a', '\x85', '!'].
    assert run_pretok_program(QWEN_LIKE, "a!") == ["a", "", "!"]


def test_ufeff_is_not_whitespace():
    # Confirmed against the C runtime. That produces ['a', '﻿!'].
    assert run_pretok_program(QWEN_LIKE, "a﻿!") == ["a", "﻿!"]


def test_ws_run_groups_a_mixed_white_space_run_as_c_does():
    # Input is a, U+0085, U+2009 THIN SPACE, U+0020, b. The C runtime
    # emits the pieces "a" / " " / " b". U+0085 therefore belongs to
    # the same ws_run as U+2009 even though they're different code points.
    assert run_pretok_program(QWEN_LIKE, "a  b") == ["a", " ", " b"]


def test_trailing_ws_treats_u0085_as_part_of_the_run():
    # C emits ['a', ''] for this input.
    assert run_pretok_program(QWEN_LIKE, "a") == ["a", ""]


# ── Metaspace: open question, deliberately not pinned either way ───────────


@pytest.mark.skip(
    reason=(
        "Open question that this file leaves unresolved: for a whitespace run "
        "longer than one code point (e.g. two consecutive newlines), C "
        "and Rust agree the whole run is a pure separator that produces "
        "no piece of its own ('a\\n\\nb' -> ['▁a', '▁b']). "
        "TypeScript, before it was fixed alongside this file landing, "
        "emitted a spurious '▁\\n' piece per extra newline instead. "
        "Neither side has been confirmed against HuggingFace's own "
        "Metaspace pre-tokenizer. That pre-tokenizer reportedly keeps a trailing "
        "newline attached to the adjacent word (a third possible "
        "answer). This module's _run_metaspace follows C and Rust "
        "because they agree with each other. Agreement between C and Rust is no evidence that either has "
        "been shown to match HuggingFace. Un-skip only once that is "
        "settled against a real HuggingFace reference. Assert "
        "whichever answer that reference gives."
    ),
)
def test_metaspace_consecutive_newlines_open_question():
    prog = {"version": 1, "ops": [{"op": "metaspace_split", "prefix_first": False}]}
    run_pretok_program(prog, "a\n\nb")


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
    # (regex-free) unit tests. This block builds the regex-equivalent
    # variant here with `max_run: 1`.
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
    "ab",
    "a﻿b",
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
    # the whole stress corpus. Reusing that proven pair here means an
    # end-to-end BPETokenizer check rides on the same equivalence
    # guarantee already established above.
    m_program = _byte_level_map(pre_tokenizer_program=QWEN_PROGRAM)
    m_pattern = _byte_level_map(pre_tokenizer_pattern=QWEN_REGEX)

    tok_program = BPETokenizer(m_program)
    tok_pattern = BPETokenizer(m_pattern)

    text = "hello world!"
    assert tok_program.encode(text) == tok_pattern.encode(text)
    # Confirms the program path really was used. It was not silently ignored.
    assert tok_program._pre_tok_program is not None  # noqa: SLF001
    assert tok_program._pre_tok_re is None  # noqa: SLF001
