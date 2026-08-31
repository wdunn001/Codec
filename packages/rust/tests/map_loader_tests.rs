// SPDX-License-Identifier: MIT
//! MapLoader tests: sha256 verify-and-parse path.
//!
//! Network round-trips aren't exercised here (deliberately, to keep the
//! tests hermetic); the `verify_and_parse` helper covers the
//! hash-mismatch contract.

#![cfg(feature = "http")]

use codec_rs::{LoadError, MapLoader, TokenizerMap};

fn make_valid_map_json() -> String {
    r#"{
        "id": "test/synth",
        "version": "2",
        "vocab_size": 3,
        "vocab": {"a": 0, "b": 1, "c": 2}
    }"#
    .to_string()
}

#[test]
fn verify_and_parse_succeeds_on_correct_hash() {
    let json = make_valid_map_json();
    let bytes = json.as_bytes();
    let actual = TokenizerMap::verify_sha256(bytes, "0").err().map(|(_, a)| a).unwrap_or_default();
    // Use the actual hash to assert the success path of MapLoader.
    let expected = format!("sha256:{actual}");
    let map = MapLoader::verify_and_parse(bytes, Some(&expected)).expect("verify ok");
    assert_eq!(map.id, "test/synth");
}

#[test]
fn verify_and_parse_returns_hash_mismatch_no_panic() {
    let json = make_valid_map_json();
    let bytes = json.as_bytes();
    let bad_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    let result = MapLoader::verify_and_parse(bytes, Some(bad_hash));
    match result {
        Err(LoadError::HashMismatch(err)) => {
            assert_eq!(err.expected, "0".repeat(64));
            assert_eq!(err.actual.len(), 64);
        }
        Err(other) => panic!("expected HashMismatch, got {other:?}"),
        Ok(_) => panic!("expected HashMismatch, got success"),
    }
}

#[test]
fn verify_and_parse_with_no_hash_skips_verification() {
    let json = make_valid_map_json();
    let bytes = json.as_bytes();
    let map = MapLoader::verify_and_parse(bytes, None).expect("parse ok");
    assert_eq!(map.id, "test/synth");
}
