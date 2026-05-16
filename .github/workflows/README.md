# Codec — release-publish workflows

Five workflows in this directory handle the §10 Package Publish phase
of the [release checklist](../../docs/RELEASE_CHECKLIST.md). Each one
fires on a `v*` tag push *and* supports manual trigger via
`workflow_dispatch` so you can republish a single package without
re-tagging the whole repo.

The companion Docker publishes (`§11`) live in
`codec-supervisor/.github/workflows/release.yml` (already wired
since v0.3.x).

## Files

| Workflow | Publishes | Required secrets |
|---|---|---|
| `publish-npm.yml` | `@codecai/web`, `@codecai/web-safety`, `@codecai/maps-cli` | `NPM_TOKEN` |
| `publish-pypi.yml` | `codecai` | OIDC (see file header) or `PYPI_API_TOKEN` |
| `publish-cargo.yml` | `codec-rs` | `CARGO_REGISTRY_TOKEN` |
| `publish-nuget.yml` | `Codec.Net` | `NUGET_API_KEY` |
| `publish-maven.yml` | `io.github.wdunn001:codec` | `MAVEN_USERNAME`, `MAVEN_CENTRAL_TOKEN`, `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE` |

## How to cut a release

1. Tag both repos: `git tag v0.X.Y && git push origin v0.X.Y` on
   `Codec` and `codec-supervisor`.
2. All five workflows here fire automatically (on tag push).
   codec-supervisor's `release.yml` fires in parallel for the
   Docker images.
3. Monitor the Actions tab; if any one fails, retrigger just that
   workflow via `workflow_dispatch` after fixing the issue.
4. Manual partial retrigger: from the Actions tab, choose
   `publish-npm` → "Run workflow" → pick the package. Same for the
   other registries (each accepts no input, but you can re-run on
   the same tag).

## Why one workflow per registry, not one big "release.yml"?

A registry-specific failure (e.g. a transient PyPI 500 mid-upload)
shouldn't force a retag of the entire release. Per-target workflows
let each one retry independently against the same tag.

## v0.4 cut: status

The five workflows landed at v0.4 cut time but require the corresponding
secrets to be added under repo Settings → Secrets and variables →
Actions. Until those are set, the workflows will fail at the
"Publish" step with a "no credentials" error and the rest of the
build remains valid as a CI signal.

For the v0.4.1 cut specifically:
- Tags `v0.4.1` pushed on `Codec` and `codec-supervisor`.
- Docker images: built + pushed by `codec-supervisor/release.yml`
  (uses `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN`); 4 small images via
  the supervisor workflow + 3 large engine images built locally and
  pushed by hand (codec-{sglang,vllm,llamacpp}:v0.4.1).
- npm / PyPI / crates.io / NuGet: secrets configured; all 5 npm packages
  + codecai + codec-rs + Codec.Net publish workflows green at v0.4.1.
  npm workflow is idempotent — re-running with `package=all` is safe
  (existing versions skip-if-exists). Maven Central (`ai.codec:codec`)
  deferred at v0.4.1; revisits at v0.4.2.
