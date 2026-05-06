/**
 * Detokenizer — IDs → text. Invoked only when a human is going to read the
 * output. Agent-to-agent calls skip this layer entirely.
 *
 * Two correctness concerns it has to get right:
 *
 *   1. Byte-fallback tokens. Some tokenizers emit raw UTF-8 bytes for
 *      characters outside their vocabulary. IDs in [byte_fallback_start,
 *      byte_fallback_end] are decoded as single bytes, then accumulated until
 *      they form a valid UTF-8 sequence before being rendered.
 *
 *   2. Partial multi-byte sequences across frame boundaries. A frame boundary
 *      is never a valid rendering boundary for a partial emoji or multi-byte
 *      character. The detokenizer buffers partial bytes between calls and
 *      flushes them when complete.
 */
import type { TokenizerMap } from './types.js';

export interface DetokenizeOptions {
  /**
   * If true, this is not the final chunk — buffer any trailing partial UTF-8
   * sequence rather than emitting replacement characters. Set to `false` (or
   * omit) on the last chunk so the buffer flushes.
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
  private byteBuffer: number[] = [];

  constructor(map: TokenizerMap) {
    this.map = map;
    this.specialIds = new Set(Object.values(map.special_tokens ?? {}));
    this.fallbackStart = map.byte_fallback_start ?? -1;
    this.fallbackEnd = map.byte_fallback_end ?? -2;
  }

  /**
   * Render a chunk of IDs to text. Stateful across calls — partial multi-byte
   * sequences carry over until completed by a later chunk.
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
      // Byte-fallback path: accumulate bytes; flush whenever the buffer holds a
      // complete UTF-8 sequence (or invalid bytes that should surface as U+FFFD).
      if (id >= this.fallbackStart && id <= this.fallbackEnd) {
        this.byteBuffer.push(id - this.fallbackStart);
        const flushed = this.tryFlushBytes();
        if (flushed) out += flushed;
        continue;
      }

      // Any other byte-buffered residue must be flushed before emitting a
      // regular token — otherwise we'd interleave a raw-byte sequence with a
      // vocab token mid-character.
      if (this.byteBuffer.length > 0) {
        out += this.flushBytesForce();
      }

      if (this.specialIds.has(id) && !renderSpecial) continue;

      const fragment = this.map.tokens[String(id)];
      if (fragment !== undefined) {
        out += fragment;
      } else {
        // Unknown ID — emit replacement character so the caller can see
        // something went wrong rather than silently drop tokens.
        out += '�';
      }
    }

    if (!partial && this.byteBuffer.length > 0) {
      out += this.flushBytesForce();
    }
    return out;
  }

  /**
   * Render and reset the internal byte buffer. Call this when starting a new
   * stream to avoid stale partial-sequence leakage from a prior conversation.
   */
  reset(): void {
    this.byteBuffer = [];
  }

  /** Flush only if the accumulated bytes form a complete, valid UTF-8 sequence. */
  private tryFlushBytes(): string | null {
    if (this.byteBuffer.length === 0) return null;
    const needed = utf8SequenceLength(this.byteBuffer[0]!);
    if (needed === 0) {
      // First byte is invalid — emit a replacement and drop one byte.
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

/** Convenience: detokenize a complete sequence in one shot. */
export function detokenize(
  map: TokenizerMap,
  ids: readonly number[],
  opts?: Omit<DetokenizeOptions, 'partial'>
): string {
  const d = new Detokenizer(map);
  return d.render(ids, { ...opts, partial: false });
}
