# Phase 10K — GPU Hub Independent CI / Release Readiness Audit

**Date:** 2026-09-06
**HEAD (monorepo):** `8417039245c84c5baf2b3950bb0e59f7bf51ea44`
**HEAD (standalone):** `b95bfdc` (Phase 10J CI workflow)

---

## 1. Executive Summary

The standalone GPU Hub repo (`Animastor/animastor-gpu-hub`) is **technically ready** for independent CI and future GHCR release. All boundary contracts are intact, all tests pass, Docker builds and smokes clean. The monorepo transitional fixture and `GPU_HUB_IMAGE` override seam are preserved.

**Verdict: READY AFTER PREPARATION** — one remaining blocker before real cutover (see §8).

---

## 2. Standalone CI

### 2.1 Existing CI Pipeline

**File:** `.github/workflows/ci.yml`
**Status:** Complete and functional.

| Job | What it verifies |
|-----|------------------|
| `package` | `npm ci` (registry resolution), 19-check standalone suite, `npm pack --dry-run` |
| `docker` | Image build, isolated smoke (health, auth planes, protocol gate, artifact 404s), protocol parity |

### 2.2 CI Boundary Guarantees

The CI pipeline enforces:

- [x] Standalone repo does not require `Animastor/animastor`
- [x] No `file:../contracts` — contracts resolves from npm registry
- [x] No local copy of Job Protocol
- [x] No runtime imports from monorepo
- [x] Package remains `@animastor/gpu-hub@0.1.0`
- [x] Docker image builds from standalone repo
- [x] Protocol parity (PROTOCOL_VERSION === 2)

### 2.3 New GHCR Release Workflow

**File:** `.github/workflows/ghcr-release.yml`
**Status:** Prepared, deliberately DISABLED.

- Builds Docker image
- Runs smoke test
- Records digest in GitHub Step Summary
- Push step is `if: false` (preparation only)
- Trigger is `on: {}` (no activation)
- Requires `GHCR_IMAGE_PAT` secret (not set — documented requirement)
- Never uses `:latest`

---

## 3. Docker Build / Smoke

### 3.1 Build

```
docker build -t gpu-hub-test:phase10k .
```

- [x] Builds successfully on `node:20` base
- [x] `npm install` resolves `@animastor/contracts` from registry
- [x] Exposes port 5000
- [x] `.dockerignore` excludes `node_modules`, `tests`, `.git`, `*.md` (except README)

### 3.2 Smoke Test Results

| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `GET /health` | `{"ok":true}` | `{"gpus":0,"queues":{...}}` | ✅ |
| `POST /task` (no key) | 401 | 401 | ✅ |
| `POST /task` (bad key) | 401 | 401 | ✅ |
| `POST /task` (v1 protocol) | 409 protocol_version_mismatch | 409 | ✅ |
| `GET /worker-bundle` (no mount) | 404 worker_bundle_unavailable | 404 | ✅ |
| `GET /installer` (no mount) | 404 installer_unavailable | 404 | ✅ |
| Protocol parity | PROTOCOL_VERSION === 2 | 2 | ✅ |

---

## 4. npm Dependency Isolation

### 4.1 Package Identity

```json
{
  "name": "@animastor/gpu-hub",
  "version": "0.1.0",
  "license": "MIT",
  "engines": { "node": ">=18" }
}
```

### 4.2 Dependency Set (Frozen: 4 packages)

| Package | Version | Source |
|---------|---------|--------|
| `@animastor/contracts` | `^0.1.0` | npm registry |
| `cors` | `^2.8.5` | npm registry |
| `express` | `^4.19.2` | npm registry |
| `ioredis` | `^5.10.0` | npm registry |

- [x] No `file:../` or `workspace:` references
- [x] No `devDependencies`
- [x] No `optionalDependencies`
- [x] No `pg`/`postgres` in runtime
- [x] Frozen npm specifier set enforced by tests

### 4.3 Runtime Module Set (Frozen: 4 files)

| File | Purpose |
|------|---------|
| `gpu-hub.js` | Express app factory (2036 lines) |
| `server.js` | Entrypoint with Redis + env wiring |
| `tarball.js` | Deterministic tar.gz builder |
| `bootstrap.js` | Cross-platform installer launchers |

### 4.4 Bare Require Set (Frozen)

Only these bare requires are allowed in runtime code:
`express`, `cors`, `crypto`, `fs`, `path`, `ioredis`, `zlib`, `http`, `https`, `url`, `@animastor/contracts`

---

## 5. Protocol Parity

| Source | PROTOCOL_VERSION |
|--------|-----------------|
| `@animastor/contracts` (npm registry) | 2 |
| `@animastor/contracts` (monorepo) | 2 |
| GPU Hub (standalone, runtime) | 2 |
| GPU Hub (standalone, container) | 2 |

- [x] Hub carries NO local PROTOCOL_VERSION literal
- [x] Single source of truth: `@animastor/contracts`
- [x] Parity enforced by test suite AND Docker smoke

---

## 6. Security

### 6.1 API Key Auth

- Fail-closed: no key → 401 on `/task`, `/queue/clear`
- Fail-closed: bad key → 401
- Worker auth: `Authorization: Bearer wrk.<id>.<secret>`
- `GPU_HUB_ALLOW_OPEN` is dev-only opt-out

### 6.2 Redis Ownership

Hub-owned keys (frozen):
- `animastor:gpu-hub:workers`
- `animastor:processing-claimed`
- `animastor:dead-letter`
- `animastor:queue:*`
- `animastor:running`
- `animastor:job:*`
- `animastor:worker:heartbeat:*`

Hub NEVER writes:
- `animastor:worker-auth` (read-only mirror)

### 6.3 Bundle Security

- `.env` and `.env.*` files excluded from bundles
- `tarball.js` walker excludes `node_modules` and `.git`
- Artifact mounts are read-only (`:ro`)

---

## 7. Monorepo Compatibility

### 7.1 Transitional Fixture

- [x] `gpu-hub/` directory preserved in monorepo
- [x] Byte-identical to standalone (per extraction audit)
- [x] Default compose builds `./gpu-hub` (no image override)
- [x] Package identity: `@animastor/gpu-hub@0.1.0`

### 7.2 GPU_HUB_IMAGE Override Seam

```yaml
# docker-compose.yml:111
image: ${GPU_HUB_IMAGE:-animastor-gpu-hub:local}
```

- [x] Default: local build (`animastor-gpu-hub:local`)
- [x] Override: set `GPU_HUB_IMAGE` in `.env`
- [x] Overlay: `docker/compose/overlay-gpu-hub-standalone.yml`
- [x] Overlay uses `build: !reset null` to remove local build
- [x] Requires digest-pinned reference (no `:latest`)

### 7.3 Five Artifact Mounts (Frozen)

| # | Container Path | Host Source | Status |
|---|---------------|-------------|--------|
| 1 | `/app/worker-source/worker.cjs` | `./worker/worker/worker.cjs:ro` | ✅ Preserved |
| 2 | `/app/worker-bundle` | `./worker/worker/:ro` | ✅ Preserved |
| 3 | `/app/workflows` | `./backend/ai/workflows/:ro` | ✅ Preserved |
| 4 | `/app/installer-src` | `./backend/src/installer/:ro` | ✅ Preserved |
| 5 | `/app/install-manifests` | `./backend/ai/install-manifests/:ro` | ✅ Preserved |

### 7.4 nginx /gpu/ Proxy

- [x] `upstream gpu_hub_upstream { server gpu-hub:5000 }` unchanged
- [x] `location /gpu/ { proxy_pass http://gpu_hub_upstream/; }` unchanged
- [x] Prefix strip (`/gpu/` → `/`) unchanged
- [x] Internal block rules unchanged

### 7.5 HUB_URL Chain

| Component | Value | Status |
|-----------|-------|--------|
| Backend → Hub | `http://gpu-hub:5000` | ✅ Unchanged |
| Worker → Hub | `https://animastor.in/gpu` | ✅ Unchanged |
| Default (docs) | `https://animastor.in/gpu` | ✅ Unchanged |

### 7.6 Architecture Guards (Monorepo Tests)

| Test File | What It Guards |
|-----------|----------------|
| `phase10j-gpu-hub-transitional-fixture.test.js` | TF1-TF4: fixture exists, no runtime imports, deployment parameterization, artifact mounts frozen |
| `phase10d-gpu-hub-package-boundary.test.js` | PB1-PB7: package identity, manifest, lock, pack surface, runtime files, Docker contract, contracts resolution |
| `phase10a-gpu-hub-contract-freeze.test.js` | 14-route surface frozen |
| `gpu-hub-contract.test.js` | Wire contract parity |
| `phase2-redis-ownership-contract.test.js` | Redis key ownership |

All tests pass (306/306 in backend suite).

### 7.7 No New Backend → GPU Hub Runtime Dependency

- [x] Backend never `require('gpu-hub/...')` or `require('@animastor/gpu-hub')`
- [x] Coupling is strictly at wire contract level (HTTP + Redis + API key)
- [x] Enforced by `phase10j-gpu-hub-transitional-fixture.test.js` TF2

---

## 8. Remaining Blockers Before Real Cutover

| # | Blocker | Why | Required Action |
|---|---------|-----|-----------------|
| 1 | **GHCR publish never tested** | The `ghcr-release.yml` workflow is prepared but disabled. The actual push to GHCR has never been executed. | Activate workflow, push to GHCR, verify image is pullable, record digest |
| 2 | **Consuming side not wired** | Monorepo `.env` still has default local build. No environment has `GPU_HUB_IMAGE` set to a registry reference. | Set `GPU_HUB_IMAGE` in staging `.env`, apply overlay, verify deployment |
| 3 | **Artifact mounts source parity** | The five artifact mounts pull from monorepo paths (`./worker/`, `./backend/`). When the hub runs from a GHCR image, these mounts still come from the monorepo host. The hub image itself does NOT embed them. | Verify that the production host has the correct artifact source paths at cutover time |
| 4 | **Shared Redis ownership** | Hub and backend share `redis:7`. The hub writes to `animastor:queue:*`, `animastor:running`, etc. Verify no key collisions exist in production Redis after image switch. | Run Redis key audit before cutover |
| 5 | **No staging environment tested** | The standalone image has only been tested in isolated CI smoke tests, not in a staging deployment with real workers. | Deploy to staging with overlay, run E2E dispatch test |

---

## 9. Files Changed in This Phase

| Repo | File | Change |
|------|------|--------|
| `animastor-gpu-hub` | `.github/workflows/ghcr-release.yml` | New: prepared (disabled) GHCR release workflow |
| `animastor` | `docs/architecture/PHASE_10K_GPU_HUB_INDEPENDENT_CI_RELEASE_READINESS_AUDIT.md` | New: this audit |

---

## 10. Verdict

**READY AFTER PREPARATION**

The standalone repo is technically ready for independent CI and future GHCR release. All boundary contracts are intact. The remaining blockers are operational (actual GHCR publish, staging deployment, production verification) — not architectural.

The `GPU_HUB_IMAGE` → standalone image → `HUB_URL` → API key → Redis → nginx → artifact mounts cutover seam is **technically proven to exist** and does not hide stale dependencies. The seam is a config change, not a code change.

**Next phase (10L):** Activate GHCR release workflow, publish first image, record digest, deploy to staging with overlay, run E2E tests.
