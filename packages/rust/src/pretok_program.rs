// SPDX-License-Identifier: MIT
//! Pre-tokenizer program interpreter.
//!
//! Executes a [`PreTokProgram`] against an input string. It produces the
//! same sequence of pieces the model's real HuggingFace pre-tokenizer
//! would have produced. This is a mirror of `@codecai/web`'s
//! `pretok-program.ts` and `codecai`'s `pretok_program.py`. See
//! [`spec/PRETOKENIZER_PROGRAM.md`](https://github.com/wdunn001/Codec/blob/main/spec/PRETOKENIZER_PROGRAM.md)
//! for the design rationale, the op set, and the stage set.
//!
//! Two program shapes exist, chosen by the program's own `version` field.
//!
//! - v1 (`{ version: 1, ops: [...] }`): a single flat list of ops tried in
//!   priority order at every cursor position, scanned once over the whole
//!   input text. This is the whole program for any tokenizer whose
//!   HuggingFace pre-tokenizer reduces to one alternation regex (Qwen,
//!   Llama-3/4, Phi-4, o200k, mistral-nemo), and for SentencePiece
//!   metaspace tokenizers via the single-op `metaspace_split` shortcut.
//! - v2 (`{ version: 2, stages: [...] }`): an ordered list of stages. Each
//!   stage transforms every piece the stage before it produced, mirroring
//!   HuggingFace's `Sequence` pre-tokenizer exactly. Four published maps
//!   need this: HuggingFaceTB/SmolLM2, tiiuae/falcon,
//!   deepseek-ai/DeepSeek-V3, and deepseek-ai/DeepSeek-R1. A v1 program
//!   cannot express any of these: collapsing a multi-stage `Sequence` into
//!   one flat alternation is exactly the bug this schema version fixes.
//!
//! A program whose `version` field this interpreter doesn't recognise
//! fails deserialization immediately, by name. Guessing at an unknown
//! version's execution model risks emitting a plausible-looking but wrong
//! split, which is the exact failure mode this schema exists to prevent.
//!
//! Why the program path exists at all in the Rust client: the `regex`
//! crate doesn't support lookaround (`\s+(?!\S)`) or inline case-insensitive
//! groups (`(?i:...)`), both of which appear in every GPT-2-family
//! `pre_tokenizer_pattern`. Without the program interpreter, the Rust
//! `BPETokenizer` constructor fails before `encode()` runs on every shipped
//! Qwen / Llama-3 / Phi-4 / cl100k_base map. With the interpreter, the
//! program path bypasses regex entirely and the same maps tokenise
//! byte-for-byte against HuggingFace.

use regex::Regex;
use serde::de::Error as DeError;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::byte_encoder::METASPACE;

// ── Op types (used inside a v1 program directly, or inside a v2
//    `alternation` stage) ────────────────────────────────────────────────

/// Which class an `l_p_s`-style `lead_other` exclusion set uses. See
/// [`PreTokOp::Letters`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LeadOtherClass {
    /// Excludes `\r`, `\n`, `\p{L}`, `\p{N}`. The default, and the only
    /// value any map emitted before `lead_other_class` existed.
    #[serde(rename = "l_n")]
    LN,
    /// Excludes `\r`, `\n`, `\p{L}`, `\p{P}`, `\p{S}`. A digit at the lead
    /// position is admitted under this class. DeepSeek-V3's third `Split`
    /// stage uses it.
    #[serde(rename = "l_p_s")]
    LPS,
}

/// Letter-run body class for [`PreTokOp::Letters`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LetterBody {
    /// `\p{L}+`. The default, and the only value any map emitted before
    /// `body` existed.
    #[serde(rename = "L")]
    L,
    /// `[\p{L}\p{M}]+`: letters plus combining marks, so a base letter and
    /// a following combining accent stay one piece. DeepSeek-V3's third
    /// `Split` stage uses it.
    #[serde(rename = "L_M")]
    LM,
}

/// Punctuation-run body class for [`PreTokOp::PunctRun`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PunctCharset {
    /// `[^\s\p{L}\p{N}]+`: the GPT-2-family complement class. The default,
    /// and the only value any map emitted before `charset` existed.
    #[serde(rename = "not_ws_L_N")]
    NotWsLN,
    /// `[\p{P}\p{S}]+`: the punctuation/symbol class named explicitly
    /// rather than by complement. Excludes combining marks and any other
    /// leftover Unicode category the complement class would otherwise
    /// sweep in. DeepSeek-V3's third `Split` stage uses it.
    #[serde(rename = "p_s")]
    PS,
}

/// One op in a [`PreTokProgram`]. See module-level docs for semantics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PreTokOp {
    /// `(?i:p1|p2|...)`: match the longest case-insensitive literal.
    LiteralsCi { patterns: Vec<String> },
    /// Case-sensitive literal alternatives: like `LiteralsCi` but matches
    /// case-exact. Used by older OpenAI tokenizers (p50k_base, r50k_base).
    Literals { patterns: Vec<String> },
    /// `\p{L}+`, `[^\r\n\p{L}\p{N}]?\p{L}+` when `lead_other`, or
    /// ` ?\p{L}+` when `lead_space`. The two lead flags are mutually
    /// exclusive: `lead_space` is the older-OpenAI shape, `lead_other`
    /// is the GPT-2 / Qwen / Llama-3 shape.
    Letters {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lead_other: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lead_space: Option<bool>,
        /// Which class `lead_other` excludes. Ignored unless `lead_other`
        /// is true. Defaults to [`LeadOtherClass::LN`].
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lead_other_class: Option<LeadOtherClass>,
        /// Letter-run body class. Defaults to [`LetterBody::L`].
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<LetterBody>,
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
        /// Override `trailing_newlines` with an explicit charset string.
        /// Each character is accepted in the trailing run. Used by
        /// o200k_base / mistral-nemo whose trailing is `[\r\n/]`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trailing_chars: Option<String>,
        /// Run-body class. Defaults to [`PunctCharset::NotWsLN`].
        #[serde(default, skip_serializing_if = "Option::is_none")]
        charset: Option<PunctCharset>,
    },
    /// `[!-\/:-@\[-\`{-~][A-Za-z]+`: one ASCII punctuation character, then
    /// one or more ASCII letters. DeepSeek-V3's third `Split` stage's
    /// first alternative: an apostrophe glued to identifier letters, `'m`
    /// in code like Python's `sys.platform == 'linux'`, comes out as one
    /// piece under this op.
    PunctAsciiLetters {},
    /// Cased-letter run with optional trailing case-insensitive contractions.
    /// Used by o200k_base / mistral-nemo. Both split on case boundaries.
    /// `kind: "title"` matches `[Lu Lt Lm Lo M]* [Ll Lm Lo M]+`,
    /// `kind: "upper"` matches `[Lu Lt Lm Lo M]+ [Ll Lm Lo M]*`.
    LettersCased {
        kind: CasedKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lead_other: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trailing_ci: Option<Vec<String>>,
    },
    /// `\s*[\r\n]+`: paragraph break with leading indentation.
    NewlineBlock {},
    /// `\s+(?!\S)`: whitespace at end of input (or with only more ws after).
    TrailingWs {},
    /// `\s+`: generic whitespace catchall (always last in GPT-2 programs).
    WsRun {},
    /// SentencePiece-style splitter: single-op v1 programs only. Never
    /// appears inside a v2 `alternation` stage.
    MetaspaceSplit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix_first: Option<bool>,
    },
}

/// "Title" or "upper" cased-letter shape: see [`PreTokOp::LettersCased`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CasedKind {
    /// `[Lu Lt Lm Lo M]* [Ll Lm Lo M]+`: zero-or-more upper, then 1+ lower.
    Title,
    /// `[Lu Lt Lm Lo M]+ [Ll Lm Lo M]*`: one-or-more upper, then 0+ lower.
    Upper,
}

// ── v2 stage types ───────────────────────────────────────────────────────
//
// Each stage transforms the FULL current list of pieces: every existing
// piece is fed through the stage independently and the results are
// concatenated in order. This mirrors HuggingFace's `Sequence`
// pre-tokenizer exactly. Each sub-pretokenizer runs over every span the
// previous ones already produced.

/// `digits_isolate` mode. See [`PreTokStage::DigitsIsolate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DigitsMode {
    /// Every digit becomes its own piece. Lowered from HuggingFace
    /// `Digits(individual_digits=true)` (SmolLM2's first stage).
    Individual,
    /// Consecutive digits stay together as one piece, chunked to `max_run`
    /// digits when set. Lowered from `Digits(individual_digits=false)`
    /// (Falcon's third stage) or from a bounded `Split` on `\p{N}{1,K}`
    /// (DeepSeek-V3's first stage).
    Grouped,
}

/// One stage in a v2 [`PreTokProgram`]. Each corresponds to exactly one
/// node the maps-cli compiler recognised while walking a HuggingFace
/// `Sequence` pre-tokenizer. See module-level docs and
/// `spec/PRETOKENIZER_PROGRAM.md` § Stages (v2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum PreTokStage {
    /// Isolate digit runs. See [`DigitsMode`].
    DigitsIsolate {
        mode: DigitsMode,
        /// Only meaningful when `mode` is `grouped`. Omit for unbounded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_run: Option<u32>,
    },
    /// HuggingFace `Split("[0-9][0-9][0-9]", Isolated)`: Falcon's fourth
    /// stage. Exact non-overlapping windows of 3 ASCII digits, scanned
    /// left to right. A digit run whose length isn't a multiple of 3
    /// leaves a remainder, which stays ungrouped as part of the
    /// surrounding non-match content. This is deliberately distinct from
    /// `DigitsIsolate`'s `max_run`, which chunks a `\p{N}` run into pieces
    /// of at most `K` digits with no remainder ever left behind.
    DigitTriplesIsolate {},
    /// HuggingFace `Punctuation(Contiguous)`: Falcon's first stage.
    /// Classifies each character as ASCII-punctuation-or-`\p{P}` versus
    /// everything else, and groups each maximal run of one classification
    /// into one piece. Whitespace and letters share the "everything else"
    /// bucket, so a whitespace run stays attached to its adjacent letters.
    PunctuationContiguous {},
    /// HuggingFace `Split([一-龥぀-ゟ゠-ヿ]+, Isolated)`: DeepSeek-V3's second
    /// stage. Isolates maximal runs of CJK Unified Ideographs
    /// (U+4E00-U+9FA5, the model's own literal bound), Hiragana
    /// (U+3040-U+309F), and Katakana (U+30A0-U+30FF) as their own pieces.
    CjkIsolate {},
    /// The GPT-2-style "try every op in priority order, take the first
    /// non-empty match, advance" scanner, scoped to one piece. Lowered
    /// from `ByteLevel(use_regex=true)` (a HuggingFace-crate constant op
    /// list) or from a `Split` node whose regex is one of the recognised
    /// exhaustive alternation shapes.
    Alternation { ops: Vec<PreTokOp> },
}

// ── Program shapes ──────────────────────────────────────────────────────

/// A v1 program: `{ "version": 1, "ops": [...] }`. A flat, ordered list of
/// ops, run as a single alternation scan over the whole input text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreTokProgramV1 {
    pub version: u32,
    pub ops: Vec<PreTokOp>,
}

/// A v2 program: `{ "version": 2, "stages": [...] }`. An ordered pipeline
/// of stages, each run over every piece the stage before it produced.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreTokProgramV2 {
    pub version: u32,
    pub stages: Vec<PreTokStage>,
}

/// A compiled pre-tokenizer program. Carried alongside the legacy
/// `pre_tokenizer_pattern` on a map. Runtimes prefer the program when
/// present, and fall back to the regex otherwise.
///
/// Deserialization dispatches on the program's own `version` field rather
/// than on shape, so a v2 program reaching this build fails loudly by
/// name at load time instead of silently executing a partial or
/// misinterpreted program. See module-level docs and
/// `spec/PRETOKENIZER_PROGRAM.md` § Versioning.
#[derive(Debug, Clone)]
pub enum PreTokProgram {
    V1(PreTokProgramV1),
    V2(PreTokProgramV2),
}

impl PreTokProgram {
    /// True when the program carries no ops (v1) or no stages (v2).
    pub fn is_empty(&self) -> bool {
        match self {
            PreTokProgram::V1(v1) => v1.ops.is_empty(),
            PreTokProgram::V2(v2) => v2.stages.is_empty(),
        }
    }
}

impl Serialize for PreTokProgram {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            PreTokProgram::V1(v1) => v1.serialize(serializer),
            PreTokProgram::V2(v2) => v2.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for PreTokProgram {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Route on the program's own `version` field before committing to
        // either shape. An untagged "try each variant" deserializer would
        // reject an unrecognised version with a generic, unnamed error;
        // this schema requires the failure to name the version it saw.
        let value = serde_json::Value::deserialize(deserializer)?;
        let version = value.get("version").and_then(serde_json::Value::as_u64);
        match version {
            Some(1) => serde_json::from_value(value)
                .map(PreTokProgram::V1)
                .map_err(DeError::custom),
            Some(2) => serde_json::from_value(value)
                .map(PreTokProgram::V2)
                .map_err(DeError::custom),
            _ => {
                let seen = value
                    .get("version")
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "missing".to_string());
                Err(DeError::custom(format!(
                    "pre_tokenizer_program: unsupported version {seen}. \
                     This client understands versions 1 and 2. Upgrade the client to use this map."
                )))
            }
        }
    }
}

// ── Class predicates (native regex; no Unicode data shipped beyond what
//    the `regex` crate already carries for v1) ────────────────────────────

fn re_letter() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\p{L}").unwrap())
}
fn re_number() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\p{N}").unwrap())
}
fn re_mark() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\p{M}").unwrap())
}
fn re_punct() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\p{P}").unwrap())
}
fn re_symbol() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\p{S}").unwrap())
}
fn re_ws() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\s").unwrap())
}
fn re_letter_upper() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]").unwrap())
}
fn re_letter_lower() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[\p{Ll}\p{Lm}\p{Lo}\p{M}]").unwrap())
}

fn is_letter(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_letter().is_match(cp.encode_utf8(&mut buf))
}
fn is_number(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_number().is_match(cp.encode_utf8(&mut buf))
}
fn is_mark(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_mark().is_match(cp.encode_utf8(&mut buf))
}
fn is_punct(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_punct().is_match(cp.encode_utf8(&mut buf))
}
fn is_symbol(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_symbol().is_match(cp.encode_utf8(&mut buf))
}
fn is_ws(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_ws().is_match(cp.encode_utf8(&mut buf))
}
fn is_letter_upper(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_letter_upper().is_match(cp.encode_utf8(&mut buf))
}
fn is_letter_lower(cp: char) -> bool {
    let mut buf = [0u8; 4];
    re_letter_lower().is_match(cp.encode_utf8(&mut buf))
}
/// ASCII punctuation, `[!-\/:-@\[-\`{-~]`: the 32 chars HuggingFace's
/// `is_ascii_punctuation` accepts. Shared by `punct_ascii_letters` and
/// `punctuation_contiguous`. Plain range comparisons: no regex needed.
fn is_ascii_punct(c: char) -> bool {
    matches!(c, '!'..='/' | ':'..='@' | '['..='`' | '{'..='~')
}

// ── Per-op matchers ────────────────────────────────────────────────────────
//
// Each returns the byte count consumed at position `i`, or 0 if no match.
// All indexing here is on Unicode scalar values (`char`), never raw UTF-16
// or byte counts split mid-codepoint: a byte-index slip here reproduces
// the piece-shattering bug this whole schema revision exists to fix.

fn match_literals_ci(patterns: &[String], text: &str, i: usize) -> usize {
    let rest = &text[i..];
    let rest_bytes = rest.as_bytes();
    let mut best = 0;
    for p in patterns {
        if p.len() <= best || rest.len() < p.len() {
            continue;
        }
        // Byte-wise ASCII case-fold compare. Avoids slicing `rest` at a
        // potentially-non-char-boundary when `p.len()` falls inside a
        // multibyte codepoint (CJK / emoji).
        let p_bytes = p.as_bytes();
        let mut ok = true;
        for k in 0..p.len() {
            let a = rest_bytes[k];
            let b = p_bytes[k];
            if a == b { continue; }
            if a.is_ascii_uppercase() && a + 32 == b { continue; }
            if a.is_ascii_lowercase() && a - 32 == b { continue; }
            ok = false;
            break;
        }
        if ok {
            best = p.len();
        }
    }
    best
}

fn match_literals(patterns: &[String], text: &str, i: usize) -> usize {
    let rest = &text[i..];
    let bytes = rest.as_bytes();
    let mut best = 0;
    for p in patterns {
        if p.len() <= best || rest.len() < p.len() {
            continue;
        }
        // Byte-wise compare avoids slicing rest at a non-char-boundary:
        // the patterns are ASCII so it's safe even when `rest` starts with
        // a multibyte codepoint like a CJK char. Without this, `&rest[..p.len()]`
        // panics when `p.len()` falls inside a multibyte codepoint.
        if bytes[..p.len()] == p.as_bytes()[..] {
            best = p.len();
        }
    }
    best
}

fn match_letters(
    lead_other: bool,
    lead_space: bool,
    lead_other_class: LeadOtherClass,
    body: LetterBody,
    text: &str,
    i: usize,
) -> usize {
    let rest = &text[i..];
    let mut chars = rest.char_indices().peekable();
    let mut p = 0usize;
    if lead_other {
        // `[^\r\n\p{L}\p{N}]?` (default `LeadOtherClass::LN`), or
        // `[^\r\n\p{L}\p{P}\p{S}]?` for `LeadOtherClass::LPS`: at most one
        // char that's none of the excluded classes.
        if let Some(&(_off, c)) = chars.peek() {
            let excluded = c != '\r'
                && c != '\n'
                && !is_letter(c)
                && match lead_other_class {
                    LeadOtherClass::LN => !is_number(c),
                    LeadOtherClass::LPS => !is_punct(c) && !is_symbol(c),
                };
            if excluded {
                p = c.len_utf8();
                chars.next();
            }
        }
    } else if lead_space {
        // ` ?`: at most one literal space.
        if let Some(&(_off, c)) = chars.peek() {
            if c == ' ' {
                p = c.len_utf8();
                chars.next();
            }
        }
    }
    // `\p{L}+` (default `LetterBody::L`), or `[\p{L}\p{M}]+` for
    // `LetterBody::LM`.
    let run_start = p;
    while let Some(&(_off, c)) = chars.peek() {
        let body_ok = match body {
            LetterBody::L => is_letter(c),
            LetterBody::LM => is_letter(c) || is_mark(c),
        };
        if !body_ok {
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
    trailing_chars: Option<&str>,
    charset: PunctCharset,
    text: &str,
    i: usize,
) -> usize {
    let bytes = text.as_bytes();
    let mut p = i;
    if lead_space && p < bytes.len() && bytes[p] == b' ' {
        p += 1;
    }
    // `[^\s\p{L}\p{N}]+` (default `PunctCharset::NotWsLN`), or
    // `[\p{P}\p{S}]+` for `PunctCharset::PS`.
    let run_start = p;
    for c in text[p..].chars() {
        let in_run = match charset {
            PunctCharset::NotWsLN => !is_ws(c) && !is_letter(c) && !is_number(c),
            PunctCharset::PS => is_punct(c) || is_symbol(c),
        };
        if !in_run {
            break;
        }
        p += c.len_utf8();
    }
    if p == run_start {
        return 0;
    }
    // Trailing chars: prefer explicit charset when set, otherwise legacy
    // boolean → `\r\n` only.
    if let Some(chars) = trailing_chars {
        loop {
            let Some(c) = text[p..].chars().next() else { break };
            if !chars.contains(c) {
                break;
            }
            p += c.len_utf8();
        }
    } else if trailing_newlines {
        while p < bytes.len() && (bytes[p] == b'\n' || bytes[p] == b'\r') {
            p += 1;
        }
    }
    p - i
}

/// `[!-\/:-@\[-\`{-~][A-Za-z]+`: one ASCII punctuation char, then 1+ ASCII
/// letters. ASCII punctuation and ASCII letters are always a single byte,
/// so plain byte-boundary indexing is safe here.
fn match_punct_ascii_letters(text: &str, i: usize) -> usize {
    let mut chars = text[i..].chars();
    let Some(c0) = chars.next() else { return 0 };
    if !is_ascii_punct(c0) {
        return 0;
    }
    let mut p = c0.len_utf8();
    let mut consumed_letter = false;
    for c in text[i + p..].chars() {
        if c.is_ascii_alphabetic() {
            p += c.len_utf8();
            consumed_letter = true;
        } else {
            break;
        }
    }
    if consumed_letter { p } else { 0 }
}

fn match_letters_cased(
    kind: CasedKind,
    lead_other: bool,
    trailing_ci: Option<&[String]>,
    text: &str,
    i: usize,
) -> usize {
    let mut p = i;
    if lead_other {
        if let Some(c) = text[p..].chars().next() {
            if c != '\r' && c != '\n' && !is_letter(c) && !is_number(c) {
                p += c.len_utf8();
            }
        }
    }

    // Greedy prefix run; record each step as a candidate suffix-start.
    // Lm/Lo/M are in BOTH sets so the longest overall match may need
    // to back off the prefix run to let the suffix consume them.
    let mut checkpoints: Vec<usize> = vec![p];
    while let Some(c) = text[p..].chars().next() {
        if !is_letter_upper(c) {
            break;
        }
        p += c.len_utf8();
        checkpoints.push(p);
    }

    let (min_prefix, min_suffix): (usize, usize) = match kind {
        CasedKind::Upper => (1, 0),
        CasedKind::Title => (0, 1),
    };

    // Try suffix from each checkpoint, longest-prefix first. First success wins.
    for k in (0..checkpoints.len()).rev() {
        if k < min_prefix {
            break;
        }
        let mut q = checkpoints[k];
        let mut suffix_count = 0usize;
        while let Some(c) = text[q..].chars().next() {
            if !is_letter_lower(c) {
                break;
            }
            q += c.len_utf8();
            suffix_count += 1;
        }
        if suffix_count < min_suffix {
            continue;
        }

        // Optional case-insensitive trailing-contractions match, longest wins.
        if let Some(patterns) = trailing_ci {
            let rest = &text[q..];
            let rest_bytes = rest.as_bytes();
            let mut best = 0usize;
            for pat in patterns {
                if pat.len() <= best || rest.len() < pat.len() {
                    continue;
                }
                let p_bytes = pat.as_bytes();
                let mut ok = true;
                for k in 0..pat.len() {
                    let a = rest_bytes[k];
                    let b = p_bytes[k];
                    if a == b {
                        continue;
                    }
                    if a.is_ascii_uppercase() && a + 32 == b {
                        continue;
                    }
                    if a.is_ascii_lowercase() && a - 32 == b {
                        continue;
                    }
                    ok = false;
                    break;
                }
                if ok {
                    best = pat.len();
                }
            }
            q += best;
        }

        return q - i;
    }
    0
}

fn match_newline_block(text: &str, i: usize) -> usize {
    // `\s*[\r\n]+`: greedy `\s*`, then back off until the trailing run is
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

// ── Alternation scanner (v1 whole-program loop, and the v2 `alternation`
//    stage) ────────────────────────────────────────────────────────────────

/// Try every op in `ops`, in priority order, at position `i`. Returns the
/// first non-empty match's span, or 0 if none match.
fn try_ops_at(ops: &[PreTokOp], text: &str, i: usize) -> usize {
    for op in ops {
        let span = match op {
            PreTokOp::LiteralsCi { patterns } => match_literals_ci(patterns, text, i),
            PreTokOp::Literals { patterns } => match_literals(patterns, text, i),
            PreTokOp::Letters { lead_other, lead_space, lead_other_class, body } => {
                match_letters(
                    lead_other.unwrap_or(false),
                    lead_space.unwrap_or(false),
                    lead_other_class.unwrap_or(LeadOtherClass::LN),
                    body.unwrap_or(LetterBody::L),
                    text,
                    i,
                )
            }
            PreTokOp::Numbers { max_run, lead_space } => {
                match_numbers(max_run.unwrap_or(0), lead_space.unwrap_or(false), text, i)
            }
            PreTokOp::PunctRun { lead_space, trailing_newlines, trailing_chars, charset } => {
                match_punct_run(
                    lead_space.unwrap_or(false),
                    trailing_newlines.unwrap_or(false),
                    trailing_chars.as_deref(),
                    charset.unwrap_or(PunctCharset::NotWsLN),
                    text,
                    i,
                )
            }
            PreTokOp::PunctAsciiLetters {} => match_punct_ascii_letters(text, i),
            PreTokOp::LettersCased { kind, lead_other, trailing_ci } => match_letters_cased(
                *kind,
                lead_other.unwrap_or(false),
                trailing_ci.as_deref(),
                text,
                i,
            ),
            PreTokOp::NewlineBlock {} => match_newline_block(text, i),
            PreTokOp::TrailingWs {} => match_trailing_ws(text, i),
            PreTokOp::WsRun {} => match_ws_run(text, i),
            PreTokOp::MetaspaceSplit { .. } => 0, // mixed programs unsupported
        };
        if span > 0 {
            return span;
        }
    }
    0
}

/// Try every op in `ops`, in priority order, at each cursor position;
/// consume the first non-empty match and advance. This is the whole v1
/// program's execution model, and one v2 `alternation` stage's execution
/// model, scoped to a single input piece rather than the whole original
/// text.
///
/// When no op matches at a position, this is `Split(..., Isolated)` gap
/// behavior: consume the maximal run of consecutive non-matching
/// positions as ONE piece, verbatim, rather than shattering it one
/// Unicode scalar at a time. For a GPT-2-family op list running directly
/// over raw text (v1 programs, and a v2 `alternation` stage that is the
/// program's only stage), this list is exhaustive over every Unicode
/// scalar value and the branch is unreachable. It becomes reachable, and
/// matters, once an earlier v2 stage has already stripped a character
/// class this alternation's ops were never meant to see. DeepSeek-V3's
/// third stage receives whole digit-run and CJK-run pieces from the two
/// stages before it, and its own ops have no digit or CJK branch at all.
/// Shattering such a piece one scalar at a time would turn a three-digit
/// piece "123" into three separate one-digit pieces instead of passing it
/// through untouched.
fn run_alternation_ops(ops: &[PreTokOp], text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let n = text.len();
    let mut i = 0usize;
    while i < n {
        let span = try_ops_at(ops, text, i);
        if span > 0 {
            out.push(text[i..i + span].to_string());
            i += span;
            continue;
        }
        let first_len = text[i..].chars().next().unwrap().len_utf8();
        let mut j = i + first_len;
        while j < n && try_ops_at(ops, text, j) == 0 {
            j += text[j..].chars().next().unwrap().len_utf8();
        }
        out.push(text[i..j].to_string());
        i = j;
    }
    out
}

// ── v2 stage executors ──────────────────────────────────────────────────────

fn stage_digits_isolate(mode: DigitsMode, max_run: u32, piece: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut num_buf = String::new();
    let mut num_count: u32 = 0;
    let max = if max_run == 0 { u32::MAX } else { max_run };
    for c in piece.chars() {
        if is_number(c) {
            if !buf.is_empty() {
                out.push(std::mem::take(&mut buf));
            }
            if mode == DigitsMode::Individual {
                out.push(c.to_string());
            } else {
                if num_count >= max {
                    out.push(std::mem::take(&mut num_buf));
                    num_count = 0;
                }
                num_buf.push(c);
                num_count += 1;
            }
        } else {
            if !num_buf.is_empty() {
                out.push(std::mem::take(&mut num_buf));
                num_count = 0;
            }
            buf.push(c);
        }
    }
    if !num_buf.is_empty() {
        out.push(num_buf);
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

/// Exact non-overlapping windows of 3 ASCII digits, scanned left to right.
/// Byte indexing is safe here: an ASCII byte (including every ASCII
/// digit) is always its own UTF-8 character, so a position where three
/// consecutive bytes are all ASCII digits is always a char boundary on
/// both ends, and the single-byte advance on a non-match never lands a
/// later digit-triple check on a split multibyte character.
fn stage_digit_triples_isolate(piece: &str) -> Vec<String> {
    let bytes = piece.as_bytes();
    let n = bytes.len();
    let mut out = Vec::new();
    let mut last = 0usize;
    let mut i = 0usize;
    while i + 3 <= n {
        if bytes[i].is_ascii_digit() && bytes[i + 1].is_ascii_digit() && bytes[i + 2].is_ascii_digit() {
            if i > last {
                out.push(piece[last..i].to_string());
            }
            out.push(piece[i..i + 3].to_string());
            i += 3;
            last = i;
        } else {
            i += 1;
        }
    }
    if last < n {
        out.push(piece[last..].to_string());
    }
    out
}

fn stage_punctuation_contiguous(piece: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut p_buf = String::new();
    for c in piece.chars() {
        if is_ascii_punct(c) || is_punct(c) {
            if !buf.is_empty() {
                out.push(std::mem::take(&mut buf));
            }
            p_buf.push(c);
        } else {
            if !p_buf.is_empty() {
                out.push(std::mem::take(&mut p_buf));
            }
            buf.push(c);
        }
    }
    if !p_buf.is_empty() {
        out.push(p_buf);
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

/// DeepSeek-V3's literal CJK ranges: U+4E00-U+9FA5 (its own bound, short of
/// the full CJK Unified Ideographs block at U+9FFF), Hiragana U+3040-U+309F,
/// Katakana U+30A0-U+30FF. Fixed literal code-point intervals: three
/// integer comparisons, no Unicode property table needed.
const CJK_RANGES: [(u32, u32); 3] = [(0x4E00, 0x9FA5), (0x3040, 0x309F), (0x30A0, 0x30FF)];

fn is_cjk(c: char) -> bool {
    let code = c as u32;
    CJK_RANGES.iter().any(|&(lo, hi)| code >= lo && code <= hi)
}

fn stage_cjk_isolate(piece: &str) -> Vec<String> {
    let indices: Vec<(usize, char)> = piece.char_indices().collect();
    let n = indices.len();
    let byte_len = piece.len();
    let mut out = Vec::new();
    let mut last = 0usize;
    let mut k = 0usize;
    while k < n {
        let (i, c) = indices[k];
        if is_cjk(c) {
            if i > last {
                out.push(piece[last..i].to_string());
            }
            let mut k2 = k + 1;
            while k2 < n && is_cjk(indices[k2].1) {
                k2 += 1;
            }
            let end = if k2 < n { indices[k2].0 } else { byte_len };
            out.push(piece[i..end].to_string());
            last = end;
            k = k2;
        } else {
            k += 1;
        }
    }
    if last < byte_len {
        out.push(piece[last..].to_string());
    }
    out
}

fn run_stage(stage: &PreTokStage, piece: &str) -> Vec<String> {
    match stage {
        PreTokStage::DigitsIsolate { mode, max_run } => {
            stage_digits_isolate(*mode, max_run.unwrap_or(0), piece)
        }
        PreTokStage::DigitTriplesIsolate {} => stage_digit_triples_isolate(piece),
        PreTokStage::PunctuationContiguous {} => stage_punctuation_contiguous(piece),
        PreTokStage::CjkIsolate {} => stage_cjk_isolate(piece),
        PreTokStage::Alternation { ops } => run_alternation_ops(ops, piece),
    }
}

// ── Interpreter entry point ─────────────────────────────────────────────────

/// Execute `program` against `text`, returning the same piece sequence
/// the model's real HuggingFace pre-tokenizer would have emitted.
///
/// A v1 program runs as a single alternation scan over the whole text
/// (with the single-op metaspace shortcut handled first). A v2 program
/// runs each stage over the piece list the stage before it produced,
/// mirroring HuggingFace's `Sequence` pre-tokenizer.
pub fn run_pretok_program(program: &PreTokProgram, text: &str) -> Vec<String> {
    match program {
        PreTokProgram::V1(v1) => {
            // Single-op metaspace shortcut.
            if v1.ops.len() == 1 {
                if let PreTokOp::MetaspaceSplit { prefix_first } = &v1.ops[0] {
                    return run_metaspace(prefix_first.unwrap_or(false), text);
                }
            }
            run_alternation_ops(&v1.ops, text)
        }
        PreTokProgram::V2(v2) => {
            let mut pieces: Vec<String> = vec![text.to_string()];
            for stage in &v2.stages {
                let mut next = Vec::with_capacity(pieces.len());
                for piece in &pieces {
                    next.extend(run_stage(stage, piece));
                }
                pieces = next;
            }
            pieces.retain(|p| !p.is_empty());
            pieces
        }
    }
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
        PreTokProgram::V1(PreTokProgramV1 {
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
                    lead_other_class: None,
                    body: None,
                },
                PreTokOp::Numbers {
                    max_run: None,
                    lead_space: None,
                },
                PreTokOp::PunctRun {
                    lead_space: Some(true),
                    trailing_newlines: Some(true),
                    trailing_chars: None,
                    charset: None,
                },
                PreTokOp::NewlineBlock {},
                PreTokOp::TrailingWs {},
                PreTokOp::WsRun {},
            ],
        })
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

    #[test]
    fn v1_program_rejects_gap_shattering() {
        // A deliberately non-exhaustive v1 op list: only letters. Any
        // non-letter run must come out as ONE piece, not one scalar per
        // character, confirming the alternation scanner's gap-absorption
        // fix applies to v1 as well as v2.
        let p = PreTokProgram::V1(PreTokProgramV1 {
            version: 1,
            ops: vec![PreTokOp::Letters {
                lead_other: None,
                lead_space: None,
                lead_other_class: None,
                body: None,
            }],
        });
        let out = run_pretok_program(&p, "ab12cd");
        assert_eq!(out, vec!["ab", "12", "cd"]);
    }

    #[test]
    fn unknown_version_fails_loudly() {
        let json = serde_json::json!({ "version": 3, "ops": [] });
        let err = serde_json::from_value::<PreTokProgram>(json).unwrap_err();
        assert!(err.to_string().contains("unsupported version 3"));
    }

    #[test]
    fn missing_version_fails_loudly() {
        let json = serde_json::json!({ "ops": [] });
        let err = serde_json::from_value::<PreTokProgram>(json).unwrap_err();
        assert!(err.to_string().contains("missing"));
    }

    #[test]
    fn smollm2_v2_program() {
        // Sequence[Digits(individual_digits=true), ByteLevel(use_regex=true)].
        let p = PreTokProgram::V2(PreTokProgramV2 {
            version: 2,
            stages: vec![
                PreTokStage::DigitsIsolate { mode: DigitsMode::Individual, max_run: None },
                PreTokStage::Alternation {
                    ops: vec![
                        PreTokOp::Literals {
                            patterns: vec![
                                "'s".into(), "'t".into(), "'re".into(), "'ve".into(),
                                "'m".into(), "'ll".into(), "'d".into(),
                            ],
                        },
                        PreTokOp::Letters {
                            lead_other: None,
                            lead_space: Some(true),
                            lead_other_class: None,
                            body: None,
                        },
                        PreTokOp::Numbers { max_run: None, lead_space: Some(true) },
                        PreTokOp::PunctRun {
                            lead_space: Some(true),
                            trailing_newlines: None,
                            trailing_chars: None,
                            charset: None,
                        },
                        PreTokOp::TrailingWs {},
                        PreTokOp::WsRun {},
                    ],
                },
            ],
        });
        // "a  1" -> digits_isolate isolates "1" first, leaving "a  " intact
        // as one piece for the alternation stage's own trailing_ws/ws_run.
        let out = run_pretok_program(&p, "a  1");
        assert_eq!(out, vec!["a", "  ", "1"]);
    }

    #[test]
    fn falcon_v2_program_digit_triples() {
        let p = PreTokProgram::V2(PreTokProgramV2 {
            version: 2,
            stages: vec![
                PreTokStage::DigitsIsolate { mode: DigitsMode::Grouped, max_run: None },
                PreTokStage::DigitTriplesIsolate {},
            ],
        });
        let out = run_pretok_program(&p, "12345");
        assert_eq!(out, vec!["123", "45"]);
    }

    #[test]
    fn deepseek_v3_v2_program_cjk_and_letters_body() {
        let p = PreTokProgram::V2(PreTokProgramV2 {
            version: 2,
            stages: vec![
                PreTokStage::DigitsIsolate { mode: DigitsMode::Grouped, max_run: Some(3) },
                PreTokStage::CjkIsolate {},
                PreTokStage::Alternation {
                    ops: vec![
                        PreTokOp::PunctAsciiLetters {},
                        PreTokOp::Letters {
                            lead_other: Some(true),
                            lead_space: None,
                            lead_other_class: Some(LeadOtherClass::LPS),
                            body: Some(LetterBody::LM),
                        },
                        PreTokOp::PunctRun {
                            lead_space: Some(true),
                            trailing_newlines: Some(true),
                            trailing_chars: None,
                            charset: Some(PunctCharset::PS),
                        },
                        PreTokOp::NewlineBlock {},
                        PreTokOp::TrailingWs {},
                        PreTokOp::WsRun {},
                    ],
                },
            ],
        });
        let out = run_pretok_program(&p, "日本語abc");
        assert_eq!(out, vec!["日本語", "abc"]);

        let out2 = run_pretok_program(&p, "12345");
        assert_eq!(out2, vec!["123", "45"]);

        // `'m` glued to identifier letters, as in `sys.platform == 'linux'`
        // truncated to just the trailing quote+letters, must come out as
        // one piece via `punct_ascii_letters`.
        let out3 = run_pretok_program(&p, "'m");
        assert_eq!(out3, vec!["'m"]);
    }
}
