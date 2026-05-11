# @codecai/maps-cli — coverage

Last measured: 2026-05-11 (v0.4 release-cut). Quantitative number
pending — see "How" below.

## How (wiring needed)

```
cd packages/maps-cli
npx c8 --reporter=text-summary npm test
```

The above wasn't run for this cut. Tracked as a v0.5 follow-up.

## Result (v0.4 baseline — test count as floor)

All tests pass:

| Test file                                | Notes                                              |
|------------------------------------------|----------------------------------------------------|
| `test/compile-pretok.test.ts`            | covers all op shapes (legacy GPT-2, old OpenAI, cased-letter) |
| `test/convert.test.ts`                   | HF tokenizer.json → TokenizerMap conversion        |
| `test/convert-tiktoken.test.ts`          | new `deriveMergesFromRanks` greedy-BPE algorithm   |
| `test/policies.test.ts`                  | new in v0.4 — sanitize / hash / well-known         |
| `test/well-known.test.ts`                | tokenizer-map + safety-policy publishing trees     |

## Intentionally uncovered

- HF-network paths in `build` subcommand — only `convert` (local
  file) is unit-tested; live HF fetch is integration-tested manually.

## v0.5 follow-up

- Wire c8 coverage + CI fail-on-regression.
- Add fixtures for the `policies-enumerate` subcommand once it
  lands (currently an open question in v0.4).
