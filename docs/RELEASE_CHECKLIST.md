# Codec Release Checklist

This checklist is the **gate** between feature work and a published release.
It runs in order. **No artifact ships** (tag, npm, PyPI, crates.io, NuGet,
Maven Central, Docker Hub, codecai.net) until every box on its row is checked.

The principle: every artifact a user can install MUST point at numbers,
docs, and behavior that match the website and the spec at the moment of
publish. A premature publish creates a permanent mismatch — auditing
"v0.4 says X, npm says Y" wastes more time than waiting one extra day to
cut the release cleanly.

This document is normative for v0.4 onward. v0.2 and v0.3 shipped without
this gate; closing that gap is part of the v0.4 release.

---

## How to use this file

1. Copy the entire **Pre-publish gates** + **Publish phase** + **Post-publish**
   sections into the GitHub release-issue tracking the cut (one per release —
   `release: v0.4`, `release: v0.5`, ...).
2. Tick boxes as work lands. Don't skip; if something doesn't apply,
   strike it through with a one-line reason inline.
3. The release-issue stays open until every box is ticked or struck.
4. The *publish phase* is gated on the entire pre-publish phase being
   green. The *post-publish* phase is gated on every publish step
   succeeding.

A release-issue with even one un-ticked, un-struck box in pre-publish
**MUST NOT** be tagged.

---

## Pre-publish gates

### 1 · Validation (cross-language test suites)

- [ ] `@codecai/web` — `npm test` green in `packages/web/`
- [ ] `@codecai/web-safety` — `npm test` green in `packages/web-safety/`
- [ ] `@codecai/maps-cli` — `npm test` green + canonical-example round-trip
- [ ] `codecai` (Python) — `pytest` green in `packages/python/`
- [ ] `codec-rs` — `cargo test --all-features` green in `packages/rust/`
- [ ] `Codec.Net` — `dotnet test` green in `packages/dotnet/`
- [ ] `codec` (Java) — `mvn test` green in `packages/java/` (run on a JDK
      box; `vinez@192.168.1.88` has Docker maven:3-eclipse-temurin-17 if
      the local box doesn't have a JDK)
- [ ] `libcodec` — CMake/CTest green: `cmake --build build && ctest`
- [ ] `codec-supervisor` — `pytest` green
- [ ] Cross-stack hash interop spot-check: hash a canonical descriptor
      from each language; verify all six produce identical
      `sha256:<hex>` (the contract that makes `safety_policy_hash`
      meaningful across stacks)

### 2 · Coverage

- [ ] Coverage % per language, captured in `packages/*/COVERAGE.md` (or
      equivalent per-package report). No regression vs. previous release.
- [ ] Anything intentionally uncovered is documented (e.g. "default
      classifier factory paths run only with weights present").

### 3 · Benchmarks

- [ ] `packages/bench/` cross-stack run completed against the release
      candidate stack.
- [ ] Fresh result file under `packages/bench/results/<UTC>/`.
- [ ] `MATRIX.md` aggregator regenerated.
- [ ] `RESULTS.md` headline numbers updated.
- [ ] Bench-method changes documented (see `methodology/SCHEMA.md`); no
      cell with a stale `(run_id, engine, lang)` fingerprint compared
      against a new one.
- [ ] If new modalities or classifiers shipped this version (e.g. v0.3
      added latents, v0.4 added safety): the bench surface covers them
      or has a documented "skipped, see issue #N" note.
- [ ] vs.-previous-release delta produced (text or table) for the
      release notes.

### 4 · Spec + per-version protocol documentation

- [ ] `spec/PROTOCOL.md` (the navigation index) accurate — every
      shipped version is listed, the "latest" pointer resolves
      correctly, companion-doc list reflects what's in-tree.
- [ ] `spec/versions/v0.X.md` (this release's per-version doc) is
      written: every wire field, frame type, capability axis the
      candidate ships is documented in this file (frozen wire-text
      block + living open-questions block).
- [ ] **Versioning policy compliance** (binding from v0.4 onward —
      see `spec/versions/v0.4.md` § Versioning Policy). For a
      proposed minor version (`v0.X.(Y+1)` against `v0.X.Y`):
  - [ ] **Diff audit** completed against the prior minor version
        across `spec/versions/v0.X.md`, `spec/*.schema.json`,
        `spec/PIPELINES.md`, `spec/WELL_KNOWN_DISCOVERY.md`.
  - [ ] No removed wire fields, no field-semantics changes, no
        reassigned frame-type bytes, no canonical-bytes format
        changes, no removed discovery paths, no closed-enum
        tightening that rejects v0.X.Y JSON, no previously-optional
        field made mandatory.
  - [ ] If ANY breaking change is found, the release MUST be a
        major version bump (e.g. v0.X → v1.0), not a minor — STOP
        the cut, escalate, restart the cut as a major.
  - [ ] If no breaking changes, the audit conclusion is recorded in
        the release notes ("v0.X.Y → v0.X.(Y+1) is non-breaking;
        diff audit attached").
- [ ] **Per-version "Open questions" sections current.** See
      `docs/PROTOCOL_VERSION_HISTORY.md` for the convention. Specifically:
  - [ ] Items resolved by this version are marked `**Resolved.**`
        (with strikethrough on the original question text) in the older
        version's section.
  - [ ] This version gets a new `## Open questions (vX.Y)` block with
        its own concerns.
  - [ ] Items deferred to vX.(Y+1) are explicitly named.
- [ ] `spec/<schema>.json` files validate against their canonical
      `examples/` round-trip via `@codecai/maps-cli` (or the equivalent
      per-schema CLI).
- [ ] `WELL_KNOWN_DISCOVERY.md` accurate for any new well-known paths.
- [ ] `PIPELINES.md` accurate for any new transform pipelines.

### 5 · READMEs

- [ ] Top-level `README.md` — release banner, headline numbers from this
      release's bench, "Latest release: vX.Y" badge.
- [ ] Per-package READMEs (`packages/*/README.md`):
  - [ ] Quick-start example uses the version being released.
  - [ ] Wire-shape callouts reflect the version being released
        (e.g. v0.3.2 per-block `_meta` vs v0.3.0 sibling `_codec_meta`).
  - [ ] Public API surface matches what's exported in the version
        being released.
- [ ] `codec-supervisor/README.md` — backend list, image tags,
      classifier extras + how to install them.
- [ ] `packages/bench/README.md` — current results table; "v0.X.x lab
      results (committed)" section indexes new run IDs.

### 6 · codecai.net (website)

- [ ] Headline numbers on the home page match `packages/bench/RESULTS.md`
      for this release.
- [ ] `/protocol-map` SVG matches `spec/versions/v0.X.md` mermaid
      diagrams for the version being released.
- [ ] Per-package install snippets show this version.
- [ ] "Latest release" banner / changelog updated.
- [ ] Deploy procedure: `ssh william@192.168.1.198 'cd /storage/codec-website && git pull && docker compose up -d --build'`
      (per the saved memory). Confirm the deploy reflects the merged
      release branch.

### 7 · Engine forks (only if this release touches engine integration)

- [ ] vLLM fork (`wdunn001/vllm`) `main` branch built + smoke-tested.
- [ ] sglang fork (`wdunn001/sglang`) `main` branch built + smoke-tested.
- [ ] llama.cpp fork (`wdunn001/llama.cpp`) `master` branch built.
- [ ] metamcp + ComfyUI + diffusers forks (still on feature branches per
      saved memory) — release-tagged or branch-pinned for the
      `codec-supervisor` Dockerfiles to consume.

### 8 · Release-cut commit

- [ ] All `feat/*` branches that contributed to this release are merged
      to `main` on Codec.
- [ ] All `feat/*` branches that contributed are merged to `main` on
      `codec-supervisor`.
- [ ] Each cut commit has a non-trivial CHANGELOG / release-notes entry
      summarizing user-facing changes (not just commit subjects).
- [ ] No work-in-progress dirty trees on either repo at cut time.

---

## Publish phase

Run **only** when every pre-publish box above is ticked or struck.

### 9 · Tags

- [ ] Annotated tag `vX.Y` on Codec `main`, message includes the
      release-notes summary.
- [ ] Annotated tag `vX.Y` on `codec-supervisor` `main` matching the
      Codec tag.
- [ ] `git push --tags` to both repos.

### 10 · Package publishes

Each step has its own credentials; run one at a time so a failure halts
the cascade rather than fanning out broken artifacts.

- [ ] **npm**: `@codecai/web`, `@codecai/web-safety`, `@codecai/maps-cli`
      (`npm publish --access public` per package). Verify visible on
      `https://www.npmjs.com/package/<name>` before continuing.
- [ ] **PyPI**: `codecai` (`python -m build && twine upload dist/*` or
      via the GitHub Actions OIDC publisher if wired). Verify on
      `https://pypi.org/project/codecai/`.
- [ ] **crates.io**: `codec-rs` (`cargo publish` from
      `packages/rust/`). Verify on `https://crates.io/crates/codec-rs`.
- [ ] **NuGet**: `Codec.Net` (`dotnet pack -c Release && dotnet nuget
      push`). Verify on `https://www.nuget.org/packages/Codec.Net`.
- [ ] **Maven Central**: `io.github.wdunn001:codec` (`mvn deploy -P
      release` with the configured Sonatype + GPG creds). Verify in
      Sonatype staging → release → search.maven.org propagation (can
      take 10-60 min).
- [ ] **libcodec** (no formal package manager): the `vX.Y` git tag is
      itself the artifact; verify a fresh `FetchContent_Declare(... GIT_TAG vX.Y)`
      smoke-builds + tests in a throwaway project.

### 11 · Docker Hub publishes

`codec-supervisor` ships images for each engine fork.

- [ ] `docker buildx` build (multi-arch where it makes sense) and push
      `:vX.Y` + `:latest` tags for:
  - [ ] `wdunn001/codec-vllm:vX.Y`
  - [ ] `wdunn001/codec-sglang:vX.Y`
  - [ ] `wdunn001/codec-llamacpp:vX.Y`
  - [ ] `wdunn001/codec-metamcp:vX.Y`
  - [ ] `wdunn001/codec-comfyui:vX.Y`
  - [ ] `wdunn001/codec-diffusers:vX.Y`
  - [ ] `wdunn001/codec-time-leaf:vX.Y`
- [ ] Each pushed image's `latest` tag points at the new `vX.Y`.
- [ ] `compose.yml` references in `codec-supervisor` updated to the
      new image tags.

### 12 · Website publish

- [ ] `codec-website` rebuild + redeploy after the package + Docker
      pushes complete (so the install snippets resolve to existing
      artifacts).
- [ ] Sanity click-through: home page benches load, per-language
      install pages link to the right registry URL, `/protocol-map`
      renders the right mermaid.

---

## Post-publish

- [ ] **Install smoke tests** from a clean machine (or `docker run` in
      a vanilla image): `npm i @codecai/web@X.Y` works; `pip install
      codecai==X.Y`; `cargo add codec-rs@X.Y`; `dotnet add package
      Codec.Net --version X.Y`; Maven dependency resolves.
- [ ] **End-to-end lab smoke**: a vLLM container running
      `wdunn001/codec-vllm:vX.Y` answers a `/v1/completions/codec`
      request, the wire matches `spec/versions/v0.X.md`, and a
      Python client of
      `codecai==X.Y` decodes the stream cleanly.
- [ ] **Announce**: GitHub release notes draft (auto-generated from
      tag + manual additions), published.
- [ ] **Roll the release-issue forward**: open the `release: v(X.Y+1)`
      issue with this checklist pre-pasted; close the current one.

---

## Roles, who-runs-what

This is a single-maintainer project today; everything in the checklist
is run by the maintainer or a CI job they configured. The list above
intentionally enumerates the *steps*, not the actors, so as the
project grows the assignment column can be added without the gates
themselves changing.

---

## When the checklist is wrong

If a checklist gate is impossible to satisfy for a legitimate reason
(e.g. a downstream service is down, a benchmark machine is
unavailable), edit this file in the same PR that proposes the
exception, with a "[v0.4] gate-skip: reason" line. Don't normalize
"skip the gate" — normalize "the document changed because the gate's
contract changed."
