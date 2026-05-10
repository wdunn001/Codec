# Codec Map Discovery via `.well-known/codec/`

Status: stable, additive to v0.2.

This document specifies the convention by which a model maintainer publishes
their tokenizer dialect map at a known location on a domain they control,
so that any Codec client can discover it given only the maintainer's origin
and the map ID.

It is the decentralised counterpart to a future centralised registry. Both
can coexist; the registry is a lookup service, this convention is a
publishing protocol.

---

## Why

Map publishing today is ad-hoc: a maintainer hosts a JSON somewhere
(jsDelivr, S3, Hugging Face), then has to communicate the URL and sha256
hash to every client out-of-band. That works for one-off integrations, but
it doesn't scale: every model release requires a synchronised update on the
client side.

Following the [RFC 8615](https://datatracker.ietf.org/doc/html/rfc8615)
`.well-known` pattern (the same pattern used by `security.txt`, OpenID
Connect, ACME, etc.), Codec defines a fixed location under any HTTPS origin
where a maintainer can publish their maps. Clients can then fetch the map
given only:

  - the origin (e.g. `https://qwen.io`)
  - the map ID (e.g. `qwen/qwen2`)

The maintainer rotates maps on their own cadence; clients always see the
current pinned hash without a code change.

---

## URL layout

```
https://<origin>/.well-known/codec/maps/<id>.json        ← per-tokenizer-map document
https://<origin>/.well-known/codec/policies/<id>.json    ← per-safety-policy document (mutable pointer / inline)
https://<origin>/.well-known/codec/policies/<hash>.json  ← per-safety-policy document (immutable, content-addressed)
https://<origin>/.well-known/codec/index.json            ← directory (optional)
```

`<id>` is the Codec ID (tokenizer-map id or safety-policy id) with `/`
characters preserved as path separators. For example, the tokenizer ID
`qwen/qwen2` resolves to:

```
https://qwen.io/.well-known/codec/maps/qwen/qwen2.json
```

And the safety-policy ID `acme/strict-v3` resolves to:

```
https://acme.example/.well-known/codec/policies/acme/strict-v3.json
```

IDs MUST be lowercase ASCII matching `[a-z0-9._/-]+`. Maintainers MUST NOT
publish documents whose ID contains `..`, leading `/`, or any other path
traversal sequence.

Safety policies additionally publish under a content-addressed sibling
path keyed by sha256 hash:

```
https://acme.example/.well-known/codec/policies/sha256/<hex>.json
```

The mutable per-id document MAY be either an inline descriptor or a
pointer; the content-addressed sibling is always the inline descriptor
(or a pointer whose own bytes hash to its filename's `<hex>`). Clients
that receive a `safety_policy_hash` in `READY` SHOULD prefer the
content-addressed path because it is provably immutable.

---

## Per-map document

The document at `.well-known/codec/maps/<id>.json` is one of two shapes.
Clients distinguish them by inspecting the keys present.

### Form A — Pointer

A pointer is small (typically <200 bytes) and references a tokenizer map
hosted elsewhere — usually a CDN. This is the recommended shape: the
`.well-known` document changes only when a new map version is published,
the heavy map JSON sits behind a CDN's caching headers.

```json
{
  "id": "qwen/qwen2",
  "url": "https://cdn.jsdelivr.net/gh/qwen/codec-maps/qwen2.json",
  "hash": "sha256:c73972f7a580936d724ffd8df9df2ce546d255c543e9d09b6d75e5bf69b1a64d",
  "published_at": "2026-05-06T12:00:00Z"
}
```

| Field          | Type   | Required | Notes                                       |
|----------------|--------|----------|---------------------------------------------|
| `id`           | string | yes      | MUST equal the requested `<id>`.            |
| `url`          | string | yes      | Absolute HTTPS URL for the actual map JSON. |
| `hash`         | string | yes      | sha256 digest of the bytes at `url`. Format `sha256:<hex>`. |
| `published_at` | string | no       | ISO 8601 UTC. For maintainer telemetry only — clients ignore it. |

The pointer's `url` MAY be on any HTTPS origin (the maintainer's own,
jsDelivr, R2, Hugging Face, etc.). Pointers MUST NOT chain — the loader
fetches `url`, verifies its bytes hash to `hash`, parses as a TokenizerMap,
and returns. A pointer whose `url` resolves to another pointer is rejected.

### Form B — Inline map

If the map is small enough that the indirection isn't worth it, the
document MAY be the full TokenizerMap directly. Detected by the presence
of `vocab` (v2) or `tokens` (v1):

```json
{
  "id": "qwen/qwen2",
  "version": "2",
  "vocab_size": 151665,
  "vocab": { ... },
  "encoder": "byte_level",
  "merges": [ ... ],
  ...
}
```

When the map is served inline, the integrity guarantee is the HTTPS
connection itself. Clients that need a stable pin SHOULD compute the hash
on first fetch and cache it; subsequent loads MAY be re-verified against
the cached hash to detect tampering.

Maintainers SHOULD prefer Form A for any map larger than ~10 KB.

---

## Directory document (optional)

`https://<origin>/.well-known/codec/index.json` enumerates every map the
origin publishes. Useful for clients that want to discover what's available
without knowing IDs in advance, and for build tools that pre-warm caches.

```json
{
  "codec_version": "0.2",
  "maps": [
    {
      "id": "qwen/qwen2",
      "url": "https://cdn.jsdelivr.net/gh/qwen/codec-maps/qwen2.json",
      "hash": "sha256:c73972f7a58…"
    },
    {
      "id": "qwen/qwen2.5",
      "url": "https://cdn.jsdelivr.net/gh/qwen/codec-maps/qwen2.5.json",
      "hash": "sha256:7af1219c3e4…"
    }
  ]
}
```

Each entry has the same fields as a pointer document. `codec_version`
identifies the discovery protocol version (currently `"0.2"`).

The index document is advisory: a client MAY skip it and resolve the
per-map document directly. A maintainer MAY skip publishing it if they
expose only one or two maps.

---

## Resolution algorithm

Given `(origin, id)`:

1. Fetch `<origin>/.well-known/codec/maps/<id>.json`.
2. Parse as JSON.
3. If the parsed object contains `vocab` or `tokens` → treat as an inline
   map. Run the standard map validator and return.
4. Otherwise → treat as a pointer. Validate `id`, `url`, `hash`. Reject if
   the pointer's `id` doesn't match the requested `id`.
5. Fetch `pointer.url`, verify its bytes hash to `pointer.hash`, parse as
   TokenizerMap, validate, return.

Clients MUST NOT follow pointers across more than one hop. A pointer that
resolves to another pointer is an error.

Resolution failures (404, hash mismatch, validation error) MUST surface as
distinct error types so application code can fall back gracefully — e.g.
to a hard-coded URL+hash pair or to a centralised registry lookup.

---

## CORS & content type

Maintainers SHOULD serve `.well-known/codec/*.json` with:

```
Content-Type: application/json
Access-Control-Allow-Origin: *
Cache-Control: public, max-age=300, stale-while-revalidate=86400
```

`Access-Control-Allow-Origin: *` is required for browser clients to
discover maps cross-origin. Without it, `.well-known` discovery is
effectively server-only.

Per-map documents are cheap (Form A) or content-addressed by hash (Form
B), so a 5-minute cache with a long stale-while-revalidate window is safe
and gives near-zero discovery latency on hot paths.

---

## Security model

The trust anchor is the **origin's TLS certificate plus the sha256 hash
inside the pointer**.

  - The origin is named by the application: it is the maintainer the user
    has chosen to trust for this model. TLS authenticates that origin.
  - The pointer's `hash` field anchors the actual map bytes. Even if the
    CDN URL is later compromised, a hash mismatch fails closed.

For Form A, the pointer file is small and changes rarely; a maintainer who
controls the origin controls the pointer, and the pointer pins the bytes
on the CDN. A CDN compromise alone cannot serve a poisoned map.

For Form B, the maintainer controls both the bytes and the TLS — there is
no second trust hop. Equivalent to direct hosting, but at the discoverable
location.

Clients that need stronger guarantees (e.g. air-gapped enterprise) SHOULD
pin both the URL and the hash via direct configuration. `discoverMap` is
one bootstrapping path; it doesn't replace `loadMap({ url, hash })` for
fixed-deployment use.

---

## Safety policies

Safety policy descriptors follow the same conventions as tokenizer maps:
content-addressed by sha256, sanitized (operators publish the *shape* of
enforcement, never the contents — see
[`safety-policy.schema.json`](./safety-policy.schema.json)), discoverable
under `.well-known/codec/policies/`.

Resolution order, given `(origin, policy_id)`:

1. Fetch `<origin>/.well-known/codec/policies/<policy_id>.json`.
2. Parse as JSON.
3. If the parsed object contains `categories` → treat as an inline
   descriptor. Run the safety-policy validator and return.
4. Otherwise → treat as a pointer (same `{id, url, hash}` shape as
   tokenizer-map pointers). Validate, fetch `pointer.url`, verify hash,
   return the inline descriptor.

A client that received `safety_policy_hash` in `READY` MAY skip the
mutable per-id path entirely and fetch
`<origin>/.well-known/codec/policies/sha256/<hex>.json` directly — the
hash already pins the bytes, so the mutable indirection is unnecessary.

Resolution failures (404, hash mismatch, validation error) MUST surface
as distinct error types so application code can fall back gracefully —
e.g. abort the session if no acceptable policy is published.

---

## Worked example

A maintainer publishes Qwen-2 and Qwen-2.5 from `qwen.io`:

```
qwen.io/
  .well-known/
    codec/
      index.json
      maps/
        qwen/
          qwen2.json        ← pointer
          qwen2.5.json      ← pointer
```

`index.json`:
```json
{
  "codec_version": "0.2",
  "maps": [
    { "id": "qwen/qwen2",   "url": "https://cdn.example/qwen2.json",   "hash": "sha256:c73972…" },
    { "id": "qwen/qwen2.5", "url": "https://cdn.example/qwen2.5.json", "hash": "sha256:7af121…" }
  ]
}
```

`maps/qwen/qwen2.json`:
```json
{
  "id": "qwen/qwen2",
  "url": "https://cdn.example/qwen2.json",
  "hash": "sha256:c73972f7a580936d724ffd8df9df2ce546d255c543e9d09b6d75e5bf69b1a64d"
}
```

A client resolves the map with:

```ts
import { discoverMap } from '@codecai/web';

const map = await discoverMap({
  origin: 'https://qwen.io',
  id: 'qwen/qwen2',
});
```

```python
from codecai import discover_map

map = await discover_map(origin="https://qwen.io", id="qwen/qwen2")
```

The pointer at `qwen.io/.well-known/codec/maps/qwen/qwen2.json` is fetched
once (small file, well-cached), then the actual map is fetched from the
CDN and verified against the hash. Subsequent calls hit the in-process
map cache and skip the network entirely.
