/**
 * wire-compress — pick the right Content-Encoding for streaming responses.
 *
 * Framework-agnostic, zero dependencies. Designed for streaming workloads
 * with bursty small frames (SSE, Codec, gRPC-Web text, etc.) where the
 * standard "always-brotli" advice doesn't hold.
 *
 * Reasoning model:
 *   1. Look at what the client advertised in Accept-Encoding (with q-values).
 *   2. Look at the (best-guess) payload size: what we'll be sending.
 *   3. Pick the encoding the data says is smallest at that size, restricted
 *      to what the client actually supports.
 *   4. Fall back gracefully — gzip is the universal floor; identity is the
 *      always-works escape hatch.
 *
 * The default thresholds come from a real measurement against a streaming
 * binary endpoint (Codec on sglang, see RESULTS.md §1c). Override them with
 * `pick({ thresholds })` if your workload differs.
 */

export type Encoding = 'identity' | 'gzip' | 'br' | 'zstd';

export interface ClientSupport {
  /** Encodings the client accepts, ordered by preference (q-value desc). */
  accepted: Encoding[];
  /** Did the client send no Accept-Encoding at all? Some clients omit it. */
  unspecified?: boolean;
}

export interface PickInput {
  /** The Accept-Encoding header value, or null if absent. */
  acceptEncoding?: string | null;
  /**
   * Best estimate of total response size in tokens (Codec) or bytes.
   * Use whichever unit your thresholds are calibrated in.
   */
  estimatedSize: number;
  /** Override the default thresholds. */
  thresholds?: Thresholds;
  /**
   * Restrict the candidate set the server is willing to apply, e.g. if
   * the server doesn't have a zstd encoder available.
   */
  serverSupports?: Encoding[];
  /**
   * Is this response being read by a human as it streams (interactive
   * chat, code editor autocomplete, etc.) or by an agent that consumes
   * the entire response at once (tool-call dispatch, model-to-model
   * handoff, batch eval)?
   *
   * Default `true` (interactive). When `true`, the picker avoids
   * encodings that buffer the whole response — measured TTFT goes from
   * ~11 ms (gzip) to ~3,800 ms (zstd) at 2K tokens because zstd
   * compressors typically wait for the whole stream to finalize their
   * dictionary. So for human-facing streams, gzip wins regardless of
   * size.
   *
   * See RESULTS.md §1d (TTFT cliff chart) for the measured data.
   */
  interactive?: boolean;
  /**
   * Explicit opt-in to zstd. **Off by default.**
   *
   * The zstd middleware shipped on every gateway we've benchmarked
   * (sglang's `codec_compression.py`, the equivalent paths in
   * vLLM/llama.cpp PRs) buffers the whole response before sending the
   * first byte — TTFT regresses 334× at 2K tokens (11 ms → 3,684 ms).
   * For interactive *and* agent-to-agent traffic, that latency is
   * worse than the ~30% extra wire savings zstd offers over gzip is
   * worth.
   *
   * Set this `true` only when:
   *   1. You've confirmed the gateway uses streaming-zstd with
   *      periodic flushes (not buffered finalisation), AND
   *   2. The consumer genuinely reads the whole response in one shot
   *      with no inter-token deadline (large-batch eval, archival).
   *
   * If unset (or `false`), the picker treats zstd as if the client
   * didn't advertise it — gzip is preferred at every size.
   */
  zstdEnabled?: boolean;
  /**
   * Whether the server has a pre-trained zstd dictionary loaded for the
   * `(tokenizer_id, stream_format)` of *this specific request*. **The new
   * primary gate for selecting zstd.**
   *
   * Without a dict, no-dict zstd's wire-byte advantage over gzip is small
   * (RESULTS.md §1f puts gzip and no-dict zstd within noise of each other
   * on Codec streams — 3.4 B/token vs 3.4 B/token), but its TTFB cost on
   * shipped buffered middleware is catastrophic (RESULTS.md §1d, 334× at
   * 2K tokens). So no-dict zstd is the *worst of both worlds*: same bytes
   * as gzip, much worse TTFB.
   *
   * The dict is therefore not an optimization on top of zstd — it's the
   * **precondition** for zstd being a viable choice at all. If the
   * server doesn't have a dict for this request's tokenizer/format, the
   * picker MUST fall through to gzip (or br as fallback).
   *
   * Default `false`. Set this `true` per-request when the server has
   * resolved the tokenizer map for the response and confirmed
   * `zstd_dictionaries[]` contains an entry whose `format` matches the
   * response's `stream_format`. See spec/PROTOCOL.md "Pre-trained ZSTD
   * dictionaries" and packages/bench/RESULTS.md §1g.
   */
  zstdHasDict?: boolean;
}

export interface PickOutput {
  /** The Content-Encoding to apply. 'identity' means: send raw, no encoding header. */
  encoding: Encoding;
  /** A short human-readable rationale for logs. */
  reason: string;
}

/**
 * Default thresholds, in tokens of streaming output. Calibrated on Codec
 * msgpack/protobuf streams measured against sglang (PR #24483) on
 * Qwen2.5-0.5B-Instruct. See RESULTS.md §1c.
 *
 * The shape: {encoding -> [minSize, maxSize]} (inclusive). An encoding is
 * preferred when the size falls inside its bracket.
 */
export interface Thresholds {
  /** Below this many tokens, gzip's smaller header beats zstd. */
  gzipPreferredUpTo: number;
  /** At this many tokens or above, zstd's dictionary amortises. */
  zstdPreferredFrom: number;
  /** Brotli is only used if it's the *only* option above identity. */
  brotliFallbackOnly: boolean;
  /** Even at 16 tokens compressed beats raw, so raw is never preferred. */
  identityFallbackOnly: boolean;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  gzipPreferredUpTo: 128,
  zstdPreferredFrom: 256,
  brotliFallbackOnly: true,
  identityFallbackOnly: true,
};

/**
 * Per-stack measured compression characteristics. Lets the picker tune
 * itself for the gateway it's actually running behind, instead of
 * assuming sglang-shaped numbers everywhere.
 *
 * Each entry is `{ wireCoeff, ttftRatio }` per encoding:
 *   - wireCoeff:  measured `compressed_bytes / raw_codec_bytes` (lower = better)
 *   - ttftRatio:  measured `compressed_TTFT / raw_codec_TTFT`   (1.0 = streams)
 *
 * Source for each profile is RESULTS.md §1f. Update by re-running
 * codec-bench-timed against the stack and computing the two ratios.
 */
export interface EncodingChars {
  wireCoeff: number;
  ttftRatio: number;
}

export interface StackProfile {
  /** Stack name, for logging/diagnostics. */
  name: string;
  /** Per-encoding characterisation. Encodings missing here are assumed unsupported. */
  encodings: Partial<Record<Exclude<Encoding, 'identity'>, EncodingChars>>;
}

/**
 * Built-in stack profiles. Add more as we measure them.
 *
 * `default` is conservative — assumes typical streaming-aware gzip,
 * working zstd with a buffering quirk (the sglang pattern), and a br
 * implementation of unknown quality.
 */
export const STACK_PROFILES: Record<string, StackProfile> = {
  default: {
    name: 'default',
    encodings: {
      gzip: { wireCoeff: 0.05, ttftRatio: 1.0 },
      br: { wireCoeff: 0.5, ttftRatio: 1.0 },
      zstd: { wireCoeff: 0.05, ttftRatio: 100 },
    },
  },
  sglang: {
    name: 'sglang',
    // Measured 2024-05; see RESULTS.md §1f. br is broken (per-frame
    // compression sometimes expands the payload); zstd buffers full response.
    encodings: {
      gzip: { wireCoeff: 0.023, ttftRatio: 1.0 },
      br: { wireCoeff: 0.733, ttftRatio: 1.0 },
      zstd: { wireCoeff: 0.017, ttftRatio: 334 },
    },
  },
  'llama.cpp': {
    name: 'llama.cpp',
    // Measured 2024-05 against PR #22757. The PR ships codec wire formats
    // but does NOT add any compression middleware — every Accept-Encoding
    // returns the raw codec bytes (wireCoeff = 1.0, "passthrough"). TTFT
    // is consistently fast (5-7 ms) so streaming is not at risk.
    // To upgrade: hook a streaming-aware gzip layer into mongoose's HTTP
    // pipeline. Until then the picker should treat all encodings as
    // equivalent on this stack.
    encodings: {
      gzip: { wireCoeff: 1.0, ttftRatio: 1.0 },
      br: { wireCoeff: 1.0, ttftRatio: 1.0 },
      zstd: { wireCoeff: 1.0, ttftRatio: 1.0 },
    },
  },
  // vLLM profile pending the cross-stack bench run.
};

/**
 * Look up a profile by stack name (`sglang`, `vllm`, `llama.cpp`).
 * Falls back to `default` if not registered.
 */
export function profileFor(stackName: string | undefined): StackProfile {
  if (!stackName) return STACK_PROFILES.default!;
  return STACK_PROFILES[stackName] ?? STACK_PROFILES.default!;
}

// In the gap between gzipPreferredUpTo and zstdPreferredFrom (e.g. 129..255)
// the data is noisy — both gzip and zstd are within 10% of optimal. We pick
// gzip there because it's universally supported and the difference is sub-
// kilobyte. Override `gzipPreferredUpTo` upward if you'd rather always-zstd.

// ─── Accept-Encoding parser ─────────────────────────────────────────────────

/**
 * Parse an Accept-Encoding header into an ordered list of encodings the
 * client accepts, dropping anything with q=0 and sorting by q-value desc.
 *
 *   parseAcceptEncoding('br;q=1.0, gzip;q=0.8, *;q=0')
 *     → ['br', 'gzip']
 *
 *   parseAcceptEncoding(null) → unspecified=true
 *
 *   parseAcceptEncoding('') → accepted=[] (client wants identity-only)
 */
export function parseAcceptEncoding(header: string | null | undefined): ClientSupport {
  if (header == null) return { accepted: ['identity'], unspecified: true };
  const parts = header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return { accepted: ['identity'] };

  interface Entry { name: string; q: number }
  const entries: Entry[] = [];
  let star: number | null = null;
  let starQ = 0;

  for (let i = 0; i < parts.length; i++) {
    const [rawName, ...params] = parts[i]!.split(';').map((s) => s.trim());
    const name = (rawName ?? '').toLowerCase();
    let q = 1.0;
    for (const p of params) {
      const m = /^q\s*=\s*([0-9.]+)$/.exec(p);
      if (m) q = parseFloat(m[1]!);
    }
    if (name === '*') {
      star = i;
      starQ = q;
      continue;
    }
    if (q > 0) entries.push({ name, q });
  }

  // Stable sort by q desc.
  entries.sort((a, b) => b.q - a.q);
  const accepted: Encoding[] = [];
  for (const e of entries) {
    if (isKnownEncoding(e.name) && !accepted.includes(e.name)) {
      accepted.push(e.name);
    }
  }
  // identity is implicit unless the client disabled it explicitly. RFC 7231
  // says identity is always acceptable unless q=0 is set on it (or on *).
  const identityForbidden =
    parts.some((p) => /^identity\s*;\s*q\s*=\s*0/i.test(p)) ||
    (star !== null && starQ === 0 && !accepted.length);
  if (!identityForbidden && !accepted.includes('identity')) accepted.push('identity');
  return { accepted };
}

function isKnownEncoding(s: string): s is Encoding {
  return s === 'gzip' || s === 'br' || s === 'zstd' || s === 'identity';
}

// ─── The picker ─────────────────────────────────────────────────────────────

/**
 * Pick the best Content-Encoding for a streaming response.
 *
 * Algorithm:
 *   1. Parse Accept-Encoding (if absent, treat as gzip-only — RFC 7231 §5.3.4
 *      says identity is always acceptable, and gzip is universally supported,
 *      so gzip is a safe assumption when the client said nothing).
 *   2. Intersect with serverSupports (defaults to all four).
 *   3. From the candidate set, pick the smallest-bytes-at-size winner using
 *      the thresholds. zstd wins big payloads, gzip wins small.
 *   4. Brotli is only chosen when it's the only non-identity option. This
 *      reflects the measured behaviour: on streaming small-frame workloads
 *      brotli's per-block overhead dominates and gzip is cheaper. But
 *      brotli has wider client coverage than zstd (Safari, older Firefox,
 *      iOS) so it remains a critical fallback when zstd is unavailable.
 *   5. identity is the universal fallback when nothing else is supported.
 */
export function pick(input: PickInput): PickOutput {
  const {
    acceptEncoding,
    estimatedSize,
    thresholds = DEFAULT_THRESHOLDS,
    interactive = true,
    zstdEnabled = false,
    zstdHasDict = false,
  } = input;
  const serverCandidates: Set<Encoding> = new Set(
    input.serverSupports ?? ['identity', 'gzip', 'br', 'zstd'],
  );

  const client = parseAcceptEncoding(acceptEncoding);
  const candidates = new Set<Encoding>();
  for (const enc of client.accepted) if (serverCandidates.has(enc)) candidates.add(enc);

  // zstd has TWO gates, both must be true.
  //
  // 1. `zstdHasDict`: do we have a pre-trained dictionary for this
  //    request's (tokenizer, format)? Without a dict, zstd's wire-byte
  //    advantage over gzip is essentially zero on Codec streams (RESULTS.md
  //    §1f), and shipped middleware adds a catastrophic TTFB cliff
  //    (§1d) — so no-dict zstd is the worst of both worlds. The dict is
  //    not an optimization; it's the precondition.
  //
  // 2. `zstdEnabled`: has the operator confirmed the middleware uses
  //    streaming-zstd-with-flush, not buffered finalisation? If they
  //    haven't, even with-dict zstd will eat the TTFB cliff.
  //
  // Either gate failing → drop zstd from the candidate set entirely; the
  // picker falls through to gzip (or br for clients without gzip).
  if (!zstdHasDict || !zstdEnabled) candidates.delete('zstd');

  const has = (e: Encoding) => candidates.has(e);

  // After both gates above, zstd in the candidate set means: dict loaded
  // for this (tokenizer, format) AND streaming middleware confirmed. In
  // that world dict-zstd beats gzip at every size (RESULTS.md §1g: 16-38%
  // fewer bytes) with a streaming-TTFB overhead of +0.13 ms — sub-ms,
  // dwarfed by network. So zstd wins for both interactive and agent
  // traffic when present. The size threshold and interactive special
  // case (which previously avoided no-dict zstd's TTFT cliff) are no
  // longer needed.
  if (has('zstd')) {
    return {
      encoding: 'zstd',
      reason:
        `dict-zstd (zstdHasDict & zstdEnabled set; ` +
        `${interactive ? 'interactive' : 'agent'}; size=${estimatedSize})`,
    };
  }
  if (has('gzip')) {
    return {
      encoding: 'gzip',
      reason: zstdHasDict
        ? `gzip (no zstd in client's Accept-Encoding; size=${estimatedSize})`
        : `gzip (no zstd dict for this request — see PROTOCOL.md "Pre-trained ZSTD dictionaries"; size=${estimatedSize})`,
    };
  }
  if (has('br')) {
    return {
      encoding: 'br',
      reason: `br fallback (no gzip; size=${estimatedSize})`,
    };
  }
  return { encoding: 'identity', reason: `client supports nothing compressible; identity` };
}

// ─── Helpers callers usually want ───────────────────────────────────────────

/**
 * Build the Accept-Encoding header a client should send to maximise its
 * chance of getting the best encoding back. Use this on the client side.
 *
 * Returns: "gzip;q=1.0, br;q=0.5" by default.
 *
 * The q-values reflect the measured preference order on streaming Codec
 * frames: gzip > br > identity. zstd is omitted by default for two
 * reasons: shipped middleware buffers the whole response (RESULTS.md §1d
 * TTFT cliff), and even with streaming middleware, no-dict zstd's
 * wire-byte advantage over gzip is essentially zero on Codec streams
 * (RESULTS.md §1f) — so advertising zstd to a server without a
 * pre-trained dict for this tokenizer just risks a worse outcome.
 *
 * Opt back in by passing `{ zstd: true }` only when:
 *   1. You've confirmed the server uses streaming-zstd-with-flush, AND
 *   2. The server has a `zstd_dictionaries[]` entry on the tokenizer
 *      map for the response's stream_format. (Without the dict, the
 *      server SHOULD pick gzip per the picker rule — but advertising
 *      zstd unnecessarily can confuse middleware that doesn't honour
 *      that rule.)
 *
 * Identity is implicit per RFC 7231.
 */
export function buildAcceptEncoding(opts?: {
  zstd?: boolean;
  gzip?: boolean;
  br?: boolean;
}): string {
  const want = { zstd: false, gzip: true, br: true, ...opts };
  const parts: string[] = [];
  if (want.gzip) parts.push('gzip;q=1.0');
  if (want.br) parts.push('br;q=0.5');
  if (want.zstd) parts.push('zstd;q=0.3');
  return parts.join(', ');
}

/**
 * Pretty-print the threshold rule for documentation / log lines.
 */
export function describeRule(_t: Thresholds = DEFAULT_THRESHOLDS): string {
  return [
    `wire-compress policy:`,
    `  zstd     → chosen ONLY when both gates pass for this request:`,
    `              1. zstdHasDict: server has a pre-trained dict for the`,
    `                 (tokenizer_id, stream_format) of this response`,
    `              2. zstdEnabled: middleware uses streaming-zstd-with-flush`,
    `                 (not buffered finalisation; see RESULTS.md §1d)`,
    `             with both true, zstd-with-dict beats gzip on bytes (16-38%`,
    `             smaller, RESULTS.md §1g) at +0.13 ms streaming-TTFB`,
    `  gzip     → universal default; what you ship when no dict is loaded.`,
    `             zstd-no-dict is NEVER chosen — bytes ≈ gzip but TTFB cliff`,
    `             on shipped middleware. Dict is the precondition, not an`,
    `             optimization on top.`,
    `  brotli   → fallback when client doesn't accept gzip (Safari/iOS edge)`,
    `  identity → last resort only`,
  ].join('\n');
}
