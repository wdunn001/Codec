"""Tool-call / region watcher.

Detect delimited regions in a token-ID stream without ever decoding.
Mirrors the C ``codec_tool_watcher`` and TS ``ToolWatcher`` APIs: same
state-machine semantics, same edge cases.

Most chat-tuned models delimit tool calls (and reasoning blocks, vision
spans, sandbox regions, channel headers) with single-token specials.
Detecting *that* one happened is a uint32 compare in the hot loop:
no detokenization, no string allocation.

Quick start::

    from codecai import ToolWatcher

    watcher = ToolWatcher(map, "<tool_call>", "</tool_call>")
    for frame in stream:
        for ev in watcher.feed(frame.ids):
            if ev.kind == "passthrough":
                forward(next_agent, ev.ids)
            else:  # "region"
                dispatch_tool(json.loads(detok.render(ev.ids)))

State survives across ``feed()`` calls: a region split between network
frames buffers internally until the end marker arrives.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal, Sequence

from .types import TokenizerMap


class ToolWatcherError(ValueError):
    """Raised when a named special token isn't in the map."""


@dataclass(frozen=True, slots=True)
class WatcherEvent:
    """One event emitted by ``ToolWatcher.feed()``.

    :attr:`kind` is ``"passthrough"`` (IDs outside any region) or
    ``"region"`` (a complete start..end region with markers excluded).

    :attr:`ids` is a tuple of raw token IDs. Always a fresh tuple; safe
    to retain across subsequent ``feed()`` calls.
    """

    kind: Literal["passthrough", "region"]
    ids: tuple[int, ...]


class ToolWatcher:
    """Stateful watcher for delimited regions in a token-ID stream.

    Construct with a map and the names of the start/end specials. The
    watcher resolves them to uint32 IDs once and caches them: no
    further map access happens during ``feed()``.
    """

    __slots__ = (
        "_start_id", "_end_id", "_start_name", "_end_name",
        "_inside", "_region",
    )

    def __init__(self, map: TokenizerMap, start_name: str, end_name: str) -> None:
        specials = map.special_tokens or {}
        if start_name not in specials:
            raise ToolWatcherError(
                f"special token {start_name!r} not in map.special_tokens")
        if end_name not in specials:
            raise ToolWatcherError(
                f"special token {end_name!r} not in map.special_tokens")
        self._start_id: int = specials[start_name]
        self._end_id:   int = specials[end_name]
        self._start_name = start_name
        self._end_name   = end_name
        self._inside: bool = False
        self._region: list[int] = []

    @property
    def start_id(self) -> int:
        return self._start_id

    @property
    def end_id(self) -> int:
        return self._end_id

    @property
    def inside(self) -> bool:
        """True when a region is currently open (start seen, end not yet)."""
        return self._inside

    def reset(self) -> None:
        """Drop any in-flight region. Call between conversations so a
        leftover unclosed region from session N doesn't spill into N+1."""
        self._inside = False
        self._region = []

    def feed(self, ids: Sequence[int] | Iterable[int]) -> list[WatcherEvent]:
        """Feed a chunk of token IDs and return a flat list of events.

        Single-pass scan, identical state machine to the C and TS
        implementations: keep them in sync if you change one.
        """
        # Materialize once so we can index. Tolerates list / tuple /
        # generator alike. For tight inner loops the caller should pass
        # a sequence directly: generators add a copy.
        if not isinstance(ids, (list, tuple)):
            ids = list(ids)

        events: list[WatcherEvent] = []
        n = len(ids)
        pt_start = 0

        for i in range(n):
            tok = ids[i]

            if not self._inside:
                if tok == self._start_id:
                    if i > pt_start:
                        events.append(WatcherEvent(
                            kind="passthrough",
                            ids=tuple(ids[pt_start:i])))
                    self._inside = True
                    self._region = []
                    # pt_start re-anchors when the region closes.
                # else: token continues the passthrough run; no action.
            else:
                if tok == self._end_id:
                    # Region complete: hand the body to the caller as
                    # an immutable tuple. Reset internal buffer.
                    events.append(WatcherEvent(
                        kind="region",
                        ids=tuple(self._region)))
                    self._region = []
                    self._inside = False
                    pt_start = i + 1
                elif tok == self._start_id:
                    # Nested start: ignore. Most models don't nest these
                    # markers. Treating an inner start as a new region
                    # would silently drop the outer content.
                    pass
                else:
                    self._region.append(tok)

        # Trailing passthrough run, if we ended outside a region.
        if not self._inside and pt_start < n:
            events.append(WatcherEvent(
                kind="passthrough",
                ids=tuple(ids[pt_start:n])))

        return events


__all__ = ["ToolWatcher", "ToolWatcherError", "WatcherEvent"]
