# Installer Extraction Audit

**Audit date:** 2026-09-15 (updated post-extraction)
**Verdict:** EXTRACTION COMPLETED (physical move + integration; npm publish deferred)
**Package:** `@animastor/installer` v0.1.0
**Location:** `packages/animastor-installer/`
**Strategy:** Option A — wholesale move preserving inner `src/installer/` layout

---

## 1. Final package layout

```
packages/animastor-installer/
├── package.json                @animastor/installer 0.1.0, private, main + bin, engines >=20
├── package-lock.json           devDeps only (mocha, chai)
├── README.md
├── ai/install-manifests/       3 manifests (audio/qwen-tts, image/qwen-image, video/ltx-2.3)
├── src/installer/              31 source files, ~12.6k lines
│   ├── cli.js                  CLI entry (CLI_ROOT 2-up, REPO_ROOT 4-up)
│   ├── index.js                Public API: 10 exports incl. setupContract
│   ├── setup-contract.js       Host-facing projection, ~1.4k lines
│   ├── engine/                 core runtime (engine, workflows, worker, ...)
│   ├── platform/               adaptive/platform detection + deployment targets
│   ├── install-manifest.js     MANIFEST_ROOT: /app/artifacts/install-manifests → __dirname/../../ai/install-manifests
│   └── ...                     worker-bundle-source, install-plan, safety-rules, ...
└── tests/                      17 files (mocha/chai), npm test
```

`backend/src/installer/` — REMOVED (no compatibility shim/symlink).
`backend/ai/install-manifests/` — REMOVED (moved into package).
`backend/ai/workflows/` — UNCHANGED (host-side shared asset).

**npm dependencies:** ZERO — Node builtins only (`child_process`, `crypto`, `fs`, `os`, `path`, `readline`).

---

## 2. Public API

`require('@animastor/installer')` exports:

`manifest`, `resolver`, `workflows`, `downloads`, `plan`, `safety`,
`verification`, `engine`, `uninstaller`, **`setupContract`**.

`setup-contract` was added to the public API (it was previously a deep internal
require by the backend consumer — now part of the explicit surface).

**CLI:** `animastor-installer` → `src/installer/cli.js` (package `bin`). The
backend `bin` entry for it was removed from `backend/package.json`.

---

## 3. Consumers (verified post-extraction)

| Consumer | Mechanism | Status |
|---|---|---|
| `backend/src/routes/worker-setup-routes.cjs:38` | `require('@animastor/installer').setupContract` | updated |
| `backend/package.json` | `"@animastor/installer": "file:../packages/animastor-installer"` + lockfile | updated |
| `docker-compose.yml` (backend) | read-only mount into `/app/node_modules/@animastor/installer` (same pattern as other `file:` packages) | updated |
| GPU Hub `gpu-hub.js` | tarball builder `buildInstallerArtifact` (paths unchanged) + `installerMeta()` version read with candidate chain (Docker-baked `installer-src/package.json` → dev package root) | updated |
| GPU Hub `Dockerfile` | `COPY packages/animastor-installer/src/installer/ .../installer-src/` + `package.json` + manifests | updated |
| GPU Hub `bootstrap.js` / `docker/worker/entrypoint.sh` | tarball layout `animastor-installer/src/installer/cli.js` | unchanged (contract preserved) |
| `docker/compose/overlay-gpu-hub-local.yml` | dev mounts: `installer-src`, single-file `package.json`, `install-manifests` | updated |
| `scripts/check-artifacts.sh` | `installer-src/{package.json,cli.js,index.js}` | unchanged |
| `scripts/syntax-smoke.sh` | installer package added to smoke scope | updated |
| Frontends | no code dependency (i18n strings only) | unchanged |

Backend production code has NO remaining reference to `backend/src/installer`
or any installer internal path (architecture guard enforces this).

---

## 4. Runtime path semantics

### A. Repo-dev
- Manifests: `packages/animastor-installer/ai/install-manifests`
  (MANIFEST_ROOT fallback = `__dirname/../../ai/install-manifests` — resolved
  relative to the moved file, no env var, no semantic change).
- Workflows: `backend/ai/workflows` resolved via
  `WORKFLOW_ROOT_CANDIDATES` (repo-root `backend/ai/workflows` first).

### B. Production/container (backend + GPU Hub image)
- Manifests: `/app/artifacts/install-manifests` (baked-first candidate — unchanged).
- Workflows: `/app/artifacts/workflows` (host-side, via candidates).

### C. GPU Hub installer tarball (contract preserved)
```
animastor-installer/src/installer/...        (source now physically from package)
animastor-installer/ai/install-manifests/... (manifests now physically from package)
animastor-installer/backend/ai/workflows/... (workflows remain host-side)
animastor-installer/packages/animastor-worker/worker/...
```
Tar prefixes and bootstrap CLI path are unchanged; only the COPY source and
dev-mount sources moved. Hub `installerMeta()` reads the canonical version
from `installer-src/package.json`, which is baked into Docker and single-file
mounted in the dev overlay.

### D. Backend worker setup consumer
`require('@animastor/installer')` — resolves via `file:` dep in dev/tests and
via read-only node_modules mount in docker-compose.

---

## 5. Workflows host-side status

`backend/ai/workflows` remains a shared host asset. The installer resolves
workflow artifacts exclusively through `repository_path` / tarball contract —
no new installer → backend runtime dependency was introduced. `listWorkflowArtifacts`
defaults to an exists-checked candidate chain instead of deriving from
MANIFEST_ROOT (which after extraction would point inside the package).

---

## 6. Architecture guards (post-extraction state)

- `backend/tests/architecture/installer-package-boundary.test.js` — rewritten:
  asserts package exists at `packages/animastor-installer` with correct
  name/version/engines/bin/main; `backend/src/installer` absent; zero
  runtime deps; backend does not import installer internals; installer does
  not import backend; manifests inside package; workflows host-side; tarball
  prefixes in hub code; consumer uses `@animastor/installer` only.
- `backend/tests/architecture/phase10t-1-artifact-bakein.test.js` — source
  reads updated to package paths; Dockerfile/overlay pins updated.
- `backend/tests/architecture/phase9d-worker-package.test.js` — manifest
  location pin updated.
- `scripts/syntax-smoke.sh` — installer package covered.

---

## 7. Tests moved vs. kept

**Moved (17 files → `packages/animastor-installer/tests/`):** installer-cli,
installer-cpu, installer-busy, installer-modelscope, installer-uninstall,
installer-prereq, installer-term, installer-engine, installer-setup-contract,
installer-phase15, installer-platform, installer-resume, installer-resolver,
installer-security, installer-management-tools, installer-docker-deployment,
install-manifest.

**Kept in backend (host integration):** worker-setup-api, gpu-hub-artifacts,
gpu-hub-bootstrap, all architecture/* guards, general backend suites.

---

## 8. Test results (post-extraction)

| Suite | Result |
|---|---|
| `@animastor/installer` npm test (17 files) | 304 passing |
| backend architecture suite | passing (2 pre-existing failures on base unrelated to installer: phase5 T9 removed-file pin; fixed phase9d manifest pin) |
| backend worker-setup-api | 40 passing |
| backend gpu-hub-artifacts + gpu-hub-bootstrap | passing |
| `@animastor-gpu-hub` package tests | 22/22 |
| `scripts/syntax-smoke.sh installer` | passing |

**Pre-existing fix included:** `worker-routes.cjs` / `admin-routes.cjs`
called `workerRepo.WORKER_TYPES.includes(...)` on a function export (regression
from generation-extraction commit `6895d135`) — caused worker creation to hang
(express 4 async TypeError, no response). Fixed to call `WORKER_TYPES()`.

---

## 9. Remaining risks / deferred work

- npm publish, release/tag: intentionally deferred (next step after review).
- Docs outside this audit (`docs/04-planning/INSTALLER_ARCHITECTURE.md`,
  `docs/05-operations/GPU_HUB_CONTRACT.md`, phase docs) still reference the
  old `backend/src/installer` path in prose — non-executing, to update in a
  doc pass.
- `package.json` version inside `installer-src/` is baked per Docker build;
  the dev overlay single-file mount keeps it in sync for local hub runs.
- Hub candidate-chain version read silently falls back to `0.0.0` if both
  candidates are missing — acceptable (same behavior class as before).
