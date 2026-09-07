# Phase 10Q — GPU Hub Post-Cutover Independence Audit

**Date:** 2026-09-07
**Verdict:** YELLOW — production-ready, limited external dependencies remain

---

## Executive Summary

After the successful production cutover (Phase 10P), the standalone `animastor-gpu-hub` is operationally independent: it builds, publishes, deploys, restarts, and rolls back without monorepo checkout. The GHCR image runs immutable, digest-pinned, with zero monorepo source at runtime.

However, **5 runtime artifact mounts** still bind the GPU Hub to monorepo-owned files at container start. These mounts are the sole remaining coupling — they are read-only, non-destructive, and operationally stable, but they prevent claiming full module independence.

**The GPU Hub application code itself has ZERO monorepo coupling.** The only dependency boundary is the artifact delivery layer.

---

## 1. Current Architecture (Post Phase 10P)

```
┌─────────────────────────────────────────────────────────────┐
│                      PRODUCTION HOST                         │
│                                                              │
│  ┌──────────────┐     ┌──────────────────────────────────┐  │
│  │ animastor-    │     │ gpu-hub (GHCR immutable image)   │  │
│  │ backend       │◄────│ @animastor/gpu-hub@0.1.0         │  │
│  │ (local build) │     │ sha256:eb9a9807b7c2...           │  │
│  └──────────────┘     │                                  │  │
│        ▲              │  5 bind mounts (read-only):       │  │
│        │              │  ├─ worker/worker/ → worker-bundle│  │
│        │              │  ├─ backend/ai/workflows → /workflows│
│        │              │  ├─ backend/src/installer → installer-src│
│        │              │  ├─ backend/ai/install-manifests  │  │
│        │              │  └─ worker/worker/worker.cjs      │  │
│        │              │       → worker-source (deprecated)│  │
│        │              └──────────────────────────────────┘  │
│        ▲                        ▲                           │
│        │  POST /gpu/task/result │  HTTP callbacks           │
│        │  POST /gpu/task/error  │  (x-api-key auth)        │
│        │                        │                           │
│  ┌──────────────┐     ┌──────────────────────────────────┐  │
│  │ animastor-    │     │ animastor-redis                   │  │
│  │ proxy (nginx) │────►│ redis:7                           │  │
│  │ HTTPS /gpu/   │     │ (shared instance)                 │  │
│  └──────────────┘     └──────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ workers (external GPU machines)                       │   │
│  │ Protocol: Job Protocol v2 (frozen)                    │   │
│  │ Auth: Bearer wrk.<id>.<secret>                        │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Coupling Points — Complete Inventory

### 2.1 Coupling via Artifact Mounts (PRIMARY)

| # | Mount | Owner | Why GPU Hub Needs It | Removable? |
|---|-------|-------|---------------------|------------|
| 1 | `worker/worker/` → `/app/worker-bundle` | Worker team | Serves worker runtime bundle via `GET /worker-bundle` and embeds in installer | Requires alternative delivery |
| 2 | `backend/ai/workflows/` → `/app/workflows` | Backend AI team | Serves workflow JSON via `GET /workflow/:id` and embeds in installer | Requires alternative delivery |
| 3 | `backend/src/installer/` → `/app/installer-src` | Backend installer team | Serves bootstrap script via `GET /installer`, version from `package.json` | Requires alternative delivery |
| 4 | `backend/ai/install-manifests/` → `/app/install-manifests` | Backend AI team | Builds profile/workflow allowlists, embeds in installer bundle | Requires alternative delivery |
| 5 | `worker/worker/worker.cjs` → `/app/worker-source` | Worker team | Serves deprecated single-file download | Can be removed (endpoint deprecated) |

### 2.2 Coupling via Compose Configuration (SECONDARY)

| Item | Status | Impact |
|------|--------|--------|
| `docker-compose.yml` base service | `build: ./gpu-hub` still default | No impact when overlay active (Phase 10P) |
| `GPU_HUB_IMAGE` in `.env` | Pinned to GHCR digest | Active, production override |
| Overlay file | `overlay-gpu-hub-standalone.yml` | Active, removes `build:` |
| `gpu-hub-rebuild.sh` | References local build | Only used for emergency local rebuilds |

### 2.3 Coupling via Shared Secrets (TERTIARY)

| Secret | Shared Between | Impact |
|--------|---------------|--------|
| `GPU_HUB_API_KEY` | Backend ↔ GPU Hub | Symmetric key for mutual auth. Must be identical. |

### 2.4 Coupling via Redis (TERTIARY)

| Key | Owner | Reader | Coupling Type |
|-----|-------|--------|---------------|
| `animastor:worker-auth` | Backend (write) | GPU Hub (read) | Backend-owned, hub reads for auth |
| `animastor:gpu-hub:workers` | GPU Hub (write) | Backend (delete on purge) | Hub-owned, backend deletes |
| `animastor:queue:*` | GPU Hub | GPU Hub | Hub-owned only |
| `animastor:running` | GPU Hub | GPU Hub | Hub-owned only |
| `animastor:processing` | GPU Hub | GPU Hub | Hub-owned only |
| `animastor:dead-letter` | GPU Hub | GPU Hub | Hub-owned only |

### 2.5 Coupling via API Contracts (COSMETIC)

| Contract | Status | Versioned? |
|----------|--------|------------|
| Job Protocol v2 | Frozen, parity-guarded | YES (`PROTOCOL_VERSION = 2`) |
| HTTP endpoint surface | 14 routes, frozen | YES (test-enforced) |
| Worker auth token format | `wrk.<id>.<secret>` | Implicitly versioned |
| Backend callback payload | `{job_id, build_id, dispatch_id, ...}` | Implicitly versioned |

---

## 3. Artifact Mounts — Detailed Analysis

### Mount 1: `worker/worker/` → `/app/worker-bundle`

**Why GPU Hub depends on it:**
- `GET /worker-bundle` serves a tar.gz of the full worker runtime to GPU machines
- `GET /worker-bundle/sha256` serves checksum metadata
- `GET /installer/bundle` embeds the worker bundle inside the installer tar.gz

**Producer:** `worker/` directory in monorepo. Maintained manually, no build step.

**Consumed by:** GPU workers (via HTTP download), installer (via embedding).

**Can it be replaced by a versioned artifact?** YES. Options:
1. **Publish worker bundle as npm package** — already has `package.json` with version `2.1.0`
2. **Bake into GHCR image** — include worker bundle in the image at build time
3. **Upload to object storage** — serve from CDN/S3 with version pinning

**What's needed for full elimination:** A publish pipeline for the worker bundle that runs before GPU Hub image build, plus a mechanism to inject the version into the hub's configuration.

### Mount 2: `backend/ai/workflows/` → `/app/workflows`

**Why GPU Hub depends on it:**
- `GET /workflow/:id` serves individual workflow JSON files to workers/installer
- Workflows are embedded in installer bundle

**Producer:** Backend AI team. Manually authored ComfyUI workflow definitions.

**Consumed by:** GPU workers (via HTTP), installer (via embedding).

**Can it be replaced by a versioned artifact?** YES. Options:
1. **Publish workflows as versioned npm package** — with manifest reference
2. **Bake into GHCR image** — include in image at build time
3. **Upload to object storage** — serve from CDN with version pinning

**What's needed:** A publish pipeline + allowlist configuration injection.

### Mount 3: `backend/src/installer/` → `/app/installer-src`

**Why GPU Hub depends on it:**
- `GET /installer` generates a bootstrap launcher script (dynamically from `bootstrap.js`)
- `GET /installer/sha256` serves checksum metadata
- `GET /installer/bundle` embeds installer sources in tar.gz
- Version metadata comes from `package.json` inside the directory

**Producer:** Backend installer team. Part of `backend/src/` tree.

**Consumed by:** GPU machines (via bootstrap download), installer bundle assembly.

**Can it be replaced by a versioned artifact?** YES. Options:
1. **Publish installer as npm package** — already has `package.json` with version `1.3.0`
2. **Bake into GHCR image** — include in image at build time
3. **Pre-generate installer bundle** — serve a static tar.gz instead of assembling at runtime

**What's needed:** A publish pipeline + version injection mechanism.

### Mount 4: `backend/ai/install-manifests/` → `/app/install-manifests`

**Why GPU Hub depends on it:**
- `loadWorkflowAllowlist()` scans manifests to build the workflow ID allowlist
- `loadProfileAllowlist()` scans manifests to build the profile ID allowlist
- Manifests are embedded in installer bundle

**Producer:** Backend AI team. Manually maintained JSON definitions.

**Consumed by:** GPU Hub (at startup + on-demand), installer (via embedding).

**Can it be replaced by a versioned artifact?** YES. Options:
1. **Publish manifests as npm package** — with version pinning
2. **Bake into GHCR image** — include in image at build time
3. **Embed in GPU Hub config** — ship manifests as static configuration

**What's needed:** A publish pipeline + allowlist rebuild mechanism.

### Mount 5: `worker/worker/worker.cjs` → `/app/worker-source`

**Why GPU Hub depends on it:**
- `GET /worker-source` serves a single-file worker download
- **DEPRECATED** — endpoint has `Deprecation: true` header, links to `/worker-bundle` as successor

**Producer:** Worker team. Same file as in Mount 1 (duplicate).

**Can it be removed NOW?** YES. The endpoint is deprecated, no new workers should use it.

**What's needed for removal:** Remove mount from `docker-compose.yml` and the deprecated endpoint from `gpu-hub.js`.

---

## 4. Release/Versioning Independence

### 4.1 Can standalone GPU Hub build independently?

| Capability | Status | Evidence |
|------------|--------|----------|
| `npm ci` (dependency resolution) | ✅ YES | `@animastor/contracts` resolves from npm registry |
| `docker build` | ✅ YES | 13-line Dockerfile in standalone repo |
| `npm test` (19 checks) | ✅ YES | Zero-dependency test runner, self-contained |
| `npm pack` (package surface) | ✅ YES | 9-file surface verified |

### 4.2 Can standalone GPU Hub publish independently?

| Capability | Status | Evidence |
|------------|--------|----------|
| CI on every push | ✅ YES | `.github/workflows/ci.yml` |
| GHCR release | ✅ YES | `.github/workflows/ghcr-release.yml` (manual dispatch) |
| Image smoke test | ✅ YES | Automated in CI and release workflow |
| Digest recording | ✅ YES | `$GITHUB_STEP_SUMMARY` output |

### 4.3 Can standalone GPU Hub deploy independently?

| Capability | Status | Evidence |
|------------|--------|----------|
| Docker Compose overlay | ✅ YES | `overlay-gpu-hub-standalone.yml` |
| `.env` pinning | ✅ YES | `GPU_HUB_IMAGE` in `.env` |
| Graceful restart | ✅ YES | SIGTERM handler, state preserved in Redis |
| Rollback | ✅ YES | Remove `GPU_HUB_IMAGE` from `.env`, restart |

### 4.4 Can standalone GPU Hub update independently?

| Capability | Status | Evidence |
|------------|--------|----------|
| New GHCR image | ✅ YES | Update `GPU_HUB_IMAGE` digest in `.env` |
| Zero-downtime | ⚠️ PARTIAL | Container restart causes ~5s gap; no rolling update |
| State preservation | ✅ YES | Redis state survives restart |

### 4.5 What's NOT independent?

| Dependency | Impact | Blocking? |
|------------|--------|-----------|
| 5 artifact mounts | Files served at runtime come from monorepo | YES — for full independence |
| `GPU_HUB_API_KEY` secret | Must be manually synchronized | NO — operational, not architectural |
| Redis instance | Shared with backend | NO — by design, not a coupling issue |

---

## 5. API/Contract Boundaries

### 5.1 External/Versioned Contracts

| Contract | Version | Enforcement |
|----------|---------|-------------|
| Job Protocol v2 | `PROTOCOL_VERSION = 2` | Code-level parity guards, `@animastor/contracts` npm package |
| HTTP route surface | 14 routes frozen | `tests/run-all.cjs` route count assertion |
| Worker auth token | `wrk.<id>.<secret>` format | Fail-closed verification against Redis mirror |
| Backend callback auth | `x-api-key` header | `requireHubCallbackAuth` middleware |

### 5.2 Filesystem-Dependent Contracts

| Contract | Source | Delivery |
|----------|--------|----------|
| Workflow JSON files | `/app/workflows/` (mount) | `GET /workflow/:id` |
| Install manifests | `/app/install-manifests/` (mount) | Embedded in installer bundle, allowlist |
| Worker bundle | `/app/worker-bundle/` (mount) | `GET /worker-bundle`, `GET /installer/bundle` |
| Installer source | `/app/installer-src/` (mount) | `GET /installer`, `GET /installer/bundle` |

### 5.3 Sync Points (Documented in Code)

| Sync Point | Backend Location | GPU Hub Location |
|------------|-----------------|------------------|
| Worker auth mirror key | `backend/src/services/worker-auth.js` | `gpu-hub.js:47` |
| GPU registry key | `backend/src/routes/worker-routes.cjs:414` | `gpu-hub.js:305` |
| Worker token format | `worker-repo.js` | `gpu-hub.js:64` |
| Share policy structure | `backend/src/config/` | `gpu-hub.js` (SH-1/SH-2) |
| Workspace resolution | `gpu-dispatcher.js` | Hub trusts `workspace_id` from backend |

---

## 6. Operational Independence

### 6.1 Restart/Reconnect

| Mechanism | Status | Evidence |
|-----------|--------|----------|
| SIGTERM graceful shutdown | ✅ | `server.js` closes HTTP, quits Redis |
| Redis reconnect (ioredis) | ✅ | Built-in ioredis reconnection strategy |
| Worker reconnect | ✅ | Workers poll `/task/next` every 10s, re-register via `/beacon` |
| Queue recovery | ✅ | Queues are Redis lists — survive hub restart |
| State preservation | ✅ | Tested in Phase 10P — all data preserved |

### 6.2 Callback Failure Handling

| Scenario | Handling |
|----------|----------|
| Backend down during result callback | 5 retries × 500ms, fallback to Redis `animastor:error:{job_id}` (1hr TTL) |
| Backend down during error callback | Same retry + Redis fallback |
| Stale callback rejected | Backend re-verifies `dispatch_id` |

### 6.3 Upgrade/Rollback

| Operation | Procedure | Risk |
|-----------|-----------|------|
| Upgrade | Update `GPU_HUB_IMAGE` digest in `.env`, `docker compose up -d gpu-hub` | Low — state in Redis |
| Rollback | Set previous digest in `.env`, `docker compose up -d gpu-hub` | Low — state in Redis |
| Emergency local rebuild | `gpu-hub-rebuild.sh` (builds from `./gpu-hub`) | Medium — uses monorepo source |

### 6.4 Observability

| Check | Endpoint | Frequency |
|-------|----------|-----------|
| Health | `GET /gpu/health` (via nginx) | Continuous |
| Queue depths | Embedded in health response | Per-request |
| Worker registry | `animastor:gpu-hub:workers` Redis key | 15-min TTL |
| Running jobs | `animastor:running` Redis key | Real-time |
| Dead letters | `animastor:dead-letter` Redis key | 7-day TTL |

---

## 7. Security/Deployment Coupling

### 7.1 Host Paths

| Path | Required? | Purpose |
|------|-----------|---------|
| Host filesystem root | NO | Container uses overlay filesystem |
| Monorepo source root | NO | Only 5 specific bind mounts |
| `/home/animastor/animastor/worker/worker/` | YES (mount 1,5) | Worker bundle delivery |
| `/home/animastor/animastor/backend/ai/workflows/` | YES (mount 2) | Workflow delivery |
| `/home/animastor/animastor/backend/src/installer/` | YES (mount 3) | Installer delivery |
| `/home/animastor/animastor/backend/ai/install-manifests/` | YES (mount 4) | Manifest delivery |

### 7.2 Secrets

| Secret | Location | Impact |
|--------|----------|--------|
| `GPU_HUB_API_KEY` | `.env` file, both backend and GPU Hub env | Must match. No rotation mechanism. |
| `POSTGRES_PASSWORD` | `.env` file, backend env | Not used by GPU Hub |
| `WORKSPACE_SECRET_KEY` | `.env` file, backend env | Not used by GPU Hub |

### 7.3 Undocumented Environment Variables

| Variable | Default | Used? |
|----------|---------|-------|
| `REDIS_URL` | `redis://animastor-redis:6379` | Yes — ioredis connection |
| `BACKEND_URL` | `http://animastor-backend:3000` | Yes — callback target |
| `PORT` | `5000` | Yes — HTTP listen port |
| `GPU_TIMEOUT` / `GPU_TIMEOUT_MS` | `600000` | Yes — task hard timeout |
| `SHARE_FEATURES_ENABLED` | `0` (off) | Yes — SH-1/SH-2 kill-switch |

All env vars are documented in `gpu-hub/README.md` and `server.js` comments.

### 7.4 Backend Runtime Assumptions

| Assumption | Risk |
|------------|------|
| Backend is reachable at `http://animastor-backend:3000` | LOW — Docker network DNS |
| Backend handles `POST /gpu/task/result` and `/gpu/task/error` | LOW — frozen routes |
| Backend re-authenticates worker identity from DB | LOW — hub sends audit-only worker_id |
| Backend shares the same Redis instance | LOW — by design |
| Backend provides `GPU_HUB_API_KEY` for callback auth | LOW — symmetric key |

---

## 8. What Can Be Removed/Changed Now

| Item | Action | Phase Required |
|------|--------|---------------|
| Mount 5 (`worker.cjs` → `worker-source`) | Remove mount + deprecated endpoint | Separate task (cleanup) |
| `gpu-hub-rebuild.sh` | Can be removed or marked legacy | Separate task (cleanup) |
| `build: ./gpu-hub` default in compose | Can be removed when overlay is permanent | Separate task (cleanup) |

## 9. What Requires a Separate Phase

| Item | Required Work | Estimated Effort |
|------|--------------|-----------------|
| Mounts 1-4 elimination | Publish worker bundle, workflows, installer, manifests as versioned artifacts (npm package or baked into GHCR image) | Medium — requires publish pipeline + version injection |
| `GPU_HUB_API_KEY` rotation | Implement key rotation mechanism with grace period | Small |
| Mount 5 deprecation removal | Remove endpoint + mount | Small |
| `build: ./gpu-hub` cleanup | Remove default build directive from compose | Small |

---

## 10. Coupling Severity Matrix

| Coupling Point | Type | Severity | Removable? |
|---------------|------|----------|-----------|
| Mount 1: worker bundle | Runtime artifact | MEDIUM | YES (publish pipeline) |
| Mount 2: workflows | Runtime artifact | MEDIUM | YES (publish pipeline) |
| Mount 3: installer | Runtime artifact | MEDIUM | YES (publish pipeline) |
| Mount 4: manifests | Runtime artifact | MEDIUM | YES (publish pipeline) |
| Mount 5: worker.cjs | Deprecated artifact | LOW | YES (immediate removal) |
| `GPU_HUB_API_KEY` | Shared secret | LOW | YES (rotation mechanism) |
| `build: ./gpu-hub` default | Compose config | LOW | YES (remove default) |
| Redis shared instance | Infrastructure | NONE | By design |
| Job Protocol v2 | Wire contract | NONE | By design (frozen, versioned) |
| HTTP route surface | API contract | NONE | By design (frozen, tested) |

---

## 11. Recommendations

### Immediate (no Phase required)
1. Remove Mount 5 (`worker.cjs` → `worker-source`) and the deprecated `GET /worker-source` endpoint
2. Remove `gpu-hub-rebuild.sh` or mark as legacy emergency-only

### Short-term (next Phase)
3. Publish worker bundle as a versioned artifact (npm package or bake into GHCR image)
4. Publish workflows as a versioned artifact
5. Publish installer sources as a versioned artifact
6. Publish install manifests as a versioned artifact
7. Update overlay compose to inject artifact versions via environment variables

### Medium-term
8. Implement `GPU_HUB_API_KEY` rotation mechanism
9. Remove `build: ./gpu-hub` default from base compose (make overlay the permanent path)

---

## 12. GREEN / YELLOW / RED Assessment

### GREEN Criteria (all must be met)
- ✅ Builds independently
- ✅ Publishes independently
- ✅ Deploys independently
- ✅ Restarts/reconnects independently
- ✅ Rolls back independently
- ✅ Zero monorepo source at runtime
- ✅ All API contracts are external/versioned
- ✅ All secrets are documented
- ❌ Artifact delivery is NOT independent (5 mounts)

### YELLOW Criteria (production-ready, limited dependencies)
- ✅ All GREEN criteria except artifact independence
- ✅ Mounts are read-only, non-destructive
- ✅ Mounts are operationally stable
- ✅ Mounts can be replaced by versioned artifacts
- ✅ No blocking architectural issues

### RED Criteria (blocking architectural issues)
- ❌ No blocking issues found

---

## VERDICT: YELLOW

The GPU Hub is **production-ready and operationally independent**. It can build, publish, deploy, restart, and roll back without monorepo checkout. The 5 artifact mounts are the sole remaining coupling — they are read-only, stable, and replaceable by versioned artifacts, but they prevent claiming full module independence.

**RECOMMENDED NEXT PHASE:** Phase 10R — Artifact Mount Elimination. Publish worker bundle, workflows, installer sources, and install manifests as versioned artifacts (npm packages or baked into GHCR image), then remove all 5 bind mounts from the compose configuration.
