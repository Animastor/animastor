# Video Re-Dispatch Loop — Independent Forensic Audit (v2)

**Date:** 2026-08-26
**Subject of review:** `docs/runtime-audits/video-retry-root-cause-2026-08-26.md` (Mimo 2.5, commit `bb58af8`)
**Scenes under investigation:** `import_1786345731767_1786345734345/ch-1bb5123c/sc-a740d763` (video) and `ch-37eadabb/sc-5f0068ca` (video cover)
**Auditor:** Independent re-review against current code in `bb58af8`

This document does **not** propose a patch. It verifies — and in
several places refutes — the Mimo 2.5 narrative by walking the actual
code paths and correlating them with the on-disk evidence in
`data/output/build_import_1786345731767_1786345734345/`.

---

## TL;DR

The Mimo 2.5 audit identifies **real defects** in `dispatch-engine`
and `video-orchestrator` that are necessary preconditions for
re-dispatch loops, but **none of them is proven to be the triggering
event for this specific incident** (`sc-a740d763`, `sc-5f0068ca`).

The narrative "Worker cleaner deleted the file → ComfyUI 404 →
re-dispatch loop" contains logical inconsistencies with the actual
code:

1. The cleaner only runs after a successful `sendResult` (HTTP 200).
   It cannot interleave with a *fresh* re-dispatch on a different
   worker, because each worker has its own `COMFY_OUTPUT_DIR` and only
   reads files it just produced.
2. The audit's claim "Video was generated but never accepted by
   backend due to stale dispatch" is **contradicted by the on-disk
   state**: the file `import_1786345731767_1786345734345_ch-1bb5123c_sc-a740d763.mp4`
   (584 KB) and its group clip `_g1.mp4` (614 KB) are present, dated
   2026-08-26 03:52.
3. The audit's "799 KB" file size is wrong; the actual files are
   614 KB (group) and 584 KB (merged).

What is true and matters: the backend's `completeStage` has a
fail-closed version-gate (`orchestrator.js:124–194`) that downgrades a
successful handler result to `DIRTY` when the PG version check is
not satisfiable. The scheduler's `shouldScheduleAssets`
(`runtime-scheduler.js:336–347`) treats `DIRTY` as dispatchable, so
the very next tick re-arms a new dispatch for the same scene. The
"re-dispatch" observed in this incident is therefore most likely
driven by **the version-gate's `DIRTY` exit**, not by lease expiry
or worker-side failure.

The Mimo 2.5 root causes are **latent defects** that would matter
under a stale-callback race, but that race is not established by the
on-disk evidence.

---

## Timeline reconstruction (evidence-based)

| Time            | Evidence                                                                                 | Inference                                                                            |
|-----------------|------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| Aug 26 03:03    | `sc-a740d763_iu-070ed92b.png` (1.0 MB) written                                           | Image dispatch for `chapter_intro` unit `iu-070ed92b` succeeded                       |
| Aug 26 03:04    | `sc-a740d763_pr-070ed92b.png` (164 KB) written                                           | Image preview produced                                                                |
| Aug 26 03:52    | `sc-a740d763_g1.mp4` (614 KB) and merged `sc-a740d763.mp4` (584 KB) written              | Single-group video generated, group file written, then merged into scene.mp4          |
| Aug 26 03:5x+   | (probable) re-dispatch loop                                                              | `shouldScheduleAssets` keeps returning `video` because state is `PENDING` or `DIRTY` |
| Aug 26 04:55    | Mimo 2.5 audit committed                                                                 | Symptoms and three proposed root causes documented                                     |

**Source:** `ls -la data/output/build_import_1786345731767_1786345734345/` at `bb58af8`.

**What we do not have:**

- Backend logs from the incident.
- Redis state snapshots (lease keys, dispatch metadata, video-orch
  state, asset-state hash).
- Hub state (`animastor:running`, `animastor:result:*`).
- `event-journal` history.

The repository contains no operational logs for these scenes
(`grep -rn "sc-a740d763\|sc-5f0068ca" backend/` returns no hits). All
conclusions below are reconstructed from on-disk state and code-path
analysis, not from observed runtime events.

---

## Verification of the Mimo 2.5 audit (claim-by-claim)

For every claim in the Mimo 2.5 audit I list the verdict, the code
locations that ground it, and the supporting or refuting evidence.

| #  | Mimo claim                                                                                                                                         | Verdict                  | Grounding code                                                                                              | Notes |
|----|----------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------|-------------------------------------------------------------------------------------------------------------|-------|
| 1  | `finalizeDispatch` silently returns `stale_dispatch` without cleanup (line ~748)                                                                    | **Confirmed (code)**     | `backend/src/runtime/dispatch-engine.js:758–764`                                                            | Verbatim: `if (metadata.dispatch_id !== dispatchId) return { finalized: false, reason: 'stale_dispatch', currentDispatchId: ... }`. No mutation of metadata/lease/counter. The audit's line number "748" is off by ~10; actual is **758–764**. |
| 2  | `initState` unconditionally overwrites video-orch state (line ~152)                                                                                 | **Confirmed (code)**     | `backend/src/services/video-orchestrator.js:155–160`                                                        | Verbatim: `const state = createState(buildId, groups); await setState(...);`. No `getState` guard. The comment on lines 151–153 explicitly documents the overwrite as **intentional** ("Terminal DONE is overwritten (dirty regeneration) — expected behavior"). |
| 3  | Hub returns HTTP 409 on `dispatch_id` mismatch                                                                                                      | **Confirmed (code)**     | `gpu-hub/gpu-hub.js:855–857` (result) and `990–992` (error)                                                 | `if (!runningInfo || runningInfo.dispatch_id !== dispatch_id) return res.status(409).json({ error: "stale_or_unknown_dispatch" })`. |
| 4  | `/gpu/task/result` accepts stale `dispatch_id` for `audio`/`video` when phase ∈ {WAITING_CHUNKS, MERGING}                                          | **Confirmed (code)**     | `backend/src/routes/generation-routes.cjs:1378–1391`; also `backend/src/services/task-handler.cjs:45–60`    | Mirrored logic in both layers.                                                                              |
| 5  | `/gpu/task/error` does NOT accept stale `dispatch_id`                                                                                              | **Confirmed (code)**     | `backend/src/routes/generation-routes.cjs:1455–1458`                                                        | Late errors are rejected outright; orchestrator does not see them.                                          |
| 6  | `failure-taxonomy` classifies "Download failed: 404" as `transient`/`retryable`                                                                    | **Confirmed (code)**     | `backend/src/runtime/failure-taxonomy.js:38–46` and `:73–113`                                               | The string does not match `(.*)not.*found$`; it falls through to default `transient`. However, see verdict on claim #11. |
| 7  | Lease TTLs: `audio ≈ 1860s`, `image = 1200s`, `video = 1800s`                                                                                     | **Confirmed (code)**     | `backend/src/config/runtime-config.js:162–166`; `backend/src/runtime/lease-manager.js:36–40`                | Two independent definitions; both agree.                                                                     |
| 8  | Lease is renewable every 30 s + 3 min                                                                                                              | **Confirmed (code)**     | `backend/src/runtime/lease-manager.js:29–40, 82–124`                                                        | `RENEWAL_INTERVAL_MS = 30_000`, `LEASE_RENEWAL_TTL_ADD = 180`. **But** timers are in-process; a backend restart loses them. |
| 9  | Scheduler tick interval = 5 s                                                                                                                       | **Confirmed (code)**     | `backend/src/runtime/runtime-scheduler.js:74`                                                               | `SCHEDULER_TICK_MS = 5000`.                                                                                 |
| 10 | `video` retry budget = 5 per (scene, stage)                                                                                                        | **Confirmed (code)**     | `backend/src/runtime/retry-budget-manager.js:24`                                                            | `PER_SCENE_LIMITS = { ..., video: 5 }`.                                                                      |
| 11 | The Worker cleaner's deletion of the output file causes the `/view` 404 on the next attempt                                                        | **Refuted (logical)**    | `worker/worker/worker.cjs:633–688`; `worker/worker/worker-cleanup.cjs:35–58`                                | Cleaner runs **only** in `finally` after `sendResult` returns HTTP 200 (`outputDelivered = true`). On error, `outputDelivered = false` and the file is **not** deleted. A re-dispatch sends a *new* `dispatch_id` to a (potentially different) worker with its own `COMFY_OUTPUT_DIR`; that worker never reads a file from a previous worker's dir. The `/view` 404 path is **not reachable** through the Mimo scenario. |
| 12 | "Video was generated but never accepted by backend due to stale dispatch. Retry loop exhausted budget."                                             | **Refuted by on-disk state** | `data/output/build_import_.../..._sc-a740d763.mp4` (584 KB, Aug 26 03:52)                                | The file **is** on disk. Backend writes the file in `task-handler.cjs:85 fs.writeFileSync` **unconditionally**, BEFORE `handleTaskResult` decides on state. |
| 13 | "799 KB" video file size                                                                                                                           | **Refuted by on-disk state** | (same)                                                                                                     | Actual: 614 KB for `_g1.mp4`, 584 KB for merged `scene.mp4`.                                               |
| 14 | "sc-5f0068ca video cover never reached ComfyUI because circuit breaker blocked all video dispatches"                                               | **Partially confirmed**  | `backend/src/runtime/circuit-breaker.js:50–54`; `backend/src/runtime/dispatch-engine.js:461–479`            | Circuit-breaker logic is present and would block re-dispatch after 5 consecutive `video`-stage failures. We cannot confirm from the repo that the breaker was the proximate cause. **Confirmed by absence of evidence**: no `*.mp4` for `sc-5f0068ca` exists, so the video generation never produced an output. |
| 15 | "Worker 404 download 404 not classified as terminal"                                                                                               | **Confirmed in the abstract; moot for this incident** | (see #11)                                                                                                  | Even if the classification were changed to terminal, the Mimo scenario does not cause a `/view` 404 on a re-dispatch. |
| 16 | The `stale_dispatch` branch in `finalizeDispatch` is the cause of the missing cleanup that perpetuates the loop                                      | **Confirmed as defect, NOT confirmed as trigger** | (see #1)                                                                                                    | The branch is a *latent* defect: if a stale callback ever arrives, the lease/metadata are orphaned. For the *happy* delivery path (file on disk, single dispatch, single result), this branch is not taken. `finalizeDispatch` is called by `orchestrator.completeStage` after the dispatch has been verified and the file has been written. |
| 17 | `dispatch-engine.markDispatchCompleted` / `markDispatchFailed` is the canonical finalization                                                          | **Confirmed (code)**     | `backend/src/runtime/dispatch-engine.js:729–865`                                                            | `finalizeDispatch` is the single entry point and the audit description matches.                              |

---

## A. Root cause (defensible from code + on-disk state)

The most defensible root cause, given the on-disk evidence (file is
present, single dispatch, single group, scene has 1 unit) and the
code, is:

**`orchestrator.completeStage` enters the `version_gate stale` branch
(`orchestrator.js:124–194`) on a successful video delivery. The gate
sets the per-asset state to `DIRTY` instead of `READY`. The
scheduler's `shouldScheduleAssets` (`runtime-scheduler.js:336–347`)
treats `DIRTY` as dispatchable, and the very next tick (≤ 5 s)
re-arms a new dispatch for the same scene. `videoOrch.initState`
(line 155–160) then overwrites the previous `video-orch` state, but
this is the **mechanism** of the loop, not the cause.**

Confidence: **medium**. This is the only root cause I can defend
from code + on-disk evidence without inventing events that the
repository does not record.

The Mimo 2.5 root cause is **not provable** from the same evidence.

---

## B. Trigger

The trigger is `completeStage` entering the `version_gate stale`
branch. The conditions for that branch are:

- The handler `handleVideoCompleted` returned `ok: true` (file valid,
  asset state in `GENERATING|PENDING|DIRTY`), passing through
  `scene-callbacks.js:348–432`.
- The PG check at `orchestrator.js:136–169` either failed (PG
  unreachable), found no `scenes` row for this scene (legacy import),
  or found `scene_content_version < content_version` (stale
  comparison).

Any of those causes the gate to set
`state.unsafeRestoreAssetState(..., DIRTY)` and skip `markReady`.
Because `DIRTY` is dispatchable, the loop self-arms.

For `sc-5f0068ca` the same path is available, plus one more
amplification: the very first dispatch may have been blocked by the
circuit breaker (per the audit's claim #14, which I cannot refute
and which matches the on-disk absence of any video file).

---

## C. Contributing factors

1. **`state.AssetState.DIRTY` is dispatchable.** In
   `runtime-scheduler.js:336–347`, the check is
   `video !== READY && video !== FAILED && video !== GENERATING`.
   There is no `DIRTY` exclusion. This is by design (DIRTY means
   "needs re-generation"), but combined with the version-gate's
   `DIRTY` exit it creates a non-terminal re-dispatch loop unless the
   version-gate eventually resolves.
2. **`initState` unconditionally overwrites state on every
   re-dispatch.** Even when the previous dispatch's group file is
   already valid and unit-id-identical, `initState` re-arms the
   `videoOrch` state from scratch. The fast-track cache-hit at
   `scene-orchestrator.js:360–407` then re-derives the merged file
   without consulting the backend's `completeStage` history. Not
   wrong in isolation, but it means the version-gate's READY decision
   is effectively *unreachable* for a file that is already on disk:
   the next dispatch either reuses the file (cache-hit) or generates
   a new one and re-enters the same gate.
3. **`finalizeDispatch` does not clean up on `stale_dispatch`.** Real
   defect (`dispatch-engine.js:758–764`). Latent in this incident,
   but it would matter for any future race between callback and
   re-dispatch.
4. **Cleaner runs after `sendResult` only.** The cleaner deleting
   *transient* ComfyUI outputs is correct and unrelated to the
   re-dispatch. It only matters for the *same* worker process and
   only for the *same* ComfyUI output directory.
5. **Backend process restart kills the lease renewal timer**
   (in-process `setInterval` in `lease-manager.js:101–107`). After a
   restart, the last-known lease is left to expire by its own TTL
   (1800 s for video). If the result lands during that window, it
   can race the new scheduler's re-dispatch. This is the only path
   by which Mimo's `lease_expiry → 409 → stale_dispatch` narrative
   becomes plausible, and even then it is not the dominant mechanism
   for *this* incident (we have a file on disk, which means at
   least one delivery completed end-to-end).

---

## D. Why the cleaner exposed the bug (and why it is not the root cause)

The cleaner is the wrong target for blame because:

- The cleaner never touches `data/output/build_*/...mp4`. It only
  deletes the *transient* file in the worker's `COMFY_OUTPUT_DIR` and
  the *transient* input files in `COMFY_INPUT_DIR`. See
  `worker/worker/worker-cleanup.cjs:35–58` and the call site at
  `worker/worker/worker.cjs:657–688`.
- The cleaner only runs when `outputDelivered === true`
  (`worker.cjs:660, 663–666`). On any error path
  (`sendResult` throws, hub returns non-200, network blip), the
  ComfyUI output file is **preserved** for the next retry on the
  same worker. So the "cleaner deleted the file and the next
  attempt 404'd" narrative requires the cleaner to run *before* the
  next attempt — which only happens if the same worker successfully
  delivered, then re-attempted. That requires a *single worker* to
  receive two different `dispatch_id`s, which is not how the
  dispatch model works: each worker poll grabs one job at a time
  (`worker/worker/worker.cjs:580+`).
- The `/view` 404 fallback at `worker.cjs:487–498` is only reached
  when the local ComfyUI file is gone. The only way for it to be
  gone *after* a successful `waitResult` is for ComfyUI itself to
  have removed the file (workflow cleanup), or for the worker's
  `COMFY_OUTPUT_DIR` to be ephemeral (container restart without
  persistent volume). Neither is the cleaner.

So the cleaner is **not the trigger**. It is a contributing surface
only if the worker is restarted between jobs, which the Mimo 2.5
narrative does not establish.

---

## E. Exact code locations

| Concern                                                                | File                                                  | Lines         | What it does                                                                                                       |
|------------------------------------------------------------------------|-------------------------------------------------------|---------------|--------------------------------------------------------------------------------------------------------------------|
| Version-gate stale → `DIRTY` (the real trigger)                        | `backend/src/orchestration/orchestrator.js`           | 124–194       | If PG version check fails, sets `state = DIRTY` (line 190) and skips `markReady`.                                    |
| `DIRTY` is dispatchable                                                | `backend/src/runtime/runtime-scheduler.js`            | 336–347       | `shouldScheduleAssets` does not exclude `DIRTY`; it is treated as needing dispatch.                                  |
| `initState` overwrites                                                 | `backend/src/services/video-orchestrator.js`          | 155–160       | Unconditional `setState(createState(...))` — wipes any prior `WAITING_CHUNKS|MERGING|DONE` state.                   |
| Fast-track cache-hit path (re-uses file, re-derives)                   | `backend/src/orchestration/scene-orchestrator.js`     | 360–407       | If file valid + unit_ids match → `markGroupDone` + `completeGroup` without sending a ComfyUI job.                   |
| `finalizeDispatch` silent on `stale_dispatch`                          | `backend/src/runtime/dispatch-engine.js`              | 758–764       | Returns `{ finalized: false, reason: 'stale_dispatch' }` without cleaning metadata/lease/counter.                   |
| `verifyDispatchIdentity` returns `stale_dispatch`                      | `backend/src/runtime/dispatch-engine.js`              | 230–251       | Pure read; no side effects.                                                                                         |
| `/gpu/task/result` stale-accept for chunks                             | `backend/src/routes/generation-routes.cjs`            | 1378–1391     | Allows `stale_dispatch` if `videoOrch` phase ∈ {WAITING_CHUNKS, MERGING}. Lost on `initState` overwrite.            |
| `/gpu/task/error` no stale-accept                                      | `backend/src/routes/generation-routes.cjs`            | 1455–1458     | Late errors rejected outright.                                                                                       |
| File write is unconditional                                            | `backend/src/services/task-handler.cjs`               | 81–86         | `fs.writeFileSync(asset.fullPath, resultBuffer)` runs *before* `handleTaskResult`'s success state is decided.       |
| Cleaner (worker-local, scoped)                                         | `worker/worker/worker.cjs` + `worker/worker/worker-cleanup.cjs` | 657–688 + 35–58 | Cleaner runs only when `outputDelivered === true`; removes only this worker's `COMFY_OUTPUT_DIR` and `COMFY_INPUT_DIR` files. |
| `downloadResult` `/view` fallback (dead path for this incident)        | `worker/worker/worker.cjs`                           | 463–503       | Tries local filesystem first, then ComfyUI `/view`. The HTTP fallback is the only path that can produce a 404.    |
| `failure-taxonomy.classifyFailure`                                     | `backend/src/runtime/failure-taxonomy.js`             | 73–113        | Permanent patterns do not match "Download failed: 404" → defaults to `transient`. The classification is correct.    |
| Circuit breaker (relevant for `sc-5f0068ca`)                           | `backend/src/runtime/circuit-breaker.js`              | 50–54         | `failureThreshold: 5`, `recoveryTimeoutMs: 60_000`. After 5 consecutive failures for `video` stage, all video dispatches block. |
| Lease renewal (in-process timer)                                       | `backend/src/runtime/lease-manager.js`                | 82–124        | `setInterval` every 30 s; lost on backend restart.                                                                 |
| `handleVideoCompleted` precondition                                    | `backend/src/orchestration/scene-callbacks.js`        | 348–432       | Returns `ok: true` only if `assetStates.video ∈ {GENERATING, PENDING, DIRTY}`.                                     |

---

## F. Mimo 2.5 audit verdict (summary)

| Claim                                                                                                                                       | Verdict                        |
|---------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------|
| **R1:** `finalizeDispatch` silently returns `stale_dispatch` without cleanup                                                                  | Confirmed as code defect (line 758–764, not 748). **Latent** for this incident.        |
| **R2:** `initState` unconditionally overwrites video-orch state                                                                              | Confirmed. **Not a trigger** — it is the mechanism that the real trigger exploits.      |
| **R3:** Worker 404 download classified as `transient`                                                                                        | Confirmed but **moot**: 404 is not reachable through the Mimo narrative.                |
| **F1:** Lease expiry → 409 → stale dispatch → orphan metadata                                                                                 | Code path exists; **not proven** for this incident. Re-dispatch of `sc-a740d763` shows a file on disk from a successful delivery. |
| **F2:** Worker cleaner deleted the file → 404 → retry                                                                                         | **Refuted**: cleaner runs only after `sendResult` succeeds, and it deletes from the *worker's* `COMFY_OUTPUT_DIR`, which a *new* dispatch's worker does not read. |
| **F3:** "Video was generated but never accepted by backend due to stale dispatch. Retry loop exhausted budget."                              | **Refuted by on-disk state** for `sc-a740d763` (the file is there, 584 KB, 03:52).      |
| **F4:** "sc-5f0068ca video cover never reached ComfyUI because circuit breaker blocked all video dispatches"                              | Plausible. There is no on-disk video file for `sc-5f0068ca`. Not directly refutable.    |
| **F5:** "799 KB" video file                                                                                                                  | **Refuted by on-disk state**: 614 KB (`_g1.mp4`) / 584 KB (merged).                     |
| **Recommended Fix 1:** Add lease-expiry cleanup in `finalizeDispatch`                                                                        | Defensible improvement; addresses a real defect, even if it is not THE trigger.          |
| **Recommended Fix 2:** `initState` should not overwrite `WAITING_CHUNKS`/`MERGING`                                                          | Defensible improvement; removes a real foot-gun.                                         |
| **Recommended Fix 3:** Worker classifies 404 as terminal                                                                                      | **Wrong premise**: the 404 is not the failure mode of this incident. See F2.            |

The audit's *defects* are real; the audit's *narrative* (trigger) is
not supported by the on-disk evidence and the code.

---

## G. Minimal correction strategy (conceptual only)

1. **Make `state = DIRTY` non-dispatchable on a per-build-id basis**
   so that a successful-but-stale delivery does not re-arm a new
   dispatch for an asset whose on-disk file is already valid. This is
   the most surgical change: the version-gate is doing the right
   thing (fail-closed), but the scheduler should not treat a
   "stale and happy on disk" state as needing regeneration.
2. **In `videoOrch.initState`, accept the previous state if it is
   `DONE` and the file is on disk and unit-ids match.** This is the
   explicit fix Mimo proposed. It is good, but it must be paired
   with (1) to actually stop the loop.
3. **Make `finalizeDispatch` clean up its own metadata when it
   detects `stale_dispatch` and the active lease is gone.** Prevents
   orphaned metadata from accumulating; not required to fix the
   incident but it is a real defect.
4. **Reconcile `scene-assets.status='ready'` against on-disk
   presence and content version** in the worklist rebuild
   (already partially done at
   `reconciliation-engine.js:1948–1957` and `:1974–2001`); make sure
   the rebuild never writes `PENDING` for an asset whose on-disk
   file is valid AND whose `scene_assets` is already `ready`. Second
   line of defence.

Do **NOT** add any of:

- 404 → terminal classification in the worker
- dedup logic in the worker
- "am I stale" decision in the worker
- any re-dispatch decision in the worker

---

## H. Worker boundary — what NOT to add to the worker

The worker MUST remain a thin executor. Specifically, do not add:

1. **404-as-terminal** logic. The 404 is a sign of a bug elsewhere
   (file not actually generated, or hub/cleaner race). Pushing
   terminal handling into the worker hides the real problem and
   makes the worker responsible for an orchestration decision.
2. **Cache-hit decisions** based on disk content. The cache-hit
   logic lives in `videoOrch.isGroupFileValid` +
   `scene-orchestrator.js:374` on the backend side, and that is the
   right place. The worker should not look at a previous dispatch's
   outputs.
3. **Re-dispatch control flow** (e.g., "if the file I just wrote
   matches a previous one, do not upload"). Upload idempotency is
   already covered by the hub's `animastor:job:{dispatch_id}:{job_id}`
   dedup key and the backend's `animastor:result-processed:*` key.
4. **Any knowledge of dispatch identity, lease, or version
   semantics.** The worker is a one-job-at-a-time executor; it
   uploads what it produced and exits.

The worker's only orchestration-adjacent responsibilities (which it
already has correctly):

- Run the workflow and read the result from its local ComfyUI
  output.
- Send the result with the `dispatch_id` it was given.
- Tell the hub about errors.
- Clean up *its own* transient files (input, output) **after** a
  successful delivery.

These are correct. The cleaner is a feature, not a bug. The
`/view` 404 fallback is a defensive code path that protects against
ComfyUI's own temp cleanup; it is correct.

---

## What this audit could not prove

- The exact sequence of state transitions for `sc-a740d763` and
  `sc-5f0068ca`. There are no runtime logs, Redis snapshots, or
  journal events in the repository.
- Whether the version-gate actually blocked READY for these scenes,
  or whether the re-dispatch was driven by some other state-machine
  path.
- Whether the circuit breaker was the cause of `sc-5f0068ca`'s
  missing video file.
- Whether a backend process restart occurred between dispatch and
  result delivery (this is the only path that makes the Mimo
  narrative plausible, and we cannot rule it out).

To settle those questions decisively, we would need:

- The Redis state at the time of the incident (lease keys, dispatch
  metadata, video-orch state, asset-state hash).
- The backend logs from the dispatch and result handler.
- The Hub's `animastor:running` and `animastor:result:*` state.

---

## Final note

The Mimo 2.5 audit is a competent first pass at the code paths but
treats the 404/cleaner/lease-expiry cluster as **the** cause, when
in fact it is at most a *contributing* surface. The actual
triggering event is on the backend side — specifically, the
version-gate's exit to `DIRTY` combined with `DIRTY` being
dispatchable, combined with `initState` having no merge-from-DONE
path. Fixing only the three things Mimo proposes will likely *not*
stop the loop in the scenario that actually produced the symptoms;
the loop will continue, but through a different path.
