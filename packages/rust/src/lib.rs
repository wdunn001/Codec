// SPDX-License-Identifier: MIT
//! # codec-rs
//!
//! Rust port of the [Codec](https://github.com/wdunn001/Codec) binary
//! transport protocol — the functional twin of `Codec.Net`,
//! `@codecai/web`, and `codecai`.
//!
//! Codec carries `uint32` token IDs on the wire instead of UTF-8 / JSON,
//! deferring text decoding to the presentation layer. This crate lets a
//! Rust client decode/encode Codec frames, parse tokenizer maps,
//! detokenize/tokenize, watch for tool calls, translate cross-vocab, and
//! load maps over HTTP — all with full sha256 verification.
//!
//! ## Quick start
//!
//! ```no_run
//! use codec_rs::{TokenizerMap, Detokenizer, DetokenizeOptions};
//!
//! # fn _example(json: &[u8], frames: Vec<codec_rs::CodecFrame>) {
//! let map = TokenizerMap::from_json(json).unwrap();
//! let mut detok = Detokenizer::new(&map);
//! for frame in frames {
//!     let opts = DetokenizeOptions { partial: !frame.done, render_special: false };
//!     let text = detok.render(&frame.ids, opts);
//!     print!("{text}");
//! }
//! # }
//! ```
//!
//! See module-level docs and the project README for the full surface.

pub mod byte_encoder;
pub mod detokenize;
pub mod frame;
pub mod longest_match;
pub mod map;
#[cfg(feature = "http")]
pub mod map_loader;
pub mod pretok_program;
pub mod safety_policy;
pub mod stream;
pub mod tokenize;
pub mod tool_watcher;
pub mod translator;

// Re-export the public surface.
pub use byte_encoder::{decode_byte_level_token, encode_byte_level_chars, METASPACE};
pub use detokenize::{Detokenizer, DetokenizeOptions};
pub use frame::{CodecFrame, IMapCache, MapCache, MemoryMapCache};
pub use longest_match::{LongestMatchTokenizer, Tokenize};
pub use map::{
    TokenizerMap, TokenizerMapError, ToolCallingArgsFormat, ToolCallingBlock,
    ToolCallingConvention, ToolCallingMarkers, ToolCallingResultFormat,
};
#[cfg(feature = "http")]
pub use map_loader::{LoadError, LoadOptions, MapLoader, TokenizerMapHashMismatchError};
pub use safety_policy::{
    Category as SafetyCategory, CategoryAction, ClassifierBlock as SafetyClassifierBlock,
    ClassifierHost, ClientHooksBlock as SafetyClientHooksBlock, EngineFeature,
    PublisherBlock as SafetyPublisherBlock, RulesSummary as SafetyRulesSummary,
    SafetyPolicyDescriptor, SafetyPolicyError, SafetyPolicyPointer,
    POLICY_WELL_KNOWN_BASE,
};
#[cfg(feature = "http")]
pub use safety_policy::{discover_safety_policy, load_safety_policy};
pub use stream::{
    decode_msgpack_stream, decode_protobuf_frame, decode_protobuf_stream, MsgpackFrameIter,
    ProtobufFrameIter, StreamError,
};
pub use pretok_program::{run_pretok_program, PreTokOp, PreTokProgram};
pub use tokenize::{BPETokenizer, ITokenizer};
pub use tool_watcher::{ToolWatcher, ToolWatcherError, WatcherEvent, WatcherEventKind};
pub use translator::{static_translation_table, translate_one_shot, Translator};
