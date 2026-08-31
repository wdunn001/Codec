// SPDX-License-Identifier: MIT
//! StreamDecoder tests: mirrors `StreamDecoderTests.cs`.

use std::io::{Cursor, Read, Result as IoResult};

use codec_rs::{
    decode_msgpack_stream, decode_protobuf_frame, decode_protobuf_stream, CodecFrame,
};

// Use the public encoders from the stream module for round-trip tests.
use codec_rs::stream::{encode_msgpack_frame, encode_protobuf_frame};

#[test]
fn msgpack_stream_yields_frames_in_order_and_stops_at_done() {
    let frames = [
        CodecFrame::new(vec![1, 2, 3], false, None),
        CodecFrame::new(vec![4, 5], false, None),
        CodecFrame::new(vec![6], true, Some("stop".into())),
    ];
    let mut bytes: Vec<u8> = Vec::new();
    for f in &frames {
        bytes.extend_from_slice(&encode_msgpack_frame(f));
    }
    let cursor = Cursor::new(bytes);
    let collected: Vec<CodecFrame> = decode_msgpack_stream(cursor)
        .collect::<Result<Vec<_>, _>>()
        .expect("frames decode cleanly");
    assert_eq!(collected.len(), 3);
    assert_eq!(collected[0].ids, vec![1u32, 2, 3]);
    assert_eq!(collected[2].ids, vec![6u32]);
    assert!(collected[2].done);
    assert_eq!(collected[2].finish_reason.as_deref(), Some("stop"));
}

#[test]
fn protobuf_stream_reassembles_frames_split_across_chunks() {
    let frames = [
        CodecFrame::new(vec![1, 2], false, None),
        CodecFrame::new(vec![3, 4], false, None),
        CodecFrame::new(vec![5], true, Some("stop".into())),
    ];
    let mut bytes: Vec<u8> = Vec::new();
    for f in &frames {
        bytes.extend_from_slice(&encode_protobuf_frame(f));
    }

    let chunked = ChunkedReader::new(bytes, 7);
    let collected: Vec<CodecFrame> = decode_protobuf_stream(chunked)
        .collect::<Result<Vec<_>, _>>()
        .expect("frames decode cleanly");
    assert_eq!(collected.len(), 3);
    assert_eq!(collected[0].ids, vec![1u32, 2]);
    assert_eq!(collected[1].ids, vec![3u32, 4]);
    assert_eq!(collected[2].ids, vec![5u32]);
}

#[test]
fn decode_protobuf_frame_round_trips_all_fields() {
    let frame = CodecFrame::new(vec![100, 200, 300], true, Some("length".into()));
    let wire = encode_protobuf_frame(&frame);
    // Strip 4-byte length prefix.
    let payload = &wire[4..];
    let decoded = decode_protobuf_frame(payload).expect("decode");
    assert_eq!(decoded.ids, vec![100u32, 200, 300]);
    assert!(decoded.done);
    assert_eq!(decoded.finish_reason.as_deref(), Some("length"));
}

#[test]
fn msgpack_round_trip_via_encoder_and_decoder() {
    // Single frame, exercise the full surface.
    let frame = CodecFrame::new(vec![42, 1234567, 0xFFFFFF], true, Some("eos_token".into()));
    let bytes = encode_msgpack_frame(&frame);
    let cursor = Cursor::new(bytes);
    let mut iter = decode_msgpack_stream(cursor);
    let decoded = iter.next().expect("a frame").expect("decoded");
    assert_eq!(decoded.ids, vec![42u32, 1234567, 0xFFFFFF]);
    assert!(decoded.done);
    assert_eq!(decoded.finish_reason.as_deref(), Some("eos_token"));
}

// ── Async (tokio feature) ─────────────────────────────────────────────────

#[cfg(feature = "tokio")]
#[tokio::test]
async fn async_msgpack_stream_roundtrip() {
    use codec_rs::stream::r#async::decode_msgpack_stream_async;
    use futures_util::StreamExt;

    let frames = [
        CodecFrame::new(vec![10, 20, 30], false, None),
        CodecFrame::new(vec![40], true, Some("eos_token".into())),
    ];
    let mut bytes: Vec<u8> = Vec::new();
    for f in &frames {
        bytes.extend_from_slice(&encode_msgpack_frame(f));
    }
    // Tokio's `Cursor` wrap of std::io::Cursor implements AsyncRead.
    let reader = std::io::Cursor::new(bytes);
    let stream = decode_msgpack_stream_async(reader);
    tokio::pin!(stream);
    let mut collected: Vec<CodecFrame> = Vec::new();
    while let Some(item) = stream.next().await {
        collected.push(item.expect("decoded"));
    }
    assert_eq!(collected.len(), 2);
    assert!(collected[1].done);
    assert_eq!(collected[1].finish_reason.as_deref(), Some("eos_token"));
}

// Reader that returns at most `chunk_size` bytes per read: exercises
// the protobuf decoder's frame-reassembly logic across split reads.
struct ChunkedReader {
    data: Vec<u8>,
    chunk_size: usize,
    pos: usize,
}

impl ChunkedReader {
    fn new(data: Vec<u8>, chunk_size: usize) -> Self {
        Self { data, chunk_size, pos: 0 }
    }
}

impl Read for ChunkedReader {
    fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
        let remaining = self.data.len() - self.pos;
        if remaining == 0 {
            return Ok(0);
        }
        let n = remaining.min(self.chunk_size).min(buf.len());
        buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}
