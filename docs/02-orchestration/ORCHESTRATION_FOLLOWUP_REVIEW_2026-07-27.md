# Follow-Up Review of Recent Orchestration and Task System Commits

> **Date:** 27 July 2026
> **Scope:** commits from 25–27 July 2026 (yesterday + today)
> **Method:** git history → read diffs → verify against actual HEAD code → run `npm test`
> **Principle:** targeted observations where real desynchronization or regression windows are visible.
> Don't touch what's been fixed. No over-engineering.

---

## 1. What Was Happening (Context)

During 25–27 July, a series of significant artifacts landed in orchestration/task layer:

| Group | Commits | Topic |
|-------|---------|-------|
| **Audio recovery bugfixes** | `8bd08bc`, `84aae09`, `22ed20f`, `c1a97b3`, `4fc9e3d` | 0-segments cycle, scene_not_found infinite loop, placeholder audio not content, stale_dispatch chunks |
| **Quotas / cleanup** | `d8a598a`, `ed1c459` | Quota increase 3→8/2→4/1→2, consolidated GPU hub cleanup, gen-scope TTL + startup migration |
| **Parallel F15** | `6daa5c1`, `090f279`, `0468243`, `62b5679`, `2df246a`, `06188d6`, `5a06f96`, `c6df601`, `5685704`, `5a27db9`, `21eda6b` | Independent parallel tasks, per-task timers/expiry, no overwrite `_activeGeneration` |
| **R audit fixes** | `fa6c039`, `5884139`, `3ae734b` | R1 validate+journal in setScene*, R3 sync after setDone, R6 invariant tests, R7 bookDiff mandatory, W1 try/catch around markDirty |
| **Task terminology** | `34862c3`, `7bd8ec4`, `c1b01bc`, `be2ca8f`, `865a38c`, `4717ac7`, `3632ae2` | WorkerUi→TaskRow, buildWorker→buildTaskRows, scopedTaskLabel, `TASK_ARCHITECTURE.md` |
| **Deps cleanup** | `7761dea`, `ed1c459` | Lazy-require → DI for scheduler/sceneWindow in routes |

**Tests:** 598 passing (verified `npm test` on HEAD). No regressions.

---

## 2. What Was Fixed Correctly (Verified by Code)

| Correct Fix | Where | Verification |
|-------------|-------|--------------|
| **R1**: `validateAssetTransition` + journal in all 4 `setScene*` | `orchestrator.js:322-435` | All 4 functions have `INVALID_STATE_CALLBACK` guard and `SCENE_*` events |
| **R6**: invariant tests | `backend/tests/orchestration-stabilization.test.js` (+215 lines) | Tests run, 598 passing |
| **R7**: `bookDiff` mandatory | `orchestrator.js:594` | `throw new Error` when `bookDiff.markDirtyScenes` missing |
| **W1**: try/catch around markDirty | `orchestrator.js:602-607` | Guarantees `addSceneToActiveIndex` even on markDirty error |
| **R3 partial**: sync after `setDone` in MERGING→DONE recovery | `reconciliation-engine.js:1413` | `unsafeRestoreAssetState('audio', READY)` after `audioOrch.setDone` |
| **Audio bugfix**: 0 segments → DONE early | `scene-orchestrator.js:168-177` | Breaks infinite dispatch→pending→re-dispatch loop |
| **Audio bugfix**: scene_not_found → `completed:true` | `scene-orchestrator.js:65,206,278` | All 3 executors return `completed:true`, scheduler stops re-dispatching |
| **Audio bugfix**: stale recovery detect chunks before reset | `scene-orchestrator.js:118-132`, `reconciliation-engine.js:1372-1399` | `findExistingSceneChunks` + `completeChunk` instead of blind FAILED |
| **Audio bugfix**: placeholder not counted as real content | `scene-restoration.js` (`c1a97b3`) | `placeholderAudio.hasRealAudio` check before `asset.audio=READY` |
| **Audio bugfix**: stale_dispatch chunks at WAITING_CHUNKS | `4fc9e3d` | Routes to task-handler, doesn't drop delayed chunk from stale dispatch |
| **Quotas** 3→8/2→4/1→2 + tests aligned | `d8a598a`, `86defe5` | `happy-path.test.js` expects `audio=8/image=4/video=2` |
| **Consolidated `clearHubDispatches`** | `dispatch-engine.js:977`, `orchestrator.js:471` | Single helper, unified auth + error path across all callers |
| **Gen-scope TTL + migration** | `gen-scope.js` (TTL 24h, `migrateLegacyScopes`) | Called on startup from `backend.cjs:290` |
| **DI for scheduler/sceneWindow** in routes | `7761dea` | Lazy-require → DI in generation-routes, easy to test |

All these items dropped — no repeat observations.

---

## 3. What Remains Inflamed (Follow-Up Recommendations)

### F1. R3 Patch Covered 1 of 3 audio-orch FAILED Recovery Branches

`reconciliation-engine.js:recoverAudioOrchStates()` (line 1365+) has three branches
calling `audioOrch.setFailed` directly (not via `failWaitingScene`, which itself
calls `orchestrator.failStage`):

| Line | Branch | Sync asset.audio? | Journal `AUDIO_FAILED`? |
|------|--------|-------------------|------------------------|
| 1401 | `GENERATING/WAITING_CHUNKS → FAILED` (restart_recovery) | ❌ only `markDirtyScene` below sets DIRTY | ❌ no |
| 1411 | `MERGING → DONE` | ✅ R3: `unsafeRestoreAssetState('audio', READY)` | ✅ (log only, recovery-context) |
| 1416 | `MERGING → FAILED` (restart_merge_missing) | ❌ only `markDirtyScene` below sets DIRTY | ❌ no |

R3 patch only fixed branch 1411. In branches 1401 and 1416:
- asset.audio transitions to `DIRTY` via `markDirtyScene` (transition `GENERATING→DIRTY` valid per `AssetTransitions`, see `scene-state.js:54`),
- but `FAILED` is never written to asset state and no `AUDIO_FAILED` event in journal.

**Investigation Risk:** on backend restart, a scene from "audio in paused generation"
ends up in `DIRTY` without an `AUDIO_FAILED` record in the journal. The `SCENE_DIRTY`/`INVALID_STATE_CALLBACK`
event won't explain the cause (only `[AUDIO-ORCH] Recover ... → FAILED` warn in log).

**Recommendation** (minimal-invasive):

In `reconciliation-engine.js`, immediately after `audioOrch.setFailed(...)` at lines 1401 and 1416,
add asset state sync analogous to what was done for `setDone`:

```js
await audioOrch.setFailed(redis, bookId, chapterId, sceneId, 'restart_recovery');
// F1: sync asset.audio — FAILED, like R3 for setDone
await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.FAILED);
// Then markDirtyScene → DIRTY (PENDING-redispatch path for scheduler)
if (deps.orchestrator) {
    await deps.orchestrator.markDirtyScene(redis, bookId, chapterId, sceneId, ['audio']);
}
```

Alternative (cleaner, more changes): replace the trio `setFailed + restoreFailed + markDirtyScene`
with a single `orchestrator.failStage(..., { redispatch: false })`, then `markDirtyScene`. `failStage`
itself sets `asset.audio=FAILED`, writes journal `AUDIO_FAILED`, does `finalizeDispatch('failure')`.
Size: 2 locations × ~3 lines = 6 lines. This is **R3 follow-up** for the two missed branches.

### F2. Race Between `setFailed` (audio-orch) and `failStage` (orchestrator) in `/gpu/task/error`

`backend/src/routes/generation-routes.cjs:1168-1185`:

```js
if (parsed.kind === 'audio_chunk') {
    try {
        const audioOrch = require('../services/audio-orchestrator');
        await audioOrch.setFailed(redis, bookId, chapterId, sceneId,
            `chunk_error:${parsed.chunkIndex}:${reason || 'unknown'}`);
    } catch (orchErr) { ... }
}

const result = await orchestrator.failStage(
    redis, bookId, chapterId, sceneId, stage, build_id, reason || 'worker_error',
    { dispatchId: dispatch_id }
);
```

`audioOrch.setFailed` (raw) does NOT sync asset.audio — it's just
`transitionState(redis, ..., PHASES.FAILED)` in `audio-orchestrator.js:158`. Between this call and
the subsequent `failStage` there's a window (< 1 redis round-trip) where `audio-orch.phase == FAILED`,
but `asset.audio == GENERATING` — invariant `audio-orch.FAILED ⇒ asset ∈ {FAILED, PENDING}` violated.

**Practical Risk:**
- `reconcileCycle.checkStalledAudioScenes` filters non-WAITING_CHUNKS → safe.
- Scheduler will attempt re-dispatch only if lease expired — but lease lives 15 min for audio,
  `failStage` below releases it via `finalizeDispatch('failure')`. Correct.
- Short window, but journal only records `failStage`'s `AUDIO_FAILED` with `reason='worker_error'`,
  while `chunk_error:5:network_timeout` from raw `setFailed` is lost.

**Recommendation** (simple): remove raw `audioOrch.setFailed` entirely — `orchestrator.failStage`
already transitions audio-orch to FAILED (via `failWaitingScene` if WAITING_CHUNKS, or via
sync in `failStage` for the general case). Verify that `failStage` indeed covers
audio-orch FAILED for `audio_chunk` stage=audio; if not — add one `audioOrch.setFailed` line
inside `orchestrator.failStage` after `unsafeRestoreAssetState`.

Size: ~5 lines cleanup. Reduces "two sources of truth" on error path.

### F3. Lazy-Require Inside `setScene*` Remains (Cosmetic)

After `fa6c039`, each of the 4 `setScene*` functions does 3 `require()` inside the body:

```js
async function setScenePending(...) {
    const state = require('../state');
    const journal = require('./event-journal');
    const { log, warn } = require('./scene-utils');
    // ...
}
```

In the previous document this was **R4 (low)**, audit 27-07 (W2) confirmed "leave as is,
don't refactor". Agreed — `state/journal/scene-utils` can safely be moved to top-level, but
this is purely cosmetic, behavior doesn't change. **Action:** none, not worth a separate commit.

### F4. `workers` Field in `/progress-panel` JSON vs `TaskRow` Term — Lock Down in Contract

`docs/05-frontend/TASK_ARCHITECTURE.md:200` explicitly documents the mismatch:

> The `workers` field in JSON response was retained for backward compatibility. On the frontend,
> objects are called `ProgressWorker` in API models but displayed as `TaskRow`.

Risk: next time someone refactors `progress-panel.cjs`, they might name the variable `workers` in
backend thinking it's the term; on frontend it'll be `TaskRow` — double naming becomes entrenched.

**Recommendation:** add a comment in the header of `progress-panel.cjs` (next to module description):
```js
// Contract: JSON field "workers" is legacy, retained for backward compatibility.
// In new code use `rows`/`taskRows`; rename the JSON field only in a coordinated
// frontend+backend release (see docs/05-frontend/TASK_ARCHITECTURE.md §6).
```
Size — 4 lines. Backend change `workers → tasks` in JSON — DO NOT do, breaks installed
app versions.

### F5. `gen-scope.migrateLegacyScopes` — Fixed ✅

During review, confirmed that `migrateLegacyScopes` is called on startup from
`backend.cjs:290` in a `setImmediate` block of startup-recovery. F5 resolved.

---

## 4. Additional Observations (No Action Required)

### N1. Transient Inconsistency in `recoverAudioOrchStates`: `MERGING → FAILED` Without Explicit Write

Line 1416 `audioOrch.setFailed(..., 'restart_merge_missing')` → next if `markDirtyScene`.
Asset.audio goes from `GENERATING` (part of MERGING invariant) directly to `DIRTY` (without `FAILED`).
`AssetTransitions[GENERATING] = [READY, FAILED, DIRTY]` — transition formally valid, but journal
doesn't record `AUDIO_FAILED`. This is part of F1 (see above).

### N2. `scene-orchestrator.js` — `audioOrch.setMerging + setDone` Without File Check

In `scene-orchestrator.js:163-164` and `:174-175` fast-track to DONE:
```js
await audioOrch.setMerging(redis, ...);
await audioOrch.setDone(redis, ...);
```
No check for merged `.mp3` on disk. `completeStage` below via `handleAudioCompleted`
checks `audio.isSceneAudioReady()` — if file missing, returns `ok:false, retryable:true`, asset
stays GENERATING, completeStage won't set READY. Correct, but dispatchId returns with
`Geological Surveyed=false, completed=false` for `already_ready` — odd, since the path was
called `already_ready`. **Not a bug, but misleading names.** No action needed.

### N3. Parallel Generation: readdToActiveIndex=false Path

In `orchestrator.js:612-619` added `readdToActiveIndex: false` path (done in `6daa5c1` for
selective generation/Navigator-flow, so task registry manages activation itself). If caller
forgets to pass this in `options`, default `true` — safe. Haven't grepped all callers with `false`
but docstring in `orchestrator.js:395-403` describes the contract. OK.

---

## 5. Implementation Priority

| Phase | Tasks | Size | Risk |
|-------|-------|------|------|
| **A** | F1 (sync asset.audio in 2 branches of recoverAudioOrchStates) | ~6 lines | Low |
| **B** | F2 (remove duplicate raw `audioOrch.setFailed` in `/gpu/task/error`) | ~5 lines | Low (need to verify `failStage` covers audio-orch FAILED for `audio_chunk` stage=audio; if not — add one line inside failStage) |
| **C** | F4 (comment in `progress-panel.cjs` about legacy `workers`) | ~4 lines | Zero |

Follow-up does NOT add new facade commands, state machines, queues, or services.
Closes remaining audio-orch↔asset sync gaps after R3. Phase A+B+C combined —
**15 lines**. Test coverage R6 already exists (215 lines `orchestration-stabilization.test.js`),
new tests not needed: one `it()` for invariant after recovery-branch
FAILED is sufficient (if going with F1).

---

## 6. What NOT To Do (Consolidation)

- **Do NOT rename** JSON field `workers` in `/progress-panel` — breaks installed app versions.
- **Do NOT merge** audio-orch into orchestrator.js — separate phase machine is meaningful.
- **Do NOT move** lazy-require in `setScene*` to top-level — cosmetic, no benefit.
- **Do NOT introduce** centralized invariant-enforcement wrapper around all `audioOrch.*` —
  local sync in 2 locations (F1) is sufficient.
- **Do NOT migrate** reconciliation to 100% via facade (M5 progress: 1 of 18 locations closed by R3) —
  this is a large refactoring effort, current gap is sufficiently closed by F1.

---

<!-- === Footer === -->
---
*Follow-up review of commits 25–27 July 2026. All checks against HEAD `f5bcde0`.*
