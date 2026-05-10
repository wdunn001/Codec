/**
 * `LlamaGuard31B` — tier-2 opt-in browser safety classifier.
 *
 * Wraps Meta's Llama Guard 3 1B via MLC web-llm. ~1 GB after WebGPU
 * q4 quantization; requires WebGPU + GB-class memory headroom, so it
 * back-stops the always-on tier-1 Prompt Guard 86M (slice 3) on
 * capable devices. Surfaces the full Llama Guard 3 14-category
 * taxonomy (S1–S14) so policy descriptors can route per-category.
 *
 * Generator-DI design — the classifier does NOT hard-import
 * `@mlc-ai/web-llm`. The default factory dynamic-imports it and spins
 * up a fresh engine, but hosts that already operate an engine pool
 * (e.g. leet's leader-elected codec-web-llm tab) pass a generator
 * that reuses the existing engine. This keeps slice 4 a registry
 * capability — leet decides at the PERSONA tab whether to flip it on.
 *
 * Maps Llama Guard 3 categories to web-safety categories 1:1 by
 * canonical lowercase name. Hosts whose policy uses the schema's
 * shorter category set (`hate`, `self_harm`, `sexual_content`, ...)
 * see scores under those names directly; hosts that want the full
 * taxonomy have it.
 */
import type {
  ClassificationInput,
  ClassificationResult,
  SafetyClassifier,
} from '../base.js';
import { register, type ClassifierFactory } from '../registry.js';

// ── Llama Guard 3 taxonomy ───────────────────────────────────────────────────
//
// Each S-code maps to a stable canonical category name. Order matches
// the official Llama Guard 3 model card; the prompt template below
// emits these categories in this exact order so the model sees a
// consistent surface across deployments.

interface LlamaGuardCategory {
  readonly code: string;
  readonly name: string;
  readonly title: string;
}

const LLAMA_GUARD_CATEGORIES: ReadonlyArray<LlamaGuardCategory> = [
  { code: 'S1',  name: 'violent_crimes',         title: 'Violent Crimes' },
  { code: 'S2',  name: 'non_violent_crimes',     title: 'Non-Violent Crimes' },
  { code: 'S3',  name: 'sex_crimes',             title: 'Sex Crimes' },
  { code: 'S4',  name: 'child_exploitation',     title: 'Child Exploitation' },
  { code: 'S5',  name: 'defamation',             title: 'Defamation' },
  { code: 'S6',  name: 'specialized_advice',     title: 'Specialized Advice' },
  { code: 'S7',  name: 'privacy',                title: 'Privacy' },
  { code: 'S8',  name: 'intellectual_property',  title: 'Intellectual Property' },
  { code: 'S9',  name: 'indiscriminate_weapons', title: 'Indiscriminate Weapons' },
  { code: 'S10', name: 'hate',                   title: 'Hate' },
  { code: 'S11', name: 'self_harm',              title: 'Self-Harm' },
  { code: 'S12', name: 'sexual_content',         title: 'Sexual Content' },
  { code: 'S13', name: 'elections',              title: 'Elections' },
  { code: 'S14', name: 'code_interpreter_abuse', title: 'Code Interpreter Abuse' },
];

const CATEGORY_BY_CODE = new Map(
  LLAMA_GUARD_CATEGORIES.map((c) => [c.code, c]),
);

// ── Generator interface ──────────────────────────────────────────────────────

export interface LlamaGuardGenerateOptions {
  readonly signal?: AbortSignal;
  /** Hard cap on output tokens. Default: 64 (Llama Guard reply is short). */
  readonly maxTokens?: number;
  /** Default: 0 — Llama Guard is a classifier, deterministic decoding is right. */
  readonly temperature?: number;
}

/**
 * Generator function the classifier calls to run inference on the
 * built Llama Guard prompt. Returns the model's text completion.
 *
 * The default factory creates a fresh `@mlc-ai/web-llm` engine bound
 * to `modelId`; hosts can pass their own generator to reuse an
 * existing engine pool (recommended in mesh / multi-tab contexts so
 * one tab serves the model and the safety classifier piggybacks).
 */
export type LlamaGuardGenerator = (
  prompt: string,
  opts?: LlamaGuardGenerateOptions,
) => Promise<string>;

export type LlamaGuardGeneratorFactory = (
  modelId: string,
  opts?: { progressCallback?: (report: { text: string; progress: number }) => void },
) => Promise<LlamaGuardGenerator>;

// ── Options ──────────────────────────────────────────────────────────────────

export interface LlamaGuard31BOptions {
  /** MLC model id. Defaults to the Llama-Guard-3-1B q4f16 build. */
  readonly modelId?: string;
  /**
   * Generator factory override. By default the classifier dynamic-
   * imports `@mlc-ai/web-llm` and spins up a fresh engine; hosts that
   * already run an engine pool pass their own factory.
   */
  readonly generatorFactory?: LlamaGuardGeneratorFactory;
  /** Optional progress callback (model load / shard download). */
  readonly progressCallback?: (report: { text: string; progress: number }) => void;
  /**
   * If set, capability() reports OK even without WebGPU. Useful for
   * generator-DI deployments where the host's generator runs
   * elsewhere (Web Worker, server-rendered, etc.).
   */
  readonly skipWebGpuCheck?: boolean;
}

const DEFAULT_MODEL_ID = 'Llama-Guard-3-1B-q4f16_1-MLC';

// ── Implementation ───────────────────────────────────────────────────────────

export class LlamaGuard31B implements SafetyClassifier {
  readonly modelId: string;
  readonly requires = 'text' as const;
  readonly categories: ReadonlyArray<string> = LLAMA_GUARD_CATEGORIES.map((c) => c.name);

  private readonly opts: LlamaGuard31BOptions;
  private generator: LlamaGuardGenerator | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(opts: LlamaGuard31BOptions = {}) {
    this.opts = opts;
    this.modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  }

  async load(_opts?: { signal?: AbortSignal }): Promise<void> {
    if (this.generator) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      const factory = this.opts.generatorFactory ?? defaultGeneratorFactory;
      const factoryOpts: { progressCallback?: (r: { text: string; progress: number }) => void } = {};
      if (this.opts.progressCallback) factoryOpts.progressCallback = this.opts.progressCallback;
      this.generator = await factory(this.modelId, factoryOpts);
    })();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  async unload(): Promise<void> {
    // Drop reference; the underlying engine's GC cleans up.
    this.generator = null;
  }

  async capability(): Promise<string | null> {
    if (typeof fetch !== 'function') {
      return 'no global fetch — upgrade to Node 18+ or a modern browser';
    }
    if (!this.opts.skipWebGpuCheck) {
      const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
      if (!nav || !nav.gpu) {
        return 'no WebGPU — Llama Guard 3 1B q4 needs GPU acceleration';
      }
    }
    return null;
  }

  async score(input: ClassificationInput): Promise<ClassificationResult> {
    if (input.form !== 'text') {
      throw new Error(
        `LlamaGuard31B only accepts form="text" inputs; got form="${input.form}"`,
      );
    }
    if (typeof input.payload !== 'string') {
      throw new Error('LlamaGuard31B: text input payload must be a string');
    }
    if (!this.generator) await this.load();
    if (!this.generator) {
      throw new Error('LlamaGuard31B: generator failed to load');
    }

    const prompt = buildLlamaGuardPrompt(input.payload);
    const out = await this.generator(prompt, { maxTokens: 64, temperature: 0 });
    return parseLlamaGuardOutput(out);
  }
}

// ── Prompt + parser ──────────────────────────────────────────────────────────
//
// Exposed as named exports so tests can exercise them without a generator,
// and so a host that wants to drive Llama Guard out-of-band (e.g. a server
// classifier) can reuse the exact prompt template.

export function buildLlamaGuardPrompt(userMessage: string): string {
  const cats = LLAMA_GUARD_CATEGORIES.map((c) => `${c.code}: ${c.title}.`).join('\n');
  return [
    "<|begin_of_text|><|start_header_id|>user<|end_header_id|>",
    "",
    "Task: Check if there is unsafe content in 'User' messages in conversations according our safety policy with the below categories.",
    "",
    "<BEGIN UNSAFE CONTENT CATEGORIES>",
    cats,
    "<END UNSAFE CONTENT CATEGORIES>",
    "",
    "<BEGIN CONVERSATION>",
    "",
    `User: ${userMessage}`,
    "",
    "<END CONVERSATION>",
    "",
    "Provide your safety assessment for ONLY THE LAST User message in the above conversation:",
    " - First line must read 'safe' or 'unsafe'.",
    " - If unsafe, a second line must include a comma-separated list of violated categories.<|eot_id|><|start_header_id|>assistant<|end_header_id|>",
    "",
  ].join('\n');
}

/**
 * Parse Llama Guard's two-line completion. `safe` returns all category
 * scores at 0; `unsafe\nS5,S10` returns those categories at 1.0 and
 * everything else at 0. The model's output is binary per-category;
 * scoring is the host's threshold call (0.5 separates safe from
 * unsafe in this scheme — any positive flag is unsafe).
 */
export function parseLlamaGuardOutput(text: string): ClassificationResult {
  const trimmed = text.trim();
  const firstLine = trimmed.split('\n')[0]?.trim().toLowerCase() ?? '';

  // Initialize every category at 0.
  const scores: Record<string, number> = {};
  for (const c of LLAMA_GUARD_CATEGORIES) scores[c.name] = 0;

  if (firstLine === 'safe') {
    return { scores, raw: { firstLine, body: trimmed } };
  }

  // unsafe — second line is a comma-separated list of S-codes
  // (sometimes prefixed with whitespace). Be lenient about extras.
  const secondLine = trimmed.split('\n')[1]?.trim() ?? '';
  const codes = secondLine
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^S(?:1[0-4]|[1-9])$/.test(s));

  if (codes.length === 0) {
    // Model said "unsafe" but didn't name a category — record under a
    // generic catch-all so policy can still act (most policies enforce
    // on `unsafe` directly when categories are unparseable).
    return {
      scores: { ...scores, unsafe: 1 },
      raw: { firstLine, body: trimmed, unparseableCategories: secondLine },
    };
  }

  for (const code of codes) {
    const cat = CATEGORY_BY_CODE.get(code);
    if (cat) scores[cat.name] = 1;
  }
  return { scores, raw: { firstLine, body: trimmed, codes } };
}

// ── Default generator factory ────────────────────────────────────────────────
//
// Dynamically imports `@mlc-ai/web-llm` and spins up a fresh engine
// for the requested model id. Hosts that need to share an engine
// across tabs / workers should pass their own factory.

const defaultGeneratorFactory: LlamaGuardGeneratorFactory = async (modelId, opts) => {
  let mod: unknown;
  try {
    mod = await import('@mlc-ai/web-llm');
  } catch (e) {
    throw new Error(
      "@codecai/web-safety: LlamaGuard31B's default factory needs '@mlc-ai/web-llm'. " +
        'Install it as a peer dep, or pass `generatorFactory` to construct() to use ' +
        'an existing engine pool. ' +
        `Underlying error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  type CreateMLCEngine = (
    modelId: string,
    config?: { initProgressCallback?: (r: { text: string; progress: number }) => void },
  ) => Promise<{
    chat: {
      completions: {
        create: (req: {
          messages: Array<{ role: string; content: string }>;
          max_tokens?: number;
          temperature?: number;
          stream?: false;
        }) => Promise<{ choices: Array<{ message: { content: string } }> }>;
      };
    };
  }>;

  const create = (mod as { CreateMLCEngine?: CreateMLCEngine }).CreateMLCEngine;
  if (typeof create !== 'function') {
    throw new Error(
      "@codecai/web-safety: '@mlc-ai/web-llm' did not export CreateMLCEngine",
    );
  }
  const engine = await create(modelId, {
    ...(opts?.progressCallback ? { initProgressCallback: opts.progressCallback } : {}),
  });

  return async (prompt, gOpts) => {
    const reply = await engine.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: gOpts?.maxTokens ?? 64,
      temperature: gOpts?.temperature ?? 0,
      stream: false,
    });
    return reply.choices[0]?.message.content ?? '';
  };
};

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register Llama Guard 3 1B with the global classifier registry as
 * the tier-2 opt-in. Idempotent: a second call is a no-op.
 *
 *   import { registerLlamaGuard31B } from '@codecai/web-safety/classifiers/llama-guard-3-1b';
 *   registerLlamaGuard31B({
 *     // Reuse leet's existing engine pool instead of spinning up a fresh one:
 *     generatorFactory: leetEngineGeneratorFactory,
 *   });
 */
export function registerLlamaGuard31B(opts: LlamaGuard31BOptions = {}): void {
  const factory: ClassifierFactory = () => new LlamaGuard31B(opts);
  try {
    register({
      modelId: opts.modelId ?? DEFAULT_MODEL_ID,
      factory,
      tier: 2,
      description:
        "Meta Llama Guard 3 1B via MLC web-llm — tier-2 opt-in; WebGPU, ~1 GB",
    });
  } catch (e) {
    if (e instanceof Error && /already registered/.test(e.message)) return;
    throw e;
  }
}
