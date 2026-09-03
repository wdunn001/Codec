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

/** The canonical GPT-2-family alternation regex, recognised by
 * `compileAlternationOps`. Used by both fixtures below so the Split node's
 * pattern lowers to a real `alternation` program stage instead of the
 * unrecognised-pattern fallback. */
export const GPT2_FAMILY_REGEX =
  "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}+" +
  '| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+';

export function makeByteLevelHF(): HFTokenizerJson {
  const sp = encodeByteLevelChars(new Uint8Array([0x20])); // " " → "Ġ"
  return {
    pre_tokenizer: {
      type: 'Sequence',
      pretokenizers: [
        {
          type: 'Split',
          pattern: { Regex: GPT2_FAMILY_REGEX },
          behavior: 'Isolated',
          invert: false,
        },
        // use_regex: false. The Split above already did the splitting;
        // this stage is byte-encode-only, matching every real HuggingFace
        // dump this converter has been checked against (see
        // convert.ts's compilePreTokenizerStages doc comment).
        { type: 'ByteLevel', use_regex: false },
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

// ── Multi-stage Sequence (SmolLM2 shape): Digits then ByteLevel ────────────
//
// Zero Split nodes. The old `extractPreTokenizerPattern` (which only ever
// looked for a Split node) produced neither a pattern nor a program for
// this shape at all. `compilePreTokenizerStages` lowers `Digits` to a
// `digits_isolate` stage and `ByteLevel(use_regex=true)` to the fixed
// `alternation` stage, in order, with no legacy pattern (two real stages:
// not expressible as one regex).

export function makeSmolLM2LikeHF(): HFTokenizerJson {
  const sp = encodeByteLevelChars(new Uint8Array([0x20]));
  return {
    pre_tokenizer: {
      type: 'Sequence',
      pretokenizers: [
        { type: 'Digits', individual_digits: true },
        { type: 'ByteLevel', use_regex: true },
      ],
    },
    decoder: { type: 'ByteLevel' },
    model: {
      type: 'BPE',
      vocab: {
        a: 0, [sp]: 1, '1': 2, '2': 3, '3': 4,
        [sp + sp]: 5,
      },
      merges: [sp + ' ' + sp],
    },
    added_tokens: [],
  };
}

// ── Multi-stage Sequence (Falcon shape): Punctuation, ByteLevel, Digits,
//    Split(digit-triples) ───────────────────────────────────────────────────

export function makeFalconLikeHF(): HFTokenizerJson {
  return {
    pre_tokenizer: {
      type: 'Sequence',
      pretokenizers: [
        { type: 'Punctuation', behavior: 'Contiguous' },
        { type: 'ByteLevel', use_regex: true },
        { type: 'Digits', individual_digits: false },
        {
          type: 'Split',
          pattern: { Regex: '[0-9][0-9][0-9]' },
          behavior: 'Isolated',
          invert: false,
        },
      ],
    },
    decoder: { type: 'ByteLevel' },
    model: {
      type: 'BPE',
      vocab: { a: 0, b: 1, '.': 2, '1': 3, '2': 4, '3': 5 },
      merges: [],
    },
    added_tokens: [],
  };
}

// ── Multi-stage Sequence (DeepSeek-V3 shape): bounded digit-run Split,
//    CJK-range Split, alternation Split, ByteLevel(use_regex=false) ────────

export function makeDeepSeekLikeHF(): HFTokenizerJson {
  return {
    pre_tokenizer: {
      type: 'Sequence',
      pretokenizers: [
        { type: 'Split', pattern: { Regex: '\\p{N}{1,3}' }, behavior: 'Isolated', invert: false },
        { type: 'Split', pattern: { Regex: '[一-龥぀-ゟ゠-ヿ]+' }, behavior: 'Isolated', invert: false },
        {
          type: 'Split',
          pattern: {
            Regex:
              "[!\"#$%&'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+" +
              '|[^\\r\\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+' +
              '| ?[\\p{P}\\p{S}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+',
          },
          behavior: 'Isolated',
          invert: false,
        },
        { type: 'ByteLevel', use_regex: false },
      ],
    },
    decoder: { type: 'ByteLevel' },
    model: {
      type: 'BPE',
      vocab: { a: 0, b: 1, '1': 2, '2': 3 },
      merges: [],
    },
    added_tokens: [],
  };
}

// ── Unsupported shapes: must FAIL LOUD, never emit an approximation ────────

/** `Punctuation` with the default `Isolated` behavior: only `Contiguous`
 * has a verified faithful lowering. */
export function makeUnsupportedPunctuationHF(): HFTokenizerJson {
  return {
    pre_tokenizer: {
      type: 'Sequence',
      pretokenizers: [
        { type: 'Punctuation' },
        { type: 'ByteLevel', use_regex: true },
      ],
    },
    decoder: { type: 'ByteLevel' },
    model: { type: 'BPE', vocab: { a: 0 }, merges: [] },
    added_tokens: [],
  };
}

/** A `Split` node with `behavior: 'MergedWithPrevious'`: no lowering is
 * implemented for any behavior besides `Isolated` (invert=false) and the
 * `Removed`+invert=true exhaustive-alternation case. */
export function makeUnsupportedSplitBehaviorHF(): HFTokenizerJson {
  return {
    pre_tokenizer: {
      type: 'Split',
      pattern: { Regex: GPT2_FAMILY_REGEX },
      behavior: 'MergedWithPrevious',
      invert: false,
    },
    decoder: { type: 'ByteLevel' },
    model: { type: 'BPE', vocab: { a: 0 }, merges: [] },
    added_tokens: [],
  };
}

/** `Metaspace` nested inside a byte_level `Sequence`: not the top-level
 * lone-`Metaspace` shape `detectEncoder` handles separately. */
export function makeMetaspaceInsideSequenceHF(): HFTokenizerJson {
  return {
    pre_tokenizer: {
      type: 'Sequence',
      pretokenizers: [
        { type: 'Metaspace', replacement: METASPACE },
        { type: 'ByteLevel', use_regex: true },
      ],
    },
    decoder: { type: 'ByteLevel' },
    model: { type: 'BPE', vocab: { a: 0 }, merges: [] },
    added_tokens: [],
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
        {
          type: 'Split',
          pattern: { Regex: GPT2_FAMILY_REGEX },
          behavior: 'Isolated',
          invert: false,
        },
        { type: 'ByteLevel', use_regex: false },
      ],
    },
    decoder: { type: 'ByteLevel' },
    model: {
      type: 'BPE',
      vocab: { a: 0, b: 1, ab: 2 },
      // Some HF dumps store merges as [["a","b"], ...] instead of "a b".
      merges: [['a', 'b']] as unknown as string[],
    },
    added_tokens: [],
  };
}
