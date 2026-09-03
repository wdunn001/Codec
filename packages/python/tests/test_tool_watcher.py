"""ToolWatcher tests: mirror packages/web/test/tool-watcher.test.ts."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from codecai import (
    DEFAULT_REGION_CAP,
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
    # End with no preceding start: treated as ordinary token.
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
    """No-decode contract: mirror of test_watcher_does_not_decode_tokens
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


# ── Ordering: interleaved events in stream order (defect 3) ──────────────────
#
# [a, S, X, E, b, S, Y, E, c] must produce five ORDERED events:
# passthrough(a) / region(X) / passthrough(b) / region(Y) / passthrough(c).
# This is the exact shape every language's watcher must agree on.


def test_ordering_matches_defect3_example():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")
    a, b, c, x, y = 0, 1, 2, 3, 4  # hello, world, !, foo, bar
    evs = w.feed([a, START, x, END, b, START, y, END, c])
    assert len(evs) == 5
    assert evs[0].kind == "passthrough" and evs[0].ids == (a,)
    assert evs[1].kind == "region" and evs[1].ids == (x,)
    assert evs[2].kind == "passthrough" and evs[2].ids == (b,)
    assert evs[3].kind == "region" and evs[3].ids == (y,)
    assert evs[4].kind == "passthrough" and evs[4].ids == (c,)


# ── Nested start markers (defect 5) ───────────────────────────────────────────


def test_nested_start_is_dropped_from_body_but_observable():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")
    # S 0 S 1 E 2 -> nested_start / region([0,1]) / passthrough([2])
    evs = w.feed([START, 0, START, 1, END, 2])
    assert len(evs) == 3
    assert evs[0].kind == "nested_start" and evs[0].ids == (START,)
    assert evs[1].kind == "region" and evs[1].ids == (0, 1)
    assert evs[2].kind == "passthrough" and evs[2].ids == (2,)


# ── Truncation: end() while inside a region (defect 1) ────────────────────────
#
# An unterminated region (stream ends mid tool-call, e.g. the model hit its
# length limit) used to be silently dropped: no event, no signal,
# indistinguishable from a model that never called a tool. end() must report
# it, carrying the finish reason so a length stop is distinguishable from a
# malformed emission.


def test_end_emits_truncated_with_finish_reason():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")
    evs = w.feed([0, START, 3, 4])
    assert len(evs) == 1
    assert evs[0].kind == "passthrough"
    assert w.inside

    evs = w.end("length")
    assert len(evs) == 1
    assert evs[0].kind == "truncated"
    assert evs[0].ids == (3, 4)
    assert evs[0].finish_reason == "length"
    assert not w.inside

    # A second end() call is a no-op: nothing left in flight.
    assert w.end("length") == []


def test_end_reports_empty_body_when_stream_ends_right_after_start():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")
    w.feed([START])
    assert w.inside

    evs = w.end()  # no finish reason known
    assert len(evs) == 1
    assert evs[0].kind == "truncated"
    assert evs[0].ids == ()
    assert evs[0].finish_reason is None


def test_end_outside_region_emits_nothing():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")
    w.feed([START, 3, END, 4])
    assert not w.inside
    assert w.end("stop") == []


# ── Overflow: region buffer cap (defect 2) ─────────────────────────────────────
#
# The region buffer used to grow without bound: a client that can make the
# model emit a start marker without a matching end marker could grow it to
# the entire remaining generation. The cap must be enforced and the overflow
# must be a defined, observable event, not a silent truncation.


def test_region_cap_defaults_and_is_settable():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>")
    assert w.region_cap == DEFAULT_REGION_CAP

    w.set_region_cap(3)
    assert w.region_cap == 3

    # 0 resets to the default rather than becoming an unusable cap.
    w.set_region_cap(0)
    assert w.region_cap == DEFAULT_REGION_CAP

    w2 = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>", region_cap=3)
    assert w2.region_cap == 3


def test_overflow_fires_once_at_cap_then_resyncs_on_end_marker():
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>", region_cap=3)
    # Region body is 5 tokens long against a cap of 3: must overflow once,
    # with exactly the first 3 tokens, and must NOT also emit a region
    # event for the same region when the end marker eventually arrives.
    evs = w.feed([START, 1, 2, 3, 4, 5, END, 9])
    assert len(evs) == 2
    assert evs[0].kind == "overflow" and evs[0].ids == (1, 2, 3)
    assert evs[1].kind == "passthrough" and evs[1].ids == (9,)
    assert not w.inside


def test_overflow_then_truncated_reports_both():
    # A region that overflows and then never sees an end marker must
    # report BOTH: the overflow (memory bound hit) and the truncation
    # (stream ended without a close). They are orthogonal signals.
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>", region_cap=2)
    evs = w.feed([START, 1, 2, 3, 4])
    assert len(evs) == 1
    assert evs[0].kind == "overflow" and evs[0].ids == (1, 2)

    evs = w.end("length")
    assert len(evs) == 1
    assert evs[0].kind == "truncated"
    assert evs[0].ids == (1, 2)
    assert evs[0].finish_reason == "length"


def test_exact_cap_does_not_overflow():
    # Off-by-one check: a region whose body is exactly `cap` tokens must
    # close cleanly as "region", not as "overflow".
    w = ToolWatcher(SYN_MAP, "<tool_call>", "</tool_call>", region_cap=3)
    evs = w.feed([START, 1, 2, 3, END])
    assert len(evs) == 1
    assert evs[0].kind == "region" and evs[0].ids == (1, 2, 3)


# ── Fixture-driven conformance cases ──────────────────────────────────────────
#
# packages/tool-watcher-conformance/fixtures/tool-watcher-events.json is the
# cross-language source of truth for the event contract: every Codec
# ToolWatcher implementation must reproduce it exactly. Every case there runs
# here too, so this file can't silently fall out of sync with it.

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "tool-watcher-conformance" / "fixtures" / "tool-watcher-events.json"
)
_FIXTURE = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
_FIXTURE_MAP = TokenizerMap(
    id="test/fixture",
    version="2",
    vocab_size=100,
    encoder="byte_level",
    vocab={},
    special_tokens={"<start>": _FIXTURE["start_id"], "<end>": _FIXTURE["end_id"]},
)


def _normalize(kind: str, ids: tuple[int, ...] | list[int], finish_reason: str | None):
    entry = {"kind": kind, "ids": list(ids)}
    if kind == "truncated":
        entry["finish_reason"] = finish_reason
    return entry


@pytest.mark.parametrize(
    "case", _FIXTURE["cases"], ids=[c["name"] for c in _FIXTURE["cases"]]
)
def test_fixture_case(case):
    region_cap = case["region_cap"] if case["region_cap"] is not None else DEFAULT_REGION_CAP
    w = ToolWatcher(_FIXTURE_MAP, "<start>", "<end>", region_cap=region_cap)

    actual = []
    for feed_ids in case["feeds"]:
        for ev in w.feed(feed_ids):
            actual.append(_normalize(ev.kind, ev.ids, ev.finish_reason))
    if case["end"] is not None:
        for ev in w.end(case["end"]["finish_reason"]):
            actual.append(_normalize(ev.kind, ev.ids, ev.finish_reason))

    expected = [
        _normalize(e["kind"], e["ids"], e.get("finish_reason"))
        for e in case["events"]
    ]
    assert actual == expected


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
    # specials that ARE in the file: we're testing the watcher, not
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
