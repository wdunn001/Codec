# 03 — Indirect Prompt Injection: Public Disclosure References

Companion to [`../03-indirect-injection.md`](../03-indirect-injection.md).

## §0. Foundational academic reference (covers entire category)

**Greshake, Abdelnabi, Mishra, Endres, Holz, Fritz — "Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection."**

- arXiv: https://arxiv.org/abs/2302.12173
- Published: February 23, 2023 (revised May 5, 2023)
- Venue: Proceedings of the 16th ACM Workshop on Artificial Intelligence and Security (AISec '23), ACM DOI 10.1145/3605764.3623985
- Black Hat USA 2023 talk: https://i.blackhat.com/BH-US-23/Presentations/US-23-Greshake-Not-what-youve-signed-up-for-whitepaper.pdf
- Project page: https://kai-greshake.de/projects/

This is the **canonical academic introduction** to the entire indirect-injection class. Demonstrated working exploits against Bing Chat (then GPT-4-powered), GPT-4 code completion, and synthetic agents. Coined the formal taxonomy: data theft, worming, information ecosystem contamination.

**Authors' companion PoC repo:** https://github.com/greshake/llm-security

---

## §1. PDF prompt injection

**Status:** no single CVE — repeated demonstrations against multiple PDF-ingesting products.

**Catalog of demonstrations:**
- **Johann Rehberger / Embrace The Red** has 20+ posts cataloguing PDF-based injection against ChatGPT plugins, Bing Chat, Copilot, custom GPTs. See https://embracethered.com/blog/ (filter for "PDF").
- **Simon Willison's blog** has multiple posts on PDF-via-RAG injection patterns: https://simonwillison.net/tags/prompt-injection/

**Specific high-profile incidents:**
- Multiple Aim Security disclosures against M365 Copilot (2024–2025) used PDF or Office-document ingestion as the entry point; see EchoLeak (CVE-2025-32711) under [`04-output-exfiltration-refs.md`](04-output-exfiltration-refs.md) §1.

**Tools and PoC:**
- https://github.com/Lakera-AI/Lakera-Gandalf — interactive challenge testing many of these patterns
- https://github.com/protectai/llm-guard — production sanitization

---

## §2. HTML hidden-element injection

**Status:** no single CVE; well-known via blog disclosures.

**Canonical references:**
- **Kai Greshake's Bing Chat demonstrations (2023)** — embedded prompt-injection in HTML pages Bing summarized. https://kai-greshake.de/posts/inject-my-pdf/ (PDF-focused but covers HTML in same project)
- **Joseph Thacker, multiple Embrace The Red posts** — `aria-hidden`, `<meta>`, `display:none` channels.

**Defense literature:**
- **Mozilla Readability** — https://github.com/mozilla/readability — reader-mode extractor; standard recommendation for "extract just the body content" use cases.

---

## §3. Image OCR / multimodal injection

**Bagdasaryan, Hsieh, Nassi, Shmatikov — "Abusing Images and Sounds for Indirect Instruction Injection in Multi-Modal LLMs."**
- arXiv: https://arxiv.org/abs/2307.10490 (July 2023)

**Bailey, Ong, Russell, Emmons — "Image Hijacks: Adversarial Images can Control Generative Models at Runtime."**
- arXiv: https://arxiv.org/abs/2309.00236 (September 2023; revised 2024)

**Carlini et al. — adversarial perturbation lineage:**
- "Audio Adversarial Examples: Targeted Attacks on Speech-to-Text" — IEEE S&P 2018. Predates LLMs but the methodology transferred directly.

**Tools and PoC:**
- https://github.com/euanong/image-hijacks — Bailey et al. PoC repo

---

## §4. QR codes and barcodes

**Status:** no CVE — class-level concern, multiple demonstrations.

**Canonical references:**
- **Johann Rehberger, Embrace The Red** — multiple posts on QR-as-injection vector against multimodal models.
- General multi-modal injection literature (Bagdasaryan et al. above) covers the same class.

---

## §5. Audio transcript injection

Same papers as §3 (Bagdasaryan et al.). The "audio" half of "Abusing Images and Sounds."

**Industry guidance:**
- OpenAI Whisper documentation discusses transcript handling; standard recommendation: treat as untrusted input.

---

## §6. Email header injection

**Status:** no LLM-specific CVE; covered as a sub-class of general email injection.

**Real-world manifestations:**
- **EchoLeak (CVE-2025-32711)** in Microsoft 365 Copilot used email headers as part of the ingestion path. See [`04-output-exfiltration-refs.md`](04-output-exfiltration-refs.md) §1.

**Older email-injection class CVEs (transferable methodology):**
- **CVE-2017-7480** (PHP `mail()` header injection)
- **CVE-2020-13777** (GnuTLS unrelated but shows email-context attack patterns)

---

## §7. Filename injection

**Status:** generic class — predates LLMs, applies anywhere a filename ends up in a prompt context.

**Canonical references:**
- Classic CTF and pentest literature; multiple `argv[0]` and shell-injection CVEs from the 2000s document the class.
- LLM-specific: covered as a footnote in most prompt-injection tutorials.

---

## §8. EXIF metadata injection

**Status:** generic class.

**Canonical reference:**
- **EXIF as malicious-content vector** — predates LLMs (steganography, polyglot files). LLM application is new: any pipeline that surfaces "Camera: ..., Comment: ..." in a prompt context is exposed.

**Tools:**
- `exiftool` — read/write/sanitize EXIF; standard defense

---

## §9. Office document revision history / hidden content

**Status:** repeatedly observed in M365 Copilot incidents.

**Specific reference:**
- **EchoLeak (CVE-2025-32711)** — the most severe documented incident in this category. Used Office documents (Word, PowerPoint) as the injection-content carrier.
- Aim Security's technical writeup: https://www.aim.security/lp/aim-labs-echoleak-blogpost (link pattern; actual URL may vary)

---

## Sources

- [Greshake et al. arxiv 2302.12173](https://arxiv.org/abs/2302.12173)
- [Black Hat USA 2023 whitepaper](https://i.blackhat.com/BH-US-23/Presentations/US-23-Greshake-Not-what-youve-signed-up-for-whitepaper.pdf)
- [Embrace The Red blog](https://embracethered.com/blog/)
- [Simon Willison prompt-injection tag](https://simonwillison.net/tags/prompt-injection/)
- [Image Hijacks paper](https://arxiv.org/abs/2309.00236)
- [Abusing Images and Sounds paper](https://arxiv.org/abs/2307.10490)
