# Wire-overhead thinning proposal — headers can't dominate the payload

**Status:** proposal. Not executed.

## The problem

Measured today on `vinez@192.168.1.88`, sglang `codec-sglang:v0.3.0`:

| Scenario                       | Body bytes | Header bytes | Ratio   |
|--------------------------------|-----------:|-------------:|---------|
| 8-token msgpack response       |         84 |          185 | **2.2×** headers |
| 2,048-token msgpack + dict-zstd|        291 |          185 | **0.6×** (manageable) |
| 2,048-token msgpack + zstd     |       4549 |          185 | (negligible) |

Today's headers are ONLY standard HTTP (`content-type`, `content-encoding`, `vary`, `transfer-encoding`, `date`, `server`). No Codec-* headers are emitted. **The current "thin wire" is an accident — the server is omitting metadata the spec implies should be there.**

When we wire up the spec-conformant header set per v0.4:

```
HTTP/1.1 200 OK
date:                       Fri, 15 May 2026 17:21:07 GMT   (37 bytes)
server:                     uvicorn                          (16 bytes)
vary:                       Accept-Encoding                  (22 bytes)
content-encoding:           zstd                             (22 bytes)
content-type:               application/x-msgpack            (40 bytes)
transfer-encoding:          chunked                          (28 bytes)
Codec-Tokenizer-Map:        https://cdn.jsdelivr.net/gh/wdunn001/codec-maps@main/maps/qwen/qwen2.json  (92 bytes)
Codec-Tokenizer-Map-Hash:   sha256:887311099cdc09e7022001a01fa1da396750d669b7ed2c242a000b9badd09791  (95 bytes)
Codec-Zstd-Dict:            sha256:ecc9410a09b1d3e5c7a8...                                            (75 bytes)
Codec-Safety-Policy:        acme/strict-v3                                                            (35 bytes)
Codec-Safety-Policy-Hash:   sha256:ab12cd34ef56...                                                    (95 bytes)
Codec-Min-Version:          0.4                                                                       (22 bytes)
```

Spec-conformant response header total: **~580 bytes**. On an 84-byte payload that's a **7× header-to-body ratio**. Even on a 291-byte dict-zstd response it's 2:1.

HTTP/2 HPACK helps inside a single connection — common header NAMES are pre-indexed in the static table, and repeated header VALUES build up in the dynamic table over the connection. But:
- First response of a connection always pays full freight.
- Many deployments run HTTP/1.1 (uvicorn for vllm; nginx-proxy in front; common reverse-proxy stacks).
- Header VALUES like `sha256:887311…` are unique enough that even HPACK only saves on exact repetition.

The headers are mostly **connection-invariant**: the map URL, the dict hash, the safety policy ID, the minimum-version floor — none of these change per request. Repeating them every response is what makes the wire fat.

## Five interventions

In rough order of bytes-saved-per-response, biggest first:

### 1. `Codec-Session` ID caching (biggest win)

The server computes a short deterministic hash of its current Codec session state (map URL, map hash, dict hash, safety policy id+hash, version floor, required features) and emits it as `Codec-Session: <8-hex>` on every response.

- **First response of a connection** (or after a session-state change): emit `Codec-Session: <8-hex>` + the full set of Codec-* headers.
- **Subsequent responses** with the same session id: emit ONLY `Codec-Session: <8-hex>`. Client looks up the cached state.
- **State change**: server emits a new session id + the full set; client invalidates cache, swaps.

8 hex chars = 32 bits of entropy. Per-connection scope means collision risk is negligible (a malicious server still can't cause a wrong-state lookup because the client validates the resulting frames against its cached state).

**Saves ~400–500 bytes per response after the first** when full v0.4 headers are in play. Works on HTTP/1.1 — no HPACK dependency. Works behind reverse proxies that strip/re-add headers (the session id is opaque; proxies pass it through).

```
First response:
  Codec-Session:             a3f8c014
  Codec-Tokenizer-Map:       qwen2 sha256:887311099cdc
  Codec-Zstd-Dict:           sha256:ecc9410a09b1
  Codec-Safety-Policy:       acme/strict-v3 sha256:ab12cd34ef56
  Codec-Min-Version:         0.4

Subsequent responses (cache hit):
  Codec-Session:             a3f8c014
```

### 2. Truncate `sha256:` in headers from 64 hex to 12-16 hex

A sha256 in full hex is 64 chars. At 16 hex (64 bits), collision-resistance for cache lookups is still 2⁶⁴ buckets — astronomically safe for "look up the right map in my local cache" use cases.

The full hash STILL appears in the well-known descriptor body — that's where integrity verification happens. The header is just an index. Headers are not the integrity boundary.

- Old: `Codec-Tokenizer-Map-Hash: sha256:887311099cdc09e7022001a01fa1da396750d669b7ed2c242a000b9badd09791` (95 B)
- New: `Codec-Tokenizer-Map-Hash: sha256:887311099cdc0973` (47 B)
- **Saves ~48 B per hash-bearing header. With 3 hashes (map, dict, safety): ~144 B/response.**

If we want to drop a level further, integrate the hash into the value:

- `Codec-Tokenizer-Map: qwen2@887311099cdc0973` (~35 B for ID + truncated hash)

### 3. Drop URLs from headers — use `(id, hash)` and discover URL via well-known

`Codec-Tokenizer-Map` currently carries the full URL (`https://cdn.jsdelivr.net/.../qwen2.json`). But every v0.4-aware client knows the well-known convention (`.well-known/codec/maps/<id>.json`). The ID + the hash is enough; URL is recoverable.

- Old: `Codec-Tokenizer-Map: https://cdn.jsdelivr.net/gh/wdunn001/codec-maps@main/maps/qwen/qwen2.json` (92 B)
- New: `Codec-Tokenizer-Map: qwen2 sha256:887311099cdc0973` (~38 B)
- **Saves ~50 B per map-bearing header.**

Trade-off: a v0.3 or earlier client that only knew to read the URL from the header would have to be upgraded. Mitigated by §4 below (the well-known convention is older than v0.4 — discovery works for any version).

### 4. Drop advisory headers on 200 OK; emit only when they matter

`Codec-Min-Version` and `Codec-Required-Features` are signals the spec ADDED in v0.4 § Version Compatibility Signaling. On a 426 response they're load-bearing — the client uses them to render the upgrade prompt. On a **200 OK** they're advisory; the client already speaks the right version or it wouldn't have gotten a 200.

- Default: server omits `Codec-Min-Version` and `Codec-Required-Features` on 2xx responses.
- Server MUST emit them on 426 (already required).
- Server MAY emit them on 2xx if a deployment policy wants advisory advertisement (e.g. for monitoring tooling).

**Saves 100–150 B per 2xx response on v0.4-mandated deployments.**

### 5. Short header names where the verbosity isn't load-bearing

`Codec-Tokenizer-Map-Hash` is 24 chars before the colon. The shorter form `Codec-Tm-Hash` is 13. Across 6+ Codec-* headers per response that's ~60 B/response just on names (before HPACK).

Trade-off: readability in `curl -v` output suffers. I'd argue the truncated-hash trick (§2) and session-id (§1) reduce the count of headers per response so much that the name length stops mattering — easier to keep readable names than save another 60 B on top of the 600+ already saved.

**Recommendation: skip §5.** Apply §1-4 instead.

## Combined impact

Worst case today (spec-conformant v0.4 response on 84-byte payload):

| Header treatment            | Bytes | vs. body |
|-----------------------------|------:|---------:|
| Current spec (all headers, full URLs + full hashes) | 580 | 7.0× |
| Apply §2 (truncated hashes)               | 436 | 5.2× |
| Apply §2 + §3 (no URLs)                   | 336 | 4.0× |
| Apply §2 + §3 + §4 (drop advisory)        | 214 | 2.5× |
| Apply §2 + §3 + §4 + §1 (session cached)  |  ~85 | **1.0×** ✓ |

In steady state (after the first response of a connection), the headers drop to roughly the body size. The first response of a connection pays full Codec-* freight (~214 B with §2+§3+§4), but every response after that on the same session is essentially free.

## Migration plan

Each section is independently shippable; ordered by safety + impact:

1. **§4 — Drop advisory on 200 OK.** Pure server-side change; no client work. Servers stop sending `Codec-Min-Version` on 2xx. Land in v0.4.1 or v0.5 cut.

2. **§2 — Truncate hashes in headers.** Server emits 16-hex; clients accept both 64-hex (legacy) and 16-hex+. Wire-additive — older servers' 64-hex still parses. Land in v0.5.

3. **§3 — `(id, hash)` instead of URLs.** Server emits the new form; clients still accept the old URL form. The well-known convention is v0.2+ so this works against any deployment with the convention published. Wire-additive. Land in v0.5 alongside §2.

4. **§1 — `Codec-Session` caching.** Most impactful, most work — needs a client-side state cache, server-side session-id derivation, and a spec'd cache invalidation rule. Codec-Session header is new; older clients ignore it. Wire-additive. **Land in v0.6.**

## Open questions

- **`Codec-Session` scope: per-connection or per-tuple?** Per-connection is the simplest (cache invalidates on TCP close); per-tuple `(origin, map_id, dict_id, safety_policy_id, version_floor)` is more reusable across connections but needs a longer hash (16 hex?) to dodge cross-origin collisions. Recommendation: per-connection for v0.6, revisit if the cache hit rate suffers in practice.
- **Should the session-id derivation be canonical (hash of sorted fields) or arbitrary (server picks)?** Arbitrary is simpler — server emits whatever short id it wants, client treats it opaquely. Canonical lets two different servers with the same state share a session id, which a CDN could use. Recommendation: arbitrary for v0.6 — canonical is a future additive.
- **`Codec-Session` invalidation on state change**: server emits new id + full headers; client invalidates old. Does the client also need to RE-VALIDATE the cached state via the full header set on every Nth response? Recommendation: no — the cache is in-memory per-client per-connection, no persistence, no risk of stale.

## What this does NOT change

- The well-known fabric (URL conventions, schemas, content-addressing).
- HELLO/READY exchange when session protocol lands — that's a different layer where the same state can live once and be referenced by frame id; this proposal is purely about the stateless HTTP completion layer.
- Body bytes. The frame format on the wire is unchanged.
- Backward compatibility per `spec/versions/v0.4.md` § Versioning Policy. Every change here is additive; older clients still parse the wire.
