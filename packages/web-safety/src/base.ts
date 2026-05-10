/**
 * SafetyClassifier interface — the modular contract slices 3, 4 (and
 * future implementations) implement.
 *
 * Mirrors the backend `codec-supervisor/codec_supervisor/safety/base.py`
 * Protocol so the same policy file can drive both sides: the policy
 * descriptor's `classifier.family` is the lookup key into the registry
 * (server-side or browser-side), the registry returns an implementation
 * matching this interface, and the gate runs it.
 *
 * Concrete browser implementations live alongside this file (slices 3-4):
 *   - `prompt-guard-86m`  — tier 1, Transformers.js, ~80 MB, CPU-only
 *   - `llama-guard-3-1b`  — tier 2, codec-web-llm, WebGPU, ~1 GB
 */

/**
 * What input form a classifier expects. Matches the backend Protocol so
 * a policy can declare its requirements once and both sides agree.
 *
 *   - `text`        — the classifier consumes detokenized text. The host
 *                      is responsible for passing through a private detok
 *                      buffer (text NEVER goes back on the Codec wire).
 *   - `embeddings`  — token-embedding sequences from the engine; no detok
 *                      anywhere in the pipeline. (Server-only in v1; no
 *                      browser engine currently exposes hidden states.)
 *   - `logits`      — sampler-time logit tensors; pure token-space.
 *                      Server-only in v1.
 */
export type ClassifierInputForm = 'text' | 'embeddings' | 'logits';

/** Categories a classifier reports. Match the safety-policy schema names. */
export type ClassifierCategory = string;

/**
 * What a classifier returns for one classification call. A score above
 * the policy's per-category threshold means the category fired; the host
 * decides the action (stop / redact / regenerate / flag) by looking up
 * the policy's category map.
 */
export interface ClassificationResult {
  /**
   * Per-category scores in [0, 1]. Categories absent from this map
   * SHOULD be treated as `0` by the host.
   */
  readonly scores: Readonly<Record<ClassifierCategory, number>>;
  /**
   * Optional raw model output (for debug / telemetry). Implementations
   * MAY include the underlying logits, label, or rationale — but hosts
   * MUST NOT depend on the shape, since it varies per implementation.
   */
  readonly raw?: unknown;
  /**
   * True if the host should keep accumulating tokens before scoring
   * again. Implementations of streaming classifiers (delay-k style) use
   * this to signal "I haven't seen enough yet."
   */
  readonly more?: boolean;
}

/**
 * Generic input shape. The actual `payload` type depends on the
 * classifier's `requires` value; runtime-checked at the registry boundary.
 */
export interface ClassificationInput {
  /** The form of `payload`. MUST equal the classifier's `requires` value. */
  readonly form: ClassifierInputForm;
  /**
   * For `form = "text"`: a string (a sliding-window detok buffer or a
   * full prompt for input-side classification).
   * For `form = "embeddings"` / `"logits"`: a numeric array (precise
   * shape is implementation-specific).
   */
  readonly payload: string | ReadonlyArray<number> | ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * The contract any client-side classifier honors. Mirrors the backend
 * Protocol; identical surface so policy descriptors can talk about both
 * without distinguishing host.
 */
export interface SafetyClassifier {
  /** Stable identifier used in policy descriptors and the registry. */
  readonly modelId: string;

  /** What input form the classifier consumes. */
  readonly requires: ClassifierInputForm;

  /**
   * The categories this classifier can score. Policy enforcement
   * intersects this with the policy's `categories[].name` list.
   */
  readonly categories: ReadonlyArray<ClassifierCategory>;

  /**
   * Run the classifier against an input. Implementations are expected to
   * be re-entrant (the same instance may be called concurrently for
   * different streams); if a backend can't support that, it should
   * serialize internally.
   */
  score(input: ClassificationInput): Promise<ClassificationResult>;

  /**
   * Idempotent setup hook — load weights, warm the GPU, etc. Called by
   * the registry the first time the classifier is selected. Hosts MAY
   * call directly to pre-warm.
   */
  load?(opts?: { signal?: AbortSignal }): Promise<void>;

  /** Optional teardown — release GPU memory, close workers. */
  unload?(): Promise<void>;

  /**
   * Capability self-check. Returns `null` if the runtime can host this
   * classifier (browser supports WebGPU when needed, has enough memory,
   * etc.); returns a human-readable reason string when it can't. The
   * registry uses this for tier fallback decisions.
   */
  capability?(): Promise<string | null>;
}
