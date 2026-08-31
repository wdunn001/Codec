"""Text → token IDs.

Two tokenizer implementations:

- :class:`BPETokenizer`: pure-Python BPE, byte_level + metaspace. Use for
  any v2 map that has merges (every map fetched from ``codec-maps`` for a
  real model).
- :class:`LongestMatchTokenizer`: vocab-only longest-prefix-match. Suitable
  for canonical-IR / synthetic test maps.

:func:`pick_tokenizer` returns the right one for a given map.
"""
from __future__ import annotations

import re as _stdlib_re
from abc import ABC, abstractmethod
from typing import Any

# Use the third-party `regex` module for the byte_level pre-tokenizer pattern,
# which uses Unicode property classes (\p{L}, \p{N}) that stdlib `re` doesn't
# support. Falls back to `re` for the simpler whitespace-collapsing patterns.
import regex

from .encoder import METASPACE, encode_byte_level_chars
from .pretok_program import run_pretok_program
from .types import TokenizerMap

_DELIMITER_BODY = _stdlib_re.compile(r"^[A-Za-z0-9_-]+$")


def _is_delimiter_shape(tok: str) -> bool:
    """Match ``<|body|>`` where body is non-empty and identifier-like.

    Catches every shipped chat-template and tool-call delimiter while
    excluding pathological vocab BPE tokens like Falcon's ``<|>`` (id
    61799) that share the start/end pair.
    """
    if len(tok) <= 4:
        return False
    if not (tok.startswith("<|") and tok.endswith("|>")):
        return False
    return bool(_DELIMITER_BODY.match(tok[2:-2]))


class Tokenizer(ABC):
    """Common interface every tokenizer satisfies."""

    @property
    @abstractmethod
    def id(self) -> str:
        ...

    @abstractmethod
    def encode(self, text: str) -> list[int]:
        ...


# ── BPE ──────────────────────────────────────────────────────────────────────


class BPETokenizer(Tokenizer):
    """Pure-Python BPE encoder. Text → token IDs.

    Algorithm (for both byte_level and metaspace BPE):

    1. Pre-tokenize: split input text into pieces (regex for byte_level,
       whitespace for metaspace).
    2. Encode each piece into the vocab's character space (GPT-2 byte chars
       or ``▁``-prefixed).
    3. Apply BPE merges greedily by priority: match HuggingFace reference.
    4. Look up final tokens in :attr:`vocab`. Tokens not in the vocab fall
       back to byte tokens (metaspace path).
    """

    __slots__ = (
        "_id", "_encoder", "_vocab", "_merge_ranks", "_pre_tok_re",
        "_pre_tok_program",
        "_byte_fallback_start", "_cache",
        "_special_ids", "_special_re",
    )

    @staticmethod
    def supports(m: TokenizerMap) -> bool:
        """True if the map has the data this tokenizer needs."""
        return bool(
            m.vocab
            and m.merges
            and m.encoder in ("byte_level", "metaspace")
        )

    def __init__(self, m: TokenizerMap) -> None:
        if not BPETokenizer.supports(m):
            raise ValueError(
                f"BPETokenizer: map {m.id!r} lacks vocab/merges/encoder. "
                "Use BPETokenizer.supports(map) to check first, or call "
                "pick_tokenizer(map) which falls back to LongestMatchTokenizer."
            )

        assert m.vocab is not None
        assert m.merges is not None

        self._id = m.id
        self._encoder = m.encoder
        self._vocab: dict[str, int] = dict(m.vocab)
        self._merge_ranks: dict[str, int] = {entry: i for i, entry in enumerate(m.merges)}
        self._byte_fallback_start = m.byte_fallback_start if m.byte_fallback_start is not None else -1
        self._cache: dict[str, list[int]] = {}

        # Pre-tokenizer: prefer the compiled program when present, otherwise
        # fall back to the legacy regex. Programs are required for clients
        # without a Unicode regex engine (libcodec/C); Python already has
        # one via the `regex` package, so the program here is mostly a
        # startup-time speedup plus keeping every client on the same
        # code path, which is what makes the equivalence claim auditable.
        if self._encoder == "byte_level":
            if m.pre_tokenizer_program and m.pre_tokenizer_program.get("ops"):
                self._pre_tok_program: dict[str, Any] | None = m.pre_tokenizer_program
                self._pre_tok_re = None
            elif m.pre_tokenizer_pattern:
                self._pre_tok_re = regex.compile(m.pre_tokenizer_pattern)
                self._pre_tok_program = None
            else:
                raise ValueError(
                    f"BPETokenizer: byte_level map {m.id!r} missing both "
                    "pre_tokenizer_program and pre_tokenizer_pattern."
                )
        else:
            self._pre_tok_re = None
            self._pre_tok_program = None

        # Build the special-token scanner. Accept entries from
        # ``special_tokens`` AND any vocab key in ``<|body|>`` shape where
        # body is non-empty and identifier-like: older maps shipped
        # before a chat-template revision may carry the delimiters in
        # vocab but not in special_tokens. Length-descending order makes
        # the regex match the longest delimiter at any position. Without
        # this pre-scan, ``<|im_start|>`` would tokenise byte-by-byte
        # instead of as the single atomic vocab ID. The body constraint
        # excludes pathological vocab tokens like Falcon's ``<|>`` (id
        # 61799) that share the start/end pair.
        special: dict[str, int] = dict(m.special_tokens or {})
        for tok, tid in self._vocab.items():
            if tok in special:
                continue
            if _is_delimiter_shape(tok):
                special[tok] = tid
        self._special_ids: dict[str, int] = special
        if special:
            keys = sorted(special.keys(), key=len, reverse=True)
            self._special_re: regex.Pattern[str] | None = regex.compile(
                "|".join(regex.escape(k) for k in keys)
            )
        else:
            self._special_re = None

    @property
    def id(self) -> str:
        return self._id

    def encode(self, text: str) -> list[int]:
        if not text:
            return []

        if self._special_re is not None:
            out: list[int] = []
            cursor = 0
            for m in self._special_re.finditer(text):
                if m.start() > cursor:
                    self._encode_chunk(text[cursor:m.start()], out)
                out.append(self._special_ids[m.group(0)])
                cursor = m.end()
            if cursor < len(text):
                self._encode_chunk(text[cursor:], out)
            return out

        ids: list[int] = []
        self._encode_chunk(text, ids)
        return ids

    def _encode_chunk(self, text: str, out: list[int]) -> None:
        if not text:
            return
        for piece in self._pre_tokenize(text):
            cached = self._cache.get(piece)
            if cached is not None:
                out.extend(cached)
                continue
            encoded = self._encode_piece_to_vocab_space(piece)
            merged = self._apply_bpe(encoded)
            piece_ids = self._lookup(merged)
            self._cache[piece] = piece_ids
            out.extend(piece_ids)

    # ── Pre-tokenization ────────────────────────────────────────────────────

    def _pre_tokenize(self, text: str) -> list[str]:
        if self._encoder == "byte_level":
            if self._pre_tok_program is not None:
                return run_pretok_program(self._pre_tok_program, text)
            assert self._pre_tok_re is not None
            return [m for m in self._pre_tok_re.findall(text) if m]

        # Metaspace: split on whitespace, prefix every word with ▁.
        # Mirrors the JS implementation: collapse runs of spaces/tabs to
        # single spaces, then attach ▁ to each non-whitespace piece.
        collapsed = _stdlib_re.sub(r"[ \t]+", " ", text)
        out: list[str] = []
        for part in _stdlib_re.split(r"(\s)", collapsed):
            if not part or part == " ":
                continue
            out.append(METASPACE + part)
        return out

    # ── Step 2: piece → vocab character space ──────────────────────────────

    def _encode_piece_to_vocab_space(self, piece: str) -> list[str]:
        if self._encoder == "byte_level":
            return list(encode_byte_level_chars(piece.encode("utf-8")))
        # metaspace: piece is already in vocab space
        return list(piece)

    # ── Step 3: BPE merges ─────────────────────────────────────────────────

    def _apply_bpe(self, tokens: list[str]) -> list[str]:
        if len(tokens) < 2:
            return tokens

        parts = list(tokens)
        while True:
            best_idx = -1
            best_rank = float("inf")
            for i in range(len(parts) - 1):
                key = parts[i] + " " + parts[i + 1]
                rank = self._merge_ranks.get(key)
                if rank is not None and rank < best_rank:
                    best_rank = rank
                    best_idx = i
            if best_idx == -1:
                break

            # Merge ALL non-overlapping occurrences of that pair in one pass:
            # matches HuggingFace.
            left = parts[best_idx]
            right = parts[best_idx + 1]
            merged = left + right
            new_parts: list[str] = []
            i = 0
            while i < len(parts):
                if i < len(parts) - 1 and parts[i] == left and parts[i + 1] == right:
                    new_parts.append(merged)
                    i += 2
                else:
                    new_parts.append(parts[i])
                    i += 1
            parts = new_parts

        return parts

    # ── Step 4: vocab lookup with byte fallback ────────────────────────────

    def _lookup(self, tokens: list[str]) -> list[int]:
        ids: list[int] = []
        for tok in tokens:
            tok_id = self._vocab.get(tok)
            if tok_id is not None:
                ids.append(tok_id)
                continue
            if self._byte_fallback_start >= 0:
                # Metaspace + SentencePiece byte_fallback: emit raw UTF-8 bytes.
                for b in tok.encode("utf-8"):
                    ids.append(self._byte_fallback_start + b)
            # For byte_level this branch is unreachable for valid UTF-8 input.
        return ids


# ── LongestMatch ─────────────────────────────────────────────────────────────


class LongestMatchTokenizer(Tokenizer):
    """Vocab-only longest-prefix-match tokenizer. Fallback for non-BPE maps."""

    __slots__ = ("_id", "_fragment_to_id", "_max_fragment_length", "_special_fragment_to_id")

    def __init__(self, m: TokenizerMap) -> None:
        self._id = m.id
        self._fragment_to_id: dict[str, int] = {}
        max_len = 1

        if m.vocab is not None:
            for fragment, tok_id in m.vocab.items():
                if not fragment:
                    continue
                self._fragment_to_id[fragment] = tok_id
                if len(fragment) > max_len:
                    max_len = len(fragment)
        if m.tokens is not None:
            for id_str, fragment in m.tokens.items():
                if not fragment:
                    continue
                try:
                    tok_id = int(id_str)
                except ValueError:
                    continue
                self._fragment_to_id[fragment] = tok_id
                if len(fragment) > max_len:
                    max_len = len(fragment)

        self._max_fragment_length = max_len
        self._special_fragment_to_id: dict[str, int] = {}
        if m.special_tokens is not None:
            for name, tok_id in m.special_tokens.items():
                self._special_fragment_to_id[name] = tok_id
                if not name.startswith("<"):
                    self._special_fragment_to_id[f"<|{name}|>"] = tok_id

    @property
    def id(self) -> str:
        return self._id

    def encode(self, text: str) -> list[int]:
        out: list[int] = []
        pos = 0
        n = len(text)
        while pos < n:
            consumed = False
            for frag, tok_id in self._special_fragment_to_id.items():
                if text.startswith(frag, pos):
                    out.append(tok_id)
                    pos += len(frag)
                    consumed = True
                    break
            if consumed:
                continue

            remaining = n - pos
            try_up_to = min(self._max_fragment_length, remaining)
            matched_id = -1
            matched_len = 0
            for length in range(try_up_to, 0, -1):
                candidate = text[pos:pos + length]
                tok_id = self._fragment_to_id.get(candidate)
                if tok_id is not None:
                    matched_id = tok_id
                    matched_len = length
                    break

            if matched_id == -1:
                out.append(0)  # UNK by convention
                pos += 1
            else:
                out.append(matched_id)
                pos += matched_len
        return out


# ── Factory ──────────────────────────────────────────────────────────────────


def pick_tokenizer(m: TokenizerMap) -> Tokenizer:
    """Build the right tokenizer for the map."""
    if BPETokenizer.supports(m):
        return BPETokenizer(m)
    return LongestMatchTokenizer(m)


def tokenize(m: TokenizerMap, text: str) -> list[int]:
    """One-shot encode using :func:`pick_tokenizer`."""
    return pick_tokenizer(m).encode(text)
