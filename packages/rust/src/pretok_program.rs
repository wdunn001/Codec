// SPDX-License-Identifier: MIT
//! Pre-tokenizer program interpreter.
//!
//! Executes a [`PreTokProgram`] against an input string, producing the
//! same sequence of pieces that the legacy `pre_tokenizer_pattern` regex
//! would have produced. Mirror of `@codecai/web`'s `pretok-program.ts`
//! and `codecai`'s `pretok_program.py`; see
//! [`spec/PRETOKENIZER_PROGRAM.md`](https://github.com/wdunn001/Codec/blob/main/spec/PRETOKENIZER_PROGRAM.md)
//! for the design rationale and op set.
//!
//! Why this exists in the Rust client: the `regex` crate doesn't support
//! lookaround (`\s+(?!\S)`) or ES2025 RegExp Pattern Modifiers
//! (`(?i:...)`), both of which appear in every GPT-2-family
//! `pre_tokenizer_pattern`. Without the program interpreter, the Rust
//! `BPETokenizer` constructor fails before encode() runs on every
//! shipped Qwen / Llama-3 / Phi-4 / cl100k_base map. With the
//! interpreter, the program path bypasses regex entirely and the same
//! maps tokenise byte-for-byte against HuggingFace.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::byte_encoder::METASPACE;

// ── Op types ────────────────────────────────────────────────────────────────

/// One op in a [`PreTokProgram`]. See module-level docs for semantics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PreTokOp {
    /// `(?i:p1|p2|...)` — match the longest case-insensitive literal.
    LiteralsCi { patterns: Vec<String> },
    /// Case-sensitive literal alternatives — like `LiteralsCi` but matches
    /// case-exact. Used by older OpenAI tokenizers (p50k_base, r50k_base).
    Literals { patterns: Vec<String> },
    /// `\p{L}+`, `[^\r\n\p{L}\p{N}]?\p{L}+` when `lead_other`, or
    /// ` ?\p{L}+` when `lead_space`. The two lead flags are mutually
    /// exclusive — `lead_space` is the older-OpenAI shape, `lead_other`
    /// is the GPT-2 / Qwen / Llama-3 shape.
    Letters {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lead_other: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lead_space: Option<bool>,
    },
    /// `\p{N}+` (unbounded) or `\p{N}{1,K}` when `max_run > 0`; with optional
    /// ` ?` literal-space lead for older OpenAI tokenizers.
    Numbers {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_run: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lead_space: Option<bool>,
    },
    /// `[ ?][^\s\p{L}\p{N}]+[\r\n]*` with toggleable lead-space and
    /// trailing-newlines.
    PunctRun {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lead_space: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trailing_newlines: Option<bool>,
    },
    /// `\s*[\r\n]+` — paragraph break with leading indentation.
    NewlineBlock {},
    /// `\s+(?!\S)` — whitespace at end of input (or with only more ws after).
    TrailingWs {},
    /// `\s+` — generic whitespace catchall (always last in GPT-2 programs).
    WsRun {},
    /// SentencePiece-style splitter — single-op programs only.
    MetaspaceSplit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix_first: Option<bool>,
    },
}

/// A compiled pre-tokenizer program. Carried alongside the legacy
/// `pre_tokenizer_pattern` on v2.1+ maps. Runtimes prefer the program
/// when present; falls back to the regex otherwise.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreTokProgram {
    pub version: u32,
    pub ops: Vec<PreTokOp>,
}

// ── Class predicates ────────────────────────────────────────────────────────

fn re_letter() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\p{L}").unwrap())
}
fn re_number() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\p{N}").unwrap())
}
fn re_ws() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\s").unwrap())
}

fn is_letter(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_letter().is_match(cp.encode_utf8(&mut buf))
}
fn is_number(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_number().is_match(cp.encode_utf8(&mut buf))
}
fn is_ws(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_ws().is_match(cp.encode_utf8(&mut buf))
}

// ── Per-op matchers ────────────────────────────────────────────────────────
//
// Each returns the byte count consumed at position `i`, or 0 if no match.

fn match_literals_ci(patterns: &[String], text: &str, i: usize) -> usize {
    let rest = &text[i..];
    let mut best = 0;
    for p in patterns {
        if p.len() <= best || rest.len() < p.len() {
            continue;
        }
        let head = &rest[..p.len()];
        if head.eq_ignore_ascii_case(p) {
            best = p.len();
        }
    }
    best
}

fn match_literals(patterns: &[String], text: &str, i: usize) -> usize {
    let rest = &text[i..];
    let mut best = 0;
    for p in patterns {
        if p.len() <= best || rest.len() < p.len() {
            continue;
        }
        if &rest[..p.len()] == p.as_str() {
            best = p.len();
        }
    }
    best
}

fn match_letters(lead_other: bool, lead_space: bool, text: &str, i: usize) -> usize {
    let rest = &text[i..];
    let mut chars = rest.char_indices().peekable();
    let mut p = 0usize;
    if lead_other {
        // `[^\r\n\p{L}\p{N}]?` — at most one char that is none of those.
        if let Some(&(_off, c)) = chars.peek() {
            if c != '\r' && c != '\n' && !is_letter(c) && !is_number(c) {
                p = c.len_utf8();
                chars.next();
            }
        }
    } else if lead_space {
        // ` ?` — at most one literal space.
        if let Some(&(_off, c)) = chars.peek() {
            if c == ' ' {
                p = c.len_utf8();
                chars.next();
            }
        }
    }
    // `\p{L}+`
    let run_start = p;
    while let Some(&(_off, c)) = chars.peek() {
        if !is_letter(c) {
            break;
        }
        p += c.len_utf8();
        chars.next();
    }
    if p == run_start {
        0
    } else {
        p
    }
}

fn match_numbers(max_run: u32, lead_space: bool, text: &str, i: usize) -> usize {
    let max = if max_run == 0 { u32::MAX } else { max_run };
    let mut p = 0usize;
    let bytes = text.as_bytes();
    if lead_space && i + p < bytes.len() && bytes[i + p] == b' ' {
        p += 1;
    }
    let run_start = p;
    let mut count = 0u32;
    for c in text[i + p..].chars() {
        if count >= max || !is_number(c) {
            break;
        }
        p += c.len_utf8();
        count += 1;
    }
    if p == run_start { 0 } else { p }
}

fn match_punct_run(
    lead_space: bool,
    trailing_newlines: bool,
    text: &str,
    i: usize,
) -> usize {
    let bytes = text.as_bytes();
    let mut p = i;
    if lead_space && p < bytes.len() && bytes[p] == b' ' {
        p += 1;
    }
    // `[^\s\p{L}\p{N}]+`
    let run_start = p;
    for c in text[p..].chars() {
        if is_ws(c) || is_letter(c) || is_number(c) {
            break;
        }
        p += c.len_utf8();
    }
    if p == run_start {
        return 0;
    }
    if trailing_newlines {
        while p < bytes.len() && (bytes[p] == b'\n' || bytes[p] == b'\r') {
            p += 1;
        }
    }
    p - i
}

fn match_newline_block(text: &str, i: usize) -> usize {
    // `\s*[\r\n]+` — greedy `\s*`, then back off until the trailing run is
    // contiguous newlines.
    let mut p = 0usize;
    for c in text[i..].chars() {
        if !is_ws(c) {
            break;
        }
        p += c.len_utf8();
    }
    let bytes = text.as_bytes();
    // Find the first newline within [i, i+p).
    let mut first_nl: Option<usize> = None;
    for q in i..(i + p) {
        if bytes[q] == b'\n' || bytes[q] == b'\r' {
            first_nl = Some(q);
            break;
        }
    }
    let Some(first_nl) = first_nl else { return 0 };
    // Trim back from end while we see non-newline whitespace.
    let mut q = i + p;
    while q > first_nl {
        let c = bytes[q - 1];
        if c == b'\n' || c == b'\r' {
            break;
        }
        q -= 1;
    }
    q - i
}

fn match_trailing_ws(text: &str, i: usize) -> usize {
    // `\s+(?!\S)`: longest whitespace run ending either at EOI or one
    // code point before a final whitespace.
    let mut p = i;
    for c in text[i..].chars() {
        if !is_ws(c) {
            break;
        }
        p += c.len_utf8();
    }
    if p == i {
        return 0;
    }
    if p == text.len() {
        return p - i;
    }
    // Trailing non-ws follows; trim before the LAST whitespace code point.
    let mut q = i;
    let mut last_start = i;
    while q < p {
        last_start = q;
        let c = text[q..].chars().next().unwrap();
        q += c.len_utf8();
    }
    last_start - i
}

fn match_ws_run(text: &str, i: usize) -> usize {
    let mut p = 0usize;
    for c in text[i..].chars() {
        if !is_ws(c) {
            break;
        }
        p += c.len_utf8();
    }
    p
}

// ── Interpreter loop ────────────────────────────────────────────────────────

/// Execute `program` against `text`, returning the same piece sequence
/// the legacy regex pre-tokenizer would have emitted.
pub fn run_pretok_program(program: &PreTokProgram, text: &str) -> Vec<String> {
    // Single-op metaspace shortcut.
    if program.ops.len() == 1 {
        if let PreTokOp::MetaspaceSplit { prefix_first } = &program.ops[0] {
            return run_metaspace(prefix_first.unwrap_or(false), text);
        }
    }

    let mut out: Vec<String> = Vec::new();
    let bytes = text.as_bytes();
    let n = bytes.len();
    let mut i = 0usize;
    'outer: while i < n {
        for op in &program.ops {
            let span = match op {
                PreTokOp::LiteralsCi { patterns } => match_literals_ci(patterns, text, i),
                PreTokOp::Literals { patterns } => match_literals(patterns, text, i),
                PreTokOp::Letters {
                    lead_other,
                    lead_space,
                } => match_letters(
                    lead_other.unwrap_or(false),
                    lead_space.unwrap_or(false),
                    text,
                    i,
                ),
                PreTokOp::Numbers {
                    max_run,
                    lead_space,
                } => match_numbers(
                    max_run.unwrap_or(0),
                    lead_space.unwrap_or(false),
                    text,
                    i,
                ),
                PreTokOp::PunctRun {
                    lead_space,
                    trailing_newlines,
                } => match_punct_run(
                    lead_space.unwrap_or(false),
                    trailing_newlines.unwrap_or(false),
                    text,
                    i,
                ),
                PreTokOp::NewlineBlock {} => match_newline_block(text, i),
                PreTokOp::TrailingWs {} => match_trailing_ws(text, i),
                PreTokOp::WsRun {} => match_ws_run(text, i),
                PreTokOp::MetaspaceSplit { .. } => 0, // mixed programs unsupported
            };
            if span > 0 {
                out.push(text[i..i + span].to_string());
                i += span;
                continue 'outer;
            }
        }
        // Defensive: no op matched. Consume one scalar value.
        let c = text[i..].chars().next().unwrap();
        out.push(c.to_string());
        i += c.len_utf8();
    }
    out
}

fn run_metaspace(prefix_first: bool, text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    // Collapse `[ \t]+` to a single space, then split on whitespace
    // retaining each ws char.
    let mut prev_horiz_ws = false;
    for c in text.chars() {
        if c == ' ' || c == '\t' {
            if !prev_horiz_ws {
                buf.push(' ');
                prev_horiz_ws = true;
            }
        } else {
            buf.push(c);
            prev_horiz_ws = false;
        }
    }
    let mut is_first = true;
    let mut piece = String::new();
    for c in buf.chars() {
        if c.is_whitespace() {
            if !piece.is_empty() {
                if prefix_first && is_first {
                    out.push(std::mem::take(&mut piece));
                } else {
                    let mut s = String::with_capacity(piece.len() + 3);
                    s.push(METASPACE);
                    s.push_str(&piece);
                    out.push(s);
                    piece.clear();
                }
                is_first = false;
            }
            if c == ' ' {
                is_first = false;
            }
        } else {
            piece.push(c);
        }
    }
    if !piece.is_empty() {
        if prefix_first && is_first {
            out.push(piece);
        } else {
            let mut s = String::with_capacity(piece.len() + 3);
            s.push(METASPACE);
            s.push_str(&piece);
            out.push(s);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qwen_program() -> PreTokProgram {
        PreTokProgram {
            version: 1,
            ops: vec![
                PreTokOp::LiteralsCi {
                    patterns: vec![
                        "'s".into(),
                        "'t".into(),
                        "'re".into(),
                        "'ve".into(),
                        "'m".into(),
                        "'ll".into(),
                        "'d".into(),
                    ],
                },
                PreTokOp::Letters {
                    lead_other: Some(true),
                    lead_space: None,
                },
                PreTokOp::Numbers {
                    max_run: None,
                    lead_space: None,
                },
                PreTokOp::PunctRun {
                    lead_space: Some(true),
                    trailing_newlines: Some(true),
                },
                PreTokOp::NewlineBlock {},
                PreTokOp::TrailingWs {},
                PreTokOp::WsRun {},
            ],
        }
    }

    #[test]
    fn qwen_program_splits_basic_text() {
        let p = qwen_program();
        let out = run_pretok_program(&p, "Hello, world!");
        assert_eq!(out, vec!["Hello", ",", " world", "!"]);
    }

    #[test]
    fn qwen_program_handles_contractions() {
        let p = qwen_program();
        let out = run_pretok_program(&p, "it's");
        assert_eq!(out, vec!["it", "'s"]);
    }

    #[test]
    fn qwen_program_unbounded_digits() {
        let p = qwen_program();
        // Unbounded `numbers` op consumes the whole digit run as one piece.
        let out = run_pretok_program(&p, "abc 12345 def");
        assert_eq!(out, vec!["abc", " ", "12345", " def"]);
    }
}
