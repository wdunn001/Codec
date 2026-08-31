/**
 * wire-compress: pick the right Content-Encoding for streaming responses.
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
 *   4. Fall back gracefully: gzip is the universal floor; identity is the
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
   * encodings that buffer the whole response: measured TTFT goes from
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
   * first byte: TTFT regresses 334× at 2K tokens (11 ms → 3,684 ms).
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
   * didn't advertise it: gzip is preferred at every size.
   */
  zstdEnabled?: boolean;
  /**
   * Whether the server has a pre-trained zstd dictionary loaded for the
   * `(tokenizer_id, stream_format)` of *this specific request*. **The new
   * primary gate for selecting zstd.**
   *
   * Without a dict, no-dict zstd's wire-byte advantage over gzip is small
   * (RESULTS.md §1f puts gzip and no-dict zstd within noise of each other
   * on Codec streams: 3.4 B/token vs 3.4 B/token), but its TTFB cost on
   * shipped buffered middleware is catastrophic (RESULTS.md §1d, 334× at
   * 2K tokens). So no-dict zstd is the *worst of both worlds*: same bytes
   * as gzip, much worse TTFB.
   *
   * The dict is therefore not an optimization on top of zstd: it's the
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
  /**
   * Optional per-stack profile (v0.5). When supplied, the picker uses the
   * profile's `wireCoeff` / `ttftRatio` to override the bundled defaults.
   * Pick the closest match via `profileFor(stackName)` or supply a custom
   * `StackProfile`.
   *
   * Behaviour:
   *   - An encoding's `ttftRatio > MAX_TTFT_RATIO` (default 5) gets removed
   *     from candidates: e.g. sglang's buffered-zstd ttftRatio=334 means
   *     zstd is dropped on that stack even when both client + server
   *     advertise it.
   *   - Among the remaining candidates, the encoding with the lowest
   *     `wireCoeff` wins. Ties broken by the legacy preference order
   *     (zstd > gzip > br > identity).
   *
   * Defaults to STACK_PROFILES.default if absent.
   */
  stackProfile?: StackProfile;
  /**
   * Optional content sample (v0.5). When provided, the picker computes
   * the Shannon entropy of the first N bytes and uses it as a tiebreaker:
   *   - low entropy (< 3 bits/byte): prefer brotli (its static dict
   *     captures structural repetition Codec can't)
   *   - high entropy (>= 3 bits/byte): prefer dict-zstd
   *
   * Typically N=256. Set this from the first bytes the server has buffered
   * before committing the Content-Encoding header. Optional: the picker
   * works without it.
   */
  sampleBytes?: Uint8Array;
}

/** Per-stack profiles where an encoding with ttftRatio above this gets dropped. */
export const MAX_TTFT_RATIO = 5;
/** Shannon-entropy boundary (bits/byte) for the content-aware tiebreaker. */
export const LOW_ENTROPY_THRESHOLD = 3.0;

/**
 * Enum of pick() decisions. Each value identifies one branch of the picker's
 * decision tree, so dashboards can group/count outcomes without parsing free
 * text. The closed enum is the v0.5 contract; new picker branches require a
 * new enum value (additive: never reassign / never remove existing ones,
 * same trust posture as the wire-format versioning policy).
 */
export type PickReasonCode =
  /** Both zstd gates passed, no per-stack override. */
  | 'dict_zstd_default'
  /** Per-stack profile downgraded zstd (e.g. sglang ttftRatio > threshold). */
  | 'per_stack_overrode_zstd'
  /** zstd gated off because client didn't advertise it. */
  | 'gzip_no_zstd_in_accept'
  /** zstd gated off because zstdHasDict=false (no dict for this request). */
  | 'gzip_no_dict'
  /** zstd gated off because zstdEnabled=false (middleware not confirmed streaming). */
  | 'gzip_middleware_disabled'
  /** Content sample suggested low entropy + br outperforms gzip on that. */
  | 'br_content_sample_low_entropy'
  /** br is the only non-identity option (no gzip / no zstd accepted). */
  | 'br_fallback_no_gzip'
  /** Per-stack profile downgraded br (e.g. sglang's broken per-frame compression). */
  | 'per_stack_overrode_br'
  /** Client supports nothing compressible. Last-resort. */
  | 'identity_last_resort';

export interface PickOutput {
  /** The Content-Encoding to apply. 'identity' means: send raw, no encoding header. */
  encoding: Encoding;
  /**
   * Closed-enum decision code (v0.5). Use this for dashboard grouping.
   * The `reason` string carries the human-readable expansion.
   */
  reason_code: PickReasonCode;
  /**
   * Short human-readable rationale for logs. Format may change between
   * minor versions: use `reason_code` for programmatic dispatch.
   */
  reason: string;
  /** The candidate set considered, post all gates. For debugging. */
  considered?: Encoding[];
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
 * `default` is conservative: assumes typical streaming-aware gzip,
 * working zstd with a buffering quirk (the sglang pattern), and a br
 * implementation of unknown quality.
 */
export const STACK_PROFILES: Record<string, StackProfile> = {
  default: {
    name: 'default',
    // v0.5: zstd ttftRatio dropped from 100 → 1.0 (sglang / vllm /
    // llama.cpp all stream zstd correctly at v0.4.1+; v0.4's defensive
    // assumption is no longer justified). Operators with confirmed
    // buffered-zstd middleware should supply a custom StackProfile.
    encodings: {
      gzip: { wireCoeff: 0.05, ttftRatio: 1.0 },
      br: { wireCoeff: 0.5, ttftRatio: 1.0 },
      zstd: { wireCoeff: 0.04, ttftRatio: 1.0 },
    },
  },
  sglang: {
    name: 'sglang',
    // Originally measured 2024-05 (buffered-zstd era). v0.4.1 cohort
    // re-bench (2026-05-15) shows streaming-zstd works correctly:
    // ttftRatio dropped 334 → 1.0. br fix is still pending in the
    // sglang fork (per-frame compression occasionally expands the
    // payload; see RESULTS.md §1f). Until that lands, br stays
    // weighted out via wireCoeff.
    encodings: {
      gzip: { wireCoeff: 0.023, ttftRatio: 1.0 },
      br: { wireCoeff: 0.733, ttftRatio: 1.0 },
      zstd: { wireCoeff: 0.017, ttftRatio: 1.0 },
    },
  },
  'llama.cpp': {
    name: 'llama.cpp',
    // Measured 2024-05 against PR #22757. The PR ships codec wire formats
    // but does NOT add any compression middleware: every Accept-Encoding
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
// the data is noisy: both gzip and zstd are within 10% of optimal. We pick
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
 *   1. Parse Accept-Encoding (if absent, treat as gzip-only: RFC 7231 §5.3.4
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
    interactive = true,
    zstdEnabled = true,  // v0.5: default flipped (was false in v0.4).
                          // sglang/vllm/llamacpp all stream zstd correctly
                          // at v0.4.1+; operators with buffered-zstd
                          // middleware MUST set this false explicitly.
    zstdHasDict = false,
    stackProfile = STACK_PROFILES.default!,
    sampleBytes,
  } = input;
  const serverCandidates: Set<Encoding> = new Set(
    input.serverSupports ?? ['identity', 'gzip', 'br', 'zstd'],
  );

  const client = parseAcceptEncoding(acceptEncoding);
  const candidates = new Set<Encoding>();
  for (const enc of client.accepted) if (serverCandidates.has(enc)) candidates.add(enc);

  // ── Stage 1: hard zstd gates (unchanged from v0.4) ──────────────────────
  let droppedZstdReason: PickReasonCode | null = null;
  if (!candidates.has('zstd')) {
    droppedZstdReason = 'gzip_no_zstd_in_accept';
  } else if (!zstdHasDict) {
    candidates.delete('zstd');
    droppedZstdReason = 'gzip_no_dict';
  } else if (!zstdEnabled) {
    candidates.delete('zstd');
    droppedZstdReason = 'gzip_middleware_disabled';
  }

  // ── Stage 2: per-stack profile drops (v0.5) ─────────────────────────────
  // Drop any encoding whose ttftRatio on this stack exceeds the safe limit.
  let perStackOverroteZstd = false;
  let perStackOverroteBr = false;
  for (const enc of ['zstd', 'br', 'gzip'] as const) {
    if (!candidates.has(enc)) continue;
    const chars = stackProfile.encodings[enc];
    if (chars && chars.ttftRatio > MAX_TTFT_RATIO) {
      candidates.delete(enc);
      if (enc === 'zstd') perStackOverroteZstd = true;
      if (enc === 'br') perStackOverroteBr = true;
    }
  }

  const considered = Array.from(candidates).sort();
  const has = (e: Encoding) => candidates.has(e);

  // ── Stage 3: content-aware tiebreaker (v0.5) ────────────────────────────
  // When the caller supplied a content sample AND both br + zstd are still
  // viable, pick whichever the entropy suggests will compress better. Low
  // entropy → brotli (its static dict captures structural patterns); high
  // entropy → dict-zstd (its trained dict captures token-bigram patterns).
  if (sampleBytes && has('br') && has('zstd')) {
    const ent = shannonEntropyBitsPerByte(sampleBytes);
    if (ent < LOW_ENTROPY_THRESHOLD) {
      return mkResult('br', 'br_content_sample_low_entropy',
        `br (content sample entropy=${ent.toFixed(2)} < ${LOW_ENTROPY_THRESHOLD}; ` +
        `${interactive ? 'interactive' : 'agent'}; size=${estimatedSize})`,
        considered);
    }
    // High entropy → fall through to the default zstd-wins branch below.
  }

  if (has('zstd')) {
    return mkResult('zstd', 'dict_zstd_default',
      `dict-zstd (both gates passed; stack=${stackProfile.name}; ` +
      `${interactive ? 'interactive' : 'agent'}; size=${estimatedSize})`,
      considered);
  }

  if (perStackOverroteZstd) {
    if (has('gzip')) {
      return mkResult('gzip', 'per_stack_overrode_zstd',
        `gzip (stack=${stackProfile.name} ttftRatio for zstd > ${MAX_TTFT_RATIO}; ` +
        `size=${estimatedSize})`,
        considered);
    }
  }

  if (has('gzip')) {
    return mkResult('gzip',
      droppedZstdReason ?? 'gzip_no_zstd_in_accept',
      `gzip (${droppedZstdReason ?? 'no zstd in client Accept-Encoding'}; ` +
      `stack=${stackProfile.name}; size=${estimatedSize})`,
      considered);
  }

  if (perStackOverroteBr) {
    // br was dropped but caller also has no gzip: fall through to identity.
  }

  if (has('br')) {
    return mkResult('br', 'br_fallback_no_gzip',
      `br fallback (no gzip in candidate set; stack=${stackProfile.name}; ` +
      `size=${estimatedSize})`,
      considered);
  }

  return mkResult('identity', 'identity_last_resort',
    `client supports nothing compressible; identity (stack=${stackProfile.name})`,
    considered);
}

function mkResult(
  encoding: Encoding,
  reason_code: PickReasonCode,
  reason: string,
  considered: Encoding[],
): PickOutput {
  return { encoding, reason_code, reason, considered };
}

/**
 * Shannon entropy of `bytes` in bits/byte. Uniform random ≈ 8.0;
 * English text ≈ 4-5; long runs of one byte → near 0.
 */
export function shannonEntropyBitsPerByte(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const counts = new Int32Array(256);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]!]++;
  let h = 0;
  const n = bytes.length;
  for (let b = 0; b < 256; b++) {
    const c = counts[b]!;
    if (c === 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
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
 * (RESULTS.md §1f): so advertising zstd to a server without a
 * pre-trained dict for this tokenizer just risks a worse outcome.
 *
 * Opt back in by passing `{ zstd: true }` only when:
 *   1. You've confirmed the server uses streaming-zstd-with-flush, AND
 *   2. The server has a `zstd_dictionaries[]` entry on the tokenizer
 *      map for the response's stream_format. (Without the dict, the
 *      server SHOULD pick gzip per the picker rule: but advertising
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
    `             zstd-no-dict is NEVER chosen: bytes ≈ gzip but TTFB cliff`,
    `             on shipped middleware. Dict is the precondition, not an`,
    `             optimization on top.`,
    `  brotli   → fallback when client doesn't accept gzip (Safari/iOS edge)`,
    `  identity → last resort only`,
  ].join('\n');
}
