// SPDX-License-Identifier: MIT
//! Vocab-only longest-prefix-match tokenizer.
//!
//! Walks input left-to-right, emitting the ID of the longest vocab
//! fragment that matches at each position. Suitable for canonical-IR /
//! synthetic test maps. NOT BPE-correct for real model vocabs: use
//! [`crate::BPETokenizer`] for those.

use std::collections::HashMap;

use crate::map::TokenizerMap;
use crate::tokenize::{BPETokenizer, ITokenizer};

/// Vocab-only fallback tokenizer.
pub struct LongestMatchTokenizer {
    id: String,
    fragment_to_id: HashMap<String, u32>,
    max_fragment_length: usize,
    special_fragment_to_id: Vec<(String, u32)>,
}

impl LongestMatchTokenizer {
    pub fn new(map: &TokenizerMap) -> Self {
        let id = map.id.clone();
        let mut max_len = 1usize;
        let mut fragment_to_id: HashMap<String, u32> = HashMap::new();

        if let Some(vocab) = &map.vocab {
            for (frag, &fid) in vocab {
                if frag.is_empty() {
                    continue;
                }
                fragment_to_id.insert(frag.clone(), fid);
                if frag.len() > max_len {
                    max_len = frag.len();
                }
            }
        }
        if let Some(tokens) = &map.tokens {
            for (id_str, frag) in tokens {
                if frag.is_empty() {
                    continue;
                }
                let Ok(fid) = id_str.parse::<u32>() else {
                    continue;
                };
                fragment_to_id.insert(frag.clone(), fid);
                if frag.len() > max_len {
                    max_len = frag.len();
                }
            }
        }

        let mut special_fragment_to_id: Vec<(String, u32)> = Vec::new();
        if let Some(specials) = &map.special_tokens {
            for (name, &sid) in specials {
                special_fragment_to_id.push((name.clone(), sid));
                if !name.starts_with('<') {
                    special_fragment_to_id.push((format!("<|{name}|>"), sid));
                }
            }
        }

        Self {
            id,
            fragment_to_id,
            max_fragment_length: max_len,
            special_fragment_to_id,
        }
    }

    pub fn encode(&self, text: &str) -> Vec<u32> {
        // Operate on bytes to mirror .NET String.Substring/CompareOrdinal
        // semantics in a way that's safe for arbitrary content. We only
        // emit boundaries on UTF-8 char boundaries, but advance by raw
        // bytes for the longest-prefix walk.
        let bytes = text.as_bytes();
        let mut output: Vec<u32> = Vec::new();
        let mut pos = 0usize;
        let n = bytes.len();

        while pos < n {
            // Specials win.
            let mut consumed = false;
            for (frag, sid) in &self.special_fragment_to_id {
                let fb = frag.as_bytes();
                if pos + fb.len() <= n && &bytes[pos..pos + fb.len()] == fb {
                    output.push(*sid);
                    pos += fb.len();
                    consumed = true;
                    break;
                }
            }
            if consumed {
                continue;
            }

            let remaining = n - pos;
            let try_up_to = self.max_fragment_length.min(remaining);
            let mut matched_id: Option<u32> = None;
            let mut matched_len = 0usize;
            for len in (1..=try_up_to).rev() {
                // Only attempt if the slice is on a char boundary
                // (otherwise it can't equal any real fragment string).
                if !text.is_char_boundary(pos + len) || !text.is_char_boundary(pos) {
                    continue;
                }
                let candidate = &text[pos..pos + len];
                if let Some(&fid) = self.fragment_to_id.get(candidate) {
                    matched_id = Some(fid);
                    matched_len = len;
                    break;
                }
            }

            match matched_id {
                None => {
                    output.push(0); // UNK
                    // Advance by one char (or one byte if mid-codepoint, defensive).
                    let advance = next_char_boundary(text, pos).max(1);
                    pos += advance;
                }
                Some(fid) => {
                    output.push(fid);
                    pos += matched_len;
                }
            }
        }
        output
    }
}

fn next_char_boundary(s: &str, pos: usize) -> usize {
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut i = pos + 1;
    while i < n && !s.is_char_boundary(i) {
        i += 1;
    }
    i - pos
}

impl ITokenizer for LongestMatchTokenizer {
    fn id(&self) -> &str {
        &self.id
    }
    fn encode(&self, text: &str) -> Vec<u32> {
        Self::encode(self, text)
    }
}

/// Top-level tokenizer factory.
pub struct Tokenize;

impl Tokenize {
    /// Build the right tokenizer for the map. [`BPETokenizer`] when the
    /// map has BPE data; otherwise [`LongestMatchTokenizer`].
    pub fn pick(map: &TokenizerMap) -> Box<dyn ITokenizer> {
        if BPETokenizer::supports(map) {
            // We've already verified support; unwrap is safe.
            Box::new(BPETokenizer::new(map).expect("supports() succeeded"))
        } else {
            Box::new(LongestMatchTokenizer::new(map))
        }
    }

    /// One-shot encode using [`Tokenize::pick`].
    pub fn encode(map: &TokenizerMap, text: &str) -> Vec<u32> {
        Self::pick(map).encode(text)
    }
}
