// SPDX-License-Identifier: MIT
//! Translator tests: mirrors `TranslatorTests.cs`.

mod common;

use codec_rs::Translator;
use common::tiny_map;

#[test]
fn empty_input_returns_empty_output() {
    let m = tiny_map();
    let mut tr = Translator::new(&m, &m);
    assert_eq!(tr.translate(&[], false), Vec::<u32>::new());
}

#[test]
fn reset_clears_text_buffer() {
    let m = tiny_map();
    let mut tr = Translator::new(&m, &m);
    tr.translate(&[3u32, 4], true); // "hello "
    tr.reset();
    assert_eq!(tr.finish(), Vec::<u32>::new());
}

#[test]
fn streaming_chunks_with_word_boundary_buffer() {
    // Use the same v1 longest-match map on both sides. Translate
    // "hello world" in two chunks and verify the second chunk's
    // pre-flush buffer drains correctly via finish().
    let m = tiny_map();
    let mut tr = Translator::new(&m, &m);

    // Chunk 1: "hello ": has trailing whitespace, so should flush
    // through to target encoding. Map is longest-match: "hello"=3,
    // " "=4.
    let part_a = tr.translate(&[3u32, 4], true);
    // Chunk 2: "world": no trailing whitespace, must buffer.
    let part_b = tr.translate(&[5u32], true);
    // Drain.
    let drain = tr.finish();

    // Reassemble all output IDs. They should round-trip back to "hello world".
    let mut all: Vec<u32> = Vec::new();
    all.extend(part_a);
    all.extend(part_b);
    all.extend(drain);

    use codec_rs::Detokenizer;
    let mut d = Detokenizer::new(&m);
    assert_eq!(
        d.render(&all, Default::default()),
        "hello world"
    );
}
