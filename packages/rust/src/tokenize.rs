// SPDX-License-Identifier: MIT
//! Pure-Rust BPE encoder. Text → token IDs.
//!
//! Required for the bidirectional Codec endpoint where the client wants
//! to send token-ID prompts (zero text on the wire in either direction).
//!
//! ## Algorithm (for both byte_level and metaspace BPE)
//!
//! 1. Pre-tokenize: split input into pieces (regex for byte_level; whitespace for metaspace).
//! 2. Encode each piece into the vocab's character space (GPT-2 byte chars or `▁`-prefixed).
//! 3. Apply BPE merges greedily by priority — match HuggingFace reference.
//! 4. Look up final tokens in `vocab`. Tokens not in vocab fall back to byte tokens (metaspace path).

use std::cell::RefCell;
use std::collections::HashMap;

use regex::Regex;

use crate::byte_encoder::{encode_byte_level_chars, METASPACE};
use crate::map::TokenizerMap;

/// Common interface every tokenizer implementation satisfies.
///
/// Implemented by [`BPETokenizer`] and [`crate::longest_match::LongestMatchTokenizer`].
///
/// The trait deliberately does not require `Sync` — `BPETokenizer` keeps
/// a `RefCell`-backed encode cache (mirroring the .NET `Dictionary`).
/// Wrap in `Mutex` for cross-thread sharing.
pub trait ITokenizer: Send {
    /// Identifier of the underlying vocabulary.
    fn id(&self) -> &str;
    /// Encode a string to a sequence of token IDs.
    fn encode(&self, text: &str) -> Vec<u32>;
}

/// Pure-Rust BPE encoder.
///
/// Construct via [`BPETokenizer::new`]; check
/// [`BPETokenizer::supports`] first if you don't know whether the map has
/// the data BPE needs (use [`crate::Tokenize::pick`] which falls back).
pub struct BPETokenizer {
    id: String,
    vocab: HashMap<String, u32>,
    /// Map of `"left right"` → priority rank (lower = higher priority).
    merge_ranks: HashMap<String, u32>,
    pre_tok_regex: Option<Regex>,
    encoder: String,
    /// `i64` so a missing fallback (-1) is comparable safely against IDs.
    byte_fallback_start: i64,
    /// Per-piece encode cache. Mutex-free RefCell — BPETokenizer is `!Sync`
    /// but `Send`. (Translator only needs `Send` and constructs its own.)
    cache: RefCell<HashMap<String, Vec<u32>>>,
}

impl BPETokenizer {
    /// Returns true if the map has the data BPETokenizer needs.
    pub fn supports(map: &TokenizerMap) -> bool {
        let has_vocab = map.vocab.as_ref().is_some_and(|v| !v.is_empty());
        let has_merges = map.merges.as_ref().is_some_and(|v| !v.is_empty());
        let enc_ok = matches!(map.encoder.as_deref(), Some("byte_level") | Some("metaspace"));
        has_vocab && has_merges && enc_ok
    }

    /// Construct a `BPETokenizer` from a map. Returns an error message if
    /// the map lacks the required vocab/merges/encoder.
    pub fn new(map: &TokenizerMap) -> Result<Self, String> {
        if !Self::supports(map) {
            return Err(format!(
                "BPETokenizer: map \"{}\" lacks vocab/merges/encoder. \
                 Use BPETokenizer::supports(map) to check first, or call \
                 Tokenize::pick(map) which falls back to LongestMatchTokenizer.",
                map.id
            ));
        }

        let vocab = map.vocab.as_ref().expect("supports() checked").clone();
        let merges = map.merges.as_ref().expect("supports() checked");
        let encoder = map.encoder.as_ref().expect("supports() checked").clone();
        let id = map.id.clone();
        let byte_fallback_start = map.byte_fallback_start.unwrap_or(-1);

        let mut merge_ranks: HashMap<String, u32> = HashMap::with_capacity(merges.len());
        for (i, m) in merges.iter().enumerate() {
            merge_ranks.insert(m.clone(), i as u32);
        }

        let pre_tok_regex = if encoder == "byte_level" {
            let pat = map.pre_tokenizer_pattern.as_ref().ok_or_else(|| {
                format!(
                    "BPETokenizer: byte_level map \"{}\" missing pre_tokenizer_pattern.",
                    map.id
                )
            })?;
            Some(
                Regex::new(pat)
                    .map_err(|e| format!("BPETokenizer: invalid pre_tokenizer_pattern: {e}"))?,
            )
        } else {
            None
        };

        Ok(Self {
            id,
            vocab,
            merge_ranks,
            pre_tok_regex,
            encoder,
            byte_fallback_start,
            cache: RefCell::new(HashMap::new()),
        })
    }

    /// Encode text → token IDs.
    pub fn encode(&self, text: &str) -> Vec<u32> {
        if text.is_empty() {
            return Vec::new();
        }

        let pieces = self.pre_tokenize(text);
        let mut ids: Vec<u32> = Vec::with_capacity(pieces.len() * 2);
        for piece in pieces {
            // Cache hit?
            if let Ok(cache) = self.cache.try_borrow() {
                if let Some(cached) = cache.get(&piece) {
                    ids.extend_from_slice(cached);
                    continue;
                }
            }
            let encoded = self.encode_piece_to_vocab_space(&piece);
            let merged = self.apply_bpe(encoded);
            let piece_ids = self.lookup(&merged);
            if let Ok(mut cache) = self.cache.try_borrow_mut() {
                cache.insert(piece.clone(), piece_ids.clone());
            }
            ids.extend_from_slice(&piece_ids);
        }
        ids
    }

    // ── Pre-tokenization ────────────────────────────────────────────────────

    fn pre_tokenize(&self, text: &str) -> Vec<String> {
        if self.encoder == "byte_level" {
            let re = self.pre_tok_regex.as_ref().expect("byte_level requires regex");
            return re.find_iter(text).map(|m| m.as_str().to_string()).collect();
        }

        // Metaspace: split on whitespace, prefix every word with ▁.
        // Collapse internal runs of spaces/tabs to a single space first
        // (matches .NET).
        let collapsed = collapse_spaces_and_tabs(text);
        let parts = split_keep_whitespace(&collapsed);
        let mut pieces: Vec<String> = Vec::new();
        for p in parts {
            if p == " " {
                continue;
            }
            let mut s = String::with_capacity(p.len() + 3);
            s.push(METASPACE);
            s.push_str(&p);
            pieces.push(s);
        }
        pieces
    }

    // ── Step 2: piece → vocab character space ──────────────────────────────

    fn encode_piece_to_vocab_space(&self, piece: &str) -> Vec<String> {
        if self.encoder == "byte_level" {
            let bytes = piece.as_bytes();
            let encoded = encode_byte_level_chars(bytes);
            return codepoints(&encoded);
        }
        codepoints(piece)
    }

    // ── Step 3: BPE merges ─────────────────────────────────────────────────

    fn apply_bpe(&self, tokens: Vec<String>) -> Vec<String> {
        if tokens.len() < 2 {
            return tokens;
        }
        let mut parts = tokens;
        loop {
            let mut best_idx: Option<usize> = None;
            let mut best_rank: u32 = u32::MAX;
            for i in 0..parts.len() - 1 {
                // Build "left right" without alloc churn — small strings only here.
                let mut key = String::with_capacity(parts[i].len() + 1 + parts[i + 1].len());
                key.push_str(&parts[i]);
                key.push(' ');
                key.push_str(&parts[i + 1]);
                if let Some(&r) = self.merge_ranks.get(&key) {
                    if r < best_rank {
                        best_rank = r;
                        best_idx = Some(i);
                    }
                }
            }
            let Some(_idx) = best_idx else {
                break;
            };

            let left = parts[best_idx.unwrap()].clone();
            let right = parts[best_idx.unwrap() + 1].clone();
            let merged = format!("{left}{right}");

            // Merge ALL non-overlapping occurrences in one pass — matches HF.
            let mut next: Vec<String> = Vec::with_capacity(parts.len());
            let mut j = 0;
            while j < parts.len() {
                if j + 1 < parts.len() && parts[j] == left && parts[j + 1] == right {
                    next.push(merged.clone());
                    j += 2;
                } else {
                    next.push(parts[j].clone());
                    j += 1;
                }
            }
            parts = next;
        }
        parts
    }

    // ── Step 4: vocab lookup with byte fallback ────────────────────────────

    fn lookup(&self, tokens: &[String]) -> Vec<u32> {
        let mut ids: Vec<u32> = Vec::with_capacity(tokens.len());
        for tok in tokens {
            if let Some(&id) = self.vocab.get(tok) {
                ids.push(id);
                continue;
            }
            if self.byte_fallback_start >= 0 {
                for &b in tok.as_bytes() {
                    ids.push((self.byte_fallback_start + b as i64) as u32);
                }
            }
            // For byte_level this is unreachable for valid UTF-8 input.
        }
        ids
    }
}

impl ITokenizer for BPETokenizer {
    fn id(&self) -> &str {
        &self.id
    }
    fn encode(&self, text: &str) -> Vec<u32> {
        BPETokenizer::encode(self, text)
    }
}

// Helpers ------------------------------------------------------------------

fn codepoints(s: &str) -> Vec<String> {
    s.chars().map(|c| c.to_string()).collect()
}

fn collapse_spaces_and_tabs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars() {
        if c == ' ' || c == '\t' {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out
}

/// Split on whitespace, keeping each whitespace char as its own segment
/// (mirrors .NET `Regex.Split(text, "(\\s)")`).
fn split_keep_whitespace(s: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut buf = String::new();
    for c in s.chars() {
        if c.is_whitespace() {
            if !buf.is_empty() {
                parts.push(std::mem::take(&mut buf));
            }
            parts.push(c.to_string());
        } else {
            buf.push(c);
        }
    }
    if !buf.is_empty() {
        parts.push(buf);
    }
    parts
}
