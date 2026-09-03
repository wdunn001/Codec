// SPDX-License-Identifier: MIT
//! Tool-call / region watcher.
//!
//! Mirrors `libcodec`'s `codec_tool_watcher`, the .NET `ToolWatcher`,
//! and `@codecai/web`'s `ToolWatcher`: same state-machine semantics.
//! Detects delimited regions (tool calls, reasoning blocks, vision
//! spans, sandbox regions, channel headers) in a token-ID stream
//! without ever decoding. The hot loop is a `u32` compare against two
//! cached IDs; no vocab read, no detokenize call, no string allocation.
//!
//! State survives across [`ToolWatcher::feed`] calls: a region split
//! between network frames buffers internally until the end marker
//! arrives. [`ToolWatcher::feed`] has no way to know the stream is
//! over, so call [`ToolWatcher::end`] once you know no more tokens are
//! coming (e.g. right after a frame whose `done` is true).
//!
//! Known limitation, not yet handled: a single (start_id, end_id) pair
//! assumes the start marker is exclusive to tool calls. Formats where
//! the same start marker opens every assistant message and a closing
//! token decides after the fact whether it was a tool call (gpt-oss
//! harmony: `<|start|>` 200006 opens every message; `<|call|>` 200012
//! confirms, `<|end|>` 200007 / `<|return|>` 200002 reject) need a set
//! of closing tokens with different outcomes, not one end_id. See the
//! "Known limitation" paragraph on `codec_tool_watcher` in
//! packages/c/include/codec/codec.h for the full writeup and the
//! reasoning for why this is additive to the event kinds above, not a
//! rewrite of them.

use crate::map::TokenizerMap;

/// Default cap on the number of token IDs buffered inside one open
/// region. 65536 tokens is comfortably above any real tool-call payload
/// while still bounding worst-case per-watcher memory against a client
/// that can make the model emit a start marker without a matching end
/// marker.
pub const DEFAULT_REGION_CAP: usize = 65536;

/// Kind of event emitted by [`ToolWatcher::feed`] / [`ToolWatcher::end`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherEventKind {
    /// Token IDs outside any watched region. Forward as-is.
    Passthrough,
    /// A complete start..end region with markers excluded.
    Region,
    /// Emitted only by [`ToolWatcher::end`], when the stream finished
    /// while still inside a region.
    Truncated,
    /// The region buffer hit its configured cap.
    Overflow,
    /// A start marker was seen while already inside a region.
    NestedStart,
}

/// One event from [`ToolWatcher::feed`] / [`ToolWatcher::end`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatcherEvent {
    pub kind: WatcherEventKind,
    pub ids: Vec<u32>,
    /// Set only on [`WatcherEventKind::Truncated`], and only when the
    /// caller passed one to [`ToolWatcher::end`]. `None` otherwise.
    pub finish_reason: Option<String>,
}

impl WatcherEvent {
    fn new(kind: WatcherEventKind, ids: Vec<u32>) -> Self {
        Self {
            kind,
            ids,
            finish_reason: None,
        }
    }
}

/// Errors raised when constructing a [`ToolWatcher`].
#[derive(Debug, thiserror::Error)]
pub enum ToolWatcherError {
    #[error("special token \"{0}\" not in map.special_tokens")]
    MissingSpecial(String),
}

/// Stateful watcher for delimited regions in a token-ID stream.
///
/// Construct with a map and the names of the start/end specials. The
/// watcher resolves them to IDs once and caches them: no further map
/// access happens during [`ToolWatcher::feed`].
pub struct ToolWatcher {
    pub start_id: u32,
    pub end_id: u32,
    pub start_name: String,
    pub end_name: String,
    inside: bool,
    /// True once the in-progress region has hit `region_cap` and emitted
    /// its `Overflow` event. While set, body tokens are dropped (not
    /// buffered, not re-reported) until the end marker closes the region.
    capped: bool,
    region_cap: usize,
    region: Vec<u32>,
}

impl ToolWatcher {
    pub fn new(
        map: &TokenizerMap,
        start_name: &str,
        end_name: &str,
    ) -> Result<Self, ToolWatcherError> {
        let specials = map.special_tokens.as_ref().ok_or_else(|| {
            ToolWatcherError::MissingSpecial(start_name.to_string())
        })?;
        let start_id = specials
            .get(start_name)
            .copied()
            .ok_or_else(|| ToolWatcherError::MissingSpecial(start_name.to_string()))?;
        let end_id = specials
            .get(end_name)
            .copied()
            .ok_or_else(|| ToolWatcherError::MissingSpecial(end_name.to_string()))?;

        Ok(Self {
            start_id,
            end_id,
            start_name: start_name.to_string(),
            end_name: end_name.to_string(),
            inside: false,
            capped: false,
            region_cap: DEFAULT_REGION_CAP,
            region: Vec::new(),
        })
    }

    /// True while a region is open (start seen, end not yet).
    pub fn inside(&self) -> bool {
        self.inside
    }

    /// Cap on the number of token IDs buffered inside one open region.
    pub fn region_cap(&self) -> usize {
        self.region_cap
    }

    /// Change the region cap. 0 resets to [`DEFAULT_REGION_CAP`].
    pub fn set_region_cap(&mut self, cap: usize) {
        self.region_cap = if cap > 0 { cap } else { DEFAULT_REGION_CAP };
    }

    /// Drop any in-flight region buffer. Call between conversations so
    /// a leftover unclosed region from session N doesn't spill into N+1.
    pub fn reset(&mut self) {
        self.inside = false;
        self.capped = false;
        self.region.clear();
    }

    /// Feed a chunk of token IDs and receive a flat list of events, in
    /// stream order.
    pub fn feed(&mut self, ids: &[u32]) -> Vec<WatcherEvent> {
        let mut events: Vec<WatcherEvent> = Vec::new();
        let n = ids.len();
        let mut pt_start = 0usize;

        // Single-pass scan. Identical state machine to the C / .NET / TS
        // implementations: keep them in sync if you change one.
        for i in 0..n {
            let id = ids[i];
            if !self.inside {
                if id == self.start_id {
                    if i > pt_start {
                        events.push(WatcherEvent::new(
                            WatcherEventKind::Passthrough,
                            ids[pt_start..i].to_vec(),
                        ));
                    }
                    self.inside = true;
                    self.capped = false;
                    self.region.clear();
                    // pt_start re-anchors when the region closes.
                }
                // else: token continues passthrough run; no action.
            } else if id == self.end_id {
                // Region complete. Skipped when the region already
                // overflowed: that was reported once, already, at the
                // moment the cap was hit.
                if !self.capped {
                    events.push(WatcherEvent::new(
                        WatcherEventKind::Region,
                        std::mem::take(&mut self.region),
                    ));
                }
                self.region.clear();
                self.inside = false;
                self.capped = false;
                pt_start = i + 1;
            } else if id == self.start_id {
                // Nested start: dropped from the region body (most models
                // don't nest these markers, and treating an inner start
                // as a new region would silently drop the outer content)
                // but reported so it isn't silently swallowed.
                events.push(WatcherEvent::new(WatcherEventKind::NestedStart, vec![id]));
            } else if self.capped {
                // Already reported Overflow for this region. Keep
                // scanning for the end marker without buffering: memory
                // stays bounded.
            } else if self.region.len() >= self.region_cap {
                // Cap hit on this token. Report what's buffered so far,
                // then stop growing: do not silently truncate.
                // Deliberately does NOT clear `self.region`: if the
                // stream then ends without an end marker, `end()`
                // reports the same capped content as `Truncated`
                // (overflow and truncation are orthogonal signals; a
                // region can be both). The end-marker path above clears
                // it once the region actually closes.
                events.push(WatcherEvent::new(
                    WatcherEventKind::Overflow,
                    self.region.clone(),
                ));
                self.capped = true;
            } else {
                self.region.push(id);
            }
        }

        if !self.inside && pt_start < n {
            events.push(WatcherEvent::new(
                WatcherEventKind::Passthrough,
                ids[pt_start..n].to_vec(),
            ));
        }

        events
    }

    /// Signal end of stream. [`ToolWatcher::feed`] has no way to know the
    /// stream is over, so call this once you know no more tokens are
    /// coming.
    ///
    /// If a region is currently open, returns a single `Truncated` event
    /// carrying whatever was buffered (possibly empty) and
    /// `finish_reason`, so the caller can tell "the model hit its length
    /// limit mid tool-call" (`finish_reason == Some("length")`) apart
    /// from a malformed emission on its own. Returns an empty vec when
    /// not inside a region: calling `end()` on a cleanly finished stream
    /// is a no-op.
    pub fn end(&mut self, finish_reason: Option<&str>) -> Vec<WatcherEvent> {
        if !self.inside {
            return Vec::new();
        }
        let ids = std::mem::take(&mut self.region);
        self.inside = false;
        self.capped = false;
        vec![WatcherEvent {
            kind: WatcherEventKind::Truncated,
            ids,
            finish_reason: finish_reason.map(str::to_string),
        }]
    }

    /// Convenience: feed an `i32` slice (the wire frame's natural type
    /// from .NET surface familiarity). Internally upcast to `u32`.
    pub fn feed_i32(&mut self, ids: &[i32]) -> Vec<WatcherEvent> {
        let copy: Vec<u32> = ids.iter().map(|&v| v as u32).collect();
        self.feed(&copy)
    }
}
