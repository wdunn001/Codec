/**
 * Detokenizer — IDs → text. Invoked only when a human is going to read the
 * output. Agent-to-agent calls skip this layer entirely.
 *
 * Three correctness concerns it has to get right:
 *
 *   1. Per-token decoding. The way to recover text from a token's vocab key
 *      depends on the map's `encoder` field:
 *        byte_level — each vocab key is a string of GPT-2-encoded bytes
 *                     (Llama-3, Qwen, Phi-3 …); reverse the byte table.
 *        metaspace  — each vocab key is a ▁-prefixed string (Llama-2,
 *                     Mistral-v3, Mixtral, Gemma); replace ▁ with space.
 *        identity   — vocab keys are already decoded text (test fixtures,
 *                     v1 schema maps).
 *
 *   2. Byte-fallback range. SentencePiece-style maps reserve IDs for raw
 *      bytes 0x00–0xFF. These tokens are decoded as single bytes and
 *      accumulated until they form a valid UTF-8 sequence.
 *
 *   3. Partial multi-byte sequences across frame boundaries. A frame
 *      boundary is never a valid rendering boundary for a partial emoji or
 *      multi-byte character. The detokenizer buffers partial bytes between
 *      calls (when `partial: true`) and flushes them when complete.
 */
import { decodeByteLevelToken, METASPACE } from './encoder.js';
import type { TokenizerMap } from './types.js';

export interface DetokenizeOptions {
  /**
   * If true, this is not the final chunk — buffer any trailing partial
   * UTF-8 sequence rather than emitting replacement characters. Set to
   * `false` (or omit) on the last chunk so the buffer flushes.
   */
  partial?: boolean;
  /** If true, render special tokens (e.g. `<|eos|>`) as text. Default: false. */
  renderSpecial?: boolean;
}

export class Detokenizer {
  private readonly map: TokenizerMap;
  private readonly specialIds: Set<number>;
  private readonly fallbackStart: number;
  private readonly fallbackEnd: number;

  /**
   * id → bytes for byte_level maps (every vocab token is a byte sequence),
   * or null for non-byte_level maps where lookup goes through `idToText`.
   */
  private readonly idToBytes: Map<number, Uint8Array> | null;

  /** id → already-decoded text. Used for metaspace and identity encoders. */
  private readonly idToText: Map<number, string> | null;

  private byteBuffer: number[] = [];

  constructor(map: TokenizerMap) {
    this.map = map;
    this.specialIds = new Set(Object.values(map.special_tokens ?? {}));
    this.fallbackStart = map.byte_fallback_start ?? -1;
    this.fallbackEnd = map.byte_fallback_end ?? -2;

    if (map.encoder === 'byte_level') {
      this.idToBytes = buildByteLevelTable(map);
      this.idToText = null;
    } else {
      this.idToBytes = null;
      this.idToText = buildTextTable(map);
    }
  }

  /**
   * Render a chunk of IDs to text. Stateful across calls — partial
   * multi-byte sequences carry over until completed by a later chunk.
   *
   *   const detok = new Detokenizer(map);
   *   for await (const frame of decodeStream(stream)) {
   *     out += detok.render(frame.ids, { partial: !frame.done });
   *   }
   */
  render(ids: readonly number[], opts: DetokenizeOptions = {}): string {
    const partial = opts.partial ?? false;
    const renderSpecial = opts.renderSpecial ?? false;
    let out = '';

    for (const id of ids) {
      // Byte-fallback range: SentencePiece maps reserve a contiguous block
      // of IDs for raw bytes 0x00–0xFF.
      if (id >= this.fallbackStart && id <= this.fallbackEnd) {
        this.byteBuffer.push(id - this.fallbackStart);
        const flushed = this.tryFlushBytes();
        if (flushed) out += flushed;
        continue;
      }

      // byte_level path — every vocab token is itself a byte sequence,
      // so we route all token bytes through the same UTF-8 buffer logic.
      if (this.idToBytes) {
        if (this.specialIds.has(id) && !renderSpecial) {
          // Specials still live in the vocab but should not surface as text.
          // Flush any pending bytes first to avoid splitting a multi-byte char.
          if (this.byteBuffer.length > 0) out += this.flushBytesForce();
          continue;
        }
        const bytes = this.idToBytes.get(id);
        if (bytes === undefined) {
          if (this.byteBuffer.length > 0) out += this.flushBytesForce();
          out += '�';
          continue;
        }
        for (let i = 0; i < bytes.length; i++) this.byteBuffer.push(bytes[i]!);
        const flushed = this.tryFlushAllBytes();
        if (flushed) out += flushed;
        continue;
      }

      // metaspace / identity path — token text is rendered directly.
      // Flush any pending byte-fallback bytes first.
      if (this.byteBuffer.length > 0) out += this.flushBytesForce();

      if (this.specialIds.has(id) && !renderSpecial) continue;

      const text = this.idToText!.get(id);
      if (text !== undefined) {
        out += text;
      } else {
        out += '�';
      }
    }

    if (!partial && this.byteBuffer.length > 0) {
      out += this.flushBytesForce();
    }
    return out;
  }

  /** Reset internal state — call between conversations / requests. */
  reset(): void {
    this.byteBuffer = [];
  }

  /** Decode whatever complete UTF-8 prefix sits in the buffer; keep the rest. */
  private tryFlushAllBytes(): string {
    let out = '';
    while (this.byteBuffer.length > 0) {
      const needed = utf8SequenceLength(this.byteBuffer[0]!);
      if (needed === 0) {
        this.byteBuffer.shift();
        out += '�';
        continue;
      }
      if (this.byteBuffer.length < needed) break;
      const bytes = this.byteBuffer.splice(0, needed);
      try {
        out += new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
      } catch {
        out += '�';
      }
    }
    return out;
  }

  /** Single-sequence flush — used by the byte-fallback range path. */
  private tryFlushBytes(): string | null {
    if (this.byteBuffer.length === 0) return null;
    const needed = utf8SequenceLength(this.byteBuffer[0]!);
    if (needed === 0) {
      this.byteBuffer.shift();
      return '�';
    }
    if (this.byteBuffer.length < needed) return null;
    const bytes = this.byteBuffer.splice(0, needed);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    } catch {
      return '�';
    }
  }

  /** Flush whatever's in the buffer, replacing invalid bytes with U+FFFD. */
  private flushBytesForce(): string {
    if (this.byteBuffer.length === 0) return '';
    const bytes = new Uint8Array(this.byteBuffer);
    this.byteBuffer = [];
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Number of bytes a UTF-8 sequence starting with `b` requires, or 0 if `b`
 * is not a valid leading byte.
 */
function utf8SequenceLength(b: number): number {
  if ((b & 0x80) === 0x00) return 1; // 0xxxxxxx
  if ((b & 0xe0) === 0xc0) return 2; // 110xxxxx
  if ((b & 0xf0) === 0xe0) return 3; // 1110xxxx
  if ((b & 0xf8) === 0xf0) return 4; // 11110xxx
  return 0;
}

/** Build id → bytes table for byte_level maps. */
function buildByteLevelTable(map: TokenizerMap): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  if (!map.vocab) return out;
  for (const [token, id] of Object.entries(map.vocab)) {
    out.set(id, decodeByteLevelToken(token));
  }
  return out;
}

/**
 * Build id → text table for metaspace and identity (incl. v1) maps.
 * - metaspace: replace ▁ with space.
 * - identity / v1: token text is already decoded.
 */
function buildTextTable(map: TokenizerMap): Map<number, string> {
  const out = new Map<number, string>();
  const isMetaspace = map.encoder === 'metaspace';

  // v2 maps: { raw_token: id }
  if (map.vocab) {
    for (const [token, id] of Object.entries(map.vocab)) {
      // SentencePiece byte-fallback tokens (<0x00>…<0xFF>) live in vocab
      // but are handled by the byte_fallback range path — skip here.
      if (/^<0x[0-9A-Fa-f]{2}>$/.test(token)) continue;
      const text = isMetaspace ? token.replace(/▁/g, ' ') : token;
      out.set(id, text);
    }
  }

  // v1 maps: { id_string: decoded_text }
  if (map.tokens) {
    for (const [idStr, text] of Object.entries(map.tokens)) {
      out.set(Number(idStr), text);
    }
  }

  return out;
}

/** Convenience: detokenize a complete sequence in one shot. */
export function detokenize(
  map: TokenizerMap,
  ids: readonly number[],
  opts?: Omit<DetokenizeOptions, 'partial'>,
): string {
  const d = new Detokenizer(map);
  return d.render(ids, { ...opts, partial: false });
}
