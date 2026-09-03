/**
 * End-to-end proof that the fixed converter reaches the same numbers as a
 * faithful transcription of each model's real HuggingFace pre-tokenizer,
 * on real corpora, for the four models the pretok pipeline bug broke:
 * SmolLM2, Falcon, DeepSeek-V3, DeepSeek-R1.
 *
 * For each model: convert its real HuggingFace `tokenizer.json` with the
 * fixed `convertHFTokenizer`, splice the resulting `pre_tokenizer_program`
 * onto the shipped codec-maps map (same vocab/merges/encoder; only the
 * pretok program differs), and run three corpora through `BPETokenizer`:
 *
 *   - golden (125 hand-aimed samples: punctuation+newline, tab/NBSP lead,
 *     punct glued to letters, CJK boundaries, combining marks, CRLF,
 *     multi-space, contractions, digit runs)
 *   - stress (3370 combinatorial samples sweeping the same dimensions)
 *   - real   (460 ten-line windows of real source code and markdown)
 *
 * against ids captured from HuggingFace `tokenizers` 0.23.1.
 *
 * Both the source `tokenizer.json` files and the corpora live outside
 * this repo (`codec-maps`'s local cache, and a scratch audit harness), so
 * every test here skips gracefully when its inputs aren't present rather
 * than failing CI on a fresh checkout. This is the same pattern the
 * existing real-Qwen-2 test in convert.test.ts already uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BPETokenizer, type TokenizerMap } from '@codecai/web';
import { convertHFTokenizer, type HFTokenizerJson } from '../src/convert.ts';

interface Corpus {
  model: string;
  hf_id: string;
  tokenizer_lib: string;
  samples: Array<{ text: string; ids: number[] }>;
}

interface ModelFixture {
  mapId: string;
  /** Candidate paths for the model's real HF tokenizer.json, tried in
   * order; the first one that exists is used. */
  hfTokenizerJsonCandidates: string[];
}

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

// codec-maps checkout: same sibling-repo convention convert.test.ts uses
// for its real-Qwen-2 test.
const CODEC_MAPS_CANDIDATES = [
  'H:/dev/codec-maps',
  path.resolve(import.meta.dirname, '../../../../codec-maps'),
];
const codecMapsRoot = firstExisting(CODEC_MAPS_CANDIDATES.map((p) => `${p}/maps`))
  ? CODEC_MAPS_CANDIDATES.find((p) => fs.existsSync(`${p}/maps`))!
  : null;

// The audit harness that generated the corpora and the source
// tokenizer.json files. Not part of any repo: a scratch working directory
// from the investigation this fix is based on. Override with
// CODEC_PRETOK_AUDIT_DIR if it lives somewhere else.
const AUDIT_DIR_CANDIDATES = [
  process.env.CODEC_PRETOK_AUDIT_DIR ?? '',
  'C:/Users/willi/AppData/Local/Temp/claude/C--Users-willi/3a1da6d2-5545-4f0e-bbc6-271d0ef9bcbb/scratchpad/pretok-audit',
];
const auditDir = AUDIT_DIR_CANDIDATES.find((p) => p && fs.existsSync(p)) ?? null;

const MODELS: ModelFixture[] = [
  {
    mapId: 'huggingfacetb/smollm2',
    hfTokenizerJsonCandidates: auditDir
      ? [`${auditDir}/HuggingFaceTB_SmolLM2-1.7B-Instruct.tokenizer.json`]
      : [],
  },
  {
    mapId: 'tiiuae/falcon',
    hfTokenizerJsonCandidates: codecMapsRoot
      ? [`${codecMapsRoot}/.cache/tokenizer-json/tiiuae__falcon-7b-instruct.tokenizer.json`]
      : [],
  },
  {
    mapId: 'deepseek-ai/deepseek-v3',
    hfTokenizerJsonCandidates: codecMapsRoot
      ? [`${codecMapsRoot}/.cache/tokenizer-json/deepseek-ai__DeepSeek-V3.tokenizer.json`]
      : [],
  },
  {
    mapId: 'deepseek-ai/deepseek-r1',
    hfTokenizerJsonCandidates: codecMapsRoot
      ? [`${codecMapsRoot}/.cache/tokenizer-json/deepseek-ai__DeepSeek-R1.tokenizer.json`]
      : [],
  },
];

/**
 * deepseek-ai/deepseek-v3's shipped map is missing `<think>`/`</think>`
 * from its special-token set (they're real vocab entries but not flagged
 * as delimiters), a pre-existing gap in that one map's special_tokens
 * data, unrelated to pre-tokenization: two "real" corpus samples happen
 * to mention those literal strings in backticked prose. A faithful
 * transcription of DeepSeek-V3's actual HuggingFace Sequence run directly
 * (bypassing this repo's special-token scanner and vocab entirely) gets
 * the same 458/460 on that corpus, confirmed via the audit harness's
 * `swap` mode: this is the correct ground truth to hold the fix to, not
 * 460/460. See the task report for the full explanation.
 */
const KNOWN_SHORTFALLS: Record<string, Partial<Record<'golden' | 'stress' | 'real', number>>> = {
  'deepseek-ai/deepseek-v3': { real: 458 },
};

for (const fixture of MODELS) {
  const hfPath = firstExisting(fixture.hfTokenizerJsonCandidates);
  const mapPath = codecMapsRoot ? `${codecMapsRoot}/maps/${fixture.mapId}.json` : null;
  const have = Boolean(hfPath && mapPath && fs.existsSync(mapPath) && auditDir);

  test(
    `pretok fix reaches ground truth on all three corpora: ${fixture.mapId}`,
    { skip: !have && 'source tokenizer.json / codec-maps / audit corpora not available locally' },
    () => {
      const hf = JSON.parse(fs.readFileSync(hfPath!, 'utf-8')) as HFTokenizerJson;
      const shipped = JSON.parse(fs.readFileSync(mapPath!, 'utf-8')) as TokenizerMap;

      const converted = convertHFTokenizer(hf, { id: fixture.mapId });
      const fixedMap = { ...shipped } as Record<string, unknown>;
      fixedMap.pre_tokenizer_program = converted.pre_tokenizer_program;
      if (converted.pre_tokenizer_pattern === undefined) {
        delete fixedMap.pre_tokenizer_pattern;
      } else {
        fixedMap.pre_tokenizer_pattern = converted.pre_tokenizer_pattern;
      }

      const tok = new BPETokenizer(fixedMap as unknown as TokenizerMap);

      for (const corpus of ['golden', 'stress', 'real'] as const) {
        const corpusPath = `${auditDir}/${fixture.mapId.replace('/', '__')}.${corpus}.json`;
        if (!fs.existsSync(corpusPath)) continue; // this one corpus wasn't generated; skip just it
        const data = JSON.parse(fs.readFileSync(corpusPath, 'utf-8')) as Corpus;

        let pass = 0;
        const fails: string[] = [];
        for (const s of data.samples) {
          const got = tok.encode(s.text);
          if (got.length === s.ids.length && got.every((v, i) => v === s.ids[i])) {
            pass++;
          } else if (fails.length < 3) {
            fails.push(JSON.stringify(s.text));
          }
        }

        const want = KNOWN_SHORTFALLS[fixture.mapId]?.[corpus] ?? data.samples.length;
        assert.equal(
          pass,
          want,
          `${fixture.mapId} ${corpus}: ${pass}/${data.samples.length} match (wanted ${want}). ` +
            `First mismatches: ${fails.join(', ')}`,
        );
      }
    },
  );
}
