// SPDX-License-Identifier: MIT
//! Detokenizer integration tests: mirrors `DetokenizerTests.cs`.

mod common;

use codec_rs::{decode_byte_level_token, encode_byte_level_chars, Detokenizer, DetokenizeOptions, TokenizerMap};
use common::{byte_id, tiny_map};

#[test]
fn detokenizes_simple_vocab_tokens() {
    // hello + space + world + !
    let ids = [3u32, 4, 5, 8];
    assert_eq!(
        Detokenizer::detokenize(&tiny_map(), &ids, false),
        "hello world!"
    );
}

#[test]
fn skips_special_tokens_by_default() {
    let ids = [267u32, 3, 4, 5, 266]; // <bos> hello world <eos>
    assert_eq!(
        Detokenizer::detokenize(&tiny_map(), &ids, false),
        "hello world"
    );
}

#[test]
fn renders_special_tokens_when_asked() {
    let ids = [3u32, 266];
    let result = Detokenizer::detokenize(&tiny_map(), &ids, true);
    // 266 isn't in the v1 tokens map, so emits replacement char. Point:
    // call doesn't throw and the eos token doesn't silently disappear.
    assert!(result.starts_with("hello"));
}

#[test]
fn byte_fallback_three_byte_utf8() {
    // € = E2 82 AC (3 bytes)
    let ids = [byte_id(0xE2), byte_id(0x82), byte_id(0xAC)];
    assert_eq!(Detokenizer::detokenize(&tiny_map(), &ids, false), "€");
}

#[test]
fn byte_fallback_four_byte_emoji() {
    // 🚀 = F0 9F 9A 80 (4 bytes)
    let ids = [
        byte_id(0xF0),
        byte_id(0x9F),
        byte_id(0x9A),
        byte_id(0x80),
    ];
    assert_eq!(Detokenizer::detokenize(&tiny_map(), &ids, false), "🚀");
}

#[test]
fn partial_multi_byte_sequence_buffered_across_frames_three_byte() {
    let map = tiny_map();
    let mut d = Detokenizer::new(&map);
    // Frame 1: first 2 bytes of €: incomplete, must not emit anything.
    let out1 = d.render(
        &[byte_id(0xE2), byte_id(0x82)],
        DetokenizeOptions { partial: true, render_special: false },
    );
    assert_eq!(out1, "");
    // Frame 2: final byte: flushes.
    let out2 = d.render(
        &[byte_id(0xAC)],
        DetokenizeOptions { partial: false, render_special: false },
    );
    assert_eq!(out2, "€");
}

#[test]
fn partial_four_byte_emoji_across_two_frames() {
    let map = tiny_map();
    let mut d = Detokenizer::new(&map);
    // Split 🚀 across two frames at the 2-byte / 4-byte boundary.
    let f1 = d.render(
        &[byte_id(0xF0), byte_id(0x9F)],
        DetokenizeOptions { partial: true, render_special: false },
    );
    assert_eq!(f1, "");
    let f2 = d.render(
        &[byte_id(0x9A), byte_id(0x80)],
        DetokenizeOptions { partial: false, render_special: false },
    );
    assert_eq!(f2, "🚀");
}

#[test]
fn vocab_token_after_partial_bytes_flushes_buffer_first() {
    let map = tiny_map();
    let mut d = Detokenizer::new(&map);
    // 'A' as byte (0x41) + 'hello' (vocab id 3)
    let output = d.render(&[byte_id(0x41), 3], DetokenizeOptions::default());
    assert_eq!(output, "Ahello");
}

#[test]
fn unknown_id_emits_replacement() {
    let map = tiny_map();
    let mut d = Detokenizer::new(&map);
    assert_eq!(d.render(&[99999u32], DetokenizeOptions::default()), "\u{FFFD}");
}

#[test]
fn reset_clears_partial_buffer() {
    let map = tiny_map();
    let mut d = Detokenizer::new(&map);
    d.render(
        &[byte_id(0xE2)],
        DetokenizeOptions { partial: true, render_special: false },
    );
    d.reset();
    assert_eq!(d.render(&[3u32], DetokenizeOptions::default()), "hello");
}

// ── Byte-level (Qwen-2 style) detokenizer ─────────────────────────────────

fn byte_level_qwen_style_map() -> TokenizerMap {
    use std::collections::HashMap;

    // Build a tiny byte_level vocab that contains "Hello" and "Ġworld"
    // (i.e., the GPT-2-encoded form of " world"). The detokenizer must
    // strip the Ġ encoding back to a real space.
    let mut vocab: HashMap<String, u32> = HashMap::new();
    vocab.insert("Hello".into(), 0);
    let space = encode_byte_level_chars(&[0x20]);
    vocab.insert(format!("{space}world"), 1);
    vocab.insert("!".into(), 2);

    TokenizerMap {
        id: "test/byte_level".into(),
        version: "2".into(),
        vocab_size: 3,
        vocab: Some(vocab),
        tokens: None,
        encoder: Some("byte_level".into()),
        merges: Some(vec![]),
        pre_tokenizer_pattern: None,
        pre_tokenizer_program: None,
        byte_fallback_start: None,
        byte_fallback_end: None,
        special_tokens: None,
        tool_calling: None,
        published_at: None,
    }
}

#[test]
fn detokenizer_byte_level_round_trips_space_prefix() {
    let map = byte_level_qwen_style_map();
    // "Hello world!"
    let ids = [0u32, 1, 2];
    assert_eq!(Detokenizer::detokenize(&map, &ids, false), "Hello world!");
}

#[test]
fn decode_byte_level_token_handles_emoji_in_token_string() {
    // The GPT-2 encoded form of 🚀 (F0 9F 9A 80) should round-trip back
    // to the same 4 bytes.
    let token_chars = encode_byte_level_chars(&[0xF0, 0x9F, 0x9A, 0x80]);
    assert_eq!(decode_byte_level_token(&token_chars), &[0xF0, 0x9F, 0x9A, 0x80]);
}

// ── Metaspace (Llama-2 style) detokenizer ─────────────────────────────────

fn metaspace_map() -> TokenizerMap {
    use std::collections::HashMap;
    let mut vocab: HashMap<String, u32> = HashMap::new();
    // Byte-fallback range tokens occupy ids 3..=258. Metaspace vocab
    // entries land above that range to avoid collisions.
    for b in 0u32..=255 {
        vocab.insert(format!("<0x{b:02X}>"), 3 + b);
    }
    // "▁hello", "▁world", "!": metaspace replaces ▁ with space
    vocab.insert("\u{2581}hello".into(), 300);
    vocab.insert("\u{2581}world".into(), 301);
    vocab.insert("!".into(), 302);

    TokenizerMap {
        id: "test/metaspace".into(),
        version: "2".into(),
        vocab_size: 400,
        vocab: Some(vocab),
        tokens: None,
        encoder: Some("metaspace".into()),
        merges: Some(vec![]),
        pre_tokenizer_pattern: None,
        pre_tokenizer_program: None,
        byte_fallback_start: Some(3),
        byte_fallback_end: Some(258),
        special_tokens: None,
        tool_calling: None,
        published_at: None,
    }
}

#[test]
fn metaspace_decodes_underscore_as_space() {
    let map = metaspace_map();
    let ids = [300u32, 301, 302];
    // Leading "▁hello" → " hello" so the assembled string starts with a space.
    assert_eq!(Detokenizer::detokenize(&map, &ids, false), " hello world!");
}

#[test]
fn metaspace_byte_fallback_range_decodes() {
    let map = metaspace_map();
    // 🚀 = F0 9F 9A 80 via byte fallback (start=3): IDs [3+0xF0, 3+0x9F, 3+0x9A, 3+0x80]
    let ids = [3 + 0xF0, 3 + 0x9F, 3 + 0x9A, 3 + 0x80];
    assert_eq!(Detokenizer::detokenize(&map, &ids, false), "🚀");
}
