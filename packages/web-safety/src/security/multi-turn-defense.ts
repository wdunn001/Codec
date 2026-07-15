/**
 * Multi-turn / behavioral defenses — companion to
 * spec/proposals/v0.6-security/05-multi-turn-behavioral.md.
 *
 * Detects the structural shapes of many-shot jailbreaks, role-confusion
 * attempts, and prefill injection. Does NOT attempt model-layer safety —
 * that's the model provider's job. These are protocol-shape guards that fire
 * BEFORE the request reaches the model.
 */

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ManyShotDetection {
  /** Number of consecutive (user, assistant) turn pairs at the start of the conversation. */
  consecutivePairs: number;
  /** True if the consecutivePairs count exceeds the threshold. */
  suspicious: boolean;
  /** The threshold that was applied. */
  threshold: number;
}

/**
 * Detect the structural fingerprint of many-shot jailbreaking (Anil et al.
 * NeurIPS 2024): many consecutive (user, assistant) turn pairs at the start
 * of a conversation, before the latest user turn.
 *
 * The detector counts the longest opening run of alternating user/assistant
 * turns. A legitimate fresh conversation has 0–2 such pairs. A many-shot
 * jailbreak typically has dozens to hundreds.
 *
 * Default threshold: 5 (well above legitimate few-shot prompting, well below
 * the power-law sweet spot of many-shot attacks).
 */
export function detectManyShotPattern(
  messages: readonly Message[],
  threshold = 5,
): ManyShotDetection {
  let pairs = 0;
  let i = 0;
  // Skip leading system messages.
  while (i < messages.length && messages[i]?.role === 'system') i++;
  while (i + 1 < messages.length) {
    if (messages[i]?.role === 'user' && messages[i + 1]?.role === 'assistant') {
      pairs++;
      i += 2;
    } else {
      break;
    }
  }
  return { consecutivePairs: pairs, suspicious: pairs >= threshold, threshold };
}

export interface RoleClaimScan {
  /** True if the content contains a `<system>...</system>` block or `system:` role prefix. */
  containsRoleClaim: boolean;
  /** The specific patterns matched. */
  matches: string[];
}

const ROLE_CLAIM_PATTERNS: readonly RegExp[] = [
  /<\s*system\s*>/i,
  /<\s*\/\s*system\s*>/i,
  /<\s*important_instructions\s*>/i,
  /<\s*system-reminder\s*>/i,
  /^\s*(system|developer|admin)\s*:/im,
  /<\|im_start\|>system/i,
  /<\|start_header_id\|>system<\|end_header_id\|>/i,
];

/**
 * Detect attempts in user content to claim or fabricate elevated roles
 * (system / developer / admin). These are the structural shapes of the most
 * common role-confusion injection patterns. A positive result means the user
 * content MUST NOT be forwarded as-is into a model prompt — wrap in
 * untrusted-content tags or sanitize before forwarding.
 */
export function scanForRoleClaims(content: string): RoleClaimScan {
  const matches: string[] = [];
  for (const re of ROLE_CLAIM_PATTERNS) {
    const m = content.match(re);
    if (m) matches.push(m[0]);
  }
  return { containsRoleClaim: matches.length > 0, matches };
}

export interface PrefillValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Validate an assistant-prefill value before passing it to the model API.
 *
 * Per spec/proposals/v0.6-security/05-multi-turn-behavioral.md §5, the safe
 * default is to **never** let user-influenced content flow into the
 * assistant_prefill parameter. This validator enforces that:
 *
 *   - If `fromUserInput` is true, reject categorically.
 *   - Otherwise, scan for role-claim patterns and reject if found
 *     (defense-in-depth — even application-controlled prefills shouldn't
 *     contain forged system framing).
 */
export function validateAssistantPrefill(
  prefill: string,
  options: { fromUserInput: boolean },
): PrefillValidation {
  if (options.fromUserInput) {
    return {
      ok: false,
      reason: 'user-influenced prefill content is forbidden — assistant_prefill must be application-controlled',
    };
  }
  const claim = scanForRoleClaims(prefill);
  if (claim.containsRoleClaim) {
    return {
      ok: false,
      reason: `prefill contains role-claim pattern: ${claim.matches.join(', ')}`,
    };
  }
  return { ok: true };
}

/**
 * Conservative conversation-length guard. Returns whether the message count
 * is within a configured cap. The cap defends against system-prompt eviction
 * via sliding-window truncation: if a conversation grows beyond `maxMessages`
 * the host should force a new conversation rather than slide the window.
 */
export function withinConversationLength(
  messages: readonly Message[],
  maxMessages = 200,
): boolean {
  return messages.length <= maxMessages;
}
