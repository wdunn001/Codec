/**
 * Wire-protocol defenses — companion to spec/proposals/v0.6-security/02-wire-protocol-attacks.md.
 *
 * Implements the testable, transport-independent parts of the wire-protocol
 * security checklist: decompression budgeting, length-frame validation, and
 * compression-negotiation downgrade rejection. The actual transport bindings
 * (HTTP/2, SSE, raw TCP) live elsewhere — this module is the policy core.
 */

export class CodecDecompressionBudgetExceeded extends Error {
  constructor(public readonly budgetBytes: number, public readonly seenBytes: number) {
    super(
      `decoded output exceeded budget: budget=${budgetBytes} bytes, seen=${seenBytes} bytes`,
    );
    this.name = 'CodecDecompressionBudgetExceeded';
  }
}

export class CodecLengthMismatch extends Error {
  constructor(public readonly declared: number, public readonly actual: number) {
    super(
      `frame length mismatch: declared=${declared}, actual=${actual} — refusing to truncate-and-continue`,
    );
    this.name = 'CodecLengthMismatch';
  }
}

export class CodecNegotiationFailure extends Error {
  constructor(message: string, public readonly chosen: string) {
    super(message);
    this.name = 'CodecNegotiationFailure';
  }
}

/**
 * Apply a hard size budget to a streaming decode. Pass an async iterable of
 * chunk buffers (from `zlib.createBrotliDecompress()`, `ZstdDecompressor`,
 * etc.) and a budget in bytes. Throws CodecDecompressionBudgetExceeded if the
 * cumulative output exceeds the budget — rejects the whole operation rather
 * than truncating, which is the correct posture for security-sensitive
 * decompression.
 *
 * The bench budget recommended in
 * spec/proposals/v0.6-security/07-codec-client-checklist.md §5 is 16 MiB for
 * the chat tier; configure higher only for batch deployments.
 */
export async function decodeWithBudget(
  chunks: AsyncIterable<Uint8Array>,
  budgetBytes: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.byteLength;
    if (total > budgetBytes) {
      throw new CodecDecompressionBudgetExceeded(budgetBytes, total);
    }
    parts.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/**
 * Strict length-prefix validation. Rejects on mismatch rather than
 * truncate-and-continue. Codec uses length-prefixed framing for several
 * message types (per spec/PROTOCOL.md); reference parsers MUST enforce.
 */
export function validateFramedLength(declared: number, actualBytes: Uint8Array): void {
  if (declared !== actualBytes.byteLength) {
    throw new CodecLengthMismatch(declared, actualBytes.byteLength);
  }
}

export type CompressionAlgo = 'identity' | 'gzip' | 'br' | 'zstd' | 'dict-zstd';
export type DeploymentTier = 'production' | 'staging' | 'development';

/**
 * Compression-negotiation policy. The "silent identity-fallthrough on missing
 * compression dep" pattern (memory: feedback_engine_image_dep_verify) is the
 * worst Codec failure mode. This function refuses identity in the production
 * tier — a peer advertising no compression support is a downgrade signal in
 * production; development tier may allow with a warning surface for the host
 * application to log.
 *
 * Returns the chosen compression. Throws CodecNegotiationFailure on
 * impossible negotiations.
 */
export function negotiateCompression(
  clientSupports: readonly CompressionAlgo[],
  serverSupports: readonly CompressionAlgo[],
  tier: DeploymentTier = 'production',
): { chosen: CompressionAlgo; warning?: string } {
  const preference: CompressionAlgo[] = ['dict-zstd', 'zstd', 'br', 'gzip', 'identity'];
  const both = new Set(clientSupports.filter((c) => serverSupports.includes(c)));
  const chosen = preference.find((p) => both.has(p));
  if (!chosen) {
    throw new CodecNegotiationFailure(
      'no compression algorithm in common between client and server',
      'identity',
    );
  }
  if (chosen === 'identity' && tier === 'production') {
    throw new CodecNegotiationFailure(
      'identity-fallthrough rejected in production tier — set tier="development" to override',
      'identity',
    );
  }
  if (chosen === 'identity') {
    return {
      chosen,
      warning:
        'identity fallthrough — production should never see this; check engine image dep verify',
    };
  }
  return { chosen };
}
