# v0.6 Security References: Per-Vulnerability Public Disclosure Tracking

**Purpose.** For each documented attack vector in [`spec/proposals/v0.6-security/`](../), what's publicly known: CVEs, academic papers, vendor advisories, GitHub PoC repos, real-world incidents. Lets the threat-model docs stay focused on mechanism + defense while this directory carries the citation evidence.

**Status.** Initial inventory: 2026-05-18; updated same day with the Jan:May 2026 disclosure wave. References verified against public sources as of that date. Where no specific CVE has been assigned (CVEs typically attach to specific products rather than vulnerability classes), the academic or industry source is cited instead.

**Notable 2026 additions in this update pass:**
- The Anthropic MCP "by design" STDIO command-injection wave (April 2026, Ox Security; 7,000+ servers, 150M+ downloads affected; 30+ coordinated disclosures with 10+ high/critical CVEs).
- CVE-2026-21520 (Copilot Studio), CVE-2026-26144 (Excel/Copilot zero-click), CVE-2026-24299 (Copirate 365 DEF CON), CVE-2026-42208 (LiteLLM SQLi, ~26-hour exploit window), CVE-2026-33626 (LMDeploy SSRF, ~12-hour exploit window).
- Named-attack campaigns: Reprompt (Varonis, Jan 2026), CellShock (Anthropic Claude for Excel), ZombieAgent (ShadowLeak variant).
- AWS Security Blog published official Unicode-smuggling defense guidance.

The 2026 wave makes the case for v0.6 client-side defenses stronger than the 2025 baseline did. Disclosure-to-exploit windows are now measured in **hours**.

## Files in this bundle

| # | Category file | Topic | Most-cited reference |
|---|---|---|---|
| 1 | [01-unicode-smuggling-refs.md](01-unicode-smuggling-refs.md) | Unicode-level smuggling | CVE-2021-42574 (Trojan Source) |
| 2 | [02-wire-protocol-refs.md](02-wire-protocol-refs.md) | Wire/protocol attacks | BREACH (2013), HTTP/2 framing CVEs (2019) |
| 3 | [03-indirect-injection-refs.md](03-indirect-injection-refs.md) | RAG / document / image injection | Greshake et al. 2023 (arXiv:2302.12173) |
| 4 | [04-output-exfiltration-refs.md](04-output-exfiltration-refs.md) | Markdown / link / tool-call exfil | CVE-2025-32711 (EchoLeak) |
| 5 | [05-multi-turn-behavioral-refs.md](05-multi-turn-behavioral-refs.md) | Many-shot / crescendo / prefill | Anil et al. 2024, Russinovich et al. 2024 |
| 6 | [06-tool-agent-refs.md](06-tool-agent-refs.md) | MCP poisoning / tool result trust | CVE-2025-54136 (MCP Tool Poisoning) |
| 7 | [07-codec-client-checklist-refs.md](07-codec-client-checklist-refs.md) | Operational frameworks + defensive tooling that the checklist derives from | OWASP LLM Top 10, NIST AI RMF, MITRE ATLAS |

## Conventions used in each file

- **CVE entries** include the assigned identifier and a brief mechanism summary. Linked to the canonical NVD entry where possible.
- **Academic papers** cite the arxiv ID and conference venue if published. First-author-listed for brevity.
- **GitHub repos** are tagged as `[PoC]`, `[tool]`, or `[catalog]` depending on whether they're proof-of-concept attack code, defensive tooling, or a curated collection.
- **Vendor advisories** quote the issuing org and date.
- **Real-world incidents** distinguish observed-in-wild from researcher disclosures.

## What's deliberately omitted

- **Specific working exploit code.** Where a PoC repo is referenced, it's linked for research traceability; we do not reproduce exploit payloads here.
- **Zero-day disclosures not yet public.** Stays in private vendor channels.
- **Vendor-specific bypasses for currently-shipping defenses.** If you discover one, follow responsible disclosure to the affected vendor before adding here.

## When to update this directory

- A new public CVE lands that maps to one of the documented vector classes.
- An academic paper publishes that materially changes the threat model for a vector.
- A vendor ships a mitigation that changes recommended-defense guidance in [`spec/proposals/v0.6-security/07-codec-client-checklist.md`](../07-codec-client-checklist.md).
- A new GitHub PoC or tool becomes the canonical reference for a vector.
