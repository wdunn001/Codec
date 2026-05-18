# 02 — Wire/Protocol Attacks: Public Disclosure References

Companion to [`../02-wire-protocol-attacks.md`](../02-wire-protocol-attacks.md).

Most attacks in this category are NOT LLM-specific — they're decades-old wire-protocol attack classes that re-emerge whenever a new transport gets popular. Codec inherits the catalog by virtue of being a wire protocol.

## §1. Downgrade attacks

**Status:** generic protocol-design attack class; many specific CVEs in TLS / SSH / HTTPS history.

**Canonical references:**
- **POODLE — CVE-2014-3566.** TLS downgrade to SSLv3.
- **FREAK — CVE-2015-0204.** RSA export-grade downgrade.
- **Logjam — CVE-2015-4000.** TLS DH downgrade.

**LLM/Codec specific:** the "silent identity-fallthrough on missing compression dep" pattern documented in `feedback_engine_image_dep_verify` memory is the same vulnerability class — a peer can advertise no-compression-support to force a known-weaker mode. No specific CVE has been assigned in the LLM-serving space yet because the protocols are still pre-standardization.

---

## §2. Tokenizer-map handshake poisoning

**Status:** no published CVE — Codec-specific concern, no parallel in established protocols (most LLM serving stacks don't have a tokenizer-map handshake at all).

**Closest analog:**
- **Subresource Integrity (SRI) absence** in supply chains — CDN-served scripts substituted post-deployment. Not a CVE; a known class.
- **Module supply-chain attacks** (npm/PyPI typosquatting) — CVE numbering varies per incident.

**LLM-application angle:** the threat model is **supply-chain substitution of trusted-data artifacts**. The right reference frame is signed-package distribution (sigstore, npm provenance, PyPI attestations) — apply those patterns to tokenizer-map distribution.

---

## §3. Compression bombs

**Canonical references:**
- **zip bombs** — generic class, decades old. CVE assignments rare because the bug is "application doesn't bound decompression."
- **gzip-bomb defenses in HTTP servers** — multiple CVEs against early implementations:
  - CVE-2018-6789 (Exim base64 decode without bound)
  - CVE-2019-3463 / 3464 (rssh/scponly compression bomb)
  - CVE-2020-13935 (Tomcat WebSocket DoS with zip-bomb shape)

**LLM-relevant brotli/zstd:**
- General-purpose decompression-bomb risk against any unbounded brotli/zstd consumer.
- No public LLM-specific CVE yet; the failure mode is well-understood.

**Tools and PoC:**
- https://github.com/iamtraction/ZOD — modern zip bomb generator (educational/defense use)
- https://bomb.codes — example bomb files for testing

---

## §4. Compression oracle attacks

**CVE-2012-4929 — CRIME.** TLS compression oracle. Duong & Rizzo, 2012.
- Forced disabling of TLS compression as the only known mitigation.

**BREACH attack — 2013.** Gluck, Harris, Prado, presented at Black Hat USA 2013.
- No single CVE — applies to any application doing HTTP compression with attacker-influenced plaintext and a secret in the same response.
- Mitigation guidance: separate trust zones, randomize per-request, length padding.

**Specific BREACH-derived CVE:**
- **CVE-2016-10708** — OpenSSH SSH compression-related (looser BREACH-class).

**LLM-application angle:** if Codec compresses across tenant boundaries, the same oracle re-emerges at the Codec layer. Defense: per-tenant compression contexts (per [`../02-wire-protocol-attacks.md`](../02-wire-protocol-attacks.md) §4).

---

## §5. Length confusion in framed fields

**Canonical references — HTTP/2 framing CVEs:**
- **CVE-2019-9512 ("Ping Flood")** — HTTP/2.
- **CVE-2019-9514 ("Reset Flood")** — HTTP/2.
- **CVE-2019-9515 ("Settings Flood")** — HTTP/2.
- **CVE-2023-44487 ("HTTP/2 Rapid Reset")** — DDoS via stream reset abuse. Major incident, exploited at scale.

**HTTP request smuggling family:**
- **CVE-2019-18277** (HAProxy)
- **CVE-2020-12440** (Nginx)
- Many more — the request-smuggling catalog is large.

**Tools:**
- https://github.com/PortSwigger/http-request-smuggler — classic Burp tool
- https://github.com/anshumanbh/git-all-secrets — adjacent

**LLM-application angle:** Codec uses length-prefixed framing per `spec/PROTOCOL.md`. Reference parsers MUST reject on mismatch rather than truncate-and-continue.

---

## §6. Cross-tenant ID/routing leakage

**Status:** not a single CVE — recurring application-design flaw class.

**Recent high-profile incidents:**
- Multiple SaaS tenant isolation bugs disclosed 2023–2025 with various CVE assignments. Best catalog: https://github.com/0xRadi/OWASP-Web-Checklist
- **CVE-2023-34362 (MOVEit Transfer)** — tenant boundary exploitation in file-transfer SaaS. Cl0p ransomware campaign.

**LLM-application angle:** if Codec endpoints serve multiple tenants, follow the SaaS tenant-isolation playbook: authenticated principal derived per request, never trust client-supplied tenant identifiers.

---

## §7. Replay attacks

**Status:** generic protocol-design concern; specific CVEs vary by protocol.

**Notable:**
- **CVE-2018-25032** (Kerberos replay — pre-auth)
- **CVE-2023-25690** (Apache mod_proxy request smuggling — replay-adjacent)

**LLM-application angle:** per-request nonce + freshness window + small replay cache. Same pattern as Kerberos/OAuth.

---

## §8. Cache poisoning

**Canonical reference:**
- **Omer Gil, "Web Cache Deception" — Black Hat USA 2017.** Foundational paper.
- **James Kettle (PortSwigger), "Practical Web Cache Poisoning" — 2018.** https://portswigger.net/research/practical-web-cache-poisoning

**Related CVEs:**
- **CVE-2019-9512** (HTTP/2 above) has cache-poisoning variants.
- **CVE-2023-46604** (Apache ActiveMQ) — broader RCE but cache-touching.

**LLM-application angle:** prompt-prefix caching for cost optimization is becoming standard. Cache keys MUST include the trust principal (authenticated user/tenant), not just content hash, or attacker-primed entries leak to legitimate users.

---

## §9. Streaming chunk injection

**Status:** generic class; specific CVEs in SSE/HTTP-2 parsers.

**Recent:**
- **CVE-2021-22945** (curl SSE-related)
- **CVE-2023-26424** (LangSmith SSE — LangChain ecosystem)

**LLM-application angle:** SSE is the dominant streaming format for chat APIs. `data:` lines containing literal `\n\n` (event boundary) from upstream-unsafe sources can fragment events. Per-chunk integrity tag is the cleanest defense.

---

## §10. Side-channel via timing and length

**LLM-specific academic work:**
- **Yang et al., "Prompt Stealing Attacks on Large Language Models" — arxiv 2402.12959 (2024).** Demonstrates extracting prompts via output statistics.
- **Carlini et al., "Extracting Training Data from Large Language Models" — USENIX 2021.** Predates prompt stealing but same family of timing/output leakage.

**Cache-timing oracle work:**
- **CVE-2018-3639 (Spectre v4 / SSB)** — hardware side-channel, but the analysis methodology transfers.
- **PromptCache attacks** documented academically in 2024–2025 but no production CVE yet.

**LLM-application angle:** prompt caching at the model-server side leaks cache-hit-vs-miss timing to clients who can observe TTFT (time to first token). Mitigation: constant-time response framing for security-sensitive deployments, or disable shared prompt caching.

---

## §11. LLM serving-infrastructure CVEs (2026 wave)

While not pure wire-protocol attacks, these LLM-serving-stack CVEs land at the same architectural layer Codec occupies and are worth tracking as adjacent-threat references:

**CVE-2026-42208 — LiteLLM SQL Injection (Critical, CVSS 9.3)**
- Disclosed: April 2026. Patched in `1.83.7-stable` April 19, 2026.
- **First exploitation attempt recorded ~26 hours after the GitHub advisory was indexed** — among the fastest weaponization-to-exploit windows observed in the LLM-infrastructure space.
- CISA added to KEV (Known Exploited Vulnerabilities) catalog amid active exploitation.
- Reference: https://thehackernews.com/2026/04/litellm-cve-2026-42208-sql-injection.html

**CVE-2026-33626 — LMDeploy SSRF**
- Exploited **within 12 hours** of disclosure — even faster than LiteLLM.
- Enabled attackers to use a vision-LLM endpoint for SSRF-based internal-network scanning, cloud-metadata access, and service enumeration.
- Reference: https://webflow.sysdig.com/blog/cve-2026-33626-how-attackers-exploited-lmdeploy-llm-inference-engines-in-12-hours

**Operational lesson:** these 2026 cases set a new bar — disclosure-to-exploit windows are now measured in hours, not days. For Codec releases, the recommended pre-publish security gate (see [`../07-codec-client-checklist.md`](../07-codec-client-checklist.md) crosscutting requirements) must assume a similar weaponization timeline once vulnerabilities are disclosed.

---

## Sources

- [POODLE — CVE-2014-3566](https://nvd.nist.gov/vuln/detail/CVE-2014-3566)
- [HTTP/2 framing CVEs — Netflix advisory](https://github.com/Netflix/security-bulletins/blob/master/advisories/third-party/2019-002.md)
- [HTTP/2 Rapid Reset — CVE-2023-44487](https://nvd.nist.gov/vuln/detail/CVE-2023-44487)
- [PortSwigger HTTP request smuggling research](https://portswigger.net/web-security/request-smuggling)
- [Practical Web Cache Poisoning](https://portswigger.net/research/practical-web-cache-poisoning)
- [Prompt Stealing Attacks on LLMs](https://arxiv.org/abs/2402.12959)
- [LiteLLM CVE-2026-42208 — The Hacker News](https://thehackernews.com/2026/04/litellm-cve-2026-42208-sql-injection.html)
- [LMDeploy CVE-2026-33626 — Sysdig](https://webflow.sysdig.com/blog/cve-2026-33626-how-attackers-exploited-lmdeploy-llm-inference-engines-in-12-hours)
