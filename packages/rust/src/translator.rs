// SPDX-License-Identifier: MIT
//! Translator: cross-vocab token-stream pipe.
//!
//! Take Agent A's token IDs in vocab `V_A`, produce Agent B's token IDs
//! in vocab `V_B`, with no text ever leaving the process. Internally:
//!
//! ```text
//!     ids_A → Detokenizer(V_A) → utf8 → BPETokenizer(V_B) → ids_B
//! ```
//!
//! The text intermediate is purely local; agent-to-agent traffic still
//! carries only token IDs on the wire. Mirrors the TS Translator class
//! from `@codecai/web` and the Python Translator from `codecai`: same
//! word-boundary buffering rules.
//!
//! Streaming caveat: BPE merges depend on context. Re-tokenizing
//! partial words mid-stream produces different IDs than re-tokenizing
//! the complete word. The Translator buffers text until a safe boundary
//! (whitespace) before flushing through BPE. Pass `partial=true` for
//! incoming chunks and `partial=false` (or call [`Translator::finish`])
//! on the last chunk so the buffer drains.

use std::collections::{HashMap, HashSet};

use crate::detokenize::{Detokenizer, DetokenizeOptions};
use crate::longest_match::Tokenize;
use crate::map::TokenizerMap;
use crate::tokenize::ITokenizer;

/// Cross-vocab agent-handoff pipe.
pub struct Translator {
    pub from_id: String,
    pub to_id: String,
    from_detok: Detokenizer,
    to_tok: Box<dyn ITokenizer>,
    text_buffer: String,
}

impl Translator {
    /// Construct a translator from V_A (`from_map`) to V_B (`to_map`).
    pub fn new(from_map: &TokenizerMap, to_map: &TokenizerMap) -> Self {
        Self {
            from_id: from_map.id.clone(),
            to_id: to_map.id.clone(),
            from_detok: Detokenizer::new(from_map),
            to_tok: Tokenize::pick(to_map),
            text_buffer: String::new(),
        }
    }

    /// Translate a chunk of source-vocab IDs to target-vocab IDs.
    ///
    /// `partial=true` for streaming chunks (a trailing partial word
    /// stays buffered). `partial=false` (or call [`Translator::finish`])
    /// on the final chunk so the buffer drains.
    pub fn translate(&mut self, ids: &[u32], partial: bool) -> Vec<u32> {
        let text = self
            .from_detok
            .render(ids, DetokenizeOptions { partial, render_special: false });
        if !text.is_empty() {
            self.text_buffer.push_str(&text);
        }

        if !partial {
            let all_text = std::mem::take(&mut self.text_buffer);
            return self.to_tok.encode(&all_text);
        }

        let safe = find_last_safe_boundary(&self.text_buffer);
        if safe == 0 {
            return Vec::new();
        }
        // Drain the prefix up to `safe` (a char boundary by construction).
        let to_encode: String = self.text_buffer.drain(..safe).collect();
        self.to_tok.encode(&to_encode)
    }

    /// End-of-stream flush. Equivalent to `translate(&[], false)`.
    pub fn finish(&mut self) -> Vec<u32> {
        self.translate(&[], false)
    }

    /// Drop all internal state. Call between conversations.
    pub fn reset(&mut self) {
        self.from_detok.reset();
        self.text_buffer.clear();
    }
}

// ASCII whitespace + common Unicode whitespace block: covers the
// pre-tokenizer regexes used by Llama-3, Qwen, Phi-3, Mistral, etc.
fn is_whitespace_cp(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t'
            | '\n'
            | '\r'
            | '\x0B'
            | '\x0C'
            | '\u{00A0}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{3000}'
    )
}

/// Returns the byte offset just after the last whitespace char in `buf`,
/// or 0 if none found. The returned offset is always a char boundary.
fn find_last_safe_boundary(buf: &str) -> usize {
    let mut last_after: usize = 0;
    for (i, c) in buf.char_indices() {
        if is_whitespace_cp(c) {
            last_after = i + c.len_utf8();
        }
    }
    last_after
}

/// One-shot translator for non-streaming uses where all IDs are in hand.
pub fn translate_one_shot(
    from_map: &TokenizerMap,
    to_map: &TokenizerMap,
    ids: &[u32],
) -> Vec<u32> {
    let mut tr = Translator::new(from_map, to_map);
    tr.translate(ids, false)
}

/// Build a static `V_A → V_B[]` translation table by rendering each
/// `V_A` vocab entry to text and re-tokenizing through `V_B`.
///
/// Context-free: the result for a given source ID may differ from what
/// [`Translator::translate`] produces when the same ID appears
/// mid-sentence (BPE merges depend on context). Useful for analysis
/// (vocab overlap, cost estimation) and as a fast lookup when
/// context-free translation is acceptable.
pub fn static_translation_table(
    from_map: &TokenizerMap,
    to_map: &TokenizerMap,
) -> HashMap<u32, Vec<u32>> {
    let mut detok = Detokenizer::new(from_map);
    let tok = Tokenize::pick(to_map);
    let mut result: HashMap<u32, Vec<u32>> = HashMap::new();

    let mut special_ids: HashSet<u32> = HashSet::new();
    if let Some(specials) = &from_map.special_tokens {
        for &v in specials.values() {
            special_ids.insert(v);
        }
    }

    if let Some(vocab) = &from_map.vocab {
        for &id in vocab.values() {
            if special_ids.contains(&id) {
                continue;
            }
            let text = detok.render(
                &[id],
                DetokenizeOptions { partial: false, render_special: false },
            );
            if text.is_empty() {
                detok.reset();
                continue;
            }
            result.insert(id, tok.encode(&text));
            detok.reset();
        }
    }

    if let Some(tokens) = &from_map.tokens {
        for id_str in tokens.keys() {
            let Ok(id) = id_str.parse::<u32>() else {
                continue;
            };
            if special_ids.contains(&id) || result.contains_key(&id) {
                continue;
            }
            let text = detok.render(
                &[id],
                DetokenizeOptions { partial: false, render_special: false },
            );
            if text.is_empty() {
                detok.reset();
                continue;
            }
            result.insert(id, tok.encode(&text));
            detok.reset();
        }
    }

    result
}
