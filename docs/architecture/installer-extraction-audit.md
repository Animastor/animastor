# Installer Extraction Audit

**Audit date:** 2026-09-14
**Verdict:** READY AFTER SEAM WORK
**Proposed package:** `@animastor/installer`
**Extraction target:** `packages/animastor-installer/`
**Extraction strategy:** Option A — wholesale move preserving inner `src/installer/` layout

---

## 1. Current boundary

```
backend/src/installer/          31 source files
├── cli.js                      CLI entry, REPO_ROOT = __dirname/../../.. (3-up = repo root)
├── index.js                    Package entry, exports 9 modules (NOT setup-contract)
├── package.json                Canonical version source (v1.3.0, name animastor-installer)
├── setup-contract.js           Host-facing projection (1380 lines), 13 exported functions
├── management.js               Engine consumer (cliPath via __dirname/../cli.js)
├── engine/                     13 files (core runtime: engine, fetchers, installers, plan, registry, state, store, tar, utils, workflows, dryrun, resume, install-sequencer)
├── platform/                   5 files (adaptive, distribution-detector, installer-adapter, native, system)
├── worker-bundle-source.js     Repo bundle resolution (REPO_BUNDLE_DIRS + resolveRepoBundleDir)
├── install-manifest.js         Manifest loading (MANIFEST_ROOT = __dirname/../../ai/install-manifests)
├── install-plan.js, download-planner.js, safety-rules.js, verification-report.js, workflow-artifacts.js, uninstaller.js, compatibility-resolver.js, install-manifest.js
└── io/, term/, progress/, state/   Internal helpers
```

**npm dependencies:** ZERO — only Node builtins: `child_process`, `crypto`, `fs`, `os`, `path`, `readline`.
**Requires escaping installer dir:** NONE (full graph scan + Tarjan SCC: no cycles, no reverse dependencies).

---

## 2. Dependency graph

### 2.1 Production consumers (code require)

| Consumer | Location | What it uses |
|---|---|---|
| `worker-setup-routes.cjs` | `backend/src/routes/worker-setup-routes.cjs:37` | `require('../installer/setup-contract')` — 12+ functions (getManifestRegistry, listSetupProfiles, getInstallationMethods, deploymentCapabilities, getPlatformArtifacts, PLATFORMS, listWorkflowArtifacts, isHiddenManifest, buildInstructions, adaptSetupStatus, normalizeCapabilities, buildSetupPlan, probeHubArtifacts, SETUP_WORKER_STATUSES) |
| `backend.cjs` | `backend/src/backend.cjs:645` | Wires the routes (indirect) |
| `backend/package.json` | `backend/package.json:7` | `"bin": {"animastor-installer": "src/installer/cli.js"}` |

**ONLY production code consumer** is `worker-setup-routes.cjs` via a single `require('../installer/setup-contract')`.

### 2.2 GPU Hub consumers (filesystem / tarball)

| Consumer | Location | Mechanism |
|---|---|---|
| `gpu-hub.js` | `packages/animastor-gpu-hub/gpu-hub.js:1315` | `INSTALLER_SRC_DIR = resolveArtifactDir('installer-src', '/app/installer-src')` — reads `package.json` + walks files into tarball |
| `gpu-hub.js` | `packages/animastor-gpu-hub/gpu-hub.js:1638-1700` | `buildInstallerArtifact`: tar entries `animastor-installer/src/installer/${f}` |
| `Dockerfile` | `packages/animastor-gpu-hub/Dockerfile:14` | `COPY backend/src/installer/ /staging/artifacts/installer-src/` |
| `bootstrap.js` | `packages/animastor-gpu-hub/bootstrap.js:202` | `CLI="$WORK_DIR/animastor-installer/src/installer/cli.js"` |
| `compose overlay` | `docker/compose/overlay-gpu-hub-local.yml:23` | `./backend/src/installer:/app/installer-src:ro` |
| `entrypoint.sh` | `docker/worker/entrypoint.sh:19` | `CLI="$INSTALLER_DIR/src/installer/cli.js"` (tarball layout) |
| `check-artifacts.sh` | `scripts/check-artifacts.sh:122-128` | `installer-src/{package.json,cli.js,index.js}` |

### 2.3 Tests

**Package-owned (move with package, 20 files):**

| Test file | Notes |
|---|---|
| `installer-cli.test.js` | Spawns cli.js via `path.join(REPO_ROOT, 'backend/src/installer/cli.js')` — path pin |
| `installer-cpu.test.js` | Same pattern, path pin |
| `installer-busy.test.js` | Path pin |
| `installer-modelscope.test.js` | Path pin |
| `installer-uninstall.test.js` | Path pin |
| `installer-prereq.test.js` | Path pin |
| `installer-term.test.js` | Path pin |
| `installer-engine.test.js` | Uses index.js, path pin |
| `installer-setup-contract.test.js` | Path pin |
| `installer-phase15.test.js` | Path pin |
| `installer-platform.test.js` | Spawns `require('${path.join(REPO_ROOT, "backend/src/installer/platform")}')` — path pin |
| `installer-resume.test.js` | Path pin |
| `installer-resolver.test.js` | Path pin |
| `installer-security.test.js` | Path pin |
| `installer-management-tools.test.js` | Path pin |
| `install-manifest.test.js` | Path pin |

**Host integration tests (stay in backend, path pins update):**

| Test file | What to update |
|---|---|
| `worker-setup-api.test.js` | `INSTALLER_SRC_DIR` config |
| `gpu-hub-artifacts.test.js` | `REAL_INSTALLER_SRC` pin + tar entry name assertions |
| `gpu-hub-bootstrap.test.js` | Stub `INSTALLER_SRC_DIR` (path-agnostic) |
| `phase10t-1-artifact-bakein.test.js` | AB4/AB5 source-read paths + AB8 overlay source pins |
| `phase10j-gpu-hub-transitional-fixture.test.js` | Mount targets (container-side paths — frozen, NO change) |

### 2.4 Frontends

NO code dependency. Only i18n strings in `frontends/app/src/app/i18n.ts`.

### 2.5 Docs (low risk, non-blocking)

`docs/04-planning/INSTALLER_ARCHITECTURE.md`, `docs/05-operations/GPU_HUB_CONTRACT.md`, `docs/04-planning/MODULE_LAYOUT_MIGRATION_AUDIT.md`, phase docs — path references update in doc pass.

---

## 3. Hidden coupling — path arithmetic

### 3.1 `cli.js:53` — REPO_ROOT

```js
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
```

| Context | `__dirname` | REPO_ROOT resolves to | Status |
|---|---|---|---|
| Repo dev (today) | `backend/src/installer` | repo root (`/home/animastor/animastor`) | ✓ |
| Tarball extracted | `<extract>/animastor-installer/src/installer` | extraction parent (`<extract>`) | ✓ |
| After nested move | `packages/animastor-installer/src/installer` | repo root | ✓ (same depth) |

**Depth preserved** — REPO_ROOT is UNCHANGED by the nested extraction.

### 3.2 `install-manifest.js:37-41` — MANIFEST_ROOT

```js
const MANIFEST_ROOT = process.env.ANIMASTOR_MANIFEST_ROOT ||
    path.join('/app', 'artifacts', 'install-manifests') ||
    path.join(__dirname, '..', '..', 'ai', 'install-manifests');
```

| Context | Resolves to | Status |
|---|---|---|
| Hub container (baked-in) | `/app/artifacts/install-manifests` | ✓ |
| Repo dev (today) | `backend/ai/install-manifests` | ✓ |
| After nested move (if manifests stay in `backend/ai/`) | `packages/animastor-installer/ai/install-manifests` | ✗ MISS |
| After nested move + manifests move | `packages/animastor-installer/ai/install-manifests` | ✓ |

**Seam:** Manifests must move with the package (`git mv backend/ai/install-manifests packages/animastor-installer/ai/install-manifests`).

### 3.3 `setup-contract.js:73-75` — getWorkerBundleVersion candidates

```js
path.join(__dirname, '..', '..', '..', 'packages', 'animastor-worker', 'worker', 'package.json')
path.join(__dirname, '..', '..', '..', 'worker', 'worker', 'package.json')  // legacy
```

| Context | Resolves to | Status |
|---|---|---|
| Repo dev (today) | `packages/animastor-worker/worker/package.json` | ✓ |
| After nested move | Same (3-up = repo root) | ✓ |
| Tarball | `<extract>/packages/animastor-worker/worker/package.json` | ✗ (files at `animastor-installer/packages/...`) — pre-existing, hub-probe fallback covers |

**UNCHANGED** by extraction — same behavior as today.

### 3.4 `engine/workflows.js:37-42` — repository_path candidates

```js
path.join(repoRoot, wf.source.repository_path)           // backend/ai/workflows/...
path.join(repoRoot, 'animastor-installer', wf.source.repository_path)  // tarball second candidate
```

**UNCHANGED** — REPO_ROOT depth preserved, tarball layout preserved.

### 3.5 `engine/engine.js:930` — cliPath

```js
path.join(__dirname, '..', 'cli.js')  // engine/ → ../cli.js = src/installer/cli.js
```

**UNCHANGED** — intra-package relative path.

### 3.6 `worker-bundle-source.js` — REPO_BUNDLE_DIRS

```js
REPO_BUNDLE_DIRS = [['packages','animastor-worker','worker'], ['worker','worker']]
```

Joins with `repoRoot`. Same depth semantics. **UNCHANGED**.

---

## 4. Tarball two-sided contract (frozen wire format)

### 4.1 Tar entry layout (produced by hub, consumed by engine)

```
animastor-installer/src/installer/{cli.js, engine/*, ...}
animastor-installer/ai/install-manifests/...
animastor-installer/backend/ai/workflows/...
animastor-installer/packages/animastor-worker/worker/...
animastor-installer/package.json
animastor-installer/README.txt
```

### 4.2 Bootstrap / entrypoint path pins

| File | Path hardcoded |
|---|---|
| `gpu-hub.js:1638` | `animastor-installer/src/installer/${f}` (tar prefix) |
| `gpu-hub.js:1700` | `animastor-installer/package.json` |
| `bootstrap.js:202` | `$WORK_DIR/animastor-installer/src/installer/cli.js` |
| `entrypoint.sh:19` | `$INSTALLER_DIR/src/installer/cli.js` (after cp -a strips prefix) |
| `gpu-hub-artifacts.test.js:340-347` | Entry name assertions (frozen) |

### 4.3 Compatibility analysis

| Operation | Nested move impact |
|---|---|
| Hub tar builder (walk INSTALLER_SRC_DIR) | **UNCHANGED** — Dockerfile produces identical flat `installer-src/` layout |
| Bootstrap CLI path | **UNCHANGED** — tar entries identical |
| entrypoint.sh CLI path | **UNCHANGED** — cp -a produces identical layout |
| Engine resolution (REPO_ROOT, MANIFEST_ROOT, bundle) | **UNCHANGED** — same depths |
| Hub readCanonicalVersion | **UNCHANGED** — flat copy includes package.json |
| e2e install-driver | **UNCHANGED** — container-side paths frozen |

**ZERO behavioral change to shipped artifacts.**

---

## 5. Env / global assumptions (all self-contained)

| Variable / path | Used by | Backend coupling |
|---|---|---|
| `/app/artifacts/install-manifests` | install-manifest.js baked-in | None |
| `/app/artifacts/worker-bundle` | setup-contract baked-in | None |
| `ANIMASTOR_DEPLOYMENT` | setup-contract, engine, cli | None |
| `/.dockerenv` | platform detection | None |
| `HOME`, `LC_ALL`, `LANG` | CLI locale, io/term | None |
| `HF_TOKEN`, `HUGGINGFACE_HUB_TOKEN`, `MODELSCOPE_API_TOKEN` | download-planner | None |
| `ANIMASTOR_MANIFEST_ROOT` | install-manifest.js override | None |
| Node >= 20 | engines requirement | None |

All assumptions are installer-internal. No backend coupling.

---

## 6. Proposed package boundary

### 6.1 Package structure (after extraction)

```
packages/animastor-installer/
├── package.json                    name: "@animastor/installer", version: 1.3.0
│                                   bin: { animastor-installer: "src/installer/cli.js" }
│                                   main: "src/installer/index.js"
├── src/installer/
│   ├── cli.js                      CLI entry (REPO_ROOT 3-up unchanged)
│   ├── index.js                    Public API entry (exports 10 modules)
│   ├── setup-contract.js           Host-facing projection (exported to index.js)
│   ├── management.js, engine/, platform/, worker-bundle-source.js
│   ├── install-manifest.js, install-plan.js, download-planner.js
│   ├── safety-rules.js, verification-report.js, workflow-artifacts.js
│   ├── compatibility-resolver.js, uninstaller.js
│   └── io/, term/, progress/, state/
├── ai/install-manifests/           git mv from backend/ai/install-manifests
├── tests/                          git mv from backend/tests/installer-*.test.js
│   ├── mocha config / test script
│   └── *.test.js (updated require paths)
└── README.md                       (optional)
```

### 6.2 Public API (index.js)

Exports 10 modules — setup-contract added as public (was internal-only):

| Export | Source |
|---|---|
| `manifest` | install-manifest |
| `resolver` | compatibility-resolver |
| `workflows` | workflow-artifacts |
| `downloads` | download-planner |
| `plan` | install-plan |
| `safety` | safety-rules |
| `verification` | verification-report |
| `engine` | engine/engine |
| `uninstaller` | uninstaller |
| `setupContract` | setup-contract (NEW — host seam for worker-setup-routes) |

### 6.3 Internal-only (NOT public)

Engine internals, platform adapters, safety-rule redactors, state store, worker-bundle-source, io/term/progress helpers.

---

## 7. Exact seam work (12 items)

### S1. `install-manifest.js` MANIFEST_ROOT — add fallback candidate

**Current:** `path.join(__dirname, '..', '..', 'ai', 'install-manifests')` → `backend/ai/install-manifests`
**After move:** `path.join(__dirname, '..', '..', 'ai', 'install-manifests')` → `packages/animastor-installer/ai/install-manifests` ✓
**Action:** NO code change needed if manifests move into the package. Just `git mv backend/ai/install-manifests packages/animastor-installer/ai/install-manifests`.

### S2. `cli.js` REPO_ROOT — UNCHANGED

3-up from `packages/animastor-installer/src/installer` = repo root ✓. No code change.

### S3. `setup-contract.js` getWorkerBundleVersion — UNCHANGED

3-up + `packages/animastor-worker/worker` ✓. No code change.

### S4. `setup-contract.js` getInstallerVersion — update package.json path

**Current:** `path.join(__dirname, 'package.json')` — package.json lives alongside setup-contract.js.
**After move:** Package.json moves to package root (`packages/animastor-installer/package.json`).
**Change:** `path.join(__dirname, '..', '..', 'package.json')` (2-up from `src/installer`).

### S5. `worker-setup-routes.cjs:37` — update require

**Current:** `require('../installer/setup-contract')`
**After:** `require('@animastor/installer').setupContract`
**Dependency:** Add `"@animastor/installer": "file:../packages/animastor-installer"` to `backend/package.json`.

### S6. `backend/package.json` — remove bin, add file dep

- Remove `"bin": {"animastor-installer": "src/installer/cli.js"}`
- Add `"@animastor/installer": "file:../packages/animastor-installer"` to dependencies

### S7. Hub Dockerfile — update COPY source

**Current:** `COPY backend/src/installer/ /staging/artifacts/installer-src/`
**After:** Two COPYs to produce identical flat `installer-src/`:
```dockerfile
COPY packages/animastor-installer/src/installer/ /staging/artifacts/installer-src/
COPY packages/animastor-installer/package.json /staging/artifacts/installer-src/package.json
```
**Hub code impact:** ZERO — flat layout identical to today.

### S8. Hub Dockerfile — update manifest COPY source

**Current:** `COPY backend/ai/install-manifests/ /staging/artifacts/install-manifests/`
**After:** `COPY packages/animastor-installer/ai/install-manifests/ /staging/artifacts/install-manifests/`
**Hub code impact:** ZERO — container path `/app/artifacts/install-manifests` unchanged.

### S9. Compose overlay — update bind mount sources

```yaml
# Current
- ./backend/src/installer:/app/installer-src:ro
- ./backend/ai/install-manifests:/app/artifacts/install-manifests:ro

# After
- ./packages/animastor-installer/src/installer:/app/installer-src:ro
- ./packages/animastor-installer/ai/install-manifests:/app/artifacts/install-manifests:ro
```

### S10. Tests — move + update path pins

Move 16+ installer-*.test.js files to `packages/animastor-installer/tests/`. Update:

| Pattern | Old | New |
|---|---|---|
| `require('../src/installer/...')` | `backend/tests/` → `backend/src/installer/...` | `packages/animastor-installer/tests/` → `packages/animastor-installer/src/installer/...` |
| `path.join(REPO_ROOT, 'backend/src/installer/cli.js')` | CLI spawn path | `path.join(REPO_ROOT, 'packages/animastor-installer/src/installer/cli.js')` |
| `path.join(REPO_ROOT, 'backend/src/installer/platform')` | Platform spawn | `path.join(REPO_ROOT, 'packages/animastor-installer/src/installer/platform')` |
| `require('../src/installer/package.json')` | Version read | `require('../../package.json')` |

Add package-level test infrastructure:
- `mocha` + `chai` as devDependencies
- `test` script in package.json
- `.mocharc.json` (or inline config)

### S11. Host integration tests — update path pins

| Test file | Change |
|---|---|
| `worker-setup-api.test.js` | `INSTALLER_SRC_DIR` config path |
| `gpu-hub-artifacts.test.js` | `REAL_INSTALLER_SRC` pin + tar entry name assertions |
| `phase10t-1-artifact-bakein.test.js` | AB4/AB5 source-read paths + AB8 overlay source pins |
| `phase9d-manifest-resolution.test.js` | `MANIFEST_ROOT` repo path |

### S12. Guard tests — add installer isolation

Add architecture test: `packages/animastor-installer/tests/architecture/installer-isolation.test.js`
- No requires escape package to backend (forbidden direction)
- No npm dependencies (only builtins)
- No requires into `../../backend/` from installer code
- Reverse: nothing outside installer requires into it except `@animastor/installer` root

---

## 8. Non-blocking / optional seams

| Item | Risk | Action |
|---|---|---|
| `scripts/syntax-smoke.sh` | LOW — installer leaves `backend/src` coverage | Add `packages/animastor-installer` to checked dirs |
| `docs/04-planning/INSTALLER_ARCHITECTURE.md` | LOW — path references stale | Doc pass |
| `docs/05-operations/GPU_HUB_CONTRACT.md` | LOW | Doc pass |
| `docs/04-planning/MODULE_LAYOUT_MIGRATION_AUDIT.md` | LOW | Doc pass |
| `backend/src/installer/package.json` name field | INFO — currently `animastor-installer` | Keep unscoped for CLI artifact name; npm package name `@animastor/installer` in root package.json |
| Hub `installerMeta()` name | INFO — reads `canonical.name` | Use literal `"animastor-installer"` for tarball artifact name (hardcode, don't read from scoped package name) |

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Tarball layout change breaks existing installs | **ELIMINATED** — nested layout preserves exact entry prefixes |
| Hub Dockerfile COPY produces different flat layout | **ELIMINATED** — two COPYs + combine = identical `installer-src/` |
| Manifest resolution breaks in repo dev | **MITIGATED** — manifests move into package, MANIFEST_ROOT 2-up + ai unchanged |
| Worker bundle resolution breaks in tarball | **PRE-EXISTING** — hub-probe fallback covers (not introduced by extraction) |
| `npm test` drops installer coverage | **MITIGATED** — package gets own test script; backend CI adds workspace test |
| Reverse dependency creep (installer requires backend) | **MITIGATED** — guard test blocks it |
| `@animastor/installer` scoped name in tar artifact | **MITIGATED** — hub hardcodes artifact name `"animastor-installer"` (literal, not from pkg.name) |
| Backend mocha drops installer test coverage | **MITIGATED** — `backend/tests/**/*.test.js` glob no longer matches moved files; package test script covers |

---

## 10. Extraction sequence

1. `git mv backend/ai/install-manifests packages/animastor-installer/ai/install-manifests`
2. Create `packages/animastor-installer/package.json` (name: `@animastor/installer`, version: 1.3.0, bin, main)
3. Remove inner `backend/src/installer/package.json` (canonical version source moves to root)
4. `git mv backend/src/installer packages/animastor-installer/src/installer`
5. Update `setup-contract.js` getInstallerVersion path (S4)
6. Update `worker-setup-routes.cjs` require (S5)
7. Update `backend/package.json` (S6)
8. Update Hub Dockerfile COPYs (S7, S8)
9. Update compose overlay mount sources (S9)
10. Move package-owned tests (S10)
11. Update host integration test pins (S11)
12. Add installer isolation guard test (S12)
13. Update syntax-smoke.sh (optional)
14. `npm test` / `npm run lint` — verify
15. Commit: `refactor(extraction): move installer to packages/animastor-installer`

---

## 11. Final verdict

| Criterion | Status |
|---|---|
| Zero npm dependencies | ✓ (only Node builtins) |
| Zero requires escape | ✓ (Tarjan SCC confirmed) |
| Zero backend code requires | ✓ (only worker-setup-routes.cjs — one require, seam planned) |
| Tarball wire format preserved | ✓ (nested layout + Dockerfile two-COPY) |
| Path arithmetic compatible | ✓ (3-up depth identical) |
| All consumers identified | ✓ (3 production, 8 hub/filesystem, 20+ tests, 0 frontend) |
| Env/global assumptions self-contained | ✓ (no backend coupling) |
| Seam work scoped and exact | ✓ (12 items, all enumerated) |
| Guard tests available | ✓ (add installer isolation guard) |

**Extraction is ready after the 12 seam work items above.**
