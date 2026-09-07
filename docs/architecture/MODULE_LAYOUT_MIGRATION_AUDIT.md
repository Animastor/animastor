# MODULE LAYOUT MIGRATION AUDIT

**Status:** READ-ONLY audit + migration plan. No production code changed, no files moved.
**Date:** 2026-09-07
**Baseline:** HEAD `282c26fb` ("Prepare ComfyUI Workflow Connector for standalone distribution")

---

## Executive summary

Five standalone modules exist in the repository. Only one (`animastor-comfyui-workflow-connector`) is in `packages/`. The other four are at the root level or nested. This audit inventories all modules, checks their path dependencies, and recommends a unified `packages/<module-name>/` layout with a migration plan.

**Recommendation:** Move `ai-connector` and `contracts` to `packages/` (low risk). Move `gpu-hub` (medium risk, Dockerfile/compose updates). Keep `worker/worker/` as-is or with a symlink (Phase 9D deployment constraint). Establish `packages/` as the canonical location for all standalone modules.

---

## 1. Module inventory

### 1.1 animastor-comfyui-workflow-connector

| Property | Value |
|---|---|
| Current location | `packages/animastor-comfyui-workflow-connector/` |
| Package name | `animastor-comfyui-workflow-connector` |
| Version | 0.1.0 |
| Entry point | `src/index.js` |
| Own tests | YES (`tests/connector-core.test.js`, 34 tests) |
| Own README | YES |
| Runtime deps | ZERO (Node builtins only) |
| Consumers | 19 require sites in `backend/src/` (via `animastor-comfyui-workflow-connector` bare specifier) |
| Docker | `docker-compose.yml` mounts `./packages/animastor-comfyui-workflow-connector:/app/node_modules/animastor-comfyui-workflow-connector:ro` |
| Root symlink | `node_modules/animastor-comfyui-workflow-connector → ../packages/animastor-comfyui-workflow-connector` |
| Already in packages/ | YES — no migration needed |

### 1.2 animastor-ai-connector

| Property | Value |
|---|---|
| Current location | `ai-connector/` |
| Package name | `animastor-ai-connector` |
| Version | 0.1.0 |
| Entry point | `index.cjs` |
| Own tests | YES (`test/run-all.cjs`) |
| Own README | YES (+ `SPEC.md`) |
| Runtime deps | `ws ^8.21.3` |
| Consumers | 6 backend test files via `../../ai-connector/` relative paths (no production imports) |
| Docker | None |
| Root symlink | None |
| Already in packages/ | NO |

### 1.3 @animastor/contracts

| Property | Value |
|---|---|
| Current location | `contracts/` |
| Package name | `@animastor/contracts` |
| Version | 0.1.0 |
| Entry point | `src/index.js` |
| Own tests | YES (`tests/run-all.cjs`, 37 tests) |
| Own README | YES |
| Runtime deps | ZERO |
| Consumers | `backend/src/runtime/job-schema.js` (via `@animastor/contracts` bare specifier); `@animastor/gpu-hub` (npm registry dep) |
| Docker | `docker-compose.yml` mounts `./contracts:/app/node_modules/@animastor/contracts:ro` |
| Root symlink | `node_modules/@animastor/contracts → ../../contracts` |
| Already in packages/ | NO |

### 1.4 @animastor/gpu-hub

| Property | Value |
|---|---|
| Current location | `gpu-hub/` |
| Package name | `@animastor/gpu-hub` |
| Version | 0.1.0 |
| Entry point | `server.js` |
| Own tests | YES (`tests/run-all.cjs`, 19 tests) |
| Own README | YES |
| Runtime deps | `@animastor/contracts ^0.1.0`, `cors ^2.8.5`, `express ^4.19.2`, `ioredis ^5.10.0` |
| Consumers | `docker-compose.yml` (build), backend test files (~8 files via `../../gpu-hub/`), separate GitHub repo `Animastor/animastor-gpu-hub` |
| Docker | `Dockerfile` (build context = repo root, `COPY gpu-hub/...`), `docker-compose.yml` (`build: context: .`, `dockerfile: gpu-hub/Dockerfile`) |
| Root symlink | None |
| Already in packages/ | NO |

### 1.5 animastor-worker

| Property | Value |
|---|---|
| Current location | `worker/worker/` (nested) |
| Package name | `animastor-worker` |
| Version | 2.1.0 |
| Entry point | `worker.cjs` |
| Own tests | YES (`worker/tests/`, zero-dep harness) |
| Own README | YES (`worker/README.md`) |
| Runtime deps | ZERO |
| Consumers | Docker-compose mounts, installer manifests (×3), hub `WORKER_BUNDLE_DIR`, `backend/src/installer/engine/worker.js`, ~10 backend test files |
| Docker | `docker-compose.yml` mounts `./worker/worker:/app/worker-bundle:ro` |
| Root symlink | None |
| Already in packages/ | NO |
| **Phase 9D decision** | **Physical location NOT moved — deployment channels pin `worker/worker/`** |

### 1.6 animastor-backend (composition root)

| Property | Value |
|---|---|
| Current location | `backend/` |
| Package name | `animastor-backend` |
| Role | Composition root / host — NOT a standalone module |
| Not a migration candidate | — |

---

## 2. Current layout

```
root/
├── ai-connector/          ← standalone package (root level)
├── contracts/             ← standalone package (root level)
├── gpu-hub/               ← standalone package (root level)
├── worker/worker/         ← standalone package (nested)
├── packages/
│   └── animastor-comfyui-workflow-connector/  ← only one in packages/
├── backend/               ← composition root
├── docker-compose.yml
├── scripts/
├── docs/
└── ...
```

Root `node_modules/` symlinks:
- `@animastor/contracts → ../../contracts`
- `animastor-comfyui-workflow-connector → ../packages/animastor-comfyui-workflow-connector`

No root `package.json`. No npm workspaces.

---

## 3. Recommended layout

```
packages/
├── animastor-comfyui-workflow-connector/  (already correct)
├── animastor-ai-connector/                (move from root)
├── animastor-contracts/                   (move from root, keep @animastor scope)
├── animastor-gpu-hub/                     (move from root, keep @animastor scope)
└── animastor-worker/                      (or accept worker/worker/ as exception)
```

**Naming convention:**
- Filesystem directory: `animastor-<module>/` (flat, no scope prefix in directory name)
- npm package name: `animastor-<module>` or `@animastor/<module>` (keep existing stable names)
- Internal module/API name: unchanged (no breaking changes)

The `@animastor/` npm scope is already established for `contracts` and `gpu-hub`. The unscoped `animastor-comfyui-workflow-connector` and `animastor-ai-connector` names are already published/stable — do not rename for aesthetics.

---

## 4. Path dependency audit

### 4.1 ai-connector

| Reference type | Path | Impact of move |
|---|---|---|
| `package.json` repository.directory | `"directory": "ai-connector"` | Update to `"packages/animastor-ai-connector"` |
| Backend test files (6) | `require('../../ai-connector/...')` | Update relative paths |
| `scripts/syntax-smoke.sh` | `LAC_SRC="$ROOT_DIR/ai-connector"` | Update path |
| Docker | None | No impact |
| Production code imports | None | No impact |

### 4.2 contracts

| Reference type | Path | Impact of move |
|---|---|---|
| `package.json` repository.directory | `"directory": "contracts"` | Update to `"packages/animastor-contracts"` |
| Root symlink | `node_modules/@animastor/contracts → ../../contracts` | Recreate symlink |
| `docker-compose.yml` mount | `./contracts:/app/node_modules/@animastor/contracts:ro` | Update to `./packages/animastor-contracts:...` |
| `scripts/syntax-smoke.sh` | `CONTRACTS_SRC="$ROOT_DIR/contracts"` | Update path |
| Backend test files (~5) | `require('../../contracts/...')` | Update relative paths |
| `backend/src/runtime/job-schema.js` | Comment references `../../contracts` | Update comment |
| GPU Hub npm dep | `@animastor/contracts ^0.1.0` (registry) | No impact (npm resolution) |

### 4.3 gpu-hub

| Reference type | Path | Impact of move |
|---|---|---|
| `package.json` repository.directory | `"directory": "gpu-hub"` | Update to `"packages/animastor-gpu-hub"` |
| GPU Hub `Dockerfile` | `COPY gpu-hub/package.json ./`, `COPY gpu-hub/gpu-hub.js ...` | Update to `COPY packages/animastor-gpu-hub/...` |
| `docker-compose.yml` build | `build: context: .`, `dockerfile: gpu-hub/Dockerfile` | Update dockerfile path |
| `docker/compose/overlay-gpu-hub-local.yml` | Mounts `./worker/worker`, `./backend/ai/workflows`, etc. | No change (these are artifact mounts, not hub path) |
| `gpu-hub-rebuild.sh` | References compose files | No change (compose files are updated) |
| `scripts/syntax-smoke.sh` | `GPU_HUB_SRC="$ROOT_DIR/gpu-hub"` | Update path |
| Backend test files (~8) | `require('../../gpu-hub/...')` | Update relative paths |
| Separate GitHub repo | `git filter-repo --subdirectory-filter gpu-hub` | Re-extract or accept divergence |

### 4.4 worker

| Reference type | Path | Impact of move |
|---|---|---|
| `package.json` repository.directory | `"directory": "worker/worker"` | Update |
| `docker-compose.yml` mount | `./worker/worker:/app/worker-bundle:ro` | Update |
| `docker/compose/overlay-gpu-hub-local.yml` | `./worker/worker:/app/worker-bundle:ro` | Update |
| Installer manifests (×3) | `worker_bundle.source.options.repository: "worker/worker/"` | Update |
| `backend/src/installer/engine/worker.js` | `repoRoot/worker/worker` fallback | Update |
| `worker/start-worker.sh` | References `worker.cjs` relative path | No change (self-relative) |
| Backend test files (~10) | `require('../../worker/worker/...')` | Update |
| **Phase 9D decision** | **Deployment channels pin this path** | **HIGH RISK to change** |

---

## 5. Why things are where they are

1. **Historical convention:** "one package = one top-level directory" was established before `packages/` existed (`backend/`, `gpu-hub/`, `worker/`, `ai-connector/`, `contracts/` all at root).
2. **`packages/` created later:** Only `animastor-comfyui-workflow-connector` was placed there during its extraction.
3. **Worker stayed nested:** Phase 9D audit explicitly decided not to move `worker/worker/` because 4 deployment channels (docker-compose, installer manifests, hub bundle, installer engine) already referenced that path.
4. **GPU Hub has separate repo:** Phase 10H extracted to `Animastor/animastor-gpu-hub` via `git filter-repo --subdirectory-filter gpu-hub`, which assumes `gpu-hub/` at root.
5. **Contracts followed root convention:** Phase 9C §1.1 explicitly chose root-level following the existing pattern.

---

## 6. Migration plan

### Step 1: ai-connector → packages/animastor-ai-connector/

| Item | Detail |
|---|---|
| Risk | LOW |
| `package.json` | Update `repository.directory` |
| Backend tests | Update 6 files: `../../ai-connector/` → `../../packages/animastor-ai-connector/` |
| `scripts/syntax-smoke.sh` | Update `LAC_SRC` path |
| Docker | None |
| Symlink | Create `node_modules/animastor-ai-connector → ../packages/animastor-ai-connector` |

### Step 2: contracts → packages/animastor-contracts/

| Item | Detail |
|---|---|
| Risk | LOW-MEDIUM |
| `package.json` | Update `repository.directory` |
| Root symlink | Recreate `node_modules/@animastor/contracts → ../../packages/animastor-contracts` |
| `docker-compose.yml` | Update mount `./contracts:...` → `./packages/animastor-contracts:...` |
| `scripts/syntax-smoke.sh` | Update `CONTRACTS_SRC` path |
| Backend tests | Update ~5 files |
| Backend source | Update comment in `job-schema.js` |

### Step 3: gpu-hub → packages/animastor-gpu-hub/

| Item | Detail |
|---|---|
| Risk | MEDIUM |
| `package.json` | Update `repository.directory` |
| GPU Hub `Dockerfile` | Update all `COPY gpu-hub/...` → `COPY packages/animastor-gpu-hub/...` |
| `docker-compose.yml` | Update `dockerfile: gpu-hub/Dockerfile` → `dockerfile: packages/animastor-gpu-hub/Dockerfile` |
| `scripts/syntax-smoke.sh` | Update `GPU_HUB_SRC` path |
| Backend tests | Update ~8 files |
| Separate GitHub repo | Accept divergence or re-extract with updated filter-repo path |

### Step 4: worker — DECISION REQUIRED

| Option | Risk | Trade-off |
|---|---|---|
| **A: Stay at `worker/worker/`** | NONE | Accepted inconsistency; Phase 9D decision honored |
| **B: Move to `packages/animastor-worker/`** | HIGH | Must update 4 deployment channels + installer manifests + hub + ~10 test files; Phase 9D decision reversed |
| **C: Move + symlink** | MEDIUM | Move package, create `worker/worker/ → ../../packages/animastor-worker` symlink; deployment channels may break if they resolve symlinks differently |

**Recommendation:** Option A (keep as-is) for now. The deployment constraint is real and the benefit of moving is cosmetic. Revisit when npm workspaces are established and deployment channels are redesigned.

---

## 7. Implementation notes

- **Do all moves in separate commits** — one per module, with updated paths in the same commit.
- **Recreate root symlinks** after each move so existing `node_modules` resolution keeps working.
- **Run full test suite** after each move: `cd backend && npm test`.
- **Run `scripts/syntax-smoke.sh`** after each move.
- **Update `ARCHITECTURE.md`** Repository Layout section after all moves.
- **Do not change package names** — only filesystem paths change.
- **Do not change public APIs** — only internal paths and references.
- **Consider npm workspaces** as a follow-up (Phase 9-of-§30) to replace manual symlinks.

---

## 8. Documentation references

| Document | Relevance |
|---|---|
| `ARCHITECTURE.md` §Repository Layout | Must be updated after migration |
| `PHASE_9C_CONTRACTS_EXTRACTION_AUDIT.md` §1.1 | Chose root-level convention for contracts |
| `PHASE_9D_WORKER_PHYSICAL_EXTRACTION_AUDIT.md` §1.4–§1.5 | Decided NOT to move `worker/worker/` |
| `PHASE_10H_GPU_HUB_PHYSICAL_EXTRACTION_AUDIT.md` §2 | Extracted to separate repo via `--subdirectory-filter gpu-hub` |
| `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md` §2 | Notes "no root package.json, no npm workspaces yet" |
| `COMFYUI_WORKFLOW_CONNECTOR_EXTRACTION_READINESS.md` | Only module currently in `packages/` |
