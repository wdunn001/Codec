# 01 — Unicode Smuggling: Public Disclosure References

Companion to [`../01-unicode-smuggling.md`](../01-unicode-smuggling.md).

## §1. Unicode Tag block (U+E0000–U+E007F)

**Status:** no specific CVE — vulnerability class, not product flaw.

**Discovery / canonical demonstration:**
- **Riley Goodside, January 2024** — first public demonstration that GPT-4 tokenizers consume tag-block characters as instructions. Posted on X (formerly Twitter) and amplified across the LLM security community.
- **Joseph Thacker, "ASCII Smuggler"** — analysis and PoC tooling on https://embracethered.com/ (Embrace The Red blog). Catalog of tag-block-affected products.

**Tools and PoC:**
- https://embracethered.com/blog/ascii-smuggler.html — interactive tag-block encoder/decoder
- https://github.com/protectai/llm-guard — production sanitization library that strips this range

**Vendor responses:**
- OpenAI, Anthropic, and Google have all silently added tag-block stripping at API ingestion for their flagship models over 2024–2025. Detection coverage at platform-rendering surfaces (X, LinkedIn, GitHub) is inconsistent.

**Threat model significance:** highest-severity smuggling vector because it's 100% invisible to humans (most fonts have no glyphs for the range) but tokenized as distinct tokens by most BPE tokenizers.

---

## §2. Zero-width characters (U+200B / 200C / 200D / 2060 / FEFF)

**Status:** no specific CVE — generic technique with decades of prior art in spam/phishing.

**Canonical references:**
- IDN homograph and zero-width tricks predate LLMs; documented in spam filter literature back to early 2000s.
- LLM-specific application: Simon Willison's blog (https://simonwillison.net) has multiple posts (2023–2026) documenting use against ChatGPT and Claude.
- Used in the May 2026 tmuxvim viral LinkedIn-bio injection ("Old English recruiter spam").

**Tools and PoC:**
- https://github.com/cosgo7/zero-width-detector — detection
- https://330k.github.io/misc_tools/unicode_steganography.html — encode/decode

**Threat model significance:** primarily a **filter-evasion** vector rather than a smuggling vector — most tokenizers handle these inconsistently, so the smuggled payload often fragments. The value to attackers is defeating naive substring/regex match in security policies.

---

## §3. Variation selectors (U+FE00–FE0F, U+E0100–E01EF)

**Status:** no specific CVE.

**Canonical demonstration:**
- **Paul Butler, "Smuggling arbitrary data through an emoji" (2025)** — https://paulbutler.org/2025/smuggling-arbitrary-data-through-an-emoji/ — demonstrated encoding arbitrary payload data in variation-selector sequences attached to a carrier emoji. Up to ~256 bits per carrier.
- Analyzed by Anthropic and added to Claude content filters mid-2025 per public release notes.

**Tools and PoC:**
- Paul Butler's blog post includes an interactive encoder/decoder demo.

**Threat model significance:** carrier-emoji variation-selector chains are a high-capacity covert channel. Single VS characters are legitimate (emoji presentation, CJK font variants), so blanket strip is hostile. Defense pattern: strip *runs* of length ≥ 2 (per [`../01-unicode-smuggling.md`](../01-unicode-smuggling.md) §3).

---

## §4. Right-to-left override and bidirectional controls (U+202A–U+202F, U+2066–U+2069)

**CVE-2021-42574 — "Trojan Source"** — Boucher & Anderson, University of Cambridge, late 2021.
- arXiv: https://arxiv.org/abs/2111.00169
- Affects compilers for C, C++, C#, JavaScript, Java, Rust, Go, Python.
- GitHub added bidi-character warnings to its file-rendering UI in response.

**CVE-2021-42694** — homoglyph identifier variant of the same disclosure; covers source-code identifier confusables.

**Vendor responses:**
- Red Hat security advisory **RHSB-2021-007** covers both CVEs.
- Atlassian: separate advisory documenting Confluence/Jira impact.
- GitHub: UI warning shipped 2021-11.

**Tools and PoC:**
- https://github.com/nickboucher/trojan-source — original PoC repo from the Cambridge authors (multiple language variants)
- https://trojansource.codes — paper companion site

**LLM-application angle:** bidi controls land in model contexts via ingested documents/web pages and can flip displayed intent vs. parsed intent. Less common than the source-code case but documented; sanitization is the same.

---

## §5. Cross-script confusables (Cyrillic / Greek / Mathematical-bold / Fullwidth Latin)

**Status:** no single CVE — vulnerability class with decades of prior art in IDN homograph attacks.

**Canonical reference:**
- **Unicode Consortium UTR #36 (Unicode Security Considerations)** — https://www.unicode.org/reports/tr36/ — the authoritative document on confusables.
- **Unicode Confusables Table** — https://www.unicode.org/Public/security/latest/confusables.txt — full mapping.

**Related CVE class:**
- IDN spoofing CVEs in browsers (multiple): CVE-2017-5383 (Firefox), CVE-2018-6168 (Chrome), and many more historical cases.

**Tools and PoC:**
- https://github.com/woodgern/confusables — JS confusables-fold library
- https://pypi.org/project/confusable-homoglyphs/ — Python equivalent
- https://github.com/c-h-/eshrhomoglyphs — research-grade detector

**LLM-application angle:** primarily defeats keyword-based content filters (a regex looking for `admin` won't match `аdmin` with Cyrillic а). NFKC handles compatibility-class confusables (mathematical-bold, fullwidth) but NOT cross-script. The Codec reference implementation includes a minimal Latin-lookalike fold for common Cyrillic/Greek; production should layer in the full confusables table.

---

## §6. Mathematical alphanumerics, fullwidth Latin, enclosed alphanumerics

**Status:** no specific CVE — handled by NFKC normalization.

**Canonical reference:**
- **Unicode Standard Annex #15 (Unicode Normalization Forms)** — https://www.unicode.org/reports/tr15/ — defines NFKC.
- Same UTR #36 listed in §5 covers the security implications.

**LLM-application angle:** unlike cross-script confusables, these ranges have *compatibility decompositions* — `𝐓` (U+1D413) decomposes via NFKC to `T`. Standard practice is normalize-for-policy via NFKC before any matching; the policy check then sees ASCII.

---

## §7. Glitch tokens

**Status:** no formal CVE class; per-model documentation.

**Canonical reference:**
- **Rumbelow & Watkins, "SolidGoldMagikarp (plus, prompt generation)" — LessWrong, February 2023.** https://www.lesswrong.com/posts/aPeJE8bSo6rAFoLqg/solidgoldmagikarp-plus-prompt-generation — identified ~140 GPT-3 tokens that elicit malformed/hallucinated output.
- Subsequent academic study: Land & Bartolo, "Fishing for Magikarp: Automatically Detecting Under-trained Tokens in Large Language Models" — arxiv 2405.05417 (2024).

**Tools and PoC:**
- https://github.com/cohere-ai/sandbox-toy-glitch-tokens — illustrative catalog (older GPT models)
- https://github.com/google-deepmind/synthid-text — adjacent tooling for output watermarking; not glitch-token specific but same space

**LLM-application angle:** model-specific. Per-model glitch-token lists belong in tokenizer-map metadata (see [`../02-wire-protocol-attacks.md`](../02-wire-protocol-attacks.md) §2), not in core Codec encoding logic. New frontier models have been more carefully trained and have fewer glitch tokens; older / specialized models still have catalogued issues.
