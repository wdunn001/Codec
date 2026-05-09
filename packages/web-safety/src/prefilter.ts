/**
 * Layer 1 — client-side prefilter for the Codec safety architecture.
 *
 * Catches secrets, API keys, PII, and obvious abuse patterns in the user's
 * input *before* it gets tokenized and sent over the wire. Doomed prompts
 * never use uplink, never hit server inference budget, never need server-
 * side moderation.
 *
 * Pure regex + Shannon-entropy detection. Zero deps beyond the JS stdlib;
 * runs in browsers, Node, edge runtimes. ~200 LOC of explicit rules — no
 * JS port of trufflehog/gitleaks exists today and a focused detector is
 * easier to audit than a kitchen-sink import.
 */

// ── Result shape ─────────────────────────────────────────────────────────────

/** Canonical category names. Match the safety-policy.schema.json registry. */
export type PrefilterCategory =
  | 'secrets'
  | 'pii'
  | 'high_entropy';

/** A single match within an input string. */
export interface PrefilterMatch {
  /** Category the match was assigned to. */
  readonly category: PrefilterCategory;
  /**
   * Specific rule that fired (e.g. `aws_access_key`, `email`,
   * `entropy_base64`). Useful for telemetry and for UIs that want to
   * label *why* something tripped.
   */
  readonly rule: string;
  /** UTF-16 code-unit offsets — the same the host's <input> uses. */
  readonly start: number;
  readonly end: number;
  /** The literal substring that matched, for display. */
  readonly value: string;
  /**
   * Self-reported confidence in [0, 1]. Regex rules report 1.0; entropy
   * rules report a normalized score derived from observed Shannon
   * entropy. Hosts may threshold at e.g. 0.7 to suppress noisy detections.
   */
  readonly confidence: number;
}

export interface PrefilterOptions {
  /**
   * Categories to run. Defaults to all. A host that only wants secret
   * detection (no PII) passes `categories: ['secrets', 'high_entropy']`.
   */
  readonly categories?: ReadonlyArray<PrefilterCategory>;
  /**
   * Minimum confidence to include in results. Defaults to 0.7.
   */
  readonly minConfidence?: number;
  /**
   * Minimum Shannon entropy (bits) for the entropy rules. Defaults to 4.0.
   * 4.5 catches most base64-encoded secrets while suppressing prose.
   */
  readonly minEntropy?: number;
  /**
   * Minimum length for the entropy rules to consider a substring.
   * Defaults to 24 (typical API token length floor).
   */
  readonly minEntropyLength?: number;
}

// ── Rules ────────────────────────────────────────────────────────────────────
//
// Each rule has a category, a stable id, and a regex. Rules are ordered by
// specificity so a more-specific rule (e.g. `github_pat`) wins over a
// generic catch-all (e.g. `entropy_base64`). The matcher dedupes overlaps.

interface RegexRule {
  readonly category: PrefilterCategory;
  readonly rule: string;
  readonly pattern: RegExp;
  readonly confidence: number;
}

const REGEX_RULES: readonly RegexRule[] = [
  // ── Secrets (high confidence, vendor-anchored prefixes) ───────────────────
  {
    category: 'secrets',
    rule: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    confidence: 1.0,
  },
  {
    category: 'secrets',
    rule: 'aws_session_token',
    pattern: /\bASIA[0-9A-Z]{16}\b/g,
    confidence: 1.0,
  },
  {
    category: 'secrets',
    rule: 'github_pat',
    // Personal access tokens, OAuth tokens, user-to-server, server-to-server, refresh.
    pattern: /\bghp_[A-Za-z0-9]{36}\b|\bgho_[A-Za-z0-9]{36}\b|\bghu_[A-Za-z0-9]{36}\b|\bghs_[A-Za-z0-9]{36}\b|\bghr_[A-Za-z0-9]{36}\b/g,
    confidence: 1.0,
  },
  {
    category: 'secrets',
    rule: 'openai_key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    confidence: 0.95,
  },
  {
    category: 'secrets',
    rule: 'anthropic_key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    confidence: 1.0,
  },
  {
    category: 'secrets',
    rule: 'google_api_key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    confidence: 0.95,
  },
  {
    category: 'secrets',
    rule: 'slack_token',
    pattern: /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/g,
    confidence: 1.0,
  },
  {
    category: 'secrets',
    rule: 'stripe_secret',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
    confidence: 1.0,
  },
  {
    category: 'secrets',
    rule: 'ssh_private_key',
    // Match the BEGIN header line; the whole block is what's sensitive
    // but the header alone is a strong signal.
    pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g,
    confidence: 1.0,
  },
  {
    category: 'secrets',
    rule: 'jwt',
    // Three base64url segments. JWTs are not always secrets, but emitting
    // one in chat is almost always a mistake.
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    confidence: 0.85,
  },

  // ── PII (medium confidence; hosts MAY disable per persona) ────────────────
  {
    category: 'pii',
    rule: 'email',
    // Conservative — won't catch every RFC-5322 case, but rare in non-PII text.
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: 0.8,
  },
  {
    category: 'pii',
    rule: 'phone_us',
    // North American Numbering Plan; intentionally narrow.
    pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    confidence: 0.7,
  },
  {
    category: 'pii',
    rule: 'ssn_us',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: 0.85,
  },
  {
    category: 'pii',
    rule: 'credit_card_candidate',
    // 13-19 digits with optional dashes/spaces; final Luhn check happens
    // in scanText() to suppress false positives on order numbers etc.
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    confidence: 0.6,
  },
];

// ── Shannon entropy ──────────────────────────────────────────────────────────

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let h = 0;
  const n = s.length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// Match runs of base64-ish or hex-ish characters. We DON'T anchor on
// vendor prefixes here; this is the catch-all for "looks like an API key
// of unknown vendor."
const BASE64_RUN = /[A-Za-z0-9+/=_-]{24,}/g;
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g;

// ── Luhn ─────────────────────────────────────────────────────────────────────

function luhnValid(digits: string): boolean {
  // Accepts a string of pure digits (caller strips separators).
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits.charAt(i);
    let d = ch.charCodeAt(0) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ── Core scanner ─────────────────────────────────────────────────────────────

/**
 * Run the prefilter against a candidate input string. Returns a list of
 * matches in left-to-right order. Overlapping matches with the same
 * (start, end) span are deduplicated, keeping the highest-confidence rule.
 *
 *   const matches = scanText("my AWS key is AKIAIOSFODNN7EXAMPLE");
 *   matches[0].rule // → "aws_access_key"
 */
export function scanText(text: string, opts: PrefilterOptions = {}): PrefilterMatch[] {
  const enabled = new Set<PrefilterCategory>(
    opts.categories ?? ['secrets', 'pii', 'high_entropy'],
  );
  const minConfidence = opts.minConfidence ?? 0.7;
  const minEntropy = opts.minEntropy ?? 4.0;
  const minEntropyLength = opts.minEntropyLength ?? 24;

  const matches: PrefilterMatch[] = [];

  // Regex rules.
  for (const rule of REGEX_RULES) {
    if (!enabled.has(rule.category)) continue;
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const value = m[0];
      const start = m.index;
      const end = start + value.length;

      // Credit card candidate: gate on Luhn before reporting.
      if (rule.rule === 'credit_card_candidate') {
        const digits = value.replace(/[^\d]/g, '');
        if (!luhnValid(digits)) continue;
      }

      if (rule.confidence < minConfidence) continue;

      matches.push({
        category: rule.category,
        rule: rule.rule,
        start,
        end,
        value,
        confidence: rule.confidence,
      });
    }
  }

  // Entropy rules — only run if `high_entropy` is enabled.
  if (enabled.has('high_entropy')) {
    for (const re of [BASE64_RUN, HEX_RUN]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const value = m[0];
        if (value.length < minEntropyLength) continue;
        const h = shannonEntropy(value);
        if (h < minEntropy) continue;
        const start = m.index;
        const end = start + value.length;

        // Skip if a more-specific regex rule already covers this span.
        if (
          matches.some(
            (existing) =>
              existing.start <= start && existing.end >= end && existing.confidence >= 0.85,
          )
        ) {
          continue;
        }

        // Normalize entropy to a confidence in [0, 1]:
        //   4.0 bits → 0.7, 5.0 → 0.85, 6.0+ → 0.95 (max for entropy-only).
        const confidence = Math.min(0.95, 0.7 + (h - 4.0) * 0.15);
        if (confidence < minConfidence) continue;

        matches.push({
          category: 'high_entropy',
          rule: re === HEX_RUN ? 'entropy_hex' : 'entropy_base64',
          start,
          end,
          value,
          confidence,
        });
      }
    }
  }

  // Dedupe exact-span matches, keeping highest confidence.
  matches.sort((a, b) =>
    a.start - b.start || a.end - b.end || b.confidence - a.confidence,
  );
  const deduped: PrefilterMatch[] = [];
  for (const m of matches) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.start === m.start && prev.end === m.end) {
      // Same span; keep whichever has higher confidence (already sorted).
      continue;
    }
    deduped.push(m);
  }
  return deduped;
}

/**
 * Apply a redaction to the input, replacing each matched span with a
 * `[REDACTED:<rule>]` placeholder. Returns the new string and the count
 * of replacements made — useful so the host can show "redacted N items"
 * in its UI.
 */
export function redactMatches(
  text: string,
  matches: ReadonlyArray<PrefilterMatch>,
): { readonly redacted: string; readonly count: number } {
  if (matches.length === 0) return { redacted: text, count: 0 };

  // Sort right-to-left so offsets remain valid as we splice.
  const ordered = [...matches].sort((a, b) => b.start - a.start);
  let out = text;
  let count = 0;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const m of ordered) {
    // Skip matches that overlap with an already-applied redaction.
    if (m.end > lastStart) continue;
    out = out.slice(0, m.start) + `[REDACTED:${m.rule}]` + out.slice(m.end);
    lastStart = m.start;
    count++;
  }
  return { redacted: out, count };
}
