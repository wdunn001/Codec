/**
 * @codecai/web-safety — optional client-side safety layer for Codec.
 *
 * Layer 1 (prefilter): regex + Shannon-entropy detection of secrets, PII,
 * and high-entropy runs. Catches doomed prompts before they hit the wire.
 *
 * Layer 3 (browser classifier): pluggable classifier registry that mirrors
 * the backend `SafetyClassifier` Protocol. Concrete classifier
 * implementations (Prompt Guard 86M via Transformers.js, Llama Guard 3 1B
 * via codec-web-llm) ship in subsequent slices.
 *
 * The package is framework-free. Hosts (leet, codec-website, future web
 * clients) implement the dialog UI in their own component system using
 * the `SafetyGate` view-model.
 *
 * Quick start:
 *
 *   import { SafetyGate } from '@codecai/web-safety';
 *
 *   const gate = new SafetyGate();
 *   const decision = gate.check(prompt);
 *   if (decision.kind === 'blocked') {
 *     const action = await showHostModal(decision); // host UI
 *     const resolution = gate.apply(decision, action);
 *     if (resolution.kind === 'cancel') return;
 *     prompt = resolution.text;
 *   }
 *   // ...tokenize & send via @codecai/web as usual.
 */

// Layer 1 — prefilter
export {
  scanText,
  redactMatches,
  type PrefilterCategory,
  type PrefilterMatch,
  type PrefilterOptions,
} from './prefilter.js';

// Gate — pure-logic decision/apply state machine
export {
  SafetyGate,
  type PrefilterDecision,
  type GateUserAction,
  type GateResolution,
  type SafetyGateOptions,
  type SafetyGateAuditEvent,
} from './gate.js';

// Layer 3 — classifier interface + registry
export {
  type SafetyClassifier,
  type ClassifierInputForm,
  type ClassifierCategory,
  type ClassificationResult,
  type ClassificationInput,
} from './base.js';

export {
  register,
  unregister,
  listClassifiers,
  hasClassifier,
  resolveClassifier,
  type ClassifierFactory,
  type RegistryEntry,
  type ResolveOptions,
  type ResolveResult,
} from './registry.js';
