# Wire/Protocol-Level Attacks

**Status:** research: v0.6 security workstream. The Codec-specific document in this bundle. Most relevant for client-side and server-side reference implementations.

## TL;DR

Codec is a wire protocol. Wire protocols inherit a decades-old catalog of attacks: downgrade, replay, length confusion, decompression bombs, oracles, cache poisoning, side channels. Several of these are sharpened by Codec's specific design choices:

- The **identity-fallthrough** behavior when a compression codec is unavailable client- or server-side is already-known to be the worst Codec failure mode (per existing project memory: `feedback_engine_image_dep_verify`). It is also a downgrade-attack vector.
- The **tokenizer-map handshake** is an unauthenticated data exchange that becomes a serious supply-chain risk if not addressed in v0.6.
- The **dictionary-zstd compression layer** carries the standard compression-oracle and decompression-bomb risks.
- **Prompt dialects** (sibling v0.6 proposal) introduce a second poisoning surface in the dictionary layer.

## Threat model

- **Attacker capabilities:** can act as either party (malicious client OR malicious server), can MITM (especially over open-wifi / mobile-internet edges), can submit user-controlled text that traverses Codec.
- **Attacker goals:** force degraded protocol behavior, exfiltrate plaintext via side channels, cause DoS, poison shared state (caches, dictionaries, tokenizer maps), pivot from wire-level access to model-level injection.
- **Defender constraint:** must remain performance-competitive (Codec's value proposition is "smaller / faster / cheaper"); cannot pay arbitrary security cost.

## Vectors

### 1. Downgrade attacks

**Mechanism.** Force the negotiated Codec version, compression, or tokenizer-map down to a known-weaker variant. Most acute case: the **identity fallthrough** when a compression dependency is missing. Per `feedback_engine_image_dep_verify`, this is already a known Codec failure mode in which an engine image silently ships without `brotli`/`zstandard`/`msgpack`. The runtime then falls through to identity encoding. An attacker who controls one peer can deliberately advertise "no compression support" to force this fallback.

The downstream consequence is twofold:
- **Wire bloat** (a cost vector that becomes DoS-shaped at scale).
- **Loss of compression-as-validation:** any wire-format check that piggybacks on compression integrity (CRC over compressed bytes, dict-handle verification) is bypassed.

**Defense.**

- **Loud alerting on identity-fallthrough in production.** Currently the per-image dep verify (`docker run --rm IMAGE python3 -c "import brotli, zstandard, msgpack"`) catches this at release time. Add runtime metric: `codec_identity_fallthrough_total` counter, alert on rate > 0 in production tier.
- **Explicit minimum-version pinning** in client config. Codec clients SHOULD support a `min_protocol_version` configuration that refuses to negotiate below a stated floor.
- **Server-side capability assertion:** the server SHOULD include a signed capability statement in its handshake (`{"version": "0.6", "compressions": ["br", "zstd", "dict-zstd"], "signed": "..."}`) so a downgrade attempt is auditable.

### 2. Tokenizer-map handshake poisoning

**Mechanism.** Codec exchanges tokenizer maps between client and server to enable wire-efficient encoding. A malicious server (or a MITM) can ship a tokenizer map whose entries decode to attacker-chosen text: e.g., a map entry that claims `token_id 4242 → "the user's password is"` so that any model output containing token 4242 decodes to an attacker-injected string at the client side.

Inverse direction: a malicious client can ship a tokenizer map whose entries push exotic glitch tokens into the server-side context, degrading model behavior or extracting training data hints.

**Public reference:** general class: supply-chain attacks against signed-data systems. No published Codec-specific PoC because Codec is pre-v1.

**Defense.**

- **Sign tokenizer maps.** v0.6 SHOULD require a detached signature alongside any non-default tokenizer map; clients SHOULD pin to known-good hashes.
- **Independent re-tokenization round-trip:** the receiver can decode a known plaintext through the received map and verify it round-trips to the same plaintext via the receiver's local tokenizer. Discrepancies are evidence of poisoning.
- **Default to "no custom map" in untrusted-server mode:** the protocol should support a strict mode that refuses non-default maps entirely. Useful for hardened client deployments (regulated industries, embedded environments).

### 3. Compression bombs

**Mechanism.** brotli, zstd, and dict-zstd all support compression ratios that, in pathological cases, decode a small ciphertext to gigabytes of plaintext. Unbounded decompression is a classic DoS vector.

**Public reference:** "zip bomb": decades old. Modern variants for brotli/zstd documented in CVEs against various HTTP server implementations.

**Defense.**

- **Hard cap on decompressed-size budget per request.** Codec clients MUST set a budget (default suggested: 16 MiB for chat applications, configurable upward for batch use cases).
- **Stream-decompress with budget enforcement**: don't materialize the full plaintext before checking size. zstd and brotli both support streaming APIs; use them.
- **Reject (don't truncate) on budget exceeded.** A truncated response is worse than a rejected one; the model may receive a partial structure that misleads it.

```python
# Pseudocode for budgeted streaming decode
def decode_with_budget(stream, decoder, budget_bytes: int) -> bytes:
    out = bytearray()
    for chunk in stream:
        out.extend(decoder.decode(chunk))
        if len(out) > budget_bytes:
            raise CodecDecompressionBudgetExceeded(
                f"decoded > {budget_bytes} bytes; aborting")
    return bytes(out)
```

### 4. Compression oracle (BREACH-style)

**Mechanism.** When compression happens before encryption, ciphertext length leaks information about plaintext. Specifically: if an attacker can influence *part* of the plaintext (e.g., their own user-controlled content) and observe the encrypted-and-compressed size, they can iteratively guess other parts of the plaintext (a server-side secret, another user's content sharing the same encryption envelope, etc.).

The TLS-layer mitigation (CRIME, BREACH) is to disable compression at the TLS layer. Codec compresses *above* TLS. That means BREACH-class attacks resurface within Codec's scope.

**Acute Codec case:** if a multi-tenant Codec endpoint shares a single TLS connection across tenants and compresses across tenant boundaries, attacker tenant A can BREACH-attack tenant B's content.

**Defense.**

- **Never compress across trust boundaries.** Each tenant/session gets its own compression context. No shared dictionaries across tenants UNLESS the dictionary is public.
- **Length padding:** Codec MAY support a "constant-length response" mode for security-sensitive applications, padding ciphertext to bucketed sizes (256/1024/4096/16384 bytes) to obscure length deltas.
- **Random-noise padding** in dict-zstd: insert variable-length random no-op tokens at known positions to defeat per-byte length oracles. Cost: ~5-10% wire bloat; benefit: closes BREACH on this layer.

### 5. Length confusion in framed fields

**Mechanism.** Codec uses length-prefixed framing for some message types (per `spec/PROTOCOL.md`). If the declared length mismatches the actual bytes-on-wire, naive parsers can bleed payload into the next frame, allowing an attacker to inject controlled bytes into a downstream message's parsing scope.

**Public reference:** classic protocol parser bug. CVEs against early HTTP/2, AMQP, and binary RPC frameworks.

**Defense.**

- **Strict length validation:** reject on mismatch; never truncate-and-continue. The reference implementation must enforce.
- **Single-pass framing parser**, never re-entrant: harder to confuse.
- **Fuzz the parser:** add `cargo-fuzz` / `python-afl` targets in `packages/codec-core/tests/fuzz/`.

### 6. Cross-tenant ID/routing leakage

**Mechanism.** Multi-tenant Codec endpoints route requests by some combination of session id, tenant id, API key. If routing trusts a header field that's also user-influenceable (or worse, comes from user content), attackers can request another tenant's resources.

**Defense.** Authenticate every tenant boundary. The outer connection alone is not enough. Tenant id derived from the authentication principal, never from a separate request field.

### 7. Replay attacks

**Mechanism.** A captured Codec request, replayed verbatim, can confuse stateful clients/servers. Especially acute for:
- **Idempotency-keyed operations** (replay re-triggers).
- **Tokenizer-map updates** (replay an old map after a key rotation).
- **Streaming reconnections** (replay a chunk to inject the same content twice).

**Defense.** Include a per-request nonce and a freshness window (timestamp + skew tolerance). Servers MAY also implement a small replay-cache (recently-seen nonces). For streaming: per-chunk sequence numbers, monotonic, server-side state tracks last-seen.

### 8. Cache poisoning

**Mechanism.** Codec deployments commonly cache prompt prefixes (for prompt-cache hit on the model serving side) and dictionary/tokenizer-map blobs (for handshake efficiency). If cache keys don't include the trust principal, an attacker can prime a cache entry that legitimate users later hit. The poisoned entry could redirect to a malicious dictionary, mis-tokenize specific inputs, or simply waste budget.

**Defense.** **Cache keys MUST include the authenticated principal** alongside the content hash. This is a one-line change but a frequent omission.

For shared public caches (e.g., common-prompt prefix caching for a public chatbot), use authenticated cache writes only: clients can hit, but not write. Cache populated only by a trusted process.

### 9. Streaming chunk injection

**Mechanism.** Codec streams responses over SSE/HTTP-2/HTTP-3. If client-side streaming parsers are stateful (most are), a malicious server (or MITM, or compromised upstream) can inject chunks that flip parser state and inject content downstream.

Specifically dangerous: SSE `data:` lines whose content comes from upstream-unsafe sources can break the parser if they contain literal `\n\n` (end-of-event) sequences.

**Defense.**
- Strict SSE framing validation: reject events with malformed headers.
- Per-chunk integrity tag (HMAC or AEAD) so an injected chunk fails authentication.
- Reset client state on any parse error; never continue from a corrupted state.

### 10. Side-channel via timing and length

**Mechanism.**
- **Cache hit/miss timing:** observe latency difference between a prompt that hits the prompt cache and one that misses → infer presence of a specific prefix in the cache.
- **Response length:** infer model output content from response size.
- **First-byte latency:** infer prompt processing time / tokenization complexity.

**Public reference:** general timing-attack class. Specifically against LLM serving: "Prompt Stealing Attacks on LLMs" academic literature (multiple papers 2024 to 2025).

**Defense.**
- **Constant-time response framing for security-sensitive applications:** quantize response start time and response size to coarse buckets.
- **Don't expose first-token-time as a public metric** (or quantize it).
- **For prompt caching:** consider whether cache-hit timing exposure is acceptable for the application. For applications where it isn't, disable shared caching at the application boundary.

## Codec-specific recommendations summary

For v0.6 spec changes:

1. **Normative MUST: identity-fallthrough produces a loud client-side error.** A silent fallback is not acceptable. Application can override with an explicit flag; the default is reject.
2. **Normative MUST: tokenizer-map signature in non-default-map mode**, with the format documented in a v0.6 addendum to `spec/PROTOCOL.md`.
3. **Normative SHOULD: decompression budget of 16 MiB for chat tier**, with configurability and rejection (not truncation) on excess.
4. **Normative SHOULD: per-tenant compression contexts** (no cross-tenant dictionary sharing without explicit acknowledgment).
5. **Reference implementation MUST: strict length validation, full request rejection on framing mismatch, no truncate-and-continue.**
6. **Reference implementation MUST: per-request nonce, freshness window, replay cache.**
7. **Reference implementation SHOULD: per-chunk integrity tag in streaming mode.**
8. **Bench addition: `packages/bench/security/` axis** measuring downgrade-attempt detection rate, decompression-bomb rejection latency, signature verification overhead.

## Verification

The release checklist (`docs/RELEASE_CHECKLIST.md`) should grow a `§7: security` section requiring:

- Identity-fallthrough alert wired up and tested.
- Tokenizer-map signature verification passes on a corpus of valid maps and rejects a corpus of tampered maps.
- Decompression-bomb test cases reject within budget.
- Replay-attack tests demonstrate per-request nonce enforcement.
- Length-confusion fuzz corpus runs clean.

This is the v0.6 gate equivalent of the existing `§3.5 bench surface coverage gate`.
