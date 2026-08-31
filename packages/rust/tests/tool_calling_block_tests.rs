// SPDX-License-Identifier: MIT
//! TokenizerMap.tool_calling block: round-trip + validation.
//!
//! Mirrors the Python smoke tests in packages/python (and TS unit tests on
//! the @codecai/web side that the field was originally added to). Confirms
//! that the spec's `tool_calling` map field deserialises into the typed
//! Rust enum tree, that absence is handled, and that the spec's marker-in-
//! special_tokens rule is enforced by validate().

use codec_rs::{
    TokenizerMap, TokenizerMapError, ToolCallingArgsFormat, ToolCallingConvention,
    ToolCallingResultFormat,
};

const FULL_QWEN25_MAP_JSON: &str = r#"{
    "id": "qwen/qwen2",
    "version": "2",
    "vocab_size": 151665,
    "vocab": {"Hello": 9707, "Ġworld": 1879},
    "encoder": "byte_level",
    "special_tokens": {"<tool_call>": 151657, "</tool_call>": 151658},
    "tool_calling": {
        "convention": "qwen25",
        "markers": {"start": "<tool_call>", "end": "</tool_call>"},
        "args_format": "json",
        "result_format": "json"
    }
}"#;

#[test]
fn tool_calling_block_round_trip_qwen25() {
    let map = TokenizerMap::from_json_str(FULL_QWEN25_MAP_JSON).expect("parse ok");
    let tc = map.tool_calling.expect("tool_calling present");
    assert_eq!(tc.convention, ToolCallingConvention::Qwen25);
    assert_eq!(tc.markers.start, "<tool_call>");
    assert_eq!(tc.markers.end, "</tool_call>");
    assert_eq!(tc.args_format, ToolCallingArgsFormat::Json);
    assert_eq!(tc.result_format, ToolCallingResultFormat::Json);
}

#[test]
fn tool_calling_absent_round_trips_as_none() {
    let json = r#"{
        "id": "plain/no-tools",
        "version": "2",
        "vocab_size": 1,
        "vocab": {"a": 0}
    }"#;
    let map = TokenizerMap::from_json_str(json).expect("parse ok");
    assert!(map.tool_calling.is_none());
}

#[test]
fn tool_calling_markers_must_exist_in_special_tokens() {
    let json = r#"{
        "id": "x",
        "version": "2",
        "vocab_size": 1,
        "vocab": {"a": 0},
        "special_tokens": {},
        "tool_calling": {
            "convention": "qwen25",
            "markers": {"start": "<x>", "end": "</x>"},
            "args_format": "json",
            "result_format": "json"
        }
    }"#;
    let err = TokenizerMap::from_json_str(json).expect_err("missing markers must reject");
    let msg = match err {
        TokenizerMapError::Validation(m) => m,
        e => panic!("expected Validation error, got {e:?}"),
    };
    assert!(msg.contains("special_tokens"), "msg = {msg}");
}

#[test]
fn tool_calling_unknown_convention_rejected() {
    let json = r#"{
        "id": "x",
        "version": "2",
        "vocab_size": 1,
        "vocab": {"a": 0},
        "special_tokens": {"<x>": 0, "</x>": 1},
        "tool_calling": {
            "convention": "bogus",
            "markers": {"start": "<x>", "end": "</x>"},
            "args_format": "json",
            "result_format": "json"
        }
    }"#;
    // serde catches unknown enum variants at parse time.
    let err = TokenizerMap::from_json_str(json).expect_err("unknown convention must reject");
    matches!(err, TokenizerMapError::Parse(_));
}

#[test]
fn tool_calling_llama3_python_args_round_trip() {
    let json = r#"{
        "id": "meta-llama/llama-3",
        "version": "2",
        "vocab_size": 128256,
        "vocab": {"a": 0},
        "special_tokens": {"<|python_tag|>": 128010, "<|eom_id|>": 128008},
        "tool_calling": {
            "convention": "llama3",
            "markers": {"start": "<|python_tag|>", "end": "<|eom_id|>"},
            "args_format": "python_args",
            "result_format": "text"
        }
    }"#;
    let map = TokenizerMap::from_json_str(json).expect("parse ok");
    let tc = map.tool_calling.unwrap();
    assert_eq!(tc.convention, ToolCallingConvention::Llama3);
    assert_eq!(tc.args_format, ToolCallingArgsFormat::PythonArgs);
    assert_eq!(tc.result_format, ToolCallingResultFormat::Text);
}
