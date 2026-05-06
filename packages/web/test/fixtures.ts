import type { TokenizerMap } from '../src/types.js';

/**
 * Tiny synthetic vocabulary covering enough cases to exercise every code path:
 * - vocab fragments with overlapping prefixes (longest-match tiebreak)
 * - special tokens (skipped on render unless renderSpecial)
 * - byte-fallback range covering a multi-byte UTF-8 sequence
 */
export const TINY_MAP: TokenizerMap = {
  id: 'test-tiny-v1',
  version: '1.0.0',
  vocab_size: 270,
  tokens: {
    '0': '�', // UNK fallback
    '1': 'h',
    '2': 'he',
    '3': 'hello',
    '4': ' ',
    '5': 'world',
    '6': 'w',
    '7': 'wor',
    '8': '!',
    '9': '\n',
    // 10-265 reserved for byte-fallback (256 bytes)
  },
  special_tokens: {
    eos: 266,
    bos: 267,
  },
  byte_fallback_start: 10,
  byte_fallback_end: 265,
};

/** ID for a raw byte in the byte-fallback range. */
export function byteId(b: number): number {
  return TINY_MAP.byte_fallback_start! + b;
}
