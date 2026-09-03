// SPDX-License-Identifier: MIT
//! Fixture-driven ToolWatcher conformance tests.
//!
//! `packages/tool-watcher-conformance/fixtures/tool-watcher-events.json` is
//! the cross-language source of truth for the event contract: every Codec
//! ToolWatcher implementation must reproduce it exactly. Every case there
//! runs here too, generically, so this file can't silently fall out of
//! sync with it the way a hand-mirrored test can. See
//! `tool_watcher_tests.rs` for the hand-written tests covering
//! Rust-specific concerns (the `feed_i32` overload, error types, etc.);
//! those stay, this is additive.
//!
//! Mirrors `packages/web/test/tool-watcher.test.ts` and
//! `packages/python/tests/test_tool_watcher.py`'s fixture loaders.

use std::collections::HashMap;

use codec_rs::{ToolWatcher, TokenizerMap, WatcherEventKind, DEFAULT_REGION_CAP};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Fixture {
    start_id: u32,
    end_id: u32,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    name: String,
    region_cap: Option<usize>,
    feeds: Vec<Vec<u32>>,
    end: Option<EndSpec>,
    events: Vec<EventSpec>,
}

#[derive(Debug, Deserialize)]
struct EndSpec {
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EventSpec {
    kind: String,
    ids: Vec<u32>,
    #[serde(default)]
    finish_reason: Option<String>,
}

/// Normalized event shape used to compare actual vs expected. Kept
/// separate from `codec_rs::WatcherEvent` so the comparison is explicit
/// about which fields matter (kind, ids, and finish_reason only on
/// truncated) rather than relying on `WatcherEvent`'s own `PartialEq`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NormEvent {
    kind: String,
    ids: Vec<u32>,
    finish_reason: Option<String>,
}

/// Maps every `WatcherEventKind` variant to the fixture's string form.
/// Exhaustive match with no wildcard arm: if a new variant is ever added
/// to the enum, this fails to compile until it's handled here, rather
/// than silently miscategorizing (or dropping) events of the new kind.
fn kind_str(kind: WatcherEventKind) -> &'static str {
    match kind {
        WatcherEventKind::Passthrough => "passthrough",
        WatcherEventKind::Region => "region",
        WatcherEventKind::Truncated => "truncated",
        WatcherEventKind::Overflow => "overflow",
        WatcherEventKind::NestedStart => "nested_start",
    }
}

fn load_fixture() -> Fixture {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tool-watcher-conformance/fixtures/tool-watcher-events.json"
    );
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read fixture at {path}: {e}"));
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("failed to parse fixture at {path}: {e}"))
}

fn fixture_map(start_id: u32, end_id: u32) -> TokenizerMap {
    let mut specials: HashMap<String, u32> = HashMap::new();
    specials.insert("<start>".into(), start_id);
    specials.insert("<end>".into(), end_id);

    TokenizerMap {
        id: "test/fixture".into(),
        version: "2".into(),
        vocab_size: 100,
        vocab: Some(HashMap::new()),
        tokens: None,
        encoder: Some("byte_level".into()),
        merges: None,
        pre_tokenizer_pattern: None,
        pre_tokenizer_program: None,
        byte_fallback_start: None,
        byte_fallback_end: None,
        special_tokens: Some(specials),
        tool_calling: None,
        published_at: None,
    }
}

#[test]
fn fixture_cases_match_exactly() {
    let fixture = load_fixture();
    assert!(
        !fixture.cases.is_empty(),
        "fixture loaded but has no cases; loader is broken"
    );

    let map = fixture_map(fixture.start_id, fixture.end_id);
    let mut failures: Vec<String> = Vec::new();

    for case in &fixture.cases {
        let mut w = ToolWatcher::new(&map, "<start>", "<end>")
            .unwrap_or_else(|e| panic!("case {}: failed to construct watcher: {e}", case.name));
        w.set_region_cap(case.region_cap.unwrap_or(DEFAULT_REGION_CAP));

        let mut actual: Vec<NormEvent> = Vec::new();
        for feed_ids in &case.feeds {
            for ev in w.feed(feed_ids) {
                let finish_reason = if ev.kind == WatcherEventKind::Truncated {
                    ev.finish_reason.clone()
                } else {
                    None
                };
                actual.push(NormEvent {
                    kind: kind_str(ev.kind).to_string(),
                    ids: ev.ids,
                    finish_reason,
                });
            }
        }
        if let Some(end_spec) = &case.end {
            for ev in w.end(end_spec.finish_reason.as_deref()) {
                let finish_reason = if ev.kind == WatcherEventKind::Truncated {
                    ev.finish_reason.clone()
                } else {
                    None
                };
                actual.push(NormEvent {
                    kind: kind_str(ev.kind).to_string(),
                    ids: ev.ids,
                    finish_reason,
                });
            }
        }

        let expected: Vec<NormEvent> = case
            .events
            .iter()
            .map(|e| NormEvent {
                kind: e.kind.clone(),
                ids: e.ids.clone(),
                finish_reason: if e.kind == "truncated" {
                    e.finish_reason.clone()
                } else {
                    None
                },
            })
            .collect();

        if actual != expected {
            failures.push(format!(
                "case \"{}\": actual={:?} expected={:?}",
                case.name, actual, expected
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} fixture case(s) diverged from ToolWatcher output:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
