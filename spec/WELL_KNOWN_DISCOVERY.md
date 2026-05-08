# Codec Map Discovery via `.well-known/codec/`

Status: stable, additive to v0.2 and v0.3.

This document specifies the convention by which a model maintainer publishes
their **per-modality maps** at known locations on a domain they control,
so that any Codec client can discover them given only the maintainer's origin
and the map ID.

The convention covers two map kinds, each living at its own path under
`/.well-known/codec/`:

- **Tokenizer maps** (text-tokens modality, v0.2) — `maps/<id>.json`
- **Latent-space maps** (image-/video-latents modalities, v0.3) — `latents/<id>.json`

Both kinds use the same Form A / Form B publication pattern, the same
hash-pinned trust model, the same resolution algorithm, and the same CORS
guidance. The two paths exist in parallel because the document schemas
differ (tokenizer-map.schema.json vs latent-space-map.schema.json), but
everything procedural in this document applies to both kinds unless
stated otherwise.

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
https://<origin>/.well-known/codec/maps/<id>.json       ← tokenizer map (v0.2)
https://<origin>/.well-known/codec/latents/<id>.json    ← latent-space map (v0.3)
https://<origin>/.well-known/codec/index.json           ← directory of both (optional)
```

`<id>` is the Codec map ID with `/` characters preserved as path separators.
For example, the ID `qwen/qwen2` resolves to:

```
https://qwen.io/.well-known/codec/maps/qwen/qwen2.json
```

The latent-space map ID `stabilityai/sd-vae-ft-mse` resolves to:

```
https://stability.ai/.well-known/codec/latents/stabilityai/sd-vae-ft-mse.json
```

IDs MUST be lowercase ASCII matching `[a-z0-9._/-]+`. Maintainers MUST NOT
publish maps whose ID contains `..`, leading `/`, or any other path
traversal sequence. Tokenizer-map IDs and latent-space-map IDs share the
same namespace rules but live in different paths and MAY collide (e.g. a
maintainer could publish both `qwen/qwen2` as a tokenizer map and
`qwen/qwen2-vae` as a latent-space map without conflict).

---

## Per-map document

The document at `.well-known/codec/maps/<id>.json` (tokenizer) or
`.well-known/codec/latents/<id>.json` (latent-space) is one of two shapes.
Clients distinguish them by inspecting the keys present.

### Form A — Pointer

A pointer is small (typically <200 bytes) and references a map
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
fetches `url`, verifies its bytes hash to `hash`, parses as the appropriate
map kind (TokenizerMap for `maps/`, LatentSpaceMap for `latents/`), and
returns. A pointer whose `url` resolves to another pointer is rejected.

### Form B — Inline map

If the map is small enough that the indirection isn't worth it, the
document MAY be the full map directly. Clients detect by inspecting keys:

| Path under `.well-known/codec/` | Detect inline by               | Validate against                  |
|---------------------------------|--------------------------------|-----------------------------------|
| `maps/<id>.json`                | presence of `vocab` (v2) or `tokens` (v1) | `tokenizer-map.schema.json`       |
| `latents/<id>.json`             | presence of `decoder` and `space_kind`    | `latent-space-map.schema.json`    |

Inline tokenizer map:

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

Inline latent-space map (typically Form A in practice — VAE decoder
references push the document over 10 KB even before the decoder bytes
themselves):

```json
{
  "id": "stabilityai/sd-vae-ft-mse",
  "version": "1",
  "space_kind": "vae",
  "shape":  [4, 64, 64],
  "dtype":  "fp16",
  "vae_scale_factor": 0.18215,
  "decoder": { "runtime": "onnx-web", "url": "...", "hash": "sha256:...", ... },
  "pipelines": ["raw", "int8", "delta+int8"],
  ...
}
```

When the map is served inline, the integrity guarantee is the HTTPS
connection itself. Clients that need a stable pin SHOULD compute the hash
on first fetch and cache it; subsequent loads MAY be re-verified against
the cached hash to detect tampering.

Maintainers SHOULD prefer Form A for any map larger than ~10 KB. Latent-space
maps almost always exceed this threshold once the decoder reference is
included, so Form A is the practical default for `latents/<id>.json`.

---

## Directory document (optional)

`https://<origin>/.well-known/codec/index.json` enumerates every map the
origin publishes. Useful for clients that want to discover what's available
without knowing IDs in advance, and for build tools that pre-warm caches.

The directory carries one array per map kind. The `latents` array is
v0.3-additive; clients on v0.2 ignore it.

```json
{
  "codec_version": "0.3",
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
  ],
  "latents": [
    {
      "id":   "stabilityai/sd-vae-ft-mse",
      "url":  "https://cdn.jsdelivr.net/gh/wdunn001/codec-latents/sd-vae-ft-mse.json",
      "hash": "sha256:a1b2c3d4e5…"
    },
    {
      "id":   "stabilityai/sdxl-vae",
      "url":  "https://cdn.jsdelivr.net/gh/wdunn001/codec-latents/sdxl-vae.json",
      "hash": "sha256:f6e7d8c9b0…"
    }
  ]
}
```

Each entry has the same fields as a pointer document. `codec_version`
identifies the discovery protocol version: `"0.2"` indexes only carry
`maps[]`; `"0.3"` indexes carry both `maps[]` and `latents[]` (either MAY
be empty).

The index document is advisory: a client MAY skip it and resolve the
per-map document directly. A maintainer MAY skip publishing it if they
expose only one or two maps.

---

## Resolution algorithm

Given `(origin, kind, id)` — where `kind` is `"tokenizer"` or `"latent"`:

1. Fetch the per-map document:
   - `kind = "tokenizer"`  → `<origin>/.well-known/codec/maps/<id>.json`
   - `kind = "latent"`     → `<origin>/.well-known/codec/latents/<id>.json`
2. Parse as JSON.
3. Detect inline-vs-pointer by inspecting keys:
   - Tokenizer kind: presence of `vocab` (v2) or `tokens` (v1) → inline.
     Validate against `tokenizer-map.schema.json` and return.
   - Latent kind: presence of `decoder` and `space_kind` → inline.
     Validate against `latent-space-map.schema.json` and return.
4. Otherwise → treat as a pointer. Validate `id`, `url`, `hash`. Reject if
   the pointer's `id` doesn't match the requested `id`.
5. Fetch `pointer.url`, verify its bytes hash to `pointer.hash`, parse and
   validate against the schema for the requested `kind`, return.

A document fetched from `latents/` MUST validate against
`latent-space-map.schema.json`. A document fetched from `maps/` MUST
validate against `tokenizer-map.schema.json`. The path is the kind
discriminator — a server cannot publish a tokenizer map under `latents/`
or vice versa.

Clients MUST NOT follow pointers across more than one hop. A pointer that
resolves to another pointer is an error.

Resolution failures (404, hash mismatch, validation error) MUST surface as
distinct error types so application code can fall back gracefully — e.g.
to a hard-coded URL+hash pair or to a centralised registry lookup.

For latent-space maps, resolution returns the map document; the client
typically continues by fetching the decoder bytes referenced inside
(`decoder.url` + `decoder.hash`). Decoder bytes are content-addressed and
SHOULD be cached by hash indefinitely the same way map bytes are.

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

---

## Worked example — latent-space map (v0.3)

A maintainer publishes the SD-1 VAE and SDXL VAE from `stability.ai`:

```
stability.ai/
  .well-known/
    codec/
      index.json
      latents/
        stabilityai/
          sd-vae-ft-mse.json      ← pointer
          sdxl-vae.json           ← pointer
```

`latents/stabilityai/sd-vae-ft-mse.json`:
```json
{
  "id":   "stabilityai/sd-vae-ft-mse",
  "url":  "https://cdn.jsdelivr.net/gh/wdunn001/codec-latents/sd-vae-ft-mse.json",
  "hash": "sha256:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"
}
```

The CDN-hosted map at `cdn.jsdelivr.net/.../sd-vae-ft-mse.json` is the
full LatentSpaceMap document — see `spec/examples/sd-vae-ft-mse.latent-map.json`
for the canonical reference shape.

A client resolves it with:

```ts
import { discoverLatentSpace } from '@codecai/web';

const space = await discoverLatentSpace({
  origin: 'https://stability.ai',
  id:     'stabilityai/sd-vae-ft-mse',
});

// space.decoder.{url,hash} carry the runtime-portable decoder reference;
// space.pipelines lists the transform pipelines the server may negotiate.
```

```python
from codecai import discover_latent_space

space = await discover_latent_space(
    origin="https://stability.ai",
    id="stabilityai/sd-vae-ft-mse",
)
```

Resolution proceeds in two hops the same way tokenizer maps do (pointer →
hash-verified map JSON), but the LatentSpaceMap then references **decoder
bytes** at `space.decoder.url` + `space.decoder.hash`. Clients that intend
to do client-side decode fetch and verify those bytes once, cache them by
hash, and load them into the runtime named in `space.decoder.runtime`.
Clients that intend to fall back to server-side decode skip this step
entirely and never download the decoder.
