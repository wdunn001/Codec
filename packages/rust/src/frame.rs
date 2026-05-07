// SPDX-License-Identifier: MIT
//! `CodecFrame` and the pluggable map cache.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::map::TokenizerMap;

/// One streaming frame produced by a Codec-compliant server.
///
/// Identical shape across MessagePack and Protobuf wire modes — only
/// serialization differs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodecFrame {
    /// Token IDs emitted by the model in this chunk.
    pub ids: Vec<u32>,
    /// `true` on the final frame — no further frames follow.
    pub done: bool,
    /// Set on the final frame: e.g. `"length"`, `"stop"`, `"eos_token"`, `"error"`.
    pub finish_reason: Option<String>,
}

impl CodecFrame {
    pub fn new(ids: Vec<u32>, done: bool, finish_reason: Option<String>) -> Self {
        Self { ids, done, finish_reason }
    }
}

/// Pluggable cache for loaded maps. The default is [`MemoryMapCache`].
///
/// Implement this trait to plug in IndexedDB, Redis, on-disk storage, etc.
pub trait MapCache: Send + Sync {
    /// Returns the cached map for `key`, or `None`.
    fn get(&self, key: &str) -> Option<Arc<TokenizerMap>>;
    /// Stores `map` under `key`.
    fn set(&self, key: &str, map: Arc<TokenizerMap>);
}

/// Alias matching the .NET `IMapCache` name for users familiar with the
/// .NET surface.
pub use MapCache as IMapCache;

/// Default in-memory [`MapCache`] backed by a mutex-guarded `HashMap`.
#[derive(Debug, Default)]
pub struct MemoryMapCache {
    inner: Mutex<HashMap<String, Arc<TokenizerMap>>>,
}

impl MemoryMapCache {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }
}

impl MapCache for MemoryMapCache {
    fn get(&self, key: &str) -> Option<Arc<TokenizerMap>> {
        self.inner.lock().ok()?.get(key).cloned()
    }

    fn set(&self, key: &str, map: Arc<TokenizerMap>) {
        if let Ok(mut g) = self.inner.lock() {
            g.insert(key.to_string(), map);
        }
    }
}
