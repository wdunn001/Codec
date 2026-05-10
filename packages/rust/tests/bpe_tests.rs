// SPDX-License-Identifier: MIT
//! BPE tokenizer tests — mirrors `BPETests.cs`.

use std::collections::HashMap;
use std::path::PathBuf;

use codec_rs::{
    encode_byte_level_chars, BPETokenizer, Detokenizer, ITokenizer, TokenizerMap,
};

fn find_qwen_map() -> Option<PathBuf> {
    for c in [
        "/mnt/h/dev/codec-maps/maps/qwen/qwen2.json",
        r"H:\dev\codec-maps\maps\qwen\qwen2.json",
    ] {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn make_byte_level_fixture() -> TokenizerMap {
    let space = encode_byte_level_chars(&[0x20]);
    let mut vocab: HashMap<String, u32> = HashMap::new();
    vocab.insert("h".into(), 0);
    vocab.insert("e".into(), 1);
    vocab.insert("l".into(), 2);
    vocab.insert("o".into(), 3);
    vocab.insert("w".into(), 4);
    vocab.insert("r".into(), 5);
    vocab.insert("d".into(), 6);
    vocab.insert(space.clone(), 7);
    vocab.insert("!".into(), 8);
    vocab.insert("he".into(), 9);
    vocab.insert("hel".into(), 10);
    vocab.insert("hell".into(), 11);
    vocab.insert("hello".into(), 12);
    vocab.insert("wo".into(), 13);
    vocab.insert("wor".into(), 14);
    vocab.insert("worl".into(), 15);
    vocab.insert("world".into(), 16);
    vocab.insert(format!("{space}world"), 17);

    let merges = vec![
        "h e".to_string(),
        "he l".to_string(),
        "hel l".to_string(),
        "hell o".to_string(),
        "w o".to_string(),
        "wo r".to_string(),
        "wor l".to_string(),
        "worl d".to_string(),
        format!("{space} world"),
    ];

    TokenizerMap {
        id: "test/byte_level".into(),
        version: "2".into(),
        vocab_size: vocab.len() as i64,
        vocab: Some(vocab),
        tokens: None,
        encoder: Some("byte_level".into()),
        merges: Some(merges),
        // Llama-3-style simplified pre-tokenizer: word + maybe-leading-space.
        pre_tokenizer_pattern: Some(" ?[A-Za-z]+| ?[^A-Za-z\\s]+|\\s+".into()),
        byte_fallback_start: None,
        byte_fallback_end: None,
        special_tokens: None,
        tool_calling: None,
        published_at: None,
    }
}

#[test]
fn encodes_hello_world_exactly() {
    let map = make_byte_level_fixture();
    let tok = BPETokenizer::new(&map).expect("supports");
    let ids = ITokenizer::encode(&tok, "hello world!");
    assert_eq!(ids, vec![12, 17, 8]);
}

#[test]
fn round_trips_through_detokenizer() {
    let map = make_byte_level_fixture();
    let tok = BPETokenizer::new(&map).expect("supports");
    let mut detok = Detokenizer::new(&map);
    let text = "hello world!";
    let ids = ITokenizer::encode(&tok, text);
    assert_eq!(detok.render(&ids, Default::default()), text);
}

#[test]
fn merges_greedily_by_priority_not_left_to_right() {
    // Build a fixture where merge priority matters.
    let mut vocab: HashMap<String, u32> = HashMap::new();
    vocab.insert("a".into(), 0);
    vocab.insert("b".into(), 1);
    vocab.insert("c".into(), 2);
    vocab.insert("ab".into(), 3);
    vocab.insert("bc".into(), 4);
    vocab.insert("abc".into(), 5);

    // "b c" first (lower index = higher priority).
    // Greedy left-to-right: "ab" + "c" → [3, 2].
    // Priority-correct: "a" + "bc" → [0, 4].
    let merges = vec!["b c".to_string(), "a b".to_string()];

    let map = TokenizerMap {
        id: "test/priority".into(),
        version: "2".into(),
        vocab_size: 6,
        vocab: Some(vocab),
        tokens: None,
        encoder: Some("byte_level".into()),
        merges: Some(merges),
        pre_tokenizer_pattern: Some("\\S+".into()),
        byte_fallback_start: None,
        byte_fallback_end: None,
        special_tokens: None,
        tool_calling: None,
        published_at: None,
    };

    let tok = BPETokenizer::new(&map).expect("supports");
    assert_eq!(ITokenizer::encode(&tok, "abc"), vec![0, 4]);
}

#[test]
fn chat_template_and_fim_specials_emit_atomic_ids() {
    // Regression guard for the special-token pre-scan. Reference IDs come
    // from HuggingFace `tokenizers` 0.23.1 reading Qwen-2.5-0.5B-Instruct's
    // tokenizer.json — the encoder must emit each `<|...|>` delimiter as
    // a single atomic vocab ID, not as 6 byte-level tokens.
    //
    // Today this test runs against a synthetic byte_level fixture (the
    // real Qwen-2 regex needs lookaround support that the `regex` crate
    // doesn't ship; the durable fix is porting `pre_tokenizer_program`
    // execution to the Rust client so it can skip the regex path
    // entirely, matching @codecai/web and codecai (Python)). When that
    // lands, this test should switch to loading the real codec-maps
    // qwen/qwen2 map and asserting the reference IDs above.
    let _real_qwen_path = find_qwen_map(); // keep helper used

    // Synthetic byte_level map with two `<|...|>` delimiters in vocab AND
    // special_tokens. Encoding `<|sep|>text<|end|>` must emit the two
    // atomic IDs (1000, 1001) flanking the BPE'd middle.
    let bl_space = encode_byte_level_chars(&[0x20]);
    let mut vocab: HashMap<String, u32> = HashMap::new();
    vocab.insert("a".into(), 0);
    vocab.insert("b".into(), 1);
    vocab.insert("c".into(), 2);
    vocab.insert(bl_space.clone(), 3);
    vocab.insert("ab".into(), 4);
    vocab.insert("abc".into(), 5);
    vocab.insert("<|sep|>".into(), 1000);
    vocab.insert("<|end|>".into(), 1001);
    let merges = vec!["a b".into(), "ab c".into()];
    let mut specials: HashMap<String, u32> = HashMap::new();
    specials.insert("<|sep|>".into(), 1000);
    specials.insert("<|end|>".into(), 1001);
    let map = TokenizerMap {
        id: "test/specials".into(),
        version: "2".into(),
        vocab_size: 1002,
        vocab: Some(vocab),
        tokens: None,
        encoder: Some("byte_level".into()),
        merges: Some(merges),
        pre_tokenizer_pattern: Some(" ?[A-Za-z]+| ?[^A-Za-z\\s]+|\\s+".into()),
        byte_fallback_start: None,
        byte_fallback_end: None,
        special_tokens: Some(specials),
        tool_calling: None,
        published_at: None,
    };
    let tok = BPETokenizer::new(&map).expect("supports");
    // `<|sep|>abc<|end|>` → [1000, 5, 1001]: special, BPE'd "abc", special.
    let ids = ITokenizer::encode(&tok, "<|sep|>abc<|end|>");
    assert_eq!(ids, vec![1000, 5, 1001]);
}
