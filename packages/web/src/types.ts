/**
 * Public types for @codecai/web.
 *
 * A `TokenizerMap` is a per-model dialect — the data needed to encode text
 * into token IDs (for input) and decode IDs back to text (for output). Maps
 * are immutable once published; a new model version publishes a new map at a
 * new URL with a new sha256 hash.
 *
 * Schema version 2 (breaking change from v1):
 *   - `tokens` is replaced by `vocab` (raw form, used by the BPE tokenizer)
 *   - `encoder` describes how raw vocab tokens map to bytes/chars
 *   - `merges` and `pre_tokenizer_pattern` enable client-side BPE encoding
 */

/**
 * A tokenizer dialect for one model (or one model family that shares a
 * tokenizer). Loaded lazily by the client and cached by (id, hash).
 */
export interface TokenizerMap {
  /** Stable, globally unique tokenizer identifier (e.g. `meta-llama/llama-3`). */
  readonly id: string;

  /**
   * Schema version of this map file. Currently `"2"`. Maps with `version="1"`
   * use the legacy `tokens` field and are accepted by the Detokenizer for
   * backwards compatibility but cannot be used by the BPE tokenizer.
   */
  readonly version: string;

  /** Total number of token IDs in the vocabulary. */
  readonly vocab_size: number;

  /**
   * Vocabulary as `{ raw_token_text: id }`. "Raw" means the form stored in
   * HuggingFace `tokenizer.json` — for `byte_level` encoding this contains
   * GPT-2 byte-encoded characters (`Ġ`, etc.); for `metaspace` it contains
   * `▁`-prefixed strings. The Detokenizer applies the appropriate decoder
   * to recover human-readable text.
   */
  readonly vocab?: Readonly<Record<string, number>>;

  /**
   * Legacy v1 vocabulary as `{ decoded_text: id_string }`. Present only on
   * v1 maps. New maps use `vocab` instead.
   */
  readonly tokens?: Readonly<Record<string, string>>;

  /**
   * How vocab tokens are encoded:
   *   - `"byte_level"` — GPT-2 byte→unicode mapping (Llama-3, Qwen, Phi-3, …).
   *   - `"metaspace"`  — `▁` represents a space prefix (SentencePiece-style:
   *                      Llama-2, Mistral-v3, Mixtral, Gemma).
   *   - omitted        — identity (vocab is already decoded text; used by
   *                      simple/test maps and v1 maps).
   */
  readonly encoder?: 'byte_level' | 'metaspace';

  /**
   * BPE merges in priority order. Each entry is two tokens separated by a
   * single space, e.g. `"Ġ a"`. Required by `BPETokenizer`.
   */
  readonly merges?: readonly string[];

  /**
   * Regex pattern that splits input text into pieces before byte-encoding
   * and BPE merging. Required by `BPETokenizer` when `encoder === "byte_level"`
   * unless `pre_tokenizer_program` is present (program is preferred).
   */
  readonly pre_tokenizer_pattern?: string;

  /**
   * Compiled pre-tokenizer program. Preferred over `pre_tokenizer_pattern`
   * when both are present. The program is a small ordered op list that
   * runtimes can execute without a Unicode regex engine — see
   * `spec/PRETOKENIZER_PROGRAM.md` for the schema and op set.
   */
  readonly pre_tokenizer_program?: {
    readonly version: number;
    readonly ops: ReadonlyArray<Readonly<Record<string, unknown>>>;
  };

  /** First ID in the byte-fallback range (inclusive). SentencePiece only. */
  readonly byte_fallback_start?: number;
  /** Last ID in the byte-fallback range (inclusive). SentencePiece only. */
  readonly byte_fallback_end?: number;

  /** Named special tokens. Skipped during text rendering by default. */
  readonly special_tokens?: Readonly<Record<string, number>>;

  readonly published_at?: string;
}

/**
 * Wire frame produced by a Codec-compliant server. Identical shape across
 * MessagePack and Protobuf modes — only the serialization differs.
 */
export interface CodecFrame {
  readonly ids: readonly number[];
  readonly done: boolean;
  readonly finish_reason?: string;
}

/**
 * Pluggable cache for loaded maps. Default is in-memory; browsers can pass a
 * Cache API adapter, Node can pass a file-system adapter, etc.
 */
export interface MapCache {
  get(key: string): Promise<TokenizerMap | undefined>;
  set(key: string, map: TokenizerMap): Promise<void>;
}

/**
 * Common interface every tokenizer implementation satisfies. `BPETokenizer`,
 * `LongestMatchTokenizer`, and any wasm/native adapter all implement this.
 */
export interface Tokenizer {
  readonly id: string;
  encode(text: string): number[];
}
