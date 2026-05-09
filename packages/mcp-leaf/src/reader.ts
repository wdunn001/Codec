/**
 * Symmetric reader for the leaf-mode contract.
 *
 * `wrapToolCall` (in `leaf.ts`) is the writer side: an MCP tool author wraps
 * `CallToolResult.content[]` with `_codec_meta` siblings carrying token IDs.
 * This module is the reader side: a Codec-aware client (or an inference
 * engine receiving a forwarded result) reads those siblings back out without
 * re-tokenizing, validates the (text, ids) pairing, and surfaces a clean view
 * to consumers.
 *
 * Why both sides matter. Today the leaf-mode bypass is observable only at the
 * gateway (metamcp's `[Codec][leaf]` log fires when it sees `_codec_meta` on a
 * downstream result). Without a reader on the client side, the client either
 * decodes the text and re-tokenizes — wasting the work the tool already did —
 * or trusts the gateway to do the right thing. The reader closes that gap.
 *
 * Quick start:
 *
 *   import { findCodecMeta, takeIds } from '@codecai/mcp-leaf';
 *
 *   const ids = takeIds(result, { expectedMapHash: 'sha256:0549…' });
 *   // ids is number[][] aligned to the text-block sequence in result.content.
 */

import type { CallToolResult, CodecMetaBlock, ContentBlock } from './leaf.js';

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * One (text, ids) pairing extracted from a CallToolResult. The reader walks
 * the content array and emits one entry per text block in order: each entry
 * either carries the matching `_codec_meta` sibling's `ids`, or carries
 * `null` if the text block had no meta sibling.
 *
 * Consumers who want only the IDs (and don't care about which text block they
 * came from) should use `takeIds()` instead.
 */
export interface CodecMetaPairing {
  /** Index in the original `result.content` array of the `text` block. */
  readonly textIndex: number;
  /** The text block's text — useful for fallback retokenization paths. */
  readonly text: string;
  /** The sibling `_codec_meta` block's IDs, or `null` if absent. */
  readonly ids: readonly number[] | null;
  /** The sibling block's `map_id`, or `null` if absent. */
  readonly mapId: string | null;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class CodecMetaMapMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly found: string,
    readonly textIndex: number,
  ) {
    super(
      `_codec_meta block at content[${textIndex + 1}] declares map_id ${found} ` +
        `but the caller expected ${expected}`,
    );
    this.name = 'CodecMetaMapMismatchError';
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true iff the result has at least one `_codec_meta` block. Cheap
 * pre-check for clients that want to fork on "is this Codec-aware output".
 */
export function hasCodecMeta(result: CallToolResult): boolean {
  for (const block of result.content) {
    if (isCodecMetaBlock(block)) return true;
  }
  return false;
}

/**
 * Find the `_codec_meta` block immediately following the text block at
 * `result.content[textIndex]`. Returns `null` if the next block isn't a meta
 * sibling (or doesn't exist). Mirrors the writer-side adjacency rule: meta
 * blocks live at content[textIndex + 1].
 */
export function findCodecMeta(
  result: CallToolResult,
  textIndex: number,
): CodecMetaBlock | null {
  const next = result.content[textIndex + 1];
  return isCodecMetaBlock(next) ? next : null;
}

/**
 * Walk the content array and return one `CodecMetaPairing` per text block.
 * Non-text blocks (image, audio, resource) are skipped silently — they don't
 * have a meta-sibling contract.
 *
 * If `opts.expectedMapHash` is set, every meta block's `map_id` MUST equal it
 * (after `sha256:` prefix normalization); otherwise throws
 * `CodecMetaMapMismatchError`. Use this when the client has already pinned a
 * tokenizer map and a mismatched ID would corrupt downstream KV cache.
 */
export function readCodecMeta(
  result: CallToolResult,
  opts: { expectedMapHash?: string } = {},
): CodecMetaPairing[] {
  const expected = opts.expectedMapHash
    ? normaliseHash(opts.expectedMapHash)
    : null;

  const pairings: CodecMetaPairing[] = [];
  for (let i = 0; i < result.content.length; i++) {
    const block = result.content[i]!;
    if (!isTextBlock(block)) continue;
    const meta = findCodecMeta(result, i);
    if (meta && expected && meta.map_id !== expected) {
      throw new CodecMetaMapMismatchError(expected, meta.map_id, i);
    }
    pairings.push({
      textIndex: i,
      text: block.text,
      ids: meta?.ids ?? null,
      mapId: meta?.map_id ?? null,
    });
  }
  return pairings;
}

/**
 * Convenience wrapper around `readCodecMeta` that returns only the per-text-
 * block ID arrays. Each entry is either the IDs (if a sibling meta block was
 * found) or `null` (so the caller knows which text blocks need a fallback
 * tokenization pass). Aligned to the order of text blocks in the result.
 */
export function takeIds(
  result: CallToolResult,
  opts: { expectedMapHash?: string } = {},
): (readonly number[] | null)[] {
  return readCodecMeta(result, opts).map((p) => p.ids);
}

/**
 * Strip every `_codec_meta` block from a `CallToolResult` and return a new
 * result. Useful when forwarding to a non-Codec-aware downstream client —
 * the meta blocks are additive but verbose, and a client that didn't ask for
 * them shouldn't see them. Does not mutate the input.
 */
export function stripCodecMeta(result: CallToolResult): CallToolResult {
  const filtered = result.content.filter((b) => !isCodecMetaBlock(b));
  if (filtered.length === result.content.length) return result;
  return { ...result, content: filtered };
}

// ── Type guards ──────────────────────────────────────────────────────────────

function isTextBlock(b: unknown): b is { type: 'text'; text: string } {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as Record<string, unknown>).type === 'text' &&
    typeof (b as Record<string, unknown>).text === 'string'
  );
}

function isCodecMetaBlock(b: unknown): b is CodecMetaBlock {
  if (typeof b !== 'object' || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    o.type === '_codec_meta' &&
    typeof o.map_id === 'string' &&
    Array.isArray(o.ids)
  );
}

// Mirror leaf.ts's normalisation rule. We keep this private — the writer
// validates aggressively at construction time; the reader only normalises so a
// caller's bare-hex input can be compared to a `sha256:`-prefixed wire value.
function normaliseHash(input: string): string {
  if (input.startsWith('sha256:')) return input;
  if (/^[0-9a-f]{64}$/i.test(input)) return `sha256:${input.toLowerCase()}`;
  throw new Error(
    `expectedMapHash must be 'sha256:<64 hex chars>' or a bare 64-char hex digest, ` +
      `got ${JSON.stringify(input)}`,
  );
}

// Re-export the type a reader user is most likely to need without forcing
// them to import from `./leaf.js`.
export type { CallToolResult, CodecMetaBlock, ContentBlock } from './leaf.js';
