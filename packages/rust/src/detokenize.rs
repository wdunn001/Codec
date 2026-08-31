// SPDX-License-Identifier: MIT
//! Stateful detokenizer: token IDs → text.
//!
//! Three correctness concerns it handles:
//!
//! 1. Per-token decoding via the map's encoder (byte_level / metaspace / identity).
//! 2. Byte-fallback range: IDs in `[byte_fallback_start, byte_fallback_end]` are decoded as raw bytes.
//! 3. Partial multi-byte sequences across frame boundaries: buffered between calls when `partial: true`.

use std::collections::{HashMap, HashSet};

use crate::byte_encoder::{decode_byte_level_token, METASPACE};
use crate::map::TokenizerMap;

/// Options for [`Detokenizer::render`].
#[derive(Debug, Clone, Copy, Default)]
pub struct DetokenizeOptions {
    /// If `true`, this is not the final chunk: buffer any trailing
    /// partial UTF-8 sequence rather than emitting replacement
    /// characters. Set to `false` on the last chunk so the buffer flushes.
    pub partial: bool,
    /// If `true`, render special tokens (e.g. `<|eos|>`) as text. Default: false.
    pub render_special: bool,
}

/// Stateful detokenizer.
///
/// Construct with a [`TokenizerMap`]; call [`Detokenizer::render`]
/// repeatedly with chunks of IDs. State (the partial UTF-8 byte buffer)
/// persists across calls; [`Detokenizer::reset`] clears it.
pub struct Detokenizer {
    special_ids: HashSet<u32>,
    fallback_start: i64,
    fallback_end: i64,
    /// `Some` when encoder == "byte_level".
    id_to_bytes: Option<HashMap<u32, Vec<u8>>>,
    /// `Some` for metaspace + identity.
    id_to_text: Option<HashMap<u32, String>>,
    byte_buffer: Vec<u8>,
}

impl Detokenizer {
    /// Build a detokenizer from a map.
    pub fn new(map: &TokenizerMap) -> Self {
        let special_ids: HashSet<u32> = map
            .special_tokens
            .as_ref()
            .map(|s| s.values().copied().collect())
            .unwrap_or_default();
        let fallback_start = map.byte_fallback_start.unwrap_or(-1);
        let fallback_end = map.byte_fallback_end.unwrap_or(-2);

        let (id_to_bytes, id_to_text) = if map.encoder.as_deref() == Some("byte_level") {
            (Some(build_byte_level_table(map)), None)
        } else {
            (None, Some(build_text_table(map)))
        };

        Self {
            special_ids,
            fallback_start,
            fallback_end,
            id_to_bytes,
            id_to_text,
            byte_buffer: Vec::new(),
        }
    }

    /// Render a chunk of IDs to text. Stateful across calls.
    pub fn render(&mut self, ids: &[u32], options: DetokenizeOptions) -> String {
        let mut out = String::new();
        let render_special = options.render_special;

        for &id in ids {
            // Byte-fallback range: SentencePiece reserves IDs for raw bytes 0x00-0xFF.
            let id_i = id as i64;
            if id_i >= self.fallback_start && id_i <= self.fallback_end {
                let b = (id_i - self.fallback_start) as u8;
                self.byte_buffer.push(b);
                self.flush_all_bytes(&mut out);
                continue;
            }

            if let Some(map_bytes) = &self.id_to_bytes {
                // byte_level: every vocab token IS a byte sequence.
                if self.special_ids.contains(&id) && !render_special {
                    if !self.byte_buffer.is_empty() {
                        self.flush_bytes_force(&mut out);
                    }
                    continue;
                }
                match map_bytes.get(&id) {
                    None => {
                        if !self.byte_buffer.is_empty() {
                            self.flush_bytes_force(&mut out);
                        }
                        out.push('\u{FFFD}');
                    }
                    Some(bytes) => {
                        self.byte_buffer.extend_from_slice(bytes);
                        self.flush_all_bytes(&mut out);
                    }
                }
                continue;
            }

            // metaspace / identity: token text is rendered directly.
            if !self.byte_buffer.is_empty() {
                self.flush_bytes_force(&mut out);
            }
            if self.special_ids.contains(&id) && !render_special {
                continue;
            }
            match self.id_to_text.as_ref().and_then(|m| m.get(&id)) {
                Some(text) => out.push_str(text),
                None => out.push('\u{FFFD}'),
            }
        }

        if !options.partial && !self.byte_buffer.is_empty() {
            self.flush_bytes_force(&mut out);
        }
        out
    }

    /// Reset internal state: call between conversations / requests.
    pub fn reset(&mut self) {
        self.byte_buffer.clear();
    }

    /// Convenience: detokenize a complete sequence in one shot. Uses a
    /// fresh detokenizer; partial buffering not exposed.
    pub fn detokenize(map: &TokenizerMap, ids: &[u32], render_special: bool) -> String {
        let mut d = Self::new(map);
        d.render(ids, DetokenizeOptions { partial: false, render_special })
    }

    // ── Internals ──────────────────────────────────────────────────────────

    fn flush_all_bytes(&mut self, out: &mut String) {
        loop {
            if self.byte_buffer.is_empty() {
                return;
            }
            let needed = utf8_sequence_length(self.byte_buffer[0]);
            if needed == 0 {
                self.byte_buffer.remove(0);
                out.push('\u{FFFD}');
                continue;
            }
            if self.byte_buffer.len() < needed {
                return;
            }
            let slice: Vec<u8> = self.byte_buffer.drain(..needed).collect();
            match std::str::from_utf8(&slice) {
                Ok(s) => out.push_str(s),
                Err(_) => out.push('\u{FFFD}'),
            }
        }
    }

    fn flush_bytes_force(&mut self, out: &mut String) {
        if self.byte_buffer.is_empty() {
            return;
        }
        let bytes = std::mem::take(&mut self.byte_buffer);
        // Lossy decode matches .NET's `Encoding.UTF8.GetString` (replacement char on invalid).
        out.push_str(&String::from_utf8_lossy(&bytes));
    }
}

fn utf8_sequence_length(b: u8) -> usize {
    if b & 0x80 == 0x00 {
        1
    } else if b & 0xE0 == 0xC0 {
        2
    } else if b & 0xF0 == 0xE0 {
        3
    } else if b & 0xF8 == 0xF0 {
        4
    } else {
        0
    }
}

fn build_byte_level_table(map: &TokenizerMap) -> HashMap<u32, Vec<u8>> {
    let mut result = HashMap::new();
    if let Some(vocab) = &map.vocab {
        result.reserve(vocab.len());
        for (token, &id) in vocab {
            result.insert(id, decode_byte_level_token(token));
        }
    }
    result
}

fn build_text_table(map: &TokenizerMap) -> HashMap<u32, String> {
    let mut result: HashMap<u32, String> = HashMap::new();
    let is_metaspace = map.encoder.as_deref() == Some("metaspace");

    if let Some(vocab) = &map.vocab {
        for (token, &id) in vocab {
            // SentencePiece byte-fallback tokens (<0xHH>) live in vocab
            // but are handled by the byte_fallback range path.
            if is_byte_fallback_token(token) {
                continue;
            }
            let text = if is_metaspace {
                token.replace(METASPACE, " ")
            } else {
                token.clone()
            };
            result.insert(id, text);
        }
    }
    if let Some(tokens) = &map.tokens {
        for (id_str, text) in tokens {
            if let Ok(id) = id_str.parse::<u32>() {
                result.insert(id, text.clone());
            }
        }
    }
    result
}

fn is_byte_fallback_token(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 6 {
        return false;
    }
    if bytes[0] != b'<' || bytes[1] != b'0' || bytes[2] != b'x' || bytes[5] != b'>' {
        return false;
    }
    is_hex_byte(bytes[3]) && is_hex_byte(bytes[4])
}

fn is_hex_byte(b: u8) -> bool {
    b.is_ascii_hexdigit()
}
