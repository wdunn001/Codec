# 05 — Multi-Turn / Behavioral Attacks: Public Disclosure References

Companion to [`../05-multi-turn-behavioral.md`](../05-multi-turn-behavioral.md).

Strongly academic category — most attacks were first formalized in research papers, with mitigation work also published. CVE assignments are rare because these are model-behavior issues rather than software flaws.

## §1. Many-shot jailbreaking

**Anil, Durmus, Panickssery, Sharma, et al. — "Many-shot Jailbreaking."**

- **Venue:** NeurIPS 2024 (Thirty-eighth Annual Conference on Neural Information Processing Systems)
- **Anthropic research page:** https://www.anthropic.com/research/many-shot-jailbreaking
- **NeurIPS proceedings:** https://proceedings.neurips.cc/paper_files/paper/2024/hash/ea456e232efb72d261715e33ce25f208-Abstract-Conference.html
- **OpenReview:** https://openreview.net/forum?id=cw5mgd71jW
- **Anthropic PDF:** https://www-cdn.anthropic.com/af5633c94ed2beb282f6a53c595eb437e8e7b630/Many_Shot_Jailbreaking__2024_04_02_0936.pdf

**Core finding:** attack effectiveness follows a **power law** up to hundreds of shots. Becomes feasible with the long-context windows (200K+) deployed by Anthropic, Google, OpenAI.

**Tested models:** demonstrated against all major frontier closed-weight models across various harmful-task categories.

**Authors:** Cem Anil, Esin Durmus, Nina Panickssery, Mrinank Sharma, Joe Benton, Sandipan Kundu, Joshua Batson, Meg Tong, Jesse Mu, Daniel J Ford, Francesco Mosconi, Rajashree Agrawal, Rylan Schaeffer, Naomi Bashkansky, Samuel Svenningsen, Mike Lambert, Ansh Radhakrishnan, Carson Denison, Evan J Hubinger, Yuntao Bai, Trenton Bricken, Timothy Maxwell, Nicholas Schiefer, James Sully, Alex Tamkin, Tamera Lanham, Karina Nguyen, Tomasz Korbak, Jared Kaplan, Deep Ganguli, Samuel R. Bowman, Ethan Perez, Roger Baker Grosse, David Duvenaud.

**Mitigation literature:**
- **"Mitigating Many-Shot Jailbreaking"** — arxiv 2504.09604 (2025)
- **"Constitutional Classifiers: Defending against Universal Jailbreaks"** — arxiv 2501.18837 (Anthropic, 2025)

---

## §2. Crescendo attack

**Russinovich, Salem, Eldan — "Great, Now Write an Article About That: The Crescendo Multi-Turn LLM Jailbreak Attack."**

- **Venue:** 34th USENIX Security Symposium (USENIX Security '25, Seattle)
- **arXiv:** https://arxiv.org/abs/2404.01833 (April 2024, revised through February 2025)
- **USENIX paper:** https://www.usenix.org/conference/usenixsecurity25/presentation/russinovich
- **Microsoft blog:** https://www.microsoft.com/en-us/security/blog/2024/04/11/how-microsoft-discovers-and-mitigates-evolving-attacks-against-ai-guardrails/

**Core finding:** gradual escalation across turns achieves jailbreak goals in fewer than 10 interactions, bypassing per-turn safety classifiers.

**Tested models:** LLaMA-2 70b, LLaMA-3 70b, Gemini-Pro, Claude-2, Claude-3, GPT-3.5 Turbo, GPT-4. **Effective against all evaluated models** across the majority of tested harmful-task categories. Also demonstrated against multimodal models.

**Authors:** Mark Russinovich (Microsoft Azure CTO), Ahmed Salem, Ronen Eldan.

**Defense literature:**
- **Microsoft "Crescendomation"** — automated red-teaming tool building on the technique.
- Trajectory-aware safety classifiers (multiple vendors' internal work, less publicly published).

---

## §3. Role confusion / fake system message

**Status:** no formal academic paper as the canonical reference; well-documented in operational guidance.

**Canonical references:**
- **OpenAI's API documentation** explicitly warns against passing user-influenced content into the `system` role.
- **Anthropic's prompt engineering guide** documents the same class of mistake.
- Multiple **Embrace The Red** blog posts catalog specific instances.

---

## §4. Context-window overflow / system-prompt eviction

**Status:** operational concern; no single CVE.

**Canonical references:**
- General context-management literature; most LLM SDKs (LangChain, LlamaIndex) document the truncation-vs-summarization tradeoff.
- No specific exploit paper — known failure mode but not formally weaponized in published research.

---

## §5. Prefilling attacks

**Status:** Claude-specific API feature; no formal CVE; vendor-documented.

**Canonical reference:**
- **Anthropic API documentation** on the `assistant_prefill` parameter — includes warnings about its safety implications.
- Multiple researcher demonstrations on social media and blogs.
- General research thread: "Pre-filling Assistant Responses" — discussed in jailbreak-research community 2024–2025.

---

## §6. Multi-turn safety drift

**Status:** an outcome of §1 and §2; same references.

---

## §7. Prompt extraction

**Status:** large body of research, no single canonical CVE.

**Key academic works:**
- **Perez, Ribeiro, et al. — "Red Teaming Language Models with Language Models"** — arxiv 2202.03286 (2022). Foundational for automated extraction.
- **Zhang et al. — "Prompt Stealing Attacks on LLMs"** — arxiv 2402.12959 (2024). Statistical / side-channel extraction.
- **"Effective Prompt Extraction from Language Models"** — arxiv 2307.06865 (2023).

**Operational guidance:**
- **OWASP LLM01:2025 Prompt Injection** has a section on prompt-extraction defense: https://genai.owasp.org/llmrisk/llm01-prompt-injection/

**Mitigation:**
- Don't put secrets in system prompts. Use tool-call retrieval for sensitive runtime values.
- Train/instruct the model to refuse meta-questions about its instructions (imperfect; reduces rate but doesn't eliminate).

---

## Tooling for this category

**Red-team / fuzz tools:**
- **garak (NVIDIA)** — https://github.com/leondz/garak — LLM vulnerability scanner; includes many-shot and crescendo modules
- **PyRIT (Microsoft)** — https://github.com/Azure/PyRIT — multi-turn red-teaming framework
- **promptfoo** — https://github.com/promptfoo/promptfoo — eval framework; includes prompt-injection test sets
- **Lakera Gandalf** — https://gandalf.lakera.ai — interactive prompt-injection challenges

---

## Sources

- [Anthropic many-shot jailbreaking research page](https://www.anthropic.com/research/many-shot-jailbreaking)
- [Many-shot Jailbreaking — NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/hash/ea456e232efb72d261715e33ce25f208-Abstract-Conference.html)
- [Crescendo — arXiv 2404.01833](https://arxiv.org/abs/2404.01833)
- [Microsoft Security Blog on Crescendo](https://www.microsoft.com/en-us/security/blog/2024/04/11/how-microsoft-discovers-and-mitigates-evolving-attacks-against-ai-guardrails/)
- [Constitutional Classifiers — arXiv 2501.18837](https://arxiv.org/abs/2501.18837)
- [garak LLM vulnerability scanner](https://github.com/leondz/garak)
- [Microsoft PyRIT](https://github.com/Azure/PyRIT)
