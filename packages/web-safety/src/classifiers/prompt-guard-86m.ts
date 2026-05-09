/**
 * `PromptGuard86m` — tier-1 default browser safety classifier.
 *
 * Wraps Meta's Prompt Guard 86M (a BERT-tier classifier for prompt
 * injection / jailbreak detection) via Transformers.js. ~80 MB after
 * ONNX quantization; runs on CPU/WASM with no WebGPU requirement, so
 * it works on every device with a modern browser (or in Node ≥18).
 *
 * Loaded lazily on first `score()` call. Idempotent `load()` lets a
 * host pre-warm if it wants the first prompt to feel instant.
 *
 * Why default tier 1: small, no GPU, fast to download, runs anywhere.
 * Tier 2 (Llama Guard 3 1B via codec-web-llm) ships in slice 4 and is
 * opt-in for devices with WebGPU + GB-class memory headroom.
 *
 * Maps the model's labels to web-safety category names. Prompt Guard
 * variants emit one of:
 *   - `BENIGN` / `INJECTION` (Prompt Guard 2, two-class)
 *   - `BENIGN` / `INJECTION` / `JAILBREAK` (Prompt Guard 1, three-class)
 *   - `LABEL_0` / `LABEL_1` (raw HF default; mapped positionally)
 * All non-benign labels collapse onto category `jailbreak` (matching
 * the canonical category-name registry in `spec/safety-policy.schema.json`).
 */
import type {
  ClassificationInput,
  ClassificationResult,
  SafetyClassifier,
} from '../base.js';
import { register, type ClassifierFactory } from '../registry.js';

// ── Pipeline shape (kept loose to avoid a hard dep on @huggingface/transformers types) ──

/**
 * The shape returned by `pipeline('text-classification', ...)` in
 * Transformers.js. The runtime function takes a string (or batch) and
 * returns one prediction per input. We only use single-string mode.
 */
export type TextClassificationOutput = ReadonlyArray<{
  readonly label: string;
  readonly score: number;
}>;

export type TextClassifier = (
  input: string | ReadonlyArray<string>,
  opts?: { topk?: number; top_k?: number },
) => Promise<TextClassificationOutput | ReadonlyArray<TextClassificationOutput>>;

export type PipelineFactory = (
  task: 'text-classification',
  model: string,
  opts?: { device?: string; quantized?: boolean },
) => Promise<TextClassifier>;

// ── Options ──────────────────────────────────────────────────────────────────

export interface PromptGuard86mOptions {
  /**
   * Hugging Face / ONNX model id. Defaults to the Xenova-converted
   * Prompt Guard 86M. Hosts MAY override to a custom mirror or the
   * Prompt-Guard-2 variant.
   */
  readonly modelId?: string;
  /**
   * Optional `device` preference forwarded to the Transformers.js
   * pipeline (`cpu` / `wasm` / `webgpu`). Default: undefined (the
   * library picks based on environment).
   */
  readonly device?: 'cpu' | 'wasm' | 'webgpu';
  /**
   * Pipeline factory override. By default the classifier dynamically
   * imports `@huggingface/transformers` and uses its `pipeline` export.
   * Tests pass a stub factory to avoid network / model loading; hosts
   * can pass a Web Worker proxy for off-thread inference.
   */
  readonly pipelineFactory?: PipelineFactory;
  /**
   * Override the `topk` argument the classifier passes to Transformers.js.
   * Default: 10 — covers all classes a Prompt Guard variant emits.
   */
  readonly topK?: number;
}

const DEFAULT_MODEL_ID = 'Xenova/Prompt-Guard-86M';

// ── Implementation ───────────────────────────────────────────────────────────

export class PromptGuard86m implements SafetyClassifier {
  readonly modelId: string;
  readonly requires = 'text' as const;
  readonly categories: ReadonlyArray<string> = ['jailbreak'];

  private readonly opts: PromptGuard86mOptions;
  private classifier: TextClassifier | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(opts: PromptGuard86mOptions = {}) {
    this.opts = opts;
    this.modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  }

  /** Idempotent load. Hosts MAY call directly to pre-warm. */
  async load(_opts?: { signal?: AbortSignal }): Promise<void> {
    if (this.classifier) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      const factory = this.opts.pipelineFactory ?? (await defaultPipelineFactory());
      const ctorOpts: { device?: string } = {};
      if (this.opts.device) ctorOpts.device = this.opts.device;
      const cls = await factory('text-classification', this.modelId, ctorOpts);
      this.classifier = cls;
    })();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  async unload(): Promise<void> {
    // Transformers.js doesn't expose an explicit unload; dropping the
    // reference is the best we can do. The wasm/onnx backend will GC
    // when no inputs reference the session.
    this.classifier = null;
  }

  async capability(): Promise<string | null> {
    // Prompt Guard 86M is CPU/WASM-friendly — runs in any modern browser
    // (Node 18+ too). The only failure modes we surface here are: missing
    // global fetch (very-old runtimes) and missing WebAssembly support
    // (extremely old / locked-down environments).
    if (typeof fetch !== 'function') {
      return 'no global fetch — upgrade to Node 18+ or a modern browser';
    }
    if (typeof WebAssembly === 'undefined') {
      return 'WebAssembly not available in this runtime';
    }
    return null;
  }

  async score(input: ClassificationInput): Promise<ClassificationResult> {
    if (input.form !== 'text') {
      throw new Error(
        `PromptGuard86m only accepts form="text" inputs; got form="${input.form}"`,
      );
    }
    if (typeof input.payload !== 'string') {
      throw new Error('PromptGuard86m: text input payload must be a string');
    }
    if (!this.classifier) await this.load();
    if (!this.classifier) {
      throw new Error('PromptGuard86m: classifier failed to load');
    }

    const topK = this.opts.topK ?? 10;
    const raw = await this.classifier(input.payload, { topk: topK, top_k: topK });
    // Single-input mode returns a single TextClassificationOutput; batched
    // mode returns an outer array. We always send single inputs.
    const predictions = (
      Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])
        ? (raw[0] as TextClassificationOutput)
        : (raw as TextClassificationOutput)
    );

    // Map model labels → web-safety categories. Anything that isn't
    // explicitly benign is treated as a jailbreak signal; we take the
    // max non-benign score so a 0.4 INJECTION + 0.55 JAILBREAK becomes
    // a 0.55 jailbreak score.
    let jailbreakScore = 0;
    for (const p of predictions) {
      const norm = p.label.toUpperCase();
      if (norm === 'BENIGN' || norm === 'LABEL_0') continue;
      if (norm === 'INJECTION' || norm === 'JAILBREAK' || norm === 'LABEL_1' || norm === 'LABEL_2') {
        if (p.score > jailbreakScore) jailbreakScore = p.score;
      }
    }

    return {
      scores: { jailbreak: jailbreakScore },
      raw: predictions,
    };
  }
}

// ── Default pipeline factory ─────────────────────────────────────────────────
//
// Dynamically imported so users who never construct a PromptGuard86m don't
// pay the @huggingface/transformers download / parse cost. Cached so repeat
// calls don't re-import.

let cachedDefaultFactory: PipelineFactory | null = null;

async function defaultPipelineFactory(): Promise<PipelineFactory> {
  if (cachedDefaultFactory) return cachedDefaultFactory;
  let mod: unknown;
  try {
    mod = await import('@huggingface/transformers');
  } catch (e) {
    throw new Error(
      "@codecai/web-safety: PromptGuard86m needs '@huggingface/transformers'. " +
        'Install it as a peer dep, or pass `pipelineFactory` explicitly. ' +
        `Underlying error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const pipeline = (mod as { pipeline?: unknown }).pipeline;
  if (typeof pipeline !== 'function') {
    throw new Error(
      "@codecai/web-safety: '@huggingface/transformers' did not export a pipeline() function",
    );
  }
  cachedDefaultFactory = pipeline as PipelineFactory;
  return cachedDefaultFactory;
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register Prompt Guard 86M with the global `@codecai/web-safety`
 * classifier registry. Idempotent: a second call is a no-op.
 *
 *   import { registerPromptGuard86m } from '@codecai/web-safety/classifiers/prompt-guard-86m';
 *   registerPromptGuard86m();           // tier-1 default
 *
 * Pass options to override the model id, device, or pipeline factory:
 *
 *   registerPromptGuard86m({ device: 'wasm' });
 */
export function registerPromptGuard86m(opts: PromptGuard86mOptions = {}): void {
  const factory: ClassifierFactory = () => new PromptGuard86m(opts);
  try {
    register({
      modelId: opts.modelId ?? DEFAULT_MODEL_ID,
      factory,
      tier: 1,
      description:
        'Meta Prompt Guard 86M via Transformers.js — tier-1 default; CPU/WASM, ~80 MB',
    });
  } catch (e) {
    // Re-registration is a no-op rather than a hard error (hosts may
    // import the registration module from multiple entry points).
    if (e instanceof Error && /already registered/.test(e.message)) return;
    throw e;
  }
}
