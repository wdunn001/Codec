"""GPT-2 byte↔unicode mapping table and shared encoder utilities.

Used by both :class:`Detokenizer` (to recover bytes from byte-level tokens)
and :class:`BPETokenizer` (to encode input bytes into the vocab's
character space).
"""
from __future__ import annotations

METASPACE = "▁"  # ▁: SentencePiece metaspace marker.


def _build_byte_unicode_tables() -> tuple[dict[int, str], dict[str, int]]:
    """Build the GPT-2 byte→unicode mapping table.

    The 256-entry bijection used by tiktoken / GPT-2 / Llama-3 / Qwen-2 BPE
    tokenizers. Bytes 33-126 (printable ASCII), 161-172, 174-255 map to
    themselves; all other bytes map to characters starting at U+0100 (``Ā``).
    """
    bs: list[int] = list(range(33, 127)) + list(range(161, 173)) + list(range(174, 256))
    cs: list[int] = list(bs)
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    byte_to_char: dict[int, str] = {}
    char_to_byte: dict[str, int] = {}
    for byte_val, code_point in zip(bs, cs):
        char = chr(code_point)
        byte_to_char[byte_val] = char
        char_to_byte[char] = byte_val
    return byte_to_char, char_to_byte


_BYTE_TO_CHAR, _CHAR_TO_BYTE = _build_byte_unicode_tables()


def byte_to_char(b: int) -> str:
    """Map a byte (0 to 255) to its GPT-2-encoded character."""
    return _BYTE_TO_CHAR[b]


def char_to_byte(ch: str) -> int | None:
    """Reverse the GPT-2 byte→unicode table; return None if outside the table."""
    return _CHAR_TO_BYTE.get(ch)


def decode_byte_level_token(raw_token: str) -> bytes:
    """Decode a byte-level BPE token (e.g. ``"Ġhello"``) to its raw bytes.

    Reverses the GPT-2 byte→unicode table. Characters outside the table
    fall back to UTF-8 encoding (defensive: shouldn't happen for valid
    vocab entries).
    """
    out = bytearray()
    for ch in raw_token:
        b = _CHAR_TO_BYTE.get(ch)
        if b is not None:
            out.append(b)
        else:
            out.extend(ch.encode("utf-8"))
    return bytes(out)


def encode_byte_level_chars(data: bytes) -> str:
    """Encode raw bytes into a string of GPT-2 byte-encoded characters.

    The result matches the keys of a byte_level vocab: used by the BPE
    tokenizer to look up tokens after pre-tokenization.
    """
    return "".join(_BYTE_TO_CHAR[b] for b in data)
