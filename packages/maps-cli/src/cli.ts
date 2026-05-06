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
 */

import { readFile, writeFile } from 'node:fs/promises';
import { argv, exit, stdout, stderr } from 'node:process';
import { validateMap, BPETokenizer, Detokenizer, pickTokenizer } from '@codecai/web';
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

Examples:
  codecai-maps build Qwen/Qwen2.5-7B-Instruct --id=qwen/qwen2
  codecai-maps build meta-llama/Llama-3.1-8B --token=hf_xxx
  codecai-maps convert ./tokenizer.json --id=my-org/my-model
  codecai-maps preview ./qwen_qwen2.json --text="Explain entropy."
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
