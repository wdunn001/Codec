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
            elif ev.kind == "region":
                dispatch_tool(json.loads(detok.render(ev.ids)))
            # "truncated", "overflow" and "nested_start": see WatcherEvent.
    # feed() cannot know the stream is over. Call this once, after the
    # last feed(), even (especially) when the model hit its length limit
    # mid tool-call:
    for ev in watcher.end(frame.finish_reason):
        ...

State survives across ``feed()`` calls: a region split between network
frames buffers internally until the end marker arrives.

Known limitation, not yet handled: a single (start_id, end_id) pair
assumes the start marker is exclusive to tool calls. Formats where the
same start marker opens every assistant message and a closing token
decides after the fact whether it was a tool call (gpt-oss harmony:
``<|start|>`` 200006 opens every message; ``<|call|>`` 200012 confirms,
``<|end|>`` 200007 / ``<|return|>`` 200002 reject) need a set of closing
tokens with different outcomes, not one end_id. See the "Known
limitation" paragraph on ``codec_tool_watcher`` in
packages/c/include/codec/codec.h for the full writeup and the reasoning
for why this is additive to the event kinds above, not a rewrite of them.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Iterable, Literal, Sequence

from .types import TokenizerMap


class ToolWatcherError(ValueError):
    """Raised when a named special token isn't in the map."""


#: Default cap on the number of token IDs buffered inside one open region.
#: 65536 tokens is comfortably above any real tool-call payload while
#: still bounding worst-case per-watcher memory against a client that can
#: make the model emit a start marker without a matching end marker.
DEFAULT_REGION_CAP: Final[int] = 65536

WatcherEventKind = Literal[
    "passthrough", "region", "truncated", "overflow", "nested_start"
]


@dataclass(frozen=True, slots=True)
class WatcherEvent:
    """One event emitted by ``ToolWatcher.feed()`` / ``ToolWatcher.end()``,
    in stream order.

    :attr:`kind`:

    * ``"passthrough"``: IDs outside any watched region.
    * ``"region"``: a complete start..end region, markers excluded.
    * ``"truncated"``: emitted only by :meth:`ToolWatcher.end`, when the
      stream finished while still inside a region. :attr:`ids` is
      whatever was buffered (possibly empty) and :attr:`finish_reason`
      carries the reason the stream ended, so a length stop is
      distinguishable from a malformed emission.
    * ``"overflow"``: the region buffer hit its configured cap.
      :attr:`ids` is the capped prefix; the watcher keeps scanning for
      the end marker without buffering further body tokens.
    * ``"nested_start"``: a start marker was seen while already inside a
      region. Dropped from the region body, but reported so it isn't
      silently swallowed. :attr:`ids` is the single-element ``(id,)``.

    :attr:`ids` is a tuple of raw token IDs. Always a fresh tuple; safe
    to retain across subsequent ``feed()`` calls.

    :attr:`finish_reason` is set only on ``"truncated"`` events, and only
    when the caller passed one to :meth:`ToolWatcher.end`. ``None``
    otherwise.
    """

    kind: WatcherEventKind
    ids: tuple[int, ...]
    finish_reason: str | None = None


class ToolWatcher:
    """Stateful watcher for delimited regions in a token-ID stream.

    Construct with a map and the names of the start/end specials. The
    watcher resolves them to uint32 IDs once and caches them: no
    further map access happens during ``feed()``.
    """

    __slots__ = (
        "_start_id", "_end_id", "_start_name", "_end_name",
        "_inside", "_capped", "_region_cap", "_region",
    )

    def __init__(
        self,
        map: TokenizerMap,
        start_name: str,
        end_name: str,
        region_cap: int = DEFAULT_REGION_CAP,
    ) -> None:
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
        # True once the in-progress region has hit _region_cap and emitted
        # its "overflow" event. While set, body tokens are dropped (not
        # buffered, not re-reported) until the end marker closes the
        # region.
        self._capped: bool = False
        self._region_cap: int = region_cap if region_cap > 0 else DEFAULT_REGION_CAP
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

    @property
    def region_cap(self) -> int:
        """Cap on the number of token IDs buffered inside one open region."""
        return self._region_cap

    def set_region_cap(self, cap: int) -> None:
        """Change the region cap. 0 resets to ``DEFAULT_REGION_CAP``."""
        self._region_cap = cap if cap > 0 else DEFAULT_REGION_CAP

    def reset(self) -> None:
        """Drop any in-flight region. Call between conversations so a
        leftover unclosed region from session N doesn't spill into N+1."""
        self._inside = False
        self._capped = False
        self._region = []

    def feed(self, ids: Sequence[int] | Iterable[int]) -> list[WatcherEvent]:
        """Feed a chunk of token IDs and return a flat list of events, in
        stream order.

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
                    self._capped = False
                    self._region = []
                    # pt_start re-anchors when the region closes.
                # else: token continues the passthrough run; no action.
            else:
                if tok == self._end_id:
                    # Region complete: hand the body to the caller as an
                    # immutable tuple. Skipped when the region already
                    # overflowed: that was reported once, already, at the
                    # moment the cap was hit.
                    if not self._capped:
                        events.append(WatcherEvent(
                            kind="region",
                            ids=tuple(self._region)))
                    self._region = []
                    self._inside = False
                    self._capped = False
                    pt_start = i + 1
                elif tok == self._start_id:
                    # Nested start: dropped from the region body, then
                        # reported so it is not silently swallowed. Most
                        # models don't nest these markers. Treating an
                        # inner start as a new region would silently drop
                        # the outer content.
                    events.append(WatcherEvent(
                        kind="nested_start", ids=(tok,)))
                elif self._capped:
                    # Already reported "overflow" for this region. Keep
                    # scanning for the end marker without buffering:
                    # memory stays bounded.
                    pass
                elif len(self._region) >= self._region_cap:
                    # Cap hit on this token. Report what's buffered so
                    # far, then stop growing: do not silently truncate.
                    # Deliberately does NOT reset self._region: if the
                    # stream then ends without an end marker, end()
                    # reports the same capped content as "truncated"
                    # (overflow and truncation are orthogonal signals; a
                    # region can be both). The end-marker path above
                    # resets it once the region actually closes.
                    events.append(WatcherEvent(
                        kind="overflow", ids=tuple(self._region)))
                    self._capped = True
                else:
                    self._region.append(tok)

        # Trailing passthrough run, if we ended outside a region.
        if not self._inside and pt_start < n:
            events.append(WatcherEvent(
                kind="passthrough",
                ids=tuple(ids[pt_start:n])))

        return events

    def end(self, finish_reason: str | None = None) -> list[WatcherEvent]:
        """Signal end of stream. ``feed()`` has no way to know the stream
        is over, so call this once you know no more tokens are coming.

        If a region is currently open, returns a single ``"truncated"``
        event carrying whatever was buffered (possibly empty) and
        ``finish_reason``, so the caller can tell "the model hit its
        length limit mid tool-call" (``finish_reason == "length"``) apart
        from a malformed emission on its own. Returns an empty list when
        not inside a region: calling ``end()`` on a cleanly finished
        stream is a no-op.
        """
        if not self._inside:
            return []
        ids = tuple(self._region)
        self._region = []
        self._inside = False
        self._capped = False
        return [WatcherEvent(kind="truncated", ids=ids, finish_reason=finish_reason)]


__all__ = [
    "ToolWatcher",
    "ToolWatcherError",
    "WatcherEvent",
    "WatcherEventKind",
    "DEFAULT_REGION_CAP",
]
