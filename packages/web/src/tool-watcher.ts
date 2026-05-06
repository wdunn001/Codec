/**
 * ToolWatcher — detect tool-call regions in a token-ID stream without
 * decoding.
 *
 * Mirrors the C `codec_tool_watcher` API. Most chat-tuned models delimit
 * tool calls with single-token specials (`<tool_call>` / `</tool_call>`
 * for Qwen 2.5+, `<|python_tag|>` / `<|eom_id|>` for Llama 3.1+, etc.).
 * Detecting *that* a tool call happened is therefore a uint32 compare
 * in the hot loop — no detokenization, no string allocation.
 *
 * The watcher emits two kinds of events per `feed()` call:
 *   - `passthrough`: IDs outside any watched region (route as-is to the
 *     next agent).
 *   - `region`: a complete start..end region with markers excluded
 *     (decode only when you actually need the JSON arguments).
 *
 * State survives across `feed()` calls: a region split between network
 * frames buffers internally until the end marker arrives.
 *
 * Performance: the hot loop is a single uint32 compare against two
 * cached IDs plus an occasional push into a number[]. Roughly two
 * orders of magnitude faster than a detokenize over the same stream.
 */
import type { TokenizerMap } from './types.js';

export type WatcherEvent =
  | { readonly kind: 'passthrough'; readonly ids: ReadonlyArray<number> }
  | { readonly kind: 'region';      readonly ids: ReadonlyArray<number> };

export class ToolWatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolWatcherError';
  }
}

export class ToolWatcher {
  readonly startId: number;
  readonly endId:   number;
  readonly startName: string;
  readonly endName:   string;

  private _inside = false;
  /* Region buffer survives across feeds — markers excluded. */
  private region: number[] = [];

  constructor(map: TokenizerMap, startName: string, endName: string) {
    const specials = map.special_tokens ?? {};
    const startId = specials[startName];
    const endId   = specials[endName];
    if (typeof startId !== 'number') {
      throw new ToolWatcherError(
        `special token "${startName}" not in map.special_tokens`);
    }
    if (typeof endId !== 'number') {
      throw new ToolWatcherError(
        `special token "${endName}" not in map.special_tokens`);
    }
    this.startId   = startId;
    this.endId     = endId;
    this.startName = startName;
    this.endName   = endName;
  }

  /** True when a region is currently open (start seen, end not yet). */
  get inside(): boolean { return this._inside; }

  /**
   * Reset state — drops any in-flight region buffer. Call between
   * conversations so a leftover unclosed region from session N doesn't
   * spill into session N+1.
   */
  reset(): void {
    this._inside = false;
    this.region = [];
  }

  /**
   * Feed a chunk of token IDs and receive a flat array of events. The
   * returned `ids` arrays:
   *   - For `passthrough`: a slice of the input, valid for as long as
   *     the caller's input stays alive.
   *   - For `region`: a fresh array owned by the caller, valid forever
   *     (we hand out a copy of the buffered region and reset).
   */
  feed(input: ReadonlyArray<number> | Uint32Array): WatcherEvent[] {
    const events: WatcherEvent[] = [];
    const n = input.length;
    let ptStart = 0;

    /* Single-pass scan. Identical state machine to the C
     * implementation — keep them in sync if you change one. */
    for (let i = 0; i < n; i++) {
      const id = input[i]!;

      if (!this._inside) {
        if (id === this.startId) {
          if (i > ptStart) {
            events.push({ kind: 'passthrough', ids: sliceIds(input, ptStart, i) });
          }
          this._inside = true;
          this.region = [];
          /* ptStart is re-anchored when the region closes. */
        }
        /* else: token continues the passthrough run; no action. */
      } else {
        if (id === this.endId) {
          /* Region complete — emit a fresh array (caller-owned, doesn't
           * alias our buffer the way the C version does). */
          events.push({ kind: 'region', ids: this.region });
          this.region = [];
          this._inside = false;
          ptStart = i + 1;
        } else if (id === this.startId) {
          /* Nested start; ignore. Most models don't nest these markers,
           * and treating an inner start as a new region would silently
           * drop the outer content. */
        } else {
          this.region.push(id);
        }
      }
    }

    /* Trailing passthrough run, if we ended outside a region. */
    if (!this._inside && ptStart < n) {
      events.push({ kind: 'passthrough', ids: sliceIds(input, ptStart, n) });
    }

    return events;
  }
}

function sliceIds(input: ReadonlyArray<number> | Uint32Array,
                  from: number, to: number): number[] {
  /* Always copy out to a plain array so callers don't have to think
   * about whether they got a Uint32Array slice or a number[] slice. */
  const out = new Array<number>(to - from);
  for (let i = 0; i < to - from; i++) out[i] = input[from + i]!;
  return out;
}
