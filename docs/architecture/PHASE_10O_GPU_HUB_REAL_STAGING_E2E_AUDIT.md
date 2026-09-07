# Phase 10O — GPU Hub Real Staging E2E Audit

**Date:** 2026-09-07
**Verdict:** READY FOR PRODUCTION CUTOVER

---

## 1. VPS Staging Environment

| Property | Value |
|----------|-------|
| User | `animastor` (uid=1001, gid=1002) |
| Groups | `animastor`, `docker` (group 999) |
| Root required | **NO** — all operations via docker group |
| Docker | v29.2.1 |
| Docker Compose | v5.0.2 |
| Platform | linux |

## 2. GHCR Image

| Property | Value |
|----------|-------|
| Image | `ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c` |
| Digest (running) | `sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c` |
| Pull verified | ✅ clean pull |
| `:latest` used | **NO** — digest-pinned |

## 3. Containers

| Container | Image | Status |
|-----------|-------|--------|
| `gpu-hub` | `ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807b...` | Running |
| `animastor-backend` | `animastor-backend` (local build) | Running (2 days) |
| `animastor-proxy` | `nginx:alpine` | Running (4 days) |
| `animastor-pg` | `postgres:16` | Healthy (13 days) |
| `animastor-redis` | `redis:7` | Healthy (13 days) |
| `ollama` | `ollama/ollama:latest` | Running (3 days) |

## 4. Docker Network

| Property | Value |
|----------|-------|
| Network | `animastor_net` (bridge) |
| All services on same network | ✅ |
| DNS resolution | ✅ `gpu-hub:5000` resolves from backend |

## 5. Backend → Hub Connectivity

| Check | Result |
|-------|--------|
| `HUB_URL` env | `http://gpu-hub:5000` ✅ |
| `GPU_HUB_API_KEY` env | Set ✅ |
| Backend health | `{"status":"ok","loop":true,"redis":"PONG"}` ✅ |
| Backend → Hub HTTP | `200 OK` ✅ |

## 6. Redis

| Check | Result |
|-------|--------|
| Connectivity | `PONG` ✅ |
| Hub-owned queue families | `animastor:queue:image` (8), `animastor:queue:audio` (0), `animastor:queue:video` (0) ✅ |
| Hub-owned workspace queue | `animastor:queue:image:ws:3317e019-...` (243) ✅ |
| Hub-owned registry | `animastor:gpu-hub:workers` (1 active worker) ✅ |
| Hub-owned processing | `animastor:processing` (0) ✅ |
| Hub-owned running | `animastor:running` (0) ✅ |
| Backend-owned worker-auth mirror | `animastor:worker-auth` (6 workers) ✅ |
| Hub reads, never writes worker-auth | ✅ |

## 7. Artifact Mounts (all 5 verified)

| # | Mount Source | Container Target | Verified |
|---|-------------|-----------------|----------|
| 1 | `worker/worker/worker.cjs` | `/app/worker-source/worker.cjs` | ✅ |
| 2 | `worker/worker/` | `/app/worker-bundle` | ✅ |
| 3 | `backend/ai/workflows/` | `/app/workflows` | ✅ |
| 4 | `backend/src/installer/` | `/app/installer-src` | ✅ |
| 5 | `backend/ai/install-manifests/` | `/app/install-manifests` | ✅ |

## 8. E2E Flow Tests

### 8.1 Backend → GPU Hub Task Submission

| Test | HTTP | Response |
|------|------|----------|
| `POST /task` with correct API key + valid workspace | 200 | `{"ok":true}` |
| `POST /task` with correct API key + invalid workspace (non-UUID) | 400 | `{"error":"invalid_workspace_id"}` |
| `POST /task` with missing required fields | 400 | `{"error":"incomplete_dispatch_identity"}` |
| Queue incremented after enqueue | — | 243→244→246 (verified) |

### 8.2 Queue Management

| Test | HTTP | Response |
|------|------|----------|
| `DELETE /queue/clear?book_id=X` | 200 | `{"ok":true,"removed":{"queued":1,...}}` |
| `DELETE /queue/clear?dispatch_id=X` | 200 | `{"ok":true,"removed":{"queued":1,...}}` |
| `DELETE /queue/clear?book_id=nonexistent` | 200 | `{"ok":true,"removed":{"queued":0,...}}` |
| Queue restored to original 243 | ✅ | All test tasks cleaned |

### 8.3 Artifact Delivery

| Endpoint | HTTP | Content-Type | Size |
|----------|------|-------------|------|
| `GET /worker-bundle` | 200 | `application/gzip` | 17,661 |
| `GET /worker-bundle/sha256` | 200 | `application/json` | — |
| `GET /worker-source` (deprecated) | 200 | `application/javascript` | 29,510 |
| `GET /installer` | 200 | `text/x-shellscript` | 8,262 |
| `GET /installer/bundle` | 200 | `application/gzip` | 179,577 |
| `GET /installer/sha256` | 200 | `application/json` | — |

### 8.4 Worker Beacon / Claim Flow

| Test | HTTP | Response |
|------|------|----------|
| `POST /beacon` without Bearer | 401 | `worker_authentication_failed` |
| `GET /task/next` without Bearer | 401 | `worker_authentication_failed` |
| `POST /task/result` without Bearer | 401 | `worker_authentication_failed` |
| `POST /task/error` without Bearer | 401 | `worker_authentication_failed` |
| `POST /beacon` with fake Bearer | 401 | `invalid_worker_credential` |
| `GET /task/next` with fake Bearer | 401 | `invalid_worker_credential` |

### 8.5 Callback Authentication

| Test | HTTP | Response |
|------|------|----------|
| Backend `/gpu/task/result` without API key | 401 | `unauthorized` |
| Backend `/gpu/task/error` without API key | 401 | `unauthorized` |
| Backend callback auth enforced | ✅ | `requireHubCallbackAuth` active |

## 9. Security

### 9.1 Fail-Closed API Key

| Test | HTTP | Expected |
|------|------|----------|
| `POST /task` without `x-api-key` | 401 | `unauthorized` ✅ |
| `POST /task` with wrong `x-api-key` | 401 | `unauthorized` ✅ |
| `DELETE /queue/clear` without `x-api-key` | 401 | `unauthorized` ✅ |
| `DELETE /queue/clear` with wrong `x-api-key` | 401 | `unauthorized` ✅ |

### 9.2 Fail-Closed Worker Auth

| Test | HTTP | Expected |
|------|------|----------|
| All worker endpoints without Bearer | 401 | `worker_authentication_failed` ✅ |
| All worker endpoints with fake Bearer | 401 | `invalid_worker_credential` ✅ |

### 9.3 Protocol Version Enforcement

| Test | HTTP | Response |
|------|------|----------|
| `POST /task` with `protocol_version: 999` | 409 | `protocol_version_mismatch` (expected: 2, received: 999) ✅ |

### 9.4 `GPU_HUB_ALLOW_OPEN`

| Check | Result |
|-------|--------|
| Not set in staging env | ✅ |
| Fail-closed behavior active | ✅ |

### 9.5 Source Isolation

| Check | Result |
|-------|--------|
| GPU Hub has no access to monorepo source (only mounted artifacts) | ✅ |
| GHCR image runs independently | ✅ |
| Digest-pinned, not `:latest` | ✅ |

## 10. Deployment Integrity

| Check | Result |
|-------|--------|
| `docker compose config` (overlay) valid | ✅ |
| Container image matches GHCR digest | ✅ |
| Docker network/DNS resolves | ✅ |
| Backend `HUB_URL` correct | ✅ |
| Redis connectivity from all services | ✅ |
| nginx `/gpu/` routing configured | ✅ (upstream → `gpu-hub:5000`) |
| nginx HTTP→HTTPS redirect active | ✅ (301) |
| Five artifact mounts present | ✅ |
| Health endpoint returns data | ✅ |
| Restart preserves image digest | ✅ |
| Restart preserves queue state | ✅ |
| Production compose unchanged | ✅ |

## 11. Regression Tests

| Suite | Result |
|-------|--------|
| Syntax smoke (full repo) | ✅ All production JS/CJS pass |
| GPU Hub (`npm test`) | ✅ 19/19 passed |
| Contracts (`npm test`) | ✅ 37/37 passed |
| Worker (`npm test`) | ✅ 45/45 passed |
| Backend (`npm test`) | ✅ 306/306 passed |
| Architecture guards | ✅ (included in backend 306) |
| Protocol parity | ✅ (included in GPU Hub 19 + Backend 306) |

**Total: 407/407 tests passed**

## 12. Issues Found

**None.** All E2E flows, security checks, artifact delivery, Redis state, and regression tests passed without issues.

## 13. Root Access

| Action | Root Required |
|--------|--------------|
| Docker operations | NO (docker group) |
| GHCR pull | NO |
| Container lifecycle | NO |
| Redis access | NO |
| File operations | NO |
| **Total** | **NO root required** |

## 14. Production Status

| Check | Result |
|-------|--------|
| Production compose unchanged | ✅ |
| Production containers untouched | ✅ |
| Production GPU Hub still uses local build | ✅ |
| No production traffic switched | ✅ |
| No commits to production | ✅ |

## 15. What Was Done

1. Verified VPS access (user, Docker, Compose, GHCR)
2. Pulled GHCR image (digest-verified)
3. Applied overlay compose (`overlay-gpu-hub-standalone.yml`) to switch GPU Hub to GHCR image
4. Verified GPU Hub running from GHCR image with exact digest
5. Verified all 5 artifact mounts
6. Ran comprehensive E2E tests (61 checks)
7. Ran full regression suite (407 tests)
8. Tested restart behavior (digest preserved, state preserved)
9. Cleaned up all test artifacts from Redis

## 16. Verdict

**READY FOR PRODUCTION CUTOVER**

- Full staging E2E successfully passed
- All 407 regression tests pass
- Security fail-closed verified
- GHCR image provenance confirmed
- No issues found
- No root required
- Production untouched

To cut over production:
```bash
GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c \
  docker compose \
    -f docker-compose.yml \
    -f docker/compose/overlay-gpu-hub-standalone.yml \
    up -d gpu-hub
```
