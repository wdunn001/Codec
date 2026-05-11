# @codecai/web — coverage

Last measured: 2026-05-11 (v0.4 release-cut)

## How

```
cd packages/web
npx c8 --reporter=text --reporter=text-summary npm test
```

## Result (v0.4 baseline)

```
Statements  : 90.24% (3375/3740)
Branches    : 82.14% (713/868)
Functions   : 96.83% (153/158)
Lines       : 90.24% (3375/3740)
```

125 passed, 2 skipped (real-Qwen-tokenizer fetch tests).

| Module             | Cov% | Notes                                                            |
|--------------------|-----:|------------------------------------------------------------------|
| `index.ts`         | 100% |                                                                  |
| `pretok-program.ts`|  98% | new op support: `letters_cased`, `lead_space`, `trailing_chars`  |
| `encoder.ts`       |  96% |                                                                  |
| `tool-watcher.ts`  |  96% |                                                                  |
| `tokenize.ts`      |  95% | special-token pre-scan + `(?i:)` desugar fallback                |
| `detokenize.ts`    |  93% |                                                                  |
| `translate.ts`     |  93% |                                                                  |
| `discover.ts`      |  91% |                                                                  |
| `stream.ts`        |  89% |                                                                  |
| `latent-frame.ts`  |  89% |                                                                  |
| `map.ts`           |  85% |                                                                  |
| `safety-policy.ts` |  78% | new in v0.4 — hash, load, discover all covered; pointer-mode edge cases need more |

## Intentionally uncovered

- 2 tests in `bpe.test.ts` skip when a fetched Qwen-2 tokenizer.json
  isn't reachable locally; they run in the matrix bench on the lab.

## v0.5 follow-up

- `safety-policy.ts` pointer-mode (`.well-known/codec/policies/<id>.json`
  → external URL → hash-verify fetch) has the discovery glue but the
  pointer-resolution branch is only 78% covered. Add fixtures for
  missing-pointer / hash-mismatch / pointer-cycle cases.
- Wire CI to run `c8` and fail on regression vs. the v0.4 baseline.
