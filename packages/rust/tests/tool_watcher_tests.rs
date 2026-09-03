// SPDX-License-Identifier: MIT
//! ToolWatcher tests: mirrors `ToolWatcherTests.cs`.

use std::collections::HashMap;

use codec_rs::{ToolWatcher, ToolWatcherError, TokenizerMap, WatcherEventKind};

const START: u32 = 90;
const END: u32 = 91;

fn synth_map() -> TokenizerMap {
    let mut vocab: HashMap<String, u32> = HashMap::new();
    vocab.insert("hello".into(), 0);
    vocab.insert("world".into(), 1);
    vocab.insert("!".into(), 2);
    vocab.insert("foo".into(), 3);
    vocab.insert("bar".into(), 4);

    let mut specials: HashMap<String, u32> = HashMap::new();
    specials.insert("<tool_call>".into(), 90);
    specials.insert("</tool_call>".into(), 91);

    TokenizerMap {
        id: "test/synth".into(),
        version: "2".into(),
        vocab_size: 100,
        vocab: Some(vocab),
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
fn passthrough_then_region_then_passthrough() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    let evs = w.feed(&[0u32, 1, START, 3, 4, END, 0, 2]);
    assert_eq!(evs.len(), 3);
    assert_eq!(evs[0].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[0].ids, vec![0u32, 1]);
    assert_eq!(evs[1].kind, WatcherEventKind::Region);
    assert_eq!(evs[1].ids, vec![3u32, 4]);
    assert_eq!(evs[2].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[2].ids, vec![0u32, 2]);
    assert!(!w.inside());
}

#[test]
fn region_split_across_feeds() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();

    let evs = w.feed(&[0u32, START, 3]);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[0].ids, vec![0u32]);
    assert!(w.inside());

    let evs = w.feed(&[4u32, END, 1]);
    assert_eq!(evs.len(), 2);
    assert_eq!(evs[0].kind, WatcherEventKind::Region);
    assert_eq!(evs[0].ids, vec![3u32, 4]);
    assert_eq!(evs[1].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[1].ids, vec![1u32]);
    assert!(!w.inside());
}

#[test]
fn multiple_regions_in_one_feed() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    let evs = w.feed(&[0u32, START, 3, END, 1, START, 4, END, 2]);
    assert_eq!(evs.len(), 5);
    assert_eq!(evs[0].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[1].kind, WatcherEventKind::Region);
    assert_eq!(evs[1].ids, vec![3u32]);
    assert_eq!(evs[2].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[3].kind, WatcherEventKind::Region);
    assert_eq!(evs[3].ids, vec![4u32]);
    assert_eq!(evs[4].kind, WatcherEventKind::Passthrough);
}

#[test]
fn stray_end_passes_through() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    let evs = w.feed(&[0u32, END, 1]);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[0].ids, vec![0u32, END, 1]);
}

#[test]
fn missing_special_name_throws() {
    let map = synth_map();
    let result = ToolWatcher::new(&map, "<not_real>", "</tool_call>");
    assert!(matches!(result, Err(ToolWatcherError::MissingSpecial(_))));
}

#[test]
fn reset_drops_in_flight_region() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    w.feed(&[START, 3, 4]);
    assert!(w.inside());
    w.reset();
    assert!(!w.inside());

    // End marker now becomes a stray (no buffered body).
    let evs = w.feed(&[END, 1]);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[0].ids, vec![END, 1]);
}

#[test]
fn never_decodes_operates_on_raw_ids() {
    // Map with empty vocab; large IDs that would never be valid token
    // indices. The watcher must emit them verbatim: proving it never
    // touches the vocab.
    let mut specials: HashMap<String, u32> = HashMap::new();
    specials.insert("<tool_call>".into(), 90);
    specials.insert("</tool_call>".into(), 91);
    let no_vocab = TokenizerMap {
        id: "test/no-vocab".into(),
        version: "2".into(),
        vocab_size: 4,
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
    };
    let mut w = ToolWatcher::new(&no_vocab, "<tool_call>", "</tool_call>").unwrap();
    const BIG_A: u32 = 0xFFFFFF00;
    const BIG_B: u32 = 0xDEADBEEF;
    const BIG_C: u32 = 0xCAFEBABE;
    let evs = w.feed(&[12345, BIG_A, START, BIG_B, BIG_C, END, 99999]);
    assert_eq!(evs.len(), 3);
    assert_eq!(evs[0].ids, vec![12345, BIG_A]);
    assert_eq!(evs[1].ids, vec![BIG_B, BIG_C]);
    assert_eq!(evs[2].ids, vec![99999]);
}

#[test]
fn i32_overload_accepts_wire_frame_type() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    let evs = w.feed_i32(&[0i32, 1, START as i32, 3, END as i32, 2]);
    assert_eq!(evs.len(), 3);
    assert_eq!(evs[1].kind, WatcherEventKind::Region);
    assert_eq!(evs[1].ids, vec![3u32]);
}

// ── Ordering: interleaved events in stream order (defect 3) ────────────────
//
// [a, S, X, E, b, S, Y, E, c] must produce five ORDERED events:
// passthrough(a) / region(X) / passthrough(b) / region(Y) / passthrough(c).
// This is the exact shape every language's watcher must agree on.

#[test]
fn ordering_matches_defect3_example() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    let (a, b, c, x, y) = (0u32, 1u32, 2u32, 3u32, 4u32); // hello, world, !, foo, bar
    let evs = w.feed(&[a, START, x, END, b, START, y, END, c]);
    assert_eq!(evs.len(), 5);
    assert_eq!(evs[0].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[0].ids, vec![a]);
    assert_eq!(evs[1].kind, WatcherEventKind::Region);
    assert_eq!(evs[1].ids, vec![x]);
    assert_eq!(evs[2].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[2].ids, vec![b]);
    assert_eq!(evs[3].kind, WatcherEventKind::Region);
    assert_eq!(evs[3].ids, vec![y]);
    assert_eq!(evs[4].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[4].ids, vec![c]);
}

// ── Nested start markers (defect 5) ─────────────────────────────────────────

#[test]
fn nested_start_is_dropped_from_body_but_observable() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    // S 0 S 1 E 2 -> NestedStart / Region([0,1]) / Passthrough([2])
    let evs = w.feed(&[START, 0, START, 1, END, 2]);
    assert_eq!(evs.len(), 3);
    assert_eq!(evs[0].kind, WatcherEventKind::NestedStart);
    assert_eq!(evs[0].ids, vec![START]);
    assert_eq!(evs[1].kind, WatcherEventKind::Region);
    assert_eq!(evs[1].ids, vec![0u32, 1]);
    assert_eq!(evs[2].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[2].ids, vec![2u32]);
}

// ── Truncation: end() while inside a region (defect 1) ──────────────────────
//
// An unterminated region (stream ends mid tool-call, e.g. the model hit its
// length limit) used to be silently dropped: no event, no signal,
// indistinguishable from a model that never called a tool. end() must
// report it, carrying the finish reason so a length stop is distinguishable
// from a malformed emission.

#[test]
fn end_emits_truncated_with_finish_reason() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    let evs = w.feed(&[0u32, START, 3, 4]);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].kind, WatcherEventKind::Passthrough);
    assert!(w.inside());

    let evs = w.end(Some("length"));
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].kind, WatcherEventKind::Truncated);
    assert_eq!(evs[0].ids, vec![3u32, 4]);
    assert_eq!(evs[0].finish_reason.as_deref(), Some("length"));
    assert!(!w.inside());

    // A second end() call is a no-op: nothing left in flight.
    assert!(w.end(Some("length")).is_empty());
}

#[test]
fn end_reports_empty_body_when_stream_ends_right_after_start() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    w.feed(&[START]);
    assert!(w.inside());

    let evs = w.end(None); // no finish reason known
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].kind, WatcherEventKind::Truncated);
    assert!(evs[0].ids.is_empty());
    assert_eq!(evs[0].finish_reason, None);
}

#[test]
fn end_outside_region_emits_nothing() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    w.feed(&[START, 3, END, 4]);
    assert!(!w.inside());
    assert!(w.end(Some("stop")).is_empty());
}

// ── Overflow: region buffer cap (defect 2) ──────────────────────────────────
//
// The region buffer used to grow without bound: a client that can make
// the model emit a start marker without a matching end marker could grow
// it to the entire remaining generation. The cap must be enforced and the
// overflow must be a defined, observable event, not a silent truncation.

#[test]
fn region_cap_defaults_and_is_settable() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    assert_eq!(w.region_cap(), codec_rs::DEFAULT_REGION_CAP);

    w.set_region_cap(3);
    assert_eq!(w.region_cap(), 3);

    // 0 resets to the default rather than becoming an unusable cap.
    w.set_region_cap(0);
    assert_eq!(w.region_cap(), codec_rs::DEFAULT_REGION_CAP);
}

#[test]
fn overflow_fires_once_at_cap_then_resyncs_on_end_marker() {
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    w.set_region_cap(3);

    // Region body is 5 tokens long against a cap of 3: must overflow once,
    // with exactly the first 3 tokens, and must NOT also emit a region
    // event for the same region when the end marker eventually arrives.
    let evs = w.feed(&[START, 1, 2, 3, 4, 5, END, 9]);
    assert_eq!(evs.len(), 2);
    assert_eq!(evs[0].kind, WatcherEventKind::Overflow);
    assert_eq!(evs[0].ids, vec![1u32, 2, 3]);
    assert_eq!(evs[1].kind, WatcherEventKind::Passthrough);
    assert_eq!(evs[1].ids, vec![9u32]);
    assert!(!w.inside());
}

#[test]
fn overflow_then_truncated_reports_both() {
    // A region that overflows and then never sees an end marker must
    // report BOTH: the overflow (memory bound hit) and the truncation
    // (stream ended without a close). They are orthogonal signals.
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    w.set_region_cap(2);

    let evs = w.feed(&[START, 1, 2, 3, 4]);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].kind, WatcherEventKind::Overflow);
    assert_eq!(evs[0].ids, vec![1u32, 2]);

    let evs = w.end(Some("length"));
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].kind, WatcherEventKind::Truncated);
    assert_eq!(evs[0].ids, vec![1u32, 2]);
    assert_eq!(evs[0].finish_reason.as_deref(), Some("length"));
}

#[test]
fn exact_cap_does_not_overflow() {
    // Off-by-one check: a region whose body is exactly `cap` tokens must
    // close cleanly as Region, not as Overflow.
    let map = synth_map();
    let mut w = ToolWatcher::new(&map, "<tool_call>", "</tool_call>").unwrap();
    w.set_region_cap(3);

    let evs = w.feed(&[START, 1, 2, 3, END]);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].kind, WatcherEventKind::Region);
    assert_eq!(evs[0].ids, vec![1u32, 2, 3]);
}
