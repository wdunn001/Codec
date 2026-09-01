// SPDX-License-Identifier: MIT
//! Stream decoders for the two Codec wire formats.
//!
//! Adapt any `std::io::Read` (sync) or `tokio::io::AsyncRead` (async,
//! behind the `tokio` feature) into an iterator/stream of [`CodecFrame`]s.

use std::io::Read;

use crate::frame::CodecFrame;

/// Errors raised by the stream decoders.
#[derive(Debug, thiserror::Error)]
pub enum StreamError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid msgpack frame: {0}")]
    Msgpack(String),
    #[error("invalid protobuf frame: {0}")]
    Protobuf(String),
}

// ── Public sync iterator constructors ─────────────────────────────────────

/// Yield frames from a stream of concatenated MessagePack maps.
///
/// Frame shape: `{"ids": [int...], "done": bool, "finish_reason"?: str}`.
pub fn decode_msgpack_stream<R: Read>(reader: R) -> MsgpackFrameIter<R> {
    MsgpackFrameIter {
        reader,
        buf: Vec::new(),
        eof: false,
        done_seen: false,
    }
}

/// Yield frames from a stream of length-prefixed protobuf `CodecFrame`
/// payloads. Wire: 4-byte big-endian length followed by the protobuf
/// bytes.
pub fn decode_protobuf_stream<R: Read>(reader: R) -> ProtobufFrameIter<R> {
    ProtobufFrameIter {
        reader,
        buf: Vec::new(),
        eof: false,
        done_seen: false,
    }
}

// ── MessagePack iterator ──────────────────────────────────────────────────

/// Iterator over MessagePack frames pulled from `R`.
pub struct MsgpackFrameIter<R: Read> {
    reader: R,
    buf: Vec<u8>,
    eof: bool,
    done_seen: bool,
}

impl<R: Read> Iterator for MsgpackFrameIter<R> {
    type Item = Result<CodecFrame, StreamError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done_seen {
            return None;
        }
        loop {
            // Try to find the end of the next msgpack value in `buf`.
            match msgpack_end_offset(&self.buf, 0) {
                Ok(end) => {
                    // We have a complete frame: parse fields manually.
                    let frame = match decode_msgpack_frame(&self.buf[..end]) {
                        Ok(f) => f,
                        Err(e) => return Some(Err(e)),
                    };
                    // Drop consumed bytes.
                    self.buf.drain(..end);
                    if frame.done {
                        self.done_seen = true;
                    }
                    return Some(Ok(frame));
                }
                Err(MsgpackBoundaryError::Incomplete) => {
                    if self.eof {
                        if self.buf.is_empty() {
                            return None;
                        }
                        return Some(Err(StreamError::Msgpack(
                            "stream ended mid-frame".into(),
                        )));
                    }
                    let mut tmp = [0u8; 16 * 1024];
                    match self.reader.read(&mut tmp) {
                        Ok(0) => {
                            self.eof = true;
                            if self.buf.is_empty() {
                                return None;
                            }
                            // Loop one more time so we can produce the
                            // mid-frame error.
                        }
                        Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                        Err(e) => return Some(Err(StreamError::Io(e))),
                    }
                }
                Err(MsgpackBoundaryError::Invalid(msg)) => {
                    return Some(Err(StreamError::Msgpack(msg)));
                }
            }
        }
    }
}

// Hand-rolled msgpack value-boundary scanner. Just enough of the
// msgpack spec to bound a single value (one frame). Mirrors
// `_msgpack_end_offset` in `packages/python/src/codecai/stream.py`.
enum MsgpackBoundaryError {
    Incomplete,
    Invalid(String),
}

fn msgpack_end_offset(data: &[u8], pos: usize) -> Result<usize, MsgpackBoundaryError> {
    if pos >= data.len() {
        return Err(MsgpackBoundaryError::Incomplete);
    }
    let b = data[pos];

    // positive fixint, negative fixint, fixstr (covered below), nil, false, true
    if b <= 0x7F || b >= 0xE0 {
        return Ok(pos + 1);
    }
    if b == 0xC0 || b == 0xC2 || b == 0xC3 {
        return Ok(pos + 1);
    }

    // fixstr (0xA0-0xBF)
    if (0xA0..=0xBF).contains(&b) {
        return need(data, pos + 1 + (b & 0x1F) as usize);
    }
    // fixarray (0x90-0x9F)
    if (0x90..=0x9F).contains(&b) {
        let n = (b & 0x0F) as usize;
        return array_end(data, pos + 1, n);
    }
    // fixmap (0x80-0x8F)
    if (0x80..=0x8F).contains(&b) {
        let n = (b & 0x0F) as usize;
        return array_end(data, pos + 1, n * 2);
    }

    // bin/str/array/map with explicit length
    if b == 0xC4 || b == 0xC5 || b == 0xC6 {
        return len_prefixed(data, pos, len_size(b)?);
    }
    if b == 0xD9 || b == 0xDA || b == 0xDB {
        return len_prefixed(data, pos, len_size(b)?);
    }
    if b == 0xDC || b == 0xDD {
        let size = if b == 0xDC { 2 } else { 4 };
        if pos + 1 + size > data.len() {
            return Err(MsgpackBoundaryError::Incomplete);
        }
        let n = read_be_u32(&data[pos + 1..pos + 1 + size])?;
        return array_end(data, pos + 1 + size, n as usize);
    }
    if b == 0xDE || b == 0xDF {
        let size = if b == 0xDE { 2 } else { 4 };
        if pos + 1 + size > data.len() {
            return Err(MsgpackBoundaryError::Incomplete);
        }
        let n = read_be_u32(&data[pos + 1..pos + 1 + size])?;
        return array_end(data, pos + 1 + size, (n as usize) * 2);
    }

    let width = match b {
        0xCC => Some(1),
        0xCD => Some(2),
        0xCE => Some(4),
        0xCF => Some(8),
        0xD0 => Some(1),
        0xD1 => Some(2),
        0xD2 => Some(4),
        0xD3 => Some(8),
        0xCA => Some(4),
        0xCB => Some(8),
        0xD4 => Some(2),
        0xD5 => Some(3),
        0xD6 => Some(5),
        0xD7 => Some(9),
        0xD8 => Some(17),
        _ => None,
    };
    if let Some(w) = width {
        return need(data, pos + 1 + w);
    }

    if b == 0xC7 || b == 0xC8 || b == 0xC9 {
        let size = len_size(b)?;
        if pos + 1 + size + 1 > data.len() {
            return Err(MsgpackBoundaryError::Incomplete);
        }
        let n = read_be_u32(&data[pos + 1..pos + 1 + size])?;
        return need(data, pos + 1 + size + 1 + n as usize);
    }

    Err(MsgpackBoundaryError::Invalid(format!(
        "unsupported byte 0x{b:02X} at offset {pos}"
    )))
}

fn len_size(prefix: u8) -> Result<usize, MsgpackBoundaryError> {
    match prefix {
        0xC4 | 0xC7 | 0xD9 => Ok(1),
        0xC5 | 0xC8 | 0xDA => Ok(2),
        0xC6 | 0xC9 | 0xDB => Ok(4),
        _ => Err(MsgpackBoundaryError::Invalid(format!(
            "unexpected length-prefix byte 0x{prefix:02X}"
        ))),
    }
}

fn len_prefixed(data: &[u8], pos: usize, size: usize) -> Result<usize, MsgpackBoundaryError> {
    if pos + 1 + size > data.len() {
        return Err(MsgpackBoundaryError::Incomplete);
    }
    let n = read_be_u32(&data[pos + 1..pos + 1 + size])?;
    need(data, pos + 1 + size + n as usize)
}

fn need(data: &[u8], end: usize) -> Result<usize, MsgpackBoundaryError> {
    if end > data.len() {
        Err(MsgpackBoundaryError::Incomplete)
    } else {
        Ok(end)
    }
}

fn array_end(data: &[u8], mut pos: usize, n: usize) -> Result<usize, MsgpackBoundaryError> {
    for _ in 0..n {
        pos = msgpack_end_offset(data, pos)?;
    }
    Ok(pos)
}

fn read_be_u32(slice: &[u8]) -> Result<u32, MsgpackBoundaryError> {
    let mut v: u32 = 0;
    for &b in slice {
        v = (v << 8) | b as u32;
    }
    Ok(v)
}

// Decode a single complete msgpack frame slice into a CodecFrame.
fn decode_msgpack_frame(data: &[u8]) -> Result<CodecFrame, StreamError> {
    let mut p = MsgpackParser::new(data);
    let map_len = p.read_map_header()?;
    let mut ids: Vec<u32> = Vec::new();
    let mut done = false;
    let mut finish_reason: Option<String> = None;
    for _ in 0..map_len {
        let key = p.read_str()?;
        match key.as_str() {
            "ids" => {
                let n = p.read_array_header()?;
                ids.reserve(n);
                for _ in 0..n {
                    ids.push(p.read_int_u32()?);
                }
            }
            "done" => {
                done = p.read_bool()?;
            }
            "finish_reason" => {
                if p.try_read_nil() {
                    finish_reason = None;
                } else {
                    finish_reason = Some(p.read_str()?);
                }
            }
            _ => {
                p.skip_value()?;
            }
        }
    }
    Ok(CodecFrame { ids, done, finish_reason })
}

struct MsgpackParser<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> MsgpackParser<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn next_byte(&mut self) -> Result<u8, StreamError> {
        if self.pos >= self.data.len() {
            return Err(StreamError::Msgpack("truncated".into()));
        }
        let b = self.data[self.pos];
        self.pos += 1;
        Ok(b)
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], StreamError> {
        if self.pos + n > self.data.len() {
            return Err(StreamError::Msgpack("truncated".into()));
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn read_map_header(&mut self) -> Result<usize, StreamError> {
        let b = self.next_byte()?;
        if (0x80..=0x8F).contains(&b) {
            return Ok((b & 0x0F) as usize);
        }
        if b == 0xDE {
            let s = self.take(2)?;
            return Ok(((s[0] as usize) << 8) | s[1] as usize);
        }
        if b == 0xDF {
            let s = self.take(4)?;
            return Ok(((s[0] as usize) << 24)
                | ((s[1] as usize) << 16)
                | ((s[2] as usize) << 8)
                | s[3] as usize);
        }
        Err(StreamError::Msgpack(format!(
            "expected map header, got 0x{b:02X}"
        )))
    }
    fn read_array_header(&mut self) -> Result<usize, StreamError> {
        let b = self.next_byte()?;
        if (0x90..=0x9F).contains(&b) {
            return Ok((b & 0x0F) as usize);
        }
        if b == 0xDC {
            let s = self.take(2)?;
            return Ok(((s[0] as usize) << 8) | s[1] as usize);
        }
        if b == 0xDD {
            let s = self.take(4)?;
            return Ok(((s[0] as usize) << 24)
                | ((s[1] as usize) << 16)
                | ((s[2] as usize) << 8)
                | s[3] as usize);
        }
        Err(StreamError::Msgpack(format!(
            "expected array header, got 0x{b:02X}"
        )))
    }
    fn read_str(&mut self) -> Result<String, StreamError> {
        let b = self.next_byte()?;
        let len = if (0xA0..=0xBF).contains(&b) {
            (b & 0x1F) as usize
        } else if b == 0xD9 {
            self.next_byte()? as usize
        } else if b == 0xDA {
            let s = self.take(2)?;
            ((s[0] as usize) << 8) | s[1] as usize
        } else if b == 0xDB {
            let s = self.take(4)?;
            ((s[0] as usize) << 24)
                | ((s[1] as usize) << 16)
                | ((s[2] as usize) << 8)
                | s[3] as usize
        } else {
            return Err(StreamError::Msgpack(format!(
                "expected string, got 0x{b:02X}"
            )));
        };
        let bytes = self.take(len)?;
        std::str::from_utf8(bytes)
            .map(|s| s.to_string())
            .map_err(|_| StreamError::Msgpack("invalid utf-8 in string".into()))
    }
    fn read_int_u32(&mut self) -> Result<u32, StreamError> {
        let b = self.next_byte()?;
        // positive fixint
        if b <= 0x7F {
            return Ok(b as u32);
        }
        match b {
            0xCC => Ok(self.next_byte()? as u32),
            0xCD => {
                let s = self.take(2)?;
                Ok(((s[0] as u32) << 8) | s[1] as u32)
            }
            0xCE => {
                let s = self.take(4)?;
                Ok(((s[0] as u32) << 24)
                    | ((s[1] as u32) << 16)
                    | ((s[2] as u32) << 8)
                    | s[3] as u32)
            }
            0xCF => {
                let s = self.take(8)?;
                let mut v: u64 = 0;
                for &byte in s {
                    v = (v << 8) | byte as u64;
                }
                Ok(v as u32)
            }
            // signed ints (we coerce to u32: match .NET ReadInt32 behavior)
            0xD0 => Ok((self.next_byte()? as i8) as u32),
            0xD1 => {
                let s = self.take(2)?;
                Ok((((s[0] as i16) << 8) | s[1] as i16) as u32)
            }
            0xD2 => {
                let s = self.take(4)?;
                Ok((((s[0] as i32) << 24)
                    | ((s[1] as i32) << 16)
                    | ((s[2] as i32) << 8)
                    | s[3] as i32) as u32)
            }
            _ => Err(StreamError::Msgpack(format!(
                "expected int, got 0x{b:02X}"
            ))),
        }
    }
    fn read_bool(&mut self) -> Result<bool, StreamError> {
        match self.next_byte()? {
            0xC2 => Ok(false),
            0xC3 => Ok(true),
            other => Err(StreamError::Msgpack(format!(
                "expected bool, got 0x{other:02X}"
            ))),
        }
    }
    fn try_read_nil(&mut self) -> bool {
        if self.pos < self.data.len() && self.data[self.pos] == 0xC0 {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn skip_value(&mut self) -> Result<(), StreamError> {
        match msgpack_end_offset(self.data, self.pos) {
            Ok(end) => {
                self.pos = end;
                Ok(())
            }
            Err(MsgpackBoundaryError::Incomplete) => {
                Err(StreamError::Msgpack("truncated value to skip".into()))
            }
            Err(MsgpackBoundaryError::Invalid(m)) => Err(StreamError::Msgpack(m)),
        }
    }
}

// ── Protobuf iterator ─────────────────────────────────────────────────────

/// Iterator over length-prefixed protobuf frames pulled from `R`.
pub struct ProtobufFrameIter<R: Read> {
    reader: R,
    buf: Vec<u8>,
    eof: bool,
    done_seen: bool,
}

impl<R: Read> Iterator for ProtobufFrameIter<R> {
    type Item = Result<CodecFrame, StreamError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done_seen {
            return None;
        }
        // Need 4 bytes for length prefix.
        while self.buf.len() < 4 {
            if self.eof {
                if self.buf.is_empty() {
                    return None;
                }
                return Some(Err(StreamError::Protobuf(format!(
                    "stream ended mid-frame ({} bytes left)",
                    self.buf.len()
                ))));
            }
            let mut tmp = [0u8; 16 * 1024];
            match self.reader.read(&mut tmp) {
                Ok(0) => {
                    self.eof = true;
                }
                Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                Err(e) => return Some(Err(StreamError::Io(e))),
            }
        }

        let frame_len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]])
            as usize;

        while self.buf.len() < 4 + frame_len {
            if self.eof {
                return Some(Err(StreamError::Protobuf(format!(
                    "stream ended mid-frame (need {frame_len} bytes)"
                ))));
            }
            let mut tmp = [0u8; 16 * 1024];
            match self.reader.read(&mut tmp) {
                Ok(0) => {
                    self.eof = true;
                }
                Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                Err(e) => return Some(Err(StreamError::Io(e))),
            }
        }

        let payload: Vec<u8> = self.buf[4..4 + frame_len].to_vec();
        self.buf.drain(..4 + frame_len);

        let frame = match decode_protobuf_frame(&payload) {
            Ok(f) => f,
            Err(e) => return Some(Err(e)),
        };
        if frame.done {
            self.done_seen = true;
        }
        Some(Ok(frame))
    }
}

/// Decode a single CodecFrame protobuf payload (no length prefix).
pub fn decode_protobuf_frame(data: &[u8]) -> Result<CodecFrame, StreamError> {
    let mut ids: Vec<u32> = Vec::new();
    let mut done = false;
    let mut finish_reason: Option<String> = None;
    let mut pos = 0usize;

    while pos < data.len() {
        let (tag, np) = read_varint(data, pos)?;
        pos = np;
        let field = (tag >> 3) as u32;
        let wt = (tag & 0x07) as u32;

        match wt {
            0 => {
                // varint
                let (val, np2) = read_varint(data, pos)?;
                pos = np2;
                if field == 2 {
                    done = val != 0;
                }
            }
            1 => {
                // 64-bit fixed
                if pos + 8 > data.len() {
                    return Err(StreamError::Protobuf("truncated 64-bit field".into()));
                }
                pos += 8;
            }
            2 => {
                // length-delimited
                let (len, np3) = read_varint(data, pos)?;
                pos = np3;
                let len = len as usize;
                if pos + len > data.len() {
                    return Err(StreamError::Protobuf("truncated length-delimited field".into()));
                }
                let chunk = &data[pos..pos + len];
                pos += len;
                if field == 1 {
                    // packed repeated uint32 ids
                    let mut p = 0usize;
                    while p < chunk.len() {
                        let (id, npp) = read_varint(chunk, p)?;
                        p = npp;
                        ids.push(id as u32);
                    }
                } else if field == 3 {
                    finish_reason = Some(
                        std::str::from_utf8(chunk)
                            .map_err(|_| {
                                StreamError::Protobuf("invalid utf-8 in finish_reason".into())
                            })?
                            .to_string(),
                    );
                }
            }
            5 => {
                // 32-bit fixed
                if pos + 4 > data.len() {
                    return Err(StreamError::Protobuf("truncated 32-bit field".into()));
                }
                pos += 4;
            }
            other => {
                return Err(StreamError::Protobuf(format!(
                    "unknown wire type {other} in CodecFrame field {field}"
                )));
            }
        }
    }

    Ok(CodecFrame { ids, done, finish_reason })
}

fn read_varint(data: &[u8], mut pos: usize) -> Result<(u64, usize), StreamError> {
    let mut result: u64 = 0;
    let mut shift: u32 = 0;
    loop {
        if pos >= data.len() {
            return Err(StreamError::Protobuf("truncated varint".into()));
        }
        let b = data[pos];
        pos += 1;
        result |= ((b & 0x7F) as u64) << shift;
        if (b & 0x80) == 0 {
            return Ok((result, pos));
        }
        shift += 7;
        if shift > 63 {
            return Err(StreamError::Protobuf("varint too long".into()));
        }
    }
}

// ── Encoders for tests / parity helpers ──────────────────────────────────

/// Encode `frame` as a single MessagePack map. Used by tests and any
/// caller that wants to round-trip via the wire format.
pub fn encode_msgpack_frame(frame: &CodecFrame) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(32 + frame.ids.len() * 5);
    let field_count = if frame.finish_reason.is_some() { 3 } else { 2 };
    write_map_header(&mut out, field_count);
    write_str(&mut out, "ids");
    write_array_header(&mut out, frame.ids.len());
    for &id in &frame.ids {
        write_uint_u32(&mut out, id);
    }
    write_str(&mut out, "done");
    out.push(if frame.done { 0xC3 } else { 0xC2 });
    if let Some(reason) = &frame.finish_reason {
        write_str(&mut out, "finish_reason");
        write_str(&mut out, reason);
    }
    out
}

/// Encode `frame` as a length-prefixed protobuf frame (4-byte BE length + payload).
pub fn encode_protobuf_frame(frame: &CodecFrame) -> Vec<u8> {
    let mut payload: Vec<u8> = Vec::new();
    if !frame.ids.is_empty() {
        let mut packed: Vec<u8> = Vec::new();
        for &id in &frame.ids {
            write_varint(&mut packed, id as u64);
        }
        payload.push(0x0A);
        write_varint(&mut payload, packed.len() as u64);
        payload.extend_from_slice(&packed);
    }
    payload.push(0x10);
    payload.push(if frame.done { 1 } else { 0 });
    if let Some(reason) = &frame.finish_reason {
        let bytes = reason.as_bytes();
        payload.push(0x1A);
        write_varint(&mut payload, bytes.len() as u64);
        payload.extend_from_slice(bytes);
    }

    let mut out = Vec::with_capacity(4 + payload.len());
    let len = payload.len() as u32;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&payload);
    out
}

fn write_map_header(out: &mut Vec<u8>, n: usize) {
    if n <= 0x0F {
        out.push(0x80 | n as u8);
    } else if n <= 0xFFFF {
        out.push(0xDE);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(0xDF);
        out.extend_from_slice(&(n as u32).to_be_bytes());
    }
}

fn write_array_header(out: &mut Vec<u8>, n: usize) {
    if n <= 0x0F {
        out.push(0x90 | n as u8);
    } else if n <= 0xFFFF {
        out.push(0xDC);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(0xDD);
        out.extend_from_slice(&(n as u32).to_be_bytes());
    }
}

fn write_str(out: &mut Vec<u8>, s: &str) {
    let b = s.as_bytes();
    let n = b.len();
    if n <= 0x1F {
        out.push(0xA0 | n as u8);
    } else if n <= 0xFF {
        out.push(0xD9);
        out.push(n as u8);
    } else if n <= 0xFFFF {
        out.push(0xDA);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(0xDB);
        out.extend_from_slice(&(n as u32).to_be_bytes());
    }
    out.extend_from_slice(b);
}

fn write_uint_u32(out: &mut Vec<u8>, v: u32) {
    if v <= 0x7F {
        out.push(v as u8);
    } else if v <= 0xFF {
        out.push(0xCC);
        out.push(v as u8);
    } else if v <= 0xFFFF {
        out.push(0xCD);
        out.extend_from_slice(&(v as u16).to_be_bytes());
    } else {
        out.push(0xCE);
        out.extend_from_slice(&v.to_be_bytes());
    }
}

fn write_varint(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let bits = (n & 0x7F) as u8;
        n >>= 7;
        if n == 0 {
            out.push(bits);
            return;
        }
        out.push(bits | 0x80);
    }
}

// ── Async (tokio feature) ─────────────────────────────────────────────────

/// Async variants of the stream decoders, gated behind the `tokio`
/// feature. Returns `futures::Stream<Item = Result<CodecFrame>>`.
#[cfg(feature = "tokio")]
pub mod r#async {
    use super::{decode_msgpack_frame, decode_protobuf_frame, msgpack_end_offset,
                MsgpackBoundaryError, StreamError};
    use crate::frame::CodecFrame;
    use async_stream::try_stream;
    use futures_util::Stream;
    use tokio::io::{AsyncRead, AsyncReadExt};

    /// Async msgpack frame stream from any [`tokio::io::AsyncRead`].
    pub fn decode_msgpack_stream_async<R>(
        mut reader: R,
    ) -> impl Stream<Item = Result<CodecFrame, StreamError>>
    where
        R: AsyncRead + Unpin,
    {
        try_stream! {
            let mut buf: Vec<u8> = Vec::new();
            let mut tmp = [0u8; 16 * 1024];
            let mut eof = false;
            loop {
                match msgpack_end_offset(&buf, 0) {
                    Ok(end) => {
                        let frame = decode_msgpack_frame(&buf[..end])?;
                        buf.drain(..end);
                        let done = frame.done;
                        yield frame;
                        if done {
                            return;
                        }
                    }
                    Err(MsgpackBoundaryError::Incomplete) => {
                        if eof {
                            if buf.is_empty() {
                                return;
                            }
                            Err(StreamError::Msgpack("stream ended mid-frame".into()))?;
                        }
                        let n = reader.read(&mut tmp).await
                            .map_err(StreamError::Io)?;
                        if n == 0 {
                            eof = true;
                            if buf.is_empty() {
                                return;
                            }
                        } else {
                            buf.extend_from_slice(&tmp[..n]);
                        }
                    }
                    Err(MsgpackBoundaryError::Invalid(m)) => {
                        Err(StreamError::Msgpack(m))?;
                    }
                }
            }
        }
    }

    /// Async protobuf (length-prefixed) frame stream.
    pub fn decode_protobuf_stream_async<R>(
        mut reader: R,
    ) -> impl Stream<Item = Result<CodecFrame, StreamError>>
    where
        R: AsyncRead + Unpin,
    {
        try_stream! {
            let mut buf: Vec<u8> = Vec::new();
            let mut tmp = [0u8; 16 * 1024];
            let mut eof = false;
            loop {
                while buf.len() < 4 {
                    if eof {
                        if buf.is_empty() {
                            return;
                        }
                        Err(StreamError::Protobuf(format!(
                            "stream ended mid-frame ({} bytes left)", buf.len()
                        )))?;
                    }
                    let n = reader.read(&mut tmp).await
                        .map_err(StreamError::Io)?;
                    if n == 0 {
                        eof = true;
                    } else {
                        buf.extend_from_slice(&tmp[..n]);
                    }
                }

                let frame_len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
                while buf.len() < 4 + frame_len {
                    if eof {
                        Err(StreamError::Protobuf(format!(
                            "stream ended mid-frame (need {frame_len} bytes)"
                        )))?;
                    }
                    let n = reader.read(&mut tmp).await
                        .map_err(StreamError::Io)?;
                    if n == 0 {
                        eof = true;
                    } else {
                        buf.extend_from_slice(&tmp[..n]);
                    }
                }

                let payload: Vec<u8> = buf[4..4 + frame_len].to_vec();
                buf.drain(..4 + frame_len);

                let frame = decode_protobuf_frame(&payload)?;
                let done = frame.done;
                yield frame;
                if done {
                    return;
                }
            }
        }
    }
}
