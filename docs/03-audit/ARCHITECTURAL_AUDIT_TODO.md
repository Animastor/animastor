# Architectural Audit — TODO

> **Legend:** 🔴 Critical | 🟡 High | 🟢 Medium | ⚪ Low
> **Status:** 📝 Plan | 🔧 In progress | ✅ Done | ❌ Skipped

---

## Phase 0: Audit and Measurements (Before Changes)

### [A0] Measure Current Conflicts in Logs
- [ ] Collect grep patterns for key conflicts:
  - `DISPATCH_SKIPPED_DUPLICATE` — how many times dispatch blocked by lease
  - `RECOVERY` / `RECOVER` — how many times recovery intervened
  - `stale state` / `stale_state` — stale state tolerance in orchestrator
  - `restoreChunkStatus` — status restoration after dirty
  - `audio-recovery` — each audio recovery cycle
- [ ] Count frequency of each conflict on production logs
- [ ] Identify top-3 scenarios that actually hit users

---

## Phase 1: Passive Recovery (🔴 Critical)

**Goal:** Recovery stops being an active decision-maker. Only logs divergences, doesn't auto-fix them.

### [R1.1] Startup Recovery — Log Only, Don't Fix ✅ (partial)
- [x] `recoverIuImagesFromDisk()` — scans PNGs, only logs found scenes (doesn't update Redis)
- [x] `reconcileMissingSceneState()` — only logs books with missing Redis counters (doesn't restore counters/placeholders/hashes)
- [x] `checkVersionStaleness()` — already log-only (unchanged)
- [x] **Important:** crash recovery no longer masks dirty state — after Redis flushall the book must be explicitly loaded via PUT/regenerate

> ✅ **Divergence resolved (2026-06-27):** version-stale branch in `startup-recovery.js:284-288`
> no longer writes `setAssetStates(... DIRTY)` directly — goes through `orchestrator.markDirtyScene`
> (M5, commit `2807a38`). Single write arbiter preserved, R1.1 now fully correct.

> **UPD 2026-06-26:** Divergence noted.
> **UPD 2026-06-27:** Divergence resolved by M5 refactor; note updated.

### [R1.2] Audio Recovery — Remove Runtime Cycle ✅
- [x] `audio-recovery.cjs`: removed `startRecoveryInterval()` (setInterval every 5s)
- [x] `backend.cjs`: removed `audioRecovery.startRecoveryInterval()`
- [ ] Replace with trigger mechanism: if GPU Hub callback doesn't arrive within timeout — only then launch recovery for specific job
- [ ] Or use `recoverAudioResults()` as a one-shot call for specific scene+stage, not scanning all `animastor:result:*` every 5s
- [ ] NOTE: `recoverAudioResults()` retained as export for on-demand calls, but not connected to API

### [R1.3] Reconciliation Engine — Remove Auto-Fix ✅
- [x] `runtime-loop.js`: removed auto-apply of `applyFix()` from cycle (Phase 5)
- [x] `debug-routes.cjs`: added API endpoint `POST /api/v1/debug/runtime/apply-fix`
- [x] `reconcileScene()` — only collects report, doesn't fix
- [x] `getFixRecommendations()` — only logs, doesn't call `applyFix()`

---

## Phase 2: Force Lease Release (🔴 Critical)

**Goal:** On regenerate, dispatch lease doesn't block new generation.

### [R2.1] Force Parameter in Dispatch Engine ✅
- [x] `dispatch-engine.js`: `dispatchStage()` — added parameter `{ force: boolean }`
- [x] When `force=true`:
  1. `redis.del(leaseKey)` — clear old lease
  2. `releaseQuota()` — clear old quota
  3. Only then acquire new lease and dispatch
- [x] `acquireStageLease()` — added force mode: if lease exists and force=true, delete and create new

### [R2.2] Force Parameter in Regenerate Endpoint ✅
- [x] `book-routes.cjs`: sets `animastor:force-dispatch:{bookId}` flag (TTL 120s) after clearing leases
- [x] `runtime-scheduler.js`: `tick()` — checks force flag, passes force=true to `attemptDispatch()`
- [x] `attemptDispatch()` — receives `force` parameter, passes to `dispatchStage(..., { force })`

### [R2.3] Cleanup Stale Leases on Regenerate ✅
- [x] `dispatch-engine.js`: new method `clearAllLeasesForBook(redis, bookId)` — SCAN + DEL for lease and meta keys
- [x] `book-routes.cjs`: `/regenerate` and `/cancel-generation` use `dispatchEngine.clearAllLeasesForBook()` instead of local helpers
- [x] Local `clearBookLeases()` / `clearBookDispatchMeta()` removed as dead code

---

## Phase 3: Single Decision Orchestrator (🟡 High)

**Goal:** Only scene-orchestrator can change state. Others only read.

### [R3.1] Remove Stale State Tolerance ✅
- [x] `handleAudioCompleted()` — stale state tolerance block removed
- [x] `handleImageCompleted()` — stale state tolerance block removed
- [x] `handleVideoCompleted()` — stale state tolerance block removed
- [x] **Condition:** R2 (force lease release) completed before this step

### [R3.2] RestoreChunkStatus — Orchestration Layer Only ✅
- [x] New method `restoreSceneChunkStatus()` in `scene-orchestrator.js` — encapsulates content validation + chunk metadata restoration + state transition + PNG pre-delete + GPU dedup clear
- [x] `book-routes.cjs`: ~60 lines of inline restore logic replaced with `orchestrator.restoreSceneChunkStatus()`
- [x] Removed unnecessary inline requires inside method (fs/path already at module level)

### [R3.3] SceneHasValidContent → checkSceneContentCache (Advisory) ✅
- [x] `scene-window.js`: `sceneHasValidContent()` → `checkSceneContentCache()`
- [x] Returns advisory object `{ audioOnDisk, imageOnDisk, videoOnDisk, staleByVersion, valid }` instead of boolean
- [x] All consumers updated: slideWindow, startScene, restoreSceneChunkStatus
- [x] book-sync.js: only comments (untouched)

---

## Phase 4: Version Detection as Single Source of Dirty (🟡 High)

**Goal:** Dirty computed as `asset_version < scene_version`, not via Redis flags.

### [R4.1] Move Dirty Flags from Redis to PG ✅
- [x] Added `scenes.is_dirty BOOLEAN DEFAULT FALSE` in PG (schema.js migration)
- [x] `bumpSceneVersions()` now sets `is_dirty = TRUE` on each version bump
- [x] New `clearDirtyFlag()` — resets `is_dirty = FALSE` after video completion
- [x] New `getDirtyScenesByVersion()` — primary dirty detection mechanism via PG (is_dirty OR version_mismatch)
- [x] Redis asset states remain runtime cache, PG is source of truth for dirty

### [R4.2] Version Bump as Single Dirty Trigger ✅
- [x] `shouldScheduleAssets()` in runtime-scheduler.js — added `asset_version < scene_version` check from PG
- [x] On version mismatch detection: per-asset state reset to DIRTY → scheduler dispatches regeneration
- [x] `clearDirtyFlag()` called in three completion paths: handleVideoCompleted, completeSceneWithoutVideo, completeSceneWithoutImage
- [x] Redis Lua markDirtyScenes() retained for immediate runtime reset, but no longer sole source of dirty

### [R4.3] Crash-Safe Dirty ✅
- [x] R1.1 (startup recovery log-only) ensures dirty state not masked after Redis flushall
- [x] `is_dirty` in PG survives Redis crash — scheduler detects stale scenes on next tick
- [x] `getDirtyScenesByVersion()` independent of Redis — works on clean PG data

---

## Phase 6: Clean Up Excess Complexity (🟡 High)

**Goal:** Carefully, gradually, with tests — remove 5 points of excess complexity.
Each change must be revertible (can roll back without cascade).

### [R6.1] Dual State Model — Consolidation ✅

> Per-asset is canonical, linear FSM is derived projection.

- [x] **Step 1:** Found all linear FSM consumers (syncLinearState: 22 locations, transitionSceneState: 35 locations)
- [x] **Step 2:** Callback handlers migrated to per-asset API (6 syncLinearState calls removed)
- [x] **Step 3:** dispatchStage layer short-circuits (audio/image/video disabled) — `transitionSceneState` replaced with `setAssetState()` + `setSceneStateWithBuildId()`
- [x] **Step 4:** completeSceneWithoutVideo / completeSceneWithoutImage — `transitionSceneState` (3 calls each) replaced with per-asset API

**Result:** `transitionSceneState` (with lock+CAS) no longer called in short-circuit paths. Per-asset is the single source of truth. Linear FSM is a projection.

---

### [R6.2] Consolidate File Checks on Disk ✅

> Four places did the same thing: `checkSceneContentCache()`, `restoreChunkStatusForScene()`, `reconcileWindowStatuses()`, `recoverIuImagesFromDisk()`.

- [x] **Step 1:** Created single `getSceneFilesStatus(buildDir, bookId, chapterId, sceneId)` — returns `{ audio: { exists, isReal }, image: { exists }, video: { exists } }`
- [x] **Step 2:** `checkSceneContentCache()` rewritten to use `getSceneFilesStatus()`
- [x] **Step 3:** `restoreChunkStatusForScene()` rewritten to use `getSceneFilesStatus()`
- [x] **Step 4:** `reconcileWindowStatuses()` rewritten to use `getSceneFilesStatus()`
- [x] **Step 5:** `recoverIuImagesFromDisk()` now log-only (R1.1) — no longer uses I/O
- [x] **Step 6:** Removed duplicate fs.readdirSync/existsSync calls — all go through single function

---

### [R6.3] Audio Recovery — Replace with Trigger Mechanism ✅

> Same as R1.2, but emphasizing gradualness.

- [x] **Step 1:** Verify callback chain repair (R18) works — confirmed, callbacks arrive
- [x] **Step 2:** Add metric: how many times audio recovery actually recovered a result that wouldn't have been recovered by callback — **replaced with per-scene on-demand recovery instead of scanning all keys**
- [x] **Step 3:** `startRecoveryInterval()` removed — no periodic scanning launched
- [x] **Step 4:** New `recoverAudioForScene()` — targeted per-scene recovery for single result key
- [x] **Step 5:** Debug endpoint `POST /api/v1/debug/audio/recover` — on-demand per-scene recovery call
- [x] **Step 6:** Factory created once at debug-routes initialization (not per request)

---

### [R6.4] Governance Modules — Decide Fate ✅

> 6 modules loaded via `safeRequire()`. Decision:
> - **circuitBreaker, retryBudget, fairness** — used in `dispatchStage()` → replaced `safeRequire` with direct `require()`
> - **policyEngine, workloadClassifier, costEstimator** — only in dead functions `dispatchStageWithPolicy()` / `evaluateDispatchPolicy()` → functions removed, safeRequire removed

- [x] **Step 1:** Verified git log — modules exist but `dispatchStageWithPolicy()` and `evaluateDispatchPolicy()` were never called
- [x] **Step 2:** circuitBreaker/retryBudget/fairness — `safeRequire` → direct `require()`. policyEngine/workloadClassifier/costEstimator — removed from dispatch-engine (remain accessible via their own requires in other files)
- [x] **Step 3:** dispatch-engine no longer loads unnecessary modules, null-checks removed

---

### [R6.5] Remove Stale State Tolerance ✅

> Same as R3.1, but with explicit steps and dependencies.

- [x] **Pre-requisite:** R2.1 (force lease release) — already done
- [x] **Pre-requisite:** R2.3 (cleanup leases at regenerate) — already done
- [x] **Step 1:** `handleAudioCompleted()` — stale state tolerance block removed
- [x] **Step 2:** `handleImageCompleted()` — removed
- [x] **Step 3:** `handleVideoCompleted()` — removed
- [x] **Step 4:** Integration test: Cancel→Regenerate→callback

> ⚠️ **Internal contradiction existed:** in the priority list above R6.5 was marked ✅ Done, but here it had `[ ]`.
> Fixed: now ✅ everywhere. Verified by code — no stale state tolerance blocks in `scene-callbacks.js`.

> **UPD 2026-06-26:** Internal contradiction resolved.

---

## Full Priority List

```
Phase 1 — 🔴 Critical: Passive Recovery
├── [R1.1] Startup recovery — log only            (⚪ low urgency, ✅ Done)
├── [R1.2] Audio recovery — remove runtime cycle  (🟡 high, ✅ Done)
└── [R1.3] Reconciliation — remove auto-fix       (🟡 high, ✅ Done)

Phase 2 — 🔴 Critical: Force Lease Release
├── [R2.1] Force parameter in dispatch            (🟡 high, ✅ Done)
├── [R2.2] Force in regenerate endpoint           (🟡 high, ✅ Done)
└── [R2.3] Cleanup stale leases on regenerate     (🟢 medium, ✅ Done)

Phase 3 — 🟡 High: Single Orchestrator
├── [R3.1=R6.5] Remove stale state tolerance      (🟢 medium, ✅ Done)
├── [R3.2] RestoreChunkStatus → orchestrator      (🟢 medium, ✅ Done)
└── [R3.3] SceneHasValidContent → advisory        (🟢 medium, ✅ Done)

Phase 4 — 🟡 High: Versions as Source of Truth
├── [R4.1] Per-asset dirty in PG                  (🟡 high, ✅ Done)
├── [R4.2] Version bump = single trigger          (🟢 medium, ✅ Done)
└── [R4.3] Crash-safe dirty (partially done)      (🟢 medium, ✅ Done)

Phase 5 — 🟢 Medium: Duplicate Cleanup
├── [R5.1] Event journals — EventType enum reduced from ~100 to ~30, causal ordering helpers removed (🟢, ✅ Done)
├── [R5.2=R6.4] Governance dead code              (🟢, ✅ Done)
└── [R5.3] Heartbeat simplification — removed startSceneHeartbeatTimer/stopSceneHeartbeatTimer (⚪, ✅ Done)

Phase 6 — 🟡 High: Clean Up Excess Complexity
├── [R6.1] Dual state model — consolidation       (🟡, ✅ Done)
│   └── dispatchStage short-circuits → per-asset API
├── [R6.2] Consolidate file checks                (🟡, ✅ Done)
├── [R6.3=R1.2] Audio recovery → trigger-based    (🟡, ✅ Done)
├── [R6.4=R5.2] Governance modules — decide fate  (🟢, ✅ Done)
└── [R6.5=R3.1] Remove stale state tolerance     (🟢, ✅ Done)
```

---

## Dependency Map

```
R1.2 / R6.3 (audio recovery cycle)
  └── independent

R2.1 (force lease)
  ├──→ R2.2 → R2.3
  └──→ R3.1 / R6.5 (stale state tolerance)

R1.1 (startup log only)
  └──→ R4.3 (crash-safe dirty)

R1.3 (recon engine auto-fix)
  └── independent

R6.1 (dual state consolidation)
  └── depends on R3.x (single orchestrator)
      └── while several places still change state,
          removing linear FSM is risky

R6.2 (file check consolidation)
  └── independent, can be done in parallel

R6.4 (governance dead code)
  └── independent
```

**Recommended order (refined):**

```
Phase 1:   R1.2       →  remove audio recovery cycle             ✅
          R1.3       →  remove reconciliation auto-fix            ✅
          
Phase 2:   R2.1       →  force lease release in dispatch           ✅
          R2.2       →  force flag in regenerate + scheduler        ✅
          R2.3       →  clearAllLeasesForBook + cleanup             ✅          R6.4       →  governance: safeRequire→require + dead code       ✅
          R6.2       →  consolidate file checks                          ✅
          R1.1       →  startup recovery log-only                         ✅          Phase 4:   R4.1       →  dirty flags in PG                           ✅
          R4.2       →  version bump as single trigger                    ✅
          R4.3       →  crash-safe dirty                                   ✅
          
Next:     R6.3       →  audio recovery → trigger-based
          R5.x       →  duplicate cleanup
          R5.1       →  event journals
``` → R6.x
