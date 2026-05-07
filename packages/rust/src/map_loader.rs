// SPDX-License-Identifier: MIT
//! Fetch, verify, and cache tokenizer maps.
//!
//! Gated behind the `http` feature (default-on). Pulls in `reqwest`
//! with both blocking and async APIs.

use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::frame::{MapCache, MemoryMapCache};
use crate::map::{parse_hash, TokenizerMap, TokenizerMapError};

/// Options for [`MapLoader::load_blocking`] / [`MapLoader::load`].
#[derive(Clone, Default)]
pub struct LoadOptions {
    /// URL to fetch the map from.
    pub url: String,
    /// Optional sha256 hex digest to verify the fetched map against.
    /// Accepts `sha256:<hex>` or bare `<hex>`. If omitted, no verification.
    pub hash: Option<String>,
    /// Pluggable cache. Defaults to a process-wide in-memory cache.
    pub cache: Option<Arc<dyn MapCache>>,
    /// Cache key. Defaults to `{url}#{hash}`.
    pub cache_key: Option<String>,
}

/// Thrown when a fetched map doesn't match the expected hash.
#[derive(Debug, thiserror::Error)]
#[error("TokenizerMap hash mismatch.\n  expected: {expected}\n  actual:   {actual}")]
pub struct TokenizerMapHashMismatchError {
    pub expected: String,
    pub actual: String,
}

/// Errors raised by [`MapLoader`].
#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    HashMismatch(#[from] TokenizerMapHashMismatchError),
    #[error(transparent)]
    Map(#[from] TokenizerMapError),
}

/// Fetch, verify, and cache tokenizer maps.
pub struct MapLoader;

fn default_cache() -> Arc<dyn MapCache> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Arc<dyn MapCache>> = OnceLock::new();
    CACHE.get_or_init(|| Arc::new(MemoryMapCache::new())).clone()
}

fn build_blocking_client() -> Result<reqwest::blocking::Client, reqwest::Error> {
    reqwest::blocking::Client::builder()
        .user_agent("codec-rs/0.1")
        .gzip(true)
        .brotli(true)
        .build()
}

fn build_async_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .user_agent("codec-rs/0.1")
        .gzip(true)
        .brotli(true)
        .build()
}

impl MapLoader {
    /// Synchronous fetch + verify + cache.
    pub fn load_blocking(opts: LoadOptions) -> Result<Arc<TokenizerMap>, LoadError> {
        let cache = opts.cache.unwrap_or_else(default_cache);
        let cache_key = opts
            .cache_key
            .unwrap_or_else(|| format!("{}#{}", opts.url, opts.hash.as_deref().unwrap_or("")));

        if let Some(hit) = cache.get(&cache_key) {
            return Ok(hit);
        }

        let client = build_blocking_client()?;
        let bytes = client.get(&opts.url).send()?.error_for_status()?.bytes()?;

        if let Some(expected) = &opts.hash {
            let want = parse_hash(expected);
            let actual = sha256_hex(&bytes);
            if !actual.eq_ignore_ascii_case(&want) {
                return Err(LoadError::HashMismatch(TokenizerMapHashMismatchError {
                    expected: want,
                    actual,
                }));
            }
        }

        let map = TokenizerMap::from_json(&bytes)?;
        let arc = Arc::new(map);
        cache.set(&cache_key, Arc::clone(&arc));
        Ok(arc)
    }

    /// Async fetch + verify + cache. Requires a Tokio runtime.
    pub async fn load(opts: LoadOptions) -> Result<Arc<TokenizerMap>, LoadError> {
        let cache = opts.cache.unwrap_or_else(default_cache);
        let cache_key = opts
            .cache_key
            .unwrap_or_else(|| format!("{}#{}", opts.url, opts.hash.as_deref().unwrap_or("")));

        if let Some(hit) = cache.get(&cache_key) {
            return Ok(hit);
        }

        let client = build_async_client()?;
        let bytes = client
            .get(&opts.url)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;

        if let Some(expected) = &opts.hash {
            let want = parse_hash(expected);
            let actual = sha256_hex(&bytes);
            if !actual.eq_ignore_ascii_case(&want) {
                return Err(LoadError::HashMismatch(TokenizerMapHashMismatchError {
                    expected: want,
                    actual,
                }));
            }
        }

        let map = TokenizerMap::from_json(&bytes)?;
        let arc = Arc::new(map);
        cache.set(&cache_key, Arc::clone(&arc));
        Ok(arc)
    }

    /// Verify-only helper exposed for tests / callers that fetched bytes
    /// out-of-band (e.g. local file). Returns the map on success or a
    /// hash-mismatch error.
    pub fn verify_and_parse(
        bytes: &[u8],
        expected_hash: Option<&str>,
    ) -> Result<TokenizerMap, LoadError> {
        if let Some(expected) = expected_hash {
            let want = parse_hash(expected);
            let actual = sha256_hex(bytes);
            if !actual.eq_ignore_ascii_case(&want) {
                return Err(LoadError::HashMismatch(TokenizerMapHashMismatchError {
                    expected: want,
                    actual,
                }));
            }
        }
        Ok(TokenizerMap::from_json(bytes)?)
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}
