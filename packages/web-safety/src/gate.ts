/**
 * `SafetyGate` — pure-logic prefilter gate. Framework-free; the host
 * (leet, codec-website, future clients) implements the dialog UI in its
 * own component system using the gate's view-model.
 *
 * Lifecycle:
 *
 *   const gate = new SafetyGate({ scanText, redactMatches });
 *   const decision = gate.check("paste with AKIA1234567890ABCDEF in it");
 *   if (decision.kind === "blocked") {
 *     // show modal with decision.matches; user picks an action:
 *     const action = await showHostModal(decision);
 *     const result = gate.apply(decision, action);
 *     // result.kind === "send" | "cancel"
 *     // result.text is the (possibly redacted) string to send.
 *   } else {
 *     send(decision.text);
 *   }
 */
import {
  scanText as defaultScanText,
  redactMatches as defaultRedactMatches,
  type PrefilterCategory,
  type PrefilterMatch,
  type PrefilterOptions,
} from './prefilter.js';

/** What a decision means after running the prefilter against an input. */
export type PrefilterDecision =
  | { readonly kind: 'clean'; readonly text: string }
  | {
      readonly kind: 'blocked';
      readonly text: string;
      readonly matches: ReadonlyArray<PrefilterMatch>;
      /** Categories present in `matches`. Useful for headers like "Found: secrets, pii". */
      readonly categories: ReadonlyArray<PrefilterCategory>;
    };

/** The action a user picks when a dialog is shown for a blocked input. */
export type GateUserAction =
  | { readonly kind: 'redact' }
  | { readonly kind: 'send_anyway' }
  | { readonly kind: 'cancel' };

/** Result of resolving a blocked decision with a user action. */
export type GateResolution =
  | { readonly kind: 'send'; readonly text: string; readonly redacted: boolean; readonly redactedCount: number }
  | { readonly kind: 'cancel' };

export interface SafetyGateOptions {
  /** Forwarded to scanText. */
  readonly prefilter?: PrefilterOptions;
  /**
   * Override the prefilter scanner (mostly for tests / DI). Defaults to
   * the package's `scanText`.
   */
  readonly scan?: typeof defaultScanText;
  /** Override the redactor. Defaults to the package's `redactMatches`. */
  readonly redact?: typeof defaultRedactMatches;
  /**
   * Audit hook called whenever the gate produces a decision. The host
   * uses this for telemetry — never put PII in your telemetry; the hook
   * receives only counts and category names, not the matched values.
   */
  readonly audit?: (event: SafetyGateAuditEvent) => void;
}

export interface SafetyGateAuditEvent {
  readonly at: number; // epoch ms
  readonly kind: 'clean' | 'blocked' | 'send_anyway' | 'redacted' | 'cancelled';
  readonly categories?: ReadonlyArray<PrefilterCategory>;
  readonly matchCount?: number;
}

export class SafetyGate {
  private readonly opts: SafetyGateOptions;

  constructor(opts: SafetyGateOptions = {}) {
    this.opts = opts;
  }

  /** Run the prefilter against an input. Pure; no side effects beyond audit. */
  check(text: string): PrefilterDecision {
    const scan = this.opts.scan ?? defaultScanText;
    const matches = scan(text, this.opts.prefilter);
    if (matches.length === 0) {
      this.opts.audit?.({ at: Date.now(), kind: 'clean' });
      return { kind: 'clean', text };
    }
    const seen = new Set<PrefilterCategory>();
    for (const m of matches) seen.add(m.category);
    this.opts.audit?.({
      at: Date.now(),
      kind: 'blocked',
      categories: [...seen],
      matchCount: matches.length,
    });
    return {
      kind: 'blocked',
      text,
      matches,
      categories: [...seen],
    };
  }

  /**
   * Resolve a blocked decision with a user action. Returns the text to
   * send (possibly redacted), or `cancel` if the user backed out.
   */
  apply(decision: PrefilterDecision, action: GateUserAction): GateResolution {
    if (decision.kind === 'clean') {
      // Clean inputs short-circuit; honor cancel anyway for symmetry.
      if (action.kind === 'cancel') {
        this.opts.audit?.({ at: Date.now(), kind: 'cancelled' });
        return { kind: 'cancel' };
      }
      return { kind: 'send', text: decision.text, redacted: false, redactedCount: 0 };
    }

    switch (action.kind) {
      case 'redact': {
        const redact = this.opts.redact ?? defaultRedactMatches;
        const { redacted, count } = redact(decision.text, decision.matches);
        this.opts.audit?.({
          at: Date.now(),
          kind: 'redacted',
          categories: decision.categories,
          matchCount: count,
        });
        return { kind: 'send', text: redacted, redacted: true, redactedCount: count };
      }
      case 'send_anyway': {
        this.opts.audit?.({
          at: Date.now(),
          kind: 'send_anyway',
          categories: decision.categories,
          matchCount: decision.matches.length,
        });
        return {
          kind: 'send',
          text: decision.text,
          redacted: false,
          redactedCount: 0,
        };
      }
      case 'cancel': {
        this.opts.audit?.({
          at: Date.now(),
          kind: 'cancelled',
          categories: decision.categories,
          matchCount: decision.matches.length,
        });
        return { kind: 'cancel' };
      }
    }
  }
}
