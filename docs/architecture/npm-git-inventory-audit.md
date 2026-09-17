# NPM ↔ Git Inventory Audit

**Date:** 2026-09-17 (rev. 3)
**Branch:** `c21.4-physically-extract-analysis-from-backend`
**Scope:** `packages/` directory

> **Rev. 3 — `@animastor/installer` published.** The installer package was brought up to the
> common `@animastor/*` publication standard (`"private": true` removed; `publishConfig.access`,
> `files`, `exports`, `license`, `repository`, `bugs`, `homepage` added; LICENSE added; `ai/`
> install-manifest data included in the tarball) and published to npm as a **public** scoped
> package, version `0.1.0` — the current Git version, unmodified. Verified via `npm view`:
> latest `0.1.0`, tarball sha256-matching the locally packed artifact
> (`6a49f0818aef6dd5741a3ea28e62ddd61a5729f1`), anonymously downloadable (public access).
>
> **Rev. 2 — corrections.** The first revision of this audit (2026-09-16) misclassified
> `packages/animastor-worker/` as a tooling directory without a `package.json` and listed the npm
> package `animastor-worker` as "Published but not in Git". Both claims were wrong:
>
> 1. `packages/animastor-worker/worker/` **does contain** a `package.json`
>    (`name: "animastor-worker"`, `version: "2.1.1"`). The bundle uses a nested layout
>    (`packages/animastor-worker/worker/` is the npm package root); the sibling `tools/`, `tests/`,
>    and `image/` directories are package-owned tooling, not the package itself.
> 2. Git history proves the package is part of the current Animastor architecture: commit
>    `acafe15e` (2026-09-06, "feat(worker): prepare animastor-worker@2.1.0 for public npm release")
>    and commit `9f6b5808` (2026-09-07, "Move worker into packages/animastor-worker") moved the
>    whole root-level `worker/` tree into `packages/` (36 rename pairs, `R100` for the package
>    files).
> 3. The npm package `animastor-worker@2.1.1` matches this Git package exactly: repository URL
>    `github.com/Animastor/animastor.git`, identical description, versions `2.1.0` (published
>    2026-09-06) and `2.1.1` (published 2026-09-07) align with the commits above. It is **not** an
>    unrelated legacy package.

---

## Summary

| Metric | Count |
|--------|-------|
| Directories in `packages/` | 28 |
| Directories with a `package.json` | 28 |
| &nbsp;&nbsp;└ nested npm package | 1 (`animastor-worker`, nested at `packages/animastor-worker/worker/`) |
| &nbsp;&nbsp;└ Non-package inner `package.json` (not a workspace package) | 1 (`packages/animastor-worker/image/worker/package.json`, legacy docker fixture) |
| Top-level `packages/*/package.json` | 27 |
| Private / not for NPM (`"private": true`) | **0** |
| **Published & version-matched (MATCH)** | **28 / 28 publishable packages (100%)** |
| Published but not in Git | **0** |
| In Git but not on NPM | **0** |
| NOT_PUBLISHED (publishable Git package with no npm counterpart) | **0** |

**Notes on the counts**

- 28 directories; 27 have a top-level `package.json`. The 28th (`animastor-worker/`) has its
  `package.json` one level deeper, in `worker/`.
- All 28 directories contain a publishable npm package and all 28 exist on npm with their exact
  Git version published as `latest`.
- The npm-registry view contains **exactly 28 packages**, all of them present in Git — there are
  no npm packages without a Git counterpart.
- The nested `packages/animastor-worker/image/worker/package.json` (`name: "worker"`, version
  `0.1.0`) is a legacy docker-image fixture; it is not a workspace package and is not published.

---

## Detailed Table

| Git package (dir) | npm name | Git version | NPM exists | NPM latest | Current version published | Status |
|--------------------|----------|-------------|------------|------------|---------------------------|--------|
| `animastor-ai-agent` | `@animastor/ai-agent` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-ai-analysis` | `@animastor/ai-analysis` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-ai-connector` | `animastor-ai-connector` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-assistant` | `@animastor/assistant` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-comfyui-workflow-connector` | `animastor-comfyui-workflow-connector` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-contracts` | `@animastor/contracts` | 0.1.1 | ✅ | 0.1.1 | ✅ | **MATCH** |
| `animastor-editor` | `@animastor/editor` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-generation` | `@animastor/generation` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-gpu-hub` | `@animastor/gpu-hub` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-installer` | `@animastor/installer` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** (published 2026-09-17) |
| `animastor-orchestration` | `@animastor/orchestration` | 0.1.1 | ✅ | 0.1.1 | ✅ | **MATCH** |
| `animastor-parser` | `@animastor/parser` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-player` | `@animastor/player` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-vbook-runtime` | `@animastor/vbook-runtime` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-ai-chat` | `@animastor/web-ai-chat` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-book-session` | `@animastor/web-book-session` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-editor` | `@animastor/web-editor` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-file` | `@animastor/web-file` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-generator` | `@animastor/web-generator` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-generator-config` | `@animastor/web-generator-config` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-generator-sse` | `@animastor/web-generator-sse` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-generator-vbook` | `@animastor/web-generator-vbook` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-local-ai` | `@animastor/web-local-ai` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-navigator` | `@animastor/web-navigator` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-player` | `@animastor/web-player` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-settings` | `@animastor/web-settings` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-workers` | `@animastor/web-workers` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-worker/worker` (nested) | `animastor-worker` | 2.1.1 | ✅ | 2.1.1 | ✅ | **MATCH** |

---

## Package taxonomy (three distinct categories)

| Category | What it is | Items |
|----------|-----------|-------|
| **Git package** | A publishable npm package under `packages/` with its own `package.json` | 28 (26 top-level + `animastor-worker` nested at `packages/animastor-worker/worker/` + `@animastor/installer`) |
| **Git tooling directory** | Directory inside a package that carries scripts/tests/fixtures but **no** package root of its own | `packages/animastor-worker/{tools,tests,image,new}` + loose `*.sh` (package-owned tooling of `animastor-worker`) |
| **NPM package not in the monorepo** | Published npm package with no corresponding directory in `packages/` | **None.** The npm package `animastor-worker` **is** the Git package `packages/animastor-worker/worker/` |

---

## `animastor-worker`: resolution of the rev. 1 discrepancy

Evidence that the npm package `animastor-worker` and the Git directory `packages/animastor-worker/`
are the same package:

| Evidence | Value |
|----------|-------|
| Git `packages/animastor-worker/worker/package.json` | `name: "animastor-worker"`, `version: "2.1.1"` |
| npm registry `animastor-worker` | latest `2.1.1` (versions: `2.1.0`, `2.1.1` only) |
| npm `repository.url` | `git+https://github.com/Animastor/animastor.git` (directory `packages/animastor-worker/worker`) |
| npm `description` | byte-identical to the Git `package.json` description |
| npm publish dates | `2.1.0` → 2026-09-06, `2.1.1` → 2026-09-07 |
| Git history | `acafe15e` (2026-09-06) "prepare animastor-worker@2.1.0 for public npm release"; `9f6b5808` (2026-09-07) "Move worker into packages/animastor-worker" |
| Origin | Root-level `worker/` package (created in the June 2026 recovery, npm-released 2026-09-06), physically moved into `packages/` on 2026-09-07 |

**Conclusion:** `animastor-worker` is a first-class, currently published Animastor package. Its
unscoped name and its `2.1.1` version line (independent of the monorepo `0.1.x` line) are
intentional: the bundle is a standalone GPU compute agent distributed via npm and via the hub
artifact, and its version field is the canonical worker bundle version (see
`packages/animastor-worker/README.md`). It was **not** renamed to `@animastor/worker`, and it was
**not** unpublished. Renaming would break `npm install animastor-worker` for existing GPU operators.

---

## `@animastor/installer`: publication (rev. 3)

The package was prepared for publication and published on 2026-09-17:

| Step | Result |
|------|--------|
| `"private": true` | removed from `package.json` |
| `publishConfig.access` | set to `"public"` (scoped package) |
| `files` | `src/`, `ai/` (install-manifest data — runtime dependency of `MANIFEST_ROOT`), `README.md`, `LICENSE` |
| `exports` | `".": "./src/installer/index.js"` (in addition to `main`) |
| `license` / `LICENSE` | MIT; LICENSE file added (was missing in the package directory) |
| `repository` / `bugs` / `homepage` | `github.com/Animastor/animastor.git` (`directory: packages/animastor-installer`), repo issues, `https://animastor.in` |
| `file:` dependencies | none in the package itself (the `file:` reference lives in `backend/package.json`, which consumes the package from the repo checkout — that is a workspace setup, not a publication defect) |
| Version | `0.1.0` — current Git version, **not** bumped |
| Architecture | unchanged; no API changes; no renames; no new packages |
| Checks | `npm test` → 304 passing; `node --check` on all `src/**/*.js` → OK; `npm pack --dry-run` → 37 files, 160.5 kB, no `tests/`, `node_modules/`, `package-lock.json`, no secrets |
| Publication | `@animastor/installer@0.1.0`, public access |
| Post-publish verification | `npm view @animastor/installer` → latest `0.1.0`; dist tarball shasum `6a49f0818aef6dd5741a3ea28e62ddd61a5729f1` matches the locally packed artifact; tarball anonymously downloadable → public access confirmed |

The tarball intentionally ships `ai/install-manifests/` (3 JSON profiles): the CLI resolves its
manifest root via `path.join(__dirname, '..', '..', 'ai', 'install-manifests')` as the documented
package-relative fallback — without this data an installed package could not resolve manifests.
Repo-only paths (`backend/ai/workflows`, worker bundle source) remain host-side probes with
container/repo fallbacks and are not part of the tarball.

---

## Private / Workspace packages (not counted as errors)

**None.** As of rev. 3 there are no private or workspace-only packages left: `@animastor/installer`
was the last one and is now published (see above).

---

## Unscoped package names (current state — recorded, not changed)

Three public packages use unscoped npm names instead of `@animastor/*`; this is the current
intended state:

| Package | npm name | Published | Note |
|---------|----------|-----------|------|
| `animastor-ai-connector` | `animastor-ai-connector` | 0.1.0 ✅ | Distributed as a standalone CLI (`bin` entry) to machines outside the Animastor workspace; an unscoped name is friendlier for standalone `npm install` usage. |
| `animastor-comfyui-workflow-connector` | `animastor-comfyui-workflow-connector` | 0.1.0 ✅ | Published under the unscoped name in the current state; no renaming instruction exists. |
| `animastor-worker` (nested at `animastor-worker/worker/`) | `animastor-worker` | 2.1.1 ✅ | Unscoped intentionally: standalone GPU operators run `npm install animastor-worker` (documented in the package README). |

**Decision:** no automatic renaming was performed and none is recommended in this audit; any future
migration to `@animastor/*` must preserve the published names (deprecate + new major) and is out of
scope here.

---

## NOT_PUBLISHED packages

**None.** Every publishable Git package — 28 of them — has its exact current version published on
npm as `latest`.

---

## Notes

1. **No version mismatches.** Every Git package that exists on npm has its exact Git version
   published as `latest` (verified field-by-field on 2026-09-17 via `npm view`).
2. **`packages/animastor-worker/image/worker/package.json`** (`name: "worker"`, version `0.1.0`,
   ISC license) is a legacy docker-image fixture that predates the zero-dependency bundle. It is
   not a workspace package, is not installed by anything, and must not be published. Recorded here
   so future inventory scans do not mistake it for a missing/extra package.
3. **Verification commands used** (reproducible):

   ```sh
   find packages -maxdepth 3 -name package.json -not -path "*/node_modules/*"
   npm view <name> version           # for every package name above
   npm view @animastor/installer     # → latest 0.1.0, public, shasum-matched tarball
   npm view animastor-worker time --json   # publish dates align with git history
   git log --follow -- packages/animastor-worker
   cd packages/animastor-installer && npm test && npm pack --dry-run
   ```

---

## Git

```
Branch: c21.4-physically-extract-analysis-from-backend
Commit: <will be filled after commit>
```
