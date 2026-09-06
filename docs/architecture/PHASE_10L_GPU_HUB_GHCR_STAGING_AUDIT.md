# Phase 10L — GPU Hub GHCR Release & Staging Audit

**Date:** 2026-09-06
**Author:** opencode (automated)
**Predecessor:** Phase 10K (GPU Hub Independent CI / Release Readiness)

---

## 1. GHCR Release

### Status: BLOCKED (no credentials)

| Item | Value |
|---|---|
| **Standalone repo** | `Animastor/animastor-gpu-hub` |
| **CI HEAD** | `b95bfdcd7d576f023e257784a8dc36d57ce8a0aa` |
| **Workflow** | `.github/workflows/ghcr-release.yml` — **ACTIVATED** (was disabled) |
| **Trigger** | `workflow_dispatch` with `image_tag` input |
| **Registry** | `ghcr.io` |
| **Image name** | `ghcr.io/animastor/animastor-gpu-hub` |
| **Tag strategy** | Version tag (`v0.1.0`) + commit SHA |
| **No `:latest`** | Confirmed — workflow never produces `:latest` |
| **Secret required** | `GHCR_IMAGE_PAT` (PAT with `write:packages` scope) |

### Blocker

No `gh` CLI installed. No GitHub credentials available. No Docker login for `ghcr.io`.
The workflow is fully activated and ready to run, but requires:
1. `gh` CLI installed and authenticated, OR
2. `GHCR_IMAGE_PAT` secret set in the GitHub repo settings
3. Push to GitHub (`git push origin main`)

### Local Build Verification

| Item | Result |
|---|---|
| Docker build | PASS — `animastor-gpu-hub:local-10l` built successfully |
| Image manifest digest | `sha256:f44528bf053388315088a352c34b3ce39995fadb925d3b2ce954149531202730` |
| Image size | 1.6GB (node:20 base) |
| Base image | `node:20@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5` |

---

## 2. Standalone Image Verification

### 2.1 Standalone Test Suite: 19/19 PASS

| Group | Checks | Result |
|---|---|---|
| Package smoke | 6 | PASS |
| Dependency isolation | 4 | PASS |
| Canonical contracts | 3 | PASS |
| Protocol parity | 1 | PASS |
| Route freeze | 2 | PASS |
| Redis ownership | 3 | PASS |

### 2.2 Docker Smoke Tests: 10/10 PASS

| Check | Result |
|---|---|
| Health endpoint | PASS — returns `{"gpus":0,"queues":{...},"running":0}` |
| API key fail-closed (no key) | PASS — 401 |
| API key fail-closed (bad key) | PASS — 401 |
| Protocol gate (v1 → 409) | PASS — `protocol_version_mismatch` |
| Protocol parity (v2) | PASS — `PROTOCOL_VERSION=2` |
| worker-bundle 404 token | PASS |
| installer 404 token | PASS |
| workflow 404 | PASS |
| Unauth /task/next | PASS — 401 |
| Route freeze (14 routes) | PASS |

### 2.3 CI Workflow Health Check Fix

The original CI workflows (`ci.yml`, `ghcr-release.yml`) checked for `"ok":true` in the health response. The actual health endpoint returns queue/running data without an `"ok"` field. Fixed both workflows to check for `"gpus":` instead.

---

## 3. Monorepo Staging Seam

### 3.1 Configuration

| Component | Status |
|---|---|
| `GPU_HUB_IMAGE` env var | WIRED — used in `docker-compose.yml` line 111 |
| Overlay file | `docker/compose/overlay-gpu-hub-standalone.yml` — PRESENT |
| Base compose default | `build: ./gpu-hub` (local build, production unchanged) |
| Overlay behavior | Requires `GPU_HUB_IMAGE` set, otherwise refuses to activate |

### 3.2 Chain Verification

```
GPU_HUB_IMAGE (env var)
  → GHCR GPU Hub image reference
    → HUB_URL (http://gpu-hub:5000)
      → API key (GPU_HUB_API_KEY)
        → Redis (REDIS_URL)
          → nginx "/gpu/" (unchanged)
            → пять artifact mounts (unchanged)
```

**Overlay compose test:**
- With `GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:placeholder-test`:
  - `image:` correctly set to the GHCR reference
  - `build:` removed via `!reset null`
  - All 5 artifact mounts preserved
  - Environment variables preserved
  - Service name, container name, networks preserved

**Base compose (without overlay):**
- Defaults to `build: ./gpu-hub` (local build)
- Production NOT switched

### 3.3 `.env.example` Documentation

```bash
# GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:<digest>
```

---

## 4. Staging E2E

**Status: BLOCKED (no staging environment)**

Real staging E2E requires:
- Standalone GPU Hub running from GHCR image
- Real staging Redis/backend/Worker
- Network connectivity between services

Local integration test completed (sections 2.1–2.2 above). Full staging E2E cannot be performed without a staging environment.

---

## 5. Regression Verification

### 5.1 Test Suites

| Suite | Result |
|---|---|
| GPU Hub standalone (monorepo) | 19/19 PASS |
| Contracts | 37/37 PASS |
| Worker | 45/45 PASS |
| Architecture guards | 306/306 PASS |
| Backend (full) | PASS (syntax + 306 mocha) |
| Syntax smoke | All files OK |

### 5.2 Architecture Guards

Key Phase 10L-relevant guards verified:
- **TF1:** `gpu-hub/` exists as transitional fixture ✅
- **TF2:** No `backend/src` runtime imports into `gpu-hub/` ✅
- **TF3:** Compose image parameterization works ✅
- **TF4:** Five artifact mounts frozen ✅
- **TF5:** Production default unchanged (`build: ./gpu-hub`) ✅
- **Package boundary:** `@animastor/gpu-hub@0.1.0`, frozen deps ✅
- **Protocol parity:** hub PROTOCOL_VERSION === canonical contracts value ✅
- **Route freeze:** exactly 14 routes ✅
- **Redis ownership:** hub-owned keys frozen, mirror never written ✅

### 5.3 Stale Reference Check

| Check | Result |
|---|---|
| `file:../contracts` in package.json | NONE |
| Local `PROTOCOL_VERSION` literal in hub | NONE |
| `:latest` tag usage | NONE (only in `.env.example` as documentation) |
| Backend → gpu-hub runtime imports | NONE (test-time only, guarded) |

---

## 6. Frozen Invariants

| Invariant | Status |
|---|---|
| API/14 routes | FROZEN — unchanged |
| Redis ownership | FROZEN — unchanged |
| Auth/API key | FROZEN — unchanged |
| Job Protocol v2 | FROZEN — unchanged |
| Worker Protocol | FROZEN — unchanged |
| nginx "/gpu/" | FROZEN — unchanged |
| Five artifact mounts | FROZEN — unchanged |
| `gpu-hub/` in monorepo | PRESERVED — not deleted |
| Production compose | UNCHANGED — still builds `./gpu-hub` |

---

## 7. Files Changed

### Standalone repo (`animastor-gpu-hub`)

| File | Change |
|---|---|
| `.github/workflows/ghcr-release.yml` | Activated: `on: workflow_dispatch`, enabled login/push |
| `.github/workflows/ci.yml` | Fixed health check grep (`"gpus":` not `"ok":true`) |

### Monorepo (`animastor`)

| File | Change |
|---|---|
| `docs/architecture/PHASE_10L_GPU_HUB_GHCR_STAGING_AUDIT.md` | NEW — this document |

---

## 8. Verdict

### **BLOCKED**

**Reason:** No GitHub credentials / `gh` CLI available for GHCR publication.

**What's ready:**
- GHCR release workflow activated and tested locally
- Docker image builds and passes all smoke tests
- Monorepo staging seam verified (overlay + GPU_HUB_IMAGE)
- All regression tests pass (19+37+45+306)
- No production changes made

**To unblock:**
1. Install `gh` CLI and authenticate: `gh auth login`
2. Set `GHCR_IMAGE_PAT` secret in `Animastor/animastor-gpu-hub` repo settings
3. Push standalone repo to GitHub: `git push origin main`
4. Trigger workflow: `gh workflow run gpu-hub-ghcr-release -f image_tag=v0.1.0`
5. Record digest from workflow summary
6. Set `GPU_HUB_IMAGE` in monorepo `.env` with the pinned digest
7. Run staging E2E

**Production cutover: NOT PERFORMED (as specified).**
