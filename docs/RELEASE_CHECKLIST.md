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

### 1.5 · Prior-version wire compatibility

Complements the static §4 diff audit with a dynamic round-trip
against every prior minor version still in scope. The versioning
policy (`spec/versions/v0.4.md` § Versioning Policy) requires
minor releases to be wire-compatible with all earlier minor
versions of the same major — this gate is where we actually run
that.

Fixtures live at `spec/compat-corpus/v0.X/`, one subtree per
prior minor version, with three flavors:

- `maps/` — tokenizer-map JSONs as published in v0.X (one per
  reference vocab), pinned by `sha256` in
  `compat-corpus/v0.X/maps.manifest.json`.
- `frames/` — canonical wire frames for every frame type the
  version added (text-token msgpack/protobuf for v0.2; latent
  streams + `_codec_meta` blocks for v0.3; safety-policy
  descriptors for v0.4). Stored as `.bin` files with a sibling
  `.json` describing expected decode output.
- `descriptors/` — well-known JSON documents the version
  introduced (latent-space-map, safety-policy, tokenizer-map
  with `tool_calling` block, etc.).

If `spec/compat-corpus/v0.X/` doesn't exist for a shipped prior
version, the FIRST release that adds the gate creates it from
that version's tagged release artifacts and pins the hashes
forward.

For each shipped prior version (today: **v0.2, v0.3**):

- [ ] **Decode-forward:** every fixture in
      `spec/compat-corpus/v0.X/frames/` decodes cleanly with the
      release-candidate library in all six languages. Decoded
      shape matches the sibling `.json` byte-for-byte (frame
      type, token IDs, header fields, control IDs). No silent
      field drops, no panics on unknown future fields.
- [ ] **Encode-backward:** the release-candidate encoder, when
      negotiated down to the prior version's capability set
      (`accept_codec_version: v0.X` in HELLO, no v0.X+1 axes
      enabled), produces frames that the **prior version's**
      published library decodes successfully. Run with the prior
      version's npm tarball / PyPI wheel / NuGet package / etc.
      pulled from each registry — not a local checkout. (The
      first release that adds this gate may need to pin a Docker
      image carrying the older clients; record the digest.)
- [ ] **Schema-forward:** every JSON document in
      `spec/compat-corpus/v0.X/maps/` and
      `compat-corpus/v0.X/descriptors/` validates against the
      release-candidate's schemas (`spec/*.schema.json`). The
      version-tightening rule from §4 (no enum tightening, no
      previously-optional → mandatory) makes this an invariant —
      a fixture failure means the version is breaking and should
      be a major bump.
- [ ] **Discovery-forward:** every `.well-known/codec/*` path
      shipped in v0.X still resolves under the release-candidate
      discovery code path (404 means the path was removed —
      breaking — and the release should be a major bump).
- [ ] **Version-incompatibility signaling:** for any new
      mandatory feature this release adds, a release-candidate
      server CONFIGURED to require that feature returns a
      structured `426 Upgrade Required` (HTTP transport) or
      `VERSION_INCOMPATIBLE` frame (session protocol) to a
      `Codec-Client-Version: 0.X` client where `0.X < this
      release`. See `spec/versions/v0.4.md § Version
      Compatibility Signaling`. The 426 body parses cleanly as
      JSON with the documented fields, AND degrades to a
      renderable string for v0.3-and-older clients that don't
      know the field shape. `.well-known/codec/version-policy.json`
      matches runtime behavior (mismatch = deployment bug).
- [ ] **Default-off conformance (opt-on):** a release-candidate
      server SHIPS with every new-in-this-version capability
      DISABLED. Spin up a fresh server with default config; the
      response to a v0.X (current-version) client MUST be byte-
      equivalent to what a v0.(X-1) server would have returned
      (modulo timestamps + HPACK). No version-N headers, no
      version-N axes, no 426. See `spec/versions/v0.4.md §
      Capabilities are opt-on at the server`.
- [ ] **Graceful downgrade conformance:** with the new
      capabilities ENABLED but not enforced, a v0.(X-1) client
      hitting the same server MUST still see a v0.(X-1) wire
      surface — no version-N headers leak. Re-run the
      decode-forward step above with `Codec-Client-Version: 0.(X-1)`
      against an opted-in server; the response set MUST be
      identical to the v0.(X-1) corpus (modulo timestamps).
- [ ] Results recorded in
      `packages/bench/results/<release-UTC>/compat/v0.X.md`
      (per prior version): cell-by-cell pass/fail, decoder
      version under test, fixture hash list. Each cell is one of
      pass / fail / skipped-with-reason; no silent skips.

Hard-gate the publish phase. A failed cell means the release
either degrades to a patch (no wire change) or escalates to a
major bump.

### 1.7 · Zstd dictionary availability (v0.5+)

Added after the v0.4.1 sglang regression where an upstream merge
silently dropped the `COPY dicts/` line in the engine Dockerfile and
zstd compression quietly degraded to identity bytes at runtime — caught
only by the cross-stack bench cohort flagging anomalous wire sizes.
v0.5 promotes the zstd dictionary to a first-class discoverable
artefact (`.well-known/codec/dicts/<sha>.zstd`, see
`spec/WELL_KNOWN_DISCOVERY.md` § Zstd dictionaries) and adds this
gate to make dictionary drift a release-blocker rather than a
silent runtime degradation.

For every engine image cut at v0.5+ (`wdunn001/codec-{sglang,vllm,llamacpp}:vX.Y`):

- [ ] **Dict reachability** — image MUST satisfy at least one of:
  - Bakes `/opt/codec/dicts/msgpack-v1.zstd` AND `/opt/codec/dicts/protobuf-v1.zstd`
    into the layer at build time (legacy path), OR
  - Has `CODEC_ZSTD_DICT_MSGPACK_URL` AND `CODEC_ZSTD_DICT_PROTOBUF_URL`
    configured in the deploy environment (URL path). The URLs MUST resolve
    to a 200, the bytes MUST hash to the `<hex>` in the URL path
    component, and the engine MUST hard-fail boot if either fails.
- [ ] **Probe at container startup** — `docker run --rm <image>
      /opt/codec/check-dict-availability.sh` exits 0. The script
      verifies the active dict registry (whether baked or fetched)
      has both `msgpack` + `protobuf` entries with non-zero byte
      length.
- [ ] **Wire-level confirmation in the bench** — for each engine,
      §1b cell at 2K tokens with `Accept-Encoding: zstd` MUST hit a
      dict-zstd code path (`Codec-Zstd-Dict: sha256:<short>` in
      response headers). A response with `Content-Encoding: zstd`
      but no `Codec-Zstd-Dict:` header means the dict didn't load
      and zstd silently fell back to dict-less zstd — release-blocker.
- [ ] **Hash unanimity** — every engine in the cohort serving the
      same model MUST announce the same `Codec-Zstd-Dict:` sha
      (modulo deliberately-different dicts for engines that train
      their own — record any divergence in the release notes).

Missing the gate = release-blocker, same severity as a missing
test suite. The whole point is that silent degradation is not
acceptable for any release that markets zstd numbers.

### 1.9 · Engine image protocol-critical dep audit (v0.5+)

Added at v0.5 after **two** silent dep regressions surfaced during the
v0.5 cut:

1. `wdunn001/codec-sglang:v0.5.0` first attempt lost `brotli` +
   `zstandard` because the `FROM lmsysorg/sglang:latest` base
   silently dropped them between v0.4.1 and v0.5 builds. Engine
   degraded to identity-encoded responses without warning.
2. `wdunn001/codec-llamacpp:v0.5.0` first attempt was MISSING
   `brotli` + `zstandard` + `msgpack` ENTIRELY because the Dockerfile
   only installed them transitively via `codec-supervisor`, whose
   `pyproject.toml` had never declared them as direct deps —
   they'd been coming along by accident from upstream lmsysorg
   images for two releases.

Both regressions would have been caught earlier by these gates:

- [ ] **Dockerfile static audit** — every engine Dockerfile (sglang,
      vllm, llamacpp, comfyui, diffusers) MUST EXPLICITLY install
      `brotli`, `zstandard`, `msgpack` either:
  - As named args on its own `pip install` line, OR
  - Via `pip install codec-supervisor` where codec-supervisor's
    `pyproject.toml` declares all three as direct dependencies
    (belt + suspenders: do both).
  - Run `grep -rE 'brotli|zstandard|msgpack' codec-supervisor/Dockerfile.*
    codec-docker/Dockerfile codec-supervisor/pyproject.toml` and
    verify each engine's path has the deps named explicitly.
- [ ] **Built-image dep verification** — after each engine image
      builds, BEFORE pushing or running engine-acceptance pytest:

      docker run --rm --entrypoint python3 wdunn001/codec-<engine>:vX.Y \
        -c "import brotli, zstandard, msgpack; print(brotli.__version__,
            zstandard.__version__, msgpack.version)"

      MUST exit 0 with three version strings printed. Catches both
      "Dockerfile changed under us silently" AND "install succeeded
      but module is broken in this Python env". Wire-format protocol
      modules are NOT optional — a missing module degrades the engine
      to identity-encoded silently, which is exactly the regression
      class this gate exists to prevent.
- [ ] **Source-of-truth pin** — codec-supervisor's `pyproject.toml`
      lists `msgpack`, `brotli`, `zstandard` under `dependencies`
      (NOT optional-dependencies, NOT extras). Confirm before tag
      cut. If a future supervisor release drops one, this gate fires
      at the next engine build.

Missing the gate = release-blocker. Silent fallthrough to identity
on a Codec response is the worst possible failure mode — clients
think they got Codec, byte counts match the "best Codec" numbers
the website advertises, but the wire is identity bytes. Indistinguishable
from a correct Codec response from the client side until someone
runs a comparison bench.

### 1.8 · Root `RESULTS.md` pointer refresh

Added at v0.5 after the v0.4.1 post-mortem caught that the
top-level `RESULTS.md` was 4 releases stale (still pointed at the
v0.3 bench results directory). The root file is the single most
linked-to artefact from external pages (LinkedIn article, README
headlines, third-party blog posts). Drift here is a credibility
hit out of proportion to its content.

- [ ] Root `RESULTS.md` pointer URL bumped to the current
      cohort's `packages/bench/results/<UTC>/MATRIX.md`.
- [ ] Headline-numbers table in §"Headline numbers from the vX.Y
      cohort" reflects the current cohort's §1b best cells per engine.
- [ ] §"What's new in vX.Y" section regenerated from the release
      notes draft.
- [ ] §"Agent-loop end-to-end" table refreshed if agent-loop benches
      ran this cohort.
- [ ] `packages/bench/RESULTS.md` §10 Headlines table re-rendered
      from the same source — drift between root and packages
      means one was edited by hand.

### 2 · Coverage

- [ ] Coverage % per language, captured in `packages/*/COVERAGE.md` (or
      equivalent per-package report). No regression vs. previous release.
- [ ] Anything intentionally uncovered is documented (e.g. "default
      classifier factory paths run only with weights present").

### 3 · Benchmarks

**Engine image acceptance (gate-before-bench).** Added after the v0.4.1
post-mortem caught a stale-Dockerfile regression that the bench's
headline aggregator surfaced only by accident. Every engine image
swapped into the bench harness MUST pass these four probes BEFORE
`bench/scripts/run-matrix.sh` is invoked. The probes take ~15s total
per engine and catch the entire "image was built from a stale tree"
regression class (missing transport-compression modules, missing zstd
dicts, supervisor admin endpoints absent, codec patch files missing).

- [ ] **Fork pytest inside the running container** — `docker exec
      <engine> python3 -m pytest /opt/codec/<engine>/python/.../test_codec_*.py`
      passes. Confirms the fork source code in the image still has
      working unit tests; if this fails the merge is damaged and the
      bench cannot help.
- [ ] **Endpoint surface probe** — `GET /openapi.json` enumerates the
      expected v0.X surface (`/codec/schema`, `/.well-known/codec/version-policy.json`,
      and operator-side `/admin/codec-policy`, `/admin/policies/*` for
      v0.4-and-later). Missing endpoints mean the supervisor in the
      image is stale.
- [ ] **Transport-compression probe** — POST a streaming completion
      with `Accept-Encoding: zstd, br, gzip, identity`. Verify the
      response `Content-Encoding` is the highest the server claims to
      support (per spec §Transport-Compression preference order). A
      silent fall-through to `identity` when `gzip` overlaps is a
      §Negotiation MUST violation and means the image's brotli/zstandard
      python modules are missing.
- [ ] **Detokenize-bypass probe** — POST with `stream_format=msgpack`,
      hex-dump the response, verify no `text` field in the msgpack
      map. Confirms the binary stream path is wired correctly per
      §Bidirectional + §Mode-A.

**Synthetic-stream bench (protocol-only headline).** Added after the
v0.4.1 post-mortem caught that engine-output ratios were content-dependent
(same prompt, T=0, three engines, three different token sequences, three
different compression ratios). The synthetic bench MUST run before the
cross-stack bench so MATRIX.md §1 is protocol-only and §1b is the
content-dependent companion. See `packages/bench/methodology/SCHEMA.md`
§ Synthetic-stream wire bench.

- [ ] `packages/bench/scripts/synthetic_wire_bench.py <UTC>` ran;
      produced `results/<UTC>/synthetic/wire.json` covering all 4
      canonical corpora × 3 sizes × 2 formats × 4 encodings.
- [ ] Synthetic numbers reviewed for sanity: uniform-random ratio is
      modest (~4-5×), low-entropy is mid (~10-20×), cyclic is high
      (>100×) — same ranges every release; significant deviations
      indicate an encoder/compressor regression.
- [ ] `packages/bench/` cross-stack run completed against the release
      candidate stack.
- [ ] Fresh result file under `packages/bench/results/<UTC>/`.
- [ ] `MATRIX.md` aggregator regenerated (must include §1 synthetic
      + §1b engine-output sections — `aggregate.py` enforces this
      ordering as of v0.4.1).
- [ ] Aggregator exited with code 0 (no errored cells per the gate
      added in v0.4.1).
- [ ] `RESULTS.md` headline numbers updated, leading with the
      protocol-only synthetic numbers and clearly labelling the
      engine-output numbers as content-dependent.
- [ ] Bench-method changes documented (see `methodology/SCHEMA.md`); no
      cell with a stale `(run_id, engine, lang)` fingerprint compared
      against a new one.
- [ ] If new modalities or classifiers shipped this version (e.g. v0.3
      added latents, v0.4 added safety): the bench surface covers them
      or has a documented "skipped, see issue #N" note.
- [ ] vs.-previous-release delta produced (text or table) for the
      release notes.

### 3.5 · Bench surface coverage (added v0.5)

The cross-stack matrix (§3 above) is one of **five** bench
surfaces. The release-gate requires every surface either be
re-run for this release OR have an explicit per-surface
invariant-based skip rationale recorded below.

Hand-wave skips (e.g. "not wire-format-sensitive") are NOT a
valid rationale — a release that bumps client packages can
regress every surface. See [[no-shortcuts-full-bench]] §"Pattern:
skipping bench surfaces" for the failure mode this gate codifies.

- [ ] **§1 synthetic wire** — `synthetic_wire_bench.py <RUN>`.
      Always re-run. Pure-library protocol numbers; produces
      `results/<RUN>/synthetic/wire.json`.
- [ ] **§3 cross-stack matrix** — `run-all-langs.sh <RUN> <engine>`
      for sglang + vllm + llama.cpp. Always re-run. Produces
      `results/<RUN>/{engine}/{lang}.json` × 18 files.
- [ ] **Per-language token-bench** —
      `run-all-token-benches.sh <RUN> <map> <corpus>`. Re-run
      when ANY client package bumped (the common case at every
      release); produces `results/<RUN>/token/{lang}.json`.
      Catches CPU regressions in tokenize/detokenize hot paths.
- [ ] **Cross-vocab translator** — `translator_bench.py <RUN>`.
      Re-run when Translator code touched. Defensible to skip
      with an explicit "Translator unchanged this release" note.
- [ ] **Agent-loop end-to-end** — mock + searxng + metamcp +
      MCP-leaf paths under `agent-loop/` in the results dir.
      Re-run when ANY of: codec_dispatcher / ToolWatcher /
      mcp-leaf SDK / metamcp container touched. **At v0.5+ this
      is the bench that exercises the bolt-on tool dispatcher
      path** — skipping it on a release that touches dispatcher
      code is a §3 gate failure.
- [ ] **MCP leaf microbench** — `extract-mcp-corpus.py` + leaf
      comparison. Re-run when mcp-leaf SDK code touched OR
      metamcp container rebuilt.

For each skip, document the invariant in the commit message AND
in the release-notes draft. "Wire-additive" alone is NOT enough
— the bench surfaces measure layers that wire-additivity does
not protect (client CPU, end-to-end dispatch correctness, etc.).

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
