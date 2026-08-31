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

Verified byte-for-byte against the TypeScript reference
(``packages/web/src/pretok-program.ts``) across 5 program variants and 26
stress inputs (130 cases total, 0 mismatches) as part of landing this
module. See ``packages/python/tests/test_pretok_program.py`` for the
in-repo equivalence tests that keep that claim enforced.
"""
from __future__ import annotations

from typing import Any, List, Mapping, Sequence

from .encoder import METASPACE

# ASCII whitespace plus the Unicode WS code points typical pre-tokenizers
# regard as ``\\s``. Matches what Python's ``regex`` package treats as
# ``\\s`` under the default flags. A frozen set plus ``str.isspace()``
# fallback is used rather than calling ``regex`` on each character; the hot
# loop runs millions of times and method-call overhead dominates there.
_WS_CHARS = frozenset({
    " ", "\t", "\n", "\r", "\x0b", "\x0c",
    " ", " ", " ", "　",
})


def _is_ws(cp: str) -> bool:
    # Fast path for the common cases, fallback to str.isspace for the
    # long tail of Unicode whitespace.
    return cp in _WS_CHARS or cp.isspace()


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
    out: List[str] = []
    # Collapse runs of ASCII space/tab to a single space, then split on
    # whitespace. Mirrors the TS implementation's runMetaspace exactly.
    import re

    trimmed = re.sub(r"[ \t]+", " ", text)
    parts = [p for p in re.split(r"(\s)", trimmed) if p]
    is_first = True
    prefix_first = bool(op.get("prefix_first"))
    for p in parts:
        if p == " ":
            is_first = False
            continue
        if prefix_first and is_first:
            out.append(p)
        else:
            out.append(METASPACE + p)
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
