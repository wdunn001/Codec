// SPDX-License-Identifier: MIT
//! `TokenizerMap`: the per-model dialect record. Maps are
//! content-addressed (sha256) and immutable.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Errors raised by [`TokenizerMap`] parsing/validation.
#[derive(Debug, thiserror::Error)]
pub enum TokenizerMapError {
    #[error("TokenizerMap validation failed: {0}")]
    Validation(String),
    #[error("TokenizerMap parse failed: {0}")]
    Parse(#[from] serde_json::Error),
}

/// A per-model tokenizer dialect: the data needed to encode text into
/// token IDs and decode IDs back to text.
///
/// Maps are immutable once published; a new model version publishes a new
/// map at a new URL with a new sha256 hash.
///
/// **Schema v2:** [`TokenizerMap::vocab`] is the raw HuggingFace
/// `tokenizer.json` form (byte-level GPT-2-encoded chars or `▁`-prefixed
/// metaspace strings). [`TokenizerMap::tokens`] is the legacy v1 field,
/// kept for backwards compatibility: the [`crate::Detokenizer`] reads
/// from whichever is present.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenizerMap {
    /// Stable, globally unique tokenizer identifier (e.g. `"qwen/qwen2"`).
    #[serde(default)]
    pub id: String,
    /// Schema version. `"2"` for v2 maps; `"1"` for legacy v1.
    #[serde(default = "default_version")]
    pub version: String,
    /// Total number of token IDs in the vocabulary.
    #[serde(default, rename = "vocab_size")]
    pub vocab_size: i64,
    /// Vocabulary as `{ raw_token_text → id }`. v2 schema field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vocab: Option<HashMap<String, u32>>,
    /// Legacy v1 vocabulary as `{ id_string → decoded_text }`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<HashMap<String, String>>,
    /// Encoder family: `"byte_level"`, `"metaspace"`, or omitted (identity).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder: Option<String>,
    /// BPE merges in priority order (lower index = higher priority).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merges: Option<Vec<String>>,
    /// Pre-tokenizer regex pattern. Required for byte_level BPE when
    /// `pre_tokenizer_program` is absent.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "pre_tokenizer_pattern")]
    pub pre_tokenizer_pattern: Option<String>,
    /// Compiled pre-tokenizer program. Preferred over `pre_tokenizer_pattern`
    /// when present: the runtime executes the ops directly with no regex
    /// engine, which unblocks the GPT-2-family maps whose `(?i:...)` and
    /// `(?!\S)` syntax the `regex` crate doesn't support. See
    /// [`crate::pretok_program::PreTokProgram`] and
    /// [`spec/PRETOKENIZER_PROGRAM.md`](https://github.com/wdunn001/Codec/blob/main/spec/PRETOKENIZER_PROGRAM.md).
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "pre_tokenizer_program")]
    pub pre_tokenizer_program: Option<crate::pretok_program::PreTokProgram>,
    /// First ID in the byte-fallback range (inclusive). SentencePiece only.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "byte_fallback_start")]
    pub byte_fallback_start: Option<i64>,
    /// Last ID in the byte-fallback range (inclusive). SentencePiece only.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "byte_fallback_end")]
    pub byte_fallback_end: Option<i64>,
    /// Named special tokens. Skipped during text rendering by default.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "special_tokens")]
    pub special_tokens: Option<HashMap<String, u32>>,
    /// Per-model tool-calling convention. Optional; populated by
    /// `@codecai/maps-cli` when it detects a known chat-template signature.
    /// Absent on maps generated before this block existed; readers MUST treat
    /// absence as "convention not declared" rather than as an error. See
    /// `spec/PROTOCOL.md` § "Tool-call calling conventions in the map".
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "tool_calling")]
    pub tool_calling: Option<ToolCallingBlock>,
    /// ISO 8601 publish timestamp. Informational.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "published_at")]
    pub published_at: Option<String>,
}

/// Per-model tool-calling convention block carried inside a [`TokenizerMap`].
/// Each `convention` value pins a specific argument layout, marker placement,
/// and result framing: see `spec/PROTOCOL.md` § "Tool-call calling
/// conventions in the map" for the normative table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallingBlock {
    /// Closed enum naming the convention. New values are additive point
    /// releases of the schema; per-deployment extension is not supported.
    /// Use `"custom"` to opt out of the registry.
    pub convention: ToolCallingConvention,
    /// Start/end marker token names. Both names MUST appear as keys in the
    /// parent map's `special_tokens` table.
    pub markers: ToolCallingMarkers,
    /// How tool-call arguments are packed inside the marker pair on the
    /// engine's output side.
    pub args_format: ToolCallingArgsFormat,
    /// How tool results come back into the model's input.
    pub result_format: ToolCallingResultFormat,
}

/// Start/end marker token names for a tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallingMarkers {
    pub start: String,
    pub end: String,
}

/// Closed enum of tool-calling conventions. See `spec/PROTOCOL.md` for the
/// normative behaviour pinned to each value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallingConvention {
    Llama3,
    Qwen25,
    Phi4,
    MistralNemo,
    DeepseekV3,
    DeepseekR1,
    /// Opt-out; layout is implementer-supplied and not pinned by the spec.
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallingArgsFormat {
    /// Single JSON object, e.g. `{"location":"NYC"}`.
    Json,
    /// Python-style call expression. Llama-3 with `<|python_tag|>` uses this.
    PythonArgs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallingResultFormat {
    /// Opaque UTF-8 text returned verbatim.
    Text,
    /// JSON value the model parses.
    Json,
}

fn default_version() -> String {
    "2".to_string()
}

impl TokenizerMap {
    /// Parse a `TokenizerMap` from JSON bytes and validate it.
    pub fn from_json(json: &[u8]) -> Result<Self, TokenizerMapError> {
        let map: TokenizerMap = serde_json::from_slice(json)?;
        Self::validate(&map)?;
        Ok(map)
    }

    /// Parse from a JSON string and validate.
    pub fn from_json_str(json: &str) -> Result<Self, TokenizerMapError> {
        Self::from_json(json.as_bytes())
    }

    /// Verify that `bytes` hashes to `expected` (a hex string, optionally
    /// prefixed with `sha256:`). Returns the actual hex digest.
    pub fn verify_sha256(bytes: &[u8], expected: &str) -> Result<String, (String, String)> {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let actual = hex::encode(hasher.finalize());
        let want = parse_hash(expected);
        if actual.eq_ignore_ascii_case(&want) {
            Ok(actual)
        } else {
            Err((want, actual))
        }
    }

    /// Throws on schema violations.
    pub fn validate(map: &Self) -> Result<(), TokenizerMapError> {
        if map.id.is_empty() {
            return Err(TokenizerMapError::Validation(
                "id must be a non-empty string".into(),
            ));
        }
        if map.version.is_empty() {
            return Err(TokenizerMapError::Validation(
                "version must be a non-empty string".into(),
            ));
        }
        if map.vocab_size < 1 {
            return Err(TokenizerMapError::Validation(
                "vocab_size must be a positive integer".into(),
            ));
        }
        let has_vocab = map.vocab.as_ref().is_some_and(|v| !v.is_empty());
        let has_tokens = map.tokens.as_ref().is_some_and(|v| !v.is_empty());
        if !has_vocab && !has_tokens {
            return Err(TokenizerMapError::Validation(
                "one of `vocab` (v2) or `tokens` (v1) is required".into(),
            ));
        }
        match map.encoder.as_deref() {
            None | Some("byte_level") | Some("metaspace") => {}
            Some(other) => {
                return Err(TokenizerMapError::Validation(format!(
                    "encoder must be \"byte_level\" or \"metaspace\" if present, got \"{other}\""
                )));
            }
        }
        if map.byte_fallback_start.is_some() != map.byte_fallback_end.is_some() {
            return Err(TokenizerMapError::Validation(
                "byte_fallback_start and byte_fallback_end must both be set or both omitted"
                    .into(),
            ));
        }
        if let Some(tc) = &map.tool_calling {
            if tc.markers.start.is_empty() || tc.markers.end.is_empty() {
                return Err(TokenizerMapError::Validation(
                    "tool_calling.markers.start/.end must both be non-empty strings".into(),
                ));
            }
            // The spec requires both marker names to exist as keys in special_tokens.
            let st = map.special_tokens.as_ref();
            let in_st = |name: &str| st.is_some_and(|m| m.contains_key(name));
            if !in_st(&tc.markers.start) || !in_st(&tc.markers.end) {
                return Err(TokenizerMapError::Validation(format!(
                    "tool_calling.markers.start (\"{}\") and .end (\"{}\") must both exist as keys in special_tokens",
                    tc.markers.start, tc.markers.end,
                )));
            }
        }
        Ok(())
    }
}

/// Strip a leading `sha256:` prefix if present and lowercase the result.
pub(crate) fn parse_hash(hash: &str) -> String {
    if let Some((algo, hex)) = hash.split_once(':') {
        if !algo.eq_ignore_ascii_case("sha256") {
            // Match the .NET behavior: caller will get a mismatch if algo is wrong.
            // We still lowercase whatever follows.
        }
        hex.to_ascii_lowercase()
    } else {
        hash.to_ascii_lowercase()
    }
}
