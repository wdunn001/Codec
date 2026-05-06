"""Shared test fixtures."""
from __future__ import annotations

import os
from pathlib import Path

from codecai import TokenizerMap

# Tiny synthetic v1-style map covering vocab + special tokens + byte fallback.
TINY_MAP = TokenizerMap(
    id="test-tiny-v1",
    version="1.0.0",
    vocab_size=270,
    tokens={
        "0": "�",  # UNK
        "1": "h",
        "2": "he",
        "3": "hello",
        "4": " ",
        "5": "world",
        "6": "w",
        "7": "wor",
        "8": "!",
        "9": "\n",
    },
    special_tokens={"eos": 266, "bos": 267},
    byte_fallback_start=10,
    byte_fallback_end=265,
)


def byte_id(b: int) -> int:
    """ID for a raw byte in the byte-fallback range."""
    assert TINY_MAP.byte_fallback_start is not None
    return TINY_MAP.byte_fallback_start + b


def find_qwen_map() -> str | None:
    """Locate a real Qwen-2 map for round-trip testing if available locally."""
    candidates = [
        r"H:\dev\codec-maps\maps\qwen\qwen2.json",
        os.path.join(
            os.path.dirname(__file__),
            "..",
            "..",
            "..",
            "..",
            "codec-maps",
            "maps",
            "qwen",
            "qwen2.json",
        ),
    ]
    for c in candidates:
        if Path(c).exists():
            return os.path.abspath(c)
    return None
