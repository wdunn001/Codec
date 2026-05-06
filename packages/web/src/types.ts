/**
 * Public types for @codec/web. Mirrors spec/tokenizer-map.schema.json so a map
 * fetched from any Codec-compliant server can be validated against this shape.
 */

/**
 * Per-model decode table. Given a token ID, returns the string fragment it
 * represents. Loaded lazily by the client and cached by (id, hash).
 *
 * Maps are immutable once published — a new model version publishes a new map
 * at a new URL with a new ID. This is the same invariant as a JS package
 * version: same ID + same hash means byte-identical map.
 */
export interface TokenizerMap {
  /** Stable, globally unique tokenizer identifier. */
  readonly id: string;
  /** Semver map version. */
  readonly version: string;
  /** Total number of token IDs in the vocabulary. */
  readonly vocab_size: number;
  /** token_id (string key) → decoded string fragment. */
  readonly tokens: Readonly<Record<string, string>>;
  /** Named special tokens (e.g. `eos`, `bos`). Should not be rendered as text. */
  readonly special_tokens?: Readonly<Record<string, number>>;
  /** First ID in the byte-fallback range (inclusive). */
  readonly byte_fallback_start?: number;
  /** Last ID in the byte-fallback range (inclusive). */
  readonly byte_fallback_end?: number;
  readonly published_at?: string;
}

/**
 * Wire frame produced by a Codec-compliant server. Identical shape across
 * MessagePack and Protobuf modes — only the serialization differs.
 *
 * Mirrors @codec/core's CodecFrame so this package stays decoupled from it.
 */
export interface CodecFrame {
  /** Token IDs emitted by the model in this chunk. */
  readonly ids: readonly number[];
  /** True on the final frame — no more frames will follow. */
  readonly done: boolean;
  /** Set on the final frame. e.g. `"length"`, `"stop"`, `"eos_token"`, `"error"`. */
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
