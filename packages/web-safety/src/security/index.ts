/**
 * v0.6 security boundary layer.
 *
 * See spec/proposals/v0.6-security/ for the threat-model docs that motivate
 * these modules. See packages/bench/fixtures/security/ for the attack
 * fixtures used by the test suite.
 */
export {
  sanitizeForCodec,
  normalizeForPolicy,
  normalizeForWire,
  foldConfusables,
  looksLikeSmuggling,
} from './sanitize.js';
export type { SanitizeOptions, SanitizeResult } from './sanitize.js';

export { filterMarkdownOutput } from './output-filter.js';
export type { OutputFilterOptions, FilteredOutput } from './output-filter.js';

export {
  decodeWithBudget,
  validateFramedLength,
  negotiateCompression,
  CodecDecompressionBudgetExceeded,
  CodecLengthMismatch,
  CodecNegotiationFailure,
} from './wire-defense.js';
export type { CompressionAlgo, DeploymentTier } from './wire-defense.js';

export {
  sanitizeToolDescription,
  wrapUntrustedContent,
  detectToolNameCollisions,
} from './agent-defense.js';
export type {
  ToolDescriptionScan,
  TrustTier,
  ToolName,
  CollisionResult,
} from './agent-defense.js';

export {
  detectManyShotPattern,
  scanForRoleClaims,
  validateAssistantPrefill,
  withinConversationLength,
} from './multi-turn-defense.js';
export type {
  Message,
  ManyShotDetection,
  RoleClaimScan,
  PrefillValidation,
} from './multi-turn-defense.js';
