"""Core types for the Codec protocol.

A `TokenizerMap` is a per-model tokenizer dialect — the data needed to encode
text into token IDs and decode IDs back to text. Maps are immutable once
published; a new model version publishes a new map at a new URL with a new
sha256 hash.
"""
from __future__ import annotations

import abc
import json
from dataclasses import dataclass, field
from typing import Any


class TokenizerMapValidationError(ValueError):
    """Raised when a tokenizer map fails the schema check."""

    def __init__(self, message: str) -> None:
        super().__init__(f"TokenizerMap validation failed: {message}")


@dataclass(frozen=True, slots=True)
class CodecFrame:
    """One streaming frame produced by a Codec-compliant server.

    Identical shape across MessagePack and Protobuf wire modes; only
    serialization differs.
    """

    ids: tuple[int, ...]
    """Token IDs emitted by the model in this chunk."""

    done: bool
    """``True`` on the final frame — no further frames follow."""

    finish_reason: str | None = None
    """Set on the final frame. e.g. ``"length"``, ``"stop"``, ``"eos_token"``, ``"error"``."""


@dataclass(frozen=True)
class TokenizerMap:
    """A per-model tokenizer dialect.

    Schema v2: :attr:`vocab` is the raw HuggingFace tokenizer.json form
    (byte-level GPT-2-encoded chars or ▁-prefixed metaspace strings).
    :attr:`tokens` is the legacy v1 field, kept for backwards compatibility —
    the Detokenizer reads from whichever is present.
    """

    id: str
    """Stable, globally unique tokenizer identifier (e.g. ``"qwen/qwen2"``)."""

    version: str
    """Schema version. ``"2"`` for v2 maps; ``"1"`` for legacy v1."""

    vocab_size: int
    """Total number of token IDs in the vocabulary."""

    vocab: dict[str, int] | None = None
    """Vocabulary as ``{ raw_token_text: id }``. v2 schema field."""

    tokens: dict[str, str] | None = None
    """Legacy v1 vocabulary as ``{ id_string: decoded_text }``."""

    encoder: str | None = None
    """Encoder family: ``"byte_level"``, ``"metaspace"``, or ``None`` (identity)."""

    merges: list[str] | None = None
    """BPE merges in priority order. Each entry is ``"left right"``."""

    pre_tokenizer_pattern: str | None = None
    """Pre-tokenizer regex (byte_level only)."""

    byte_fallback_start: int | None = None
    byte_fallback_end: int | None = None

    special_tokens: dict[str, int] | None = None

    published_at: str | None = None

    @classmethod
    def from_json(cls, data: bytes | str | dict[str, Any]) -> TokenizerMap:
        """Parse a TokenizerMap from JSON bytes/str/dict and validate it."""
        if isinstance(data, (bytes, bytearray)):
            obj = json.loads(data)
        elif isinstance(data, str):
            obj = json.loads(data)
        else:
            obj = data
        validate(obj)
        return cls(
            id=obj["id"],
            version=str(obj.get("version", "2")),
            vocab_size=int(obj["vocab_size"]),
            vocab=obj.get("vocab"),
            tokens=obj.get("tokens"),
            encoder=obj.get("encoder"),
            merges=obj.get("merges"),
            pre_tokenizer_pattern=obj.get("pre_tokenizer_pattern"),
            byte_fallback_start=obj.get("byte_fallback_start"),
            byte_fallback_end=obj.get("byte_fallback_end"),
            special_tokens=obj.get("special_tokens"),
            published_at=obj.get("published_at"),
        )


def validate(obj: Any) -> None:
    """Validate a parsed map dict against the v1/v2 schema."""
    if not isinstance(obj, dict):
        raise TokenizerMapValidationError("not an object")
    if not isinstance(obj.get("id"), str) or not obj["id"]:
        raise TokenizerMapValidationError("id must be a non-empty string")
    if not isinstance(obj.get("version"), str) or not obj["version"]:
        raise TokenizerMapValidationError("version must be a non-empty string")
    if not isinstance(obj.get("vocab_size"), int) or obj["vocab_size"] < 1:
        raise TokenizerMapValidationError("vocab_size must be a positive integer")
    has_vocab = isinstance(obj.get("vocab"), dict) and obj["vocab"]
    has_tokens = isinstance(obj.get("tokens"), dict) and obj["tokens"]
    if not has_vocab and not has_tokens:
        raise TokenizerMapValidationError("one of `vocab` (v2) or `tokens` (v1) is required")
    if obj.get("encoder") not in (None, "byte_level", "metaspace"):
        raise TokenizerMapValidationError(
            f"encoder must be 'byte_level' or 'metaspace' if present, got {obj['encoder']!r}"
        )
    if obj.get("merges") is not None and not isinstance(obj["merges"], list):
        raise TokenizerMapValidationError("merges must be a list of strings")
    bfs = obj.get("byte_fallback_start")
    bfe = obj.get("byte_fallback_end")
    if (bfs is None) != (bfe is None):
        raise TokenizerMapValidationError(
            "byte_fallback_start and byte_fallback_end must both be set or both omitted"
        )


# ── Pluggable cache ──────────────────────────────────────────────────────────


class MapCache(abc.ABC):
    """Pluggable cache for loaded maps."""

    @abc.abstractmethod
    async def get(self, key: str) -> TokenizerMap | None:
        ...

    @abc.abstractmethod
    async def set(self, key: str, value: TokenizerMap) -> None:
        ...


class MemoryMapCache(MapCache):
    """Default in-memory cache."""

    def __init__(self) -> None:
        self._store: dict[str, TokenizerMap] = {}

    async def get(self, key: str) -> TokenizerMap | None:
        return self._store.get(key)

    async def set(self, key: str, value: TokenizerMap) -> None:
        self._store[key] = value
