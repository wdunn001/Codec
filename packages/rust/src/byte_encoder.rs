// SPDX-License-Identifier: MIT
//! GPT-2 byte ↔ unicode mapping table and helpers shared by the
//! Detokenizer and BPE encoder.

use std::collections::HashMap;
use std::sync::OnceLock;

/// The metaspace marker (`▁`, U+2581) used by SentencePiece tokenizers.
pub const METASPACE: char = '\u{2581}';

struct Tables {
    byte_to_char: [char; 256],
    char_to_byte: HashMap<u32, u8>,
}

fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        // The GPT-2 bijection: bytes 33-126, 161-172, 174-255 map to
        // themselves (printable / non-control). Other bytes map to
        // U+0100+n.
        let mut bs: Vec<u32> = Vec::with_capacity(256);
        for i in 33..=126u32 {
            bs.push(i);
        }
        for i in 161..=172u32 {
            bs.push(i);
        }
        for i in 174..=255u32 {
            bs.push(i);
        }
        let mut cs: Vec<u32> = bs.clone();
        let mut n: u32 = 0;
        for b in 0u32..256 {
            if !bs.contains(&b) {
                bs.push(b);
                cs.push(256 + n);
                n += 1;
            }
        }
        let mut byte_to_char = ['\0'; 256];
        let mut char_to_byte: HashMap<u32, u8> = HashMap::with_capacity(256);
        for (i, &b) in bs.iter().enumerate() {
            let c = char::from_u32(cs[i]).expect("GPT-2 char point should be valid");
            byte_to_char[b as usize] = c;
            char_to_byte.insert(cs[i], b as u8);
        }
        Tables { byte_to_char, char_to_byte }
    })
}

/// Maps a byte (0 to 255) to its GPT-2-encoded character.
pub fn byte_to_char(b: u8) -> char {
    tables().byte_to_char[b as usize]
}

/// Maps a GPT-2-encoded character codepoint back to a byte; returns
/// `None` if not in the table.
pub fn char_to_byte(c: char) -> Option<u8> {
    tables().char_to_byte.get(&(c as u32)).copied()
}

/// Decode a byte-level BPE token (e.g. `"Ġhello"`) to its raw bytes by
/// reversing the GPT-2 byte→unicode table. Characters outside the table
/// fall back to UTF-8 bytes (defensive: shouldn't happen for valid
/// vocab entries).
pub fn decode_byte_level_token(raw_token: &str) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::with_capacity(raw_token.len());
    for c in raw_token.chars() {
        match char_to_byte(c) {
            Some(b) => buf.push(b),
            None => {
                // Unknown char: emit as UTF-8 bytes.
                let mut tmp = [0u8; 4];
                let s = c.encode_utf8(&mut tmp);
                buf.extend_from_slice(s.as_bytes());
            }
        }
    }
    buf
}

/// Encode raw bytes into a string of GPT-2 byte-encoded characters.
/// The result matches the keys of a byte_level vocab.
pub fn encode_byte_level_chars(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len());
    for &b in bytes {
        s.push(byte_to_char(b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_maps_to_capital_g_with_dot() {
        // 0x20 (space) -> "Ġ" (U+0120) per GPT-2 table.
        assert_eq!(byte_to_char(0x20), '\u{0120}');
        assert_eq!(char_to_byte('\u{0120}'), Some(0x20));
    }

    #[test]
    fn round_trip_all_bytes() {
        for b in 0u8..=255 {
            let c = byte_to_char(b);
            assert_eq!(char_to_byte(c), Some(b));
        }
    }
}
