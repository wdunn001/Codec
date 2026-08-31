// SPDX-License-Identifier: MIT
//! Shared test fixtures: mirrors `packages/dotnet/test/.../Fixtures.cs`.
#![allow(dead_code)]

use std::collections::HashMap;

use codec_rs::TokenizerMap;

/// Tiny synthetic v1-style map for exercising Detokenizer + LongestMatch
/// without pulling in a real model.
pub fn tiny_map() -> TokenizerMap {
    let mut tokens: HashMap<String, String> = HashMap::new();
    tokens.insert("0".into(), "\u{FFFD}".into());
    tokens.insert("1".into(), "h".into());
    tokens.insert("2".into(), "he".into());
    tokens.insert("3".into(), "hello".into());
    tokens.insert("4".into(), " ".into());
    tokens.insert("5".into(), "world".into());
    tokens.insert("6".into(), "w".into());
    tokens.insert("7".into(), "wor".into());
    tokens.insert("8".into(), "!".into());
    tokens.insert("9".into(), "\n".into());

    let mut specials: HashMap<String, u32> = HashMap::new();
    specials.insert("eos".into(), 266);
    specials.insert("bos".into(), 267);

    TokenizerMap {
        id: "test-tiny-v1".into(),
        version: "1.0.0".into(),
        vocab_size: 270,
        vocab: None,
        tokens: Some(tokens),
        encoder: None,
        merges: None,
        pre_tokenizer_pattern: None,
        pre_tokenizer_program: None,
        byte_fallback_start: Some(10),
        byte_fallback_end: Some(265),
        special_tokens: Some(specials),
        tool_calling: None,
        published_at: None,
    }
}

/// ID for a raw byte in the byte-fallback range.
pub fn byte_id(b: u8) -> u32 {
    10 + b as u32
}
