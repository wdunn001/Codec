# v0.6 Codec Client Security Checklist

**Status:** action items: v0.6 security workstream. The prioritized list of what to actually do, distilled from the threat-model docs in this bundle.

## How to use this document

This is the operational counterpart to the threat-model docs ([01](01-unicode-smuggling.md) to [06](06-tool-agent-attacks.md)). Each item:
- Has a priority (P0 = ship-blocking for v0.6, P1 = strongly recommended for v0.6, P2 = nice-to-have / v0.7 candidate).
- Has a rationale (which threat-model doc motivates it).
- Has an implementation sketch (where in the codebase, what shape).
- Has a verification step (how to test it landed).

Ordering reflects recommended implementation sequence: items earlier in the list are foundations that later items depend on.

---

## P0: Ship-blocking for v0.6

### 1. Special-token stripping at the protocol boundary

**Why:** Section §1 in the boundary breaks of every smuggling-class injection. Without this, ChatML / Llama 3 / Mistral / Gemma special tokens in user content turn into actual control tokens in vulnerable serving stacks.

**Where:** `packages/codec-core/src/sanitize.{ts,py,rs}`: new module. Called from the encoder before tokenization, called from the decoder before re-rendering.

**Shape:**
```python
SPECIAL_TOKEN_PATTERNS = [
    "<|im_start|>", "<|im_end|>", "<|im_sep|>",
    "<|eot_id|>", "<|begin_of_text|>",
    "<|start_header_id|>", "<|end_header_id|>",
    "<s>", "</s>", "[INST]", "[/INST]",
    "<start_of_turn>", "<end_of_turn>",
    "<｜begin▁of▁sentence｜>", "<｜end▁of▁sentence｜>",
    "<|endoftext|>",
]

def strip_chat_template_tokens(s: str) -> tuple[str, int]:
    count = 0
    for pat in SPECIAL_TOKEN_PATTERNS:
        new = s.replace(pat, "")
        count += (len(s) - len(new)) // len(pat)
        s = new
    return s, count
```

**Verify:** `packages/codec-core/tests/sanitize.test.{ts,py,rs}`: feed each known special-token pattern, verify stripped. Add fuzz target for partial-match variants.

### 2. Invisible-Unicode filter

**Why:** [01-unicode-smuggling.md](01-unicode-smuggling.md) §1 to §4. Tag block, zero-width, variation selector runs, BiDi controls. Strip at the boundary.

**Where:** Same module as #1.

**Shape:** See code examples in [01-unicode-smuggling.md](01-unicode-smuggling.md).

**Verify:** Unit tests on a corpus of smuggling payloads. Also: integration test that a tag-block-encoded prompt fed into the Codec client produces clean output AND increments the smuggling-counter telemetry.

### 3. NFKC normalize before policy checks; ship NFC to model

**Why:** [01-unicode-smuggling.md](01-unicode-smuggling.md) §5 to §6. Defeats confusables for keyword matching without lossy normalization in the wire payload.

**Where:** `packages/codec-core/src/policy.{ts,py,rs}`: new helper invoked by policy code.

**Shape:**
```python
def normalize_for_policy(s: str) -> str:
    return unicodedata.normalize('NFKC', s).casefold()

def normalize_for_wire(s: str) -> str:
    return unicodedata.normalize('NFC', s)
```

**Verify:** Cyrillic-confusable banned-word corpus passes the policy check after normalization; same input ships to model unchanged.

### 4. Ban f-string JSON construction in client code

**Why:** [04-output-exfiltration.md](04-output-exfiltration.md) §1 and the JSON role-injection class. Lint rule that flags any `f"..."` containing JSON-shaped braces with embedded `{var}`. Use `json.dumps()` exclusively.

**Where:** ESLint rule + Python flake8 plugin + Rust clippy lint in `packages/codec-core/lint/`.

**Shape:** Custom rule detecting `f-string` or `format()` patterns assembling JSON. Whitelist exceptions for non-user-content cases.

**Verify:** Lint must pass on entire `packages/` tree as part of CI. Add a regression test that confirms the lint fires on a deliberately-bad pattern.

### 5. Decompression budget enforcement

**Why:** [02-wire-protocol-attacks.md](02-wire-protocol-attacks.md) §3. brotli/zstd/dict-zstd bombs.

**Where:** `packages/codec-core/src/decode.{ts,py,rs}`: wrap decompression call with budget.

**Shape:** Streaming decompression with per-chunk size check. Hard cap at 16 MiB (chat tier) / configurable upward (batch tier). Reject (don't truncate) on excess.

**Verify:** Test corpus of decompression bombs. Each must reject within budget AND the rejection must be logged.

### 6. Loud alerting on identity-fallthrough

**Why:** [02-wire-protocol-attacks.md](02-wire-protocol-attacks.md) §1 and existing memory `feedback_engine_image_dep_verify`. Silent fallback is the worst Codec failure mode.

**Where:** `packages/codec-core/src/negotiate.{ts,py,rs}`: counter increment + loud warning on every identity-fallthrough. Default-deny in production tier; explicit opt-in for development.

**Shape:**
```python
def negotiate_compression(client_caps, server_caps) -> str:
    chosen = pick_best(client_caps, server_caps)
    if chosen == "identity":
        metrics.increment("codec_identity_fallthrough_total")
        if config.tier == "production":
            raise CodecNegotiationFailure(
                "no compression algorithm in common; refusing fallthrough")
        log.warning("identity fallthrough: production should never see this")
    return chosen
```

**Verify:** Integration test: production-tier client offered only "identity" by a malicious server, MUST raise. Development-tier client may allow but MUST warn.

---

## P1: Strongly recommended for v0.6

### 7. Output filter pipeline for rendered content

**Why:** [04-output-exfiltration.md](04-output-exfiltration.md): the highest-severity class. Markdown image / link allowlist, HTML/SVG sanitizer pass.

**Where:** New module `packages/codec-client-render/src/filter.{ts,py,rs}`. Pipeline: markdown parse → URL extract → domain allowlist check → HTML sanitize → render.

**Shape:** See code example in [04-output-exfiltration.md](04-output-exfiltration.md). Default allowlist is empty (security-first); applications configure.

**Verify:** Test corpus from `packages/bench/fixtures/output-exfiltration/`. Each adversarial output must be filtered; each benign equivalent must pass.

### 8. Untrusted-content tagging in prompt assembly

**Why:** [03-indirect-injection.md](03-indirect-injection.md). Every byte ingested from external sources (documents, web, tool results) wrapped in `<untrusted_content>` tags with origin metadata. System prompt instructs differential trust.

**Where:** `packages/codec-client-render/src/prompt-build.{ts,py,rs}`. Anywhere ingested content concatenates into a prompt, must go through `wrap_untrusted()`.

**Shape:**
```python
def wrap_untrusted(content: str, origin: str, mime: str, sha256: str) -> str:
    return f"<untrusted_content origin={json.dumps(origin)} mime={json.dumps(mime)} sha256={json.dumps(sha256)}>\n{content}\n</untrusted_content>"
```

**Verify:** Integration test: external content ingested via standard path, prompt contains the wrapped form, model under test does not comply with adversarial instructions inside the wrap.

### 9. Tokenizer-map signing and pinning

**Why:** [02-wire-protocol-attacks.md](02-wire-protocol-attacks.md) §2. Tokenizer-map handshake is currently unauthenticated.

**Where:** `packages/codec-core/src/tokenizer-map.{ts,py,rs}`: new signature scheme. Detached signatures (Ed25519 recommended). Sign-verify at handshake time. Pin known-good hashes in client config.

**Shape:** Define a v0.6 addendum to `spec/PROTOCOL.md` § tokenizer-map handshake: signature field, signer identity, hash algorithm.

**Verify:** Test corpus of valid and tampered tokenizer maps. Tampered maps must reject; valid maps must pass; a configuration error (missing public key) must produce a clear error.

### 10. Per-tenant compression contexts

**Why:** [02-wire-protocol-attacks.md](02-wire-protocol-attacks.md) §4. BREACH-class oracle defense.

**Where:** `packages/codec-core/src/compress.{ts,py,rs}`: per-session compression state, no shared state across tenants/users. Dictionary management isolates per-session.

**Verify:** Integration test that demonstrates two tenants' compressed payloads do not share dictionary state. Optional: BREACH-style test demonstrating cross-tenant inference is not feasible.

### 11. Tool-result trust tagging (if MCP ships in v0.6)

**Why:** [06-tool-agent-attacks.md](06-tool-agent-attacks.md) §2. Tool results are tier-2 untrusted content.

**Where:** `packages/codec-mcp/`: if v0.6 ships MCP. Tag tool results with `<tool_result origin="...server.tool" trust_tier="external">` at injection time.

**Verify:** Integration test with an MCP server returning prompt-injection payloads; client wrapping prevents model compliance.

### 12. Cache-key tenant scoping

**Why:** [02-wire-protocol-attacks.md](02-wire-protocol-attacks.md) §8 and [06-tool-agent-attacks.md](06-tool-agent-attacks.md) §7. Cache poisoning across tenants.

**Where:** wherever caching exists: currently in `packages/codec-core/src/cache.{ts,py,rs}` (if it exists) plus any application-layer caches.

**Shape:** Cache keys MUST include the authenticated tenant principal. Hash of content alone is insufficient.

**Verify:** Test that two tenants posting the same content get distinct cache keys; primed entry by tenant A does not return on tenant B's request.

---

## P2: Nice-to-have / v0.7 candidate

### 13. Streaming chunk integrity tags

**Why:** [02-wire-protocol-attacks.md](02-wire-protocol-attacks.md) §9. MITM chunk injection.

**Where:** `packages/codec-core/src/stream.{ts,py,rs}`. Per-chunk HMAC or AEAD.

**Verify:** Bench overhead acceptable (< 5%); injection corpus rejects.

### 14. Length / timing padding for security-sensitive responses

**Why:** [02-wire-protocol-attacks.md](02-wire-protocol-attacks.md) §10. Side-channel via response size or first-token time.

**Where:** Optional response-mode flag in `spec/PROTOCOL.md` v0.6. Bucketed response sizes; randomized first-token delay (quantized to coarse buckets).

### 15. Provenance chain tracking

**Why:** [06-tool-agent-attacks.md](06-tool-agent-attacks.md) §6. Cross-tool exfiltration chains.

**Where:** Application-layer audit log. Codec wire carries `triggering_message_id` field; application logs chain.

### 16. Per-request nonce + replay cache

**Why:** [02-wire-protocol-attacks.md](02-wire-protocol-attacks.md) §7. Replay attacks.

**Where:** `packages/codec-core/src/replay-cache.{ts,py,rs}`. Sliding window of recently-seen nonces.

### 17. Glitch-token blocklist

**Why:** [01-unicode-smuggling.md](01-unicode-smuggling.md) §7. Per-model glitch tokens.

**Where:** Per-model metadata in tokenizer-map; policy hook in encoder.

### 18. Supervisor-pass support

**Why:** [05-multi-turn-behavioral.md](05-multi-turn-behavioral.md). Trajectory-aware safety.

**Where:** New request type `supervisor_eval` in `spec/PROTOCOL.md` v0.7 candidate. Reference implementation in `packages/codec-supervisor/`.

---

## Crosscutting requirements

These apply to every P0/P1 item above:

1. **Telemetry on every defense layer.** A counter per rejection class (smuggling stripped, decompression bomb rejected, identity fallthrough triggered, output filter rejected). Alert thresholds documented.
2. **Loud failures over silent ones.** Every rejection produces a structured error to the application; no defense layer silently sanitizes without surfacing.
3. **Configurable strictness.** Production tier defaults to strict; development tier may relax with explicit opt-in flags.
4. **Test corpus committed to repo.** `packages/bench/fixtures/{smuggling,wire-attacks,indirect-injection,output-exfiltration,multi-turn,agent-attacks}/`: each item above has corresponding fixtures.
5. **Bench coverage gate.** Extend the existing release-checklist `§3.5` (bench surface coverage gate) with a `§7: security coverage gate` that requires every P0 item have passing fixture tests before any release.

## Sequencing for the v0.6 cycle

Suggested implementation order, given the existing release-checklist gating:

1. **Week 1-2:** P0 items #1:#3 (sanitization at the boundary). Lowest-risk, foundation for everything else.
2. **Week 3-4:** P0 #4 (lint rule). Catches existing-codebase issues; will require some code changes.
3. **Week 5-6:** P0 #5:#6 (compression budget, identity-fallthrough alerts). Wire-layer hardening.
4. **Week 7-9:** P1 #7:#8 (output filter, untrusted-content wrapping). The high-severity classes.
5. **Week 10-11:** P1 #9:#10 (tokenizer-map signing, per-tenant compression). Protocol changes; require spec updates.
6. **Week 12:** P1 #11:#12 (if MCP ships in v0.6) + cache-key fix.
7. **P2 items:** v0.7 cycle or as time permits in v0.6.

Each P0 item should be a separate PR for traceability; P1 items can bundle.

## Companion deliverables

For v0.6 release, alongside the code:

- **Threat model summary** in `docs/SECURITY.md` (new file, sibling to existing `LICENSE`, `COMMERCIAL.md`, `RESULTS.md`). Public-facing brief description of what Codec does and does not protect against.
- **CVE-disclosure policy.** Email alias, expected response time, public credit policy.
- **Release-checklist update**: add `§7 security` gate per item #5 in crosscutting.
- **CHANGELOG entry** under `v0.6.0`: Security section enumerating each P0 item shipped.
