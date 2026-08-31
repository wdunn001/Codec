# Spec restructure proposal: thin the per-version docs

**Status:** proposal. Not executed. Reviewed before the v0.5 cut.

## The problem

```
spec/
├── PROTOCOL.md                  101 lines   navigation index
├── versions/
│   ├── v0.2.md                   864 lines
│   ├── v0.3.md                 1,358 lines  +494 over v0.2 (most is copy-down)
│   └── v0.4.md                 1,794 lines  +436 over v0.3 (most is copy-down)
├── PIPELINES.md                 176 lines
├── WELL_KNOWN_DISCOVERY.md      358 lines
├── PRETOKENIZER_PROGRAM.md      166 lines
└── *.schema.json
```

Total: ~4,800 lines, of which an estimated **2,500 to 3,000 lines are redundant text** carried forward across version files. Sections like "Wire Formats", "Tokenizer Map", "Transport Compression", and "Latent Modality" appear nearly verbatim in v0.3.md and v0.4.md.

Effects observed today:
- A new contributor reads v0.4.md and can't tell which sections describe v0.4 deltas vs. invariants from v0.2.
- Updates to invariant text (e.g. "wire frames are length-prefixed msgpack") would need to land in 3 places to stay consistent.
- The §1.5 prior-version compatibility gate just added relies on a clean "what changed where" trail. That trail fights the copy-down.
- v0.4.md is at 1,794 lines and growing. v0.5 with another axis will be 2,200+.

## The proposed structure

```
spec/
├── PROTOCOL.md                       navigation index (current)
├── CORE.md                           wire chassis: cross-version invariants
├── modalities/
│   ├── text.md                       text-token frames + tokenizer maps + tool-calling
│   └── latent.md                     LatentStreamHeader/Frame + latent-space maps
├── capabilities/
│   ├── compression.md                Accept-Encoding negotiation, dict-zstd, headers
│   ├── safety.md                     accept_safety_policies + sanitized descriptors
│   └── version-signaling.md          Codec-Client-Version / 426 / VERSION_INCOMPATIBLE
├── versions/
│   ├── v0.2.md                       ~150 lines: lineage + delta + open questions
│   ├── v0.3.md                       ~150 lines: lineage + delta + open questions
│   └── v0.4.md                       ~250 lines: lineage + delta + open questions
├── PIPELINES.md                      latent transform math (no change)
├── WELL_KNOWN_DISCOVERY.md           URL convention (no change)
├── PRETOKENIZER_PROGRAM.md           pretok DSL (no change)
└── *.schema.json
```

### What lives where

| Section (currently in v0.4.md) | Lives in (proposed) | Why |
|---|---|---|
| Motivation                 | versions/v0.2.md (origin) | One-time framing |
| Modalities table           | CORE.md                   | The list updates per version; CORE has the registry, versions add entries |
| Wire Formats               | CORE.md                   | Frame structure is invariant from v0.2 |
| Frame Semantics            | CORE.md                   | Invariant |
| Endpoints                  | CORE.md                   | HTTP path conventions are invariant |
| Transport Compression      | capabilities/compression.md | Capability, not modality |
| Tokenizer Map              | modalities/text.md        | Text-modality specific |
| Cross-vendor tokenizer     | modalities/text.md        | Text-modality specific |
| Latent Modality            | modalities/latent.md      | Latent-modality specific |
| Session Protocol (future)  | CORE.md                   | Future addition to invariants |
| Safety Policy Negotiation  | capabilities/safety.md    | Capability |
| Version Compatibility      | capabilities/version-signaling.md | Capability |
| Versioning Policy          | CORE.md                   | Cross-version invariant |
| What this is NOT           | CORE.md                   | Cross-version |
| Migration path             | CORE.md                   | Cross-version (path itself is invariant; what's added per version changes) |
| Open questions (v0.X)      | versions/v0.X.md          | Per-version, living block |

### What `versions/v0.X.md` becomes

Thin per-version doc:

```markdown
# Codec v0.X

**Lineage:** v0.(X-1) + this delta. Wire-compatible per CORE.md § Versioning Policy.

## Delta from v0.(X-1)

- Added `<axis>` capability (see capabilities/<doc>.md).
- Extended <modality> with <feature> (see modalities/<doc>.md).
- New frame type `<name>` (assigned byte `0xNN`: see CORE.md § Frame Type Registry).
- New required-features registry entry: `<value>`.
- New `.well-known/codec/<path>.json` (see WELL_KNOWN_DISCOVERY.md).

## What this version requires

- Minimum versions of each language client to negotiate v0.X: <table>
- Bench evidence the delta works: <link to packages/bench/results/.../>.

## Open questions (v0.X)

<living block: resolved items get **Resolved.** marker; deferred items
get migrated to v0.(X+1)'s block.>
```

That's it. The wire surface for v0.X is whatever CORE.md + the referenced modality/capability docs say it is, with this delta on top.

## Migration plan (if approved)

1. **Extract**: pull each section listed in the "Lives in" table out of v0.4.md into the new layered docs. Each new doc is a verbatim copy from v0.4.md for v0.4-current language; add a `**Stable since:** v0.X` line at the top.
2. **Trim per-version docs**: rewrite v0.2.md, v0.3.md, v0.4.md to the thin shape above. Keep the open-questions block intact (it's already per-version-living).
3. **Re-link**: every `#section-name` anchor referenced in package READMEs, codec-supervisor docs, codec-website docs, and changelog entries needs a path rewrite. Single-pass `sed` + manual review of the diff.
4. **Validate**: `mkdocs serve` or equivalent broken-link checker.
5. **Land**: single commit per stage (extract, trim, re-link), each pushable independently so a rollback only loses one stage.

Estimated effort: 4 to 8 hours of careful work. Net result: v0.X.md docs at ~150 to 250 lines, CORE.md at ~1,200 lines, modality docs ~400 to 500 each, capability docs ~150 to 300 each. Total spec footprint drops from ~4,800 to ~3,000 lines with zero loss of content.

## What this does NOT change

- Wire format. Every byte on the wire stays the same. This is a documentation reorganization.
- Schema files (`*.schema.json`): they are already cleanly per-thing.
- Companion docs (PIPELINES.md, WELL_KNOWN_DISCOVERY.md, PRETOKENIZER_PROGRAM.md).
- The versioning-policy rule itself (additive minor, breaking-bump major).
- §1.5 prior-version compatibility gate (still operates against the per-version specs).

## What could go further (out of scope for this proposal)

- **Schema files as the source of truth.** Today the schemas are purely descriptive. A future pass could lift the schemas to be the canonical wire definition and have the markdown docs render from them. Not blocking; doesn't reduce the redundancy unless tackled.
- **Per-version-frozen wire-text blocks.** v0.4.md § Versioning Policy talks about "frozen wire-text block + living open-questions block". If we restructure, we could enforce frozen by reading the wire-text from CORE.md in place of duplicating into each version. Already implicit in the proposal above.
