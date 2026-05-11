# @codecai/web-safety

> Optional client-side safety layer for the Codec binary transport.
> Ships in v0.4 alongside [the safety-policy negotiation spec](../../spec/versions/v0.4.md#safety-policy-negotiation).
> Sibling to [`@codecai/web`](../web); zero classifier weights of its
> own.

```sh
npm install @codecai/web-safety
```

## What it gives you

Two complementary layers, both framework-free (no React / Vue / Svelte
dependency — host apps render their own UI using the gate's view-model):

### Layer 1 — Prefilter (always-on, no network, no model load)

Catches secrets, PII, jailbreak templates, destructive-command literals,
high-entropy strings, and any host-supplied blocked patterns in a user's
input **before** it gets tokenized and sent over the wire. Doomed prompts
never use uplink, never hit server inference budget, never need
server-side moderation.

Five categories:

- **`secrets`** — vendor-anchored regex for AWS access keys, GitHub PATs,
  OpenAI / Anthropic / Google API keys, Slack / Stripe tokens, SSH
  private key headers, JWTs.
- **`pii`** — email, US phone, SSN, Luhn-validated credit-card
  candidates.
- **`high_entropy`** — generic catch-all over base64-ish and hex-ish runs
  (Shannon ≥ 4.0 bits, ≥ 24 chars). Catches API keys of unknown vendors.
- **`dangerous_action`** — obvious bad asks: jailbreak templates
  (`ignore previous instructions`, DAN-mode, "pretend to be
  unrestricted"), malware-authoring asks
  (`write working ransomware...`), exploit-authoring asks
  (`generate a 0-day exploit for...`), destructive command literals
  (`rm -rf /`, `dd if=/dev/zero of=/dev/sda`, `DROP TABLE prod`).
  These are deliberately conservative regex — the semantic
  classifiers in `classifiers/` (Prompt Guard 86M / Llama Guard 3
  1B) catch the nuanced cases. The point of regex-level
  enforcement here is to stop *cleanly-stated* doomed asks in the
  prefilter, before they consume wire, server inference budget, or
  classifier-tier compute.
- **`blocked_action`** — host-supplied patterns. Empty by default; the
  host application (`leet`, `codec-website`, etc.) passes
  `blockedActionPatterns: [{ rule, pattern, confidence? }]` to
  enforce deployment-specific gates (internal hostnames,
  `--privileged`, "no `rm -rf` against `/prod`", regulator-mandated
  refusals). Patterns live in the host's code, not in this package.

Plus dedup so vendor keys aren't double-reported as both a regex hit
and a generic entropy hit.

> **The prefilter rules are public by design.** They ship in this
> npm package's source — visible via `npm view @codecai/web-safety`
> or by reading `src/prefilter.ts`. That's the *opposite* boundary
> from the [server-side policy disclosure
> contract](https://github.com/wdunn001/Codec/blob/main/spec/versions/v0.4.md#safety-policy-negotiation):
> operator-internal banned-token-ID lists, classifier thresholds,
> and multi-token patterns live in `codec-supervisor/policies_dir/`
> and *never* cross the wire. The published policy descriptor at
> `.well-known/codec/policies/<id>.json` lists only categories +
> action types + classifier family + summary counts. Server-side
> private; client-side public. Complementary, not duplicating —
> see the top-of-file comment in `src/prefilter.ts` for the full
> layer-mapping.

```ts
import { SafetyGate } from "@codecai/web-safety";

const gate = new SafetyGate({
  audit: (e) => {
    // categories + counts only, never values
    if (e.kind === "blocked") console.info(`prefilter: ${e.categories}`);
  },
});

const decision = gate.check("paste with AKIA1234567890ABCDEF in it");
if (decision.kind === "blocked") {
  // Host renders a redact / send-anyway / cancel dialog using
  // decision.matches; user picks; gate.apply() returns send or cancel.
  const action = await showHostModal(decision);
  const result = gate.apply(decision, action);
  if (result.kind === "cancel") return;
  prompt = result.text;  // possibly redacted with [REDACTED:<rule>]
}
// ... tokenize and send via @codecai/web as usual
```

### Layer 3 — Browser-side classifier registry (opt-in)

Modular `SafetyClassifier` interface mirroring the
[`codec-supervisor` server registry](https://github.com/wdunn001/codec-supervisor)
exactly — same shapes, same canonical-categories list, so policy
descriptors talk about both sides without distinguishing host.

Two shipped implementations:

- **Prompt Guard 86M via Transformers.js** (tier 1, default) — ~80 MB
  ONNX, CPU/WASM, no WebGPU dependency. Best for always-on
  inbound-prompt classification.
- **Llama Guard 3 1B via codec-web-llm** (tier 2, opt-in) — ~1 GB
  WebGPU quant. Catches what Prompt Guard misses; same 14-category
  Llama Guard taxonomy as the server-side classifier so policy
  decisions are symmetric across mesh peers.

```ts
import { registerPromptGuard86m } from "@codecai/web-safety/classifiers/prompt-guard-86m";
import { registerLlamaGuard31B } from "@codecai/web-safety/classifiers/llama-guard-3-1b";
import { resolveClassifier } from "@codecai/web-safety";

registerPromptGuard86m();
registerLlamaGuard31B();  // opt-in

const { classifier, downgraded } = await resolveClassifier("Llama-Guard-3-1B");
// downgraded === true → registry fell back to Prompt Guard because
// the device couldn't load Llama Guard (no WebGPU, insufficient memory).
// Surface a "downgraded enforcement" badge in your UI.

const result = await classifier.score({
  form: "text",
  payload: userMessage,
});
if (result.scores.jailbreak >= 0.5) {
  // host policy decides: stop, redact, regenerate, flag
}
```

## Architecture notes

- **Framework-free.** No React/Vue/Svelte dependency. Hosts render
  modals in their own component system using `SafetyGate`'s
  `PrefilterDecision` view-model.
- **Stable cross-stack contract.** A policy's `classifier.family`
  string resolves to the same model on browser + server when both
  ship the matching registry entry — so admin UIs can bind one
  policy and have it enforced consistently across hosts.
- **Audit hook receives only categories + counts.** Never log
  matched values to telemetry; the audit callback intentionally
  doesn't expose them.
- **Per-pattern actions** match the
  [`safety-policy.schema.json`](../../spec/safety-policy.schema.json)
  contract: `stop` / `redact` / `regenerate` / `flag`. The browser
  prefilter handles the first three actions itself; `flag` annotates
  and continues.

## Peer dependencies (optional)

- [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers)
  — only needed if you `registerPromptGuard86m()`. Without it, you can
  still use the prefilter + the gate + the registry interface.
- [`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm) — only
  needed if you `registerLlamaGuard31B()`. Same property.

Both are declared as peer deps in `package.json` with
`peerDependenciesMeta.optional: true` so consumers that don't use them
never install them.

## Tests

```sh
npm test
```

Currently 62 tests covering prefilter (vendor regexes, PII Luhn-gating,
entropy-only confidence, dedup, redaction), gate state machine
(check/apply transitions, audit events), registry (register/unregister/
fallback semantics, capability detection), Prompt Guard 86M (label
mapping for all variants), Llama Guard 3 1B (prompt builder + parser +
classifier round-trip with stubbed generator). All run without
network or model weights — generator injection is the default test
pattern.

## See also

- [`spec/versions/v0.4.md`](../../spec/versions/v0.4.md) — the safety-
  policy negotiation spec on the wire.
- [`spec/safety-policy.schema.json`](../../spec/safety-policy.schema.json)
  — the publishable descriptor format.
- [`@codecai/web`](../web) — base tokenizer/detokenizer this package
  pairs with.
- [`codec-supervisor`](https://github.com/wdunn001/codec-supervisor) —
  the server-side companion shipping the policy admin REST + the
  matching `SafetyClassifier` Python registry.
