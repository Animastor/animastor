# Phase 10V — GPU Hub Production Cutover (Artifact-Baked Image)

**Date:** 2026-09-07
**Verdict:** GREEN — GPU Hub production cutover successful

## Production Image

| Field | Value |
|-------|-------|
| Image | `ghcr.io/animastor/animastor-gpu-hub` |
| Tag | `10v` |
| Digest | `sha256:0ee3879a552ddc888e20c43b70040d1ff37536df1b7cb8c54c9698eb2932f17a` |
| Source commit | `ea12aeb6` (Phase 10T.2) |
| Build context | Monorepo root (`context: .`) |
| Base image | `node:20-slim` |
| Artifact bake-in | 4 groups via multi-stage `COPY --from=stager` |

## Rollback Reference

| Field | Value |
|-------|-------|
| Previous image | `ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c` |
| Rollback command | `sed -i 's|^GPU_HUB_IMAGE=.*|GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807b7c20f3fd62d08221be132fdbe9d51070c4b1dd8fd3114a34a7afb2c|' .env && docker compose up -d gpu-hub` |

## Deployment

| Step | Result |
|------|--------|
| Build | ✅ Multi-stage Dockerfile builds successfully |
| Push | ✅ Pushed to GHCR with immutable digest |
| Pull | ✅ `docker compose pull` succeeds |
| Recreate | ✅ Container recreated with new image |
| Startup | ✅ `🚀 GPU HUB running on 5000` |
| Restart count | 0 (no unexpected restarts) |

## Artifact Independence

| Check | Result |
|-------|--------|
| `/app/artifacts/worker-bundle/` | ✅ Present (worker v2.1.0) |
| `/app/artifacts/workflows/` | ✅ Present (9 workflow files) |
| `/app/artifacts/installer-src/` | ✅ Present (installer v1.3.0) |
| `/app/artifacts/install-manifests/` | ✅ Present (3 manifests) |
| Bind mounts | ✅ ZERO — container has no volume mounts |
| `resolveArtifactDir()` | ✅ All 4 resolve to `/app/artifacts/*` |
| `check-artifacts.sh` | ✅ ALL CHECKS PASSED (6/6 groups) |
| `/worker-source` | ✅ Not present in image or runtime code |
| Monorepo filesystem dependency | ✅ ZERO at runtime |

## E2E Verification

| Check | Result |
|-------|--------|
| Health endpoint | ✅ `{"gpus":1,"queues":{...},"running":0}` |
| Backend → GPU Hub | ✅ HTTP 200 |
| Redis → GPU Hub | ✅ Connected |
| Worker bundle endpoint | ✅ Available via baked-in artifacts |
| Workflow endpoint | ✅ Available via baked-in artifacts |
| Installer endpoint | ✅ Available via baked-in artifacts |
| Install manifests | ✅ Available via baked-in artifacts |
| Protocol v2 | ✅ Frozen, parity with `@animastor/contracts` |
| Route surface | ✅ Exactly 13 frozen routes |

## Test Results

| Suite | Result |
|-------|--------|
| `gpu-hub/tests/run-all.cjs` | ✅ 22/22 |
| `phase10t-1-artifact-bakein.test.js` | ✅ 13/13 |
| `phase10a-gpu-hub-contract-freeze.test.js` | ✅ 11/11 |
| `phase10d-gpu-hub-package-boundary.test.js` | ✅ 18/18 |
| `phase10j-gpu-hub-transitional-fixture.test.js` | ✅ 10/10 |
| `phase9d-worker-package.test.js` | ✅ 16/16 |
| **Total** | **✅ 90/90** |

## Restart / Persistence

| Check | Result |
|-------|--------|
| Graceful shutdown | ✅ SIGTERM → clean close |
| Restart | ✅ Container restarts cleanly |
| Post-restart health | ✅ Valid response |
| State preservation | ✅ Queues intact |
| Artifact resolution after restart | ✅ Still baked-in paths |

## Scope Compliance

| Item | Status |
|------|--------|
| GPU Hub API | ✅ Unchanged (13 routes) |
| Job Protocol v2 | ✅ Unchanged |
| Worker version | ✅ 2.1.0 (unchanged) |
| Manifest schema | ✅ 1.0.0 (unchanged) |
| Backend contracts | ✅ Unchanged |
| Auth/API key | ✅ Unchanged |
| Callback flow | ✅ Unchanged |
| Nginx architecture | ✅ Unchanged |
| Redis architecture | ✅ Unchanged |

## Files Changed

| File | Change |
|------|--------|
| `gpu-hub/Dockerfile` | Multi-stage build with artifact staging |
| `docker-compose.yml` | Build context → repo root (`context: .`) |
| `.dockerignore` | New — optimizes build context |
| `scripts/check-artifacts.sh` | New — integrity validator (node-based) |
| `gpu-hub/tests/run-all.cjs` | Added section 7 (artifact bake-in tests) |
| `backend/tests/architecture/phase10t-1-artifact-bakein.test.js` | New — 13 architecture checks |
| `backend/tests/architecture/phase10d-gpu-hub-package-boundary.test.js` | Updated for multi-stage Dockerfile |
| `backend/tests/architecture/phase10j-gpu-hub-transitional-fixture.test.js` | Updated for new build syntax |

## Conclusion

GPU Hub is now fully independent from monorepo filesystem at runtime. The production image contains all 4 artifact groups baked in via multi-stage Docker build. No bind mounts, no monorepo path dependencies, no `/worker-source`. The image is pinned by immutable digest and can be rolled back independently.
