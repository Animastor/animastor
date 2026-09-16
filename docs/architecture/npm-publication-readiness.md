# npm Publication Readiness Audit

**Audit date:** 2026-09-16
**Post-fix update:** 2026-09-16 — the three NEEDS_FIX packages were fixed and re-verified to READY (see §8); all other sections reflect the original audit.
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

### 3.2 `@animastor/web-generator-vbook` — READY ✅ (was NEEDS_FIX, fixed 2026-09-16 — see §8)

| Check | Result |
|---|---|
| package.json fields (name/version/description/keywords/license MIT/publishConfig) | ✅ complete |
| main/module/types/exports | ✅ |
| `homepage` / `bugs` | ✅ added (GitHub `tree/main/...#readme` + `/issues`, matching published web packages) |
| README.md | ✅ **added** (5.7 kB) — purpose, public API table, usage, package boundary, place in the web-generator family |
| dependencies | ✅ `"@animastor/web-generator": "^0.1.0"` — `file:` dependency replaced with the registry range (publish order: web-generator first) |
| typecheck / test / build | ✅ 2 files, 40 tests pass; DTS build success |
| `npm pack --dry-run` | ✅ 6 files, 11.6 kB — LICENSE, README.md, dist/index.{js,d.ts,js.map}, package.json; packaged manifest has no `file:` deps; no junk/secrets |
| prepublishOnly gate | ✅ present |

### 3.3 `@animastor/web-generator-config` — READY ✅ (was NEEDS_FIX, fixed 2026-09-16 — see §8)

| Check | Result |
|---|---|
| package.json fields | ✅ complete |
| main/module/types/exports | ✅ |
| `homepage` / `bugs` | ✅ added (GitHub `tree/main/...#readme` + `/issues`) |
| README.md | ✅ **added** (3.7 kB) — purpose, public API table, usage, package boundary, place in the web-generator family |
| dependencies / peerDependencies | ✅ zero (pure functions; preact correctly absent) |
| `file:`/local deps | ✅ none |
| typecheck / test / build | ✅ 2 files, 22 tests pass; DTS build success |
| `npm pack --dry-run` | ✅ 6 files, 4.6 kB — clean; packaged manifest has no `file:` deps |
| prepublishOnly gate | ✅ present |

### 3.4 `@animastor/web-generator-sse` — READY ✅ (was NEEDS_FIX, fixed 2026-09-16 — see §8)

| Check | Result |
|---|---|
| package.json fields | ✅ complete |
| main/module/types/exports | ✅ |
| `homepage` / `bugs` | ✅ added (GitHub `tree/main/...#readme` + `/issues`) |
| README.md | ✅ **added** (4.0 kB) — purpose, public API table, usage, package boundary, place in the web-generator family |
| dependencies | ✅ `"@animastor/web-generator": "^0.1.0"` — `file:` dependency replaced with the registry range (publish order: web-generator first) |
| typecheck / test / build | ✅ 2 files, 16 tests pass; DTS build success |
| `npm pack --dry-run` | ✅ 6 files, 5.7 kB — clean; packaged manifest has no `file:` deps; no junk/secrets |
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

Original-audit deviations for the three NEEDS_FIX packages were **fixed on 2026-09-16** (see §8): READMEs created, `file:` deps replaced with `^0.1.0`, `homepage`/`bugs` added. The remaining rows record the state found by the original audit.

| Deviation | Affected | Reference behavior | Status |
|---|---|---|---|
| `README.md` absent | web-generator-vbook, web-generator-config, web-generator-sse | All published packages ship a README inside the tarball | ✅ fixed |
| `file:` dependency in `dependencies` | web-generator-vbook, web-generator-sse | Published packages reference each other via `^0.1.0` registry ranges; `file:` deps are a monorepo-dev-only mechanism that npm publish cannot resolve | ✅ fixed |
| No `homepage` field | web-generator-vbook, web-generator-config, web-generator-sse, web-book-session, web-generator | Most published web packages set `homepage` to the GitHub `tree/main/packages/...#readme` URL | ✅ fixed for the three NEEDS_FIX packages (web-book-session / web-generator not in fix scope; web-generator already carries both fields) |
| No `bugs` field | web-generator-vbook, web-generator-config, web-generator-sse, web-book-session, web-generator | Published standard: `https://github.com/Animastor/animastor/issues` | ✅ fixed for the three NEEDS_FIX packages (web-book-session / web-generator not in fix scope; web-generator already carries both fields) |

Non-blocking style notes (all five): `vitest` version pinning is inconsistent across the family (`^4.1.10` vs `4.1.11` in devDeps) — dev-only, does not affect the tarball. `web-book-session` and the three NEEDS_FIX packages omit `bugs`/`homepage`, which npm tolerates.

---

## 5. Final statuses

Post-fix state (2026-09-16). Original audit statuses in parentheses.

| Package | Version (local) | Status | Blocking issues |
|---|---|---|---|
| `@animastor/web-generator` | 0.1.0 | **READY** | — |
| `@animastor/web-book-session` | 0.1.0 | **READY** | — |
| `@animastor/web-generator-config` | 0.1.0 | **READY** (was NEEDS_FIX) | — |
| `@animastor/web-generator-vbook` | 0.1.0 | **READY** (was NEEDS_FIX) | — |
| `@animastor/web-generator-sse` | 0.1.0 | **READY** (was NEEDS_FIX) | — |
| `animastor-worker` (dir) | — | **BLOCKED** | no package.json; publishing requires an architectural decision about the artifact shape and distribution channel (GPU Hub tarball already serves this role) |

**Recommended publish order** (dependency-respecting): `@animastor/web-generator` → `@animastor/web-generator-config` and `@animastor/web-book-session` (independent) → `@animastor/web-generator-vbook` and `@animastor/web-generator-sse` (depend on web-generator via registry range `^0.1.0`).

Totals: **READY 5 · BLOCKED 1** (unpublished); published and not in scope for changes: 22.

---

## 6. Lists required by the audit

### Модули, готовые к публикации в npm

| npm package name | Версия |
|---|---|
| `@animastor/web-generator` | 0.1.0 |
| `@animastor/web-book-session` | 0.1.0 |
| `@animastor/web-generator-config` | 0.1.0 |
| `@animastor/web-generator-vbook` | 0.1.0 |
| `@animastor/web-generator-sse` | 0.1.0 |

### Модули, требующие исправлений

**Нет.** Все три пакета из этого списка исправлены 2026-09-16 и переведены в READY (см. §8):

| npm package name | Версия | Что было исправлено |
|---|---|---|
| `@animastor/web-generator-config` | 0.1.0 | Создан `README.md`; добавлены `homepage`/`bugs` |
| `@animastor/web-generator-vbook` | 0.1.0 | Создан `README.md`; `"@animastor/web-generator": "file:../animastor-web-generator"` → `"^0.1.0"`; добавлены `homepage`/`bugs` |
| `@animastor/web-generator-sse` | 0.1.0 | Создан `README.md`; `"@animastor/web-generator": "file:../animastor-web-generator"` → `"^0.1.0"`; добавлены `homepage`/`bugs` |

Out-of-scope reconciliation note: `@animastor/installer` repo manifest (`private: true`, no LICENSE) diverges from the published registry artifact (0.1.0) — worth a separate cleanup task.

---

## 7. Verification performed (commands, read-only)

- `npm view <name> version` for all 26 named packages (publication status + registry versions).
- `npm pack --dry-run` in each of the 5 unpublished packages — tarball contents inspected (no secrets/temp files/junk; `*.tgz` and `node_modules`/`dist` excluded by `.gitignore`/`files`).
- `npm run typecheck && npm test && npm run build` in each of the 5 unpublished packages — all green (175 tests total).
- Registry spot-checks confirming published tarballs ship `dist/` + `.d.ts` and carry no `file:` deps.

No files were modified for this audit; no versions were bumped; nothing was published.

---

## 8. Post-fix verification (2026-09-16) — the three NEEDS_FIX packages → READY

Fixes applied per the audit's NEEDS_FIX findings, nothing published, no versions changed, no architecture changes, `animastor-worker` untouched.

### Changes

| Package | Changes |
|---|---|
| `@animastor/web-generator-config` | `README.md` created (purpose, exports, public API table, usage example, package boundary, place in the Animastor architecture — derived from actual `src/index.ts`/`src/models.ts`, no invented API); `homepage` + `bugs` added to `package.json` |
| `@animastor/web-generator-vbook` | `README.md` created (same structure); `"@animastor/web-generator": "file:../animastor-web-generator"` → `"^0.1.0"` (registry-compatible, publish order: web-generator first); `homepage` + `bugs` added |
| `@animastor/web-generator-sse` | `README.md` created (same structure); `"@animastor/web-generator": "file:../animastor-web-generator"` → `"^0.1.0"`; `homepage` + `bugs` added |

README structure follows the published `@animastor/web-generator` README archetype (title, scope note, Install, Usage, Public API table, Package boundary, Place in the Animastor architecture, Development, License).

### Per-package verification (all green)

| Check | config | vbook | sse |
|---|---|---|---|
| typecheck (`tsc --noEmit`) | ✅ | ✅ | ✅ |
| tests (vitest) | ✅ 22 | ✅ 40 | ✅ 16 |
| build (tsup ESM + d.ts + sourcemaps) | ✅ | ✅ | ✅ |
| `npm pack --dry-run` | ✅ 6 files / 4.6 kB | ✅ 6 files / 11.6 kB | ✅ 6 files / 5.7 kB |
| README.md in tarball | ✅ | ✅ | ✅ |
| LICENSE in tarball | ✅ | ✅ | ✅ |
| `exports` / `types` / `main` / `module` / `files` in packaged manifest | ✅ | ✅ | ✅ |
| No `file:` deps in packaged `package.json` | ✅ (zero deps) | ✅ (`^0.1.0`) | ✅ (`^0.1.0`) |
| `homepage` / `bugs` present | ✅ | ✅ | ✅ |
| No secrets / test files / temp files / host artifacts in tarball | ✅ | ✅ | ✅ |

Tarballs contain exactly: `package/LICENSE`, `package/README.md`, `package/dist/index.{js,d.ts,js.map}`, `package/package.json` — verified by extracting real tarballs (`npm pack` + `tar -xzf` + manifest inspection + secret scan; no matches).

### `file:` dependency replacement — local dev/test/build integrity

- All three packages still pass typecheck + tests + build after the replacement (the dev-time resolution is unaffected): the package-local `node_modules/@animastor/web-generator` symlink (created when the dependency was `file:`) points at `../../animastor-web-generator`, whose `dist/` is built, so `@animastor/web-generator` keeps resolving for vitest/tsc/tsup locally.
- `npm install` in the package directories continues to succeed against the existing symlink without changing the checked-in lockfiles (lockfiles still carry the monorepo `resolved: ../animastor-web-generator` dev-time resolution; this is a monorepo-dev mechanism outside the publishable manifest).
- A fresh `npm ci`/`npm install` on a machine without the sibling checkout will resolve `@animastor/web-generator@^0.1.0` from the registry once `@animastor/web-generator` is published — publish order: `@animastor/web-generator` → `web-generator-config` / `web-book-session` → `web-generator-vbook` / `web-generator-sse`. No workspace/file workarounds were introduced.
- `frontends/app` host `file:` deps and the untracked host root `package.json` were intentionally not touched (host-side monorepo-dev mechanism; the audit's `file:` finding targeted the publishable package manifests).
- Packaged manifests re-checked after the change: no `file:` references remain in any of the three publishable packages.
