"""Pre-tokenizer program interpreter, Python port.

Mirrors ``runPreTokProgram`` in ``@codecai/web/src/pretok-program.ts``.
Executes a ``pre_tokenizer_program`` against an input string, producing the
same sequence of pieces that the legacy ``pre_tokenizer_pattern`` regex
would have produced. See ``spec/PRETOKENIZER_PROGRAM.md`` for the op-set
design and rationale; this module implements exactly the eight v1 ops that
spec documents (the same set ``packages/c/src/pretok_program.c`` supports).

Python's ``regex`` package supports ``\\p{L}`` natively, so for Python the
program is at most a small startup speedup over the regex path (skip
compile, skip lookbehind backtracking). It exists primarily for runtimes
without a Unicode regex engine (``libcodec``), but porting it here keeps
every client on the same code path, which is what makes cross-language
equivalence auditable in the first place.

Verified against the C runtime (``packages/c/src/pretok_program.c`` and its
``codec_unicode_is_ws`` table), not against TypeScript. At recovery time the
TypeScript interpreter's whitespace class disagreed with C and Rust on two
code points (native JS ``\\s`` versus ``\\p{White_Space}``; fixed in commit
``79e93ec``), and TypeScript's metaspace splitter still diverges from C and
Rust on how a run of non-space-or-tab whitespace (e.g. consecutive
newlines) is pieced. Pinning this file's tests to the old TypeScript
behavior would have encoded those bugs as the spec instead of catching
them. See ``packages/python/tests/test_pretok_program.py`` for the in-repo
equivalence tests, which check against C's confirmed values and Python's
own ``regex`` engine instead of the TS reference, and :func:`_run_metaspace`
below for the open question on the metaspace side.
"""
from __future__ import annotations

from typing import Any, List, Mapping, Sequence

from .encoder import METASPACE

# Unicode White_Space=Yes, transcribed from the UCD PropList. This is the
# same 25 code points as packages/c/src/codec_unicode_tables.c's
# WS_CODE_POINTS table, and what Rust's `regex` crate resolves `\s` to.
# spec/PRETOKENIZER_PROGRAM.md § Class membership pins the program's `\s`
# to exactly this set.
#
# This is deliberately NOT `str.isspace()`. CPython's `isspace()` is a
# superset of White_Space -- it also returns True for U+001C-U+001F, the
# information-separator control characters, which carry bidirectional
# class B/S but are not White_Space. Using `isspace()` as a fallback here
# would silently reintroduce the same class of bug that made TypeScript's
# native `\s` disagree with C on 1074 of 10316 differential-tested inputs
# (U+0085 NEXT LINE and U+FEFF ZERO WIDTH NO-BREAK SPACE were the two
# culprits there; see commit 79e93ec). A plain frozenset lookup over the
# exact 25-code-point table is both correct and fast, so no fallback is
# needed at all.
_WHITE_SPACE_CODE_POINTS = (
    0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x0085, 0x00A0,
    0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
    0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F,
    0x3000,
)
_WS_CHARS = frozenset(chr(cp) for cp in _WHITE_SPACE_CODE_POINTS)


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


# ── Op execution ─────────────────────────────────────────────────────────────


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


def _match_letters(op: Mapping[str, Any], s: str, i: int) -> int:
    """``[^\\r\\n\\p{L}\\p{N}]?\\p{L}+`` (or just ``\\p{L}+`` if lead_other is off)."""
    p = i
    if op.get("lead_other"):
        if p < len(s):
            cp = s[p]
            if cp != "\r" and cp != "\n" and not _is_letter(cp) and not _is_number(cp):
                p += 1
    run_start = p
    while p < len(s) and _is_letter(s[p]):
        p += 1
    if p == run_start:
        return 0
    return p - i


def _match_numbers(op: Mapping[str, Any], s: str, i: int) -> int:
    """``\\p{N}+`` if max_run==0, else ``\\p{N}{1,max_run}``."""
    p = i
    max_run = op.get("max_run", 0) or 0
    count = 0
    limit = max_run if max_run > 0 else float("inf")
    while p < len(s) and count < limit and _is_number(s[p]):
        p += 1
        count += 1
    return p - i


def _match_punct_run(op: Mapping[str, Any], s: str, i: int) -> int:
    """`` ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*`` with toggleable lead/trailing."""
    p = i
    if op.get("lead_space") and p < len(s) and s[p] == " ":
        p += 1
    run_start = p
    while p < len(s):
        cp = s[p]
        if _is_ws(cp) or _is_letter(cp) or _is_number(cp):
            break
        p += 1
    if p == run_start:
        return 0
    if op.get("trailing_newlines"):
        while p < len(s) and (s[p] == "\n" or s[p] == "\r"):
            p += 1
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


# ── Metaspace shortcut (single-op programs) ─────────────────────────────────


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

    Open question, NOT resolved by this file: for a run of more than one
    non-space-or-tab whitespace code point in the middle of the input
    (e.g. two consecutive newlines), C and Rust agree the whole run is a
    pure separator that produces no piece of its own (``"a\\n\\nb"`` ->
    ``["▁a", "▁b"]``). TypeScript, prior to this file being
    ported, emitted a spurious ``▁\\n`` piece per extra newline
    (``["▁a", "▁\\n", "▁\\n", "▁b"]``). Whichever of
    those is correct against HuggingFace's own ``Metaspace``
    pre-tokenizer (which reportedly keeps a trailing newline attached to
    the adjacent word, a third possible answer) was not established
    before this file landed. This implementation follows C and Rust
    because they agree with each other; it does not claim they match
    HuggingFace.
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

_MATCHERS = {
    "literals_ci": _match_literals_ci,
    "letters": _match_letters,
    "numbers": _match_numbers,
    "punct_run": _match_punct_run,
    "newline_block": _match_newline_block,
    "trailing_ws": _match_trailing_ws,
    "ws_run": _match_ws_run,
}


def run_pretok_program(prog: Mapping[str, Any], text: str) -> List[str]:
    """Run a pre-tokenizer program over ``text`` and return the pieces.

    Mirrors ``runPreTokProgram`` in the TS reference. Single-op metaspace
    programs delegate to a dedicated splitter; the GPT-2-family loop below
    doesn't apply to those.
    """
    ops: Sequence[Mapping[str, Any]] = prog.get("ops") or ()
    if len(ops) == 1 and ops[0].get("op") == "metaspace_split":
        return _run_metaspace(ops[0], text)

    out: List[str] = []
    n = len(text)
    i = 0
    while i < n:
        matched = False
        for op in ops:
            kind = op.get("op")
            if kind == "metaspace_split":
                # Mixed programs aren't legal; metaspace is single-op only.
                continue
            fn = _MATCHERS.get(kind or "")
            if fn is None:
                continue
            span = fn(op, text, i)
            if span > 0:
                out.append(text[i:i + span])
                i += span
                matched = True
                break
        if not matched:
            # Defensive fallback: well-formed GPT-2-family programs end
            # with ws_run, so any remaining non-whitespace becomes a
            # letters/numbers/punct_run match. This single-codepoint emit
            # only guards against a pathological/malformed program.
            out.append(text[i])
            i += 1
    return out


__all__ = ["run_pretok_program", "METASPACE"]
