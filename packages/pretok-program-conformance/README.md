# Pre-tokenizer program conformance fixtures

`fixtures/pretok-program-cases.json` is the single source of truth for
what every Codec `pre_tokenizer_program` interpreter (TypeScript, Python,
Rust, C, .NET) must produce, for both v1 (`ops`) and v2 (`stages`)
programs. When the op or stage set changes, add cases here first, then
update every language's tests to match. See
`spec/PRETOKENIZER_PROGRAM.md` for the schema and rationale this fixture
tracks.

## Why this file exists

Schema v2 (multi-stage `Sequence` programs) shipped first in
`packages/web/src/pretok-program.ts`, the only executor that ran it end
to end. Porting that interpreter to another language by reading the spec
prose alone risks the same kind of gap that made the original HuggingFace
`Sequence` converter drop every stage but the first `Split` node: a port
that looks right on the cases its author thought to try. This fixture is
generated directly from the TypeScript reference (see `generated_by` in
the JSON header). Every `expected_pieces` value therefore records what
that interpreter actually does at the moment of generation. Comparing
token IDs alone is not enough here either. A wrong split can still land
on the right final IDs when the BPE merge table happens to recover. That
is exactly why the fixture asserts piece lists, the layer the actual
defect this schema fixes lives at.

The fixture also pins one specific, previously real bug. An unmatched
span inside an `alternation` stage must come out as ONE piece, never
shattered one Unicode scalar value at a time. A v1 program's op list is
exhaustive over raw text. That distinction stays invisible there because
the branch never fires. It becomes reachable only once an earlier v2 stage
has isolated a character class the alternation stage's own ops don't
handle. The `gap_semantics_*` cases in this fixture exist specifically to
catch a regression there.

## Schema

```jsonc
{
  "description": "...",
  "generated_by": "packages/web/src/pretok-program.ts via runPreTokProgram",
  "cases": [
    {
      "name": "…",                    // stable, descriptive, snake_case
      "program": { "version": 1, "ops": [...] },       // or { "version": 2, "stages": [...] }
      "input": "…",                   // the text fed to the interpreter
      "expected_pieces": ["…", "…"]   // the exact ordered piece list
    }
  ]
}
```

A conforming interpreter, given `case.program` and `case.input`, must
produce exactly `case.expected_pieces`: same length, same order, same
string content per piece.

## Coverage

- v1 worked examples: Qwen-2-style unbounded numbers, Llama-3-style
  bounded numbers, Llama-2/Mistral-v3-style metaspace.
- v2 full pipelines covering the three distinct programs schema v2
  exists for: SmolLM2, Falcon, DeepSeek. DeepSeek's program is shared
  verbatim by V3 and R1.
- Isolated single-stage probes for each v2 stage kind: `digits_isolate`,
  `digit_triples_isolate`, `punctuation_contiguous`, `cjk_isolate`. These
  let a stage bug be localized without a full multi-stage pipeline in the
  way. The `digits_isolate` cases cover its individual mode, its grouped
  mode, and its bounded `max_run` mode. The `digit_triples_isolate` cases
  cover a digit run that isn't a multiple of 3. The `cjk_isolate` cases
  cover Hiragana and Katakana in addition to CJK Unified Ideographs.
- Isolated op probes for the new/extended ops: `punct_ascii_letters`,
  `letters` with `lead_other_class: "l_p_s"` and `body: "L_M"`,
  `punct_run` with `charset: "p_s"`.
- The gap-semantics regression described above, for both a pure digit-run
  piece and a pure CJK-run piece reaching an alternation stage with no
  matching op of its own.

This fixture is a regression net over hand-picked and stage-boundary
cases. It is deliberately not a replacement for a full differential audit
across golden/combinatorial-stress/real-code corpora; that audit lives
outside this repo (see the project's working history) and is what
established the fixed converter reaches ground truth in the first place.

## How each language uses this file

- **Python** (`packages/python`): `tests/test_pretok_program_v2.py`
  loads this file and runs every case through
  `codecai.run_pretok_program`, parametrized by `case["name"]`.
- **TypeScript** (`packages/web`): this fixture was generated FROM
  `packages/web/src/pretok-program.ts`. It is true by construction there
  today. Wiring a test that loads and re-asserts it is still worth doing.
  That way a future change to that file trips the same net every other
  language runs against.
- **Rust** (`packages/rust`) and **C** (`packages/c`): not yet wired up.
  Both clients are v1-only as of this writing (see
  `spec/PRETOKENIZER_PROGRAM.md` § Versioning). When either is extended
  to execute v2 `stages`, load this file the same way `packages/python`
  does. Parse it, iterate `cases`, feed `case.program` and `case.input`
  to the language's interpreter, then assert the result equals
  `case.expected_pieces` exactly.
