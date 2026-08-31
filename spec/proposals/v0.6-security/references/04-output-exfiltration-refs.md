# 04: Output-Side Exfiltration: Public Disclosure References

Companion to [`../04-output-exfiltration.md`](../04-output-exfiltration.md).

This category contains the **most severe documented real-world incidents** in the LLM-application space. EchoLeak (CVE-2025-32711) is the canonical reference and the first incident where prompt injection caused concrete, measurable enterprise data exfiltration in a production AI system.

## §1. Markdown image exfiltration: the EchoLeak class

**CVE-2025-32711: "EchoLeak"** in Microsoft 365 Copilot.

- **Disclosed by:** Aim Security (Aim Labs)
- **Patched:** June 2025 (Microsoft Patch Tuesday)
- **CVSS score:** 9.3 (Critical)
- **Microsoft advisory:** https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711
- **NVD:** https://nvd.nist.gov/vuln/detail/CVE-2025-32711
- **Technical writeup (Aim Labs):** https://www.aim.security (search "EchoLeak")
- **Academic analysis:** https://arxiv.org/abs/2509.10540: "EchoLeak: The First Real-World Zero-Click Prompt Injection Exploit in a Production LLM System"

**Mechanism summary:** Attacker email contained adversarial prompt → Copilot processed the email + accessed the user's internal files → response included markdown image with exfiltrated content base64'd into URL query string → Outlook rendered the markdown → image fetch carried data to attacker server. **Zero user interaction required.**

**Defenses bypassed:**
- Cross-prompt injection attack (XPIA) classifiers
- External-link redaction
- Content Security Policy
- M365 Copilot's reference-mentions filter

**Industry coverage:**
- The Hacker News: https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html
- HackTheBox technical analysis: https://www.hackthebox.com/blog/cve-2025-32711-echoleak-copilot-vulnerability
- Checkmarx: https://checkmarx.com/zero-post/echoleak-cve-2025-32711-show-us-that-ai-security-is-challenging/
- SOC Prime: https://socprime.com/blog/cve-2025-32711-zero-click-ai-vulnerability/

**Related disclosures (same vector class, separate incidents):**
- **ShadowLeak**: separate ChatGPT exfiltration, disclosed by Radware. Reported September 26, 2025; fixed by OpenAI December 16, 2025.
- **Multiple Embrace The Red catalog entries**: Johann Rehberger has documented 20+ specific exfiltration chains against ChatGPT, Bing, Copilot, custom GPTs. See https://embracethered.com/blog/.

---

## §2. ChatGPT-class CVE catalog

**CVE-2024-29990**: ChatGPT prompt injection enabling override of system instructions and conversation history exfiltration.
- Reported in OpenAI security history; vendor-issued mitigation 2024.

**CVE-2025-53773**: GitHub Copilot remote code execution via prompt injection.
- CVSS 9.6 (Critical)
- Disclosed and patched 2025.

**CVE-2025-68664: "LangGrinch"**: LangChain `dumps()` / `dumpd()` serialization functions injection.
- Attackers could inject LangChain object structures through user-controlled fields like `metadata` via prompt injection.
- Affects: LangChain Python library, multiple versions.

---

## §3. Markdown link exfiltration

**Status:** no single CVE: class-level. Same EchoLeak-family mechanism, using a link click in place of image render.

**Canonical references:**
- Subset of EchoLeak disclosures used links alongside or in place of images.
- Embrace The Red blog has multiple specific PoCs.

---

## §4. HTML / SVG render exfiltration

**Status:** no single CVE: class-level.

**Canonical references:**
- Standard XSS literature (OWASP XSS prevention cheatsheet) applies; LLM-output rendering is just XSS with an unusual source.
- Multiple Embrace The Red posts on SVG `onload` + foreignObject exfil against rendered model output.

**Defense tooling:**
- **DOMPurify** (JavaScript): https://github.com/cure53/DOMPurify
- **bleach** (Python): https://github.com/mozilla/bleach
- **ammonia** (Rust): https://github.com/rust-ammonia/ammonia

---

## §5. Tool-call exfiltration

**Status:** related to MCP tool poisoning, see [`06-tool-agent-refs.md`](06-tool-agent-refs.md) §1.

**Canonical incidents:**
- **Invariant Labs disclosures** (April 2025 forward): multiple instances of model induced via indirect injection to call `web_search`, `http_get`, or similar tools with attacker URLs.

**Academic:**
- **Tool Use Attacks on LLM Agents**: accumulating literature 2024 to 2025.

---

## §6. Function-call argument smuggling

**Status:** sub-class of §5. No single CVE.

**Canonical reference:**
- **OpenAI Function Calling Security Considerations** (in their docs): https://platform.openai.com/docs/guides/function-calling
- Multiple researcher disclosures of free-text-argument exploitation patterns.

---

## §7. Side-channel via output structure

**Status:** research-grade; no documented production incidents.

**Academic:**
- Steganographic output channels in LLM responses: multiple 2024 to 2025 papers exploring information-hiding in generated text.

---

## §8. Streaming partial-output capture

**Status:** no CVE; logging-discipline concern.

**Operational guidance:**
- Don't log full streamed token traces in production
- If transcript export exists, build from final-rendered output only

---

## 2026 disclosure update (Jan:May 2026)

The EchoLeak class continued producing variants throughout Q1 2026. Highlights:

**CVE-2026-21520: Microsoft Copilot Studio indirect prompt injection.**
- CVSS 7.5
- Discovered by **Capsule Security** November 24, 2025; Microsoft confirmed December 5, 2025; patched **January 15, 2026.**
- **Mechanism:** injected payload overrode the agent's original instructions in Capsule's PoC, directing it to query connected SharePoint Lists for customer data and send that data via Outlook to an attacker-controlled email address.
- Notable: even after Microsoft patched, follow-up research demonstrated **the data exfiltrated anyway** via alternate channels: VentureBeat coverage: https://venturebeat.com/security/microsoft-salesforce-copilot-agentforce-prompt-injection-cve-agent-remediation-playbook

**CVE-2026-26144: Excel + Copilot Agent zero-click exfiltration.**
- Cross-site scripting flaw in Excel chained to Copilot Agent enables **silent, clickless** exfiltration of spreadsheet data to attacker-controlled endpoints.
- Microsoft patch in standard cycle.
- Reference: https://system.plus/2026/03/12/zero-click-microsoft-copilot-bug-cve-2026-26144/ ; TechRadar coverage: https://www.techradar.com/pro/security/this-fascinating-microsoft-excel-security-flaw-teams-up-spreadsheets-and-copilot-agent-to-steal-data

**CVE-2026-24299: "Copirate 365" (Microsoft Copilot, DEF CON disclosure).**
- Documented by Johann Rehberger (Embrace The Red) and presented at DEF CON.
- Continues the EchoLeak family: indirect injection → exfiltration via rendered output.
- Reference: https://embracethered.com/blog/posts/2026/defcon-talk-copirate-365/

**Pattern observations from Q1 2026:**
- **Disclosure-to-patch windows have shortened** (CVE-2026-21520 was patched within ~7 weeks of report) but **patches are increasingly bypassed** by follow-up research: the EchoLeak family demonstrates that input-side defenses alone repeatedly fail.
- **The output-side filter pattern documented in [`../04-output-exfiltration.md`](../04-output-exfiltration.md) §1 is the more durable defense**: every 2026 CVE in this category eventually came down to "output rendering caused the leak," not "input filtering failed."

---

## Sources and OWASP framing

- [OWASP LLM Top 10: LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [EchoLeak academic writeup: arxiv 2509.10540](https://arxiv.org/abs/2509.10540)
- [Microsoft Security Response Center: CVE-2025-32711](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711)
- [The Hacker News: EchoLeak coverage](https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html)
- [Embrace The Red: exfiltration catalog](https://embracethered.com/blog/)
- [DOMPurify](https://github.com/cure53/DOMPurify)
- [VentureBeat: Copilot Studio CVE-2026-21520 patch-bypass coverage](https://venturebeat.com/security/microsoft-salesforce-copilot-agentforce-prompt-injection-cve-agent-remediation-playbook)
- [Embrace The Red: Copirate 365 / CVE-2026-24299](https://embracethered.com/blog/posts/2026/defcon-talk-copirate-365/)
- [System.plus: CVE-2026-26144 zero-click Copilot bug](https://system.plus/2026/03/12/zero-click-microsoft-copilot-bug-cve-2026-26144/)
