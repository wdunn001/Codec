/** Codec protocol version */
export const CODEC_VERSION = '0.1';

/**
 * A single frame as emitted by a Codec-enabled TGI server.
 * Wire format: MessagePack-encoded, one object per HTTP chunk.
 * Produced by TGI when `parameters.codec = true` in the request.
 */
export interface CodecFrame {
  /** Token IDs emitted by the model in this chunk. */
  ids: number[];
  /** True on the final frame — no more frames will follow. */
  done: boolean;
  /** Set on the final frame. Values: "Length" | "EosToken" | "StopSequence" */
  finish_reason?: string;
}

/** Chunk size (token IDs per TOKENS frame) */
export const TOKENS_PER_FRAME = 64;

export interface HelloPayload {
  codec_version: string;
  /** Tokenizer IDs the client can decode, in preference order */
  accept_tokenizers: string[];
}

export interface ReadyPayload {
  codec_version: string;
  /** Tokenizer the server will use for this session */
  tokenizer_id: string;
  /** URL where the client can fetch the tokenizer map */
  map_url: string;
  /** SHA-256 hex digest of the map for cache validation */
  map_hash: string;
}

export interface TokenizerMap {
  id: string;
  version: string;
  vocab_size: number;
  /** token_id (string key) → decoded string */
  tokens: Record<string, string>;
  special_tokens: Record<string, number>;
  /** Inclusive range of IDs that are raw UTF-8 byte fallbacks */
  byte_fallback_start?: number;
  byte_fallback_end?: number;
}
