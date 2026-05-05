/** Codec protocol version */
export const CODEC_VERSION = '0.1';

/**
 * The Codec binary wire frame — the protocol contract.
 *
 * Global Rules: CLAUDE.md, AGENTS.md
 *
 * Contract Rules:
 * - `ids` contains raw model token IDs (uint32). No text ever crosses this boundary.
 * - `done` signals end of stream. No further frames follow after it.
 * - `finish_reason` is only set on the final frame (when done=true).
 * - Frames are MessagePack-encoded, one per HTTP chunk. Wire cost: ~4 bytes/token.
 *
 * Implementations:
 * - packages/client/src/client.ts       TypeScript decoder (client)
 * - vllm/entrypoints/codec_frame.py     Python encoder/decoder (server)
 *
 * Do Not:
 * - Add text fields. Eliminating text on the wire is the entire point.
 * - Buffer frames before yielding. Streaming latency is a first-class concern.
 */
export interface CodecFrame {
  /** Token IDs emitted by the model in this chunk. */
  ids: number[];
  /** True on the final frame — no more frames will follow. */
  done: boolean;
  /** Set on the final frame. Values: "length" | "eos_token" | "stop_sequence" */
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
