// SPDX-License-Identifier: MIT
//! Integration tests for the dict-zstd helper.
//!
//! Drives the shared cross-client interop fixture at
//! `packages/bench/fixtures/dict-zstd-interop/`:
//!
//!   - `dict.bin`: the trained ZSTD dictionary (16 KB)
//!   - `compressed.bin`: server-emitted Codec response body (zstd-dict)
//!   - `decompressed.bin`: what we MUST recover byte-identically
//!   - `manifest.json`: declared sha256, first-10 token IDs, etc.
//!
//! Every Codec client (TS, Python, .NET, Java, C, Rust) drives the
//! same fixture; matching bytes here = the Rust client is on-spec.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use codec_rs::{
    decode_msgpack_stream, hash_zstd_dict, select_zstd_dict_for_response, CodecZstdDictError,
};
use serde_json::Value;

const EXPECTED_DICT_HASH: &str =
    "sha256:29a810f3fbded045d55f1cd4435c7d2959f6dbc9c697dc7fe41fb44bd2e891db";

fn fixture_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = packages/rust → ../bench/fixtures/dict-zstd-interop
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .expect("packages/")
        .join("bench")
        .join("fixtures")
        .join("dict-zstd-interop")
}

fn read_fixture(name: &str) -> Vec<u8> {
    let p = fixture_root().join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("read fixture {}: {e}", p.display()))
}

// ── A. hash_zstd_dict matches manifest ────────────────────────────────────

#[test]
fn hash_zstd_dict_matches_manifest() {
    let dict = read_fixture("dict.bin");
    assert_eq!(hash_zstd_dict(&dict), EXPECTED_DICT_HASH);

    // Cross-check: manifest.json declares the same hash.
    let manifest: Value =
        serde_json::from_slice(&read_fixture("manifest.json")).expect("manifest is valid JSON");
    let declared = manifest["dict_bin"]["sha256"]
        .as_str()
        .expect("manifest.dict_bin.sha256");
    assert_eq!(declared, EXPECTED_DICT_HASH);
}

// ── B. select_zstd_dict_for_response: full happy / sad path matrix ────────

fn loaded_dicts() -> HashMap<String, Vec<u8>> {
    let mut m = HashMap::new();
    m.insert(EXPECTED_DICT_HASH.to_string(), read_fixture("dict.bin"));
    m
}

#[test]
fn select_returns_dict_on_zstd_with_matching_header() {
    let mut headers = HashMap::new();
    headers.insert("content-encoding".into(), "zstd".into());
    headers.insert("codec-zstd-dict".into(), EXPECTED_DICT_HASH.into());
    let dicts = loaded_dicts();

    let picked = select_zstd_dict_for_response(&headers, &dicts)
        .expect("happy path must succeed")
        .expect("dict must be Some on matching header");
    assert_eq!(picked.len(), 16384);
    assert_eq!(hash_zstd_dict(picked), EXPECTED_DICT_HASH);
}

#[test]
fn select_is_case_insensitive_on_header_names() {
    // Server might (legally) emit camelcase / titlecase: HTTP names
    // are case-insensitive. The helper MUST handle that.
    let mut headers = HashMap::new();
    headers.insert("Content-Encoding".into(), "zstd".into());
    headers.insert("Codec-Zstd-Dict".into(), EXPECTED_DICT_HASH.into());
    let dicts = loaded_dicts();

    let picked = select_zstd_dict_for_response(&headers, &dicts)
        .expect("case-insensitive lookup must succeed")
        .expect("dict must be Some");
    assert_eq!(picked.len(), 16384);
}

#[test]
fn select_tolerates_value_whitespace_and_uppercase_encoding() {
    let mut headers = HashMap::new();
    headers.insert("content-encoding".into(), "  ZSTD  ".into());
    headers.insert(
        "codec-zstd-dict".into(),
        format!("  {EXPECTED_DICT_HASH}  "),
    );
    let dicts = loaded_dicts();

    let picked = select_zstd_dict_for_response(&headers, &dicts).expect("ok");
    assert!(picked.is_some(), "trimmed + lowercased should still match");
}

#[test]
fn select_returns_none_when_response_is_not_zstd() {
    let dicts = loaded_dicts();
    // gzip
    let mut h = HashMap::new();
    h.insert("content-encoding".into(), "gzip".into());
    assert!(select_zstd_dict_for_response(&h, &dicts).unwrap().is_none());
    // identity (no header at all)
    let h2: HashMap<String, String> = HashMap::new();
    assert!(select_zstd_dict_for_response(&h2, &dicts).unwrap().is_none());
}

#[test]
fn select_missing_codec_zstd_dict_header_is_error() {
    let mut headers = HashMap::new();
    headers.insert("content-encoding".into(), "zstd".into());
    let dicts = loaded_dicts();
    assert_eq!(
        select_zstd_dict_for_response(&headers, &dicts),
        Err(CodecZstdDictError::MissingHeader)
    );
}

#[test]
fn select_empty_codec_zstd_dict_header_is_error() {
    let mut headers = HashMap::new();
    headers.insert("content-encoding".into(), "zstd".into());
    headers.insert("codec-zstd-dict".into(), "   ".into());
    let dicts = loaded_dicts();
    assert_eq!(
        select_zstd_dict_for_response(&headers, &dicts),
        Err(CodecZstdDictError::MissingHeader)
    );
}

#[test]
fn select_malformed_codec_zstd_dict_header_is_error() {
    // wrong prefix
    {
        let mut headers = HashMap::new();
        headers.insert("content-encoding".into(), "zstd".into());
        headers.insert("codec-zstd-dict".into(), "md5:abc123".into());
        match select_zstd_dict_for_response(&headers, &loaded_dicts()) {
            Err(CodecZstdDictError::MalformedHash(v)) => assert_eq!(v, "md5:abc123"),
            other => panic!("expected MalformedHash, got {other:?}"),
        }
    }
    // right prefix, wrong length
    {
        let mut headers = HashMap::new();
        headers.insert("content-encoding".into(), "zstd".into());
        headers.insert("codec-zstd-dict".into(), "sha256:deadbeef".into());
        match select_zstd_dict_for_response(&headers, &loaded_dicts()) {
            Err(CodecZstdDictError::MalformedHash(v)) => assert_eq!(v, "sha256:deadbeef"),
            other => panic!("expected MalformedHash, got {other:?}"),
        }
    }
    // right prefix + length, non-hex chars
    {
        let mut headers = HashMap::new();
        headers.insert("content-encoding".into(), "zstd".into());
        let bad = format!("sha256:{}", "z".repeat(64));
        headers.insert("codec-zstd-dict".into(), bad.clone());
        match select_zstd_dict_for_response(&headers, &loaded_dicts()) {
            Err(CodecZstdDictError::MalformedHash(v)) => assert_eq!(v, bad),
            other => panic!("expected MalformedHash, got {other:?}"),
        }
    }
}

#[test]
fn select_unknown_hash_is_error() {
    let mut headers = HashMap::new();
    headers.insert("content-encoding".into(), "zstd".into());
    let unknown = format!("sha256:{}", "0".repeat(64));
    headers.insert("codec-zstd-dict".into(), unknown.clone());
    let dicts = loaded_dicts();
    match select_zstd_dict_for_response(&headers, &dicts) {
        Err(CodecZstdDictError::UnknownHash(v)) => assert_eq!(v, unknown),
        other => panic!("expected UnknownHash, got {other:?}"),
    }
}

#[test]
fn errors_are_std_error_and_display() {
    use std::error::Error as _;
    let err = CodecZstdDictError::MissingHeader;
    let _: &dyn std::error::Error = &err;
    assert!(err.to_string().contains("Codec-Zstd-Dict"));
    assert!(err.source().is_none());

    let malformed = CodecZstdDictError::MalformedHash("oops".into());
    let s = malformed.to_string();
    assert!(s.contains("Malformed"));
    assert!(s.contains("oops"));

    let unknown = CodecZstdDictError::UnknownHash("sha256:abc".into());
    let s = unknown.to_string();
    assert!(s.contains("sha256:abc"));
    assert!(s.contains("isn't loaded"));
}

// ── C. end-to-end fixture decompression + msgpack parse ───────────────────
//
// This is the cross-client interop assertion: decompress compressed.bin
// with the loaded dict, expect byte-identical match to decompressed.bin,
// then msgpack-parse and expect 32 token IDs starting with a known
// 10-prefix. Every Codec client runs the same check against the same
// fixture.

#[test]
fn fixture_decompress_byte_identical_and_msgpack_token_ids_match() {
    let dict = read_fixture("dict.bin");
    let compressed = read_fixture("compressed.bin");
    let expected_plain = read_fixture("decompressed.bin");
    let manifest: Value =
        serde_json::from_slice(&read_fixture("manifest.json")).expect("manifest JSON");

    // Build the headers the server would send.
    let mut headers = HashMap::new();
    headers.insert("content-encoding".into(), "zstd".into());
    headers.insert("codec-zstd-dict".into(), EXPECTED_DICT_HASH.into());

    // 1) Resolve dict via the production helper.
    let mut loaded = HashMap::new();
    loaded.insert(hash_zstd_dict(&dict), dict);
    let picked = select_zstd_dict_for_response(&headers, &loaded)
        .expect("ok")
        .expect("dict picked");

    // 2) Decompress with the picked dict via the `zstd` crate.
    //    `packages/rust` itself doesn't depend on zstd (the helper is
    //    pure hash/select), but the demo + this test-time check pull
    //    it in to prove the integration end-to-end.
    let mut decoder =
        zstd::stream::Decoder::with_dictionary(Cursor::new(&compressed), picked)
            .expect("zstd decoder builds with dict");
    let mut got_plain = Vec::new();
    decoder
        .read_to_end(&mut got_plain)
        .expect("zstd decompresses cleanly");

    // 3) Byte-identical with the reference plaintext.
    assert_eq!(
        got_plain, expected_plain,
        "decompressed bytes MUST match decompressed.bin byte-for-byte"
    );

    // 4) Msgpack-parse and check the token IDs.
    let frames: Vec<_> = decode_msgpack_stream(Cursor::new(&got_plain))
        .collect::<Result<Vec<_>, _>>()
        .expect("frames parse cleanly");

    let mut ids: Vec<u32> = Vec::new();
    for f in &frames {
        ids.extend_from_slice(&f.ids);
    }
    let expected_count = manifest["expected_token_count"]
        .as_u64()
        .expect("manifest.expected_token_count");
    assert_eq!(
        ids.len() as u64,
        expected_count,
        "must recover {} token IDs",
        expected_count
    );

    let expected_first_10: Vec<u32> = manifest["expected_first_10_ids"]
        .as_array()
        .expect("expected_first_10_ids array")
        .iter()
        .map(|v| v.as_u64().expect("u32 token id") as u32)
        .collect();
    assert_eq!(
        &ids[..10],
        expected_first_10.as_slice(),
        "first 10 token IDs MUST match manifest"
    );

    // And the hardcoded check from the task description, so the
    // assertion is visible in this file too.
    assert_eq!(
        &ids[..10],
        &[53365u32, 1593, 7552, 57218, 5371, 37, 11278, 43, 9909, 2773]
    );
}

// Compile-time guard: the test file lives at packages/rust/tests, so the
// fixture is two levels up (../bench/fixtures/dict-zstd-interop).
#[test]
fn fixture_root_exists() {
    let r = fixture_root();
    assert!(
        r.is_dir(),
        "fixture root must exist at {} (re-check repo layout)",
        r.display()
    );
    for f in ["dict.bin", "compressed.bin", "decompressed.bin", "manifest.json"] {
        let p: PathBuf = r.join(f);
        assert!(
            Path::new(&p).is_file(),
            "missing fixture file: {}",
            p.display()
        );
    }
}
