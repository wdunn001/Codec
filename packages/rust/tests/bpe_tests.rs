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

fn find_p50k_map() -> Option<PathBuf> {
    for c in [
        "/mnt/h/dev/codec-maps/maps/openai/p50k_base.json",
        r"H:\dev\codec-maps\maps\openai\p50k_base.json",
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
        pre_tokenizer_program: None,
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
        pre_tokenizer_program: None,
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
    // Regression guard for the special-token pre-scan + pre_tokenizer_program
    // path. Reference IDs come from HuggingFace `tokenizers` 0.23.1 reading
    // Qwen-2.5-0.5B-Instruct's tokenizer.json — the encoder must emit each
    // `<|...|>` delimiter as a single atomic vocab ID and produce the
    // byte-identical id sequence HF does for the surrounding BPE.
    //
    // Now that the codec-maps qwen/qwen2 map carries
    // `pre_tokenizer_program`, the Rust BPETokenizer bypasses the regex
    // path entirely and matches HF byte-for-byte (the `regex` crate
    // doesn't support `(?i:...)` or `(?!\S)`, both of which appear in
    // the raw pattern).
    let Some(path) = find_qwen_map() else {
        eprintln!("skipping — codec-maps/qwen/qwen2.json not present locally");
        return;
    };
    let bytes = std::fs::read(&path).expect("read map");
    let map = TokenizerMap::from_json(&bytes).expect("parse map");
    let tok = BPETokenizer::new(&map).expect("supports");

    let cases: &[(&str, &[u32])] = &[
        (
            "<|im_start|>user\nWhat is 2+2?<|im_end|>",
            &[151644, 872, 198, 3838, 374, 220, 17, 10, 17, 30, 151645],
        ),
        (
            "<|fim_prefix|>def foo(x):<|fim_suffix|>    return x<|fim_middle|>\n",
            &[151659, 750, 15229, 2075, 1648, 151661, 262, 470, 856, 151660, 198],
        ),
        (
            "<|im_start|>system\nYou are helpful.<|im_end|>\n<|im_start|>user\nHello<|im_end|>",
            &[
                151644, 8948, 198, 2610, 525, 10950, 13, 151645, 198, 151644, 872, 198, 9707,
                151645,
            ],
        ),
    ];
    for (text, expected) in cases {
        let got = ITokenizer::encode(&tok, text);
        assert_eq!(
            &got[..],
            *expected,
            "mismatch on {text:?}: expected {expected:?}, got {got:?}"
        );
    }
}

#[test]
fn p50k_base_round_trips_via_lead_space_program_ops() {
    // The older-OpenAI pre-tokenizer (p50k_base, r50k_base) was previously
    // unbuildable in Rust because the regex `\s+(?!\S)` lookahead isn't
    // supported by the `regex` crate. With the new
    // `literals` + lead_space variants on `letters`/`numbers`, the maps-cli
    // emits a program for these maps and the Rust BPE bypasses the regex
    // path entirely. Reference IDs from HuggingFace `tokenizers` 0.23.1.
    let Some(path) = find_p50k_map() else {
        eprintln!("skipping — codec-maps/openai/p50k_base.json not present locally");
        return;
    };
    let bytes = std::fs::read(&path).expect("read map");
    let map = TokenizerMap::from_json(&bytes).expect("parse map");
    let tok = BPETokenizer::new(&map).expect("supports");

    let cases: &[(&str, &[u32])] = &[
        ("Hello, world!", &[15496, 11, 995, 0]),
        (
            "1 2 12 123 1234 12345",
            &[16, 362, 1105, 17031, 1105, 2682, 17031, 2231],
        ),
        ("   spaces", &[50257, 9029]),
    ];
    for (text, expected) in cases {
        let got = ITokenizer::encode(&tok, text);
        assert_eq!(
            &got[..],
            *expected,
            "mismatch on {text:?}: expected {expected:?}, got {got:?}"
        );
    }
}
