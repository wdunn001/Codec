//! Codec v0.4 version negotiation — client-side primitives.
//!
//! Rust mirror of `packages/web/src/version-signaling.ts` and
//! `packages/python/src/codecai/version_signaling.py`.
//!
//! See `spec/versions/v0.4.md`:
//!
//!   - § Version Compatibility Signaling (Codec-Client-Version, 426 path)
//!   - § Capabilities are opt-on at the server (two-stage)
//!   - § Graceful downgrade (response shaping)
//!
//! Usage:
//!
//! ```rust,no_run
//! # #[cfg(feature = "http")]
//! # fn _doc() -> Result<(), Box<dyn std::error::Error>> {
//! use codec_rs::version_signaling::{
//!     CODEC_CLIENT_VERSION, CODEC_CLIENT_VERSION_HEADER,
//!     parse_version_required,
//! };
//!
//! let client = reqwest::blocking::Client::new();
//! let resp = client.post("https://server.test/v1/completions")
//!     .header(CODEC_CLIENT_VERSION_HEADER, CODEC_CLIENT_VERSION)
//!     .body("...")
//!     .send()?;
//!
//! if let Some(err) = parse_version_required(&resp.status(), &resp.text()?)? {
//!     return Err(err.into());
//! }
//! # Ok(()) }
//! ```

use serde::{Deserialize, Serialize};

/// The protocol version this crate speaks. Bumped when the crate
/// implements support for a new minor protocol version.
pub const CODEC_CLIENT_VERSION: &str = "0.4";

/// Request header name (canonical case).
pub const CODEC_CLIENT_VERSION_HEADER: &str = "Codec-Client-Version";

/// Response header name; advisory on 2xx, load-bearing on 426.
pub const CODEC_MIN_VERSION_HEADER: &str = "Codec-Min-Version";

/// Response header name; emitted on 426.
pub const CODEC_REQUIRED_FEATURES_HEADER: &str = "Codec-Required-Features";

/// Shape of the JSON body on a v0.4 server's 426 response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodecVersionRequiredBody {
    pub error: String,
    pub minimum_version: String,
    pub required_features: Vec<String>,
    pub client_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
}

/// Shape of `.well-known/codec/version-policy.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodecVersionPolicyDocument {
    pub minimum_version: String,
    pub required_features: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<String>,
}

/// Error raised when a v0.4-mandating server refuses with a 426.
#[derive(Debug, thiserror::Error)]
pub enum VersionSignalingError {
    #[error("Codec server requires v{minimum_version}{features_suffix}; this client speaks v{client_version}.{docs_suffix}")]
    VersionRequired {
        minimum_version: String,
        client_version: String,
        required_features: Vec<String>,
        features_suffix: String,
        docs_url: Option<String>,
        docs_suffix: String,
        deployment_id: Option<String>,
    },

    #[error("Codec server returned 426 Upgrade Required but body was not JSON: {0}")]
    NonJsonBody(String),

    #[error("Codec server returned 426 Upgrade Required with an unrecognized body: {0}")]
    UnrecognizedBody(String),

    #[error("version-policy doc is malformed: {0}")]
    MalformedPolicyDoc(String),

    #[error("HTTP error fetching version policy from {url}: status {status}")]
    HttpError { url: String, status: u16 },

    #[cfg(feature = "http")]
    #[error("reqwest error: {0}")]
    Reqwest(#[from] reqwest::Error),
}

impl VersionSignalingError {
    fn from_body(body: CodecVersionRequiredBody) -> Self {
        let features_suffix = if body.required_features.is_empty() {
            String::new()
        } else {
            format!(" (requires: {})", body.required_features.join(", "))
        };
        let docs_suffix = match &body.docs_url {
            Some(u) => format!(" See {u}"),
            None => String::new(),
        };
        Self::VersionRequired {
            minimum_version: body.minimum_version,
            client_version: body.client_version,
            required_features: body.required_features,
            features_suffix,
            docs_url: body.docs_url,
            docs_suffix,
            deployment_id: body.deployment_id,
        }
    }
}

/// Build the well-known URL for an origin.
pub fn well_known_version_policy_url(origin: &str) -> String {
    format!("{}/.well-known/codec/version-policy.json", origin.trim_end_matches('/'))
}

/// Parse a (status, body) pair into a typed error. Returns `Ok(None)` for
/// non-426 responses, `Ok(Some(err))` for valid 426 bodies, and `Err` for
/// 426s with malformed/non-JSON bodies — never silently swallows a 426.
pub fn parse_version_required(
    status: &impl HttpStatus,
    body_text: &str,
) -> Result<Option<VersionSignalingError>, VersionSignalingError> {
    if status.as_u16() != 426 {
        return Ok(None);
    }

    let raw: serde_json::Value = match serde_json::from_str(body_text) {
        Ok(v) => v,
        Err(_) => {
            return Err(VersionSignalingError::NonJsonBody(truncate(body_text, 200)));
        }
    };

    let body: CodecVersionRequiredBody = match serde_json::from_value(raw.clone()) {
        Ok(b) => b,
        Err(_) => {
            return Err(VersionSignalingError::UnrecognizedBody(truncate(body_text, 200)));
        }
    };

    if body.error != "codec_version_required"
        || body.minimum_version.is_empty()
        || body.client_version.is_empty()
    {
        return Err(VersionSignalingError::UnrecognizedBody(truncate(body_text, 200)));
    }

    Ok(Some(VersionSignalingError::from_body(body)))
}

/// Parse + validate a version-policy document.
pub fn parse_version_policy_document(
    raw: &str,
) -> Result<CodecVersionPolicyDocument, VersionSignalingError> {
    let doc: CodecVersionPolicyDocument = serde_json::from_str(raw)
        .map_err(|e| VersionSignalingError::MalformedPolicyDoc(format!("{e}")))?;
    if doc.minimum_version.is_empty() {
        return Err(VersionSignalingError::MalformedPolicyDoc(
            "missing minimum_version".into(),
        ));
    }
    Ok(doc)
}

/// Trait abstracting an HTTP status code so we can test without
/// pulling in reqwest. `reqwest::StatusCode` and `u16` both implement
/// it via the blanket impls below.
pub trait HttpStatus {
    fn as_u16(&self) -> u16;
}

impl HttpStatus for u16 {
    fn as_u16(&self) -> u16 {
        *self
    }
}

#[cfg(feature = "http")]
impl HttpStatus for reqwest::StatusCode {
    fn as_u16(&self) -> u16 {
        (*self).as_u16()
    }
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ── Pre-flight discovery ────────────────────────────────────────────────

#[cfg(feature = "http")]
/// Pre-flight fetch of the deployment's minimum-version policy.
/// Returns `Ok(None)` when the server returns 404 (unrestricted
/// deployment). Returns `Err` on 5xx or malformed body.
pub fn discover_version_policy_blocking(
    origin: &str,
    client: &reqwest::blocking::Client,
) -> Result<Option<CodecVersionPolicyDocument>, VersionSignalingError> {
    let url = well_known_version_policy_url(origin);
    let resp = client
        .get(&url)
        .header(CODEC_CLIENT_VERSION_HEADER, CODEC_CLIENT_VERSION)
        .send()?;

    let status = resp.status().as_u16();
    if status == 404 {
        return Ok(None);
    }
    if status >= 400 {
        return Err(VersionSignalingError::HttpError { url, status });
    }
    let text = resp.text()?;
    parse_version_policy_document(&text).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_BODY: &str = r#"{
        "error": "codec_version_required",
        "minimum_version": "0.4",
        "required_features": ["safety-policy-enforcement"],
        "client_version": "0.3",
        "docs_url": "https://codecai.net/docs/version-negotiation/",
        "deployment_id": "lab-test"
    }"#;

    #[test]
    fn parse_returns_none_for_non_426() {
        let result = parse_version_required(&200u16, r#"{"ok":true}"#).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn parse_returns_typed_error_for_valid_426() {
        let result = parse_version_required(&426u16, VALID_BODY).unwrap();
        assert!(result.is_some());
        if let Some(VersionSignalingError::VersionRequired {
            minimum_version,
            client_version,
            required_features,
            docs_url,
            deployment_id,
            ..
        }) = result
        {
            assert_eq!(minimum_version, "0.4");
            assert_eq!(client_version, "0.3");
            assert_eq!(required_features, vec!["safety-policy-enforcement"]);
            assert_eq!(
                docs_url,
                Some("https://codecai.net/docs/version-negotiation/".to_string())
            );
            assert_eq!(deployment_id, Some("lab-test".to_string()));
        } else {
            panic!("expected VersionRequired variant");
        }
    }

    #[test]
    fn error_message_contains_version_info() {
        let err = parse_version_required(&426u16, VALID_BODY).unwrap().unwrap();
        let msg = format!("{err}");
        assert!(msg.contains("requires v0.4"), "msg = {msg}");
        assert!(msg.contains("safety-policy-enforcement"), "msg = {msg}");
        assert!(msg.contains("speaks v0.3"), "msg = {msg}");
    }

    #[test]
    fn parse_errors_on_non_json_body() {
        let err = parse_version_required(&426u16, "plain text refusal").unwrap_err();
        assert!(matches!(err, VersionSignalingError::NonJsonBody(_)));
    }

    #[test]
    fn parse_errors_on_unrecognized_shape() {
        let err =
            parse_version_required(&426u16, r#"{"error":"something_else","foo":1}"#)
                .unwrap_err();
        assert!(matches!(err, VersionSignalingError::UnrecognizedBody(_)));
    }

    #[test]
    fn parse_handles_empty_required_features() {
        let body = r#"{
            "error": "codec_version_required",
            "minimum_version": "0.4",
            "required_features": [],
            "client_version": "0.3"
        }"#;
        let result = parse_version_required(&426u16, body).unwrap().unwrap();
        let msg = format!("{result}");
        assert!(!msg.contains("requires:"), "msg = {msg}");
    }

    #[test]
    fn parse_policy_doc_valid() {
        let body = r#"{
            "minimum_version": "0.4",
            "required_features": ["safety-policy-enforcement"],
            "deployment_id": "acme-prod"
        }"#;
        let doc = parse_version_policy_document(body).unwrap();
        assert_eq!(doc.minimum_version, "0.4");
        assert_eq!(doc.required_features, vec!["safety-policy-enforcement"]);
    }

    #[test]
    fn parse_policy_doc_rejects_missing_min_version() {
        let err = parse_version_policy_document(r#"{"required_features":[]}"#).unwrap_err();
        assert!(matches!(err, VersionSignalingError::MalformedPolicyDoc(_)));
    }

    #[test]
    fn well_known_url_helper() {
        assert_eq!(
            well_known_version_policy_url("https://x.test/"),
            "https://x.test/.well-known/codec/version-policy.json"
        );
    }

    // ── Matrix: client × server config ──────────────────────────────────

    fn server_required_features(name: &str) -> Vec<String> {
        match name {
            "safety-enforced" => vec!["safety-policy-enforcement".into()],
            "version-policy-strict" | "default-off" | _ => vec![],
        }
    }

    fn server_refuses(name: &str, client: &str) -> bool {
        let v04_min = matches!(client, "0.4" | "0.5");
        match name {
            "default-off" => false,
            "safety-enforced" | "version-policy-strict" => !v04_min,
            _ => false,
        }
    }

    #[test]
    fn matrix_full() {
        let servers = ["default-off", "safety-enforced", "version-policy-strict"];
        let clients = ["0.2", "0.3", "0.4", "0.5"];

        for server in &servers {
            for client in &clients {
                let refused = server_refuses(server, client);
                if refused {
                    let features = server_required_features(server);
                    let features_json = features
                        .iter()
                        .map(|f| format!("\"{f}\""))
                        .collect::<Vec<_>>()
                        .join(",");
                    let body = format!(
                        r#"{{
                            "error": "codec_version_required",
                            "minimum_version": "0.4",
                            "required_features": [{features_json}],
                            "client_version": "{client}"
                        }}"#
                    );
                    let result = parse_version_required(&426u16, &body)
                        .unwrap_or_else(|e| panic!("server={server} client={client}: {e}"));
                    assert!(
                        result.is_some(),
                        "server={server} client={client} expected refusal"
                    );
                    if let Some(VersionSignalingError::VersionRequired {
                        client_version, required_features, ..
                    }) = result {
                        assert_eq!(client_version, *client);
                        assert_eq!(required_features, features);
                    }
                } else {
                    let result = parse_version_required(&200u16, r#"{"ok":true}"#).unwrap();
                    assert!(
                        result.is_none(),
                        "server={server} client={client} expected pass-through"
                    );
                }
            }
        }
    }
}
