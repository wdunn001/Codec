/**
 * Server-policy discovery: pre-flight wrapper over
 * `discoverVersionPolicy` from `@codecai/web` that surfaces a friendly
 * tagged-union for safety-aware client code.
 *
 * Pattern:
 *
 *     import { discoverServerPolicy } from '@codecai/web-safety';
 *
 *     const state = await discoverServerPolicy({ origin: 'https://acme.ai' });
 *     if (state.kind === 'unrestricted') {
 *       // No v0.4 mandate. Send requests as a v0.4 client; server
 *       // will graceful-downgrade if it's an older deployment.
 *     } else if (state.kind === 'mandates-v04') {
 *       // Surface state.requiredFeatures + state.minimumVersion in
 *       // the UI so users know enforcement is in play. The specific
 *       // safety policy id arrives on the first real response via
 *       // the Codec-Safety-Policy header; resolve it then via
 *       // discoverSafetyPolicy() from '@codecai/web'.
 *     }
 *
 * Lives in web-safety so consumers who already use the prefilter +
 * classifier registry get the pre-flight in the same import surface.
 * The negotiation primitive itself lives in @codecai/web.
 */

import {
  discoverVersionPolicy,
  type DiscoverVersionPolicyOptions,
} from '@codecai/web';

/** A v0.4 deployment with no mandatory features. */
export interface UnrestrictedServerPolicy {
  readonly kind: 'unrestricted';
}

/** A v0.4 deployment that mandates one or more capabilities. */
export interface MandatedServerPolicy {
  readonly kind: 'mandates-v04';
  readonly minimumVersion: string;
  readonly requiredFeatures: readonly string[];
  readonly deploymentId?: string;
  readonly docsUrl?: string;
  /** Convenience flag: true iff `safety-policy-enforcement` is in
   *  `requiredFeatures`. Saves callers an `.includes()` check. */
  readonly enforcesSafetyPolicy: boolean;
}

export type ServerPolicyState =
  | UnrestrictedServerPolicy
  | MandatedServerPolicy;

export type DiscoverServerPolicyOptions = DiscoverVersionPolicyOptions;

/**
 * One-call pre-flight for a v0.4-aware safety client.
 *
 * Always returns a state: the unrestricted-deployment path is the
 * common case and not an error. 5xx / malformed well-known documents
 * bubble up from `discoverVersionPolicy` as exceptions.
 */
export async function discoverServerPolicy(
  opts: DiscoverServerPolicyOptions,
): Promise<ServerPolicyState> {
  const version = await discoverVersionPolicy(opts);
  if (version === null) {
    return { kind: 'unrestricted' };
  }
  return {
    kind: 'mandates-v04',
    minimumVersion: version.minimum_version,
    requiredFeatures: version.required_features,
    deploymentId: version.deployment_id,
    docsUrl: version.docs_url,
    enforcesSafetyPolicy:
      version.required_features.includes('safety-policy-enforcement'),
  };
}
