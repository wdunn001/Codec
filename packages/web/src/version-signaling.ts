/**
 * Codec version negotiation: client-side surface for the v0.4 wire
 * contract in `spec/versions/v0.4.md`:
 *
 *   - § Version Compatibility Signaling (Codec-Client-Version, 426 path)
 *   - § Capabilities are opt-on at the server (two-stage)
 *   - § Graceful downgrade (response shaping)
 *
 * The package speaks v0.4 of the protocol. Every outbound request SHOULD
 * carry `Codec-Client-Version: 0.4` so a v0.4-mandating server can
 * decide whether to serve, downgrade, or refuse with a structured 426.
 *
 * Typical usage:
 *
 *     import { withCodecClientVersion, parseVersionRequired } from '@codecai/web';
 *
 *     const resp = await fetch(url, withCodecClientVersion({ method: 'POST', body }));
 *     if (resp.status === 426) {
 *       const err = await parseVersionRequired(resp);
 *       throw err;  // CodecVersionRequiredError: surfaces the upgrade prompt
 *     }
 */

// The protocol version this package speaks. Bumped when the package
// implements support for a new minor protocol version. Use a string
// (not a number) so the literal "0.4" round-trips through JSON without
// floating-point drift on languages that parse it as a number.
export const CODEC_CLIENT_VERSION = '0.4' as const;

/** Request header name. Lower-cased to match Fetch API normalization. */
export const CODEC_CLIENT_VERSION_HEADER = 'codec-client-version';

/** Response header name (advisory; see spec § HTTP-transport shape). */
export const CODEC_MIN_VERSION_HEADER = 'codec-min-version';

/** Response header name; emitted on 426. */
export const CODEC_REQUIRED_FEATURES_HEADER = 'codec-required-features';

// ── Outbound: stamp the client version on requests ──────────────────────────

/**
 * Return a new `RequestInit` with `Codec-Client-Version` set. If the
 * caller already passed a header collection (object, Headers, or array
 * of tuples) it's merged in: the version header is added if absent
 * and left alone if the caller explicitly set it (so test harnesses
 * can simulate v0.3 clients).
 *
 * Designed to be a thin wrapper around the standard `fetch` second
 * arg. No new fetch implementation; works with any global `fetch`,
 * `node-fetch`, undici, etc.
 *
 * @param init Existing fetch init (or undefined).
 * @param overrideVersion If set, use this value instead of the package
 *   constant. Useful for tests that want to act as a v0.3 client.
 */
export function withCodecClientVersion(
  init?: RequestInit,
  overrideVersion?: string,
): RequestInit {
  const version = overrideVersion ?? CODEC_CLIENT_VERSION;
  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has(CODEC_CLIENT_VERSION_HEADER)) {
    headers.set(CODEC_CLIENT_VERSION_HEADER, version);
  }
  return { ...(init ?? {}), headers };
}

// ── Inbound: parse the structured 426 response ──────────────────────────────

/**
 * The shape of the JSON body on a v0.4 server's `426 Upgrade Required`
 * response per spec § Version Compatibility Signaling.
 *
 * Pre-v0.4 clients that parse this as a generic JSON error can still
 * render `error` + `minimum_version` as a string: the structure
 * degrades gracefully.
 */
export interface CodecVersionRequiredBody {
  readonly error: 'codec_version_required';
  readonly minimum_version: string;
  readonly required_features: readonly string[];
  readonly client_version: string;
  readonly docs_url?: string;
  readonly deployment_id?: string;
}

/**
 * Thrown when a v0.4-mandating server refuses the request with a 426.
 * Carries the structured fields from the response body and headers so
 * application code can render an upgrade prompt or take corrective
 * action (e.g. enable the missing capability and retry).
 */
export class CodecVersionRequiredError extends Error {
  readonly minimumVersion: string;
  readonly requiredFeatures: readonly string[];
  readonly clientVersion: string;
  readonly docsUrl?: string;
  readonly deploymentId?: string;
  /** The raw parsed body, for clients that want to surface more. */
  readonly body: CodecVersionRequiredBody;

  constructor(body: CodecVersionRequiredBody) {
    const features = body.required_features.length
      ? ` (requires: ${body.required_features.join(', ')})`
      : '';
    super(
      `Codec server requires v${body.minimum_version}${features}; this client speaks v${body.client_version}. ${
        body.docs_url ? `See ${body.docs_url}` : ''
      }`.trim(),
    );
    this.name = 'CodecVersionRequiredError';
    this.minimumVersion = body.minimum_version;
    this.requiredFeatures = body.required_features;
    this.clientVersion = body.client_version;
    this.docsUrl = body.docs_url;
    this.deploymentId = body.deployment_id;
    this.body = body;
  }
}

/**
 * Parse a `426 Upgrade Required` response into a `CodecVersionRequiredError`.
 *
 * If the response is NOT a 426, returns null: caller continues with
 * its usual response handling. If the response is 426 but the body
 * isn't shaped like the v0.4 schema (e.g. a pre-v0.4 server that
 * misuses 426 for something else), throws a generic Error with the
 * raw body text: never silently swallows a 426.
 *
 * This function reads the response body. Callers MUST NOT have already
 * consumed the body. After this call the response body is exhausted.
 */
export async function parseVersionRequired(
  resp: Response,
): Promise<CodecVersionRequiredError | null> {
  if (resp.status !== 426) return null;

  // Read once as text, then try to parse: calling .clone() after a
  // failed .json() leaves the body half-consumed and clone() throws.
  const text = await resp.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(
      `Codec server returned 426 Upgrade Required but body was not JSON: ${text.slice(
        0,
        200,
      )}`,
    );
  }

  if (!isVersionRequiredBody(raw)) {
    // 426 with JSON that isn't ours. Fall through with a helpful error
    // rather than misinterpreting the response.
    throw new Error(
      `Codec server returned 426 Upgrade Required with an unrecognized body: ${JSON.stringify(
        raw,
      ).slice(0, 200)}`,
    );
  }

  return new CodecVersionRequiredError(raw);
}

function isVersionRequiredBody(
  raw: unknown,
): raw is CodecVersionRequiredBody {
  if (typeof raw !== 'object' || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return (
    o.error === 'codec_version_required' &&
    typeof o.minimum_version === 'string' &&
    typeof o.client_version === 'string' &&
    Array.isArray(o.required_features) &&
    o.required_features.every((v) => typeof v === 'string')
  );
}

// ── Pre-flight: well-known/codec/version-policy.json ────────────────────────

/**
 * Shape of `.well-known/codec/version-policy.json` per spec §
 * WELL_KNOWN_DISCOVERY.md § Version policy (v0.4+).
 *
 * Returned by deployments that mandate v0.4+ features. Deployments
 * without mandatory features SHOULD NOT publish this document (404 is
 * the normal state for unrestricted deployments).
 */
export interface CodecVersionPolicyDocument {
  readonly minimum_version: string;
  readonly required_features: readonly string[];
  readonly deployment_id?: string;
  readonly docs_url?: string;
  readonly valid_until?: string;
}

export interface DiscoverVersionPolicyOptions {
  /** Origin to query, e.g. "https://api.example.com". */
  readonly origin: string;
  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Pre-flight check of a deployment's minimum-version requirement.
 *
 * Returns the parsed document when the well-known path exists, or
 * `null` when the server returns 404 (the normal state for an
 * unrestricted deployment). Throws on non-404 errors (5xx, malformed
 * body, hash mismatch: none of which are possible silent-skip
 * conditions).
 *
 * Use this if you want to surface "this server requires v0.4" before
 * attempting any real requests. Otherwise let `parseVersionRequired`
 * handle the 426 lazily on first use: both are valid patterns.
 */
export async function discoverVersionPolicy(
  opts: DiscoverVersionPolicyOptions,
): Promise<CodecVersionPolicyDocument | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      '@codecai/web: no global fetch available. Pass `fetchImpl` or upgrade to Node 18+.',
    );
  }

  const url = `${opts.origin.replace(/\/$/, '')}/.well-known/codec/version-policy.json`;
  const resp = await fetchImpl(url, withCodecClientVersion({ method: 'GET' }));

  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch version policy from ${url}: HTTP ${resp.status}`,
    );
  }

  const raw = (await resp.json()) as unknown;
  if (!isVersionPolicyDocument(raw)) {
    throw new Error(
      `Version-policy document at ${url} is malformed: ${JSON.stringify(
        raw,
      ).slice(0, 200)}`,
    );
  }
  return raw;
}

function isVersionPolicyDocument(
  raw: unknown,
): raw is CodecVersionPolicyDocument {
  if (typeof raw !== 'object' || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.minimum_version === 'string' &&
    Array.isArray(o.required_features) &&
    o.required_features.every((v) => typeof v === 'string')
  );
}
