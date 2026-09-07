# Phase 10R — GPU Hub Artifact Decoupling Plan

**Date:** 2026-09-07
**Verdict:** READY FOR IMPLEMENTATION

---

## 1. Executive Summary

After Phase 10Q identified 5 runtime artifact mounts as the sole remaining coupling between standalone `animastor-gpu-hub` and monorepo, this document defines the technical plan to eliminate them.

**Recommended approach:** Bake all 4 active artifacts (worker bundle, workflows, installer sources, install manifests) directly into the GHCR image at build time. Remove the deprecated Mount 5 immediately.

**Why bake, not npm/CDN/bundle:**
- Artifacts change infrequently (last changes: 2-4 weeks ago)
- GPU Hub already has fingerprint-based caching for worker bundle and installer
- Baking avoids new infrastructure (CDN, npm packages, object storage)
- CI pipeline already builds the Docker image — natural integration point
- Zero new operational complexity

**Migration phases:**
1. Remove deprecated `/worker-source` endpoint + Mount 5 (immediate)
2. Create artifact build stage in Dockerfile (bake worker bundle + workflows + installer + manifests into image)
3. Remove bind mounts from compose, add artifact version env vars
4. Update CI to copy artifacts at build time
5. Update standalone repo to accept artifact inputs

**Target state:** GPU Hub container runs from immutable GHCR image with zero bind mounts to monorepo. All artifacts are versioned inside the image.

---

## 2. Current State

### 2.1 Production Configuration

```
┌─────────────────────────────────────────────────────────────┐
│  gpu-hub container (GHCR immutable image)                    │
│  ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a98...       │
│                                                              │
│  BAKED IN:                                                   │
│  ├── gpu-hub.js (85KB)                                       │
│  ├── server.js, tarball.js, bootstrap.js                     │
│  ├── node_modules/ (express, ioredis, cors, contracts)       │
│  └── README.md, LICENSE                                      │
│                                                              │
│  MOUNTED (5 bind mounts, read-only):                         │
│  ├── worker/worker/ → /app/worker-bundle                     │
│  ├── backend/ai/workflows/ → /app/workflows                  │
│  ├── backend/src/installer/ → /app/installer-src             │
│  ├── backend/ai/install-manifests/ → /app/install-manifests   │
│  └── worker/worker/worker.cjs → /app/worker-source (DEPRECATED)
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Artifact Inventory

| # | Artifact | Version | Owner | Producer | Files | Last Changed |
|---|----------|---------|-------|----------|-------|-------------|
| 1 | Worker bundle | `2.1.0` | Worker team | `worker/worker/` | 8 files (29KB worker.cjs + deps) | 2026-09-06 |
| 2 | Workflows | (none) | Backend AI team | `backend/ai/workflows/` | 10 JSON files (8 active + 2 legacy) | 2026-08-22 |
| 3 | Installer sources | `1.3.0` | Backend installer team | `backend/src/installer/` | 31 files (cli.js + engine + platform) | 2026-08-31 |
| 4 | Install manifests | schema `1.0.0` | Backend AI team | `backend/ai/install-manifests/` | 3 JSON files (audio/image/video) | 2026-09-06 |
| 5 | Worker source | `2.1.0` (deprecated) | Worker team | `worker/worker/worker.cjs` | 1 file (duplicate of Mount 1) | 2026-09-06 |

### 2.3 Runtime Consumption Patterns

| Artifact | Route | Read Pattern | Caching | Error Token |
|----------|-------|-------------|---------|-------------|
| Worker bundle | `GET /worker-bundle` | Per-request fingerprint check; rebuild on change | Fingerprint-based (size+mtime) | `worker_bundle_unavailable` |
| Workflows | `GET /workflow/:id` | Per-request: allowlist scan + file read | None | `workflow_not_found` / `workflow_unavailable` |
| Installer bootstrap | `GET /installer` | Per-request: version + profile allowlist + script generation | None | `installer_unavailable` |
| Installer bundle | `GET /installer/bundle` | Per-request: 4-dir fingerprint check; rebuild on change | Fingerprint-based | `installer_unavailable` |
| Manifests | (internal) | Per-request: walk + parse all JSON files | None | Implicit (empty allowlist → 404) |
| Worker source | `GET /worker-source` | Per-request: single file read | None | `worker_source_unavailable` |

---

## 3. Complete Artifact Inventory

### 3.1 Mount 1: Worker Bundle

**Path:** `worker/worker/` → `/app/worker-bundle`

| Property | Value |
|----------|-------|
| Owner | Worker team |
| Producer | `worker/worker/` directory in monorepo |
| Consumer | GPU Hub (`GET /worker-bundle`), installer bundle assembly |
| Lifecycle | Updated when worker runtime changes (infrequent) |
| Current version | `2.1.0` (from `package.json`) |
| Delivery to production | Bind mount from host filesystem |
| Breakage if removed | `GET /worker-bundle` returns 404; installer bundle cannot assemble |
| Files | `worker.cjs` (29KB), `job-protocol-v2.cjs`, `worker-cleanup.cjs`, `worker-cleanup-journal.cjs`, `worker-env.cjs`, `package.json`, `package-lock.json`, `.env.example` |

**Cross-references:**
- Install manifests declare `worker_bundle.min_version: "2.0.0"` — any worker ≥ 2.0.0 is acceptable
- Installer reads worker version via `getWorkerBundleVersion()` at runtime
- Worker reports version in beacons via `require("./package.json").version`

### 3.2 Mount 2: Workflows

**Path:** `backend/ai/workflows/` → `/app/workflows`

| Property | Value |
|----------|-------|
| Owner | Backend AI team |
| Producer | `backend/ai/workflows/` directory in monorepo |
| Consumer | GPU Hub (`GET /workflow/:id`), installer bundle assembly |
| Lifecycle | Updated when ComfyUI workflows change (infrequent) |
| Current version | None (no version metadata in files) |
| Delivery to production | Bind mount from host filesystem |
| Breakage if removed | `GET /workflow/:id` returns 404; installer cannot resolve workflows |
| Files | 10 JSON files: `img-qwen-image.json`, `tts-qwen-dialogue.json`, `tts-qwen-narrator.json`, `video-ltx-{1,2,3,4}p.json`, `old_img-qwen-image.json`, `old_video-ltx.json` |

**Cross-references:**
- Install manifests reference workflows by ID and `baseline_sha256`
- Manifest `workflows.artifacts[]` defines the allowlist for `GET /workflow/:id`
- Legacy `old_*` files are excluded by the allowlist mechanism

### 3.3 Mount 3: Installer Sources

**Path:** `backend/src/installer/` → `/app/installer-src`

| Property | Value |
|----------|-------|
| Owner | Backend installer team |
| Producer | `backend/src/installer/` directory in monorepo |
| Consumer | GPU Hub (`GET /installer`, `GET /installer/bundle`, `GET /installer/sha256`) |
| Lifecycle | Updated when installer logic changes (moderate frequency) |
| Current version | `1.3.0` (from `package.json`) |
| Delivery to production | Bind mount from host filesystem |
| Breakage if removed | All installer endpoints return 404 |
| Files | 31 files: `cli.js` (46KB), `setup-contract.js` (63KB), `compatibility-resolver.js` (58KB), `engine/` (13 files), `platform/` (4 files), plus supporting modules |

**Cross-references:**
- `setup-contract.js` reads worker version via `getWorkerBundleVersion()` (relative path to `../../worker/worker/package.json`)
- GPU Hub reads installer version from `package.json` for bootstrap script embedding
- Installer bundle embeds all 4 artifact directories

### 3.4 Mount 4: Install Manifests

**Path:** `backend/ai/install-manifests/` → `/app/install-manifests`

| Property | Value |
|----------|-------|
| Owner | Backend AI team |
| Producer | `backend/ai/install-manifests/` directory in monorepo |
| Consumer | GPU Hub (workflow allowlist, profile allowlist, installer bundle) |
| Lifecycle | Updated when profiles change (infrequent) |
| Current version | Schema `1.0.0`, revision `2026.08.27-r1` |
| Delivery to production | Bind mount from host filesystem |
| Breakage if removed | Workflow and profile allowlists become empty; all `/workflow/:id` and `/installer?profile=` return 404 |
| Files | 3 JSON files: `audio/qwen-tts.json`, `image/qwen-image.json`, `video/ltx-2.3.json` |

**Cross-references:**
- `loadWorkflowAllowlist()` scans manifests to build workflow ID allowlist
- `loadProfileAllowlist()` scans manifests to build profile ID allowlist
- Manifests reference workflows by ID and `baseline_sha256`
- Manifests reference worker bundle by `min_version`
- Manifests are embedded in installer bundle

### 3.5 Mount 5: Worker Source (DEPRECATED)

**Path:** `worker/worker/worker.cjs` → `/app/worker-source/worker.cjs`

| Property | Value |
|----------|-------|
| Owner | Worker team |
| Producer | `worker/worker/worker.cjs` (duplicate of Mount 1 file) |
| Consumer | GPU Hub (`GET /worker-source` — deprecated) |
| Lifecycle | Same as Mount 1 (duplicate) |
| Current version | `2.1.0` |
| Delivery to production | Bind mount from host filesystem |
| Breakage if removed | `GET /worker-source` returns 404 (deprecated endpoint) |
| Files | 1 file: `worker.cjs` (29KB) — exact duplicate of Mount 1's `worker.cjs` |

**Deprecation status:**
- Endpoint returns `Deprecation: true` header
- Response includes `Link: </worker-bundle>; rel="successor-version"`
- Error token: `worker_source_unavailable`
- All 3 install manifests list it as an `animastor-origin` source option (alongside `worker-bundle`)
- Installer fallback (`worker.js:71-78`) uses it as last-resort download path

**References requiring update for removal:**

| Category | Files | Impact |
|----------|-------|--------|
| Production code | `gpu-hub.js:1286-1311`, `installer/engine/worker.js:71-78`, `frontends/app/src/features/workers/privateWorkers.ts:123-124`, `frontends/android/.../BetaSettingsHelpers.kt:150-151` | Must update before removal |
| Config | `docker-compose.yml:128-132`, 3 install manifests | Must update before removal |
| Tests | 11 test files across backend, gpu-hub, frontends | Must update before removal |
| Documentation | `GPU_HUB_CONTRACT.md`, `ARCHITECTURE.md`, 10+ PHASE docs | Can update after removal |

---

## 4. Options Comparison

### 4.1 Option A: Bake into GPU Hub Image

**Mechanism:** Copy artifacts into the Docker image at build time via multi-stage build or COPY instructions.

| Criterion | Assessment |
|-----------|-----------|
| Versioning | ✅ Version pinned by image digest — immutable |
| Reproducibility | ✅ Same image = same artifacts — deterministic |
| Rollback | ✅ Rollback image = rollback artifacts — atomic |
| Security | ✅ No network transfer at runtime; read-only filesystem |
| CI complexity | ✅ LOW — extend existing `ghcr-release.yml` with artifact copy step |
| Release ordering | ⚠️ MEDIUM — artifact changes require new image build |
| Compatibility | ✅ GPU Hub already has fingerprint-based caching |
| Independent deploy | ⚠️ MEDIUM — artifact changes require image rebuild (not independent of GPU Hub release) |
| Atomic artifact update | ⚠️ MEDIUM — requires new image build, but atomic at container level |
| Migration complexity | ✅ LOW — modify Dockerfile + CI, remove mounts from compose |
| Operational risk | ✅ LOW — same runtime behavior, just different delivery mechanism |

**Verdict: RECOMMENDED** — simplest approach, lowest operational risk.

### 4.2 Option B: Versioned npm Package

**Mechanism:** Publish each artifact as a separate npm package. GPU Hub installs them at build time via `npm ci`.

| Criterion | Assessment |
|-----------|-----------|
| Versioning | ✅ npm semver — exact version pinning |
| Reproducibility | ✅ package-lock.json — deterministic |
| Rollback | ⚠️ MEDIUM — change package.json version + rebuild |
| Security | ✅ npm registry integrity checks |
| CI complexity | ⚠️ MEDIUM — need 4 separate npm publish workflows |
| Release ordering | ⚠️ HIGH — 4 artifact packages + GPU Hub image = 5 coordinated releases |
| Compatibility | ⚠️ MEDIUM — need to ensure version compatibility matrix |
| Independent deploy | ✅ HIGH — artifacts can be updated independently via npm |
| Atomic artifact update | ⚠️ MEDIUM — requires new image build after npm publish |
| Migration complexity | ⚠️ MEDIUM — create 4 npm packages, update Dockerfile |
| Operational risk | ⚠️ MEDIUM — new npm dependencies to maintain |

**Verdict: VIABLE but OVER-ENGINEERED** for current artifact change frequency.

### 4.3 Option C: Object Storage / CDN

**Mechanism:** Publish artifacts to S3/R2/GCS. GPU Hub fetches them at startup or on-demand.

| Criterion | Assessment |
|-----------|-----------|
| Versioning | ✅ Immutable URLs with version/digest |
| Reproducibility | ✅ Deterministic fetch |
| Rollback | ✅ Change URL reference |
| Security | ⚠️ MEDIUM — requires auth tokens, network transfer |
| CI complexity | ⚠️ HIGH — need upload pipeline, CDN config, auth management |
| Release ordering | ⚠️ HIGH — CDN propagation, cache invalidation |
| Compatibility | ⚠️ MEDIUM — need to implement fetch+cache in GPU Hub |
| Independent deploy | ✅ HIGH — artifacts updated independently |
| Atomic artifact update | ✅ HIGH — atomic URL swap |
| Migration complexity | ⚠️ HIGH — new infrastructure, code changes, auth setup |
| Operational risk | ⚠️ HIGH — new failure modes (network, CDN, auth) |

**Verdict: NOT RECOMMENDED** — too much infrastructure for infrequent artifact changes.

### 4.4 Option D: Pre-generated Immutable Bundle

**Mechanism:** Pre-build artifact archives (tar.gz) and host them alongside the GPU Hub image. GPU Hub mounts or fetches them.

| Criterion | Assessment |
|-----------|-----------|
| Versioning | ✅ Digest-pinned archives |
| Reproducibility | ✅ Pre-built = deterministic |
| Rollback | ✅ Change archive reference |
| Security | ✅ No network transfer if mounted |
| CI complexity | ⚠️ MEDIUM — need to build and publish 4 archives |
| Release ordering | ⚠️ MEDIUM — archives must be built before GPU Hub image |
| Compatibility | ✅ Same as current mount behavior |
| Independent deploy | ⚠️ MEDIUM — archives must exist before image build |
| Atomic artifact update | ⚠️ MEDIUM — requires new image build |
| Migration complexity | ⚠️ MEDIUM — new build pipeline for archives |
| Operational risk | ✅ LOW — similar to current mount behavior |

**Verdict: VIABLE but ADDS COMPLEXITY** without clear benefit over Option A.

### 4.5 Comparison Matrix

| Criterion | A: Bake | B: npm | C: CDN | D: Bundle |
|-----------|---------|--------|--------|-----------|
| Versioning | ✅ | ✅ | ✅ | ✅ |
| Reproducibility | ✅ | ✅ | ✅ | ✅ |
| Rollback | ✅ | ⚠️ | ✅ | ✅ |
| Security | ✅ | ✅ | ⚠️ | ✅ |
| CI complexity | ✅ LOW | ⚠️ MED | ⚠️ HIGH | ⚠️ MED |
| Release ordering | ⚠️ MED | ⚠️ HIGH | ⚠️ HIGH | ⚠️ MED |
| Compatibility | ✅ | ⚠️ | ⚠️ | ✅ |
| Independent deploy | ⚠️ MED | ✅ HIGH | ✅ HIGH | ⚠️ MED |
| Atomic update | ⚠️ MED | ⚠️ MED | ✅ HIGH | ⚠️ MED |
| Migration complexity | ✅ LOW | ⚠️ MED | ⚠️ HIGH | ⚠️ MED |
| Operational risk | ✅ LOW | ⚠️ MED | ⚠️ HIGH | ✅ LOW |
| **OVERALL** | **✅ BEST** | ⚠️ | ❌ | ⚠️ |

---

## 5. Recommended Architecture

### 5.1 Design Decision: Bake into Image

**Rationale:**
1. Artifacts change infrequently (worker: monthly, workflows: quarterly, installer: monthly, manifests: monthly)
2. GPU Hub already has fingerprint-based caching — baked artifacts work identically
3. No new infrastructure required
4. CI pipeline already builds the Docker image — natural integration point
5. Atomic rollback: previous image = previous artifacts
6. Zero new failure modes

### 5.2 Implementation Design

#### 5.2.1 Dockerfile Changes

```dockerfile
# Stage 1: Build GPU Hub application
FROM node:20 AS hub-builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

# Stage 2: Prepare artifacts
FROM alpine:3.19 AS artifact-prep
# Worker bundle
COPY worker/worker/ /artifacts/worker-bundle/
# Workflows (only active, exclude old_*)
COPY backend/ai/workflows/ /artifacts/workflows/
# Installer sources
COPY backend/src/installer/ /artifacts/installer-src/
# Install manifests
COPY backend/ai/install-manifests/ /artifacts/install-manifests/

# Stage 3: Final image
FROM node:20-slim
WORKDIR /app
COPY --from=hub-builder /app/node_modules ./node_modules
COPY --from=hub-builder /app/gpu-hub.js /app/server.js /app/tarball.js /app/bootstrap.js ./
COPY --from=artifact-prep /artifacts/ ./artifacts/
EXPOSE 5000
CMD ["node", "server.js"]
```

#### 5.2.2 GPU Hub Source Changes

Add new configuration constants (with fallback to current mount paths for backward compatibility):

```javascript
// Artifact directories — prefer baked-in, fallback to mounts
const ARTIFACT_BASE = path.join(__dirname, 'artifacts');
const WORKER_BUNDLE_DIR = fs.existsSync(path.join(ARTIFACT_BASE, 'worker-bundle'))
  ? path.join(ARTIFACT_BASE, 'worker-bundle')
  : process.env.WORKER_BUNDLE_DIR || '/app/worker-bundle';
const WORKFLOW_DIR = fs.existsSync(path.join(ARTIFACT_BASE, 'workflows'))
  ? path.join(ARTIFACT_BASE, 'workflows')
  : process.env.WORKFLOW_DIR || '/app/workflows';
const INSTALLER_SRC_DIR = fs.existsSync(path.join(ARTIFACT_BASE, 'installer-src'))
  ? path.join(ARTIFACT_BASE, 'installer-src')
  : process.env.INSTALLER_SRC_DIR || '/app/installer-src';
const INSTALLER_MANIFESTS_DIR = fs.existsSync(path.join(ARTIFACT_BASE, 'install-manifests'))
  ? path.join(ARTIFACT_BASE, 'install-manifests')
  : process.env.INSTALLER_MANIFESTS_DIR || '/app/install-manifests';
```

This provides:
- **Backward compatibility:** Falls back to mount paths if `artifacts/` doesn't exist
- **Forward compatibility:** Uses baked-in artifacts when available
- **Zero config:** Works without environment variables

#### 5.2.3 Compose Changes

```yaml
# Remove all 5 bind mounts from docker-compose.yml:
# volumes:
#   - ./worker/worker/worker.cjs:/app/worker-source/worker.cjs:ro    # REMOVE
#   - ./worker/worker:/app/worker-bundle:ro                           # REMOVE
#   - ./backend/ai/workflows:/app/workflows:ro                       # REMOVE
#   - backend/src/installer:/app/installer-src:ro                    # REMOVE
#   - backend/ai/install-manifests:/app/install-manifests:ro          # REMOVE
```

#### 5.2.4 CI Pipeline Changes

Extend `ghcr-release.yml` to copy artifacts before build:

```yaml
- name: Prepare artifacts
  run: |
    mkdir -p artifacts/worker-bundle artifacts/workflows artifacts/installer-src artifacts/install-manifests
    cp -r worker/worker/* artifacts/worker-bundle/
    cp -r backend/ai/workflows/* artifacts/workflows/
    cp -r backend/src/installer/* artifacts/installer-src/
    cp -r backend/ai/install-manifests/* artifacts/install-manifests/

- name: Build image with artifacts
  run: docker build -t $IMAGE_TAG .
```

---

## 6. Versioning & Compatibility Model

### 6.1 Version Matrix

| Component | Current Version | Versioning | Pinning |
|-----------|----------------|-----------|---------|
| GPU Hub | `0.1.0` | npm semver | Image digest |
| Worker bundle | `2.1.0` | npm semver | Image digest (baked) |
| Workflows | (none) | File content | Image digest (baked) |
| Installer sources | `1.3.0` | npm semver | Image digest (baked) |
| Install manifests | schema `1.0.0` | revision string | Image digest (baked) |
| `@animastor/contracts` | `0.1.0` | npm semver | package-lock.json |
| Job Protocol | v2 (frozen) | Integer | Code-level parity guards |

### 6.2 Compatibility Rules

| Rule | Enforcement |
|------|------------|
| Worker ≥ 2.0.0 required by manifests | `worker_bundle.min_version: "2.0.0"` in manifests |
| Protocol version must match | `PROTOCOL_VERSION = 2` checked by all 3 components |
| GPU Hub image contains compatible artifacts | Baked at build time — always in sync |
| Installer reads worker version dynamically | `getWorkerBundleVersion()` reads from baked artifacts |
| Workflow allowlist derived from baked manifests | `loadWorkflowAllowlist()` reads from baked manifests |

### 6.3 Rollback Matrix

| Scenario | Rollback Action | Risk |
|----------|----------------|------|
| GPU Hub code regression | Rollback image to previous digest | LOW — artifacts also roll back |
| Worker bundle incompatibility | Rollback image to previous worker version | LOW — atomic with GPU Hub |
| Workflow change breaks generation | Rollback image to previous workflow set | LOW — atomic with GPU Hub |
| Installer bug | Rollback image to previous installer version | LOW — atomic with GPU Hub |
| Manifest change breaks allowlist | Rollback image to previous manifest set | LOW — atomic with GPU Hub |

**Key insight:** Baking artifacts into the image makes ALL rollbacks atomic — rolling back the image rolls back everything.

### 6.4 Incompatible Combination Prevention

| Combination | Prevention |
|-------------|-----------|
| Old worker + new GPU Hub | Worker version check in manifests (`min_version`) |
| New worker + old GPU Hub | Worker beacons include version; backend can reject |
| Protocol mismatch | `PROTOCOL_VERSION` checked at `/task` submission |
| Missing manifest workflow | Allowlist mechanism returns 404 |
| Missing installer source | Fingerprint check returns 404 |

---

## 7. Migration Phases

### Phase 10S: Remove Deprecated `/worker-source` Endpoint

**What changes:**
- Remove `GET /worker-source` handler from `gpu-hub.js` (lines 1286-1311)
- Remove Mount 5 from `docker-compose.yml` (lines 128-132)
- Remove `worker-source` references from install manifests
- Update installer fallback to use `worker-bundle` instead
- Update frontend `buildSetupContract()` to use `worker-bundle`
- Update all test files (11 files)
- Update `GPU_HUB_CONTRACT.md` route table

**Backward compatibility:** Breaking — `GET /worker-source` will return 404. All consumers must use `GET /worker-bundle` instead.

**Production restart required:** YES (new GPU Hub image)

**Verification:**
- `GET /worker-source` returns 404
- `GET /worker-bundle` still works
- Installer uses `worker-bundle` endpoint
- All tests pass

**Rollback:** Restore previous GPU Hub image with `/worker-source` endpoint

**Success criteria:** Zero references to `/worker-source` in production code; all tests updated and passing

### Phase 10T: Bake Artifacts into GHCR Image

**What changes:**
- Update `gpu-hub/Dockerfile` to multi-stage build with artifact copy
- Update `gpu-hub/.dockerignore` to exclude `artifacts/` from build context (it's built in)
- Update `gpu-hub/server.js` to prefer `artifacts/` directory
- Remove bind mounts from `docker-compose.yml`
- Update CI to copy artifacts before build
- Update standalone repo to accept artifact inputs

**Backward compatibility:** Full — GPU Hub code detects baked-in vs mounted artifacts

**Production restart required:** YES (new GPU Hub image)

**Verification:**
- Container has `/app/artifacts/` directory with all 4 artifact sets
- All endpoints work without bind mounts
- Fingerprint caching still works
- Rollback to previous image restores mount-based behavior

**Rollback:** Restore previous image + restore bind mounts in compose

**Success criteria:** Container runs with zero bind mounts; all endpoints functional

### Phase 10U: Update Standalone Repo CI

**What changes:**
- Update standalone repo's `ghcr-release.yml` to accept artifact inputs
- Add artifact preparation step to CI
- Update standalone repo's `Dockerfile` to copy artifacts
- Add artifact version tracking to release summary

**Backward compatibility:** Full — standalone repo can still build without artifacts (fallback to mounts)

**Production restart required:** NO (CI change only, no runtime impact)

**Verification:**
- Standalone CI builds image with artifacts
- `npm pack` surface unchanged
- Smoke tests pass with baked artifacts

**Rollback:** Revert CI changes

**Success criteria:** Standalone repo builds self-contained image

### Phase 10V: Cleanup

**What changes:**
- Remove `gpu-hub-rebuild.sh` (obsolete)
- Remove `build: ./gpu-hub` default from compose (make overlay permanent)
- Update all documentation to reflect new architecture
- Remove legacy `old_*` workflow files from image build
- Archive Phase 10R-10U audit documents

**Backward compatibility:** Full

**Production restart required:** NO (cleanup only)

**Verification:**
- No references to mount-based delivery in active code
- Documentation reflects baked-in architecture
- All legacy files removed

**Rollback:** N/A (cleanup, no runtime impact)

**Success criteria:** Clean codebase with no legacy artifacts

---

## 8. Rollback Strategy

### 8.1 Per-Phase Rollback

| Phase | Rollback Procedure | Time | Risk |
|-------|-------------------|------|------|
| 10S | Restore previous GPU Hub image with `/worker-source` | ~30s | LOW |
| 10T | Restore previous image + add bind mounts | ~60s | LOW |
| 10U | Revert CI changes | ~0s (no runtime) | NONE |
| 10V | N/A (cleanup) | N/A | NONE |

### 8.2 Emergency Rollback (Any Phase)

```bash
# 1. Restore previous image digest in .env
sed -i 's/GPU_HUB_IMAGE=.*/GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:PREVIOUS_DIGEST/' .env

# 2. Restore bind mounts in docker-compose.yml (if Phase 10T+)
git checkout HEAD~1 docker-compose.yml

# 3. Restart
docker compose -f docker-compose.yml -f docker/compose/overlay-gpu-hub-standalone.yml up -d gpu-hub

# 4. Verify
curl -sk https://animastor.in/gpu/health
```

### 8.3 Rollback Data Safety

- All rollback operations preserve Redis data
- No database migrations involved
- No secret changes required
- No API contract changes

---

## 9. Risks

### 9.1 Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Artifact version mismatch after bake | LOW | MEDIUM | CI verifies artifact versions match expected |
| Installer fallback breaks without mount | MEDIUM | HIGH | Phase 10S updates fallback before mount removal |
| Workflow allowlist empty after bake | LOW | HIGH | CI verifies manifests are copied correctly |
| Fingerprint caching breaks with baked artifacts | LOW | MEDIUM | Fallback to mount paths if `artifacts/` missing |
| Standalone repo CI fails with new Dockerfile | MEDIUM | LOW | Backward-compatible fallback in Dockerfile |
| Rollback fails due to missing mounts | LOW | HIGH | Emergency rollback procedure documented |

### 9.2 Mitigation Summary

1. **Backward compatibility code:** GPU Hub detects baked vs mounted artifacts, fallback to mounts
2. **CI verification:** Smoke tests verify all endpoints work with baked artifacts
3. **Gradual rollout:** Phase 10S removes deprecated endpoint first, Phase 10T bakes artifacts
4. **Emergency rollback:** Documented procedure with <60s recovery time
5. **No destructive operations:** All phases preserve data and can be reversed

---

## 10. Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  PRODUCTION HOST                                             │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  animastor-backend (local build)                      │   │
│  │  ├── HUB_URL=http://gpu-hub:5000                     │   │
│  │  └── GPU_HUB_API_KEY=<shared secret>                  │   │
│  └──────────────────────────────────────────────────────┘   │
│        ▲                                                     │
│        │ POST /gpu/task/result                               │
│        │ POST /gpu/task/error                                │
│        │                                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  gpu-hub (GHCR immutable image)                       │   │
│  │  sha256:eb9a9807b7c2...                               │   │
│  │                                                       │   │
│  │  BAKED INTO IMAGE:                                    │   │
│  │  ├── gpu-hub.js (application)                         │   │
│  │  ├── server.js, tarball.js, bootstrap.js              │   │
│  │  ├── node_modules/ (express, ioredis, contracts)      │   │
│  │  └── artifacts/                                       │   │
│  │      ├── worker-bundle/ (v2.1.0, 8 files)            │   │
│  │      ├── workflows/ (8 active JSON files)             │   │
│  │      ├── installer-src/ (v1.3.0, 31 files)           │   │
│  │      └── install-manifests/ (3 JSON files)            │   │
│  │                                                       │   │
│  │  ZERO BIND MOUNTS TO MONOREPO                         │   │
│  └──────────────────────────────────────────────────────┘   │
│        ▲                                                     │
│        │ HTTP callbacks (x-api-key auth)                     │
│        │                                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  animastor-redis (redis:7)                            │   │
│  │  ├── animastor:gpu-hub:workers (hub-owned)            │   │
│  │  ├── animastor:queue:* (hub-owned)                    │   │
│  │  ├── animastor:worker-auth (backend-written)          │   │
│  │  └── animastor:running, processing (hub-owned)        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  animastor-proxy (nginx:alpine)                       │   │
│  │  └── /gpu/ → gpu-hub:5000 (path stripping)           │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  workers (external GPU machines)                      │   │
│  │  ├── Protocol: Job Protocol v2 (frozen)               │   │
│  │  ├── Auth: Bearer wrk.<id>.<secret>                   │   │
│  │  └── Bundle: GET /gpu/worker-bundle (from image)      │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘

CI/CD FLOW:
┌─────────────────────────────────────────────────────────────┐
│  Animastor/animastor-gpu-hub (standalone repo)               │
│  ├── .github/workflows/ci.yml (verification)                │
│  └── .github/workflows/ghcr-release.yml (manual dispatch)   │
│                                                              │
│  Build pipeline:                                             │
│  1. Copy artifacts from monorepo (worker, workflows, etc.)  │
│  2. Build Docker image with baked-in artifacts              │
│  3. Smoke test (health, API key, protocol, artifacts)        │
│  4. Push to GHCR with immutable digest                      │
│  5. Record digest in release summary                         │
│                                                              │
│  Monorepo (Animastor/animastor):                             │
│  ├── worker/worker/ (produces worker bundle)                 │
│  ├── backend/ai/workflows/ (produces workflows)              │
│  ├── backend/src/installer/ (produces installer)             │
│  ├── backend/ai/install-manifests/ (produces manifests)      │
│  └── No CI — artifacts copied at build time                  │
└─────────────────────────────────────────────────────────────┘
```

**Can production GPU Hub run without a single bind mount to monorepo?**

**YES.** After Phase 10T, the GPU Hub container runs entirely from the immutable GHCR image with zero bind mounts. All artifacts are baked into the image at build time. The monorepo serves only as the source of truth for artifact content — it is not accessed at runtime.

---

## 11. Definition of Done

### Phase 10S (Remove Deprecated Endpoint)
- [ ] `GET /worker-source` returns 404 in production
- [ ] Mount 5 removed from `docker-compose.yml`
- [ ] Installer uses `worker-bundle` endpoint
- [ ] Frontend uses `worker-bundle` endpoint
- [ ] All 11 test files updated
- [ ] `GPU_HUB_CONTRACT.md` updated
- [ ] All tests pass

### Phase 10T (Bake Artifacts)
- [ ] Dockerfile uses multi-stage build with artifact copy
- [ ] Container has `/app/artifacts/` directory
- [ ] All 4 artifact endpoints work without bind mounts
- [ ] Fingerprint caching works with baked artifacts
- [ ] Backward compatibility fallback works
- [ ] CI copies artifacts before build
- [ ] Smoke tests pass with baked artifacts

### Phase 10U (Update Standalone CI)
- [ ] Standalone repo builds image with baked artifacts
- [ ] `ghcr-release.yml` accepts artifact inputs
- [ ] Release summary includes artifact versions
- [ ] All smoke tests pass

### Phase 10V (Cleanup)
- [ ] `gpu-hub-rebuild.sh` removed
- [ ] `build: ./gpu-hub` default removed from compose
- [ ] Documentation updated
- [ ] Legacy `old_*` workflow files excluded from build

---

## 12. Recommended Phase 10S

**Phase 10S should focus on:**

1. Remove `GET /worker-source` endpoint from `gpu-hub.js`
2. Remove Mount 5 from `docker-compose.yml`
3. Update installer fallback in `engine/worker.js`
4. Update frontend `buildSetupContract()` in `privateWorkers.ts` and `BetaSettingsHelpers.kt`
5. Remove `worker-source` references from all 3 install manifests
6. Update 11 test files
7. Update `GPU_HUB_CONTRACT.md` normative contract
8. Build new GPU Hub image with changes
9. Deploy to production
10. Verify `GET /worker-source` returns 404, `GET /worker-bundle` works

**Estimated effort:** 2-3 hours
**Risk:** LOW (deprecated endpoint with documented replacement)
**Production impact:** Minimal (new image required, ~30s downtime)

---

## VERDICT: READY FOR IMPLEMENTATION

All research is complete. The recommended approach (bake into image) is simple, low-risk, and uses existing infrastructure. The migration can be done in 4 safe phases with clear rollback procedures.

**RECOMMENDED NEXT PHASE: Phase 10S — Remove Deprecated `/worker-source` Endpoint**
