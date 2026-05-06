"""ToolWatcher tests — mirror packages/web/test/tool-watcher.test.ts."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from codecai import (
    TokenizerMap,
    ToolWatcher,
    ToolWatcherError,
)


# Synthetic byte_level map. Two specials act as the watcher's markers.
SYN_MAP = TokenizerMap(
    id="test/synth",
    version="2",
    vocab_size=100,
    encoder="byte_level",
    vocab={"hello": 0, "world": 1, "!": 2, "foo": 3, "bar": 4},
    special_tokens={"<tool_call>": 90, "</tool_call>": 91},
)
START = 90
END = 91


def test_passthrough_then_region_then_passthrough():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")
    # "hello world <tool_call> foo bar </tool_call> hello !"
    events = w.feed([0, 1, START, 3, 4, END, 0, 2])
    assert len(events) == 3

    assert events[0].kind == "passthrough"
    assert events[0].ids == (0, 1)

    assert events[1].kind == "region"
    assert events[1].ids == (3, 4)  # markers excluded

    assert events[2].kind == "passthrough"
    assert events[2].ids == (0, 2)

    assert not w.inside


def test_region_split_across_feeds():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")

    # Feed 1: region opens but doesn't close.
    evs = w.feed([0, START, 3])
    assert len(evs) == 1
    assert evs[0].kind == "passthrough"
    assert evs[0].ids == (0,)
    assert w.inside

    # Feed 2: closes the region with body accumulated across both feeds.
    evs = w.feed([4, END, 1])
    assert len(evs) == 2
    assert evs[0].kind == "region"
    assert evs[0].ids == (3, 4)
    assert evs[1].kind == "passthrough"
    assert evs[1].ids == (1,)
    assert not w.inside


def test_multiple_regions_in_one_feed():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")
    evs = w.feed([0, START, 3, END, 1, START, 4, END, 2])
    assert len(evs) == 5
    assert [e.kind for e in evs] == [
        "passthrough", "region", "passthrough", "region", "passthrough",
    ]
    assert evs[1].ids == (3,)
    assert evs[3].ids == (4,)


def test_stray_end_passes_through():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")
    evs = w.feed([0, END, 1])
    # End with no preceding start — treated as ordinary token.
    assert len(evs) == 1
    assert evs[0].kind == "passthrough"
    assert evs[0].ids == (0, END, 1)


def test_missing_special_name_raises():
    with pytest.raises(ToolWatcherError):
        ToolWatcher(SYN_MAP, "<not_real>", "</tool_call>")


def test_reset_drops_in_flight_region():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")
    w.feed([START, 3, 4])
    assert w.inside
    w.reset()
    assert not w.inside
    # End marker now becomes a stray (no buffered body).
    evs = w.feed([END, 1])
    assert len(evs) == 1
    assert evs[0].kind == "passthrough"
    assert evs[0].ids == (END, 1)


def test_never_decodes_operates_on_raw_ids():
    """No-decode contract — mirror of test_watcher_does_not_decode_tokens
    in libcodec and the TS test of the same name. Use a map with empty
    vocab and feed IDs outside any plausible vocab range. The watcher
    must emit them verbatim."""
    no_vocab = TokenizerMap(
        id="test/no-vocab",
        version="2",
        vocab_size=4,
        encoder="byte_level",
        vocab={},
        special_tokens={"<tool_call>": 90, "</tool_call>": 91},
    )
    w = ToolWatcher(no_vocab, "<tool_call>", "</tool_call>")
    BIG_A, BIG_B, BIG_C = 0xFFFFFF00, 0xDEADBEEF, 0xCAFEBABE
    evs = w.feed([12345, BIG_A, START, BIG_B, BIG_C, END, 99999])
    assert len(evs) == 3
    assert evs[0].ids == (12345, BIG_A)
    assert evs[1].ids == (BIG_B, BIG_C)  # body verbatim, no narrowing
    assert evs[2].ids == (99999,)


# ── Real Qwen-2 sanity check (skipped unless CODEC_MAPS_QWEN is set) ─────────


def _find_qwen2() -> str | None:
    candidates = [
        Path.cwd() / "../../../codec-maps/maps/qwen/qwen2.json",
        Path.cwd() / "../../codec-maps/maps/qwen/qwen2.json",
        os.environ.get("CODEC_MAPS_QWEN", ""),
    ]
    for c in candidates:
        p = Path(c) if c else None
        if p and p.exists():
            return str(p)
    return None


@pytest.mark.skipif(_find_qwen2() is None, reason="codec-maps qwen2.json not found")
def test_real_qwen2():
    p = _find_qwen2()
    assert p is not None
    raw = json.loads(Path(p).read_text(encoding="utf-8"))
    m = TokenizerMap.from_json(raw)
    specials = m.special_tokens or {}

    # Some published codec-maps qwen2.json snapshots stop at
    # <|video_pad|> (151656) and omit the chat-tuned <tool_call>/
    # </tool_call> entries. If they're absent, fall back to a pair of
    # specials that ARE in the file — we're testing the watcher, not
    # the map. The IDs themselves are arbitrary.
    if "<tool_call>" in specials and "</tool_call>" in specials:
        start_name, end_name = "<tool_call>", "</tool_call>"
    else:
        start_name, end_name = "<|im_start|>", "<|im_end|>"

    start_id = specials[start_name]
    end_id   = specials[end_name]
    w = ToolWatcher(m, start_name, end_name)
    evs = w.feed([9707, start_id, 90909, 12345, 67890, end_id, 1101])
    assert len(evs) == 3
    assert evs[0].kind == "passthrough"
    assert evs[1].kind == "region"
    assert len(evs[1].ids) == 3
    assert evs[2].kind == "passthrough"
