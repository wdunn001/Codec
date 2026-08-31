#!/usr/bin/env node
/**
 * codecai-maps: CLI for generating Codec tokenizer dialect maps.
 *
 * Usage:
 *
 *   codecai-maps build <hf-model> [--id=<map-id>] [--out=<path>] [--token=<hf-token>]
 *     Fetch a HuggingFace tokenizer.json, convert to a TokenizerMap, write
 *     to <path> (default: <map-id>.json), print sha256 hash to stdout.
 *
 *   codecai-maps convert <tokenizer.json> [--id=<map-id>] [--out=<path>]
 *     Same as build, but reads tokenizer.json from a local file.
 *
 *   codecai-maps validate <map.json>
 *     Validate a map file against the v2 schema. Exit 0 if valid.
 *
 *   codecai-maps hash <map.json>
 *     Print the canonical sha256 hash of a map file.
 *
 *   codecai-maps preview <map.json> [--text="<sample>"]
 *     Tokenize a sample string and detokenize back, showing IDs and
 *     round-trip text. Useful for sanity-checking a generated map.
 *
 *   codecai-maps translate --from=<map.json> --to=<map.json> [--text="..."|--ids=N,M,...]
 *     Cross-vocab agent handoff. Decode tokens via the source map's
 *     detokenizer, re-encode via the target map's tokenizer. Either feed a
 *     text sample (we'll first tokenize it through the source) or hand
 *     over a comma-separated list of source IDs directly. Prints the
 *     resulting target-vocab IDs and the round-trip text.
 *
 *   codecai-maps translation-table --from=<map.json> --to=<map.json> [--out=<path>]
 *     Build a static V_A → V_B[] table by feeding each source-vocab token
 *     through the target tokenizer. Useful for analysis (vocab overlap,
 *     cost estimation). Output is a JSON object: { "<src_id>": [tgt_ids], ... }.
 *     Note: context-free; prefer the streaming `translate` for runtime use.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { argv, exit, stdout, stderr } from 'node:process';
import {
  validateMap,
  BPETokenizer,
  Detokenizer,
  pickTokenizer,
  Translator,
  staticTranslationTable,
  WELL_KNOWN_BASE,
  validateSafetyPolicy,
  hashSafetyPolicy,
  POLICY_WELL_KNOWN_BASE,
  type MapPointer,
  type MapIndex,
  type SafetyPolicyDescriptor,
  type SafetyPolicyPointer,
} from '@codecai/web';
import {
  convertHFTokenizer,
  fetchAndConvert,
  hashMap,
  type HFTokenizerJson,
  type HFTokenizerConfig,
} from './convert.js';
import type { TokenizerMap, ToolCallingBlock } from '@codecai/web';

/** Closed-enum guard for the --convention CLI flag. Returns the
 *  validated value or exits with a clear error if unknown. The
 *  registry here MUST stay in sync with CONVENTIONS in convert.ts;
 *  adding a new convention is a coordinated change. */
function validateConventionFlag(
  raw: string | undefined,
): ToolCallingBlock['convention'] | undefined {
  if (!raw) return undefined;
  const known: ReadonlyArray<ToolCallingBlock['convention']> = [
    'llama3',
    'qwen25',
    'phi4',
    'mistral_nemo',
    'deepseek_v3',
    'deepseek_r1',
    'custom',
  ];
  if (!known.includes(raw as ToolCallingBlock['convention'])) {
    fail(
      `--convention=${raw}: unknown. Known values: ${known.join(', ')}.\n` +
        `Use --convention=custom and post-process the map if you need a layout outside the registry.`,
    );
  }
  return raw as ToolCallingBlock['convention'];
}

interface Flags {
  id?: string;
  out?: string;
  token?: string;
  text?: string;
  from?: string;
  to?: string;
  ids?: string;
  map?: string;
  url?: string;
  inline?: string;
  'out-dir'?: string;
  /** --convention=<name>: override the auto-detected tool-calling convention. */
  convention?: string;
  /** --tokenizer-config=<path>: explicit tokenizer_config.json (for `convert`). */
  'tokenizer-config'?: string;
  /** --literals=<path>: JSON array of strings to enumerate (`policies-enumerate`). */
  literals?: string;
  /** --descriptor=<path>: published safety-policy descriptor (sanitized). */
  descriptor?: string;
  /** --internal=<path>: operator's internal full-detail policy config (input to sanitize). */
  internal?: string;
}

function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)) as keyof Flags;
      const val = eq === -1 ? 'true' : arg.slice(eq + 1);
      flags[key] = val;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function inferMapId(hfModel: string): string {
  // meta-llama/Meta-Llama-3.1-8B → meta-llama/llama-3 (best-effort guess);
  // user can override with --id.
  const slug = hfModel.toLowerCase();
  return slug;
}

function fail(msg: string): never {
  stderr.write(`codecai-maps: ${msg}\n`);
  exit(1);
  throw new Error(msg); // unreachable; satisfies TS `never`
}

async function cmdBuild(args: string[], flags: Flags): Promise<void> {
  const hfModel = args[0];
  if (!hfModel) fail('build requires a HuggingFace model ID, e.g. Qwen/Qwen2.5-7B-Instruct');
  const id = flags.id ?? inferMapId(hfModel!);
  const out = flags.out ?? `${id.replace(/\//g, '_')}.json`;

  stdout.write(`▶ fetching ${hfModel} from HuggingFace…\n`);
  const convention = validateConventionFlag(flags.convention);
  const map = await fetchAndConvert({
    hfModel: hfModel!,
    id,
    hfToken: flags.token,
    convention,
  });
  const json = JSON.stringify(map, null, 2);
  await writeFile(out, json + '\n', 'utf-8');
  const hash = await hashMap(map);

  stdout.write(`✓ written  ${out}\n`);
  stdout.write(`  id           ${map.id}\n`);
  stdout.write(`  vocab_size   ${map.vocab_size}\n`);
  stdout.write(`  encoder      ${map.encoder ?? 'identity'}\n`);
  stdout.write(`  merges       ${map.merges?.length ?? 0}\n`);
  if (map.byte_fallback_start !== undefined) {
    stdout.write(`  byte_fallback ${map.byte_fallback_start}:${map.byte_fallback_end}\n`);
  }
  stdout.write(
    `  tool_calling ${map.tool_calling ? map.tool_calling.convention : 'omitted (no chat_template signature matched)'}\n`,
  );
  stdout.write(`  hash         ${hash}\n`);
}

async function cmdConvert(args: string[], flags: Flags): Promise<void> {
  const inPath = args[0];
  if (!inPath) fail('convert requires a path to a tokenizer.json file');
  const id = flags.id;
  if (!id) fail('convert requires --id=<map-id> (e.g. my-org/my-model)');
  const out = flags.out ?? `${id.replace(/\//g, '_')}.json`;

  const hf = JSON.parse(await readFile(inPath!, 'utf-8')) as HFTokenizerJson;

  // Optional tokenizer_config.json: explicit path wins, else look
  // for a sibling `tokenizer_config.json` next to the input file
  // (HuggingFace ships them together; this is the natural local layout).
  let tokenizerConfig: HFTokenizerConfig | undefined;
  const explicitConfig = flags['tokenizer-config'];
  if (explicitConfig) {
    tokenizerConfig = JSON.parse(await readFile(explicitConfig, 'utf-8')) as HFTokenizerConfig;
  } else {
    const sibling = inPath!.replace(/tokenizer\.json$/, 'tokenizer_config.json');
    if (sibling !== inPath) {
      try {
        tokenizerConfig = JSON.parse(await readFile(sibling, 'utf-8')) as HFTokenizerConfig;
      } catch {
        // No sibling: the map will simply omit tool_calling.
      }
    }
  }

  const convention = validateConventionFlag(flags.convention);
  const map = convertHFTokenizer(hf, { id, tokenizerConfig, convention });
  const json = JSON.stringify(map, null, 2);
  await writeFile(out, json + '\n', 'utf-8');
  const hash = await hashMap(map);

  stdout.write(`✓ written  ${out}\n`);
  stdout.write(
    `  tool_calling ${map.tool_calling ? map.tool_calling.convention : 'omitted'}\n`,
  );
  stdout.write(`  hash       ${hash}\n`);
}

async function cmdValidate(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) fail('validate requires a path to a map JSON file');
  const map: unknown = JSON.parse(await readFile(path!, 'utf-8'));
  validateMap(map);
  stdout.write(`✓ valid: ${(map as TokenizerMap).id} (vocab_size=${(map as TokenizerMap).vocab_size})\n`);
}

async function cmdHash(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) fail('hash requires a path to a map JSON file');
  const map = JSON.parse(await readFile(path!, 'utf-8')) as TokenizerMap;
  validateMap(map);
  stdout.write(await hashMap(map) + '\n');
}

async function cmdPreview(args: string[], flags: Flags): Promise<void> {
  const path = args[0];
  if (!path) fail('preview requires a path to a map JSON file');
  const map = JSON.parse(await readFile(path!, 'utf-8')) as TokenizerMap;
  validateMap(map);
  const text = flags.text ?? 'Hello, world! This is a Codec tokenizer dialect map.';
  const tok = pickTokenizer(map);
  const detok = new Detokenizer(map);
  const ids = tok.encode(text);
  const roundTripped = detok.render(ids);

  stdout.write(`map:           ${map.id}\n`);
  stdout.write(`tokenizer:     ${tok instanceof BPETokenizer ? 'BPETokenizer' : 'LongestMatchTokenizer'}\n`);
  stdout.write(`input:         ${JSON.stringify(text)}\n`);
  stdout.write(`token IDs:     [${ids.join(', ')}]\n`);
  stdout.write(`token count:   ${ids.length}\n`);
  stdout.write(`round-trip:    ${JSON.stringify(roundTripped)}\n`);
  stdout.write(`exact match:   ${roundTripped === text ? 'YES' : 'NO ✗'}\n`);
}

async function cmdTranslate(_args: string[], flags: Flags): Promise<void> {
  if (!flags.from) fail('translate requires --from=<map.json>');
  if (!flags.to)   fail('translate requires --to=<map.json>');
  const fromMap = JSON.parse(await readFile(flags.from!, 'utf-8')) as TokenizerMap;
  const toMap   = JSON.parse(await readFile(flags.to!,   'utf-8')) as TokenizerMap;
  validateMap(fromMap);
  validateMap(toMap);

  // Source IDs come from one of:
  //   --ids=12,34,56     literal source-vocab IDs
  //   --text="..."       text we tokenize through the source map first
  let srcIds: number[];
  let inputText: string;
  if (flags.ids) {
    srcIds = flags.ids.split(',').map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n));
    inputText = new Detokenizer(fromMap).render(srcIds);
  } else {
    inputText = flags.text ?? 'Hello, world!';
    srcIds = pickTokenizer(fromMap).encode(inputText);
  }

  const tr = new Translator(fromMap, toMap);
  const tgtIds = tr.translate(srcIds);
  const roundTripped = new Detokenizer(toMap).render(tgtIds);

  stdout.write(`from:           ${fromMap.id} (${srcIds.length} tokens)\n`);
  stdout.write(`to:             ${toMap.id} (${tgtIds.length} tokens)\n`);
  stdout.write(`input:          ${JSON.stringify(inputText)}\n`);
  stdout.write(`source IDs:     [${srcIds.join(', ')}]\n`);
  stdout.write(`target IDs:     [${tgtIds.join(', ')}]\n`);
  stdout.write(`round-trip:     ${JSON.stringify(roundTripped)}\n`);
  stdout.write(`exact match:    ${roundTripped === inputText ? 'YES' : 'NO ✗'}\n`);
  stdout.write(`token ratio:    ${(tgtIds.length / Math.max(srcIds.length, 1)).toFixed(2)}× (target/source)\n`);
}

async function cmdTranslationTable(_args: string[], flags: Flags): Promise<void> {
  if (!flags.from) fail('translation-table requires --from=<map.json>');
  if (!flags.to)   fail('translation-table requires --to=<map.json>');
  const out = flags.out ?? `translation-table.json`;
  const fromMap = JSON.parse(await readFile(flags.from!, 'utf-8')) as TokenizerMap;
  const toMap   = JSON.parse(await readFile(flags.to!,   'utf-8')) as TokenizerMap;
  validateMap(fromMap);
  validateMap(toMap);

  stdout.write(`▶ building static translation table ${fromMap.id} → ${toMap.id}…\n`);
  const t0 = Date.now();
  const table = staticTranslationTable(fromMap, toMap);
  const t1 = Date.now();

  // Write as { "<src>": [tgt_ids], ... }
  const obj: Record<string, number[]> = {};
  let oneToOne = 0, oneToMany = 0, total = 0;
  for (const [src, tgts] of table) {
    obj[String(src)] = tgts;
    total++;
    if (tgts.length === 1) oneToOne++; else if (tgts.length > 1) oneToMany++;
  }
  await writeFile(out, JSON.stringify(obj) + '\n', 'utf-8');

  stdout.write(`✓ written ${out}\n`);
  stdout.write(`  source vocab:     ${fromMap.vocab_size} tokens\n`);
  stdout.write(`  table coverage:   ${total} entries (${((total / fromMap.vocab_size) * 100).toFixed(1)}%)\n`);
  stdout.write(`  1-to-1 mappings:  ${oneToOne} (${((oneToOne / total) * 100).toFixed(1)}%)\n`);
  stdout.write(`  1-to-many:        ${oneToMany} (${((oneToMany / total) * 100).toFixed(1)}%)\n`);
  stdout.write(`  build time:       ${((t1 - t0) / 1000).toFixed(1)}s\n`);
}

/**
 * Validate the same id constraints as the discover.ts loader, so the CLI fails
 * fast rather than emitting a tree the runtime would later reject.
 */
function validateMapIdForWellKnown(id: string): void {
  if (!/^[a-z0-9._/-]+$/.test(id)) {
    fail(`map id ${JSON.stringify(id)} must match [a-z0-9._/-]+ for well-known publishing`);
  }
  if (id.includes('..') || id.startsWith('/') || id.endsWith('/')) {
    fail(`map id ${JSON.stringify(id)} contains a path traversal or empty segment`);
  }
}

async function cmdWellKnown(_args: string[], flags: Flags): Promise<void> {
  if (!flags.map) fail('well-known requires --map=<path-to-map.json>');
  const outDir = flags['out-dir'] ?? '.';

  const mapJson = await readFile(flags.map!, 'utf-8');
  const map = JSON.parse(mapJson) as TokenizerMap;
  validateMap(map);
  validateMapIdForWellKnown(map.id);

  const inline = flags.inline === 'true';
  if (!inline && !flags.url) {
    fail('well-known requires either --url=<hosted-map-url> (Form A pointer) or --inline (Form B)');
  }
  if (inline && flags.url) {
    fail('well-known: --inline and --url are mutually exclusive');
  }

  const hash = await hashMap(map);
  const targetPath = path.join(
    outDir,
    WELL_KNOWN_BASE,
    'maps',
    ...map.id.split('/'),
  ) + '.json';
  await mkdir(path.dirname(targetPath), { recursive: true });

  let docBytes: string;
  let pointer: MapPointer | null = null;
  if (inline) {
    // Form B: write the full map at the well-known location verbatim.
    docBytes = JSON.stringify(map, null, 2) + '\n';
  } else {
    // Form A: write a small pointer document.
    pointer = {
      id: map.id,
      url: flags.url!,
      hash,
      published_at: map.published_at ?? new Date().toISOString(),
    };
    docBytes = JSON.stringify(pointer, null, 2) + '\n';
  }
  await writeFile(targetPath, docBytes, 'utf-8');

  // Maintain index.json. Replace the entry for this id if it exists; otherwise
  // append. Inline-only publishes skip the index by default: the index is a
  // pointer directory.
  const indexPath = path.join(outDir, WELL_KNOWN_BASE, 'index.json');
  if (pointer) {
    let index: MapIndex = { codec_version: '0.2', maps: [] };
    if (existsSync(indexPath)) {
      const raw = await readFile(indexPath, 'utf-8');
      try {
        index = JSON.parse(raw) as MapIndex;
      } catch {
        fail(`existing index at ${indexPath} is not valid JSON`);
      }
    }
    const entries = [...(index.maps ?? [])].filter((e) => e.id !== pointer!.id);
    entries.push(pointer);
    entries.sort((a, b) => a.id.localeCompare(b.id));
    const updated: MapIndex = { codec_version: '0.2', maps: entries };
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(indexPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  }

  stdout.write(`✓ wrote   ${targetPath}\n`);
  if (pointer) {
    stdout.write(`✓ index   ${indexPath} (${pointer.id})\n`);
    stdout.write(`  url           ${pointer.url}\n`);
    stdout.write(`  hash          ${pointer.hash}\n`);
  } else {
    stdout.write(`  inline map (${(docBytes.length / 1024).toFixed(1)} KB)\n`);
    stdout.write(`  hash          ${hash}\n`);
  }
}

// ── Safety policy subcommands ────────────────────────────────────────────────
//
// Mirror the tokenizer-map subcommand surface: validate / hash / well-known,
// plus a `policies-sanitize` step unique to safety policies that strips
// operator-internal fields (banned token IDs, classifier thresholds, regex
// contents) and emits the publishable sanitized descriptor.
//
// The internal config the operator authors is a superset of the descriptor:
// it carries the descriptor's fields plus full-detail rules. v1 sanitize
// recognizes these internal-only keys and uses them to compute summary
// statistics, then drops them from the output.

const INTERNAL_ONLY_FIELDS = [
  'banned_token_ids',
  'regex_patterns',
  'grammar_constraints',
  'multi_token_patterns',
  'classifier_internal',
] as const;

interface InternalPolicyConfig {
  // Descriptor fields (passed through verbatim).
  id: string;
  version: string;
  tokenizers: string[];
  categories: Array<{ name: string; action: string; description?: string }>;
  category_registry?: string;
  classifier: {
    family: string;
    host?: string;
    requires_engine_features?: string[];
    // INTERNAL: sanitized away.
    thresholds?: Record<string, number>;
    weights_url?: string;
  };
  client_hooks?: {
    prefilter_categories?: string[];
    client_classifier_family?: string;
  };
  published_at?: string;
  publisher?: { name?: string; url?: string; contact?: string };
  // INTERNAL-ONLY: sanitized away after counting.
  banned_token_ids?: number[];
  regex_patterns?: string[];
  grammar_constraints?: unknown[];
  multi_token_patterns?: unknown[];
  classifier_internal?: Record<string, unknown>;
}

function sanitizeInternalConfig(
  internal: InternalPolicyConfig,
): SafetyPolicyDescriptor {
  // Compute summary stats from internal-only fields if present.
  const summary: Record<string, number> = {};
  if (Array.isArray(internal.banned_token_ids)) {
    summary.banned_token_id_count = internal.banned_token_ids.length;
  }
  if (Array.isArray(internal.regex_patterns)) {
    summary.regex_pattern_count = internal.regex_patterns.length;
  }
  if (Array.isArray(internal.grammar_constraints)) {
    summary.grammar_constraint_count = internal.grammar_constraints.length;
  }
  if (Array.isArray(internal.multi_token_patterns)) {
    summary.multi_token_pattern_count = internal.multi_token_patterns.length;
  }

  // Strip internal-only fields from classifier.
  const { thresholds: _t, weights_url: _w, ...classifierPublished } =
    internal.classifier;
  void _t; void _w;

  const descriptor: SafetyPolicyDescriptor = {
    id: internal.id,
    version: internal.version,
    tokenizers: internal.tokenizers,
    categories: internal.categories.map((c) => ({
      name: c.name,
      action: c.action as SafetyPolicyDescriptor['categories'][number]['action'],
      ...(c.description !== undefined ? { description: c.description } : {}),
    })),
    ...(internal.category_registry !== undefined
      ? { category_registry: internal.category_registry }
      : {}),
    classifier: classifierPublished as SafetyPolicyDescriptor['classifier'],
    ...(Object.keys(summary).length > 0 ? { rules_summary: summary } : {}),
    ...(internal.client_hooks !== undefined ? { client_hooks: internal.client_hooks } : {}),
    ...(internal.published_at !== undefined ? { published_at: internal.published_at } : {}),
    ...(internal.publisher !== undefined ? { publisher: internal.publisher } : {}),
  };

  // Final assertion that what we built passes validation.
  validateSafetyPolicy(descriptor);
  return descriptor;
}

function validatePolicyIdForWellKnown(id: string): void {
  if (!/^[a-z0-9._/-]+$/.test(id)) {
    fail(`policy id ${JSON.stringify(id)} must match [a-z0-9._/-]+ for well-known publishing`);
  }
  if (id.includes('..') || id.startsWith('/') || id.endsWith('/')) {
    fail(`policy id ${JSON.stringify(id)} contains a path traversal or empty segment`);
  }
}

async function cmdPoliciesValidate(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) fail('policies-validate requires a path to a safety-policy descriptor JSON file');
  const descriptor: unknown = JSON.parse(await readFile(path!, 'utf-8'));
  validateSafetyPolicy(descriptor);
  // Reject internal-only fields outright: descriptors are publishable, never
  // operator-internal. If the file contains banned_token_ids etc., it has not
  // been sanitized and MUST NOT be published.
  for (const k of INTERNAL_ONLY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(descriptor as object, k)) {
      fail(
        `descriptor at ${path} contains internal-only field '${k}'. ` +
          `Run \`policies-sanitize --internal=${path} --out=...\` first.`,
      );
    }
  }
  const d = descriptor as SafetyPolicyDescriptor;
  stdout.write(
    `✓ valid: ${d.id} (categories=${d.categories.length}, classifier=${d.classifier.family})\n`,
  );
}

async function cmdPoliciesHash(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) fail('policies-hash requires a path to a safety-policy descriptor JSON file');
  const descriptor = JSON.parse(await readFile(path!, 'utf-8')) as SafetyPolicyDescriptor;
  validateSafetyPolicy(descriptor);
  stdout.write((await hashSafetyPolicy(descriptor)) + '\n');
}

async function cmdPoliciesSanitize(_args: string[], flags: Flags): Promise<void> {
  if (!flags.internal) {
    fail('policies-sanitize requires --internal=<path-to-internal-config.json>');
  }
  const internal = JSON.parse(await readFile(flags.internal!, 'utf-8')) as InternalPolicyConfig;
  if (!internal || typeof internal !== 'object') {
    fail(`internal config at ${flags.internal} is not a JSON object`);
  }
  const descriptor = sanitizeInternalConfig(internal);
  const out = flags.out ?? `${internal.id.replace(/\//g, '_')}.policy.json`;
  const json = JSON.stringify(descriptor, null, 2) + '\n';
  await writeFile(out, json, 'utf-8');
  const hash = await hashSafetyPolicy(descriptor);
  stdout.write(`✓ sanitized ${flags.internal} → ${out}\n`);
  stdout.write(`  id              ${descriptor.id}\n`);
  stdout.write(`  categories      ${descriptor.categories.length}\n`);
  stdout.write(`  classifier      ${descriptor.classifier.family}\n`);
  if (descriptor.rules_summary) {
    const rs = descriptor.rules_summary;
    stdout.write(`  banned_ids      ${rs.banned_token_id_count ?? 0}\n`);
    stdout.write(`  regex_patterns  ${rs.regex_pattern_count ?? 0}\n`);
    stdout.write(`  grammar_rules   ${rs.grammar_constraint_count ?? 0}\n`);
    stdout.write(`  multi_token     ${rs.multi_token_pattern_count ?? 0}\n`);
  }
  stdout.write(`  hash            ${hash}\n`);
}

async function cmdPoliciesEnumerate(_args: string[], flags: Flags): Promise<void> {
  if (!flags.map) {
    fail('policies-enumerate requires --map=<path-to-tokenizer-map.json>');
  }
  if (!flags.literals) {
    fail(
      'policies-enumerate requires --literals=<path-to-literals.json>. '
      + 'The file is a JSON array of strings, one per pattern to enumerate '
      + '(e.g. ["ignore previous instructions", "system prompt is", ...]).',
    );
  }

  const rawMap = await readFile(flags.map!, 'utf-8');
  const mapJson: unknown = JSON.parse(rawMap);
  validateMap(mapJson);

  const tokMap = mapJson as { id: string; version?: string };
  const tokenizer = pickTokenizer(tokMap as Parameters<typeof pickTokenizer>[0]);
  // The output is keyed by the canonical hash, NOT the mutable id, so the
  // operator can pin which exact map bytes the enumeration was produced
  // against: same trust posture as safety-policy hash pinning.
  const mapHash = 'sha256:' + (await sha256HexOfText(rawMap));

  const literalsRaw = JSON.parse(await readFile(flags.literals!, 'utf-8'));
  if (!Array.isArray(literalsRaw) || !literalsRaw.every((s) => typeof s === 'string')) {
    fail(`literals file ${flags.literals} must contain a JSON array of strings`);
  }
  const literals = literalsRaw as string[];
  if (literals.length === 0) {
    fail(`literals file ${flags.literals} is empty`);
  }

  const result = {
    tokenizer_map_id: tokMap.id,
    tokenizer_map_hash: mapHash,
    enumerated_at: new Date().toISOString(),
    variant_set: VARIANT_SET_NAMES,
    patterns: literals.map((literal) => {
      const variants = enumerateVariants(literal);
      // Each variant becomes one allowed tokenization for the pattern.
      // Dedupe by the joined-IDs string: different surface variants often
      // collapse to the same token sequence, and we want one entry per
      // unique sequence.
      const seen = new Set<string>();
      const tokenizations: Array<{ variant: string; ids: number[] }> = [];
      for (const v of variants) {
        const ids = tokenizer.encode(v);
        const key = ids.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        tokenizations.push({ variant: v, ids });
      }
      return {
        literal,
        variants_enumerated: variants.length,
        tokenizations_unique: tokenizations.length,
        tokenizations,
      };
    }),
  };

  const out = flags.out ?? 'enumerated-patterns.json';
  await writeFile(out, JSON.stringify(result, null, 2) + '\n', 'utf-8');

  stdout.write(`✓ enumerated ${literals.length} literal(s) → ${out}\n`);
  stdout.write(`  tokenizer       ${tokMap.id}\n`);
  stdout.write(`  map hash        ${mapHash}\n`);
  const totalTokenizations = result.patterns.reduce(
    (acc, p) => acc + p.tokenizations_unique, 0,
  );
  stdout.write(`  unique seqs     ${totalTokenizations} across all patterns\n`);
  stdout.write(`  variant set     ${VARIANT_SET_NAMES.join(', ')}\n`);
  stdout.write(`\n`);
  stdout.write(`Next: hand-review the output, then paste the 'patterns'\n`);
  stdout.write(`array into your internal policy config's\n`);
  stdout.write(`'multi_token_patterns' field, then 'policies-sanitize'.\n`);
}

/**
 * Variant set v1: the patterns we cover. KEPT INTENTIONALLY SMALL so the
 * output file stays reviewable by hand. Operators who need more aggressive
 * coverage (homoglyph attacks, leetspeak, multilingual variants) should
 * extend the literals file directly with the variant strings they care
 * about.
 *
 * Order matters: variant[0] is the input verbatim, so a caller who
 * only wants the literal tokenization can take just the first entry.
 */
const VARIANT_SET_NAMES = [
  'verbatim',
  'leading-space',
  'leading-newline',
  'lowercase',
  'titlecase',
  'uppercase',
  'trimmed',
] as const;

function enumerateVariants(literal: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  push(literal);                                  // verbatim
  push(' ' + literal);                            // leading-space (BPE often
                                                  //   emits a distinct token
                                                  //   for " word" vs "word")
  push('\n' + literal);                           // leading-newline (same)
  push(literal.toLowerCase());                    // lowercase
  push(literal.charAt(0).toUpperCase() + literal.slice(1).toLowerCase());  // titlecase
  push(literal.toUpperCase());                    // uppercase
  push(literal.trim());                           // trimmed (idempotent for
                                                  //   already-trimmed inputs)
  return out;
}

async function sha256HexOfText(text: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error('Node 18+ required for crypto.subtle');
  }
  const enc = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function cmdPoliciesWellKnown(_args: string[], flags: Flags): Promise<void> {
  if (!flags.descriptor) fail('policies-well-known requires --descriptor=<path-to-descriptor.json>');
  const outDir = flags['out-dir'] ?? '.';

  const descriptor = JSON.parse(await readFile(flags.descriptor!, 'utf-8')) as SafetyPolicyDescriptor;
  validateSafetyPolicy(descriptor);
  validatePolicyIdForWellKnown(descriptor.id);

  const inline = flags.inline === 'true';
  if (!inline && !flags.url) {
    fail('policies-well-known requires either --url=<hosted-descriptor-url> (Form A pointer) or --inline (Form B)');
  }
  if (inline && flags.url) {
    fail('policies-well-known: --inline and --url are mutually exclusive');
  }

  const hashFull = await hashSafetyPolicy(descriptor);
  const hashHex = hashFull.replace(/^sha256:/, '');

  const idTargetPath = path.join(
    outDir,
    POLICY_WELL_KNOWN_BASE,
    ...descriptor.id.split('/'),
  ) + '.json';
  await mkdir(path.dirname(idTargetPath), { recursive: true });

  // Content-addressed sibling: <out>/.well-known/codec/policies/sha256/<hex>.json
  const hashTargetPath = path.join(
    outDir,
    POLICY_WELL_KNOWN_BASE,
    'sha256',
    `${hashHex}.json`,
  );
  await mkdir(path.dirname(hashTargetPath), { recursive: true });

  const inlineBytes = JSON.stringify(descriptor, null, 2) + '\n';

  let pointer: SafetyPolicyPointer | null = null;
  let idDocBytes: string;
  if (inline) {
    idDocBytes = inlineBytes;
  } else {
    pointer = {
      id: descriptor.id,
      url: flags.url!,
      hash: hashFull,
      published_at: descriptor.published_at ?? new Date().toISOString(),
    };
    idDocBytes = JSON.stringify(pointer, null, 2) + '\n';
  }
  await writeFile(idTargetPath, idDocBytes, 'utf-8');

  // The content-addressed path always carries the inline descriptor:
  // a hash-pinned location does not need a pointer indirection.
  await writeFile(hashTargetPath, inlineBytes, 'utf-8');

  stdout.write(`✓ wrote   ${idTargetPath}\n`);
  stdout.write(`✓ wrote   ${hashTargetPath} (content-addressed)\n`);
  if (pointer) {
    stdout.write(`  url           ${pointer.url}\n`);
  } else {
    stdout.write(`  inline (${(inlineBytes.length / 1024).toFixed(1)} KB)\n`);
  }
  stdout.write(`  hash          ${hashFull}\n`);
}

function help(): void {
  stdout.write(`codecai-maps: generate Codec tokenizer dialect maps

Commands:
  build <hf-model> [--id=<id>] [--out=<path>] [--token=<hf-token>]
                   [--convention=<llama3|qwen25|phi4|mistral_nemo|deepseek_v3|deepseek_r1|custom>]
    Fetch tokenizer.json from HuggingFace and convert to a TokenizerMap.
    Also fetches tokenizer_config.json (best-effort) and derives a
    'tool_calling' block from the chat template signature. Pass
    --convention=<name> to override the auto-detection.

  convert <tokenizer.json> --id=<id> [--out=<path>]
                           [--tokenizer-config=<path>] [--convention=<name>]
    Convert a local tokenizer.json file to a TokenizerMap. If a sibling
    tokenizer_config.json exists next to <tokenizer.json> it is read
    automatically; pass --tokenizer-config=<path> to override.

  validate <map.json>
    Validate a map file against the schema.

  hash <map.json>
    Print canonical sha256 hash for pinning in loadMap({ url, hash }).

  preview <map.json> [--text="..."]
    Tokenize and detokenize a sample to verify the map round-trips.

  translate --from=<map.json> --to=<map.json> [--text="..."|--ids=N,M,...]
    Cross-vocab agent handoff. Decode source IDs via the source map's
    detokenizer, re-encode via the target tokenizer. Prints both ID
    sequences and the round-trip text. Useful for seeing how
    Llama-3 → Qwen-2 (or similar) handoffs would tokenize.

  translation-table --from=<map.json> --to=<map.json> [--out=<path>]
    Build a static V_A → V_B[] table by feeding each source token's
    decoded text through the target tokenizer. Output is JSON. Note:
    context-free; prefer the streaming Translator API at runtime.

  well-known --map=<map.json> (--url=<hosted-url> | --inline) [--out-dir=<dir>]
    Emit a .well-known/codec/maps/<id>.json document and update
    .well-known/codec/index.json under <out-dir> (default: cwd). Use
    --url for the recommended pointer form (small file referencing a
    CDN-hosted map by hash); use --inline to write the full map at the
    well-known location. Designed to be checked into a static site so
    clients can call discoverMap({ origin, id }) against your domain.

  policies-validate <descriptor.json>
    Validate a sanitized safety-policy descriptor against the schema.
    Rejects descriptors that still contain operator-internal fields
    (banned_token_ids, regex_patterns, grammar_constraints,
    multi_token_patterns, classifier_internal): those must be removed
    by 'policies-sanitize' before publishing.

  policies-hash <descriptor.json>
    Print canonical sha256 of a sanitized descriptor. Servers publish
    this in READY.safety_policy_hash so clients can verify what they
    fetched against what was negotiated.

  policies-sanitize --internal=<internal-config.json> [--out=<path>]
    Transform an operator's full-detail internal policy config into the
    publishable sanitized descriptor. Strips banned_token_ids,
    regex_patterns, grammar_constraints, multi_token_patterns, and
    classifier_internal: counts them first into rules_summary so the
    descriptor exposes the SHAPE of enforcement without revealing its
    contents. The output is what gets published at .well-known.

  policies-enumerate --map=<tokenizer-map.json> --literals=<literals.json> [--out=<path>]
    Productize the v0.4 enumerator scripts (v0.5; resolves v0.4-OQ4).
    Reads a JSON array of literal strings, generates surface variants
    of each (verbatim, leading-space, leading-newline, lowercase,
    titlecase, uppercase, trimmed), tokenizes every variant through
    the supplied tokenizer map, deduplicates by token-sequence, and
    writes a JSON file ready to paste into an internal policy config's
    'multi_token_patterns' array. The output also pins the tokenizer
    map hash so operators can verify the enumeration was produced
    against the same map bytes the runtime ships.

  policies-well-known --descriptor=<path> (--url=<hosted-url> | --inline) [--out-dir=<dir>]
    Emit a .well-known/codec/policies/<id>.json document AND a
    content-addressed sibling at .well-known/codec/policies/sha256/<hex>.json
    under <out-dir>. The id-keyed document is a pointer (Form A) or
    inline descriptor (Form B); the hash-keyed sibling is always inline.
    Clients that received 'safety_policy_hash' in READY can hit the
    hash-keyed path directly and skip the mutable indirection.

Examples:
  codecai-maps build Qwen/Qwen2.5-7B-Instruct --id=qwen/qwen2
  codecai-maps build meta-llama/Llama-3.1-8B --token=hf_xxx
  codecai-maps convert ./tokenizer.json --id=my-org/my-model
  codecai-maps preview ./qwen_qwen2.json --text="Explain entropy."
  codecai-maps translate --from=qwen2.json --to=llama-3.json \\
                         --text="Explain entropy."
  codecai-maps translation-table --from=qwen2.json --to=llama-3.json \\
                                 --out=qwen-to-llama.json
  codecai-maps well-known --map=./qwen_qwen2.json \\
                          --url=https://cdn.example/qwen2.json \\
                          --out-dir=./public
  codecai-maps policies-sanitize --internal=./acme-strict-v3-internal.json \\
                                 --out=./acme-strict-v3.policy.json
  codecai-maps policies-validate ./acme-strict-v3.policy.json
  codecai-maps policies-hash ./acme-strict-v3.policy.json
  codecai-maps policies-enumerate --map=./qwen_qwen2.json \\
                                  --literals=./adversarial-strings.json \\
                                  --out=./enumerated-patterns.json
  codecai-maps policies-well-known --descriptor=./acme-strict-v3.policy.json \\
                                   --inline \\
                                   --out-dir=./public
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  try {
    switch (cmd) {
      case 'build': return await cmdBuild(positional, flags);
      case 'convert': return await cmdConvert(positional, flags);
      case 'validate': return await cmdValidate(positional);
      case 'hash': return await cmdHash(positional);
      case 'preview': return await cmdPreview(positional, flags);
      case 'translate': return await cmdTranslate(positional, flags);
      case 'translation-table': return await cmdTranslationTable(positional, flags);
      case 'well-known': return await cmdWellKnown(positional, flags);
      case 'policies-validate': return await cmdPoliciesValidate(positional);
      case 'policies-hash': return await cmdPoliciesHash(positional);
      case 'policies-sanitize': return await cmdPoliciesSanitize(positional, flags);
      case 'policies-enumerate': return await cmdPoliciesEnumerate(positional, flags);
      case 'policies-well-known': return await cmdPoliciesWellKnown(positional, flags);
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        help();
        return;
      default:
        fail(`unknown command: ${cmd}. Run 'codecai-maps help' for usage.`);
    }
  } catch (err) {
    fail((err as Error).message);
  }
}

await main();
