# @codecai/maps-cli — coverage

Last measured: 2026-05-11 (v0.4 release-cut)

## How

```
cd packages/maps-cli
npx c8 --reporter=text --reporter=text-summary npm test
```

For HTML output: `--reporter=html` (writes to `coverage/`).

## Result (v0.4 baseline)

```
Statements : 74.19% (1182 / 1593)
Branches   : 76.32% (158 / 207)
Functions  : 69.09% (38 / 55)
Lines      : 74.19% (1182 / 1593)
```

Tests run via `node --test`; 1 test skipped (HF live-network fetch).

| Module                        | Approx Cov% | Notes                                                            |
|-------------------------------|------------:|------------------------------------------------------------------|
| `compile-pretok.ts`           |        ~90% | all op shapes — legacy GPT-2, old-OpenAI, cased-letter, metaspace |
| `convert.ts`                  |        ~80% | HF tokenizer.json → TokenizerMap                                 |
| `convert-tiktoken.ts`         |        ~80% | new `deriveMergesFromRanks` greedy-BPE algorithm                 |
| `cli.ts`                      |        ~60% | subcommand dispatch — `build` HF-fetch path skipped               |
| Policies CLI helpers          |        ~75% | new in v0.4 — validate / sanitize / hash / well-known            |

(Per-file numbers approximate; rerun `c8 --reporter=text` for the
authoritative listing.)

## Intentionally uncovered

- `build` subcommand's HF live-network fetch path — 1 test skipped
  because it requires network access. Local-file `convert`
  subcommand IS covered.
- `well-known` generator's `--inline` mode covered; non-inline
  pointer-mode is exercised by integration tests on the lab.

## v0.5 follow-up

- Lift `cli.ts` toward 80% by adding fixtures for the
  `policies-{validate,sanitize,hash,well-known}` subcommand argv
  parsing (currently they're tested at the function level, not
  through the cli.ts entry).
- Add fixtures for the open-question `policies-enumerate` subcommand
  if it lands in v0.5.
- Wire CI to compute % + fail on regression vs the 74.19% line
  baseline.
