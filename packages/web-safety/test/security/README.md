# v0.6 Security Test Suite

**Location:** `packages/web-safety/test/security/`.
**Counterpart docs:** [`spec/proposals/v0.6-security/`](../../../../spec/proposals/v0.6-security/).
**Fixtures:** [`packages/bench/fixtures/security/`](../../../bench/fixtures/security/).

## What this is

Working test cases for each documented attack class in the v0.6 security
research bundle. Each test demonstrates the **attack is real** (the fixture
actually carries the documented attack class) AND the **defense neutralizes
it** (the sanitizer/filter blocks the attack while preserving legitimate
content). Together they form an executable specification of v0.6's security
posture.

## What's covered

| Category | Coverage |
|---|---|
| 01 — Unicode smuggling | **Full** — 7 attacks, 15 tests |
| 02 — Wire protocol | **Core** — decompression bombs, length confusion, downgrade negotiation, dict-zstd preference, identity-fallthrough rejection. 11 tests. Live transport bindings (HTTP/2, SSE) tested separately in the bench harness. |
| 03 — Indirect injection | **Partial** — JSON role injection, chat-template tokens, system-reminder mimicry. Binary fixtures (PDF/image/audio) deferred to follow-up. |
| 04 — Output exfiltration | **Partial** — markdown image/link allowlist, data:/javascript: URI rejection. HTML/SVG render and tool-call exfil deferred to follow-up. |
| 05 — Multi-turn / behavioral | **Core** — many-shot pattern detection, role-claim scanning (8 patterns), prefill validation, conversation-length guard. 16 tests. Live model jailbreak evaluation gated behind `RUN_MODEL_TESTS=1`. |
| 06 — Tool / agent / MCP | **Core** — tool-description sanitization, untrusted-content wrapping, attribute-injection escaping, tool-name collision detection. 12 tests. Live MCP harness deferred. |

## Running

From the package root:

```sh
cd packages/web-safety
npm test
```

The test script in `package.json` globs `test/*.test.ts` and `test/security/*.test.ts`. Add new test files to either location.

For a single category:

```sh
node --test --import tsx test/security/01-unicode-smuggling.test.ts
```

## Reading order if you're new to the suite

1. [`spec/proposals/v0.6-security/README.md`](../../../../spec/proposals/v0.6-security/README.md) — the threat model.
2. [`spec/proposals/v0.6-security/07-codec-client-checklist.md`](../../../../spec/proposals/v0.6-security/07-codec-client-checklist.md) — what client code must do.
3. [`packages/bench/fixtures/security/README.md`](../../../bench/fixtures/security/README.md) — fixture layout.
4. [`packages/web-safety/src/security/sanitize.ts`](../../src/security/sanitize.ts) — the boundary-layer sanitizer.
5. [`packages/web-safety/src/security/output-filter.ts`](../../src/security/output-filter.ts) — the markdown-output filter.
6. `01-unicode-smuggling.test.ts` — the most thoroughly-built category; serves as the template for extending the other categories.

## Extending the suite

To add a new attack vector:

1. Add the fixture file under `packages/bench/fixtures/security/<NN-category>/`.
2. Document it in the category's `README.md`.
3. Add a test pair (attack-is-real + defense-blocks-it) in the matching `test/security/<NN-category>.test.ts`.
4. If a new defense is needed, add it to `packages/web-safety/src/security/` and export from `index.ts`.
5. Run the suite; verify both directions pass.

## What this suite deliberately does NOT do

- **Run live model evaluations.** Some attacks (many-shot jailbreak, crescendo, image OCR) need an actual model run to validate. Those tests are stubbed in fixtures with a `RUN_MODEL_TESTS=1` env gate planned for a follow-up.
- **Generate binary fixtures.** PDFs, images, audio — the planned generator scripts (`generate_*.py`) live alongside their target fixtures and run at build time, not commit time.
- **Test against real recruiter/agent stacks.** The vulnerable-pipeline functions in `03-indirect-injection.test.ts` are *models* of real pipelines, not the real things. The defended-pipeline functions are *examples* of what real client code should do.

The point of this suite is to make each documented threat **falsifiable**: when v0.6 ships, every test here must pass, and any new attack discovered in the wild gets added here as a regression test before its mitigation lands.
