/**
 * convert.ts: HuggingFace tokenizer.json → CodecTokenizerMap.
 *
 * The library half of `@codecai/maps-cli`. Use it programmatically:
 *
 *   import { convertHFTokenizer } from '@codecai/maps-cli/convert';
 *   const map = convertHFTokenizer(hfJson, { id: 'my-org/my-model' });
 *
 * Or via the CLI: `codecai-maps build <model-id>` (see ./cli.ts).
 *
 * Output schema is the v2 `TokenizerMap` from `@codecai/web`: same JSON
 * shape used by `loadMap()` in browsers. Maps generated here can be hosted
 * anywhere (jsDelivr from a public repo, your own CDN, Hugging Face,
 * S3, …) and pinned by sha256 hash.
 */

import type { TokenizerMap, ToolCallingBlock } from '@codecai/web';
import { compilePreTokenizerRegex, metaspaceProgram } from './compile-pretok.js';

// ── HuggingFace tokenizer.json shape ────────────────────────────────────────

interface HFNode {
  type: string;
  pattern?: { Regex?: string; String?: string };
  pretokenizers?: HFNode[];
  decoders?: HFNode[];
  replacement?: string;
}

export interface HFTokenizerJson {
  model: {
    type: string;
    vocab: Record<string, number>;
    merges?: string[] | Array<[string, string]>;
    byte_fallback?: boolean;
  };
  added_tokens: Array<{
    id: number;
    content: string;
    special: boolean;
  }>;
  pre_tokenizer?: HFNode | null;
  decoder?: HFNode | null;
}

export interface ConvertOptions {
  /**
   * Stable, globally unique tokenizer ID. Convention: lowercase
   * `org/model-family` (e.g. `meta-llama/llama-3`).
   */
  id: string;
  /** Schema version. Defaults to `"2"`. */
  version?: string;
  /** ISO timestamp. Defaults to `new Date().toISOString()`. */
  publishedAt?: string;
  /**
   * Optional `tokenizer_config.json` content. When supplied, the
   * converter inspects `chat_template` and emits a `tool_calling`
   * block on the resulting map per the registry of known calling
   * conventions. Pass undefined to skip: the resulting map simply
   * omits the block. Readers treat that per the spec's prose table.
   */
  tokenizerConfig?: HFTokenizerConfig;
  /**
   * Override the auto-detected calling convention. Useful when a
   * model uses a known convention but with a non-standard chat
   * template, or to opt into a convention the detector doesn't
   * recognize yet. `"custom"` is reserved for callers that pin the
   * layout in implementer-supplied prose; using it currently produces
   * no `tool_calling` block: wire your own block in via post-
   * processing after `convertHFTokenizer` returns.
   */
  convention?: ToolCallingBlock['convention'];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findInTree(node: HFNode | null | undefined, type: string): HFNode | null {
  if (!node) return null;
  if (node.type === type) return node;
  const children = node.pretokenizers ?? node.decoders;
  if (children) {
    for (const child of children) {
      const found = findInTree(child, type);
      if (found) return found;
    }
  }
  return null;
}

function detectEncoder(hf: HFTokenizerJson): 'byte_level' | 'metaspace' | undefined {
  if (findInTree(hf.decoder, 'ByteLevel') || findInTree(hf.pre_tokenizer, 'ByteLevel')) {
    return 'byte_level';
  }
  if (findInTree(hf.decoder, 'Metaspace') || findInTree(hf.pre_tokenizer, 'Metaspace')) {
    return 'metaspace';
  }
  if (hf.model.byte_fallback) return 'metaspace';
  return undefined;
}

function extractPreTokenizerPattern(hf: HFTokenizerJson): string | undefined {
  const split = findInTree(hf.pre_tokenizer, 'Split');
  return split?.pattern?.Regex;
}

function normalizeMerges(hf: HFTokenizerJson): string[] | undefined {
  const m = hf.model.merges;
  if (!m || m.length === 0) return undefined;
  if (Array.isArray(m[0])) {
    return (m as Array<[string, string]>).map((pair) => `${pair[0]} ${pair[1]}`);
  }
  return m as string[];
}

const BYTE_FALLBACK_RE = /^<0x([0-9A-Fa-f]{2})>$/;

// ── Tool-calling convention derivation ──────────────────────────────────────
//
// Per spec/PROTOCOL.md § Tool-call calling conventions in the map, the
// per-model calling convention (markers, args/result format) lives in the
// tokenizer map's optional `tool_calling` block. We derive it from the
// model's `chat_template` Jinja string (shipped in `tokenizer_config.json`
// next to `tokenizer.json` on HuggingFace).
//
// The detector is intentionally substring-based and conservative: it
// looks for the unique start marker of each known convention and returns
// the FIRST match. If multiple markers somehow appear in a template
// (shouldn't happen in practice: a template encodes one convention)
// the first entry in CONVENTIONS wins.
//
// Both marker names MUST resolve to entries in the map's `special_tokens`
// before the block is emitted; if either is absent the detector returns
// undefined and the caller falls back to omitting the block. The map
// reader then treats absence per the spec ("convention not declared;
// behave per the prose table").

interface ChatTemplateBearing {
  /** Top-level chat_template string. Some configs use a list of
   *  {name, template} objects instead: we accept both shapes. */
  readonly chat_template?:
    | string
    | ReadonlyArray<{ readonly name: string; readonly template: string }>;
}

/**
 * The shape of `tokenizer_config.json` we care about. Other fields
 * (model_max_length, bos_token, etc.) are ignored: only chat_template
 * carries the calling-convention signature.
 */
export type HFTokenizerConfig = ChatTemplateBearing;

interface ConventionEntry {
  readonly convention: ToolCallingBlock['convention'];
  /** The unique substring of the model's chat_template that disambiguates
   *  this convention from every other. Order in the CONVENTIONS array
   *  matters for tie-breaking. */
  readonly templateSignature: string;
  readonly markers: { readonly start: string; readonly end: string };
  readonly args_format: ToolCallingBlock['args_format'];
  readonly result_format: ToolCallingBlock['result_format'];
}

// Auto-detection registry: only conventions whose markers come as a
// paired (start, end) special-token pair AND whose chat templates carry
// a unique unambiguous signature. Auto-detection is conservative on
// purpose; if a convention's template doesn't fit the paired-marker
// model cleanly, it stays out of auto-detection and operators opt in
// via the CLI `--convention=<name>` override.
//
// Known opt-in-only cases (rationale, in case re-derivation looks
// possible later):
//   - mistral_nemo: opens with `[TOOL_CALLS][` but the closing `]` is
//     the JSON array's closing bracket. It is not a paired marker token. The
//     paired-markers schema can't represent this without inventing a
//     sentinel.
//   - phi4: the public phi-4 chat template is short enough that it
//     doesn't carry an explicit tool-call marker pair; phi-4-with-
//     tools deployments use a longer template variant.
const CONVENTIONS: readonly ConventionEntry[] = [
  // Llama 3.1+: `<|python_tag|>get_weather(location="NYC")<|eom_id|>`.
  // args_format is python_args because the convention emits a
  // Python-style call expression after the tag.
  {
    convention: 'llama3',
    templateSignature: '<|python_tag|>',
    markers: { start: '<|python_tag|>', end: '<|eom_id|>' },
    args_format: 'python_args',
    result_format: 'json',
  },
  // Qwen 2.5+: `<tool_call>{"name":"x","arguments":{}}</tool_call>`.
  {
    convention: 'qwen25',
    templateSignature: '<tool_call>',
    markers: { start: '<tool_call>', end: '</tool_call>' },
    args_format: 'json',
    result_format: 'json',
  },
  // DeepSeek-V3: full-width unicode markers from the V3 chat template.
  {
    convention: 'deepseek_v3',
    templateSignature: '<｜tool▁calls▁begin｜>',
    markers: {
      start: '<｜tool▁calls▁begin｜>',
      end: '<｜tool▁calls▁end｜>',
    },
    args_format: 'json',
    result_format: 'json',
  },
];

/** Pull the chat_template string out of a tokenizer_config.json,
 *  handling both the legacy "single string" form and the newer
 *  "list of named templates" form. Returns the concatenation when
 *  multiple templates are present (sufficient for substring detection). */
function extractChatTemplate(cfg: HFTokenizerConfig | undefined): string | undefined {
  const t = cfg?.chat_template;
  if (!t) return undefined;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map((e) => e.template).join('\n');
  return undefined;
}

/**
 * Inspect a tokenizer_config + the map's vocab/special_tokens. If the
 * chat_template carries a known convention's signature AND both
 * markers resolve to IDs (in special_tokens or in the broader vocab),
 * return the matching ToolCallingBlock and also PROMOTE the markers
 * into the supplied `specialTokens` object (in-place) so the spec
 * contract holds: the spec requires markers to appear as keys in
 * special_tokens because that's what ToolWatcher reads.
 *
 * The promotion is necessary because some model families (e.g.
 * Qwen2.5) ship their tool-call markers as `added_tokens` with
 * `special: false`. They're real tokens with stable IDs, just not
 * flagged as "skip during rendering": but they ARE control tokens
 * for the tool-calling protocol. The chat template is the
 * authoritative signal that they're being used as such; once we've
 * matched a known convention by template signature, we know the
 * markers are control tokens and lift them into special_tokens.
 *
 * Returns undefined (and does NOT mutate specialTokens) if either
 * marker can't be resolved. Better to omit the block than emit one
 * with marker names a downstream tool can't look up.
 */
export function deriveToolCalling(
  cfg: HFTokenizerConfig | undefined,
  vocab: Record<string, number>,
  specialTokens: Record<string, number>,
  override?: ToolCallingBlock['convention'],
): ToolCallingBlock | undefined {
  const resolveMarker = (name: string): number | undefined => {
    if (name in specialTokens) return specialTokens[name];
    if (name in vocab) return vocab[name];
    return undefined;
  };

  const tryEntry = (entry: ConventionEntry): ToolCallingBlock | undefined => {
    const startId = resolveMarker(entry.markers.start);
    const endId = resolveMarker(entry.markers.end);
    if (startId === undefined || endId === undefined) return undefined;
    // Promote into special_tokens if absent: keeps the spec contract
    // ("markers MUST appear as keys in special_tokens") satisfied.
    if (!(entry.markers.start in specialTokens)) {
      specialTokens[entry.markers.start] = startId;
    }
    if (!(entry.markers.end in specialTokens)) {
      specialTokens[entry.markers.end] = endId;
    }
    return {
      convention: entry.convention,
      markers: entry.markers,
      args_format: entry.args_format,
      result_format: entry.result_format,
    };
  };

  // Explicit override path (CLI flag --convention=<name>).
  if (override && override !== 'custom') {
    const entry = CONVENTIONS.find((c) => c.convention === override);
    if (!entry) return undefined;
    return tryEntry(entry);
  }

  // Auto-detect from chat_template signature.
  const template = extractChatTemplate(cfg);
  if (!template) return undefined;

  for (const entry of CONVENTIONS) {
    if (!template.includes(entry.templateSignature)) continue;
    const block = tryEntry(entry);
    if (block) return block;
  }

  return undefined;
}

// ── Core conversion ──────────────────────────────────────────────────────────

/**
 * Convert a HuggingFace `tokenizer.json` (parsed JSON object) into a Codec
 * `TokenizerMap`. Pure function: no I/O.
 *
 * Throws `Error` if the input doesn't look like a HuggingFace tokenizer.json.
 */
export function convertHFTokenizer(
  hf: HFTokenizerJson,
  opts: ConvertOptions,
): TokenizerMap {
  if (!hf?.model?.vocab) {
    throw new Error(
      'convertHFTokenizer: input is missing `model.vocab`. ' +
        'Expected a HuggingFace tokenizer.json object.',
    );
  }

  const encoder = detectEncoder(hf);
  const merges = normalizeMerges(hf);
  const pre_tokenizer_pattern =
    encoder === 'byte_level' ? extractPreTokenizerPattern(hf) : undefined;

  const vocab: Record<string, number> = { ...hf.model.vocab };
  const special_tokens: Record<string, number> = {};
  for (const t of hf.added_tokens ?? []) {
    vocab[t.content] = t.id;
    if (t.special) special_tokens[t.content] = t.id;
  }

  let byte_fallback_start: number | undefined;
  let byte_fallback_end: number | undefined;
  if (encoder === 'metaspace' || hf.model.byte_fallback) {
    const byteIds = new Map<number, number>();
    for (const [token, id] of Object.entries(vocab)) {
      const m = token.match(BYTE_FALLBACK_RE);
      if (m) byteIds.set(parseInt(m[1]!, 16), id);
    }
    if (byteIds.size === 256) {
      byte_fallback_start = byteIds.get(0)!;
      byte_fallback_end = byteIds.get(255)!;
    }
  }

  const result: TokenizerMap = {
    id: opts.id,
    version: opts.version ?? '2',
    vocab_size: Object.keys(vocab).length,
    vocab,
    published_at: opts.publishedAt ?? new Date().toISOString(),
  };

  // Build with `as` casts since TokenizerMap fields are readonly.
  if (encoder) (result as { encoder?: string }).encoder = encoder;
  if (merges) (result as { merges?: string[] }).merges = merges;
  if (pre_tokenizer_pattern)
    (result as { pre_tokenizer_pattern?: string }).pre_tokenizer_pattern =
      pre_tokenizer_pattern;

  // Compile the regex into a v2.1 pre_tokenizer_program when the regex
  // is one we recognise. Old clients ignore the field; new clients
  // (and the C runtime once it lands) skip the regex engine entirely.
  // For metaspace encoders, emit the metaspace_split shortcut directly.
  if (encoder === 'byte_level' && pre_tokenizer_pattern) {
    const prog = compilePreTokenizerRegex(pre_tokenizer_pattern);
    if (prog) {
      (result as { pre_tokenizer_program?: typeof prog }).pre_tokenizer_program = prog;
    }
  } else if (encoder === 'metaspace') {
    const prog = metaspaceProgram();
    (result as { pre_tokenizer_program?: typeof prog }).pre_tokenizer_program = prog;
  }
  if (byte_fallback_start !== undefined) {
    (result as { byte_fallback_start?: number }).byte_fallback_start = byte_fallback_start;
    (result as { byte_fallback_end?: number }).byte_fallback_end = byte_fallback_end;
  }
  if (Object.keys(special_tokens).length > 0) {
    (result as { special_tokens?: Record<string, number> }).special_tokens = special_tokens;
  }

  // Optional tool-calling convention block. The deriver looks up
  // markers in vocab + special_tokens. It promotes vocab-only markers
  // into special_tokens (in-place) when a convention matches: the
  // spec contract "markers MUST be keys in special_tokens" stays
  // satisfied. A partial match still returns undefined and the block
  // is omitted; the spec lets readers handle absence per the prose
  // table.
  const toolCalling = deriveToolCalling(
    opts.tokenizerConfig,
    vocab,
    special_tokens,
    opts.convention,
  );
  if (toolCalling) {
    // Re-assign special_tokens onto the result in case deriveToolCalling
    // promoted markers and Object.keys went from 0 to non-zero.
    (result as { special_tokens?: Record<string, number> }).special_tokens = special_tokens;
    (result as { tool_calling?: ToolCallingBlock }).tool_calling = toolCalling;
  }

  return result;
}

// ── Convenience: fetch from HuggingFace and convert ──────────────────────────

export interface FetchAndConvertOptions extends ConvertOptions {
  /** HuggingFace model ID, e.g. `Qwen/Qwen2.5-7B-Instruct`. */
  hfModel: string;
  /** HuggingFace API token, for gated models. */
  hfToken?: string;
  /** Override the URL (e.g. for a mirror). */
  url?: string;
}

/**
 * Fetch a tokenizer.json from HuggingFace and convert it. Also fetches
 * `tokenizer_config.json` (best-effort) so the converter can derive a
 * `tool_calling` block from the model's chat template; a missing config
 * is not an error, the block is simply omitted in that case.
 *
 * Useful for one-off generation; for bulk conversion across many models,
 * fetch both JSON files yourself and call `convertHFTokenizer` directly
 * with `tokenizerConfig` supplied.
 */
export async function fetchAndConvert(
  opts: FetchAndConvertOptions,
): Promise<TokenizerMap> {
  const tokenizerUrl =
    opts.url ?? `https://huggingface.co/${opts.hfModel}/resolve/main/tokenizer.json`;
  const headers: Record<string, string> = {
    'User-Agent': '@codecai/maps-cli',
  };
  if (opts.hfToken) headers.Authorization = `Bearer ${opts.hfToken}`;

  const resp = await fetch(tokenizerUrl, { headers });
  if (!resp.ok) {
    throw new Error(
      `fetchAndConvert: HTTP ${resp.status} for ${tokenizerUrl}` +
        (resp.status === 401 ? ' (gated model: pass hfToken)' : ''),
    );
  }
  const hf = (await resp.json()) as HFTokenizerJson;

  // Best-effort fetch of tokenizer_config.json. The chat_template lives
  // there (not in tokenizer.json). We need it to derive the
  // tool_calling block. A 404 here means "no chat template published":
  // we proceed without and the map simply omits the block. Network
  // errors propagate normally.
  let tokenizerConfig: HFTokenizerConfig | undefined;
  if (!opts.tokenizerConfig) {
    const cfgUrl = tokenizerUrl.replace(/tokenizer\.json$/, 'tokenizer_config.json');
    try {
      const cfgResp = await fetch(cfgUrl, { headers });
      if (cfgResp.ok) {
        tokenizerConfig = (await cfgResp.json()) as HFTokenizerConfig;
      }
    } catch {
      // Network error: leave undefined and continue. The CLI surfaces
      // this gap via "tool_calling: omitted" in its output banner so
      // operators know to investigate if they expected a block.
    }
  }

  return convertHFTokenizer(hf, {
    ...opts,
    tokenizerConfig: opts.tokenizerConfig ?? tokenizerConfig,
  });
}

// ── sha256 helper ────────────────────────────────────────────────────────────

/**
 * Compute the canonical sha256 hash of a TokenizerMap. Use this when
 * publishing a map so consumers can pin against it via
 * `loadMap({ url, hash })`.
 */
export async function hashMap(map: TokenizerMap): Promise<string> {
  const json = JSON.stringify(map, null, 2);
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}
