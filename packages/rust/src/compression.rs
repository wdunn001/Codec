// SPDX-License-Identifier: MIT
//! Client-side helpers for the Codec compression contract.
//!
//! Rust twin of `codecai.compression` (Python): the server emits
//! `Codec-Zstd-Dict: sha256:<hex>` on every zstd response, the client
//! validates that header against locally-loaded dicts before
//! decompressing. See `spec/PROTOCOL.md` "Codec-Zstd-Dict response
//! header" (stable since v0.2) for the full contract.
//!
//! The actual zstd decompression is intentionally out of scope here —
//! callers usually already have an HTTP stack and pick their own
//! zstd binding (`zstd` crate, `zstd-safe`, an FFI wrapper, etc.).
//! This module just gives you the small piece that's specific to
//! Codec: matching a response's declared dict hash to the dict you've
//! loaded, with the case-insensitive header lookup and fail-fast
//! semantics the spec mandates.
//!
//! Wrong-dict decompression produces garbage bytes that downstream
//! msgpack / protobuf parsers will silently misinterpret — fail fast
//! at the dict-select boundary instead.

use std::collections::HashMap;
use std::fmt;

use sha2::{Digest, Sha256};

/// Compute the canonical `Codec-Zstd-Dict` hash for `dict_bytes`.
///
/// Returns `sha256:<lowercase hex>` — same shape as the server-side
/// header value and the `hash` field in tokenizer-map
/// `zstd_dictionaries[]` entries.
pub fn hash_zstd_dict(dict_bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(dict_bytes);
    let digest = hasher.finalize();
    format!("sha256:{}", hex::encode(digest))
}

/// Raised when the server's `Codec-Zstd-Dict` header doesn't match any
/// dict the client has loaded, or is missing on a zstd response.
///
/// A wrong-dict decompression would produce garbage bytes that
/// downstream parsers would misinterpret — fail fast instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecZstdDictError {
    /// Response was `Content-Encoding: zstd` but the server omitted
    /// the `Codec-Zstd-Dict` header. Per spec/PROTOCOL.md the server
    /// MUST name the dict it used; we refuse to guess.
    MissingHeader,
    /// `Codec-Zstd-Dict` value was not in the canonical
    /// `sha256:<64 hex chars>` shape. The wrapped string is the raw
    /// header value (trimmed) for diagnostics.
    MalformedHash(String),
    /// `Codec-Zstd-Dict` named a dict we haven't loaded. The caller
    /// should fetch it from the tokenizer map's `zstd_dictionaries[]`
    /// entry (the one whose `hash` matches) or retry the request with
    /// `Accept-Encoding: gzip` to downgrade to a no-dict path. The
    /// wrapped string is the declared hash.
    UnknownHash(String),
}

impl fmt::Display for CodecZstdDictError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CodecZstdDictError::MissingHeader => write!(
                f,
                "Response is Content-Encoding: zstd but no Codec-Zstd-Dict \
                 header was present. Per spec/PROTOCOL.md the server MUST \
                 name the dict it used. Refusing to guess."
            ),
            CodecZstdDictError::MalformedHash(value) => write!(
                f,
                "Malformed Codec-Zstd-Dict value: {value:?}. Expected \
                 'sha256:<64 hex chars>'."
            ),
            CodecZstdDictError::UnknownHash(hash) => write!(
                f,
                "Server used zstd dict {hash} but it isn't loaded \
                 locally. Fetch it from the tokenizer map's \
                 zstd_dictionaries[] entry (the entry whose hash \
                 matches), or send Accept-Encoding: gzip to downgrade."
            ),
        }
    }
}

impl std::error::Error for CodecZstdDictError {}

/// Pick the zstd dict to decompress this response with.
///
/// # Parameters
///
/// - `response_headers`: HTTP response header map. Keys are looked up
///   case-insensitively, matching the way `reqwest::HeaderMap` and most
///   HTTP libraries treat headers on the wire.
/// - `loaded_dicts`: `{ "sha256:<hex>" -> dict bytes }`. Populate this
///   from your tokenizer map's `zstd_dictionaries[]` entries; keys
///   follow the same canonical shape the server emits.
///
/// # Returns
///
/// - `Ok(Some(&dict_bytes))` when the response is
///   `Content-Encoding: zstd` and the server's `Codec-Zstd-Dict`
///   header points at a loaded dict — pass these bytes to your zstd
///   decoder (e.g. `zstd::stream::Decoder::with_dictionary`).
/// - `Ok(None)` when the response isn't zstd. The caller should pass
///   the body through identity / let its HTTP stack auto-decompress
///   gzip / brotli.
///
/// # Errors
///
/// Returns `CodecZstdDictError` when the response is zstd but the
/// header is missing, malformed, or names a dict the client hasn't
/// loaded. Wrong-dict decompression is never attempted — see the
/// spec rationale at `spec/PROTOCOL.md`.
pub fn select_zstd_dict_for_response<'a>(
    response_headers: &HashMap<String, String>,
    loaded_dicts: &'a HashMap<String, Vec<u8>>,
) -> Result<Option<&'a [u8]>, CodecZstdDictError> {
    let enc = header(response_headers, "content-encoding");
    match enc.map(|v| v.trim().to_ascii_lowercase()) {
        Some(ref v) if v == "zstd" => {}
        _ => return Ok(None), // caller's HTTP stack handles gzip/br/identity
    }

    let declared = match header(response_headers, "codec-zstd-dict") {
        Some(v) => v.trim().to_string(),
        None => return Err(CodecZstdDictError::MissingHeader),
    };
    if declared.is_empty() {
        return Err(CodecZstdDictError::MissingHeader);
    }

    if !is_canonical_sha256(&declared) {
        return Err(CodecZstdDictError::MalformedHash(declared));
    }

    match loaded_dicts.get(&declared) {
        Some(bytes) => Ok(Some(bytes.as_slice())),
        None => Err(CodecZstdDictError::UnknownHash(declared)),
    }
}

/// Case-insensitive header lookup. Most idiomatic HTTP libraries
/// (`reqwest::HeaderMap`, `http::HeaderMap`) already treat header
/// names case-insensitively; this is the defensive fallback for
/// callers that hand us a plain `HashMap<String, String>` lifted
/// out of their own request plumbing.
fn header<'a>(headers: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    if let Some(v) = headers.get(name) {
        return Some(v.as_str());
    }
    let lower = name.to_ascii_lowercase();
    for (k, v) in headers.iter() {
        if k.to_ascii_lowercase() == lower {
            return Some(v.as_str());
        }
    }
    None
}

fn is_canonical_sha256(value: &str) -> bool {
    const PREFIX: &str = "sha256:";
    if !value.starts_with(PREFIX) {
        return false;
    }
    let hex = &value[PREFIX.len()..];
    hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

// ── Discoverable zstd dictionaries (.well-known/codec/dicts/<sha>.zstd, v0.5+) ──

/// Errors raised by the v0.5 zstd-dictionary discovery surface.
///
/// The discovery path is hard-fail by design (no silent fallback to identity
/// bytes) — see `spec/WELL_KNOWN_DISCOVERY.md § Resolution failures`. Silent
/// dict-load failure was the v0.4.1 sglang COPY-dicts regression class this
/// surface eliminates.
#[derive(Debug, thiserror::Error)]
pub enum ZstdDictDiscoveryError {
    /// Hash input was not `sha256:<64 hex>` or bare `<64 hex>`.
    #[error("Invalid dict hash {hash:?}: expected 'sha256:<64 hex>' or '<64 hex>'")]
    InvalidHash { hash: String },
    /// `.well-known/codec/dicts/<hex>.zstd` returned HTTP 404.
    #[error("No zstd dict at {url} (HTTP 404)")]
    NotFound { url: String },
    /// Fetched bytes did not hash to the `<hex>` path component in the URL.
    /// Treat as byte-tampering: never decompress.
    #[error("Zstd dict hash mismatch at {url}\n  expected: {expected}\n  actual:   {actual}")]
    HashMismatch {
        url: String,
        expected: String,
        actual: String,
    },
    /// HTTP transport-layer failure (reqwest). Surfaced separately from 404 so
    /// callers can distinguish "origin doesn't publish this dict" from "we
    /// couldn't reach the origin at all."
    #[cfg(feature = "http")]
    #[error("HTTP error fetching {url}: {source}")]
    Http {
        url: String,
        #[source]
        source: reqwest::Error,
    },
}

/// Validate + normalise an sha256 dict hash to bare lowercase hex.
///
/// Accepts either `sha256:<hex>` or bare `<hex>`. Used both as a URL builder
/// guard and as the expected verifier in [`discover_zstd_dict_blocking`].
fn parse_dict_hash(hash: &str) -> Result<String, ZstdDictDiscoveryError> {
    let s = hash.trim();
    let stripped = s.strip_prefix("sha256:").unwrap_or(s);
    let lower = stripped.to_ascii_lowercase();
    if lower.len() != 64 || !lower.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(ZstdDictDiscoveryError::InvalidHash {
            hash: hash.to_string(),
        });
    }
    Ok(lower)
}

/// Per-dict document URL for an origin + sha256 hash (v0.5+).
///
/// Returns `<origin>/.well-known/codec/dicts/<sha256-hex>.zstd`. The URL is
/// fully derived from the hash — there is no mutable per-id form for dicts.
///
/// # Errors
///
/// [`ZstdDictDiscoveryError::InvalidHash`] when the hash is not the expected
/// `sha256:<hex>` / bare `<hex>` shape.
pub fn well_known_dict_url(origin: &str, hash: &str) -> Result<String, ZstdDictDiscoveryError> {
    let hex = parse_dict_hash(hash)?;
    let origin = origin.strip_suffix('/').unwrap_or(origin);
    Ok(format!("{origin}/.well-known/codec/dicts/{hex}.zstd"))
}

#[cfg(feature = "http")]
fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Synchronously resolve a zstd dictionary via
/// `.well-known/codec/dicts/<hex>.zstd` (v0.5+).
///
/// Fetches `<origin>/.well-known/codec/dicts/<sha256-hex>.zstd`, verifies the
/// fetched bytes hash to `<hex>`, and returns the raw dict bytes ready to
/// feed into `zstd::dict::DecoderDictionary::copy(...)` or equivalent.
///
/// # Example
///
/// ```no_run
/// use codec_rs::discover_zstd_dict_blocking;
///
/// let dict = discover_zstd_dict_blocking(
///     "https://codec.example",
///     "sha256:abc1230000000000000000000000000000000000000000000000000000000000",
/// )?;
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
///
/// # Errors
///
/// - [`ZstdDictDiscoveryError::InvalidHash`] if the hash is malformed
///   (rejected before any HTTP request)
/// - [`ZstdDictDiscoveryError::NotFound`] for HTTP 404
/// - [`ZstdDictDiscoveryError::HashMismatch`] if origin served wrong bytes
/// - [`ZstdDictDiscoveryError::Http`] for transport-layer failures
#[cfg(feature = "http")]
pub fn discover_zstd_dict_blocking(
    origin: &str,
    hash: &str,
) -> Result<Vec<u8>, ZstdDictDiscoveryError> {
    let expected = parse_dict_hash(hash)?;
    let url = well_known_dict_url(origin, hash)?;

    let client = reqwest::blocking::Client::builder()
        .user_agent("codec-rs/0.4")
        .build()
        .map_err(|e| ZstdDictDiscoveryError::Http {
            url: url.clone(),
            source: e,
        })?;

    let resp = client
        .get(&url)
        .send()
        .map_err(|e| ZstdDictDiscoveryError::Http {
            url: url.clone(),
            source: e,
        })?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(ZstdDictDiscoveryError::NotFound { url });
    }
    let resp = resp
        .error_for_status()
        .map_err(|e| ZstdDictDiscoveryError::Http {
            url: url.clone(),
            source: e,
        })?;
    let bytes = resp.bytes().map_err(|e| ZstdDictDiscoveryError::Http {
        url: url.clone(),
        source: e,
    })?;
    let actual = sha256_hex_bytes(&bytes);
    if actual != expected {
        return Err(ZstdDictDiscoveryError::HashMismatch {
            url,
            expected,
            actual,
        });
    }
    Ok(bytes.to_vec())
}

/// Async variant of [`discover_zstd_dict_blocking`]. Requires a Tokio runtime.
#[cfg(feature = "http")]
pub async fn discover_zstd_dict(
    origin: &str,
    hash: &str,
) -> Result<Vec<u8>, ZstdDictDiscoveryError> {
    let expected = parse_dict_hash(hash)?;
    let url = well_known_dict_url(origin, hash)?;

    let client = reqwest::Client::builder()
        .user_agent("codec-rs/0.4")
        .build()
        .map_err(|e| ZstdDictDiscoveryError::Http {
            url: url.clone(),
            source: e,
        })?;

    let resp =
        client
            .get(&url)
            .send()
            .await
            .map_err(|e| ZstdDictDiscoveryError::Http {
                url: url.clone(),
                source: e,
            })?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(ZstdDictDiscoveryError::NotFound { url });
    }
    let resp = resp
        .error_for_status()
        .map_err(|e| ZstdDictDiscoveryError::Http {
            url: url.clone(),
            source: e,
        })?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| ZstdDictDiscoveryError::Http {
            url: url.clone(),
            source: e,
        })?;
    let actual = sha256_hex_bytes(&bytes);
    if actual != expected {
        return Err(ZstdDictDiscoveryError::HashMismatch {
            url,
            expected,
            actual,
        });
    }
    Ok(bytes.to_vec())
}

// ── unit tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_zstd_dict_matches_python_reference() {
        // "hello world" sha256 — same digest both languages produce.
        let got = hash_zstd_dict(b"hello world");
        assert_eq!(
            got,
            "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn select_returns_none_when_not_zstd() {
        let mut headers = HashMap::new();
        headers.insert("content-encoding".into(), "gzip".into());
        let dicts: HashMap<String, Vec<u8>> = HashMap::new();
        assert_eq!(
            select_zstd_dict_for_response(&headers, &dicts).unwrap(),
            None
        );
    }

    #[test]
    fn select_returns_none_when_no_encoding() {
        let headers: HashMap<String, String> = HashMap::new();
        let dicts: HashMap<String, Vec<u8>> = HashMap::new();
        assert_eq!(
            select_zstd_dict_for_response(&headers, &dicts).unwrap(),
            None
        );
    }

    #[test]
    fn select_missing_header_is_error() {
        let mut headers = HashMap::new();
        headers.insert("Content-Encoding".into(), "zstd".into());
        let dicts: HashMap<String, Vec<u8>> = HashMap::new();
        assert_eq!(
            select_zstd_dict_for_response(&headers, &dicts),
            Err(CodecZstdDictError::MissingHeader)
        );
    }

    #[test]
    fn select_malformed_hash_is_error() {
        let mut headers = HashMap::new();
        headers.insert("content-encoding".into(), "zstd".into());
        headers.insert("codec-zstd-dict".into(), "md5:abc".into());
        let dicts: HashMap<String, Vec<u8>> = HashMap::new();
        match select_zstd_dict_for_response(&headers, &dicts) {
            Err(CodecZstdDictError::MalformedHash(v)) => assert_eq!(v, "md5:abc"),
            other => panic!("expected MalformedHash, got {other:?}"),
        }
    }

    // ── well_known_dict_url / parse_dict_hash (v0.5) ─────────────────────────

    #[test]
    fn well_known_dict_url_strips_sha256_prefix() {
        let h = "a".repeat(64);
        assert_eq!(
            well_known_dict_url("https://codec.example", &format!("sha256:{h}")).unwrap(),
            format!("https://codec.example/.well-known/codec/dicts/{h}.zstd"),
        );
    }

    #[test]
    fn well_known_dict_url_accepts_bare_hex() {
        let h = "b".repeat(64);
        assert_eq!(
            well_known_dict_url("https://codec.example", &h).unwrap(),
            format!("https://codec.example/.well-known/codec/dicts/{h}.zstd"),
        );
    }

    #[test]
    fn well_known_dict_url_strips_trailing_slash() {
        let h = "c".repeat(64);
        assert_eq!(
            well_known_dict_url("https://codec.example/", &h).unwrap(),
            format!("https://codec.example/.well-known/codec/dicts/{h}.zstd"),
        );
    }

    #[test]
    fn well_known_dict_url_normalises_uppercase_hex() {
        let upper = "D".repeat(64);
        let expected = "d".repeat(64);
        assert_eq!(
            well_known_dict_url("https://codec.example", &upper).unwrap(),
            format!("https://codec.example/.well-known/codec/dicts/{expected}.zstd"),
        );
    }

    #[test]
    fn well_known_dict_url_rejects_short_hash() {
        let err = well_known_dict_url("https://codec.example", "deadbeef").unwrap_err();
        assert!(matches!(err, ZstdDictDiscoveryError::InvalidHash { .. }));
    }

    #[test]
    fn well_known_dict_url_rejects_wrong_algorithm() {
        let err = well_known_dict_url(
            "https://codec.example",
            &format!("md5:{}", "a".repeat(32)),
        )
        .unwrap_err();
        assert!(matches!(err, ZstdDictDiscoveryError::InvalidHash { .. }));
    }

    #[test]
    fn well_known_dict_url_rejects_nonhex_chars() {
        let err = well_known_dict_url("https://codec.example", &"z".repeat(64)).unwrap_err();
        assert!(matches!(err, ZstdDictDiscoveryError::InvalidHash { .. }));
    }
}
