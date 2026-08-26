# Video Re-Dispatch Root Cause Analysis

**Date:** 2026-08-26  
**Scene:** `import_1786345731767_1786345734345/ch-1bb5123c/sc-a740d763` (video) + `sc-5f0068ca` (video cover)  
**Symptom:** Video generated once (799 KB), but backend kept re-dispatching. Worker cleaner deleted the file. ComfyUI retries hit 404 on download. Circuit breaker stuck in `half_open`. Eventually `RETRY_BUDGET_EXCEEDED`.

---

## Timeline

```
T0: Backend dispatch #1 (dispatch_id=abc)
    ├─ initState → GENERATING
    ├─ sends task to GPU Hub
    └─ setWaitingChunks → WAITING_CHUNKS

T1: Worker generates video (799 KB)
    ├─ Worker sends result to Hub (dispatch_id=abc)
    ├─ Hub stores in Redis, forwards to backend
    └─ Backend: /gpu/task/result

T2: Backend processes result
    ├─ verifyDispatchIdentity → dispatch_id=abc ✓
    ├─ handleTaskResult → videoOrch.completeGroup
    ├─ completeGroup: video-orch state=null → legacy path
    ├─ completeStage → handleVideoCompleted → file OK → READY ✓
    └─ finalizeDispatch('success') → clears metadata, lease, circuit=success ✓

--- But if lease expired BEFORE T2 (timer glitch / restart): ---

T2': Backend did NOT receive result in time (lease expired)
    ├─ Scheduler: new dispatch (dispatch_id=def)
    ├─ initState → OVERWRITES state to GENERATING
    ├─ sends SAME task to GPU Hub (new dispatch_id=def)
    └─ setWaitingChunks → WAITING_CHUNKS

T3: Hub receives result from Worker (dispatch_id=abc — OLD!)
    ├─ Hub: runningInfo.dispatch_id=def ≠ abc → 409 REJECTED ❌
    └─ Result lost! Hub does not remove from animastor:running

T4: Worker tries to download video → 404
    ├─ File already cleaned up by worker after T1
    ├─ ComfyUI: "I already served the result" → /view → 404
    └─ Worker: sendTaskError → Hub → /gpu/task/error (dispatch_id=def)

T5: Backend processes error
    ├─ verifyDispatchIdentity → dispatch_id=def ✓ (current)
    ├─ failStage → video: FAILED → PENDING
    ├─ finalizeDispatch('failure') → circuit=OPEN, retry_budget consumed
    └─ Scheduler: video=PENDING → ATTEMPT_DISPATCH → CIRCUIT_BLOCKED

T6: Loop repeats:
    ├─ Circuit → half_open → test dispatch
    ├─ Worker: download → 404 → error → circuit OPEN again
    └─ RETRY_BUDGET_EXCEEDED → scene stuck forever
```

---

## Root Cause #1: `finalizeDispatch` does NOT clean up on `stale_dispatch`

**File:** `backend/src/runtime/dispatch-engine.js`, line ~748

```javascript
if (metadata.dispatch_id !== dispatchId) {
    return {
        finalized: false,
        reason: 'stale_dispatch',    // ← silently returns false, no cleanup!
        currentDispatchId: metadata.dispatch_id || null
    };
}
```

When a result arrives with a **stale dispatch_id** (because the scheduler already created a new dispatch), `finalizeDispatch` **silently returns false** and **does NOT release the lease/metadata**. This means:

1. The old dispatch is NEVER finalized
2. Scheduler sees an active lease → tries re-dispatch → creates a NEW dispatch
3. Hub receives result with old dispatch_id → 409 (stale) → result is lost
4. Worker has already cleaned up the file → subsequent download → 404
5. Error callback → `failStage` → FAILED → PENDING → retry loop

---

## Root Cause #2: `initState` unconditionally overwrites video-orch state

**File:** `backend/src/services/video-orchestrator.js`, line ~152

```javascript
async function initState(redis, bookId, chapterId, sceneId, buildId, groups) {
    const state = createState(buildId, groups);  // ← ALWAYS GENERATING
    await setState(redis, bookId, chapterId, sceneId, state);
    // ...
}
```

When re-dispatch calls `initState`, it overwrites WAITING_CHUNKS → GENERATING. Then `setWaitingChunks` transitions GENERATING → WAITING_CHUNKS (succeeds). But the old result (dispatch_id=abc) is now rejected as stale because the new dispatch_id=def is in metadata.

---

## Root Cause #3: Worker download failure is not a terminal rejection

**File:** `worker/worker/worker.cjs`, line ~497

The "Download failed: 404" error from the worker's HTTP fallback (`/view` endpoint) is forwarded to the backend as a regular error via `/gpu/task/error`. The backend treats it as a transient failure and calls `failStage` → FAILED → PENDING → re-dispatch.

But a 404 on download is a **terminal condition** — the file is gone, retrying won't help. The error should be classified as non-retryable.

---

## Recommended Fixes

### Fix 1: `finalizeDispatch` — handle stale dispatch gracefully

When `dispatch_id` doesn't match, check if the lease has expired. If yes, clean up the orphaned lease and metadata:

```javascript
if (metadata.dispatch_id !== dispatchId) {
    // Stale dispatch — check if lease has expired
    const currentLeaseToken = await redis.get(leaseKey);
    if (!currentLeaseToken) {
        // Lease expired — clean up orphaned metadata
        await redis.del(metadataKey);
        stopDispatchRenewal(bookId, chapterId, sceneId, stage);
        return { finalized: false, reason: 'stale_dispatch_cleaned', orphanCleaned: true };
    }
    // Lease still active (new dispatch) — leave alone
    return { finalized: false, reason: 'stale_dispatch', currentDispatchId: metadata.dispatch_id };
}
```

### Fix 2: `video-orchestrator.initState` — don't overwrite intermediate states

Check the current phase before overwriting:

```javascript
async function initState(redis, bookId, chapterId, sceneId, buildId, groups) {
    const current = await getState(redis, bookId, chapterId, sceneId);
    if (current && (current.phase === PHASES.WAITING_CHUNKS || current.phase === PHASES.MERGING)) {
        // Don't overwrite — previous dispatch is still in progress
        warn(`initState: skipping overwrite for ${bookId}/${chapterId}/${sceneId} (phase=${current.phase})`);
        return current;
    }
    const state = createState(buildId, groups);
    await setState(redis, bookId, chapterId, sceneId, state);
    return state;
}
```

### Fix 3: Worker — classify 404 as terminal in error callback

In `worker.cjs`, when `downloadResult` fails with 404, send a specific reason that the backend can classify as non-retryable:

```javascript
} catch (err) {
    const reason = err.message.includes('404')
        ? `download_not_found:${err.message}`
        : err.message;
    await sendTaskError(task, reason);
}
```

Then in `failure-taxonomy.js`, classify `download_not_found` as non-retryable so the retry budget is not consumed.

---

## Impact

- **sc-a740d763**: Video was generated but never accepted by backend due to stale dispatch. Retry loop exhausted budget.
- **sc-5f0068ca**: Video cover never reached ComfyUI because circuit breaker blocked all video dispatches.
- **Worker Cleaner Race**: Worker cleaner deletes output file after successful delivery. If the result is rejected as stale, subsequent retries find no file → 404.

---

## Files Involved

| File | Role |
|------|------|
| `backend/src/runtime/dispatch-engine.js` | `finalizeDispatch` — does not clean up on stale_dispatch |
| `backend/src/services/video-orchestrator.js` | `initState` — unconditionally overwrites state |
| `worker/worker/worker.cjs` | `downloadResult` — 404 not classified as terminal |
| `backend/src/runtime/failure-taxonomy.js` | Failure classification (needs download_not_found) |
| `backend/src/orchestration/orchestrator.js` | `failStage` — triggers re-dispatch on failure |
| `backend/src/routes/generation-routes.cjs` | `/gpu/task/result` and `/gpu/task/error` endpoints |
| `gpu-hub/gpu-hub.js` | Hub error forwarding and result storage |
