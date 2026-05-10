// SPDX-License-Identifier: MIT
//! Safety-policy descriptor loading, validation, and discovery.
//!
//! Rust twin of `@codecai/web`'s `safety_policy.ts` (slice 1) and
//! `codecai.safety_policy` (slice 11). Same shapes, same errors, same
//! canonical JSON form for hashing — a descriptor that hashes to
//! `sha256:abc…` in any client hashes to the identical digest here.
//!
//! Used by clients that received `safety_policy_id` + `safety_policy_hash`
//! in `READY` and want to fetch and surface what the server is
//! enforcing. The descriptor is the *sanitized*, publishable shape —
//! categories, actions, classifier family, summary stats — never the
//! operator's internal banned token IDs / classifier thresholds /
//! regex patterns.
//!
//! Discovery follows the existing tokenizer-map convention:
//!
//!   - `<origin>/.well-known/codec/policies/<id>.json`         (mutable)
//!   - `<origin>/.well-known/codec/policies/sha256/<hex>.json` (immutable)
//!
//! A client that received a hash in `READY` SHOULD prefer the
//! content-addressed sibling — it's provably immutable and skips the
//! mutable indirection.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const POLICY_WELL_KNOWN_BASE: &str = "/.well-known/codec/policies";

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CategoryAction {
    Stop,
    Redact,
    Regenerate,
    Flag,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClassifierHost {
    Server,
    Client,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineFeature {
    LogitsProcessor,
    HiddenStates,
    SamplingChain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Category {
    pub name: String,
    pub action: CategoryAction,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassifierBlock {
    pub family: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub host: Option<ClassifierHost>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub requires_engine_features: Option<Vec<EngineFeature>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RulesSummary {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub banned_token_id_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub regex_pattern_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub grammar_constraint_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub multi_token_pattern_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ClientHooksBlock {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub prefilter_categories: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub client_classifier_family: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PublisherBlock {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub contact: Option<String>,
}

/// The sanitized, publishable safety-policy descriptor.
///
/// Matches `spec/safety-policy.schema.json` v1. Field order mirrors the
/// TS / Python clients so canonical JSON output is byte-identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafetyPolicyDescriptor {
    pub id: String,
    pub version: String,
    pub tokenizers: Vec<String>,
    pub categories: Vec<Category>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub category_registry: Option<String>,
    pub classifier: ClassifierBlock,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub rules_summary: Option<RulesSummary>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub client_hooks: Option<ClientHooksBlock>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub publisher: Option<PublisherBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafetyPolicyPointer {
    pub id: String,
    pub url: String,
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub published_at: Option<String>,
}

// ── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SafetyPolicyError {
    #[error("SafetyPolicyDescriptor validation failed: {0}")]
    Validation(String),

    #[error("SafetyPolicyDescriptor parse failed: {0}")]
    Parse(#[from] serde_json::Error),

    #[error("SafetyPolicyDescriptor hash mismatch.\n  expected: {expected}\n  actual:   {actual}")]
    HashMismatch { expected: String, actual: String },

    #[error("Invalid policy id {id:?}: {reason}")]
    InvalidId { id: String, reason: &'static str },

    #[error("Invalid policy hash hex: must be 64-char lowercase hex (got {got:?})")]
    InvalidHashHex { got: String },

    #[error("Pointer id {got:?} does not match requested id {expected:?}")]
    PointerIdMismatch { got: String, expected: String },

    #[error("Pointer url must be http(s): got {got:?}")]
    PointerBadUrl { got: String },

    #[error("Pointer hash must be sha256:<64 hex chars>: got {got:?}")]
    PointerBadHash { got: String },

    #[error("Inline descriptor id {got:?} does not match requested id {expected:?}")]
    InlineIdMismatch { got: String, expected: String },

    #[cfg(feature = "http")]
    #[error("No safety-policy document at {url} (HTTP {status})")]
    NotFound { url: String, status: u16 },

    #[cfg(feature = "http")]
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
}

// ── Validation ──────────────────────────────────────────────────────────────
//
// Hand-written shape check matching the TS / Python validators. Run
// against the parsed serde_json::Value before attempting to deserialize
// so we get clean error messages rather than serde's terser ones.

/// Documented charset spec mirrored across all client validators.
/// Kept as a string constant so error messages cite the same regex
/// the TS / Python clients reference.
const CATEGORY_NAME_RE: &str = r"^[a-z0-9_-]+$";

fn category_name_ok(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn id_ok(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' || c == '.' || c == '/')
        && !s.contains("..")
        && !s.starts_with('/')
        && !s.ends_with('/')
}

fn hex64_lower_ok(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit() && (!c.is_ascii_alphabetic() || c.is_ascii_lowercase()))
}

/// Validate a parsed JSON value as a SafetyPolicyDescriptor candidate.
///
/// Use before [`SafetyPolicyDescriptor::from_json`] when you want
/// human-readable error messages; otherwise serde's deserializer will
/// surface its own (terser) errors automatically.
pub fn validate_safety_policy(value: &serde_json::Value) -> Result<(), SafetyPolicyError> {
    let v = value
        .as_object()
        .ok_or_else(|| SafetyPolicyError::Validation("not an object".into()))?;

    let id = v.get("id").and_then(|x| x.as_str()).filter(|s| !s.is_empty())
        .ok_or_else(|| SafetyPolicyError::Validation("id must be a non-empty string".into()))?;
    let _ = id;

    v.get("version").and_then(|x| x.as_str())
        .ok_or_else(|| SafetyPolicyError::Validation("version must be a string".into()))?;

    let tokenizers = v.get("tokenizers").and_then(|x| x.as_array())
        .filter(|a| !a.is_empty())
        .ok_or_else(|| SafetyPolicyError::Validation(
            "tokenizers must be a non-empty array of tokenizer ids".into(),
        ))?;
    for t in tokenizers {
        if !t.is_string() {
            return Err(SafetyPolicyError::Validation(
                "tokenizers entries must be strings".into(),
            ));
        }
    }

    let categories = v.get("categories").and_then(|x| x.as_array())
        .filter(|a| !a.is_empty())
        .ok_or_else(|| SafetyPolicyError::Validation(
            "categories must be a non-empty array".into(),
        ))?;
    for c in categories {
        let cat = c.as_object().ok_or_else(|| {
            SafetyPolicyError::Validation("category entry must be an object".into())
        })?;
        let name = cat.get("name").and_then(|x| x.as_str()).ok_or_else(|| {
            SafetyPolicyError::Validation("category.name must be a string".into())
        })?;
        if !category_name_ok(name) {
            return Err(SafetyPolicyError::Validation(format!(
                "category.name must match {CATEGORY_NAME_RE} (got {name:?})"
            )));
        }
        let action = cat.get("action").and_then(|x| x.as_str()).ok_or_else(|| {
            SafetyPolicyError::Validation(format!(
                "category.action for {name:?} must be one of stop|redact|regenerate|flag"
            ))
        })?;
        if !matches!(action, "stop" | "redact" | "regenerate" | "flag") {
            return Err(SafetyPolicyError::Validation(format!(
                "category.action for {name:?} must be one of stop|redact|regenerate|flag"
            )));
        }
        if let Some(desc) = cat.get("description") {
            if !desc.is_string() && !desc.is_null() {
                return Err(SafetyPolicyError::Validation(format!(
                    "category.description for {name:?} must be a string when present"
                )));
            }
        }
    }

    let cls = v.get("classifier").and_then(|x| x.as_object()).ok_or_else(|| {
        SafetyPolicyError::Validation("classifier must be an object".into())
    })?;
    let family = cls.get("family").and_then(|x| x.as_str()).filter(|s| !s.is_empty())
        .ok_or_else(|| SafetyPolicyError::Validation(
            "classifier.family must be a non-empty string".into(),
        ))?;
    let _ = family;
    if let Some(host) = cls.get("host") {
        if !host.is_null() {
            let h = host.as_str().ok_or_else(|| {
                SafetyPolicyError::Validation(format!(
                    "classifier.host must be one of server|client|both (got {host})"
                ))
            })?;
            if !matches!(h, "server" | "client" | "both") {
                return Err(SafetyPolicyError::Validation(format!(
                    "classifier.host must be one of server|client|both (got {h:?})"
                )));
            }
        }
    }
    if let Some(feats) = cls.get("requires_engine_features") {
        if !feats.is_null() {
            let arr = feats.as_array().ok_or_else(|| {
                SafetyPolicyError::Validation(
                    "classifier.requires_engine_features must be an array".into(),
                )
            })?;
            for f in arr {
                let s = f.as_str().ok_or_else(|| {
                    SafetyPolicyError::Validation(
                        "classifier.requires_engine_features entry must be a string".into(),
                    )
                })?;
                if !matches!(s, "logits_processor" | "hidden_states" | "sampling_chain") {
                    return Err(SafetyPolicyError::Validation(format!(
                        "classifier.requires_engine_features entry must be one of \
                         logits_processor|hidden_states|sampling_chain (got {s:?})"
                    )));
                }
            }
        }
    }

    if let Some(rs) = v.get("rules_summary") {
        if !rs.is_null() {
            let m = rs.as_object().ok_or_else(|| {
                SafetyPolicyError::Validation("rules_summary must be an object when present".into())
            })?;
            for k in [
                "banned_token_id_count",
                "regex_pattern_count",
                "grammar_constraint_count",
                "multi_token_pattern_count",
            ] {
                if let Some(val) = m.get(k) {
                    if !val.is_null() && !val.as_u64().is_some() {
                        return Err(SafetyPolicyError::Validation(format!(
                            "rules_summary.{k} must be a non-negative integer when present"
                        )));
                    }
                }
            }
        }
    }

    Ok(())
}

// ── Builder ─────────────────────────────────────────────────────────────────

impl SafetyPolicyDescriptor {
    /// Parse + validate a JSON byte slice into a SafetyPolicyDescriptor.
    ///
    /// Validates first via [`validate_safety_policy`] for clean error
    /// messages, then deserializes via serde. Rejects shapes the
    /// validator accepts but serde would silently coerce (e.g. extra
    /// fields are ignored on the rust side which is the desired
    /// forward-compat behavior).
    pub fn from_json(bytes: &[u8]) -> Result<Self, SafetyPolicyError> {
        let parsed: serde_json::Value = serde_json::from_slice(bytes)?;
        validate_safety_policy(&parsed)?;
        let descriptor: SafetyPolicyDescriptor = serde_json::from_value(parsed)?;
        Ok(descriptor)
    }

    /// Canonical JSON serialization for hashing + well-known publish.
    ///
    /// Matches the TS / Python / supervisor format: 2-space indent +
    /// trailing newline. Fields with `None` values are omitted (via
    /// serde's `skip_serializing_if`) so the canonical bytes match
    /// across stacks.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, SafetyPolicyError> {
        let mut buf = Vec::new();
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
        let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
        self.serialize(&mut ser)?;
        buf.push(b'\n');
        Ok(buf)
    }

    /// Canonical sha256 hash of a descriptor.
    ///
    /// Returns `sha256:<64 hex chars>` matching what
    /// `codecai-maps policies hash` emits and what servers should
    /// publish in `READY.safety_policy_hash`.
    pub fn hash(&self) -> Result<String, SafetyPolicyError> {
        let bytes = self.canonical_bytes()?;
        let mut h = Sha256::new();
        h.update(&bytes);
        Ok(format!("sha256:{:x}", h.finalize()))
    }
}

fn parse_hash(hash: &str) -> Result<String, SafetyPolicyError> {
    if let Some(rest) = hash.strip_prefix("sha256:") {
        let lower = rest.to_ascii_lowercase();
        if !hex64_lower_ok(&lower) {
            return Err(SafetyPolicyError::InvalidHashHex { got: hash.to_string() });
        }
        Ok(lower)
    } else {
        let lower = hash.to_ascii_lowercase();
        if !hex64_lower_ok(&lower) {
            return Err(SafetyPolicyError::InvalidHashHex { got: hash.to_string() });
        }
        Ok(lower)
    }
}

// ── URL builders ────────────────────────────────────────────────────────────

fn strip_trailing_slash(s: &str) -> &str {
    s.strip_suffix('/').unwrap_or(s)
}

/// Per-policy URL by mutable id (e.g. `acme/strict-v3`).
pub fn well_known_policy_url(origin: &str, policy_id: &str) -> Result<String, SafetyPolicyError> {
    if !id_ok(policy_id) {
        return Err(SafetyPolicyError::InvalidId {
            id: policy_id.to_string(),
            reason: "must match [a-z0-9._/-]+ and contain no traversal",
        });
    }
    Ok(format!(
        "{}{POLICY_WELL_KNOWN_BASE}/{}.json",
        strip_trailing_slash(origin),
        policy_id,
    ))
}

/// Content-addressed URL by sha256 hex (no `sha256:` prefix).
pub fn well_known_policy_hash_url(origin: &str, hash_hex: &str) -> Result<String, SafetyPolicyError> {
    let lower = hash_hex.to_ascii_lowercase();
    if !hex64_lower_ok(&lower) {
        return Err(SafetyPolicyError::InvalidHashHex { got: hash_hex.to_string() });
    }
    Ok(format!(
        "{}{POLICY_WELL_KNOWN_BASE}/sha256/{}.json",
        strip_trailing_slash(origin),
        lower,
    ))
}

// ── Pointer detection ───────────────────────────────────────────────────────

fn is_pointer_shape(value: &serde_json::Value) -> bool {
    let Some(obj) = value.as_object() else { return false; };
    obj.get("id").is_some_and(|v| v.is_string())
        && obj.get("url").is_some_and(|v| v.is_string())
        && obj.get("hash").is_some_and(|v| v.is_string())
        // Inline descriptors always carry `categories`; pointers never do.
        && !obj.contains_key("categories")
}

fn validate_pointer(
    value: &serde_json::Value,
    expected_id: &str,
) -> Result<SafetyPolicyPointer, SafetyPolicyError> {
    let pointer: SafetyPolicyPointer = serde_json::from_value(value.clone())?;
    if pointer.id != expected_id {
        return Err(SafetyPolicyError::PointerIdMismatch {
            got: pointer.id,
            expected: expected_id.to_string(),
        });
    }
    if !(pointer.url.starts_with("https://") || pointer.url.starts_with("http://")) {
        return Err(SafetyPolicyError::PointerBadUrl { got: pointer.url });
    }
    if !pointer.hash.starts_with("sha256:") || !hex64_lower_ok(&pointer.hash[7..].to_ascii_lowercase()) {
        return Err(SafetyPolicyError::PointerBadHash { got: pointer.hash });
    }
    Ok(pointer)
}

// ── HTTP loader + discovery (gated on `http` feature) ───────────────────────

#[cfg(feature = "http")]
mod http_impl {
    use super::*;

    fn build_async_client() -> Result<reqwest::Client, reqwest::Error> {
        reqwest::Client::builder()
            .user_agent("codec-rs/0.1")
            .gzip(true)
            .brotli(true)
            .build()
    }

    /// Fetch + verify + cache a safety-policy descriptor.
    ///
    /// If `hash` is provided, the fetched bytes MUST hash to it
    /// (returns [`SafetyPolicyError::HashMismatch`] otherwise).
    pub async fn load_safety_policy(
        url: &str,
        hash: Option<&str>,
    ) -> Result<SafetyPolicyDescriptor, SafetyPolicyError> {
        let client = build_async_client()?;
        let resp = client.get(url).send().await?.error_for_status()?;
        let bytes = resp.bytes().await?;

        if let Some(expected) = hash {
            let want = parse_hash(expected)?;
            let mut h = Sha256::new();
            h.update(&bytes);
            let actual = format!("{:x}", h.finalize());
            if actual != want {
                return Err(SafetyPolicyError::HashMismatch { expected: want, actual });
            }
        }

        SafetyPolicyDescriptor::from_json(&bytes)
    }

    /// Resolve a safety-policy descriptor via `.well-known/codec/policies/`.
    ///
    /// If `hash` is provided, fetches the immutable content-addressed
    /// sibling at `<origin>/.well-known/codec/policies/sha256/<hex>.json`
    /// and verifies the bytes match. Otherwise fetches the mutable
    /// per-id document and follows a pointer if present.
    pub async fn discover_safety_policy(
        origin: &str,
        id: &str,
        hash: Option<&str>,
    ) -> Result<SafetyPolicyDescriptor, SafetyPolicyError> {
        let client = build_async_client()?;

        if let Some(h) = hash {
            let hash_hex = parse_hash(h)?;
            let url = well_known_policy_hash_url(origin, &hash_hex)?;
            let resp = client.get(&url).send().await?;
            if resp.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(SafetyPolicyError::NotFound {
                    url,
                    status: resp.status().as_u16(),
                });
            }
            let resp = resp.error_for_status()?;
            let bytes = resp.bytes().await?;
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let actual = format!("{:x}", hasher.finalize());
            if actual != hash_hex {
                return Err(SafetyPolicyError::HashMismatch {
                    expected: hash_hex,
                    actual,
                });
            }
            let parsed: serde_json::Value = serde_json::from_slice(&bytes)?;
            if is_pointer_shape(&parsed) {
                let pointer = validate_pointer(&parsed, id)?;
                return load_safety_policy(&pointer.url, Some(&pointer.hash)).await;
            }
            let descriptor = SafetyPolicyDescriptor::from_json(&bytes)?;
            if descriptor.id != id {
                return Err(SafetyPolicyError::InlineIdMismatch {
                    got: descriptor.id,
                    expected: id.to_string(),
                });
            }
            return Ok(descriptor);
        }

        let url = well_known_policy_url(origin, id)?;
        let resp = client.get(&url).send().await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(SafetyPolicyError::NotFound {
                url,
                status: resp.status().as_u16(),
            });
        }
        let resp = resp.error_for_status()?;
        let bytes = resp.bytes().await?;
        let parsed: serde_json::Value = serde_json::from_slice(&bytes)?;
        if is_pointer_shape(&parsed) {
            let pointer = validate_pointer(&parsed, id)?;
            return load_safety_policy(&pointer.url, Some(&pointer.hash)).await;
        }
        let descriptor = SafetyPolicyDescriptor::from_json(&bytes)?;
        if descriptor.id != id {
            return Err(SafetyPolicyError::InlineIdMismatch {
                got: descriptor.id,
                expected: id.to_string(),
            });
        }
        Ok(descriptor)
    }
}

#[cfg(feature = "http")]
pub use http_impl::{discover_safety_policy, load_safety_policy};

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_json() -> serde_json::Value {
        serde_json::json!({
            "id": "acme/strict-v3",
            "version": "1",
            "tokenizers": ["meta-llama/llama-3"],
            "categories": [
                {"name": "secrets", "action": "stop"},
                {"name": "pii", "action": "redact", "description": "Email and phone."},
            ],
            "classifier": {
                "family": "llama-guard-3-1b",
                "host": "server",
                "requires_engine_features": ["logits_processor", "sampling_chain"],
            },
            "rules_summary": {
                "banned_token_id_count": 4128,
                "regex_pattern_count": 47,
            },
            "client_hooks": {
                "prefilter_categories": ["secrets", "pii"],
                "client_classifier_family": "prompt-guard-86m",
            },
            "published_at": "2026-05-09T00:00:00Z",
        })
    }

    fn valid_descriptor() -> SafetyPolicyDescriptor {
        let bytes = serde_json::to_vec(&valid_json()).unwrap();
        SafetyPolicyDescriptor::from_json(&bytes).unwrap()
    }

    // ── Validation ─────────────────────────────────────────────────────────

    #[test]
    fn validate_accepts_minimal_valid_descriptor() {
        validate_safety_policy(&valid_json()).unwrap();
    }

    #[test]
    fn validate_rejects_missing_required_fields() {
        validate_safety_policy(&serde_json::json!({})).unwrap_err();
        let mut bad = valid_json();
        bad["id"] = serde_json::Value::String(String::new());
        validate_safety_policy(&bad).unwrap_err();
        let mut bad = valid_json();
        bad["tokenizers"] = serde_json::json!([]);
        validate_safety_policy(&bad).unwrap_err();
        let mut bad = valid_json();
        bad["categories"] = serde_json::json!([]);
        validate_safety_policy(&bad).unwrap_err();
    }

    #[test]
    fn validate_rejects_bad_category_name() {
        let mut bad = valid_json();
        bad["categories"] = serde_json::json!([{"name": "BadCaps", "action": "stop"}]);
        validate_safety_policy(&bad).unwrap_err();
    }

    #[test]
    fn validate_rejects_unknown_action() {
        let mut bad = valid_json();
        bad["categories"] = serde_json::json!([{"name": "secrets", "action": "banhammer"}]);
        validate_safety_policy(&bad).unwrap_err();
    }

    #[test]
    fn validate_rejects_unknown_engine_features() {
        let mut bad = valid_json();
        bad["classifier"]["requires_engine_features"] = serde_json::json!(["weather_api"]);
        validate_safety_policy(&bad).unwrap_err();
    }

    // ── Hash determinism ───────────────────────────────────────────────────

    #[test]
    fn hash_is_deterministic_for_identical_input() {
        let d = valid_descriptor();
        let a = d.hash().unwrap();
        let b = d.hash().unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("sha256:"));
        assert_eq!(a.len() - "sha256:".len(), 64);
    }

    #[test]
    fn hash_differs_when_category_action_changes() {
        let d1 = valid_descriptor();
        let mut json2 = valid_json();
        json2["categories"][0]["action"] = serde_json::Value::String("flag".into());
        let bytes = serde_json::to_vec(&json2).unwrap();
        let d2 = SafetyPolicyDescriptor::from_json(&bytes).unwrap();
        assert_ne!(d1.hash().unwrap(), d2.hash().unwrap());
    }

    #[test]
    fn canonical_bytes_match_2_space_indent_with_trailing_newline() {
        let d = valid_descriptor();
        let raw = d.canonical_bytes().unwrap();
        let text = std::str::from_utf8(&raw).unwrap();
        assert!(text.ends_with('\n'));
        // pretty-printed: contains a newline-then-two-spaces indent.
        assert!(text.contains("\n  "));
        // Round-trips through serde.
        let _: serde_json::Value = serde_json::from_str(text).unwrap();
    }

    // ── URL builders ───────────────────────────────────────────────────────

    #[test]
    fn well_known_policy_url_preserves_slashes_and_strips_trailing() {
        let url = well_known_policy_url("https://acme.example/", "acme/strict-v3").unwrap();
        assert_eq!(
            url,
            "https://acme.example/.well-known/codec/policies/acme/strict-v3.json"
        );
    }

    #[test]
    fn well_known_policy_url_rejects_traversal() {
        well_known_policy_url("https://acme.example", "../etc").unwrap_err();
        well_known_policy_url("https://acme.example", "/abs").unwrap_err();
        well_known_policy_url("https://acme.example", "trailing/").unwrap_err();
    }

    #[test]
    fn well_known_policy_url_rejects_bad_charset() {
        well_known_policy_url("https://acme.example", "Acme/Strict").unwrap_err();
    }

    #[test]
    fn well_known_policy_hash_url_uses_sha256_path() {
        let hex = "a".repeat(64);
        let url = well_known_policy_hash_url("https://acme.example", &hex).unwrap();
        assert_eq!(
            url,
            format!("https://acme.example/.well-known/codec/policies/sha256/{hex}.json")
        );
    }

    #[test]
    fn well_known_policy_hash_url_rejects_malformed_hex() {
        well_known_policy_hash_url("https://acme.example", "not-hex").unwrap_err();
    }

    // ── Round-trip ─────────────────────────────────────────────────────────

    #[test]
    fn descriptor_round_trip_canonical_bytes_to_json() {
        let d = valid_descriptor();
        let raw = d.canonical_bytes().unwrap();
        let d2 = SafetyPolicyDescriptor::from_json(&raw).unwrap();
        assert_eq!(d, d2);
    }

    #[test]
    fn from_json_rejects_bad_descriptor() {
        let bytes = b"{}";
        SafetyPolicyDescriptor::from_json(bytes).unwrap_err();
    }
}
