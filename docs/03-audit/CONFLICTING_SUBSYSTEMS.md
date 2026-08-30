# Architectural Audit: Conflicting Subsystems

> Date: June 2026
> Purpose: Identify where subsystems compete for state management control and outline paths toward unified coordination.

---

## Phase 1 Status (Passive Recovery)

> ✅ **R1.2** — Audio recovery: runtime cycle (setInterval 5s) removed. `recoverAudioResults()` retained for on-demand calls.
> ✅ **R1.3** — Reconciliation engine: auto-fix removed from runtime-loop. `POST /debug/runtime/apply-fix` added for manual invocation.

---

## 1. Subsystem Map and Their "Veto Power"

### 1.1 Dirty System (book-diff.cjs) — **Initiator**

**Role:** Compares old/new book, computes dirty layers via Prompt Dependency Registry, triggers `markDirtyScenes()`.

**Actual Veto Power:**
- Lua script `RESET_SCENE_LUA` atomically resets chunk metadata and per-asset states to `pending`
- Adds scenes to active-scenes index
- Calls `syncLinearState()` after each dirty scene

**Where it gets overridden:**
- `scene-window.restoreChunkStatusForScene()` may restore `audio_status = 'ready'` right after dirty system set `'pending'`
- `dispatch-engine` may say "duplicate, lease still active"

---

### 1.2 Dispatch Engine (dispatch-engine.js) — **Access Controller**

**Role:** The only way to launch a stage. Checks lease, quota, circuit breaker, retry budget.

**Actual Veto Power:**
- `DISPATCH_SKIPPED_DUPLICATE: lease still active` — if lease alive, dispatch blocked
- Backpressure quotas (audio: 3, image: 2, video: 1)
- "Phase 9" governance (circuit breaker, retry budget, fairness)

**Problem:** Lease is both a duplicate protection AND a barrier to force-regen. If user wants to regenerate and lease is still active from previous attempt, system says "duplicate." `book-routes.cjs` has pre-delete and dedup key cleanup for dirty units, but lease may remain.

---

### 1.3 Scene Window (scene-window.js) — **Caching Optimizer**

**Role:** Checks whether content exists on disk, and if so, skips GPU.

**Actual Veto Power:**
- `sceneHasValidContent()` → if audio is real (not placeholder), images and video exist — returns `true`, and scene is NOT sent to GPU
- `restoreChunkStatusForScene()` → rewrites `audio_status: 'pending'` back to `'ready'`/`'placeholder'` based on files on disk
- `startScene()` → if `sceneHasValidContent() = true`, sets `VIDEO_READY` and dispatches nothing

**Key Conflict:** markDirtyScenes() resets everything to pending, and milliseconds later `startScene()` / `restoreChunkStatusForScene()` may return everything to ready if files exist on disk. This is correct for cache, but may interfere with force-regen.

---

### 1.4 Startup Recovery (startup-recovery.js) — **Post-Crash Restorer**

**Role:** On startup, restores Redis state from PG and filesystem.

**Actual Veto Power:**
- Step 2: `recoverIuImagesFromDisk()` — finds PNGs on disk and sets `image_status = 'ready'` in Redis. If dirty flags were lost after crash but files remain — restoration makes them ready, and system doesn't know regeneration is needed.
- Step 3: `reconcileMissingSceneState()` — restores scene counters, placeholder audio, scene_hashes in PG
- Step 4: `checkVersionStaleness()` — only logs, doesn't fix

**Problem:** If book was changed, crash happened BEFORE markDirtyScenes executed, then on startup recovery restores EVERYTHING as ready (because files exist), and changes won't trigger regeneration. **This is data loss.**

---

### 1.5 Audio Recovery (audio-recovery.cjs) — **Active Restorer (every 5s)**

**Role:** Every 5 seconds scans `animastor:result:*` in Redis and restores GPU results to disk.

**Actual Veto Power:**
- May overwrite chunk metadata, setting `audio_status = 'ready'`
- May trigger `handleTaskResult()`, which triggers `handleAudioCompleted()`

**Problem:** Runs in runtime, not just on startup. May "restore" a result that user explicitly cancelled and wants to regenerate.

---

### 1.6 Reconciliation Engine (reconciliation-engine.js) — **Self-Healer**

**Role:** Detects mismatches between state machine and actual files, can fix them.

**Actual Veto Power:**
- `checkOrphanVideoState()` / `checkOrphanImageState()` / `checkOrphanAudioState()` — finds READY states without files
- `checkStaleDispatchLeases()` — finds stale leases
- `checkStuckScenes()` — finds stuck states
- `applyFix()` — can apply `REGENERATE_MISSING_ASSET`, `MOVE_TO_PENDING`, `RELEASE_STALE_LEASE`, `PROGRESS_TO_IMAGE`, `RECONCILE_COUNTER_DRIFT` and other fixes

**Problem:** Reconciliation engine is another decision center that:
- Doesn't know about user intentions (force-regen)
- May "fix" state that was intentionally set by dirty system
- Has its own model of "correct" state that may not match other subsystems' models

---

### 1.7 Image Service (image-service.js) — **Executor with Bypasses**

**Role:** Generates IU images.

**Actual Veto Power:**
- `processSingleIU()` — `dirtyUnitIds` bypass: if unit in dirty list, skips disk cache check and sends to GPU
- In same place clears GPU hub dedup key (`animastor:job:{job_id}`) before dispatch so regeneration not blocked
- Sets in-flight marker (`iu-in-flight:{id}`, TTL 20 min) to prevent duplicates on next ticks

**This is correct:** image-service is the only place where dirty unit bypass works properly.

---

### 1.8 Scene Orchestrator (scene-orchestrator.js) — **Central Conductor**

**Role:** Dispatch execution, callback handling, stale state tolerance.

**Actual Veto Power:**
- `executeImageDispatch()` — [VERSION-STALE CHECK] before generation checks PG versions, and if `asset_ver < scene_ver` — forces regen
- `executeVideoDispatch()` — same for video
- `handleImageCompleted()` — stale state tolerance: if state isn't IMAGE_GENERATING but files exist — completes anyway
- `handleAudioCompleted()` / `handleVideoCompleted()` — same

**Problem:** Stale state tolerance is a "backdoor" that solves specific bugs (callback arrived after cancel→regenerate), but signals that state machine is not the sole source of truth. Files on disk can override state.

---

### 1.9 Book Sync (book-sync.js) — **PG Auditor**

**Role:** Synchronizes Book JSON with PG.

**Actual Veto Power:**
- `markSceneAssetsStale()` — changes status in PG from 'ready' to 'stale'
- `reconcileFromDiff()` — updates scene_hashes, cancels generation_tasks

**Conflict:** book-sync has version checking (`getOutdatedByVersions`) which can find stale assets, but it only logs — doesn't initiate regeneration. This is correct (read-only auditor), but can be confusing.

---

## 2. Conflict Matrix

| Scenario | Dirty | Dispatch | Window | Recovery | Recon Engine | Who Wins |
|---|---|---|---|---|---|---|
| **Regenerate after edit** | sets pending | lease may block | restore after dirty | — | may "fix" back | **Window** (restores ready) |
| **Crash after save before regenerate** | lost | — | starts from disk | restores everything as ready | not launched | **Recovery** (files exist → ready) |
| **Callback after Cancel→Regenerate** | new dirty, new buildId | old lease may block | stale state tolerance | may process old result | — | **Orchestrator** (stale state tolerance) |
| **Force-regen dirty unit** | dirty unit in PG | dedup cleared | cache bypass | — | — | **Image Service** (correct) |
| **Audio recovery finds old result** | — | — | — | restores file | — | **Audio Recovery** (no context) |

---

## 3. Root Problem: Four Decision Centers

We have **four independent mechanisms**, each capable of setting or overriding state:

```
1. Dirty/Regenerate        — sets PENDING (via Lua)
   (book-diff.cjs + markDirtyScenes)

2. Scene Window / Cache    — sets READY (files exist)
   (sceneHasValidContent + restoreChunkStatus)

3. Startup Recovery        — sets READY (files exist)
   (recoverIuImagesFromDisk + reconcileMissingSceneState)

4. Reconciliation Engine   — may set PENDING or READY
   (applyFix: REGENERATE_MISSING_ASSET, MOVE_TO_PENDING, etc.)
```

None of them knows about the others' intentions. Dirty doesn't know Window just restored ready. Recovery doesn't know user pressed regenerate.

**Truth is smeared across three sources:**
- **PG** — versions (content_version, audio_config_version), dirty_unit_ids, scene_hashes
- **Redis** — per-asset states, chunk metadata, scene states, leases
- **Filesystem** — .mp3, .png, .mp4 files

---

## 4. What ChatGPT Proposed — and What's Applicable

### ✅ "User intent bypass" — partially implemented

Dirty unit bypass via `dirtyUnitIds` in `processSingleIU()` is exactly user intent bypass. User edited unit → dirty_unit_ids saved in PG → on dispatch this unit force-generated, bypassing cache.

**But:** this only works for per-unit regeneration. For scenario-level force-regen (entire image/video layer), mechanism is less reliable — relies on version staleness check in scene-orchestrator.

### ✅ "Recovery as passive system" — NOT implemented

Audio recovery is active in runtime (every 5s). Startup recovery restores state without context about dirty. Reconciliation engine can change state at any time.

### ❌ "Single UnitState" — NOT implemented

We have dual model (linear FSM + per-asset), but this isn't a single source of truth. Real truth lives in PG + files + Redis simultaneously.

### ❌ "Orchestrator decides, others advise" — NOT implemented

Window, Recovery, Reconciliation Engine — all can make decisions. Dispatch Engine has veto power.

---

## 5. Recommendations for Reducing Complexity

### 5.1 Passive Recovery (high priority)

Make recovery passive:
- **Startup recovery:** only restores Redis from PG. Doesn't set statuses based on files on disk — only logs divergences.
- **Audio recovery:** remove runtime cycle (5s). Replace with GPU Hub callback trigger.
- **Reconciliation engine:** remove auto-fix. Only logs and suggests fixes. Apply only on explicit request (via /admin endpoint).

### 5.2 Dispatch Lease Accounting for User Intentions (medium)

Currently lease is a pure "lock" with TTL. If regenerate arrived, lease should be force-released for this scene:
```
dispatchStage(..., { force: true }) → 
  1. Redis.DEL lease (if exists)
  2. Redis.DEL quota (if exists)  
  3. Acquire new lease
  4. Dispatch
```

Currently done for dirty units (dedup key cleared), but not for scenario-level leases.

### 5.3 Version-Based Stale Detection (already implemented, R13-R16) — **develop**

Version-based approach (content_version, audio_config_version) is the right path. It allows:
- Computing dirty as `asset_version < scene_version`, not as explicit flag
- Persisting versions in PG (survives crash)
- Avoiding flags that can be lost

**Next step:** Move dirty flags from Redis to PG completely. Redis stores only runtime state (progress, queues). PG stores truth (versions, dirty).

### 5.4 Simplifying Stale State Tolerance (low)

5 locations in scene-orchestrator.js check "state doesn't match, but files exist — complete anyway." If state machine were the sole source of truth, these backdoors wouldn't be needed.

---

## 6. Final "Who Is Who" Map

| Subsystem | Now | Should Be |
|---|---|---|
| **book-diff** (dirty) | Initiator | Single dirty initiator |
| **dispatch-engine** | Controller (lease) | Orchestrator decisions executor |
| **scene-window** (cache) | Makes decisions (valid content) | Only advises (cache advisory) |
| **startup-recovery** | Restores with auto-fix | Only logs divergences |
| **audio-recovery** | Active cycle (5s) | Only on callback |
| **reconciliation-engine** | Applies auto-fix | Only audit |
| **scene-orchestrator** | Central conductor | Sole state changer |

Ideal: system where state changes happen in one place, following one protocol, with context awareness (user intent, current mode).

---

## 7. Excess Complexity: 5 Points Requiring Careful Cleanup

> Below are five specific locations where complexity is unjustified and creates risks during changes.
> Each requires gradual, testable approach: no "big bang" refactorings.

### 7.1 Dual State Model (linear FSM + per-asset)

**Problem:** Per-asset states are canonical source of truth. Linear FSM is derived projection for backward compatibility. `syncLinearState()` called AFTER EVERY per-asset state change:

- `scene-orchestrator.js`: 11+ calls to `syncLinearState()`
- `book-diff.cjs`: 1 call after `markDirtyScenes()`
- Each call = Redis GET + JSON.parse + Redis SET

**Risk:** Divergence between per-asset and linear states. Every bug of type "callback arrived, but state is wrong" is a consequence of this divergence.

**Cleanup approach:**
1. First make per-asset source of truth everywhere (already done in theory)
2. Then find all linear FSM consumers and migrate them to per-asset
3. Remove `syncLinearState()` — this will be final step when nobody depends on linear

---

### 7.2 Four Duplicate File Checks on Disk

All four do the same thing: scan output directory and compare with Redis:

| Function | Where | What It Does |
|---|---|---|
| `sceneHasValidContent()` | scene-window.js | Checks .mp3, .png, .mp4 on disk for single scene |
| `restoreChunkStatusForScene()` | scene-window.js | Restores chunk status from files after dirty |
| `reconcileWindowStatuses()` | scene-window.js | Scans all chunk keys and compares with files |
| `recoverIuImagesFromDisk()` | startup-recovery.js | On startup scans PNGs and sets image_status='ready' |

**Problem:** Different logic in each place. One may say "ready", another "pending" for same file.

**Cleanup approach:**
1. Extract single `getSceneFilesStatus(buildDir, bookId, chapterId, sceneId)` returning `{ audio: { exists, isReal }, image: { exists }, video: { exists } }`
2. Replace all 4 checks with calls to this function
3. Gradually remove duplicate locations

---

### 7.3 Audio Recovery as Active Cycle (every 5s)

**Problem:** `audio-recovery.cjs` every 5 seconds scans all `animastor:result:*` keys in Redis. This:
- Treats symptoms, not root cause (callback chain repair already done in R18)
- May "restore" result that user cancelled
- Creates unnecessary Redis load (SCAN over all keys)

**Cleanup approach:**
1. First R18 already fixed callback chain — verify recovery still needed
2. Then replace cycle with trigger mechanism: recovery launches only for specific job_id if callback didn't arrive within timeout
3. Finally — remove `startRecoveryInterval()` and 5s cycle

---

### 7.4 Dispatch Engine with 6 Lazy-Loaded Governance Modules

**Problem:** `dispatch-engine.js` loads via `safeRequire()`:
- `circuit-breaker.js`
- `retry-budget-manager.js`
- `fairness-engine.js`
- `policy-engine.js`
- `workload-classifier.js`
- `cost-estimator.js`

All are dead code. Not used in production. Loaded only if files exist on disk. `safeRequire()` returns `null` if module not found — and dispatch-engine works as usual.

**Cleanup approach:**
1. Decide: are these modules needed?
2. If no — delete files
3. If yes — activate in core pipeline
4. Current state ("seem to exist but aren't used") — worst of all worlds

---

### 7.5 Stale State Tolerance in Three Callbacks

**Problem:** Three callbacks in `scene-orchestrator.js` have same pattern:

```javascript
if (!currentState || currentState.state !== EXPECTED_STATE) {
    if (filesExistOnDisk) {
        // Stale state tolerance: complete anyway
    } else {
        // Reject callback
    }
}
```

This means: **state machine is not trustworthy**. If files exist — we believe disk, not state machine.

**Root:** Cancel→Regenerate generates new buildId, but GPU callback may arrive with old buildId. State machine already reset, but GPU still working on old job.

**Cleanup approach:**
1. First R2 (force lease release) — ensures new regenerate clears old leases
2. Then R3 (unit in-flight tracking) — prevents dispatch for already-launched jobs
3. Only then can stale state tolerance be removed — because new dirty will be preceded by clearing old jobs

---

## 8. Gradual Cleanup Approach

```
Stage 1 (now):     Recognize the problem ✅
                    Document it ✅
                    
Stage 2 (near-term): Remove active recovery (R1.2)
                    Force lease release (R2.1)
                    
Stage 3 (medium-term): Remove stale state tolerance (depends on R2)
                        Consolidate file checks (7.2)
                        
Stage 4 (long-term): Remove dual state model
                       Clean governance dead code
```

**Principle:** Each change must:
1. Have tests (at least integration tests)
2. Be revertible — can roll back without cascade
3. Not change user-facing behavior (only internal architecture)

---

## 9. Target Architecture: Source of Truth for Each Question

> Based on ChatGPT discussion: key problem — no single responsible for each question.

### 9.1 Storage Separation Principle

> **Redis stores what can be lost.**
> **Database stores what cannot be lost.**

If Redis disappears tomorrow (`redis flushall`), system should recover. May be slow (rebuilding caches), but **without losing project**. If PG disappears — that's catastrophe.

### 9.2 Responsibility Table

| Question | Who Answers | Where Stored | Type |
|---|---|---|---|
| **Need to regenerate?** | **PG (versions)** | `scenes.content_version`, `scenes.audio_config_version` | **Fact** |
| **Which units are dirty?** | **PG** | `scenes.dirty_unit_ids` | **Fact** |
| **Is there a GPU task?** | **Scheduler** | `dispatch-lease` in Redis | Derived |
| **Is file on disk?** | **Storage** | Filesystem | Derived |
| **Is there a ready result?** | **PG** | `scene_assets.status` | **Fact** |
| **What's progress (43%)?** | **Redis** | chunk metadata | Derived (cache) |
| **Scene in queue?** | **Redis** | `active-scenes` | Derived |
| **Prompt cache?** | **Redis** | (somewhere in runtime) | Derived (cache) |
| **Task duplicate?** | **Redis** | `animastor:job:*` | Derived (TTL) |

Distinction between fact and derived state:

- **Fact** — stored in PG, survives crash, is source of truth
- **Derived** — stored in Redis or filesystem, can be reconstructed from facts

### 9.3 What Currently Violates This Principle

**Facts stored in Redis:**
- `animastor:asset-state:*` — per-asset states (dirty/pending/generating/ready) — **this is fact, should be in PG**
- `animastor:scene-state:*` — linear FSM — **derived** (computed from per-asset), can be in Redis

**Derivatives duplicated in PG:**
- `scene_assets.status` — duplicates per-asset state from Redis. **This is correct:** PG is fact, Redis is fast cache.
  But if Redis and PG diverge — who's right?

**Storage (files) makes decisions:**
- `sceneHasValidContent()` — checks files and based on this decides whether to skip GPU. **Files should not be source of truth for generation state.**

### 9.4 Target Architecture: Conductor

```
            ┌─────────────────────────────────────┐
            │          ORCHESTRATOR                 │
            │  (makes decisions)                    │
            │                                      │
            │  ┌──────────────────────────────┐    │
            │  │  Information Sources:        │    │
            │  │  ├── PG: versions, statuses  │    │
            │  │  ├── Redis: progress, cache  │    │
            │  │  ├── Storage: files          │    │
            │  │  └── GPU Hub: results        │    │
            │  └──────────────────────────────┘    │
            │              │                        │
            │              ▼                        │
            │  ┌──────────────────────────────┐    │
            │  │  Executors:                   │    │
            │  │  ├── dispatch-engine          │    │
            │  │  ├── audio/image/video service│    │
            │  │  └── scene-window (slide)     │    │
            │  └──────────────────────────────┘    │
            └─────────────────────────────────────┘

  Each module answers ITS OWN question and does NOT make decisions.
  Only the orchestrator makes decisions.
```

### 9.5 What This Changes for Each Module

| Module | Now | Goal |
|---|---|---|
| **PG versions** | Stores versions, but dirty determined via Redis | Single source of truth for "need regeneration" |
| **scene-window** | `sceneHasValidContent()` decides to skip GPU | `getSceneFilesStatus()` returns info, orchestrator decides |
| **dispatch-engine** | Lease may block dispatch | Lease is only info, orchestrator can force |
| **startup-recovery** | Restores statuses (files exist → ready) | Logs divergences, doesn't change state |
| **audio-recovery** | Active 5s cycle, restores results | Only on timeout for specific job |
| **scene-orchestrator** | Stale state tolerance (bypasses state machine) | Trusts state machine (after R2) |
| **reconciliation-engine** | Auto-fix (changes state) | Only audit + API /admin/apply-fix |

### 9.6 Success Criteria

System achieves goal when after `redis flushall`:

1. Backend starts
2. Startup recovery logs: "found N files on disk, K divergences from PG"
3. **Nothing changes in state**
4. Runtime scheduler starts ticking
5. `shouldScheduleAssets()` checks PG versions: `asset_version < scene_version?`
6. For stale scenes — dispatch
7. For current — `sceneHasValidContent()` (now advisory) suggests skipping
8. Orchestrator makes decision

**No file on disk can override state without orchestrator's decision.**
