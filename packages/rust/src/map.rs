// SPDX-License-Identifier: MIT
//! `TokenizerMap` — the per-model dialect record. Maps are
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

/// A per-model tokenizer dialect — the data needed to encode text into
/// token IDs and decode IDs back to text.
///
/// Maps are immutable once published; a new model version publishes a new
/// map at a new URL with a new sha256 hash.
///
/// **Schema v2:** [`TokenizerMap::vocab`] is the raw HuggingFace
/// `tokenizer.json` form (byte-level GPT-2-encoded chars or `▁`-prefixed
/// metaspace strings). [`TokenizerMap::tokens`] is the legacy v1 field,
/// kept for backwards compatibility — the [`crate::Detokenizer`] reads
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
    /// Pre-tokenizer regex pattern. Required for byte_level BPE.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "pre_tokenizer_pattern")]
    pub pre_tokenizer_pattern: Option<String>,
    /// First ID in the byte-fallback range (inclusive). SentencePiece only.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "byte_fallback_start")]
    pub byte_fallback_start: Option<i64>,
    /// Last ID in the byte-fallback range (inclusive). SentencePiece only.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "byte_fallback_end")]
    pub byte_fallback_end: Option<i64>,
    /// Named special tokens. Skipped during text rendering by default.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "special_tokens")]
    pub special_tokens: Option<HashMap<String, u32>>,
    /// ISO 8601 publish timestamp. Informational.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "published_at")]
    pub published_at: Option<String>,
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
