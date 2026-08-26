# Independent Forensic Audit: Video Re-Dispatch Retry Loop

**Date:** 2026-08-26
**Scope:** orchestration/retry root cause for chapter video workflow
(book `import_1786345731767_1786345734345`, scenes `sc-a740d763` page animation +
`sc-5f0068ca` video cover).
**Method:** independent code-level verification of `dispatch-engine.js`,
scheduler, orchestrator facade, video-orchestrator, task-handler,
generation-routes, gpu-hub, worker + cleanup; cross-check of the prior audit
(`video-retry-root-cause-2026-08-26.md`, Mimo 2.5 preliminary).
**No patches proposed here** — Worker must stay a simple executor; all fixes
belong to backend / orchestration / GPU Hub.

---

## 0. Evidence base and its limits

- The previous audit doc's timeline (`dispatch_id=abc/def`) is **synthetic
  reconstruction, not extracted logs**.
- The event journal lives only in Redis (`animastor:event-journal:*`,
  `backend/src/orchestration/event-journal.js`). **No real incident logs exist
  in the repository** (no `*.log`/`*.jsonl`; `audio-qwen/audit-2026-08-25.txt`
  is a GPU runtime snapshot, not orchestration logs).
- Therefore: claims below marked "confirmed by code" are proven; **the exact
  trigger of this specific incident cannot be proven from logs** — honest limit.

---

## A. Root Cause

Architectural asymmetry between success and failure when a success-callback is
lost, amplified by deterministic task identity:

1. **Video success is not a durable fact for the orchestrator.** The only path
   to READY is the callback `/gpu/task/result` → `completeGroup` →
   `completeStage`. If that callback is lost/rejected, the result exists only:
   - in the worker file, which the worker **deletes immediately after HTTP 200
     from the hub** (`worker/worker/worker.cjs` finally-block;
     `outputDelivered=true`), and hub 200 means only "stored in Redis and
     *attempted* backend delivery up to 5 times" (`gpu-hub/gpu-hub.js`
     `/task/result`: on total failure only `console.error("backend delivery
     failed")` is logged — the worker already got `ok:true`);
   - in the hub Redis copy `animastor:result:*` with TTL 3600s.
   After that the system holds **zero evidence generation succeeded** and, by
   all its state machines, legitimately considers the scene unfinished → any
   watchdog/failStage path re-dispatches.

2. **A repeated task is indistinguishable from the first one.** `job_id` and
   workflow are fully deterministic:
   - `job_id = book_ch_scene_gN:video`, no dispatch_id
     (`backend/src/video/video-service.js`);
   - `filename_prefix = video/<book>_<ch>_<scene>`, no timestamp/dispatch_id
     (`backend/src/workflows/video-workflows.js:402-404`).
   A re-dispatch sends a **byte-identical prompt** to ComfyUI → ComfyUI node
   cache returns the cached output under the old filename instead of
   regenerating → `waitResult` gets metadata pointing to the file already
   deleted by the cleaner → local read miss → HTTP fallback `/view` →
   `Download failed: 404`.

3. **404 is classified as transient.** `"Download failed: 404"` matches no
   `PERMANENT_PATTERNS` entry (including `/(.*)not.*found$/i` — the message
   ends with "404", not "not found") in
   `backend/src/runtime/failure-taxonomy.js` → transient, retryable →
   `failStage` (redispatch=true default) → FAILED→PENDING → scheduler
   re-dispatch → **closed loop**: each iteration burns retry budget until
   `RETRY_BUDGET_EXCEEDED`, circuit breaker flaps OPEN↔half_open, blocking the
   other video scene.

One line: **the orchestrator re-runs already-done work because it never learned
about the success — every carrier of that fact (worker file, hub Redis copy,
in-flight HTTP response) disappears within ≤1h — and because task identity is
deterministic, the retry looks legitimate but deterministically hits the
deleted artifact and is misclassified as transient.**

---

## B. Trigger

Exact trigger not provable from logs. Code admits exactly four entries into the
loop, all via moving video back to PENDING/DIRTY:

| # | Trigger | Location | Assessment |
|---|---------|----------|------------|
| T1 | Success-callback lost/failed (hub→backend 5 retries exhausted; or exception in `handleTaskResult` → 500) → state stuck WAITING_CHUNKS → stall watchdog | `gpu-hub.js /task/result`; `reconciliation-engine.js checkStalledVideoScenes` (threshold ≥ per-job timeout+5min) | most probable |
| T2 | Lease expiry due to **backend restart**: renewal timers are in-memory (`lease-manager.js activeLeaseRenewals: Map`) and are not re-armed after restart | `lease-manager.js`; `runtime-config.js LEASE_TTL_S.VIDEO=30*60` | requires restart |
| T3 | PG version mismatch → `markVersionStaleDirty` resets READY→DIRTY on an already-ready scene | `runtime-scheduler.js detectVersionStale/markVersionStaleDirty` | possible |
| T4 | Manual regenerate (force-dispatch flag, 120s) | `generation-routes.cjs FORCE_DISPATCH_TTL_S` | excluded (no manual regen) |

Mimo asserted T2 as fact. Code does **not** confirm it as the actual trigger:
with a live backend the lease is renewed every 30s (+180s TTL), so expiry in a
healthy system is impossible; T2 requires an extra condition (restart). T1
requires nothing beyond a single delivery failure, so it is statistically
prior.

---

## C. Contributing Factors

1. Worker deletes output immediately after hub 200, though 200 ≠ "backend
   accepted". The "hub is durable" assumption is false: hub Redis copy lives
   1 hour.
2. Deterministic prompt (see A-2) turns any re-dispatch into pseudo-generation.
3. Transient classification of 404 — no terminal handling for "artifact gone".
4. `executeVideoDispatch` itself deletes the VPS group copy before regeneration
   (`scene-orchestrator.js`, `unlinkSync(stalePath)`) — after the first loop
   iteration, cache-hit/fast-track recovery becomes impossible; the loop locks
   in.
5. Stale-accept for video (`task-handler.cjs`, `generation-routes.cjs`): late
   groups with old dispatch_id are accepted in WAITING_CHUNKS/MERGING — a known
   compromise, but it lets old results interfere with the new state machine.
6. `initState` unconditionally overwrites state (including DONE — documented as
   intentional), `video-orchestrator.js:155`.
7. Circuit breaker is global per stage ('video'), so one scene's loop blocks
   the other.

## D. Why Cleaner exposed the bug

Cleaner is correct and disciplined (deletes strictly after DELIVERED,
journal-backed recovery). It is **not the primary cause**: it merely destroys
the last physical copy of a result whose accounting the system had already
lost. Without cleaner the loop would look different (ComfyUI would return the
file and the duplicate success would be accepted), but the underlying bug —
"orchestrator does not retain knowledge of success" — would remain. Cleaner
turned a latent bug into an observable 404.

## E. Exact code locations

| Decision | File : function |
|----------|-----------------|
| Re-dispatch decision (FAILED→PENDING) | `backend/src/orchestration/orchestrator.js:232` `failStage()` |
| Accepting worker error | `backend/src/routes/generation-routes.cjs` `/gpu/task/error` |
| Classifying 404 as transient | `backend/src/runtime/failure-taxonomy.js` `classifyFailure` |
| Watchdog re-dispatch of stalls | `backend/src/runtime/reconciliation-engine.js` `checkStalledVideoScenes` → `failWaitingScene` |
| Deleting VPS group copy before regen | `backend/src/orchestration/scene-orchestrator.js` `executeVideoDispatch` |
| Unconditional state overwrite | `backend/src/services/video-orchestrator.js:155` `initState` |
| Result loss on failed backend delivery | `gpu-hub/gpu-hub.js` `/task/result` (5-retry loop, `ok:true` to worker) |
| File deletion by worker | `worker/worker/worker.cjs` finally-block + `journal.setDelivered` |
| Deterministic prompt | `backend/src/video/video-service.js`; `backend/src/workflows/video-workflows.js:402-404` |

---

## F. Mimo Audit Verdict

| Mimo claim | Verdict |
|------------|---------|
| Lease expires → scheduler creates new dispatch | **partially confirmed**: mechanism exists, but with a live backend lease renews every 30s (`RENEWAL_INTERVAL_MS=30s`); expiry requires restart/renewal failure. As *this* incident's trigger — **not confirmed** (no logs) |
| New dispatch gets new dispatch_id | **confirmed by code** (`generateDispatchToken` per `dispatchStage`) |
| Old callback becomes stale, backend rejects it | **refuted in general form**: audio/video stale results are **accepted** in WAITING_CHUNKS/MERGING (comments «🔧 FIX»); rejected only in GENERATING/DONE/no-state |
| Hub rejects old result 409, doesn't clean running | **confirmed by code** (`stale_or_unknown_dispatch`, early return without hdel). But consequence wrong: on 409 the worker does **not** delete its file (`outputDelivered=false`), so this branch alone produces no 404 |
| `finalizeDispatch` silently returns on stale_dispatch without cleanup → infinite cycle | **refuted as root cause**: metadata/lease at that moment belong to the *new live* dispatch and are finalized by it; the early return is correct behavior (a stale callback must not finalize someone else's dispatch). It creates no cycle |
| `initState` unconditionally overwrites state | **confirmed by code**, but it is a condition of the loop, not its initiator |
| 404 download falls into retryable path | **confirmed by code** — the main loop driver; Mimo judged this correctly |
| Circuit half_open / RETRY_BUDGET_EXCEEDED finale | plausible from code, unproven by logs |
| Lease TTL insufficient for video gen + delivery | **refuted**: VIDEO=30 min base + renewal every 30s (+180s) ⇒ effectively unlimited while backend alive; insufficient only if renewal timers lost (restart) |

---

## G. Minimal Correction Strategy (conceptual only)

1. **Make success durable at the backend**: results stored by the hub should be
   pulled by backend recovery/reconciliation (`animastor:result:*` already sits
   in Redis 1h — nobody reads it during recovery), or the hub should not answer
   200 to the worker before backend acknowledgement.
2. **Terminal classification** for "result unavailable at executor"
   (download 404 / artifact gone): do not burn retry budget; raise a
   reconciliation event instead of FAILED→PENDING.
3. **Idempotency of re-generation at identity level**: dispatch_id or nonce in
   the workflow (filename_prefix/prompt) so a re-dispatch is a *new* prompt for
   ComfyUI, not its byte clone.
4. **Do not delete the VPS group copy** until the new generation has actually
   started successfully.
5. Fix location — **backend/orchestration layer**
   (failStage/taxonomy/reconciliation/scene-orchestrator); the hub's job is
   only durable delivery guarantee.

## H. Worker Boundary

Must **never** be added to the Worker:
- dedup by job_id/dispatch_id or "already generated" decisions;
- retry policy, retry budget, terminal/transient classification;
- cross-task result caching;
- knowledge of scene/stage state;
- error masking ("file vanished — count as success").

Worker contract stays: run prompt → deliver result → report exact error →
clean own files. "Download failed: 404" is an honest signal; interpreting it
is the backend's job.

---

## Timeline (code-derived; real timestamps unavailable)

```
T0  dispatchStage #N → lease+meta+quota → executeVideoDispatch → initState(GENERATING)
    → setWaitingChunks → sendUnified(job_id deterministic)
T1  Worker: runWorkflow(/prompt) → waitResult → mp4 on ComfyUI disk
T2  Worker: downloadResult (local read) → sendResult → hub 200
T3  Hub: animastor:result:* (TTL 1h) → up to 5 attempts POST /gpu/task/result
    ── if all 5 fail: result lost forever ──
T4  Backend (normal path): completeGroup → merge → completeStage
    → verifyDispatchIdentity → READY + finalizeDispatch('success') → lease released
    ── or (incident): T4 never happens; state stuck in WAITING_CHUNKS
T5  Worker cleaner: outputDelivered=true → unlink mp4  ← last copy destroyed
T6  Stall watchdog / lease expiry (after restart) → failWaitingScene → failStage
    → FAILED→PENDING → finalizeDispatch('failure')
T7  Scheduler tick → dispatchStage #N+1 → initState overwrite → job to hub again
    → ComfyUI: identical prompt → node cache → old filename returned
T8  Worker: local miss → GET /view → 404 → sendTaskError("Download failed: 404")
    → failStage(transient) → PENDING → goto T7   ⟲ budget burn →
    RETRY_BUDGET_EXCEEDED, circuit OPEN↔half_open, second video scene blocked
```

**Bottom line:** the orchestrator did not "decide" to regenerate — it never
learned about the success in the first place. Everything downstream (watchdog,
failStage, scheduler) behaved exactly as designed, on incorrect inputs.
