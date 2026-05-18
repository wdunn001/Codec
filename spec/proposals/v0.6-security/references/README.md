# v0.6 Security References — Per-Vulnerability Public Disclosure Tracking

**Purpose.** For each documented attack vector in [`spec/proposals/v0.6-security/`](../), what's publicly known: CVEs, academic papers, vendor advisories, GitHub PoC repos, real-world incidents. Lets the threat-model docs stay focused on mechanism + defense while this directory carries the citation evidence.

**Status.** Initial inventory — 2026-05-18. References verified against public sources as of that date; some 2026 disclosures may not yet be reflected. Where no specific CVE has been assigned (most LLM-application vulnerabilities to date — CVEs typically attach to specific products, not vulnerability classes), the academic or industry source is cited instead.

## Files in this bundle

| # | Category file | Topic | Most-cited reference |
|---|---|---|---|
| 1 | [01-unicode-smuggling-refs.md](01-unicode-smuggling-refs.md) | Unicode-level smuggling | CVE-2021-42574 (Trojan Source) |
| 2 | [02-wire-protocol-refs.md](02-wire-protocol-refs.md) | Wire/protocol attacks | BREACH (2013), HTTP/2 framing CVEs (2019) |
| 3 | [03-indirect-injection-refs.md](03-indirect-injection-refs.md) | RAG / document / image injection | Greshake et al. 2023 (arXiv:2302.12173) |
| 4 | [04-output-exfiltration-refs.md](04-output-exfiltration-refs.md) | Markdown / link / tool-call exfil | CVE-2025-32711 (EchoLeak) |
| 5 | [05-multi-turn-behavioral-refs.md](05-multi-turn-behavioral-refs.md) | Many-shot / crescendo / prefill | Anil et al. 2024, Russinovich et al. 2024 |
| 6 | [06-tool-agent-refs.md](06-tool-agent-refs.md) | MCP poisoning / tool result trust | CVE-2025-54136 (MCP Tool Poisoning) |

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
