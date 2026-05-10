/**
 * Pluggable registry of `SafetyClassifier` implementations.
 *
 * Slices 3 (Prompt Guard 86M) and 4 (Llama Guard 3 1B via codec-web-llm)
 * register their factories here at module load time. A policy descriptor
 * carries `classifier.family` (or `client_hooks.client_classifier_family`
 * for browser-side), the host calls `resolveClassifier(modelId)`, and
 * the registry returns a ready-to-use instance — falling back to a
 * lower-tier model if capability detection rules out the requested one.
 */
import type { SafetyClassifier } from './base.js';

export type ClassifierFactory = () => SafetyClassifier;

export interface RegistryEntry {
  readonly modelId: string;
  readonly factory: ClassifierFactory;
  /**
   * Tier hint — lower numbers are "always-runs" (small, CPU-only); higher
   * numbers are "opt-in heavy" (WebGPU, large weights). Used by
   * `resolveClassifier` for fallback ordering when the requested model
   * isn't capable on the current device.
   *
   *   1 — tier 1, always-on (Prompt Guard 86M)
   *   2 — tier 2, opt-in    (Llama Guard 3 1B)
   */
  readonly tier: number;
  /**
   * Optional human-readable description shown in admin UIs that surface
   * the registry (leet's PERSONA tab, codec-supervisor admin).
   */
  readonly description?: string;
}

const REGISTRY = new Map<string, RegistryEntry>();
const INSTANCE_CACHE = new Map<string, SafetyClassifier>();

/**
 * Register a classifier factory. Slice-3/4 modules call this at import
 * time. Re-registering the same `modelId` throws — implementations are
 * meant to be append-only.
 */
export function register(entry: RegistryEntry): void {
  if (REGISTRY.has(entry.modelId)) {
    throw new Error(
      `[@codecai/web-safety] classifier '${entry.modelId}' is already registered`,
    );
  }
  REGISTRY.set(entry.modelId, entry);
}

/**
 * Drop a previously registered classifier. Idempotent: unknown ids
 * silently no-op. Drops the cached instance too — hosts that want to
 * release weights / GPU memory should `await classifier.unload()` first
 * (the registry doesn't because unregistration must stay synchronous
 * for predictable UI toggling). Returns `true` when something was
 * removed, `false` when the id wasn't registered.
 *
 * Used by runtime toggles (e.g. an admin UI flipping the opt-in tier-2
 * classifier on/off).
 */
export function unregister(modelId: string): boolean {
  const had = REGISTRY.delete(modelId);
  INSTANCE_CACHE.delete(modelId);
  return had;
}

/** Test-only: drop a registration (or all registrations if no id given). */
export function _unregisterForTest(modelId?: string): void {
  if (modelId) {
    REGISTRY.delete(modelId);
    INSTANCE_CACHE.delete(modelId);
    return;
  }
  REGISTRY.clear();
  INSTANCE_CACHE.clear();
}

export function listClassifiers(): ReadonlyArray<RegistryEntry> {
  return [...REGISTRY.values()].sort((a, b) => a.tier - b.tier);
}

export function hasClassifier(modelId: string): boolean {
  return REGISTRY.has(modelId);
}

export interface ResolveOptions {
  /**
   * If true, falls back to the lowest-tier capable classifier when the
   * requested one's `capability()` reports unable. Default: true.
   */
  readonly allowFallback?: boolean;
  /** Forwarded to `load()` if the implementation defines one. */
  readonly signal?: AbortSignal;
}

export interface ResolveResult {
  readonly classifier: SafetyClassifier;
  /** True when fallback fired — the host SHOULD surface a "downgraded enforcement" badge. */
  readonly downgraded: boolean;
  /** When `downgraded`, the original modelId the policy asked for. */
  readonly requestedModelId?: string;
  /** When `downgraded`, the reason the requested model couldn't run. */
  readonly downgradeReason?: string;
}

/**
 * Resolve a classifier by model id, running capability detection and
 * (optionally) falling back to the lowest-tier alternative if the
 * requested one isn't supported on the current device.
 *
 *   const { classifier, downgraded } = await resolveClassifier('llama-guard-3-1b');
 *   if (downgraded) badge('Using fallback safety model');
 */
export async function resolveClassifier(
  modelId: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const allowFallback = opts.allowFallback ?? true;

  const requested = REGISTRY.get(modelId);
  if (!requested) {
    if (!allowFallback) {
      throw new Error(
        `[@codecai/web-safety] no classifier registered for '${modelId}'`,
      );
    }
    return await fallbackOrThrow(modelId, `no classifier registered for '${modelId}'`, opts);
  }

  const candidate = await getInstance(requested);
  const reason = candidate.capability ? await candidate.capability() : null;
  if (reason === null) {
    if (candidate.load) await candidate.load({ signal: opts.signal });
    return { classifier: candidate, downgraded: false };
  }

  if (!allowFallback) {
    throw new Error(
      `[@codecai/web-safety] '${modelId}' not supported here: ${reason}`,
    );
  }
  return await fallbackOrThrow(modelId, reason, opts);
}

async function fallbackOrThrow(
  requestedModelId: string,
  reason: string,
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const candidates = listClassifiers().filter((e) => e.modelId !== requestedModelId);
  for (const entry of candidates) {
    const inst = await getInstance(entry);
    const r = inst.capability ? await inst.capability() : null;
    if (r === null) {
      if (inst.load) await inst.load({ signal: opts.signal });
      return {
        classifier: inst,
        downgraded: true,
        requestedModelId,
        downgradeReason: reason,
      };
    }
  }
  throw new Error(
    `[@codecai/web-safety] no capable classifier available (requested '${requestedModelId}': ${reason})`,
  );
}

async function getInstance(entry: RegistryEntry): Promise<SafetyClassifier> {
  let inst = INSTANCE_CACHE.get(entry.modelId);
  if (!inst) {
    inst = entry.factory();
    INSTANCE_CACHE.set(entry.modelId, inst);
  }
  return inst;
}
