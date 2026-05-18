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

## 2026 disclosure update (Jan–May 2026) — **the wave year for MCP**

The MCP security landscape has changed dramatically in early 2026. April 2026 saw a coordinated wave of disclosures led by Ox Security and others. Headline numbers:

**Systemic Anthropic MCP STDIO design flaw (April 2026, Ox Security).**
- A "by design" weakness in the official Anthropic MCP SDK across **Python, TypeScript, Java, and Rust** that can lead to remote code execution.
- Affects more than **7,000 publicly accessible servers** and software packages totaling more than **150 million downloads.**
- **Anthropic's response:** confirmed the behavior is by design and declined to modify the protocol, stating "the STDIO execution model represents a secure default and that sanitization is the developer's responsibility."
- This created significant industry pushback; positioned MCP host implementations (not the protocol itself) as the locus of mitigation.
- References:
  - The Hacker News: https://thehackernews.com/2026/04/anthropic-mcp-design-vulnerability.html
  - The Register: https://www.theregister.com/2026/04/16/anthropic_mcp_design_flaw/
  - Infosecurity Magazine: https://www.infosecurity-magazine.com/news/systemic-flaw-mcp-expose-150/
  - Ox Security full advisory: https://www.ox.security/blog/the-mother-of-all-ai-supply-chains-critical-systemic-vulnerability-at-the-core-of-the-mcp/
  - Ox Security STDIO command-injection advisory: https://www.ox.security/blog/mcp-supply-chain-advisory-rce-vulnerabilities-across-the-ai-ecosystem/

**Ox Security's 30+ disclosures (April 2026):**
- Coordinated multi-vendor disclosure cycle covering >30 MCP servers/packages.
- Yielded **>10 high or critical-severity CVEs.**
- Catalog summary: Khayyam H., "The Model Context Protocol Crisis: What 30 CVEs Teach Us About Building Secure AI Agents" — https://medium.com/@khayyam.h/the-model-context-protocol-crisis-what-30-cves-teach-us-about-building-secure-ai-agents-95e16497d249

**Specific 2026 CVEs (selected):**

| CVE | Component | Class | Severity |
|---|---|---|---|
| **CVE-2026-25536** | MCP server with `StreamableHTTPServerTransport` | Cross-client response leak when a single `McpServer` instance is reused across multiple clients — responses leak across client boundaries | High |
| **CVE-2026-23744** | MCPJam Inspector | RCE — listens on 0.0.0.0 with no authentication on a critical endpoint; a crafted HTTP request installs an MCP server and executes arbitrary code on the host | Critical |
| **CVE-2026-30615** | Windsurf | Prompt injection allowing remote attackers to execute arbitrary commands on a victim system | High |

CVE numbers for the rest of the Ox Security wave aren't fully enumerated here; the comprehensive index is at **The Vulnerable MCP Project**: https://vulnerablemcp.info/

**Continuous red-teaming response:**
- Penligent.ai analysis on continuous-red-teaming as the response posture: https://www.penligent.ai/hackinglabs/anthropic-mcp-vulnerability-7000-servers-and-the-case-for-continuous-red-teaming/
- CyberSecure Fox technical writeup on the MCP RCE class: https://cybersecurefox.com/en/model-context-protocol-mcp-remote-code-execution-vulnerability/

**Codec-relevance:** the 2026 MCP wave is the single strongest argument for the v0.6 normative requirements in [`../07-codec-client-checklist.md`](../07-codec-client-checklist.md) §11 (tool-result trust tagging) and §9 (tokenizer-map signing). Anthropic's "developer responsibility" posture means the protocol layer will NOT solve this; the burden falls entirely on client implementations like the ones Codec is positioned to enable.

---

## Sources

- [OWASP MCP Top 10 — Tool Poisoning](https://owasp.org/www-project-mcp-top-10/2025/MCP03-2025%E2%80%93Tool-Poisoning)
- [Simon Willison — MCP prompt injection problems](https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/)
- [Truefoundry MCP Tool Poisoning analysis](https://www.truefoundry.com/blog/blog-mcp-tool-poisoning-gateway-defense)
- [AuthZed — Timeline of MCP Security Breaches](https://authzed.com/blog/timeline-mcp-breaches)
- [MCP threat-modeling paper — arxiv 2603.22489](https://arxiv.org/abs/2603.22489)
- [Greshake et al. — foundational indirect-injection paper](https://arxiv.org/abs/2302.12173)
- [The Vulnerable MCP Project — comprehensive CVE database](https://vulnerablemcp.info/)
- [The Hacker News — Anthropic MCP design vulnerability (April 2026)](https://thehackernews.com/2026/04/anthropic-mcp-design-vulnerability.html)
- [The Register — MCP design flaw 200k servers (April 2026)](https://www.theregister.com/2026/04/16/anthropic_mcp_design_flaw/)
- [Ox Security — mother-of-all-AI-supply-chains advisory](https://www.ox.security/blog/the-mother-of-all-ai-supply-chains-critical-systemic-vulnerability-at-the-core-of-the-mcp/)
- [Khayyam H. — 30 CVEs from MCP](https://medium.com/@khayyam.h/the-model-context-protocol-crisis-what-30-cves-teach-us-about-building-secure-ai-agents-95e16497d249)
