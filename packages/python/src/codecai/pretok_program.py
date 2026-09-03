"""Pre-tokenizer program interpreter, Python port.

Mirrors ``runPreTokProgram`` in ``@codecai/web/src/pretok-program.ts``.
Executes a ``pre_tokenizer_program`` against an input string, producing the
same sequence of pieces that the model's real HuggingFace pre-tokenizer
would have produced. See ``spec/PRETOKENIZER_PROGRAM.md`` for the full
op-set and stage design and rationale.

Two program shapes are supported, selected by the program's own
``version`` field.

* v1 (``{"version": 1, "ops": [...]}``): a single flat list of ops tried
  in priority order at every cursor position. This is the whole program
  for GPT-2-family tokenizers whose HuggingFace ``pre_tokenizer`` reduces
  to one alternation regex, and for SentencePiece metaspace tokenizers via
  the single-op ``metaspace_split`` shortcut.
* v2 (``{"version": 2, "stages": [...]}``): an ordered list of stages,
  each applied to every piece the stage before it produced. This mirrors
  HuggingFace's ``Sequence`` pre-tokenizer exactly. Four published maps
  need it: HuggingFaceTB/SmolLM2, tiiuae/falcon, deepseek-ai/DeepSeek-V3,
  and deepseek-ai/DeepSeek-R1. A v1 program cannot express any of these:
  collapsing a multi-stage ``Sequence`` into one flat alternation is the
  bug schema v2 exists to fix.

One correctness point carries across both program shapes. The
``alternation`` op-priority scanner emits a whole unmatched span as ONE
piece when no op matches at a cursor position, never one Unicode scalar
value at a time. Shattering an unmatched span scalar by scalar is
invisible on a v1 program, whose op lists are exhaustive over raw input
text: every position matches something, so the branch never fires. It
becomes reachable, and wrong, once an earlier v2 stage has already
isolated a character class this alternation's own ops were never meant to
see. DeepSeek-V3's third stage is the concrete case: it receives whole
digit-run and CJK-run pieces from the two stages ahead of it, and its own
ops have no digit or CJK branch. An earlier version of the TypeScript
reference implementation had exactly this scalar-by-scalar bug; it turned
a three-digit piece like ``"123"`` into three separate one-digit pieces
instead of passing it through untouched. This module shares one
alternation scanner, :func:`_run_alternation_ops`, between the v1 whole-
program loop and the v2 ``alternation`` stage, so the fix only needs to
exist in one place.

Python's ``regex`` package supports ``\\p{L}`` natively, so for Python the
program is at most a small startup speedup over the regex path (skip
compile, skip lookbehind backtracking). It exists primarily for runtimes
without a Unicode regex engine (``libcodec``), but porting it here keeps
every client on the same code path, which is what makes cross-language
equivalence auditable in the first place.

The v1 op-set portion of this file was verified against the C runtime
(``packages/c/src/pretok_program.c`` and its ``codec_unicode_is_ws``
table), not against TypeScript. At recovery time the TypeScript
interpreter's whitespace class disagreed with C and Rust on two code
points (native JS ``\\s`` versus ``\\p{White_Space}``; fixed in commit
``79e93ec``), and TypeScript's metaspace splitter still diverges from C
and Rust on how a run of non-space-or-tab whitespace (e.g. consecutive
newlines) is pieced. Pinning this file's tests to the old TypeScript
behavior would have encoded those bugs as the spec instead of catching
them. See ``packages/python/tests/test_pretok_program.py`` for the
in-repo equivalence tests, which check against C's confirmed values and
Python's own ``regex`` engine instead of the TS reference, and
:func:`_run_metaspace` below for the open question on the metaspace side.
The v2 stage portion added alongside this docstring was instead verified
piece-by-piece against the TypeScript reference (the only other client
that executes v2 today) over golden, combinatorial-stress, and
real-code-and-markdown corpora. See the audit notes referenced from the
project's working history for the corpus counts.
"""
from __future__ import annotations

import unicodedata
from typing import Any, List, Mapping, Sequence

from .encoder import METASPACE

# Unicode White_Space=Yes, transcribed from the UCD PropList. This is the
# same 25 code points as packages/c/src/codec_unicode_tables.c's
# WS_CODE_POINTS table, and what Rust's `regex` crate resolves `\s` to.
# spec/PRETOKENIZER_PROGRAM.md § Class membership pins the program's `\s`
# to exactly this set.
#
# This is deliberately NOT `str.isspace()`. CPython's `isspace()` is a
# superset of White_Space. It also returns True for U+001C through
# U+001F, the information-separator control characters, which carry
# bidirectional class B/S but are not White_Space. Using `isspace()` as a
# fallback here would silently reintroduce the same class of bug that
# made TypeScript's native `\s` disagree with C on 1074 of 10316
# differential-tested inputs (U+0085 NEXT LINE and U+FEFF ZERO WIDTH
# NO-BREAK SPACE were the two culprits there; see commit 79e93ec). A
# plain frozenset lookup over the exact 25-code-point table is both
# correct and fast, so no fallback is needed at all.
_WHITE_SPACE_CODE_POINTS = (
    0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x0085, 0x00A0,
    0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
    0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F,
    0x3000,
)
_WS_CHARS = frozenset(chr(cp) for cp in _WHITE_SPACE_CODE_POINTS)

# ASCII punctuation, the 32 characters HuggingFace's `is_ascii_punctuation`
# accepts: `[!-\/:-@\[-\`{-~]`. Shared by `punct_ascii_letters` and
# `punctuation_contiguous`.
_ASCII_PUNCT_CODE_POINTS = frozenset(
    list(range(0x21, 0x2F + 1))
    + list(range(0x3A, 0x40 + 1))
    + list(range(0x5B, 0x60 + 1))
    + list(range(0x7B, 0x7E + 1))
)


def _is_ws(cp: str) -> bool:
    return cp in _WS_CHARS


def _is_letter(cp: str) -> bool:
    # Python's str.isalpha covers Unicode \p{L} for single-codepoint
    # strings (precise behavior for all categories Lu/Ll/Lt/Lm/Lo).
    return cp.isalpha()


def _is_number(cp: str) -> bool:
    # str.isdigit covers Nd; isnumeric also covers Nl/No. \p{N} is the
    # union of N* categories, so isnumeric is the correct match for the
    # regex semantics.
    return cp.isnumeric()


def _is_mark(cp: str) -> bool:
    # \p{M}: General_Category=Mark (Mn, Mc, Me). unicodedata.category
    # returns the exact two-letter Unicode general category for a single
    # code point, so checking the leading "M" is precise, not a heuristic.
    return unicodedata.category(cp)[0] == "M"


def _is_punct(cp: str) -> bool:
    # \p{P}: General_Category=Punctuation (Pc, Pd, Ps, Pe, Pi, Pf, Po).
    return unicodedata.category(cp)[0] == "P"


def _is_symbol(cp: str) -> bool:
    # \p{S}: General_Category=Symbol (Sm, Sc, Sk, So).
    return unicodedata.category(cp)[0] == "S"


def _is_ascii_punct(cp: str) -> bool:
    return len(cp) == 1 and ord(cp) in _ASCII_PUNCT_CODE_POINTS


def _is_ascii_letter(cp: str) -> bool:
    return ("A" <= cp <= "Z") or ("a" <= cp <= "z")


def _is_letter_upper(cp: str) -> bool:
    # "Upper cluster" of the o200k_base / mistral-nemo letters_cased op:
    # \p{Lu} (uppercase) and \p{Lt} (titlecase), plus the \p{Lm}/\p{Lo}/\p{M}
    # set that is also valid in the lower cluster.
    cat = unicodedata.category(cp)
    return cat in ("Lu", "Lt", "Lm", "Lo") or cat[0] == "M"


def _is_letter_lower(cp: str) -> bool:
    # "Lower cluster": \p{Ll}, plus the shared modifier/other-letter/mark
    # categories.
    cat = unicodedata.category(cp)
    return cat in ("Ll", "Lm", "Lo") or cat[0] == "M"


# ── Op execution ─────────────────────────────────────────────────────────────
#
# Each matcher returns the number of code points consumed at position `i`,
# or 0 if it doesn't match. Python strings already index by Unicode code
# point (unlike JavaScript's UTF-16 code units), so no surrogate-pair
# handling is needed anywhere below.


def _match_literals_ci(op: Mapping[str, Any], s: str, i: int) -> int:
    best = 0
    patterns: Sequence[str] = op.get("patterns") or ()
    for p in patterns:
        n = len(p)
        if n <= best or i + n > len(s):
            continue
        # ASCII case-fold compare. Pre-tokenizer contraction lists are
        # always ASCII, so a full Unicode-aware lower() is unnecessary but
        # harmless here.
        if s[i:i + n].lower() == p.lower():
            best = n
    return best


def _match_literals(op: Mapping[str, Any], s: str, i: int) -> int:
    """Case-sensitive literal alternatives: match the longest of
    ``op["patterns"]`` at position ``i``, exact case. Used by older OpenAI
    tokenizers (p50k_base, r50k_base) and by ``ByteLevel(use_regex=true)``'s
    fixed internal regex, and by SmolLM2's and Falcon's ``alternation``
    stage (see spec/PRETOKENIZER_PROGRAM.md worked examples).
    """
    best = 0
    patterns: Sequence[str] = op.get("patterns") or ()
    for p in patterns:
        n = len(p)
        if n <= best or i + n > len(s):
            continue
        if s[i:i + n] == p:
            best = n
    return best


def _match_letters(op: Mapping[str, Any], s: str, i: int) -> int:
    """``[^\\r\\n\\p{L}\\p{N}]?\\p{L}+`` by default.

    ``lead_other_class: "l_p_s"`` changes the excluded lead-char class to
    ``[^\\r\\n\\p{L}\\p{P}\\p{S}]`` instead: a digit at the lead position
    is admitted there (DeepSeek-V3's third stage).

    ``body: "L_M"`` changes the run body from ``\\p{L}+`` to
    ``[\\p{L}\\p{M}]+``: a base letter with a following combining mark
    stays one piece.

    ``lead_space: true`` matches `` ?\\p{L}+`` instead (older OpenAI
    tokenizers). Mutually exclusive with ``lead_other``.
    """
    p = i
    if op.get("lead_other"):
        if p < len(s):
            cp = s[p]
            if op.get("lead_other_class") == "l_p_s":
                excluded = (
                    cp != "\r" and cp != "\n"
                    and not _is_letter(cp) and not _is_punct(cp) and not _is_symbol(cp)
                )
            else:
                excluded = (
                    cp != "\r" and cp != "\n"
                    and not _is_letter(cp) and not _is_number(cp)
                )
            if excluded:
                p += 1
    elif op.get("lead_space"):
        if p < len(s) and s[p] == " ":
            p += 1
    run_start = p
    if op.get("body") == "L_M":
        while p < len(s) and (_is_letter(s[p]) or _is_mark(s[p])):
            p += 1
    else:
        while p < len(s) and _is_letter(s[p]):
            p += 1
    if p == run_start:
        return 0
    return p - i


def _match_letters_cased(op: Mapping[str, Any], s: str, i: int) -> int:
    """Cased-letter run with an optional trailing case-insensitive
    contraction, used by o200k_base and mistral-nemo.

    ``kind: "title"`` matches ``[Lu Lt Lm Lo M]* [Ll Lm Lo M]+``: zero or
    more upper-cluster letters, then one or more lower-cluster letters.
    ``kind: "upper"`` matches ``[Lu Lt Lm Lo M]+ [Ll Lm Lo M]*``: one or
    more upper-cluster letters, then zero or more lower-cluster letters.
    Both split a word on a case boundary, so ``"MyCamelCase"`` becomes
    ``["My", "Camel", "Case"]``.

    ``lead_other: true`` prepends the conventional GPT-2 lead-other guard,
    ``[^\\r\\n\\p{L}\\p{N}]?``. ``trailing_ci``, when set, matches the
    longest of its patterns at the end of the run using the same
    ASCII-case-fold semantics as ``literals_ci``.

    The upper and lower clusters overlap on ``Lm``, ``Lo``, and ``M``, so
    the longest overall match can require giving back one or more
    characters from the greedy upper-cluster run to let the lower-cluster
    suffix claim them. This is why the run below records a checkpoint at
    every step of the greedy prefix scan and retries the suffix from each
    checkpoint, longest prefix first, taking the first checkpoint whose
    suffix also satisfies ``kind``'s minimum length.
    """
    p = i
    if op.get("lead_other"):
        if p < len(s):
            cp = s[p]
            if cp != "\r" and cp != "\n" and not _is_letter(cp) and not _is_number(cp):
                p += 1

    checkpoints = [p]
    while p < len(s) and _is_letter_upper(s[p]):
        p += 1
        checkpoints.append(p)

    kind = op.get("kind")
    min_prefix = 1 if kind == "upper" else 0
    min_suffix = 1 if kind == "title" else 0

    for k in range(len(checkpoints) - 1, -1, -1):
        if k < min_prefix:
            break
        q = checkpoints[k]
        suffix_count = 0
        while q < len(s) and _is_letter_lower(s[q]):
            q += 1
            suffix_count += 1
        if suffix_count < min_suffix:
            continue

        trailing_ci: Sequence[str] = op.get("trailing_ci") or ()
        if trailing_ci:
            best = 0
            for pat in trailing_ci:
                n = len(pat)
                if n <= best or q + n > len(s):
                    continue
                if s[q:q + n].lower() == pat.lower():
                    best = n
            q += best

        return q - i
    return 0


def _match_numbers(op: Mapping[str, Any], s: str, i: int) -> int:
    """``\\p{N}+`` if max_run==0, else ``\\p{N}{1,max_run}``."""
    p = i
    max_run = op.get("max_run", 0) or 0
    count = 0
    limit = max_run if max_run > 0 else float("inf")
    if op.get("lead_space") and p < len(s) and s[p] == " ":
        p += 1
    run_start = p
    while p < len(s) and count < limit and _is_number(s[p]):
        p += 1
        count += 1
    if p == run_start:
        return 0
    return p - i


def _match_punct_run(op: Mapping[str, Any], s: str, i: int) -> int:
    """`` ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*`` with toggleable lead/trailing.

    ``charset: "p_s"`` changes the run body from the complement class
    ``[^\\s\\p{L}\\p{N}]+`` to ``[\\p{P}\\p{S}]+`` instead: DeepSeek-V3's
    third stage names its punctuation/symbol class explicitly rather than
    by complement, which excludes combining marks and any other leftover
    category the complement class would otherwise sweep in.
    """
    p = i
    if op.get("lead_space") and p < len(s) and s[p] == " ":
        p += 1
    run_start = p
    if op.get("charset") == "p_s":
        while p < len(s) and (_is_punct(s[p]) or _is_symbol(s[p])):
            p += 1
    else:
        while p < len(s):
            cp = s[p]
            if _is_ws(cp) or _is_letter(cp) or _is_number(cp):
                break
            p += 1
    if p == run_start:
        return 0
    trailing_chars = op.get("trailing_chars")
    if trailing_chars is not None:
        while p < len(s) and s[p] in trailing_chars:
            p += 1
    elif op.get("trailing_newlines"):
        while p < len(s) and (s[p] == "\n" or s[p] == "\r"):
            p += 1
    return p - i


def _match_punct_ascii_letters(_op: Mapping[str, Any], s: str, i: int) -> int:
    """``[!-\\/:-@\\[-\\`{-~][A-Za-z]+``: one ASCII punctuation character,
    then one or more ASCII letters. DeepSeek-V3's third stage tries this
    before its general letters/punct branches, so a token like ``'m`` in
    code (an apostrophe glued to identifier letters) comes out as one
    piece instead of splitting at the apostrophe.
    """
    if i >= len(s):
        return 0
    if not _is_ascii_punct(s[i]):
        return 0
    p = i + 1
    run_start = p
    while p < len(s) and _is_ascii_letter(s[p]):
        p += 1
    if p == run_start:
        return 0
    return p - i


def _match_newline_block(_op: Mapping[str, Any], s: str, i: int) -> int:
    """``\\s*[\\r\\n]+``: a whitespace run that contains at least one
    newline, truncated so the match ends on a newline."""
    p = i
    while p < len(s) and _is_ws(s[p]):
        p += 1
    if p == i:
        return 0
    # Find the first newline within the whitespace run.
    first_nl = -1
    for q in range(i, p):
        if s[q] == "\n" or s[q] == "\r":
            first_nl = q
            break
    if first_nl < 0:
        return 0
    # Trim back any trailing non-newline whitespace.
    q = p
    while q > first_nl and not (s[q - 1] == "\n" or s[q - 1] == "\r"):
        q -= 1
    return q - i


def _match_trailing_ws(_op: Mapping[str, Any], s: str, i: int) -> int:
    """``\\s+(?!\\S)`` with backtracking semantics. See the TS interpreter
    docstring for the full derivation. Match length:
       run reaches end of input -> whole run.
       run ends at non-whitespace -> run length minus the last whitespace
       code point.
       single-codepoint run followed by non-whitespace -> 0 (no match).
    """
    p = i
    while p < len(s) and _is_ws(s[p]):
        p += 1
    if p == i:
        return 0
    if p == len(s):
        return p - i
    # Followed by non-whitespace; truncate before the last whitespace code
    # point. Every Python str index is already one code point, so that's
    # just p - 1.
    return (p - 1) - i


def _match_ws_run(_op: Mapping[str, Any], s: str, i: int) -> int:
    p = i
    while p < len(s) and _is_ws(s[p]):
        p += 1
    return p - i


_MATCHERS = {
    "literals_ci": _match_literals_ci,
    "literals": _match_literals,
    "letters": _match_letters,
    "letters_cased": _match_letters_cased,
    "numbers": _match_numbers,
    "punct_run": _match_punct_run,
    "punct_ascii_letters": _match_punct_ascii_letters,
    "newline_block": _match_newline_block,
    "trailing_ws": _match_trailing_ws,
    "ws_run": _match_ws_run,
}


# ── Alternation scanner (v1 whole-program loop, and the v2 `alternation`
#    stage) ────────────────────────────────────────────────────────────────


def _try_ops_at(
    ops: Sequence[Mapping[str, Any]], text: str, i: int, version: int
) -> int:
    """Try every op in `ops`, in priority order, at position `i`. Returns
    the first non-empty match's span, or 0 if none match.

    An op kind this client's ``_MATCHERS`` table does not recognise raises
    immediately, naming the op and the program version. Skipping an
    unrecognised op and continuing the scan would let the alternation fall
    through to the unmatched-span case in :func:`_run_alternation_ops` and
    emit a plausible-looking but wrong split instead of failing. That is
    the same class of defect the whole pre-tokenizer-program format exists
    to prevent; see the module docstring and
    ``spec/PRETOKENIZER_PROGRAM.md`` § Compiler failure is loud.
    """
    for op in ops:
        kind = op.get("op")
        if kind == "metaspace_split":
            # Mixed programs aren't legal: metaspace is single-op (v1) and
            # never appears inside an `alternation` stage (v2). Skip.
            continue
        fn = _MATCHERS.get(kind or "")
        if fn is None:
            raise ValueError(
                f"run_pretok_program: unrecognised op {kind!r} in a "
                f"pre_tokenizer_program version {version} alternation. "
                "This client's alternation scanner understands "
                f"{sorted(_MATCHERS)!r}, plus the version-1-only "
                "metaspace_split shortcut. Upgrade the client to use this "
                "map."
            )
        span = fn(op, text, i)
        if span > 0:
            return span
    return 0


def _run_alternation_ops(
    ops: Sequence[Mapping[str, Any]], text: str, version: int
) -> List[str]:
    """Try every op in `ops`, in priority order, at each cursor position;
    consume the first non-empty match and advance. This is the whole v1
    program's execution model, and one v2 `alternation` stage's execution
    model (scoped to a single input piece rather than the whole original
    text).

    When no op matches at a position, this emits the maximal run of
    consecutive non-matching positions as ONE piece, verbatim, rather than
    shattering it one code point at a time. For a GPT-2-family op list
    running directly over raw text (v1 programs, and a v2 `alternation`
    stage that is the program's only stage), this list is exhaustive over
    every Unicode scalar value and the branch is unreachable. It becomes
    reachable, and matters, once an earlier v2 stage has already stripped
    a character class this alternation's ops were never meant to see. See
    the module docstring for the concrete DeepSeek-V3 case and the bug
    this behavior fixes.
    """
    out: List[str] = []
    n = len(text)
    i = 0
    while i < n:
        span = _try_ops_at(ops, text, i, version)
        if span > 0:
            out.append(text[i:i + span])
            i += span
            continue
        j = i + 1
        while j < n and _try_ops_at(ops, text, j, version) == 0:
            j += 1
        out.append(text[i:j])
        i = j
    return out


# ── v2 stage executors ───────────────────────────────────────────────────────
#
# Each stage transforms the FULL current list of pieces: every existing
# piece is fed through the stage independently and the results are
# concatenated in order. This mirrors HuggingFace's `Sequence`
# pre-tokenizer exactly: each sub-pretokenizer runs over every span the
# previous ones already produced. See :func:`run_pretok_program`.


def _stage_digits_isolate(op: Mapping[str, Any], piece: str) -> List[str]:
    """`mode: "individual"`: every digit becomes its own piece
    (HuggingFace `Digits(individual_digits=true)`, SmolLM2). `mode:
    "grouped"`: consecutive digits stay together as one piece, chunked to
    `max_run` when set (HuggingFace `Digits(individual_digits=false)`,
    Falcon; or a `Split` on `\\p{N}{1,K}`/`\\p{N}+` with `Isolated`
    behavior, DeepSeek-V3's first stage with `max_run: 3`).
    """
    out: List[str] = []
    buf: List[str] = []
    num_buf: List[str] = []
    num_count = 0
    mode = op.get("mode")
    max_run = op.get("max_run") or 0
    limit = max_run if max_run > 0 else None
    for cp in piece:
        if _is_number(cp):
            if buf:
                out.append("".join(buf))
                buf = []
            if mode == "individual":
                out.append(cp)
            else:
                if limit is not None and num_count >= limit:
                    out.append("".join(num_buf))
                    num_buf = []
                    num_count = 0
                num_buf.append(cp)
                num_count += 1
        else:
            if num_buf:
                out.append("".join(num_buf))
                num_buf = []
                num_count = 0
            buf.append(cp)
    if num_buf:
        out.append("".join(num_buf))
    if buf:
        out.append("".join(buf))
    return out


def _is_ascii_digit(ch: str) -> bool:
    return "0" <= ch <= "9"


def _stage_digit_triples_isolate(piece: str) -> List[str]:
    """HuggingFace `Split("[0-9][0-9][0-9]", Isolated)`: Falcon's fourth
    stage. Exact non-overlapping windows of 3 ASCII digits, scanned
    left to right. A run of digits not itself a multiple of 3 leaves a
    remainder that stays ungrouped, as part of the surrounding non-match
    content; the remainder itself is never chunked. This is deliberately
    distinct from `digits_isolate`'s `max_run`, which chunks a `\\p{N}`
    run into pieces of at most K digits with no remainder left behind.
    """
    out: List[str] = []
    n = len(piece)
    last = 0
    i = 0
    while i + 3 <= n:
        if (
            _is_ascii_digit(piece[i])
            and _is_ascii_digit(piece[i + 1])
            and _is_ascii_digit(piece[i + 2])
        ):
            if i > last:
                out.append(piece[last:i])
            out.append(piece[i:i + 3])
            i += 3
            last = i
        else:
            i += 1
    if last < n:
        out.append(piece[last:])
    return out


def _stage_punctuation_contiguous(piece: str) -> List[str]:
    """HuggingFace `Punctuation(Contiguous)`: Falcon's first stage.
    Classifies each character as ASCII-punctuation-or-`\\p{P}` versus
    everything else, and groups each maximal run of the same
    classification into one piece. Whitespace and letters share the
    "everything else" bucket, so a whitespace run stays attached to its
    adjacent letters as one piece here.
    """
    out: List[str] = []
    buf: List[str] = []
    p_buf: List[str] = []
    for cp in piece:
        if _is_ascii_punct(cp) or _is_punct(cp):
            if buf:
                out.append("".join(buf))
                buf = []
            p_buf.append(cp)
        else:
            if p_buf:
                out.append("".join(p_buf))
                p_buf = []
            buf.append(cp)
    if p_buf:
        out.append("".join(p_buf))
    if buf:
        out.append("".join(buf))
    return out


# DeepSeek-V3's literal CJK ranges: U+4E00-U+9FA5 (its own bound, short of
# the full CJK Unified Ideographs block at U+9FFF), Hiragana U+3040-U+309F,
# Katakana U+30A0-U+30FF.
_CJK_RANGES = (
    (0x4E00, 0x9FA5),
    (0x3040, 0x309F),
    (0x30A0, 0x30FF),
)


def _is_cjk(cp: str) -> bool:
    code = ord(cp)
    for lo, hi in _CJK_RANGES:
        if lo <= code <= hi:
            return True
    return False


def _stage_cjk_isolate(piece: str) -> List[str]:
    """HuggingFace `Split([一-龥぀-ゟ゠-ヿ]+, Isolated)`: DeepSeek-V3's second
    stage. Isolates maximal runs of CJK Unified Ideographs, Hiragana, and
    Katakana as their own pieces, so a CJK run never merges with adjacent
    Latin text or a preceding space.
    """
    out: List[str] = []
    n = len(piece)
    last = 0
    i = 0
    while i < n:
        if _is_cjk(piece[i]):
            if i > last:
                out.append(piece[last:i])
            j = i + 1
            while j < n and _is_cjk(piece[j]):
                j += 1
            out.append(piece[i:j])
            i = j
            last = j
        else:
            i += 1
    if last < n:
        out.append(piece[last:])
    return out


def _run_stage(stage: Mapping[str, Any], piece: str) -> List[str]:
    kind = stage.get("stage")
    if kind == "digits_isolate":
        return _stage_digits_isolate(stage, piece)
    if kind == "digit_triples_isolate":
        return _stage_digit_triples_isolate(piece)
    if kind == "punctuation_contiguous":
        return _stage_punctuation_contiguous(piece)
    if kind == "cjk_isolate":
        return _stage_cjk_isolate(piece)
    if kind == "alternation":
        return _run_alternation_ops(stage.get("ops") or (), piece, 2)
    # An unrecognised stage kind. Refuse to guess: silently skipping a
    # stage, or passing the piece through unchanged, would produce a
    # plausible-looking but wrong split, exactly the failure mode
    # spec/PRETOKENIZER_PROGRAM.md's "Compiler failure is loud" section
    # exists to prevent on the compile side. The runtime side owes the
    # same guarantee once a client is asked to execute a stage kind newer
    # than the version it understands.
    raise ValueError(
        f"run_pretok_program: unsupported v2 stage kind {kind!r}. This "
        "client understands digits_isolate, digit_triples_isolate, "
        "punctuation_contiguous, cjk_isolate, and alternation."
    )


# ── Metaspace shortcut (single-op v1 programs) ──────────────────────────────


def _run_metaspace(op: Mapping[str, Any], text: str) -> List[str]:
    """Split ``text`` on whitespace runs, prefixing each non-empty piece
    with ``METASPACE`` (except the first, when ``prefix_first`` is set).

    This mirrors ``codec_pretok_run_metaspace`` in
    ``packages/c/src/pretok_program.c`` byte-for-byte, including its
    ``is_first`` bookkeeping: ``is_first`` goes false as soon as ANY
    leading whitespace run (of any White_Space code point, not just a
    literal space) is consumed, even before the first word is captured.
    Rust's ``run_metaspace`` only clears its ``is_first`` on a literal
    ASCII space during that leading run, which is an observable
    disagreement between C and Rust when ``prefix_first`` is set and the
    input starts with a non-space whitespace character (e.g. a leading
    newline). That narrow case is left un-pinned here in favor of C's
    simpler, uniform rule; it hasn't been resolved against any upstream
    reference.

    Open question, not resolved by this file. For a run of more than one
    non-space-or-tab whitespace code point in the middle of the input
    (e.g. two consecutive newlines), C and Rust agree the whole run is a
    pure separator that produces no piece of its own (``"a\\n\\nb"`` ->
    ``["▁a", "▁b"]``). TypeScript, prior to this file being ported,
    emitted a spurious ``▁\\n`` piece per extra newline (``["▁a", "▁\\n",
    "▁\\n", "▁b"]``). Whichever of those is correct against HuggingFace's
    own ``Metaspace`` pre-tokenizer (which reportedly keeps a trailing
    newline attached to the adjacent word, a third possible answer) was
    not established before this file landed. This implementation follows
    C and Rust because they agree with each other. It does not claim they
    match HuggingFace.
    """
    prefix_first = bool(op.get("prefix_first"))
    out: List[str] = []
    n = len(text)
    i = 0
    is_first = True
    while i < n:
        # Advance past any leading whitespace run. Any White_Space code
        # point clears is_first, even if no word has been captured yet.
        ws_end = i
        while ws_end < n and _is_ws(text[ws_end]):
            ws_end += 1
        if ws_end > i:
            is_first = False
        i = ws_end
        if i >= n:
            break

        # Capture the next non-whitespace run.
        word_start = i
        while i < n and not _is_ws(text[i]):
            i += 1
        if i == word_start:
            break

        word = text[word_start:i]
        if prefix_first and is_first:
            out.append(word)
        else:
            out.append(METASPACE + word)
        is_first = False
    return out


# ── Public API ───────────────────────────────────────────────────────────────


def run_pretok_program(prog: Mapping[str, Any], text: str) -> List[str]:
    """Run a pre-tokenizer program over ``text`` and return the pieces.

    Mirrors ``runPreTokProgram`` in the TS reference.

    A v1 program (``prog["version"] == 1``) runs as a single alternation
    scan over the whole text, except for the single-op ``metaspace_split``
    shortcut, which delegates to a dedicated splitter.

    A v2 program (``prog["version"] == 2``) starts with a piece list
    containing the whole input text as its only entry. For each stage, in
    order, every current piece is fed through that stage independently and
    the results are concatenated to form the next piece list. Empty pieces
    are dropped from the final result: a stage boundary can produce one
    where HuggingFace's own ``Sequence`` would too, and neither runtime
    should emit a token for it.

    Any other ``version`` value raises. Guessing at execution semantics
    for a program version this client has never heard of risks emitting a
    plausible-looking but wrong split, which is exactly the failure mode
    the whole pre-tokenizer-program format exists to prevent. See
    ``spec/PRETOKENIZER_PROGRAM.md`` § Versioning.
    """
    version = prog.get("version", 1)
    if version == 1:
        ops: Sequence[Mapping[str, Any]] = prog.get("ops") or ()
        if len(ops) == 1 and ops[0].get("op") == "metaspace_split":
            return _run_metaspace(ops[0], text)
        return _run_alternation_ops(ops, text, version)

    if version == 2:
        pieces: List[str] = [text]
        for stage in prog.get("stages") or ():
            next_pieces: List[str] = []
            for piece in pieces:
                next_pieces.extend(_run_stage(stage, piece))
            pieces = next_pieces
        return [p for p in pieces if p]

    raise ValueError(
        f"run_pretok_program: unsupported pre_tokenizer_program version "
        f"{version!r}. This client understands versions 1 and 2. Upgrade "
        "the client to use this map."
    )


__all__ = ["run_pretok_program", "METASPACE"]
