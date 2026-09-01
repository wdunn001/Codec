/**
 * Synthetic HuggingFace tokenizer.json fixtures.
 *
 * Small, deterministic, no network. Each one exercises a different path in
 * convertHFTokenizer(): byte_level, metaspace with byte_fallback, and a
 * minimal "no extras" map.
 */
import type { HFTokenizerJson } from '../src/convert.ts';
import { encodeByteLevelChars, METASPACE } from '@codecai/web';

// ── byte_level (Llama-3 / Qwen-2 / Phi-3 / DeepSeek-V3 family) ──────────────

export function makeByteLevelHF(): HFTokenizerJson {
  const sp = encodeByteLevelChars(new Uint8Array([0x20])); // " " → "Ġ"
  return {
    pre_tokenizer: {
      type: 'Sequence',
      pretokenizers: [
        {
          type: 'Split',
          pattern: { Regex: ` ?[A-Za-z]+| ?[^A-Za-z\\s]+|\\s+` },
        },
        { type: 'ByteLevel' },
      ],
    },
    decoder: { type: 'ByteLevel' },
    model: {
      type: 'BPE',
      vocab: {
        h: 0, e: 1, l: 2, o: 3,
        w: 4, r: 5, d: 6,
        [sp]: 7, '!': 8,
        he: 9, hel: 10, hell: 11, hello: 12,
        [sp + 'world']: 13,
      },
      merges: ['h e', 'he l', 'hel l', 'hell o', sp + ' world'],
    },
    added_tokens: [
      { id: 100, content: '<|endoftext|>', special: true },
      { id: 101, content: '<|im_start|>', special: true },
    ],
  };
}

// ── metaspace + byte_fallback (Llama-2 / Mistral-v3 / Mixtral / Gemma) ──────

export function makeMetaspaceHF(): HFTokenizerJson {
  // Construct a 256-entry byte fallback range starting at id 3.
  const vocab: Record<string, number> = {
    '<unk>': 0,
    '<s>': 1,
    '</s>': 2,
  };
  for (let i = 0; i < 256; i++) {
    const hex = i.toString(16).padStart(2, '0').toUpperCase();
    vocab[`<0x${hex}>`] = 3 + i;
  }
  // Add some realistic vocab entries above the byte-fallback range.
  vocab[METASPACE + 'h'] = 259;
  vocab[METASPACE + 'he'] = 260;
  vocab[METASPACE + 'hello'] = 261;
  return {
    pre_tokenizer: { type: 'Metaspace', replacement: METASPACE },
    decoder: {
      type: 'Sequence',
      decoders: [
        { type: 'Replace', pattern: { String: METASPACE }, content: ' ' },
        { type: 'ByteFallback' },
        { type: 'Fuse' },
      ],
    },
    model: {
      type: 'BPE',
      vocab,
      merges: [METASPACE + ' h', METASPACE + 'h e', METASPACE + 'he llo'],
      byte_fallback: true,
    },
    added_tokens: [
      { id: 0, content: '<unk>', special: true },
      { id: 1, content: '<s>', special: true },
      { id: 2, content: '</s>', special: true },
    ],
  };
}

// ── Pair-format merges (newer HF tokenizer.json variants) ──────────────────

export function makePairFormatMergesHF(): HFTokenizerJson {
  return {
    pre_tokenizer: {
      type: 'Sequence',
      pretokenizers: [
        { type: 'Split', pattern: { Regex: '\\S+' } },
        { type: 'ByteLevel' },
      ],
    },
    decoder: { type: 'ByteLevel' },
    model: {
      type: 'BPE',
      vocab: { a: 0, b: 1, ab: 2 },
      // Some HF dumps store merges as [["a","b"], ...].
      merges: [['a', 'b']] as unknown as string[],
    },
    added_tokens: [],
  };
}
