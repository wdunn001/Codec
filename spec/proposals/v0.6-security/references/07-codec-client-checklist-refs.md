# 07: Codec Client Checklist: Framework and Tooling References

Companion to [`../07-codec-client-checklist.md`](../07-codec-client-checklist.md).

Unlike the per-vulnerability references in files 01 to 06, this file does NOT enumerate CVEs: the checklist is an action-items document. Each P0/P1/P2 item in the checklist already cross-references its motivating threat-model section (which has the CVEs).

What this file collects instead: the **operational frameworks**, **industry checklists**, **defensive tooling**, and **peer-project security postures** that the checklist's structure derives from. Citing these makes the checklist's recommendations independently defensible.

## §1. Foundational security frameworks for LLM applications

**OWASP Top 10 for LLM Applications (2025 edition)**: the canonical industry baseline.
- https://genai.owasp.org/llm-top-10/
- Categories aligned with Codec checklist items:
  - LLM01:2025 Prompt Injection ↔ checklist P0 #1:#3 (input sanitization), P1 #8 (untrusted-content wrapping)
  - LLM02:2025 Sensitive Information Disclosure ↔ P1 #7 (output filtering)
  - LLM03:2025 Supply Chain ↔ P1 #9 (tokenizer-map signing), P1 #11 (tool-result tagging)
  - LLM05:2025 Improper Output Handling ↔ P1 #7
  - LLM06:2025 Excessive Agency ↔ P1 #11
  - LLM07:2025 System Prompt Leakage ↔ multi-turn behavioral (file 05)
  - LLM08:2025 Vector and Embedding Weaknesses ↔ indirect injection (file 03)
  - LLM09:2025 Misinformation ↔ output filtering (file 04)
  - LLM10:2025 Unbounded Consumption ↔ P0 #5 (decompression budget)

**OWASP MCP Top 10 (2025)**: the MCP-specific companion. https://owasp.org/www-project-mcp-top-10/
- MCP03:2025 Tool Poisoning ↔ P1 #11 (tool-result trust tagging)
- (Full list at the linked URL: the project is active and expanding.)

**NIST AI Risk Management Framework (AI RMF 1.0)**: federal/regulated-industry baseline.
- https://www.nist.gov/itl/ai-risk-management-framework
- Functions: GOVERN, MAP, MEASURE, MANAGE. The Codec checklist's "telemetry on every defense layer" + "loud failures over silent" requirements (crosscutting §1 to §2) align with the MEASURE function.

**NIST AI 600-1: Generative AI Profile**: companion to AI RMF specifically for genAI risks.
- https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf

**ISO/IEC 42001:2023: AI Management System (AIMS)**: the international ISO standard.
- https://www.iso.org/standard/42001
- Relevant for enterprise/SaaS Codec deployments needing certified AI governance.

**MITRE ATLAS (Adversarial Threat Landscape for AI Systems)**: adversary-tactic taxonomy.
- https://atlas.mitre.org/
- Tactic-level mapping: ATLAS TA0043 (Reconnaissance) ↔ section 05 prompt extraction; ATLAS TA0007 (Defense Evasion) ↔ section 01 unicode smuggling; etc.

**Google Secure AI Framework (SAIF)**: operational-control framework.
- https://saif.google/
- Controls: input data, output filtering, supply chain, governance. Direct correspondence to Codec's P0/P1 item structure.

**Anthropic Responsible Scaling Policy**: model-vendor-side framing.
- https://www.anthropic.com/news/anthropics-responsible-scaling-policy
- Less directly applicable to Codec, a transport rather than a model, but informs the "supervisor pass" pattern in checklist P2 #18.

## §2. Defensive tooling: implementations the checklist relies on or competes with

### Input sanitization libraries

- **`protectai/llm-guard`**: Python production sanitization library covering many of P0 #1:#3 (Unicode strip, prompt-injection detection, secrets/PII).
  https://github.com/protectai/llm-guard
- **`Lakera/lakera-pii`**: Python PII detection.
- **`Cycode` SAST**: invisible-Unicode detection in source-code review.
  https://cycode.com/blog/invisible-code-hidden-prompts-unicode-attacks-sast/

### Confusables / Unicode normalization

- **`woodgern/confusables`**: JS confusables-fold library (used by Codec's `foldConfusables` reference impl).
  https://github.com/woodgern/confusables
- **`vi3k6i5/confusable-homoglyphs`**: Python equivalent.
  https://pypi.org/project/confusable-homoglyphs/
- **Unicode Consortium confusables table**: the canonical mapping.
  https://www.unicode.org/Public/security/latest/confusables.txt

### HTML / SVG / markdown output sanitization (checklist P1 #7)

- **DOMPurify**: https://github.com/cure53/DOMPurify (JS, browser + Node)
- **bleach**: https://github.com/mozilla/bleach (Python)
- **ammonia**: https://github.com/rust-ammonia/ammonia (Rust)
- **sanitize-html**: https://github.com/apostrophecms/sanitize-html (JS)

### Red-team / fuzz tooling (test-fixture sources)

- **garak (NVIDIA)**: https://github.com/leondz/garak: LLM vulnerability scanner; modules for many-shot, crescendo, glitch tokens, role confusion, prompt extraction.
- **PyRIT (Microsoft)**: https://github.com/Azure/PyRIT: multi-turn red-teaming framework.
- **promptfoo**: https://github.com/promptfoo/promptfoo: eval + red-team plugin (`promptfoo red-team`).
- **Lakera Gandalf**: https://gandalf.lakera.ai: interactive prompt-injection challenges; useful as a benchmarking baseline.
- **Cisco AI Defense skill-scanner**: https://github.com/cisco-ai-defense/skill-scanner: added Unicode Tag Block detection in 2026.
- **OWASP `genai-security-project` repo**: https://github.com/OWASP/www-project-top-10-for-large-language-model-applications

### MCP defense tooling

- **OpenClawMCP**: https://openclawmcp.com: MCP-specific runtime defense.
- **PipeLab**: https://pipelab.org: detection and runtime defense for MCP tool poisoning.
- **The Vulnerable MCP Project**: https://vulnerablemcp.info/: comprehensive CVE database, useful as a regression-test corpus.
- **MCP gateway pattern**: Truefoundry / AuthZed / Invariant Labs all publish reference architectures.

### Compression-bomb defense (checklist P0 #5)

- General zip-bomb defenses are well-trodden territory; reference patterns in [Section 02 references](02-wire-protocol-refs.md) §3.

## §3. Peer-project security postures Codec checklist draws from

Codec's checklist structure (P0/P1/P2 priority bands with explicit MUST/SHOULD normative language) borrows from:

- **TLS 1.3 (RFC 8446)**: the gold standard for security-by-default protocol design. Capability-bitmap (T2.7 in v0.6 docket) directly inspired by TLS extension negotiation.
- **HTTP/3 (RFC 9114)**: modern length-validation conventions used in checklist P0 (strict length validation).
- **Signal Protocol**: replay-cache and nonce-windowing patterns (checklist P2 #16).
- **OpenSSH**: version-pinning + downgrade-rejection postures (checklist P0 #6).
- **Sigstore / npm provenance**: supply-chain signing model (checklist P1 #9 tokenizer-map signing).
- **Apple App Transport Security (ATS)**: production-tier-strict, development-tier-relaxed pattern (checklist crosscutting #3).
- **Browser CSP (Content Security Policy)**: allowlist-default-deny pattern (checklist P1 #7 output filtering).

The checklist's "telemetry on every defense layer, loud failures over silent" requirement (crosscutting §1 to §2) draws from:

- **Google Beyond-Corp** "log everything, alert on anomaly" pattern.
- **Netflix Chaos Engineering** principle that silent failures are the worst failures.

## §4. Industry baselines for AI-application security posture

Useful comparative reading when justifying the Codec checklist to security review boards:

- **Anthropic, "Constitutional AI"**: academic root for the trust-tier untrusted-content wrapping pattern (checklist P1 #8). https://www.anthropic.com/news/constitutional-ai
- **OpenAI, "Approach to safety" docs**: vendor-perspective framing of input/output filtering.
- **Mistral, "Le Chat" safety architecture**: alternative-vendor framing.
- **NVIDIA AI Red Team manifesto**: practitioner-perspective threat modeling.

## §5. Release / responsible-disclosure references

Codec's release-checklist gating pattern (mentioned in checklist crosscutting #5: a `§7: security` gate analogous to existing `§3.5: bench surface coverage gate`) draws from:

- **CVE Coordination: MITRE Mission and Approach**: https://www.cve.org/
- **CERT/CC Vulnerability Disclosure Policy**: https://www.kb.cert.org/vuls/
- **NTIA Multistakeholder Process: Cybersecurity Vulnerability Disclosure**: federal framework.
- **GitHub Security Advisories + Dependabot**: the operational implementation for npm/PyPI ecosystem CVEs (relevant for the Codec engine forks and per-language client libraries).
- **GitHub Private Vulnerability Reporting (PVR)**: recommended channel for inbound reports against Codec itself once the SECURITY.md disclosure-policy doc lands (per checklist Companion Deliverables).

## §6. Cross-references back into Codec's own docs

The checklist items connect outward to these existing Codec documents:

- [`docs/RELEASE_CHECKLIST.md`](../../../../docs/RELEASE_CHECKLIST.md): where the new §7 security gate (per checklist crosscutting #5) would attach.
- [`spec/PROTOCOL.md`](../../../PROTOCOL.md): where normative P0/P1 MUSTs eventually graduate.
- [`spec/versions/v0.4.md`](../../../versions/v0.4.md): current versioning policy; checklist items become wire-additive amendments in v0.6 minor releases per `feedback_protocol_versioning_policy` memory.
- [`docs/WIRE_OVERHEAD_PROPOSAL.md`](../../../../docs/WIRE_OVERHEAD_PROPOSAL.md): sibling v0.6 workstream (header efficiency); some security items (T2.7 capability bitmap) intersect.
- [`spec/proposals/v0.6-prompt-dialects.md`](../../v0.6-prompt-dialects.md): sibling v0.6 workstream (language-tier compression); the prompt-dialects proposal references shared confusables/NFKC normalization machinery.
- [`packages/web-safety/COVERAGE.md`](../../../../packages/web-safety/COVERAGE.md): coverage tracking for the reference implementation.

## §7. The checklist itself is the deliverable

Items 1 to 17 of [`../07-codec-client-checklist.md`](../07-codec-client-checklist.md) trace back to specific threat-model sections in files 01 to 06. Each P0/P1 item has an "(implementation sketch / verification step)" pair so the action is independently testable. This file's purpose is to make the **structure** of the checklist defensible against external review: when a security board asks "where did you get this list," the answer is the union of OWASP LLM Top 10 + OWASP MCP Top 10 + NIST AI RMF + MITRE ATLAS + the specific CVEs catalogued in files 01 to 06 of this directory.
