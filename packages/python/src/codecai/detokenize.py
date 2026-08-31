"""Detokenizer: token IDs → text.

Three correctness concerns it handles:

1. Per-token decoding via the map's encoder (byte_level / metaspace / identity).
2. Byte-fallback range: IDs in ``[byte_fallback_start, byte_fallback_end]``
   are decoded as raw bytes and accumulated until a valid UTF-8 sequence forms.
3. Partial multi-byte sequences across frame boundaries: buffered between
   calls when ``partial=True``.
"""
from __future__ import annotations

import re
from collections.abc import Iterable

from .encoder import METASPACE, decode_byte_level_token
from .types import TokenizerMap

_BYTE_FALLBACK_RE = re.compile(r"^<0x[0-9A-Fa-f]{2}>$")
_REPLACEMENT = "�"


def _utf8_sequence_length(b: int) -> int:
    """Byte count of the UTF-8 sequence starting with ``b``, or 0 if invalid leading byte."""
    if (b & 0x80) == 0x00:
        return 1
    if (b & 0xE0) == 0xC0:
        return 2
    if (b & 0xF0) == 0xE0:
        return 3
    if (b & 0xF8) == 0xF0:
        return 4
    return 0


class Detokenizer:
    """Stateful detokenizer. Render IDs to text incrementally.

    Across calls, partial multi-byte sequences carry over until completed by
    a later chunk (when ``partial=True``).
    """

    __slots__ = (
        "_map",
        "_special_ids",
        "_fallback_start",
        "_fallback_end",
        "_id_to_bytes",
        "_id_to_text",
        "_byte_buffer",
    )

    def __init__(self, tokenizer_map: TokenizerMap) -> None:
        self._map = tokenizer_map
        self._special_ids: frozenset[int] = (
            frozenset(tokenizer_map.special_tokens.values())
            if tokenizer_map.special_tokens
            else frozenset()
        )
        self._fallback_start = (
            tokenizer_map.byte_fallback_start if tokenizer_map.byte_fallback_start is not None else -1
        )
        self._fallback_end = (
            tokenizer_map.byte_fallback_end if tokenizer_map.byte_fallback_end is not None else -2
        )

        if tokenizer_map.encoder == "byte_level":
            self._id_to_bytes: dict[int, bytes] | None = _build_byte_level_table(tokenizer_map)
            self._id_to_text: dict[int, str] | None = None
        else:
            self._id_to_bytes = None
            self._id_to_text = _build_text_table(tokenizer_map)

        self._byte_buffer: bytearray = bytearray()

    def render(
        self,
        ids: Iterable[int],
        *,
        partial: bool = False,
        render_special: bool = False,
    ) -> str:
        """Render a chunk of IDs to text. Stateful across calls."""
        out: list[str] = []

        for tok_id in ids:
            # Byte-fallback range: SentencePiece reserves IDs for raw bytes 0x00-0xFF.
            if self._fallback_start <= tok_id <= self._fallback_end:
                self._byte_buffer.append(tok_id - self._fallback_start)
                self._flush_complete(out)
                continue

            if self._id_to_bytes is not None:
                # byte_level: every vocab token IS a byte sequence.
                if tok_id in self._special_ids and not render_special:
                    if self._byte_buffer:
                        self._flush_force(out)
                    continue
                bs = self._id_to_bytes.get(tok_id)
                if bs is None:
                    if self._byte_buffer:
                        self._flush_force(out)
                    out.append(_REPLACEMENT)
                    continue
                self._byte_buffer.extend(bs)
                self._flush_complete(out)
                continue

            # metaspace / identity: token text rendered directly.
            if self._byte_buffer:
                self._flush_force(out)
            if tok_id in self._special_ids and not render_special:
                continue
            text = self._id_to_text.get(tok_id) if self._id_to_text else None
            out.append(text if text is not None else _REPLACEMENT)

        if not partial and self._byte_buffer:
            self._flush_force(out)

        return "".join(out)

    def reset(self) -> None:
        """Reset internal state: call between conversations / requests."""
        self._byte_buffer.clear()

    def _flush_complete(self, out: list[str]) -> None:
        """Flush whatever complete UTF-8 prefix sits in the buffer; keep the rest."""
        while self._byte_buffer:
            needed = _utf8_sequence_length(self._byte_buffer[0])
            if needed == 0:
                del self._byte_buffer[0]
                out.append(_REPLACEMENT)
                continue
            if len(self._byte_buffer) < needed:
                return
            try:
                out.append(bytes(self._byte_buffer[:needed]).decode("utf-8"))
            except UnicodeDecodeError:
                out.append(_REPLACEMENT)
            del self._byte_buffer[:needed]

    def _flush_force(self, out: list[str]) -> None:
        """Flush whatever's in the buffer; replace invalid bytes with U+FFFD."""
        if not self._byte_buffer:
            return
        out.append(bytes(self._byte_buffer).decode("utf-8", errors="replace"))
        self._byte_buffer.clear()


def detokenize(
    tokenizer_map: TokenizerMap,
    ids: Iterable[int],
    *,
    render_special: bool = False,
) -> str:
    """Convenience: detokenize a complete sequence in one shot."""
    return Detokenizer(tokenizer_map).render(ids, partial=False, render_special=render_special)


# ── Internal table builders ──────────────────────────────────────────────────


def _build_byte_level_table(m: TokenizerMap) -> dict[int, bytes]:
    out: dict[int, bytes] = {}
    if m.vocab is None:
        return out
    for token, tok_id in m.vocab.items():
        out[tok_id] = decode_byte_level_token(token)
    return out


def _build_text_table(m: TokenizerMap) -> dict[int, str]:
    out: dict[int, str] = {}
    is_metaspace = m.encoder == "metaspace"
    if m.vocab is not None:
        for token, tok_id in m.vocab.items():
            # SentencePiece byte-fallback tokens (<0xHH>) live in vocab but
            # are handled by the byte_fallback range path.
            if _BYTE_FALLBACK_RE.match(token):
                continue
            text = token.replace(METASPACE, " ") if is_metaspace else token
            out[tok_id] = text
    if m.tokens is not None:
        for id_str, text in m.tokens.items():
            try:
                out[int(id_str)] = text
            except ValueError:
                continue
    return out
