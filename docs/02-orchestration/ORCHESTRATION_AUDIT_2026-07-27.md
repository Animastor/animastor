# Orchestration System Audit — 27 July 2026

> **Author:** Buffy (AI review)
> **Basis:** full code review of `backend/src/orchestration/*`, `backend/src/runtime/*`,
> `backend/src/state/scene-state.js`, `backend/src/services/audio-orchestrator.js`,
> tests, documentation.
> **Principle:** no over-engineering. System is already working. Find bottlenecks
> that actually cause issues, don't touch anything that works.

---

## Overall Architecture (What Exists)

```
                   ┌──────────────────────┐
                   │   Orchestrator Facade │  ← orchestrator.js (14 commands)
                   │   (single            │
                   │    lifecycle writer) │
                   └──────┬───────┬───────┘
                          │       │
              ┌───────────┘       └───────────┐
              ▼                               ▼
   ┌──────────────────┐           ┌──────────────────────┐
   │ Dispatch Engine   │           │ Reconciliation Engine│ ← ~1.5k lines
   │ (leases, quotas,  │           │ (self-healing, 6 phases)│
   │  circuit-breaker) │           └──────────────────────┘
   └────────┬─────────┘
            │
            ▼
   ┌──────────────────┐
   │ Scene Orchestrator│ ← per-stage dispatch (audio/image/video)
   │ + callbacks       │
   └──────────────────┘
```

**14 facade commands:** `markDirty`, `markDirtyScene`, `planScene`, `beginStage`,
`completeStage`, `failStage`, `completeStageWithoutVideo`, `completeStageWithoutImage`,
`setScenePending`, `setSceneGenerating`, `setSceneAllReady`, `setScenePlaceholder`,
`reconcile`, `resetScenes`.

---

## 🟢 Strengths

### 1. Single Facade Works
All lifecycle writes genuinely go through orchestrator.js. After S2 (renaming
`setAssetState` → `unsafeRestoreAssetState`) and M5 (migrating direct calls through facade)
in production code there are **no** direct `state.setAssetState` outside the whitelist.

### 2. Per-Asset State — Correct Decision
Three-dimensional system (`audio/image/video`) instead of linear `SceneState` was the right
choice. After T8 (removing `syncLinearState`) there is one source of truth: Redis hash
`animastor:asset-state:{book}:{chapter}:{scene}`.

### 3. Event Journal Exists and Works
Events are written in all lifecycle commands. With R1, journal events added for `setScene*`.
TTL 7 days allows incident investigation.

### 4. Reconciliation Engine with Distributed Lock
`reconcileCycle()` has `CLEANUP_LOCK` — two backend instances don't compete.
Phases A–D cover all recovery classes: result keys, stalled audio, version staleness,
scene reconciliation + auto-fix.

### 5. Dispatch Identity Protocol (+ Tests)
`verifyDispatchIdentity` + `finalizeDispatch` — lease token, dispatch ID, protocol version.
Unit tests exist for stale/missing/duplicate dispatch. This closed a class of race conditions
(M5).

---

## 🟡 Weaknesses (Critical)

### W1. Orchestration Layer Complexity — 11k Lines in 26 Files

| Component | Lines |
|-----------|-------|
| `reconciliation-engine.js` | 1,543 |
| `dispatch-engine.js` | 1,369 |
| `runtime-persistence.js` | 840 |
| `scene-window.js` | 793 |
| `runtime-scheduler.js` | 662 |
| `orchestrator.js` | 634 |
| `retention-manager.js` | 570 |
| `lease-manager.js` | 521 |
| `audio-orchestrator.js` | 498 |
| `circuit-breaker.js` | 497 |
| ... | ... |
| **Total** | **~11,387** |

**Problem:** 11k lines in orchestration is a lot for a single Node process.
Especially `reconciliation-engine.js` (1.5k) and `dispatch-engine.js` (1.4k).
They contain several loosely related logics in one file.

**What to do:** DO NOT refactor now. Files are large but self-contained and stable.
Only if adding a new phase to reconciliation — extract to a separate file.

### W2. Lazy-Require as Permanent Hack

In `orchestrator.js` every function does 4–6 `require()` inside the body:

```js
async function completeStage(...) {
    const callbacks = require('./scene-callbacks');
    const dispatchEngine = require('../runtime/dispatch-engine');
    const state = require('../state');
    // ... 5 more requires
```

**Why this is a weakness:** not readability (Node caches), but that cyclic dependencies
between `orchestration/` and `runtime/` will NEVER be explicit. Lazy-require hides
the real dependency graph. When adding a new command it's easy to create an implicit cycle.

**What to do:** leave as is. Refactoring cyclic dependencies is a separate
major project (interface extraction + DI). Just watch that new dependencies
don't create new cycles.

### W3. `resetScenes` — 10 Steps Without Transaction

The function does: force-dispatch → journal → remove from index → clear leases →
clear hub queues → delete PNGs → clear IU progress → markDirty → add to index →
journal. Between steps 3 and 9 the system is in an inconsistent state.

**Problem:** failure between steps 5-8 (clearing queues → markDirty) leaves scenes
without lease, without dispatch, without dirty status. Scheduler won't pick it up, scene stuck.

**What to do:** add try/catch with active index recovery. If markDirty
fails — addSceneToActiveIndex should still be called (scene at least visible
to scheduler, even if not dirty).

### W4. Reconciliation Tests — Almost None

`reconciliation-engine.js` = 1,543 lines. Tests: `reconciliation-engine.test.js`
(~600 lines, mostly mocks). Only checks that `setScenePending` is called,
but not actual reconciliation logic (orphan detection, stale locks, invariant checks).

**Risk:** any change to `reconcileScene()` or `reconcileCycle()` is untested.

**What to do:** do NOT write tests for the full 1.5k lines now. Instead:
- If changing a specific phase (A/B/C/D) — add 1 test for that phase.
- `checkAudioOrchInvariants()` already exists — test for it was written (R6).

### W5. Audio-Orch and Asset State — Manual Synchronization

Invariant `audio-orch.phase == DONE ⇔ asset.audio == READY` is maintained
in 3+ places: `completeStage` (via handler callback), `failStage` (direct write),
`recoverAudioOrchStates` (R3 — now sync after setDone). Any new place
changing audio-orch must not forget to sync asset state.

**What to do:** introduce invariant check after EVERY audio-orch change
via a single wrapper. Alternative — `checkAudioOrchInvariants()` is called
in `reconcileScene()` and corrects divergence. Sufficient for production.

---

## 🟢 What NOT To Touch (Works and Needs No Changes)

| Component | Why Not Touch |
|-----------|---------------|
| **Per-asset state machine** (scene-state.js) | 219 lines, stable, atomic HSET, validateAssetTransition covered by tests |
| **Event journal** (event-journal.js) | 248 lines, append-only, 7-day TTL, all event types present |
| **Dispatch engine** (dispatch-engine.js) | Large (1.4k) but stable. Lease/identity logic verified by tests |
| **Failure taxonomy** (failure-taxonomy.js) | 125 lines, enum-based, doesn't change |
| **Circuit breaker** (circuit-breaker.js) | 497 lines but hasn't changed in months |
| **Scene callbacks** (scene-callbacks.js) | 435 lines, handler chain audio→image→video, stable |

---

## 🎯 What I'd Do Right Now (Without Over-Engineering)

### Priority 1: try/catch in resetScenes for Active Index Recovery

```js
// After markDirty — guarantee addSceneToActiveIndex
try {
    const { computed, marked } = await markDirty(...);
    // ...
} catch (err) {
    warn(`[RESET-SCENES] markDirty failed: ${err.message}`);
    // Don't throw — scenes must at least be visible to scheduler
} finally {
    if (readdToActiveIndex) {
        for (const ds of scenes) {
            await scheduler.addSceneToActiveIndex(redis, bookId, ds.chapter_id, ds.scene_id);
        }
    }
}
```

Currently `markDirty` is called without try, and if it fails — `addSceneToActiveIndex`
(step 9) doesn't execute. Size: ~10 lines.

### Priority 2: Remove Deprecated Aliases `setAssetState`/`setAssetStates`

Yes, they're used in tests. Migration: replace all calls in test files with
`unsafeRestoreAssetState`/`unsafeRestoreAssetStates`. ~10 files, 5 minutes
search+replace.

### Priority 3: Extract Inline SQL from completeStage (R8)

Add `sceneAssetsRepo.getSceneVersions(bookId, chapterId, sceneId)` and replace
inline `SELECT content_version, audio_config_version FROM scenes`. Size: ~15 lines.

### Priority 4: Add try/catch in resetScenes Around PNG/IU Cleanup

Currently `fs.unlinkSync` (step 6) and `redis.del` (step 7) have no shared try.
If PNG cleanup fails (e.g., permission denied) — `markDirty` won't be called.
Size: ~5 lines (wrap steps 6-7 in try/catch, log error).

---

## Summary

| Aspect | Assessment |
|--------|------------|
| **Architecture** | ✅ Correct (facade + dispatch + per-asset) |
| **Reliability** | 🟡 Gaps remain (resetScenes without try, lazy-require) |
| **Tests** | 🟡 598 tests + new 3 (R6), but reconciliation untested |
| **Observability** | ✅ Journal events, audio-orch invariant checks |
| **Complexity** | 🟡 11k lines, but stable |

**Main risk:** `resetScenes` — the only place in the system where a sequence
of 10 steps can be interrupted mid-way. This is the most likely source of a production
incident. Everything else is cosmetic or already protected by tests.
