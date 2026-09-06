# Phase 10N — GPU Hub GHCR Release Audit

**Date:** 2026-09-06
**Author:** opencode (automated)
**Predecessor:** Phase 10M (GPU Hub GHCR Staging Verification Audit)

---

## 1. Repository State

| Repository | HEAD | Commit |
|---|---|---|
| **Monorepo** (`animastor`) | `99384796b8565f0f7c2d7da543257d24d73a47de` | `docs: Phase 10M — GPU Hub GHCR staging verification audit (BLOCKED: no gh CLI)` |
| **Standalone** (`Animastor/animastor-gpu-hub`) | `7c7778c6f313dad19eb403d8509cd297226ec7ea` | `fix: GHCR release workflow — lowercase image name for GHCR compatibility` |

---

## 2. GHCR Release

### 2.1 Workflow

| Item | Value |
|---|---|
| **Workflow** | `.github/workflows/ghcr-release.yml` |
| **Run ID** | `34050714459` |
| **Trigger** | `workflow_dispatch` with `image_tag=v0.1.0` |
| **Conclusion** | **SUCCESS** |
| **Image** | `ghcr.io/animastor/animastor-gpu-hub` |
| **Tag** | `v0.1.0` (immutable) |
| **No `:latest`** | Confirmed — workflow never produces `:latest` |

### 2.2 Fix Applied

First workflow run (`34050598813`) failed because `${{ github.repository }}` resolved to `Animastor/animastor-gpu-hub` (uppercase A). GHCR requires lowercase. Fixed by hardcoding `IMAGE_NAME: animastor/animastor-gpu-hub`.

### 2.3 Published Image

| Item | Value |
|---|---|
| **Registry** | `ghcr.io` |
| **Image** | `ghcr.io/animastor/animastor-gpu-hub:v0.1.0` |
| **Digest** | `sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c` |
| **Both tags** | `v0.1.0` and commit SHA → same digest (verified) |

---

## 3. Registry Pull Verification

### 3.1 Clean Pull by Digest

```
docker pull ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c
```

**Result:** PASS — pulled from registry (not local build)

### 3.2 Image/Runtime Smoke Tests: 11/11 PASS

| # | Check | Result |
|---|---|---|
| 1 | Health endpoint | PASS — `{"gpus":0,"queues":{...},"running":0}` |
| 2 | API key fail-closed (no key) | PASS — 401 |
| 3 | API key fail-closed (bad key) | PASS — 401 |
| 4 | Protocol gate (v1 → 409) | PASS — `protocol_version_mismatch` |
| 5 | `/task/next` unauth | PASS — 401 |
| 6 | Contracts PROTOCOL_VERSION | PASS — `2` |
| 7 | Contracts path | PASS — `/app/node_modules/@animastor/contracts/package.json` |
| 8 | Route freeze (404) | PASS |
| 9 | No monorepo source in image | PASS — no `/app/gpu-hub` or monorepo artifacts |
| 10 | No local PROTOCOL_VERSION literal | PASS — imported from `@animastor/contracts` |
| 11 | Contracts version | PASS — `0.1.0` |

### 3.3 Contracts Isolation

| Item | Result |
|---|---|
| Resolution path | `/app/node_modules/@animastor/contracts/package.json` |
| Version | `0.1.0` |
| Method | npm registry (`"@animastor/contracts": "^0.1.0"` in package.json) |
| No monorepo fallback | CONFIRMED |

---

## 4. Monorepo Staging Seam

### 4.1 Overlay Compose

| Component | Status |
|---|---|
| `GPU_HUB_IMAGE` env var | WIRED — used in `docker-compose.yml` |
| Overlay file | `docker/compose/overlay-gpu-hub-standalone.yml` — PRESENT |
| Base compose default | `build: ./gpu-hub` (local build, production unchanged) |
| Overlay behavior | Requires `GPU_HUB_IMAGE` set, refuses to activate without it |

### 4.2 Overlay Verification

With `GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c`:

| Item | Result |
|---|---|
| `image:` | `ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c` |
| `build:` | REMOVED (via `!reset null`) |
| Artifact mounts | 5 preserved |
| Compose config | VALID |
| Base compose (without overlay) | VALID — unchanged |

### 4.3 `.env.example` Updated

```bash
GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c
```

---

## 5. Staging E2E

**Status: NOT PERFORMED (no staging environment)**

Local smoke tests completed (section 3.2). Full staging E2E requires a running staging environment with backend/Redis/Worker.

---

## 6. Regression Verification

### 6.1 Test Suites

| Suite | Result |
|---|---|
| GPU Hub standalone (19/19) | PASS |
| GPU Hub monorepo (19/19) | PASS |
| Contracts (37/37) | PASS |
| Worker (45/45) | PASS |
| Backend (306/306) | PASS |
| Syntax smoke | All files OK |
| **Total** | **426/426 PASS** |

### 6.2 Stale Reference Check

| Check | Result |
|---|---|
| `:latest` in compose | NONE |
| `file:../contracts` in package.json | NONE |
| Backend → gpu-hub runtime imports | NONE |
| Docker compose config (base) | VALID |
| Docker compose config (overlay) | VALID |

---

## 7. Frozen Invariants

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

## 8. Files Changed

### Standalone repo (`animastor-gpu-hub`)

| File | Change |
|---|---|
| `.github/workflows/ghcr-release.yml` | Fixed `IMAGE_NAME` to lowercase for GHCR compatibility |

### Monorepo (`animastor`)

| File | Change |
|---|---|
| `.env.example` | Updated `GPU_HUB_IMAGE` with published digest |
| `docs/architecture/PHASE_10N_GPU_HUB_GHCR_RELEASE_AUDIT.md` | NEW — this document |

---

## 9. Verdict

### **READY FOR STAGING**

**What's verified:**
- GHCR image published: `ghcr.io/animastor/animastor-gpu-hub:v0.1.0`
- Digest: `sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c`
- Clean pull from registry: PASS
- Image/runtime smoke: 11/11 PASS
- `@animastor/contracts@0.1.0` from npm registry (not monorepo): CONFIRMED
- Staging seam (overlay + `GPU_HUB_IMAGE`): VERIFIED
- All regression: 426/426 PASS
- No `:latest`, no `file:../contracts`, no backend runtime GPU Hub imports
- Production NOT switched

**To use in staging:**
```bash
# Set in .env
GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c

# Run with overlay
docker compose \
  -f docker-compose.yml \
  -f docker/compose/overlay-gpu-hub-standalone.yml \
  up -d gpu-hub
```

**Production cutover: NOT PERFORMED (as specified).**
