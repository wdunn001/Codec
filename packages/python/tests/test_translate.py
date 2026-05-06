"""Translator tests — mirror packages/web/test/translate.test.ts.

Three layers of verification:
  1. Synthetic byte_level fixture round-trips with itself (identity).
  2. Real Qwen-2 -> Qwen-2 (identity over a 152K-vocab production
     tokenizer) — proves the streaming buffering doesn't drop or
     duplicate text. Skipped when codec-maps isn't mounted.
  3. Cross-vocab: real Qwen-2 -> Llama-3 — sanity-checks that
     translated output detokenizes back to the original under the
     target tokenizer. Skipped when either map is missing.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from codecai import (
    BPETokenizer,
    Detokenizer,
    TokenizerMap,
    Translator,
    static_translation_table,
    translate,
)


# ── Synthetic identity translation ──────────────────────────────────────────


def _find_real_map(family: str) -> str | None:
    filename = "qwen2.json" if family == "qwen" else "llama-3.json"
    candidates = [
        Path.cwd() / f"../../../codec-maps/maps/{family}/{filename}",
        Path.cwd() / f"../../codec-maps/maps/{family}/{filename}",
    ]
    env = os.environ.get("CODEC_MAPS_QWEN" if family == "qwen" else "CODEC_MAPS_LLAMA3", "")
    if env:
        candidates.append(Path(env))
    for c in candidates:
        if c.exists():
            return str(c)
    return None


def _load_map(path: str) -> TokenizerMap:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return TokenizerMap.from_json(raw)


# ── Synthetic round-trip via two functioning byte_level maps ────────────────
#
# We can't construct a fully merge-bearing map by hand without writing a real
# BPE training step, so the synthetic test runs against the real Qwen-2 map
# in identity mode (same map used as both source and target). If the real
# map isn't mounted, this test is skipped.


@pytest.mark.skipif(_find_real_map("qwen") is None, reason="qwen2.json not found")
def test_translator_identity_qwen2():
    """Qwen-2 -> Qwen-2 through the Translator must equal a clean
    detokenize round-trip of the same IDs."""
    p = _find_real_map("qwen")
    assert p is not None
    m = _load_map(p)

    text = "The quick brown fox jumps over the lazy dog. 2 + 2 = 4."
    src_ids = BPETokenizer(m).encode(text)

    tr = Translator(m, m)
    out = tr.translate(src_ids, partial=False)

    # Identity translator — IDs in V_A == IDs in V_A — output must
    # detokenize back to the same text under the target map.
    detok_text = Detokenizer(m).render(out)
    assert detok_text == text


@pytest.mark.skipif(_find_real_map("qwen") is None, reason="qwen2.json not found")
def test_translator_streaming_chunks_drain_correctly():
    """Feed source IDs in small chunks with partial=True, then finish().
    The concatenation must equal one-shot translation of the full input."""
    p = _find_real_map("qwen")
    assert p is not None
    m = _load_map(p)

    text = "Hello world. This is a streaming test with several words."
    src_ids = BPETokenizer(m).encode(text)

    # One-shot reference.
    one_shot = Translator(m, m).translate(src_ids, partial=False)

    # Streaming.
    tr = Translator(m, m)
    chunked: list[int] = []
    chunk = 4
    for off in range(0, len(src_ids), chunk):
        chunked.extend(tr.translate(src_ids[off:off + chunk], partial=True))
    chunked.extend(tr.finish())

    # Both paths must round-trip back to the same text.
    rs_one = Detokenizer(m).render(one_shot)
    rs_str = Detokenizer(m).render(chunked)
    assert rs_one == text
    assert rs_str == text


# ── Cross-vocab: Qwen-2 -> Llama-3 ──────────────────────────────────────────


_HAVE_BOTH = (_find_real_map("qwen") is not None
              and _find_real_map("meta-llama") is not None)


@pytest.mark.skipif(not _HAVE_BOTH, reason="need both qwen2 + llama-3 maps")
def test_cross_vocab_qwen2_to_llama3_round_trip():
    """A real cross-vocab handoff: Qwen-2 IDs in, Llama-3 IDs out, and
    the Llama-3 detokenizer renders back to the original text."""
    src = _load_map(_find_real_map("qwen") or "")
    dst = _load_map(_find_real_map("meta-llama") or "")

    text = "The quick brown fox."
    src_ids = BPETokenizer(src).encode(text)

    dst_ids = translate(src, dst, src_ids)
    rendered = Detokenizer(dst).render(dst_ids)
    assert rendered == text


# ── static_translation_table ────────────────────────────────────────────────


@pytest.mark.skipif(_find_real_map("qwen") is None, reason="qwen2.json not found")
def test_static_translation_table_identity_includes_self():
    """Identity table: every non-special V_A id must map to a sequence
    that, when detokenized under V_A, recovers the same text fragment."""
    p = _find_real_map("qwen")
    assert p is not None
    m = _load_map(p)

    table = static_translation_table(m, m)
    # We don't assert table[id] == [id] — context-free re-encoding may
    # split a multi-byte token differently. We assert round-trip text.
    detok = Detokenizer(m)

    sample_count = 0
    for src_id, dst_ids in list(table.items())[:200]:  # spot-check
        src_text = detok.render([src_id])
        detok.reset()
        dst_text = detok.render(dst_ids)
        detok.reset()
        if src_text:
            assert dst_text == src_text, (
                f"id {src_id}: src={src_text!r} dst={dst_text!r}")
            sample_count += 1
    assert sample_count > 0
