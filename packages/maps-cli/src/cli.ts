#!/usr/bin/env node
/**
 * codecai-maps — CLI for generating Codec tokenizer dialect maps.
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

import { readFile, writeFile } from 'node:fs/promises';
import { argv, exit, stdout, stderr } from 'node:process';
import {
  validateMap,
  BPETokenizer,
  Detokenizer,
  pickTokenizer,
  Translator,
  staticTranslationTable,
} from '@codecai/web';
import {
  convertHFTokenizer,
  fetchAndConvert,
  hashMap,
  type HFTokenizerJson,
} from './convert.js';
import type { TokenizerMap } from '@codecai/web';

interface Flags {
  id?: string;
  out?: string;
  token?: string;
  text?: string;
  from?: string;
  to?: string;
  ids?: string;
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
  const map = await fetchAndConvert({ hfModel: hfModel!, id, hfToken: flags.token });
  const json = JSON.stringify(map, null, 2);
  await writeFile(out, json + '\n', 'utf-8');
  const hash = await hashMap(map);

  stdout.write(`✓ written  ${out}\n`);
  stdout.write(`  id           ${map.id}\n`);
  stdout.write(`  vocab_size   ${map.vocab_size}\n`);
  stdout.write(`  encoder      ${map.encoder ?? 'identity'}\n`);
  stdout.write(`  merges       ${map.merges?.length ?? 0}\n`);
  if (map.byte_fallback_start !== undefined) {
    stdout.write(`  byte_fallback ${map.byte_fallback_start}–${map.byte_fallback_end}\n`);
  }
  stdout.write(`  hash         ${hash}\n`);
}

async function cmdConvert(args: string[], flags: Flags): Promise<void> {
  const inPath = args[0];
  if (!inPath) fail('convert requires a path to a tokenizer.json file');
  const id = flags.id;
  if (!id) fail('convert requires --id=<map-id> (e.g. my-org/my-model)');
  const out = flags.out ?? `${id.replace(/\//g, '_')}.json`;

  const hf = JSON.parse(await readFile(inPath!, 'utf-8')) as HFTokenizerJson;
  const map = convertHFTokenizer(hf, { id });
  const json = JSON.stringify(map, null, 2);
  await writeFile(out, json + '\n', 'utf-8');
  const hash = await hashMap(map);

  stdout.write(`✓ written  ${out}\n`);
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

function help(): void {
  stdout.write(`codecai-maps — generate Codec tokenizer dialect maps

Commands:
  build <hf-model> [--id=<id>] [--out=<path>] [--token=<hf-token>]
    Fetch tokenizer.json from HuggingFace and convert to a TokenizerMap.

  convert <tokenizer.json> --id=<id> [--out=<path>]
    Convert a local tokenizer.json file to a TokenizerMap.

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

Examples:
  codecai-maps build Qwen/Qwen2.5-7B-Instruct --id=qwen/qwen2
  codecai-maps build meta-llama/Llama-3.1-8B --token=hf_xxx
  codecai-maps convert ./tokenizer.json --id=my-org/my-model
  codecai-maps preview ./qwen_qwen2.json --text="Explain entropy."
  codecai-maps translate --from=qwen2.json --to=llama-3.json \\
                         --text="Explain entropy."
  codecai-maps translation-table --from=qwen2.json --to=llama-3.json \\
                                 --out=qwen-to-llama.json
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
