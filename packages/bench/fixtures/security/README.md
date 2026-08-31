# Security Attack Fixtures: v0.6 Test Suite

**Purpose.** Curated attack payloads, one fixture per documented attack vector
in [`spec/proposals/v0.6-security/`](../../../../spec/proposals/v0.6-security/),
suitable for use as test inputs by any Codec implementation (TypeScript, Python,
Rust, .NET, Java, C).

**Status.** Initial v0.6 suite: 2026-05-18. Most fixtures are text-based for
easy cross-language consumption. Binary fixtures (PDFs, images, audio) have
companion `generate_*.py` scripts since checking in binaries doesn't review well.

## Directory layout

```
fixtures/security/
├── 01-unicode-smuggling/        # invisible / confusable Unicode in user content
├── 02-wire-protocol/            # downgrade, bombs, replay, framing
├── 03-indirect-injection/       # PDF / HTML / image / email injection sources
├── 04-output-exfiltration/      # model outputs that leak data on render
├── 05-multi-turn-behavioral/    # many-shot / crescendo / prefill conversation logs
└── 06-tool-agent-attacks/       # MCP tool description / result poisoning
```

Each subdirectory has its own `README.md` documenting the per-vector fixtures.

## How fixtures are structured

Each fixture is a single file or small group of files demonstrating ONE attack.
Naming convention: `<short-name>.<ext>` for the payload; optional
`<short-name>.expected.txt` for what a correct defense should produce; optional
`<short-name>.meta.json` for metadata (origin, related vector, severity).

For attacks that need binary content (PDFs, images), the payload is generated
by a `generate_<short-name>.py` script committed alongside. The build is
reproducible as a result, and the source-of-attack stays readable.

## How tests use these fixtures

The `@codecai/web-safety` package's `test/security/` directory contains
TypeScript tests that load fixtures from here and run them against the
package's `src/security/` defense functions. Each test demonstrates both:

1. **The attack is real**: fixture contains the documented payload class.
2. **The defense blocks it**: after the defense function runs, the payload
   no longer carries the attack.

Tests follow the pattern:

```typescript
test('attack: <short-name>', async () => {
  const payload = await loadFixture('01-unicode-smuggling/<short-name>.txt');
  assert.ok(
    isAttackPayload(payload),
    'fixture must actually carry the attack class',
  );
  const sanitized = applyDefense(payload);
  assert.equal(
    isAttackPayload(sanitized),
    false,
    'defense must neutralize the attack',
  );
  assert.ok(
    sanitized.includes(EXPECTED_VISIBLE_CONTENT),
    'defense must preserve legitimate content',
  );
});
```

## Extending the suite

To add a new attack:

1. Drop a fixture file in the right category subdirectory.
2. Update the subdirectory README with a one-line description.
3. Add a test case in `packages/web-safety/test/security/<category>.test.ts`.
4. If a new defense is needed, add it to `packages/web-safety/src/security/`.

For attacks that require an actual model run (multi-turn jailbreaks, image OCR),
the fixture documents the expected behavior but the live test is gated behind
a `RUN_MODEL_TESTS=1` env var (slow / expensive / non-deterministic).

## What's deliberately not in this suite

- **Working exploits against named commercial services.** Stays at vector-and-defense
  level.
- **Zero-day glitch tokens for current frontier models.** Documented as a class;
  specific tokens omitted (responsible disclosure).
- **Real personal identifying information.** All fixture content uses obviously-
  fake content (`user@example.com`, `attacker.example`, etc.).
