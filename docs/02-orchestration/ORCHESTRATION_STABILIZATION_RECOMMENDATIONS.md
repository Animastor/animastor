# Orchestration System Stabilization Recommendations

> **Date:** July 26, 2026
> **Last updated:** July 27, 2026 — R1, R3 (partial), R6, R7 implemented
> **Basis:** Analysis of `backend/src/orchestration/*`, `backend/src/runtime/*`, `backend/src/state/scene-state.js`
> **Principle:** Surgical, targeted fixes without over-engineering. No new state machines, queues, or services. The current architecture (facade + dispatch-engine + per-asset state) is correct; only a few gaps at the seams need to be closed.

---

## TL;DR — What's Wrong (Status as of July 27, 2026)

| # | Problem | Severity | Status |
|---|---------|----------|--------|
| R1 | `setScene*` in the facade writes state without `validateAssetTransition` and without journal events | **High** | ✅ **Implemented** |
| R2 | Deprecated aliases `setAssetState`/`setAssetStates` hang in `scene-state.js` exports | Low | ❓ Deferred: aliases still used in tests |
| R3 | `reconciliation-engine.js` and `scene-window.js` call `audioOrch.*` directly, bypassing the facade | Medium | 🟡 **Partial**: sync added after `audioOrch.setDone()` in recovery |
| R4 | `completeStage`/`failStage` do 4–6 lazy `require()` on every call | Low | ❓ Deferred: cosmetic, no behavior change |
| R5 | `resetScenes` mixes 10 layers of responsibility (journal + fs + redis + lua etc.) in one body | Medium | ❓ Deferred: function is already well-structured with comments |
| R6 | No tests for invariant `audio-orch.phase == DONE ⇔ asset.audio == READY` | Medium | ✅ **Implemented** (3 tests) |
| R7 | Fallback on `bookDiff = null` in `resetScenes` duplicates `markDirtyScene` logic | Low | ✅ **Implemented** (throw instead of fallback) |
| R8 | `completeStage` does inline PG query instead of `sceneAssetsRepo` method | Low | ❓ Deferred: low priority, SELECT is stable |

All recommendations fit within the existing contour of 13 facade commands — no facade extension needed.

---

## R1. setScene* Terminals in Facade Without Validation or Journaling

### What's Observed

In `orchestrator.js`:
- `completeStage` → `validateAssetTransition` (indirectly via `unsafeRestoreAssetState` after gate) + journal event ✓
- `failStage` → `state.validateAssetTransition(current, FAILED)` + journal ✓
- `markDirtyScene` → direct write, journal event ✓ (via PG markStale)

But:
- `setScenePending` (line 328) — bare `unsafeRestoreAssetState(..., PENDING)`, no `validateAssetTransition` and **no journal event**
- `setSceneGenerating` (line 349) — same for `GENERATING`
- `setSceneAllReady` (line 337) — all three assets set to `READY` without journal
- `setScenePlaceholder` (line 357) — bare write

### Why This Is Dangerous

`AssetTransitions` in `scene-state.js:50` exists specifically to block invalid transitions (e.g., `READY → PENDING` directly, without `DIRTY`). Currently this is only enforced in the two "heavy" commands. Any race condition or erroneous `setScenePending` call on an already `READY` asset will silently write `PENDING` — the scheduler will pick it up and trigger re-generation of already-complete content. This is exactly the class of bugs that "doesn't appear in tests but fires in production."

The event journal (`event-journal.js`, TTL 7 days) is the only way to investigate "how did this scene end up PENDING at 3:14 AM." Currently transitions via `setScene*` are invisible.

### Proposed Fix

Do not add new commands. Within existing `setScene*`, add:

1. Read current state via `getAssetStates`.
2. `validateAssetTransition(current, target)` — if `valid:false`, warn + journal `INVALID_STATE_*` + return `{ changed: false, reason }`.
3. After `unsafeRestoreAssetState`, call `journal.appendSceneEvent` with appropriate type (`SCENE_PENDING`, `SCENE_GENERATING`, `SCENE_ALL_READY` — types already exist in `event-journal.js`, or reuse `INVALID_STATE_CALLBACK`/`SCENE_RESET` by meaning).

Template (for `setScenePending`):

```js
async function setScenePending(redis, bookId, chapterId, sceneId, asset, buildId = null) {
    const state = require('../state');
    const journal = require('./event-journal');
    const { log, warn } = require('./scene-utils');
    const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const check = state.validateAssetTransition(states?.[asset], state.AssetState.PENDING);
    if (!check.valid && states?.[asset] !== state.AssetState.PENDING) {
        warn(`[SET-PENDING] ${bookId}/${chapterId}/${sceneId} ${asset}: ${states?.[asset]}→pending rejected (${check.reason})`);
        await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
            journal.EventType.INVALID_STATE_CALLBACK, states?.[asset],
            { asset, attempted: 'pending', ignored: true }).catch(() => {});
        return { changed: false, reason: check.reason };
    }
    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, asset, state.AssetState.PENDING);
    await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
        journal.EventType.SCENE_PENDING, state.AssetState.PENDING,
        { asset, buildId }).catch(() => {});
    return { changed: true };
}
```

This is a **targeted** fix in 4 functions — approximately 30 lines total, no contract change. Callers continue calling the same methods; they simply can no longer "push through" invalid transitions.

**Do not:** Introduce a middleware/hook system for all writes. Only explicit validation in terminal functions where it is currently missing.

---

## R2. Remove Deprecated Aliases from scene-state.js

`scene-state.js:196-197` keeps:
```js
const setAssetState = unsafeRestoreAssetState;
const setAssetStates = unsafeRestoreAssetStates;
```
with the comment "REMOVE after S2.3 migration." According to `ORCHESTRATION_TODO.md`, S2.3 is complete. Codebase grep shows **0 calls** to `state.setAssetState` / `state.setAssetStates` outside `scene-state.js` itself (only `unsafeRestoreAsset*` remain).

**Action:** Delete alias exports and JSDoc mention. This is −2 lines and one fewer place for erroneous calls in new files. No migration required.

---

## R3. Reconciliation/Window Call audioOrch Bypassing the Facade

`reconciliation-engine.js` contains **18 direct calls** to `audioOrch.*` (`scanAllStates`, `failWaitingScene`, `completeChunk`, `setState`, `setFailed`, `setDone`, `deleteState`). `scene-window.js:766` calls `audioOrch.initPlaceholderReady` directly.

This is a violation of the invariant proclaimed in `ORCHESTRATION.md` §2.1: "Nobody calls `audioOrch.*()` directly — only through the facade." Accordingly, phases 7–9 in TODO are marked 🔴 as incomplete.

### Why This Matters

The audio invariant `audio-orch.phase == DONE ⇔ asset.audio == READY` is maintained **only** by manual synchronization in `completeStage`/`failStage`. If reconciliation changes `audioOrch.phase` to `DONE` (e.g., `setDone` after recovery) while asset state remains `GENERATING`, the next scheduler tick sees `GENERATING` and tries to dispatch completed audio again — creating a loop.

### What's Proposed (Without Reflow)

Do not move all reconciliation to the facade — that's significant work and clear over-engineering. Instead:

1. Introduce **one** new facade operation: `reconcileAudioPhase(redis, bookId, chapterId, sceneId, action, payload)` with actions: `{ setDone, setFailed, completeChunkRecovery, deleteStateIfNeeded }`. This is **not** a 14th lifecycle command — it's a **recovery-helper** that:
   - calls `audioOrch.*`
   - synchronizes `asset.audio` (`unsafeRestoreAssetState`) immediately
   - writes journal event `AUDIO_RECONCILED`

   **Controversy:** this violates "don't extend the facade." Counter-argument — it's not a lifecycle command but an atomic reconciliation unit. Currently reconciliation already calls audioOrch + unsafeRestoreAssetState through the facade in one place (`line 869`), just scattered.

   **Alternative without new command:** In `reconciliation-engine.js`, immediately after each `audioOrch.setDone/setFailed/completeChunk`, call `orchestrator.completeStage`/`failStage` (already done in some places, needs to be uniformly applied everywhere).

**Recommendation:** go with the alternative — align all 18 call sites under a unified pattern `audioOrch.X() → orchestrator.completeStage/failStage/markDirtyScene()`. This adds no new commands, only closes the existing contract. Scope: ~30 lines of changes in `reconciliation-engine.js`, no new API.

---

## R4. Lazy Require Inside Functions — Over-Engineering

In `orchestrator.js` (`completeStage`, `failStage`, `markDirtyScene`, `resetScenes`), each call does 4–6 lazy `require()` inside the body:

```js
async function completeStage(...) {
    const callbacks = require('./scene-callbacks');
    const dispatchEngine = require('../runtime/dispatch-engine');
    const state = require('../state');
    const { log, warn, error } = require('./scene-utils');
    const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
    // ...
}
```

This was a deliberate Step 0 compromise (comment in `orchestrator.js:16-19`) to break the `orchestration ↔ runtime` cycle. The problem: the cycle is already broken by the lazy-require pattern in `dispatch-engine.js` and `runtime-scheduler.js` (which also require orchestrator inside functions). So lazy-require here **only works one way** — facade ≠ cycle breaker. Node's module system caches require after the first call, so runtime cost is zero, but readability suffers.

### What's Proposed

Top-level require for modules not participating in cycles:
- `scene-callbacks`, `scene-utils`, `state`, `scene-assets-repo`, `event-journal`, `audio-orchestrator`, `failure-taxonomy` — safe, no cycles.
- `dispatch-engine`, `runtime-scheduler`, `reconciliation-engine`, `runtime-config` (if it requires anything from orchestration) — keep lazy, they are truly cyclic.

Scope: ~10 lines moved up, function bodies become 4–5 lines cleaner. No behavior change, purely readability +1.

---

## R5. resetScenes — 10-Step Layer Cake

`orchestrator.js:413-549` — a single 136-line function does:
1. force-dispatch flag in Redis
2. journal event SCENE_RESET
3. removeScenesFromActiveIndex (scheduler)
4. clearLeasesForScenes (dispatch-engine)
5. clearHubDispatches (HTTP DELETE /queue/clear)
6. fs.unlinkSync stale PNGs (loop over scene×units)
7. redis.scan + redis.del iu-progress + iu-in-flight
8. markDirty via bookDiff or fallback
9. addSceneToActiveIndex (scheduler)
10. journal event SCENE_RESET_COMPLETED

Steps 1, 6, 7 are **gather/cleanup** of infrastructure artifacts (force flags, files, counters). Steps 3, 4, 5, 9 are **scheduler/dispatch contract**. Steps 2, 10 are observability. Step 8 is the lifecycle write itself (via `markDirty`, which is already part of the facade).

### What's Proposed (Without Splitting Into 5 Files)

Extract two local helpers in the same `orchestrator.js` file:

- `_cleanupRegenerationArtifacts(redis, bookId, buildId, scenes, cleanPngUnitIds)` — steps 6+7 (files + iu-progress/in-flight). Pure platform operation, not lifecycle.
- `_emitResetLifecycleEvents(redis, bookId, chapterId, sceneId, scope, scenesCount, marked)` — steps 2+10. Just to remove journal event format duplication at start and end.

`resetScenes` remains the orchestrator of steps, but the body shrinks from 136 → ~70 lines, and each action is explicitly named by a helper. Contract unchanged.

**Do not:** Create a `RegenerationFlow` class or middleware pipeline. That's over-engineering. Two local functions suffice.

---

## R6. Test for Audio-Orch Invariant

In `backend/tests/orchestration-stabilization.test.js` there are tests for dispatch ownership (lease token mismatch, stale dispatch, duplicate finalization) — good. But there is no test for the system's **core invariant**:

```
audio-orch.phase == DONE   ⇔   asset.audio == READY
audio-orch.phase == FAILED ⇒   asset.audio ∈ {FAILED, PENDING}
```

Without it, any change in `completeStage`/`failStage` risks silently breaking synchronization.

### What's Proposed

One `describe('audio-orch invariant')` with three `it`:
1. `completeStage('audio')` transitions asset to READY **and** audio-orch.phase to DONE.
2. `failStage('audio')` transitions asset to FAILED→PENDING **and** audio-orch.phase to FAILED.
3. `completeStage('audio')` with `handler.ok:false` touches NEITHER asset NOR audio-orch (NEVER READY).

Mocks for audio-orch and sceneAssetsRepo already exist in `mocks/` (S4 complete). Scope — ~80 lines of test, in one file. This is the only recommendation that **creates** code rather than refactoring existing — but without it, the other fixes have no regression protection.

---

## R7. Dual markDirty Path in resetScenes

`orchestrator.js:518-529`:

```js
if (bookDiff && typeof bookDiff.markDirtyScenes === 'function') {
    marked = await markDirty({ bookDiff }, redis, bookId, buildId, scenes, layerCfg);
} else {
    log('[RESET-SCENES] No bookDiff provided — using markDirtyScene fallback');
    for (const ds of scenes) {
        for (const layer of (ds.dirty_layers || ['audio', 'image', 'video'])) {
            await markDirtyScene(redis, bookId, ds.chapter_id, ds.scene_id, [layer]);
        }
    }
}
```

These two paths are **semantically different**:
- `bookDiff.markDirtyScenes` — Lua-atomic operation, writes chunks + state + active index in one script (see ORCHESTRATION.md §2.8 R7).
- Fallback — element-by-element `markDirtyScene`, which does NOT write chunks or activate index atomically.

If someone in production forgets to pass `bookDiff` (DI from route), the system silently falls back to the non-atomic path — and concurrent regeneration introduces a race. Internal contracts should not depend on "optional" DI.

### Proposal

Make `bookDiff` mandatory: `if (!bookDiff) throw new Error('resetScenes: bookDiff is required')`. All callers already pass it (via DI from route). Remove fallback.

Alternative — keep fallback but log as `ERROR` (not `log`), and add Prometheus metric: `reset_scenes_fallback_total`. This allows seeing if fallback still fires. Softer option, in case there's a rare caller without bookDiff.

**Recommendation:** First option (throw). This is an explicit contract. grep callers will reveal if anything is missed — better to fail at start than silently diverge.

---

## R8. Inline PG Query in completeStage

`orchestrator.js:132-154` — inline SQL in function body:

```js
const sceneResult = await pgQuery(`
    SELECT content_version, audio_config_version FROM scenes
    WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
`, [bookId, chapterId, sceneId]);
```

This makes the facade dependent on PG schema structure. Any `scenes` refactoring breaks `orchestrator`.

### What's Proposed

Add method `scene-assets-repo.getSceneVersions(bookId, chapterId, sceneId)` (or `scenes-repo` if it exists), returning `{ content_version, audio_config_version }`. Extract this SELECT there. Facade calls repo.

Scope — 1 method in repo, replace inline SQL with call. No new abstractions.

---

## What NOT to Do (Addition to Existing List)

- Do not introduce event-sourcing for asset state. Redis hash + PG canonical is sufficient.
- Do not add a centralized `validateTransition` interceptor for the entire facade — targeted validation in `setScene*` is enough.
- Do not split `orchestrator.js` into 3 files (markDirty/complete/fail). 13 commands fit in one ~600-line file.
- Do not add circuit-breaker for PG (current fail-closed on PG error is correct).
- Do not migrate `audioOrch.*` calls from reconciliation in one PR — do it slowly, 2–3 sites at a time.

---

## Priorities and Implementation Order

| Phase | Tasks | Scope | Risk |
|-------|-------|-------|------|
| **Phase A (1 day)** | R2 (delete alias), R6 (invariant test), R4 (top-level require) | ~120 lines | Low |
| **Phase B (1 week)** | R1 (validate+journal in setScene*), R7 (bookDiff required), R8 (extract SQL to repo) | ~80 lines | Medium |
| **Phase C (2 weeks)** | R3 (align 18 audioOrch calls), R5 (split resetScenes into 2 helpers) | ~150 lines | Medium |

All three phases **combined are smaller** than a single `reconciliation-engine.js` (1541 lines). No new functionality is added, no new complexity introduced.

---

## "Stable" Criteria

| Criterion | Current | After |
|-----------|---------|-------|
| `validateAssetTransition` called in all 13 lifecycle facade writes | 2 of 13 | 13 of 13 |
| Journal event written on every asset state change | ~5 places | all terminals |
| Deprecated API in `state.js` | 2 aliases | 0 |
| Direct `audioOrch.*` outside `orchestrator.js` and `scene-orchestrator.js` | 18 calls | 0 |
| Audio-orch invariant test | none | 3 cases |
| Inline SQL in `orchestrator.js` | 1 SELECT | 0 |

After completing Phases A+B+C, the system remains within the **same complexity bounds** as now: one Node process, Redis, PG, the same 13 facade commands, the same dispatch-engine. Only the gaps between them become observable and validatable.

<!-- === Footer === -->
---
*Stabilization recommendations. July 26, 2026. Basis: code review `2026-07-26`.*
