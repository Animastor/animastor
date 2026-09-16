# npm Publication Readiness Audit

**Audit date:** 2026-09-16
**Scope:** all 28 module directories under `packages/` (27 with `package.json` + `animastor-worker`)
**Method:** `npm view` registry lookups (publication status), `package.json` inspection, `npm pack --dry-run`, per-package `typecheck` + `test` + `build` runs, comparison against already-published Animastor packages as the formatting/structure standard.
**Constraint honored:** nothing was published and no public package versions were changed. All findings below are recorded, not applied.

---

## 1. Module inventory (28)

Every directory under `packages/` was evaluated as a potential npm package candidate.

| # | Directory | npm name | Published | npm version |
|---|---|---|---|---|
| 1 | `animastor-comfyui-workflow-connector` | `animastor-comfyui-workflow-connector` | ✅ | 0.1.0 |
| 2 | `animastor-web-file` | `@animastor/web-file` | ✅ | 0.1.0 |
| 3 | `animastor-ai-analysis` | `@animastor/ai-analysis` | ✅ | 0.1.0 |
| 4 | `animastor-parser` | `@animastor/parser` | ✅ | 0.1.0 |
| 5 | `animastor-web-navigator` | `@animastor/web-navigator` | ✅ | 0.1.0 |
| 6 | `animastor-editor` | `@animastor/editor` | ✅ | 0.1.0 |
| 7 | `animastor-generation` | `@animastor/generation` | ✅ | 0.1.0 |
| 8 | `animastor-web-editor` | `@animastor/web-editor` | ✅ | 0.1.0 |
| 9 | `animastor-installer` | `@animastor/installer` | ✅ (extracted) | 0.1.0 |
| 10 | `animastor-orchestration` | `@animastor/orchestration` | ✅ | 0.1.1 |
| 11 | `animastor-web-generator-vbook` | `@animastor/web-generator-vbook` | ❌ | 0.1.0 (local) |
| 12 | `animastor-web-generator` | `@animastor/web-generator` | ❌ | 0.1.0 (local) |
| 13 | `animastor-gpu-hub` | `@animastor/gpu-hub` | ✅ | 0.1.0 |
| 14 | `animastor-web-generator-config` | `@animastor/web-generator-config` | ❌ | 0.1.0 (local) |
| 15 | `animastor-web-player` | `@animastor/web-player` | ✅ | 0.1.0 |
| 16 | `animastor-vbook-runtime` | `@animastor/vbook-runtime` | ✅ | 0.1.0 |
| 17 | `animastor-web-local-ai` | `@animastor/web-local-ai` | ✅ | 0.1.0 |
| 18 | `animastor-web-settings` | `@animastor/web-settings` | ✅ | 0.1.0 |
| 19 | `animastor-ai-agent` | `@animastor/ai-agent` | ✅ | 0.1.0 |
| 20 | `animastor-ai-connector` | `animastor-ai-connector` | ✅ | 0.1.0 |
| 21 | `animastor-web-workers` | `@animastor/web-workers` | ✅ | 0.1.0 |
| 22 | `animastor-player` | `@animastor/player` | ✅ | 0.1.0 |
| 23 | `animastor-web-generator-sse` | `@animastor/web-generator-sse` | ❌ | 0.1.0 (local) |
| 24 | `animastor-contracts` | `@animastor/contracts` | ✅ | 0.1.1 |
| 25 | `animastor-assistant` | `@animastor/assistant` | ✅ | 0.1.0 |
| 26 | `animastor-web-book-session` | `@animastor/web-book-session` | ❌ | 0.1.0 (local) |
| 27 | `animastor-web-ai-chat` | `@animastor/web-ai-chat` | ✅ | 0.1.0 |
| 28 | `animastor-worker` | — (no `package.json`) | ❌ | — |

**Summary: 28 checked · 22 published · 6 not published (5 packages + 1 not-yet-packaged directory).**

Note on `@animastor/installer`: the `package.json` in the repo still carries `"private": true` and has no `LICENSE` file, but `npm view` reports 0.1.0 published on the registry. The local manifest is out of sync with the published artifact — publish metadata should be reconciled separately (out of scope for this audit's fixes).

---

## 2. Reference standard (derived from published packages)

Two published archetypes are used as the formatting/structure reference:

**A. Plain-JS backend/domain packages** (reference: `@animastor/vbook-runtime`, `@animastor/editor`, `@animastor/generation`):
- `name`, `version`, rich `description`, `keywords`
- `main` + `exports` map (multiple subpath exports where applicable)
- `files`: `src/`, `README.md`, `LICENSE` (+ `CHANGELOG.md` where present)
- `engines: node >=18`, `license: MIT`, `publishConfig.access: public`
- `repository` (git URL + `directory`), `bugs`, `homepage`
- mocha/chai test suite, no `private` flag

**B. Preact/TS web packages** (reference: `@animastor/web-settings`, `@animastor/web-ai-chat`, `@animastor/web-file`):
- `type: module`, `main`/`module` → `dist/index.js`, `types` → `dist/index.d.ts`
- `exports` map with `types`/`import`/`default` conditions + `./package.json`
- `files`: `dist`, `README.md`, `LICENSE`
- `sideEffects: false`, tsup build (`dts: true`), `typecheck` (tsc --noEmit), vitest
- `prepublishOnly: typecheck && test && build`
- `peerDependencies` for preact/`@preact/signals` (only when Preact is actually used at runtime)
- `publishConfig.access: public`, `repository`, `bugs`, `homepage`

Registry cross-check: published `@animastor/*` packages carry `dist/` + `.d.ts` tarballs, and published manifests do **not** contain `file:` deps (e.g. published `@animastor/vbook-runtime` depends on `tinyld`/`adm-zip` only, while the repo manifest has `@animastor/parser: file:../animastor-parser`). Registry-publish flow therefore swaps `file:` → registry versions at publish time.

---

## 3. Unpublished package audits

### 3.1 `@animastor/web-generator` — READY ✅

| Check | Result |
|---|---|
| package.json fields (name/version/description/keywords/license MIT/publishConfig) | ✅ complete |
| main/module/types/exports (dist + types condition + ./package.json) | ✅ |
| files whitelist (`dist`, `README.md`, `LICENSE`) | ✅ |
| README.md | ✅ present (4.4 kB) |
| TypeScript declarations (tsup dts) | ✅ `dist/index.d.ts` |
| dependencies / peerDependencies | ✅ zero runtime deps (pure domain logic; preact correctly absent) |
| `file:`/local deps | ✅ none |
| typecheck / test / build | ✅ 5 files, 69 tests pass; DTS build success |
| `npm pack --dry-run` | ✅ 6 files, 25.1 kB — LICENSE, README, dist/index.{js,d.ts,js.map}, package.json; no junk/secrets |
| prepublishOnly gate | ✅ present |

### 3.2 `@animastor/web-generator-vbook` — NEEDS_FIX ⚠️

| Check | Result |
|---|---|
| package.json fields | ✅ complete (name/version/description/keywords/license MIT/publishConfig) |
| main/module/types/exports | ✅ |
| README.md | ❌ **missing** — violates the standard of all published web packages; `files` lists `README.md`, so the tarball ships without any readme |
| dependencies | ❌ `"@animastor/web-generator": "file:../animastor-web-generator"` — a `file:` dependency cannot be published; must be replaced with `"^0.1.0"` once `@animastor/web-generator` is on the registry (a transitive web package) |
| typecheck / test / build | ✅ 2 files, 40 tests pass; DTS build success |
| `npm pack --dry-run` | ✅ 5 files, 10.1 kB — clean, but README absent |
| prepublishOnly gate | ✅ present |

### 3.3 `@animastor/web-generator-config` — NEEDS_FIX ⚠️

| Check | Result |
|---|---|
| package.json fields | ✅ complete |
| main/module/types/exports | ✅ |
| README.md | ❌ **missing** — tarball ships without readme |
| dependencies / peerDependencies | ✅ zero (pure functions; preact correctly absent) |
| `file:`/local deps | ✅ none |
| typecheck / test / build | ✅ 2 files, 22 tests pass; DTS build success |
| `npm pack --dry-run` | ✅ 5 files, 3.4 kB — clean |
| prepublishOnly gate | ✅ present |

### 3.4 `@animastor/web-generator-sse` — NEEDS_FIX ⚠️

| Check | Result |
|---|---|
| package.json fields | ✅ complete |
| main/module/types/exports | ✅ |
| README.md | ❌ **missing** — tarball ships without readme |
| dependencies | ❌ `"@animastor/web-generator": "file:../animastor-web-generator"` — same `file:` problem as vbook; must become `"^0.1.0"` after web-generator is published |
| typecheck / test / build | ✅ 2 files, 16 tests pass; DTS build success |
| `npm pack --dry-run` | ✅ 5 files, 4.4 kB — clean |
| prepublishOnly gate | ✅ present |

### 3.5 `@animastor/web-book-session` — READY ✅

| Check | Result |
|---|---|
| package.json fields | ✅ complete |
| main/module/types/exports | ✅ |
| README.md | ✅ present (1.7 kB) |
| TypeScript declarations | ✅ `dist/index.d.ts` |
| dependencies | ✅ `@preact/signals: ^1.3.0` as a regular dependency — signals are a real runtime value dependency here (the package owns identity signals), consistent with how `@animastor/web-settings` publishes with zero deps and `web-file` keeps preact as peer. Acceptable as-is. |
| `file:`/local deps | ✅ none |
| typecheck / test / build | ✅ 2 files, 28 tests pass; DTS build success |
| `npm pack --dry-run` | ✅ 6 files, 5.4 kB — clean |
| prepublishOnly gate | ✅ present |

### 3.6 `packages/animastor-worker` — BLOCKED 🚫

The directory has **no `package.json`** at all — it is not yet an npm package, just a deployment artifact collection:
- `worker/` — runtime bundle (`worker.cjs`, `job-protocol-v2.cjs`, its own `package.json`+lockfile for the worker runtime)
- `new/`, `tools/`, `tests/` — operational shell scripts and protocol sync tooling
- Job Protocol v2 is already canonicalized in the published `@animastor/contracts`; the worker copies it locally.

Publishing would require a decision that is architectural, not cosmetic: what the npm artifact is (the worker runtime bundle? the whole deployment kit?), which files are shipped, how it relates to `@animastor/contracts` and `@animastor/gpu-hub`, and whether npm distribution is even the right channel (GPU Hub already distributes the worker as a tarball artifact — see GPU Hub `buildInstallerArtifact` pattern). **Do not package until this is decided.**

---

## 4. Deviations vs published-module standard (unpublished packages)

| Deviation | Affected | Reference behavior |
|---|---|---|
| `README.md` absent | web-generator-vbook, web-generator-config, web-generator-sse | All 22 published packages ship a README inside the tarball |
| `file:` dependency in `dependencies` | web-generator-vbook, web-generator-sse | Published packages reference each other via `^0.1.0` registry ranges; `file:` deps are a monorepo-dev-only mechanism that npm publish cannot resolve |
| No `homepage` field | web-generator-vbook, web-generator-config, web-generator-sse, web-book-session, web-generator | Most published web packages set `homepage` to the GitHub `tree/main/packages/...#readme` URL |
| No `bugs` field | web-generator-vbook, web-generator-config, web-generator-sse, web-book-session, web-generator | Published standard: `https://github.com/Animastor/animastor/issues` |

Non-blocking style notes (all five): `vitest` version pinning is inconsistent across the family (`^4.1.10` vs `4.1.11` in devDeps) — dev-only, does not affect the tarball. `web-book-session` and the three NEEDS_FIX packages omit `bugs`/`homepage`, which npm tolerates.

---

## 5. Final statuses

| Package | Version (local) | Status | Blocking issues |
|---|---|---|---|
| `@animastor/web-generator` | 0.1.0 | **READY** | — |
| `@animastor/web-book-session` | 0.1.0 | **READY** | — |
| `@animastor/web-generator-config` | 0.1.0 | **NEEDS_FIX** | add README.md; (optional) homepage/bugs |
| `@animastor/web-generator-vbook` | 0.1.0 | **NEEDS_FIX** | add README.md; replace `file:` dep on web-generator with registry range after web-generator is published; (optional) homepage/bugs |
| `@animastor/web-generator-sse` | 0.1.0 | **NEEDS_FIX** | add README.md; replace `file:` dep on web-generator with registry range after web-generator is published; (optional) homepage/bugs |
| `animastor-worker` (dir) | — | **BLOCKED** | no package.json; publishing requires an architectural decision about the artifact shape and distribution channel (GPU Hub tarball already serves this role) |

**Recommended publish order** (dependency-respecting): `@animastor/web-generator` → fix + publish `web-generator-config` and `@animastor/web-book-session` (independent) → fix + publish `@animastor/web-generator-vbook` and `@animastor/web-generator-sse` (depend on web-generator via registry range).

Totals: **READY 2 · NEEDS_FIX 3 · BLOCKED 1** (unpublished); published and not in scope for changes: 22.

---

## 6. Lists required by the audit

### Модули, готовые к публикации в npm

| npm package name | Версия |
|---|---|
| `@animastor/web-generator` | 0.1.0 |
| `@animastor/web-book-session` | 0.1.0 |

### Модули, требующие исправлений

| npm package name | Версия | Что исправить |
|---|---|---|
| `@animastor/web-generator-config` | 0.1.0 | Создать `README.md` (сейчас tarball уходит без readme); опционально добавить `homepage`/`bugs` |
| `@animastor/web-generator-vbook` | 0.1.0 | Создать `README.md`; заменить `"@animastor/web-generator": "file:../animastor-web-generator"` на `"^0.1.0"` (после публикации web-generator); опционально `homepage`/`bugs` |
| `@animastor/web-generator-sse` | 0.1.0 | Создать `README.md`; заменить `"@animastor/web-generator": "file:../animastor-web-generator"` на `"^0.1.0"` (после публикации web-generator); опционально `homepage`/`bugs` |

Out-of-scope reconciliation note: `@animastor/installer` repo manifest (`private: true`, no LICENSE) diverges from the published registry artifact (0.1.0) — worth a separate cleanup task.

---

## 7. Verification performed (commands, read-only)

- `npm view <name> version` for all 26 named packages (publication status + registry versions).
- `npm pack --dry-run` in each of the 5 unpublished packages — tarball contents inspected (no secrets/temp files/junk; `*.tgz` and `node_modules`/`dist` excluded by `.gitignore`/`files`).
- `npm run typecheck && npm test && npm run build` in each of the 5 unpublished packages — all green (175 tests total).
- Registry spot-checks confirming published tarballs ship `dist/` + `.d.ts` and carry no `file:` deps.

No files were modified for this audit; no versions were bumped; nothing was published.
