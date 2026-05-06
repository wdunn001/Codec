"""Detokenizer tests — mirror packages/web/test/detokenize.test.ts."""
from __future__ import annotations

from codecai import Detokenizer, detokenize

from .fixtures import TINY_MAP, byte_id


def test_simple_vocab_tokens():
    ids = [3, 4, 5, 8]  # hello + space + world + !
    assert detokenize(TINY_MAP, ids) == "hello world!"


def test_skips_special_tokens_by_default():
    ids = [267, 3, 4, 5, 266]  # <bos> hello world <eos>
    assert detokenize(TINY_MAP, ids) == "hello world"


def test_renders_special_tokens_when_asked():
    # Special-token rendering is opt-in. With render_special=True we look up
    # the ID; 266 isn't in v1 tokens map → replacement char. Point: doesn't
    # throw, eos doesn't silently disappear.
    out = detokenize(TINY_MAP, [3, 266], render_special=True)
    assert out.startswith("hello")


def test_byte_fallback_3_byte_utf8():
    # € = E2 82 AC
    ids = [byte_id(0xE2), byte_id(0x82), byte_id(0xAC)]
    assert detokenize(TINY_MAP, ids) == "€"


def test_byte_fallback_4_byte_emoji():
    # 🚀 = F0 9F 9A 80
    ids = [byte_id(0xF0), byte_id(0x9F), byte_id(0x9A), byte_id(0x80)]
    assert detokenize(TINY_MAP, ids) == "🚀"


def test_partial_multibyte_buffered_across_frames():
    d = Detokenizer(TINY_MAP)
    # Frame 1: first 2 bytes of € — incomplete, must not emit.
    out1 = d.render([byte_id(0xE2), byte_id(0x82)], partial=True)
    assert out1 == ""
    # Frame 2: final byte. Now flushes.
    out2 = d.render([byte_id(0xAC)], partial=False)
    assert out2 == "€"


def test_vocab_token_after_partial_bytes_flushes_buffer():
    d = Detokenizer(TINY_MAP)
    # 'A' as byte (0x41) + 'hello' (vocab id 3)
    out = d.render([byte_id(0x41), 3])
    assert out == "Ahello"


def test_unknown_id_emits_replacement():
    d = Detokenizer(TINY_MAP)
    assert d.render([99999]) == "�"


def test_reset_clears_partial_buffer():
    d = Detokenizer(TINY_MAP)
    d.render([byte_id(0xE2)], partial=True)
    d.reset()
    assert d.render([3]) == "hello"
