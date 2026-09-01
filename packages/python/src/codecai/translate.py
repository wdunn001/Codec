"""Translator: cross-vocab token-stream pipe.

Take Agent A's token IDs in vocab V_A, produce Agent B's token IDs in
vocab V_B, with no text ever leaving the process. Internally::

    ids_A -> Detokenizer(V_A) -> utf8 -> BPETokenizer(V_B) -> ids_B

The text intermediate is purely local; agent-to-agent traffic still
carries only token IDs on the wire. Mirrors the TS ``Translator`` class
from ``@codecai/web``: same word-boundary buffering rules.

Streaming caveat: BPE merges depend on context. Re-tokenizing partial
words mid-stream produces different IDs than re-tokenizing the complete
word. The Translator buffers text until a safe boundary (whitespace)
before flushing through BPE. Pass ``partial=True`` for incoming chunks
and ``partial=False`` (or call :meth:`finish`) on the last chunk so the
buffer drains.
"""
from __future__ import annotations

from typing import Iterable, Sequence

from .detokenize import Detokenizer
from .tokenize import Tokenizer, pick_tokenizer
from .types import TokenizerMap


# ASCII whitespace + common Unicode whitespace block: covers the
# pre-tokenizer regexes used by Llama-3, Qwen, Phi-3, Mistral, etc.
_WHITESPACE_CODEPOINTS = frozenset({
    0x20, 0x09, 0x0A, 0x0D, 0x0B, 0x0C,
    0x00A0, 0x2028, 0x2029, 0x3000,
})


class Translator:
    """Cross-vocab agent-handoff pipe.

    Construct with a source map and a target map. Call :meth:`translate`
    repeatedly with chunks of source IDs; receive chunks of target IDs.
    Stateful across calls: partial words buffer internally.
    """

    __slots__ = (
        "from_id", "to_id",
        "_from_detok", "_to_tok", "_text_buffer",
    )

    def __init__(self, from_map: TokenizerMap, to_map: TokenizerMap) -> None:
        self.from_id: str = from_map.id
        self.to_id:   str = to_map.id
        self._from_detok: Detokenizer = Detokenizer(from_map)
        self._to_tok: Tokenizer = pick_tokenizer(to_map)
        self._text_buffer: str = ""

    def translate(
        self,
        ids: Sequence[int] | Iterable[int],
        *,
        partial: bool = False,
    ) -> list[int]:
        """Translate a chunk of source-vocab IDs to target-vocab IDs.

        :param partial: ``True`` for streaming chunks (a trailing
            partial word stays buffered). ``False`` (or call
            :meth:`finish`) on the final chunk so the buffer drains.
        """
        # Render through V_A's detokenizer with the same partial flag:
        # the detokenizer handles partial UTF-8 byte sequences for us.
        text = self._from_detok.render(ids, partial=partial)
        if text:
            self._text_buffer += text

        if not partial:
            out = self._to_tok.encode(self._text_buffer)
            self._text_buffer = ""
            return out

        # Streaming chunk: find the last safe boundary and flush
        # before it. Pre-tokenizers split at whitespace. Re-encoding
        # text up to the last whitespace therefore yields the same IDs as
        # re-encoding the complete word later.
        safe = self._find_last_safe_boundary(self._text_buffer)
        if safe <= 0:
            return []

        to_encode = self._text_buffer[:safe]
        self._text_buffer = self._text_buffer[safe:]
        return self._to_tok.encode(to_encode)

    def finish(self) -> list[int]:
        """End-of-stream flush. Equivalent to ``translate([], partial=False)``."""
        return self.translate([], partial=False)

    def reset(self) -> None:
        """Drop all internal state. Call between conversations."""
        self._from_detok.reset()
        self._text_buffer = ""

    @staticmethod
    def _find_last_safe_boundary(s: str) -> int:
        """Return the index just after the last whitespace char, or 0
        if the buffer has no whitespace (nothing safe to flush yet)."""
        for i in range(len(s) - 1, -1, -1):
            if ord(s[i]) in _WHITESPACE_CODEPOINTS:
                return i + 1
        return 0


def translate(
    from_map: TokenizerMap,
    to_map: TokenizerMap,
    ids: Sequence[int] | Iterable[int],
) -> list[int]:
    """Convenience: one-shot translate without keeping a Translator instance.

    Useful for non-streaming cases where you have all the IDs up front.
    """
    return Translator(from_map, to_map).translate(ids)


def static_translation_table(
    from_map: TokenizerMap,
    to_map: TokenizerMap,
) -> dict[int, list[int]]:
    """Build a static V_A -> V_B[] translation table.

    Feeds each V_A token's decoded text through V_B's tokenizer. Useful
    for analysis (vocab overlap, cost estimation) and for fast lookups
    when context-free translation is acceptable.

    Limitations: this is context-free: token boundaries don't align
    across vocabs. BPE merges also depend on context. The single-shot
    result ``static_translation_table(A, B)[id_A]`` may differ from
    what :func:`translate` produces when the same ``id_A`` appears
    mid-sentence. For exact streaming translation, use ``Translator``.
    """
    detok = Detokenizer(from_map)
    tok = pick_tokenizer(to_map)
    out: dict[int, list[int]] = {}

    special_ids: set[int] = set((from_map.special_tokens or {}).values())

    # v2 maps: walk `vocab`
    vocab = from_map.vocab or {}
    for _, id_ in vocab.items():
        if id_ in special_ids:
            continue
        text = detok.render([id_])
        if not text:
            continue
        out[id_] = tok.encode(text)
        detok.reset()

    # v1 maps: also walk `tokens` (keys are str ids)
    tokens = from_map.tokens or {}
    for id_str in tokens.keys():
        try:
            id_ = int(id_str)
        except (TypeError, ValueError):
            continue
        if id_ in special_ids or id_ in out:
            continue
        text = detok.render([id_])
        if not text:
            continue
        out[id_] = tok.encode(text)
        detok.reset()

    return out


__all__ = ["Translator", "translate", "static_translation_table"]
