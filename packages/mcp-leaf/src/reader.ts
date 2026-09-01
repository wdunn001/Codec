/**
 * Symmetric reader for the leaf-mode contract.
 *
 * `wrapToolCall` (in `leaf.ts`) is the writer side: an MCP tool author
 * annotates each text block in `CallToolResult.content[]` with a
 * `_meta['ai.codec/leaf-tokenization']` payload carrying token IDs.
 * This module is the reader side: a Codec-aware client (or an inference
 * engine receiving a forwarded result) reads those payloads back out
 * without re-tokenizing, validates the (text, ids) pairing, and surfaces
 * a clean view to consumers.
 *
 * Why both sides matter. Today the leaf-mode bypass is observable only at the
 * gateway (metamcp's `[Codec][leaf]` log fires when it sees a Codec
 * payload on a downstream result). Without a reader on the client side,
 * the client either decodes the text and re-tokenizes: wasting the work
 * the tool already did: or trusts the gateway to do the right thing.
 * The reader closes that gap.
 *
 * Quick start:
 *
 *   import { readCodecMeta, takeIds } from '@codecai/mcp-leaf';
 *
 *   const ids = takeIds(result, { expectedMapHash: 'sha256:0549…' });
 *   // ids is number[][] aligned to the text-block sequence in result.content.
 *
 * Backwards compatibility: results produced by older Codec-aware tools
 * may carry the legacy `{ type: '_codec_meta', map_id, ids }` SIBLING
 * content block instead of the new per-block `_meta` field. The reader
 * accepts both shapes: the `_meta` form is preferred (passes MCP SDK
 * validation; sibling form crashes the SDK with -32602 on the server
 * side and was withdrawn in v0.3.2).
 */

import type {
  CallToolResult,
  CodecMetaBlock,
  ContentBlock,
  CodecMetaPayload,
} from './leaf.js';
import { CODEC_META_KEY, readCodecMetaFromBlock } from './leaf.js';

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * One (text, ids) pairing extracted from a CallToolResult. The reader walks
 * the content array and emits one entry per text block in order: each entry
 * either carries the per-block `_meta` Codec payload's `ids`, or carries
 * `null` if the text block had no Codec annotation.
 *
 * Consumers who want only the IDs (and don't care about which text block they
 * came from) should use `takeIds()` instead.
 */
export interface CodecMetaPairing {
  /** Index in the original `result.content` array of the `text` block. */
  readonly textIndex: number;
  /** The text block's text: useful for fallback retokenization paths. */
  readonly text: string;
  /** The Codec payload's IDs, or `null` if absent. */
  readonly ids: readonly number[] | null;
  /** The Codec payload's `map_id`, or `null` if absent. */
  readonly mapId: string | null;
  /** Where the payload was found: `"meta"` (current shape, preferred)
   *  or `"sibling"` (legacy v0.3.0/0.3.1 sibling-block shape). `null`
   *  when no payload was present. */
  readonly source: 'meta' | 'sibling' | null;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class CodecMetaMapMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly found: string,
    readonly textIndex: number,
  ) {
    super(
      `Codec meta at content[${textIndex}] declares map_id ${found} ` +
        `but the caller expected ${expected}`,
    );
    this.name = 'CodecMetaMapMismatchError';
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true iff the result has at least one Codec meta payload:
 * either a current-shape `_meta['ai.codec/leaf-tokenization']` on a
 * text block, or a legacy `{ type: '_codec_meta' }` sibling block.
 */
export function hasCodecMeta(result: CallToolResult): boolean {
  for (const block of result.content) {
    if (readCodecMetaFromBlock(block)) return true;
    if (isLegacyCodecMetaBlock(block)) return true;
  }
  return false;
}

/**
 * Read the Codec payload that belongs to the text block at
 * `result.content[textIndex]`. Checks the current (per-block `_meta`)
 * shape first; falls back to the legacy adjacent-sibling shape so this
 * helper accepts both wire forms. Returns `null` if neither is present.
 */
export function findCodecMeta(
  result: CallToolResult,
  textIndex: number,
): CodecMetaPayload | null {
  const block = result.content[textIndex];
  const onBlock = readCodecMetaFromBlock(block);
  if (onBlock) return onBlock;
  // Legacy v0.3.0/v0.3.1 sibling-block shape: `_codec_meta` block
  // immediately following the text block.
  const next = result.content[textIndex + 1];
  if (isLegacyCodecMetaBlock(next)) {
    return { map_id: next.map_id, ids: next.ids };
  }
  return null;
}

/**
 * Walk the content array and return one `CodecMetaPairing` per text block.
 * Non-text blocks (image, audio, resource) are skipped silently: they don't
 * carry a Codec contract.
 *
 * If `opts.expectedMapHash` is set, every payload's `map_id` MUST equal it
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

    let payload: CodecMetaPayload | null = readCodecMetaFromBlock(block);
    let source: 'meta' | 'sibling' | null = payload ? 'meta' : null;
    if (!payload) {
      const next = result.content[i + 1];
      if (isLegacyCodecMetaBlock(next)) {
        payload = { map_id: next.map_id, ids: next.ids };
        source = 'sibling';
      }
    }

    if (payload && expected && payload.map_id !== expected) {
      throw new CodecMetaMapMismatchError(expected, payload.map_id, i);
    }

    pairings.push({
      textIndex: i,
      text: block.text,
      ids: payload?.ids ?? null,
      mapId: payload?.map_id ?? null,
      source,
    });
  }
  return pairings;
}

/**
 * Convenience wrapper around `readCodecMeta` that returns only the per-text-
 * block ID arrays. Each entry is either the IDs (if a Codec payload was
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
 * Return a result with all Codec metadata stripped: the per-block `_meta`
 * key removed from text blocks, AND any legacy `_codec_meta` sibling
 * blocks filtered out. Useful when forwarding to a non-Codec-aware
 * downstream client. Does not mutate the input.
 */
export function stripCodecMeta(result: CallToolResult): CallToolResult {
  let changed = false;
  const stripped = result.content
    .filter((b) => {
      if (isLegacyCodecMetaBlock(b)) {
        changed = true;
        return false;
      }
      return true;
    })
    .map((b) => {
      if (!isTextBlock(b)) return b;
      const meta = (b as { _meta?: Record<string, unknown> })._meta;
      if (!meta || !(CODEC_META_KEY in meta)) return b;
      changed = true;
      const { [CODEC_META_KEY]: _drop, ...restMeta } = meta;
      // Drop _meta entirely if it ended up empty after removing our key,
      // so the result tree stays minimal for non-Codec-aware consumers.
      if (Object.keys(restMeta).length === 0) {
        const { _meta: _omit, ...rest } = b as Record<string, unknown>;
        return rest as ContentBlock;
      }
      return { ...b, _meta: restMeta } as ContentBlock;
    });
  if (!changed) return result;
  return { ...result, content: stripped };
}

// ── Type guards ──────────────────────────────────────────────────────────────

function isTextBlock(b: unknown): b is { type: 'text'; text: string; _meta?: Record<string, unknown> } {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as Record<string, unknown>).type === 'text' &&
    typeof (b as Record<string, unknown>).text === 'string'
  );
}

function isLegacyCodecMetaBlock(b: unknown): b is CodecMetaBlock {
  if (typeof b !== 'object' || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    o.type === '_codec_meta' &&
    typeof o.map_id === 'string' &&
    Array.isArray(o.ids)
  );
}

// Mirror leaf.ts's normalisation rule. We keep this private: the writer
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

// Re-export the types a reader user is most likely to need without forcing
// them to import from `./leaf.js`.
export type {
  CallToolResult,
  CodecMetaBlock,
  CodecMetaPayload,
  ContentBlock,
} from './leaf.js';
