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
   * size. For agent-to-agent or batch traffic where the consumer reads
   * the whole response anyway, set `interactive: false` to unlock
   * zstd's full ratio.
   *
   * See RESULTS.md §1d (TTFT cliff chart) for the measured data.
   */
  interactive?: boolean;
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
  // vLLM and llama.cpp profiles will be filled in as the cross-stack
  // bench results land. Until then they fall through to `default`.
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
  } = input;
  const serverCandidates: Set<Encoding> = new Set(
    input.serverSupports ?? ['identity', 'gzip', 'br', 'zstd'],
  );

  const client = parseAcceptEncoding(acceptEncoding);
  const candidates = new Set<Encoding>();
  for (const enc of client.accepted) if (serverCandidates.has(enc)) candidates.add(enc);

  const has = (e: Encoding) => candidates.has(e);

  // Interactive streams: avoid zstd because typical implementations
  // buffer the full response (TTFT cliff: ~11 ms → ~3.8 s at 2K tokens).
  // gzip flushes per-chunk and preserves TTFT, with most of the wire win.
  if (interactive) {
    if (has('gzip')) {
      return {
        encoding: 'gzip',
        reason: `interactive=true → gzip (preserves TTFT; zstd would buffer)`,
      };
    }
    if (has('br')) {
      return {
        encoding: 'br',
        reason: `interactive=true, no gzip → br fallback`,
      };
    }
    if (has('zstd')) {
      return {
        encoding: 'zstd',
        reason: `interactive=true, but only zstd supported — accepting TTFT regression`,
      };
    }
    return { encoding: 'identity', reason: `interactive=true, nothing compressible` };
  }

  // Non-interactive (agent-to-agent, batch). TTFT doesn't matter, optimize
  // for wire bytes.
  if (estimatedSize >= thresholds.zstdPreferredFrom && has('zstd')) {
    return { encoding: 'zstd', reason: `size=${estimatedSize} >= ${thresholds.zstdPreferredFrom} → zstd` };
  }
  if (estimatedSize <= thresholds.gzipPreferredUpTo && has('gzip')) {
    return { encoding: 'gzip', reason: `size=${estimatedSize} <= ${thresholds.gzipPreferredUpTo} → gzip` };
  }
  // Mid-band: zstd > gzip, since the data shows them within 10% of each other
  // there but zstd keeps amortising as the stream grows past the estimate.
  if (has('zstd')) {
    return { encoding: 'zstd', reason: `mid-band, zstd preferred over gzip when supported` };
  }
  if (has('gzip')) {
    return { encoding: 'gzip', reason: `mid-band, fell back to gzip (zstd unsupported)` };
  }
  // Neither modern encoder available — brotli is the legacy-browser fallback.
  if (has('br')) {
    return { encoding: 'br', reason: `gzip and zstd unsupported by client; falling back to br` };
  }
  return { encoding: 'identity', reason: `client supports nothing compressible; identity` };
}

// ─── Helpers callers usually want ───────────────────────────────────────────

/**
 * Build the Accept-Encoding header a client should send to maximise its
 * chance of getting the best encoding back. Use this on the client side.
 *
 * Returns: "zstd;q=1.0, gzip;q=0.9, br;q=0.5" by default.
 *
 * The q-values reflect the measured preference order on streaming Codec
 * frames: zstd > gzip > br > identity. Identity is implicit per RFC 7231.
 */
export function buildAcceptEncoding(opts?: {
  zstd?: boolean;
  gzip?: boolean;
  br?: boolean;
}): string {
  const want = { zstd: true, gzip: true, br: true, ...opts };
  const parts: string[] = [];
  if (want.zstd) parts.push('zstd;q=1.0');
  if (want.gzip) parts.push('gzip;q=0.9');
  if (want.br) parts.push('br;q=0.5');
  return parts.join(', ');
}

/**
 * Pretty-print the threshold rule for documentation / log lines.
 */
export function describeRule(t: Thresholds = DEFAULT_THRESHOLDS): string {
  return [
    `wire-compress thresholds:`,
    `  size <= ${t.gzipPreferredUpTo}                 → gzip   (smaller header beats zstd)`,
    `  size >= ${t.zstdPreferredFrom}                 → zstd   (dictionary amortises)`,
    `  brotli                          → fallback only (universal client support; bad ratio on streamed small frames)`,
    `  identity                        → fallback only (always works)`,
  ].join('\n');
}
