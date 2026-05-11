# @codecai/web-safety — coverage

Last measured: 2026-05-11 (v0.4 release-cut)

## How

```
cd packages/web-safety
npx c8 --reporter=text-summary npm test
```

## Result (v0.4 baseline — new package this release)

```
Statements  : 90.43% (1153/1275)
Branches    : 81.46% (145/178)
Functions   : 92.10% (35/38)
Lines       : 90.43% (1153/1275)
```

62 passed, 0 skipped, 0 todo.

| Module                              | Approx Cov% | Notes                                            |
|-------------------------------------|------------:|--------------------------------------------------|
| `prefilter.ts`                      |        ~95% | vendor regexes, PII Luhn-gating, entropy, dedup |
| `gate.ts`                           |        ~95% | check/apply state machine, audit events         |
| `registry.ts`                       |        ~90% | register / unregister / fallback / capability   |
| `classifiers/prompt-guard-86m.ts`   |        ~85% | label-mapping all variants, generator-DI tests  |
| `classifiers/llama-guard-3-1b.ts`   |        ~85% | prompt builder + parser + round-trip            |
| `base.ts`                           |        100% | interface — no branches                          |
| `index.ts`                          |        100% | re-exports only                                  |

## Intentionally uncovered

- The downloadable model paths (`prompt-guard-86m` loads ~80 MB ONNX;
  `llama-guard-3-1b` loads ~1 GB WebGPU) — runtime weight fetch is
  not exercised in the unit suite; tests use generator-DI (an
  injectable `(text) → labels` callable) so the classifier-pipeline
  logic is covered without weights. Real-weight loading is exercised
  by the lab cross-stack matrix where the WebGPU and CPU paths are
  both available.
- WebGPU capability-detection branch is stubbed in the test
  environment (`navigator.gpu` is absent) — the registry-level
  fallback is covered, the actual WebGPU dispatch is not.

## v0.5 follow-up

- Move the capability-detection stub into a per-runtime adapter
  (jsdom / happy-dom) so the WebGPU branch can be exercised.
- Add the missing fallback test for "user explicitly required
  Llama Guard but no classifier capable" (currently exits with the
  `downgraded: true` flag instead of throwing — needs an explicit
  test).
