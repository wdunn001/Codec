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
//! arrives.

use crate::map::TokenizerMap;

/// Kind of event emitted by [`ToolWatcher::feed`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherEventKind {
    /// Token IDs outside any watched region. Forward as-is.
    Passthrough,
    /// A complete start..end region with markers excluded.
    Region,
}

/// One event from [`ToolWatcher::feed`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatcherEvent {
    pub kind: WatcherEventKind,
    pub ids: Vec<u32>,
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
            region: Vec::new(),
        })
    }

    /// True while a region is open (start seen, end not yet).
    pub fn inside(&self) -> bool {
        self.inside
    }

    /// Drop any in-flight region buffer. Call between conversations so
    /// a leftover unclosed region from session N doesn't spill into N+1.
    pub fn reset(&mut self) {
        self.inside = false;
        self.region.clear();
    }

    /// Feed a chunk of token IDs and receive a flat list of events.
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
                        events.push(WatcherEvent {
                            kind: WatcherEventKind::Passthrough,
                            ids: ids[pt_start..i].to_vec(),
                        });
                    }
                    self.inside = true;
                    self.region.clear();
                    // pt_start re-anchors when the region closes.
                }
                // else: token continues passthrough run; no action.
            } else if id == self.end_id {
                events.push(WatcherEvent {
                    kind: WatcherEventKind::Region,
                    ids: std::mem::take(&mut self.region),
                });
                self.inside = false;
                pt_start = i + 1;
            } else if id == self.start_id {
                // Nested start: ignore. Most models don't nest these markers.
            } else {
                self.region.push(id);
            }
        }

        if !self.inside && pt_start < n {
            events.push(WatcherEvent {
                kind: WatcherEventKind::Passthrough,
                ids: ids[pt_start..n].to_vec(),
            });
        }

        events
    }

    /// Convenience: feed an `i32` slice (the wire frame's natural type
    /// from .NET surface familiarity). Internally upcast to `u32`.
    pub fn feed_i32(&mut self, ids: &[i32]) -> Vec<WatcherEvent> {
        let copy: Vec<u32> = ids.iter().map(|&v| v as u32).collect();
        self.feed(&copy)
    }
}
