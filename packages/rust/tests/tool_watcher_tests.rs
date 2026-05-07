// SPDX-License-Identifier: MIT
//! ToolWatcher tests — mirrors `ToolWatcherTests.cs`.

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
        byte_fallback_start: None,
        byte_fallback_end: None,
        special_tokens: Some(specials),
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
    // indices. The watcher must emit them verbatim — proving it never
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
        byte_fallback_start: None,
        byte_fallback_end: None,
        special_tokens: Some(specials),
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
