# v0.6 Security Research and Proposals

**Status:** research notes — input to v0.6 security workstream. Captured 2026-05-18 during a deep dive into client-side attack surface relevant to Codec. These are research/threat-model documents, not finalized spec proposals. Each file enumerates a class of attack with mechanism, observed-in-the-wild references, and defensive recommendations for v0.6.

**Companion proposals in `spec/proposals/`:**
- `v0.6-prompt-dialects.md` — language-tier compression (efficiency axis)
- This bundle — security axis

v0.6's stated scope is "security + header efficiency + language-tier compression." These docs cover the security pillar.

## Why this matters now

Codec is moving from a pure-efficiency wire protocol toward something that mediates **untrusted content flowing into LLM contexts**. Every byte Codec carries is eventually tokenized and fed to a model. Every byte the client renders back to a user is a potential exfiltration surface. As Codec adoption grows beyond benchmarks and into real client integrations (chat UIs, agent runtimes, MCP-style tool layers), the protocol's threat model expands from "is the wire small and fast" to "can hostile content traverse the wire and weaponize the model or the client."

Most of the attacks documented here are NOT Codec-specific — they apply to any LLM serving pipeline. But several are sharpened or uniquely enabled by Codec-style architectures:

- **Tokenizer-map handshakes** introduce a signed-data assumption that is not yet enforced.
- **Identity-fallthrough on missing compression deps** is already known to be the worst Codec failure mode (see existing memory: `feedback_engine_image_dep_verify`).
- **Latent-codec** (v0.6 candidate) would carry VAE latents over the same wire — adversarial perturbation in latents is a new class.
- **Prompt dialects** (sibling v0.6 proposal) introduce per-corpus substitution dictionaries — a new poisoning surface.

## Files in this bundle

| # | File | Topic | Severity |
|---|---|---|---|
| 1 | [01-unicode-smuggling.md](01-unicode-smuggling.md) | Invisible/confusable Unicode injection into prompts | High — already in the wild |
| 2 | [02-wire-protocol-attacks.md](02-wire-protocol-attacks.md) | Codec-specific protocol-level attacks | High — protocol design liability |
| 3 | [03-indirect-injection.md](03-indirect-injection.md) | PDFs / images / RAG / audio as injection vectors | Critical — primary external attack surface |
| 4 | [04-output-exfiltration.md](04-output-exfiltration.md) | Markdown-image / tool-call data exfiltration | Critical — the actual incidents |
| 5 | [05-multi-turn-behavioral.md](05-multi-turn-behavioral.md) | Many-shot, crescendo, role confusion, prefill | Medium — model-layer, not protocol-layer |
| 6 | [06-tool-agent-attacks.md](06-tool-agent-attacks.md) | MCP server poisoning, tool description injection | High — growing surface |
| 7 | [07-codec-client-checklist.md](07-codec-client-checklist.md) | Prioritized defensive checklist for v0.6 client work | Reference — the action items |
| R | [references/](references/) | Per-vulnerability CVEs, papers, GitHub PoCs, vendor advisories | Citation evidence for each threat-model section |

## Recommended reading order

If you're building client-side Codec features right now, read in order of immediate relevance to that work:

1. **07** first — the prioritized checklist. Tells you what to actually do.
2. **04** next — output exfiltration is where real-world incidents happen. Most ship-blocking class.
3. **02** — Codec-specific wire concerns that no one else will catch for you.
4. **01** — Unicode smuggling is the foundation of every indirect injection.
5. **03** — Indirect injection vectors (PDFs/images/RAG).
6. **06** — Tool/agent attacks for when MCP integration ships.
7. **05** — Multi-turn/behavioral last; least Codec-actionable.

## What's deliberately not in this bundle

- **Specific working exploits against named commercial services.** Threat-model content stays at vector-and-defense level, not weaponized.
- **Bypasses for specific named commercial security products.** Out of scope.
- **Zero-day glitch tokens for current frontier models.** Responsible disclosure territory; surface the existence of the class, not the specific tokens.
- **Speculative attacks with no published incidents or proofs-of-concept.** Each vector listed has at least one public reference.

## Version status

These are v0.6 *research* docs. As they harden into wire-format changes or normative client requirements, they should be promoted into the spec proper (`spec/PROTOCOL.md` or sibling v0.6 proposal files) and these research notes updated to point at the resolved spec sections.
