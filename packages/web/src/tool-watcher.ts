/**
 * ToolWatcher: detect tool-call regions in a token-ID stream without
 * decoding.
 *
 * Mirrors the C `codec_tool_watcher` API. Most chat-tuned models delimit
 * tool calls with single-token specials (`<tool_call>` / `</tool_call>`
 * for Qwen 2.5+, `<|python_tag|>` / `<|eom_id|>` for Llama 3.1+, etc.).
 * Detecting *that* a tool call happened is therefore a uint32 compare
 * in the hot loop: no detokenization, no string allocation.
 *
 * The watcher emits five kinds of events, in stream order, across
 * `feed()` (and `end()`) calls:
 *   - `passthrough`: IDs outside any watched region (route as-is to the
 *     next agent).
 *   - `region`: a complete start..end region with markers excluded
 *     (decode only when you actually need the JSON arguments).
 *   - `truncated`: emitted only by `end()`, when the stream finished
 *     while still inside a region. Carries whatever was buffered plus
 *     the finish reason, so a length stop is distinguishable from a
 *     malformed emission.
 *   - `overflow`: the region buffer hit its configured cap. Carries the
 *     capped prefix; the watcher keeps scanning for the end marker
 *     without buffering further body tokens.
 *   - `nested_start`: a start marker was seen while already inside a
 *     region. Dropped from the region body, but reported so it isn't
 *     silently swallowed.
 *
 * State survives across `feed()` calls: a region split between network
 * frames buffers internally until the end marker arrives. `feed()` has
 * no way to know the stream is over, so call `end()` once you know no
 * more tokens are coming (e.g. right after a frame whose `done` is true).
 *
 * Performance: the hot loop is a single uint32 compare against two
 * cached IDs plus an occasional push into a number[]. Roughly two
 * orders of magnitude faster than a detokenize over the same stream.
 *
 * Known limitation, not yet handled: a single (startId, endId) pair
 * assumes the start marker is exclusive to tool calls. Formats where the
 * same start marker opens every assistant message and a closing token
 * decides after the fact whether it was a tool call (gpt-oss harmony:
 * `<|start|>` 200006 opens every message; `<|call|>` 200012 confirms,
 * `<|end|>` 200007 / `<|return|>` 200002 reject) need a set of closing
 * tokens with different outcomes, not one endId. See the "Known
 * limitation" paragraph on `codec_tool_watcher` in packages/c/include/
 * codec/codec.h for the full writeup and the reasoning for why this is
 * additive to the event kinds above, not a rewrite of them.
 */
import type { TokenizerMap } from './types.js';

export type WatcherEvent =
  | { readonly kind: 'passthrough';  readonly ids: ReadonlyArray<number> }
  | { readonly kind: 'region';       readonly ids: ReadonlyArray<number> }
  | { readonly kind: 'truncated';    readonly ids: ReadonlyArray<number>; readonly finishReason: string | null }
  | { readonly kind: 'overflow';     readonly ids: ReadonlyArray<number> }
  | { readonly kind: 'nested_start'; readonly ids: ReadonlyArray<number> };

/** Default cap on the number of token IDs buffered inside one open region.
 * 65536 tokens is comfortably above any real tool-call payload while still
 * bounding worst-case per-watcher memory against a client that can make
 * the model emit a start marker without a matching end marker. */
export const DEFAULT_REGION_CAP = 65536;

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
  /* True once the in-progress region has hit regionCap and emitted its
   * 'overflow' event. While set, body tokens are dropped (not buffered,
   * not re-reported) until the end marker closes the region. */
  private _capped = false;
  private _regionCap: number;
  /* Region buffer survives across feeds: markers excluded. */
  private region: number[] = [];

  constructor(map: TokenizerMap, startName: string, endName: string,
              regionCap: number = DEFAULT_REGION_CAP) {
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
    this._regionCap = regionCap > 0 ? regionCap : DEFAULT_REGION_CAP;
  }

  /** True when a region is currently open (start seen, end not yet). */
  get inside(): boolean { return this._inside; }

  /** Cap on the number of token IDs buffered inside one open region. */
  get regionCap(): number { return this._regionCap; }

  /** Change the region cap. 0 resets to {@link DEFAULT_REGION_CAP}. */
  setRegionCap(cap: number): void {
    this._regionCap = cap > 0 ? cap : DEFAULT_REGION_CAP;
  }

  /**
   * Reset state: drops any in-flight region buffer. Call between
   * conversations so a leftover unclosed region from session N doesn't
   * spill into session N+1.
   */
  reset(): void {
    this._inside = false;
    this._capped = false;
    this.region = [];
  }

  /**
   * Feed a chunk of token IDs and receive a flat array of events, in
   * stream order. Ownership, unlike the C watcher: every `ids` array
   * returned here (for every event kind, including `passthrough`) is a
   * fresh array owned by the caller, valid forever. `sliceIds` below
   * always copies, and the `region` buffer is handed out and replaced,
   * never aliased: nothing you get back from `feed()` or `end()` points
   * into memory this watcher can still mutate. Callers don't need to
   * copy anything out before the next call.
   */
  feed(input: ReadonlyArray<number> | Uint32Array): WatcherEvent[] {
    const events: WatcherEvent[] = [];
    const n = input.length;
    let ptStart = 0;

    /* Single-pass scan. Identical state machine to the C
     * implementation: keep them in sync if you change one. */
    for (let i = 0; i < n; i++) {
      const id = input[i]!;

      if (!this._inside) {
        if (id === this.startId) {
          if (i > ptStart) {
            events.push({ kind: 'passthrough', ids: sliceIds(input, ptStart, i) });
          }
          this._inside = true;
          this._capped = false;
          this.region = [];
          /* ptStart is re-anchored when the region closes. */
        }
        /* else: token continues the passthrough run; no action. */
      } else {
        if (id === this.endId) {
          /* Region complete: emit a fresh array (caller-owned, doesn't
           * alias our buffer the way the C version does). Skipped when
           * the region already overflowed: that was reported once,
           * already, at the moment the cap was hit. */
          if (!this._capped) {
            events.push({ kind: 'region', ids: this.region });
          }
          this.region = [];
          this._inside = false;
          this._capped = false;
          ptStart = i + 1;
        } else if (id === this.startId) {
          /* Nested start: dropped from the region body (most models
           * don't nest these markers, and treating an inner start as a
           * new region would silently drop the outer content) but
           * reported so it isn't silently swallowed. */
          events.push({ kind: 'nested_start', ids: [id] });
        } else if (this._capped) {
          /* Already reported 'overflow' for this region. Keep scanning
           * for the end marker without buffering: memory stays bounded. */
        } else if (this.region.length >= this._regionCap) {
          /* Cap hit on this token. Report what's buffered so far, then
           * stop growing: do not silently truncate. Deliberately does NOT
           * reset `this.region`: if the stream then ends without an end
           * marker, end() reports the same capped content as `truncated`
           * (overflow and truncation are orthogonal signals; a region can
           * be both). The end-marker path below resets it once the
           * region actually closes. */
          events.push({ kind: 'overflow', ids: this.region });
          this._capped = true;
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

  /**
   * Signal end of stream. `feed()` has no way to know the stream is
   * over, so call this once you know no more tokens are coming.
   *
   * If a region is currently open, returns a single `truncated` event
   * carrying whatever was buffered (possibly empty) and `finishReason`,
   * so the caller can tell "the model hit its length limit mid tool-call"
   * (`finishReason === 'length'`) apart from a malformed emission on its
   * own. Returns an empty array when not inside a region: calling `end()`
   * on a cleanly finished stream is a no-op.
   */
  end(finishReason: string | null = null): WatcherEvent[] {
    if (!this._inside) return [];
    const ids = this.region;
    this.region = [];
    this._inside = false;
    this._capped = false;
    return [{ kind: 'truncated', ids, finishReason }];
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
