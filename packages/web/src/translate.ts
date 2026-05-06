/**
 * Translator — cross-vocab token-stream pipe.
 *
 * Take Agent A's token IDs in vocab V_A, produce Agent B's token IDs in
 * vocab V_B, with no text ever leaving the process. Internally:
 *
 *   ids_A → Detokenizer(V_A) → utf8 → BPETokenizer(V_B) → ids_B
 *
 * The text intermediate is purely local; agent-to-agent traffic still
 * carries only token IDs on the wire. This is the scenario the Codec
 * spec calls a "cross-vocab agent handoff" — when two models with
 * different vocabularies are chained without a human reader in between.
 *
 * Use cases:
 *   - Pipe Llama-3's output into Qwen-2's input (different BPE vocabs)
 *   - Drop a Mistral-v3 step into a Llama-3 chain (different families)
 *   - Run a router / orchestrator that fans out to heterogeneous models
 *
 * Streaming caveat: BPE merges depend on context, so re-tokenizing partial
 * words mid-stream produces different IDs than re-tokenizing the complete
 * word. The Translator buffers text until a safe boundary (whitespace)
 * before flushing through BPE. Call `translate(ids, { partial: true })`
 * for incoming chunks and `translate(ids)` (or `partial: false`) for the
 * final chunk to flush any trailing word.
 */
import { Detokenizer } from './detokenize.js';
import { pickTokenizer } from './tokenize.js';
import type { Tokenizer, TokenizerMap } from './types.js';

export interface TranslateOptions {
  /**
   * If true, this is not the final chunk — buffer any trailing partial
   * word rather than flushing it through BPE prematurely. Set to `false`
   * (or omit) on the last chunk so the buffer drains.
   */
  partial?: boolean;
}

export class Translator {
  readonly fromId: string;
  readonly toId: string;
  private readonly fromDetok: Detokenizer;
  private readonly toTok: Tokenizer;
  private textBuffer: string = '';

  constructor(fromMap: TokenizerMap, toMap: TokenizerMap) {
    this.fromId = fromMap.id;
    this.toId = toMap.id;
    this.fromDetok = new Detokenizer(fromMap);
    this.toTok = pickTokenizer(toMap);
  }

  /**
   * Translate a chunk of source-vocab IDs to target-vocab IDs.
   * Stateful across calls — partial words are buffered when
   * `opts.partial` is true.
   */
  translate(ids: readonly number[], opts: TranslateOptions = {}): number[] {
    const partial = opts.partial ?? false;
    // Render through V_A's detokenizer with the same partial flag — this
    // already handles partial UTF-8 byte sequences across token boundaries.
    const text = this.fromDetok.render(ids, { partial });
    if (text.length > 0) this.textBuffer += text;

    if (!partial) {
      // Final chunk — flush everything.
      const out = this.toTok.encode(this.textBuffer);
      this.textBuffer = '';
      return out;
    }

    // Streaming chunk — find the last safe boundary and flush before it.
    // Pre-tokenizers (both byte_level and metaspace) split at whitespace,
    // so re-encoding text up to and including the last whitespace yields
    // the same IDs as re-encoding the complete word later.
    const safe = this.findLastSafeBoundary(this.textBuffer);
    if (safe <= 0) return [];

    const toEncode = this.textBuffer.slice(0, safe);
    this.textBuffer = this.textBuffer.slice(safe);
    return this.toTok.encode(toEncode);
  }

  /**
   * Reset internal state — call between conversations.
   */
  reset(): void {
    this.fromDetok.reset();
    this.textBuffer = '';
  }

  /**
   * Convenience: end-of-stream flush. Equivalent to
   * `translate([], { partial: false })` but more readable.
   */
  finish(): number[] {
    return this.translate([], { partial: false });
  }

  /**
   * Find the last index that's safe to cut at. We prefer the position
   * just after the last whitespace character, since BPE pre-tokenizers
   * always split there. If the buffer has no whitespace, return 0
   * (nothing safe to flush — keep buffering).
   */
  private findLastSafeBoundary(s: string): number {
    // Iterate codepoints from the end. Stop at the last whitespace and
    // return the position immediately after it. The trailing word stays
    // buffered until the next whitespace arrives.
    for (let i = s.length - 1; i >= 0; i--) {
      const c = s.charCodeAt(i);
      // ASCII whitespace + common Unicode whitespace block — covers the
      // pre-tokenizer regexes used by Llama-3, Qwen, Phi-3, Mistral, etc.
      if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D ||
          c === 0x0B || c === 0x0C || c === 0x00A0 || c === 0x2028 ||
          c === 0x2029 || c === 0x3000) {
        return i + 1;
      }
    }
    return 0;
  }
}

/**
 * Convenience: one-shot translate without keeping a Translator instance.
 * Useful for non-streaming cases where you have all the IDs up front.
 */
export function translate(
  fromMap: TokenizerMap,
  toMap: TokenizerMap,
  ids: readonly number[],
): number[] {
  return new Translator(fromMap, toMap).translate(ids);
}

/**
 * Build a static V_A → V_B[] translation table by feeding each V_A token's
 * decoded text through V_B's tokenizer. Useful for analysis (vocab overlap,
 * cost estimation) and for fast lookups when context-free translation is
 * acceptable.
 *
 * Limitations: this is context-free — token boundaries don't align across
 * vocabs, and BPE merges depend on context. The single-shot result
 * `staticTranslationTable(A, B)[id_A]` may differ from what `translate`
 * produces when the same `id_A` appears mid-sentence. For exact streaming
 * translation, use the `Translator` class.
 */
export function staticTranslationTable(
  fromMap: TokenizerMap,
  toMap: TokenizerMap,
): Map<number, number[]> {
  const detok = new Detokenizer(fromMap);
  const tok = pickTokenizer(toMap);
  const out = new Map<number, number[]>();

  // Walk the source vocab. Skip special tokens — they have no semantic
  // text representation that translates meaningfully.
  const specialIds = new Set(Object.values(fromMap.special_tokens ?? {}));
  const vocab = fromMap.vocab ?? {};
  for (const [, id] of Object.entries(vocab)) {
    if (specialIds.has(id)) continue;
    const text = detok.render([id]);
    if (text.length === 0) continue;
    out.set(id, tok.encode(text));
    detok.reset();
  }

  // v1 maps: also walk `tokens`
  const tokens = fromMap.tokens ?? {};
  for (const idStr of Object.keys(tokens)) {
    const id = Number(idStr);
    if (Number.isNaN(id) || specialIds.has(id) || out.has(id)) continue;
    const text = detok.render([id]);
    if (text.length === 0) continue;
    out.set(id, tok.encode(text));
    detok.reset();
  }

  return out;
}
