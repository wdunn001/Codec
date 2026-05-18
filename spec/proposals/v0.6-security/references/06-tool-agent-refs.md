# 06 — Tool / Agent / MCP Attacks: Public Disclosure References

Companion to [`../06-tool-agent-attacks.md`](../06-tool-agent-attacks.md).

Fastest-evolving category in 2025. MCP-specific CVEs began appearing in April 2025; OWASP added an MCP Top 10 list shortly after. Many references here may be partial — the space is moving faster than publication cycles.

## §1. MCP tool description poisoning

**CVE-2025-54136 — MCP Tool Poisoning** — primary public-numbered CVE for this vector.

- Disclosed by **Invariant Labs**, April 2025.
- Subsequent industry coverage and OWASP categorization.

**Invariant Labs disclosure timeline:**
- April 2025: initial public writeup of the tool-poisoning attack class.
- Follow-up disclosures throughout 2025.
- Research finding: **5.5% of publicly available MCP servers contain poisoned metadata** (per Invariant Labs survey).

**Industry references:**
- **OWASP MCP Top 10 — MCP03:2025 Tool Poisoning** — https://owasp.org/www-project-mcp-top-10/2025/MCP03-2025%E2%80%93Tool-Poisoning
- **OWASP community page** on MCP Tool Poisoning: https://owasp.org/www-community/attacks/MCP_Tool_Poisoning
- **Simon Willison "MCP has prompt injection security problems"** — https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/
- **Truefoundry technical analysis:** https://www.truefoundry.com/blog/blog-mcp-tool-poisoning-gateway-defense
- **AuthZed timeline of MCP breaches:** https://authzed.com/blog/timeline-mcp-breaches

**Academic:**
- **"Model Context Protocol Threat Modeling and Analyzing Vulnerabilities to Prompt Injection with Tool Poisoning"** — arxiv 2603.22489 (2026)

**Attack-success-rate findings (academic):**
- o1-mini: **72.8% attack success rate** in controlled testing
- More capable models were often **more** vulnerable — the attack exploits their superior instruction-following abilities

---

## §2. GitHub MCP Server attack (Invariant Labs, 2025)

**Incident:** disclosed by Invariant Labs in 2025.

- Affected repo: official GitHub MCP server, ~14,000 stars at time of disclosure.
- **Vector:** malicious issue in a public repository. User asked their agent to triage public issues → agent read the malicious issue → followed hidden instructions → pulled data from private repositories → wrote it into an attacker-controlled public pull request.
- **Significance:** first widely-publicized end-to-end exfiltration via MCP toxic-agent-flow against an official server. Demonstrated cross-repo trust violation.

---

## §3. Postmark email MCP server backdoor (2025)

**Incident:** backdoored version of a popular Postmark email MCP server.

- A release silently exfiltrated email contents through the server's legitimate email-sending path.
- Any agent using the backdoored version routed a copy of every message to an attacker-controlled destination.
- **Significance:** supply-chain attack against trusted MCP server — distinct from tool-description poisoning. The capability statement was honest; the implementation was backdoored.

---

## §4. Tool result trust (general class)

**Status:** broad subset of indirect prompt injection (see [`03-indirect-injection-refs.md`](03-indirect-injection-refs.md)).

**Canonical references:**
- Greshake et al. 2023 paper covers tool results as one of the injection channels.
- Multiple Embrace The Red posts demonstrate specific tool-result hijacks against ChatGPT plugins (pre-MCP) and Claude tool use.

---

## §5. Capability spoofing

**Status:** no single CVE; class-level concern.

**Canonical references:**
- Standard supply-chain attack class, transferred from package-manager precedent (typosquatting, etc.).
- **OWASP Top 10 MCP** — covered under multiple MCP categories.

---

## §6. Resource content abuse (MCP-specific)

**Status:** sub-class of §1. Same disclosure channels.

---

## §7. Tool name collisions

**Status:** operational concern; no formal CVE.

**Mitigation guidance:**
- Anthropic's MCP documentation recommends namespacing by server identity.
- Most MCP client implementations have shipped collision-handling policies since mid-2025.

---

## §8. Cross-server data flow / pivot attacks

**Status:** documented in Invariant Labs and academic work alongside §1.

**Canonical reference:**
- arxiv 2603.22489 (academic threat model, see §1)
- Invariant Labs blog series 2025

---

## §9. Cache poisoning in MCP context

**Status:** sub-class of [`02-wire-protocol-refs.md`](02-wire-protocol-refs.md) §8. Same mitigation pattern (cache keys include trust principal).

---

## §10. Persistent backdoor via tool registration

**Status:** documented but no single high-profile incident — observed in test deployments.

**Mitigation:**
- Per-session tool grants by default.
- Manifest pinning (hash + signature).
- Periodic re-validation.

---

## Tooling for this category

**Defense / sanitization:**
- **OpenClawMCP** — https://openclawmcp.com — MCP-specific runtime defense
- **PipeLab** — https://pipelab.org/learn/mcp-tool-poisoning/ — detection and runtime defense
- **MCP Gateway pattern** (Truefoundry, AuthZed, others) — middleware that intercepts MCP traffic and applies policy

**Red-team / scanning:**
- **MCP Security Scanner** (Invariant Labs) — referenced in their disclosures; tool surveys MCP servers for known poisoning patterns

---

## Sources

- [OWASP MCP Top 10 — Tool Poisoning](https://owasp.org/www-project-mcp-top-10/2025/MCP03-2025%E2%80%93Tool-Poisoning)
- [Simon Willison — MCP prompt injection problems](https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/)
- [Truefoundry MCP Tool Poisoning analysis](https://www.truefoundry.com/blog/blog-mcp-tool-poisoning-gateway-defense)
- [AuthZed — Timeline of MCP Security Breaches](https://authzed.com/blog/timeline-mcp-breaches)
- [MCP threat-modeling paper — arxiv 2603.22489](https://arxiv.org/abs/2603.22489)
- [Greshake et al. — foundational indirect-injection paper](https://arxiv.org/abs/2302.12173)
