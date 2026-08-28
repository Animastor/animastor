# Forensic Audit: Video Re-Dispatch Incident (new, 2026-08-28)

**Date:** 2026-08-28
**Scene:** `import_1786345731767_1786345734345/ch-37eadabb/sc-5f0068ca` (video cover), stage `video`
**job_id:** `import_1786345731767_1786345734345_ch-37eadabb_sc-5f0068ca_g1:video`
**build:** `build_import_1786345731767_1786345734345`
**Worker:** `7bd8609d-0ed8-489a-b1c0-26bc8880ac9a` (private, workspace `3317e019-879d-4dfb-a9f8-edc9b72da7f4`)
**Method:** live runtime evidence — backend docker logs (container up since 2026-08-27 13:02 UTC),
gpu-hub docker logs (up since ~2026-08-27 08:00), Redis state (leases, metadata, asset-state,
video-orch, retry-budget, circuit, event journal), on-disk output mtimes, code-path verification.
**No code changes were made during this investigation.**

---

## TL;DR

A freshly started remote GPU instance picked up one queued video job, generated it
successfully in ComfyUI (~2.6 min), and the backend accepted the result
(stale-accept → READY → FINALIZE_SUCCESS). Immediately afterwards the hub fed the
worker **85 more copies of the same job**, each failing in ~0.7 s with
`Download failed: 404`.

The duplicates were **not** created after the success. They had been accumulating
in the hub queue for 14+ hours (oldest copy from 2026-08-26): every ~28 minutes
the backend reconciliation falsely declared the **live, actively-renewed** video
dispatch "stale" (`metadata.started_at` older than 90% of the 1800 s lease TTL =
27 min), force-reset the scene to dirty and re-dispatched with a new dispatch_id.
Hub dedup is keyed by dispatch_id, so every re-dispatch enqueued a fresh copy.

**Root cause:** `reconciliation-engine.js checkStaleDispatchLeases()` uses
metadata age, while lease renewal never updates `metadata.started_at`, and the
backend itself sends video jobs with `timeout_ms = 60 min` — a direct
contradiction: jobs are allowed to run 60 min but killed as "stale" at 27 min.

This is a **new trigger**, not the old 2026-08-26 bug: the old
`invalid_asset_state` chain is fixed and did not reproduce (dc00075 abort worked,
result accepted, zero retry budget burned, circuit untouched).

---

## Timeline (all timestamps real, UTC)

| Time | Event |
|------|-------|
| Aug 27 13:02 | Current backend container starts. Redis already holds lease+metadata from the previous instance |
| 13:30:08 | Reconciliation: `stale_dispatch_lease` (metadata age > 1620 s) → `RELEASE_STALE_LEASE` + `markDirtyScene` → all 3 assets → `dirty` |
| 13:30:11 | Dispatch attempt #1: `dirty→generating rejected (invalid_asset_transition)` → **abort BEFORE any GPU job** (dc00075 fix working) → video → `pending` → FINALIZE_CANCELLED |
| 13:30:16 | Attempt #2: `pending→generating` OK → task sent to hub (`dispatch-1787837416175`); lease renewed every 30 s |
| 13:58:08, 14:26:09, … every **28 min** | Reconciliation again declares the live dispatch stale → RELEASE_STALE_LEASE → dirty → **new re-dispatch with new dispatch_id** |
| 13:30 → 03:02 | **30 dispatches in 14 h** (≈86 copies total in the hub queue incl. copies from Aug 26). GPU offline — queue not drained |
| **Aug 28 03:10:46** | GPU worker comes online; hub hands it the **oldest queued copy** (FIFO, `dispatch-1787748921140`, created Aug 26 ~12:55) |
| 03:10:46 → 03:13:23 | Real ComfyUI generation (~2.6 min) |
| **03:13:23.65** | **Last successful ComfyUI-side event:** worker → hub `📤 Result` (3177 KB b64) |
| 03:13:23.85–.89 | Backend: `verifyDispatchIdentity: stale_dispatch` → **stale-ACCEPT** (scene WAITING_CHUNKS) → saved `_g1.mp4` (2440273 B, mtime 03:13:23.881) |
| 03:13:24–25 | MERGING → merge → video-orch **DONE** → `handleVideoCompleted` accepts (state=generating) → video → **READY** → REGISTERED → VIDEO_COMPLETED → **FINALIZE_SUCCESS** (merged `sc-5f0068ca.mp4` 1426416 B, mtime 03:13:25.425) |
| **03:13:25.59** | **First event after success:** hub dispatches the next queued copy of the same job to the worker |
| 03:13:26 → 03:14:36 | **85 attempts at ~0.8 s period**: ComfyUI node-cache hit on byte-identical prompt → cached output filename already deleted by cleaner after the successful delivery → local miss → `/view` fallback → **404** → worker error → hub forwards → backend `[GPU ERROR] Rejected: no_active_dispatch` (HTTP 200) |
| 03:14:36 | Hub queue empty (86 dispatches, 85 errors total) |
| 03:25:12 | Hub `💀 GPU timeout: 7bd8609d` — worker dropped from registry (last_seen > 10 min) |

Post-success state (verified in Redis): asset-state video=`ready`, video-orch
`DONE`, `dispatch-completed:…:dispatch-1787886157713` marker present, scene
removed from active index. No dispatch requests for this scene after 03:13:25.

---

## A / B / C verdicts

**A) ComfyUI re-runs the workflow itself after success — NO.**
One real execution (03:10:46 → 03:13:23). All 85 subsequent attempts fail in
~0.7 s — these are ComfyUI **node-cache hits** on a byte-identical prompt, not
re-generations. Job identity is fully deterministic (`job_id` without dispatch_id
— `backend/src/video/video-service.js`; `filename_prefix` without nonce —
`backend/src/workflows/video-workflows.js:402-404`), which is precisely what
makes the cache hit possible.

**B) Backend re-dispatches after success — NO literally, YES causally.**
No DISPATCH_REQUEST after 03:13:25. But the backend is the **origin of the
duplicate stock**: for 14+ hours it killed a live dispatch every ~28 min and
enqueued a fresh copy. The post-success "retries" are the **hub draining the 85
accumulated duplicates** (each with its own dispatch_id). Initiator of the
post-success re-executions: **gpu-hub queue + worker poll loop** — not ComfyUI,
not the cleaner, not a fresh backend dispatch.

**C) Cleaner deleted the output too early — NO as trigger.**
The cleaner removed the worker's `COMFY_OUTPUT_DIR` copy only **after**
successful delivery (hub HTTP 200, backend accepted → READY) — per the worker
contract (`worker/worker/worker.cjs` finally-block, `outputDelivered=true`
gate; cleanup journal CREATED→GENERATED→DELIVERED→CLEANED). ComfyUI had
guaranteed finished with the output before deletion: the file was read,
uploaded (3177 KB), accepted and merged. The deletion only turned the
duplicate attempts into 404s — exactly as the 2026-08-26 forensic audit
predicted ("Cleaner turned a latent bug into an observable 404").

Measured intervals (hypothesis C check):

```
generation finished (hub 📤 Result)     03:13:23.65
backend confirmation (READY+SUCCESS)    03:13:25.44   (+1.8 s)
cleaner deletion (worker-side, ~)       03:13:23.7–24 (after sendResult 200; worker journal not available here)
next execution start (hub 🚀 copy #2)   03:13:25.59   (+0.14 s after success)
each subsequent attempt duration        ~0.7 s (cache hit → 404)
```

---

## Root cause (proven)

`backend/src/runtime/reconciliation-engine.js:656-705` — `checkStaleDispatchLeases()`:

```javascript
const ageSeconds = (now - data.started_at) / 1000;
const ttl = dispatchEngine.LEASE_TTLS[stage];
const threshold = ttl * 0.9; // 90% of TTL
if (ageSeconds > threshold) { staleLeases.push({ type: 'stale_dispatch_lease', ... }) }
```

Three facts combine into the loop:

1. **Renewal never refreshes `metadata.started_at`.** `lease-manager.js
   renewLeaseIfOwner` extends the lease-key TTL only; metadata is written once at
   acquire time (`dispatch-engine.js:203,218`). So a healthy, continuously
   renewed dispatch becomes "stale" purely by wall-clock age.
2. **Threshold for video = 0.9 × 1800 s = 1620 s = 27 min**
   (`runtime-config.js:162-166`, `LEASE_TTL_S.VIDEO = 30*60`), while the backend
   itself dispatches video with `timeout_ms=3600000` (**60 min**, log: "using
   timeout=60 min from layer-config"). Any video job longer than 27 min — or any
   job waiting in the hub queue for an offline GPU — is guaranteed to be killed.
3. **The "fix" action re-arms the job.** `applyFix RELEASE_STALE_LEASE`
   (`reconciliation-engine.js:966-998`) deletes lease+metadata and calls
   `markDirtyScene` → scheduler re-dispatches on the next tick → hub enqueues a
   new copy (hub dedup key `animastor:job:{dispatch_id}:{job_id}` —
   `gpu-hub.js:283-285` — includes dispatch_id, so duplicates pass through).

Cycle period = 27 min threshold + ≤60 s reconcile granularity ≈ observed
**28 min** (13:30:08 → 13:58:08 → 14:26:09 → … → 03:02:37, 30 dispatches in the
14 h log window; oldest queue copy from Aug 26 12:55 proves the loop predates
the current backend container).

The same 0.9×TTL age heuristic is latently duplicated in
`dispatch-engine.js:410-412` (`shouldSkipDispatch`).

**Exact trigger of the post-success flood:** hub handing out queued copy #2 at
03:13:25.59, 0.14 s after FINALIZE_SUCCESS. The flood is self-limiting and
harmless to state: `/gpu/task/error` returns **HTTP 200 `{ok:true,
rejected:true}`** on `no_active_dispatch` (`generation-routes.cjs:1466-1468`),
so `failStage` is never called and no retry budget is consumed.

---

## Comparison with the old (2026-08-26) proven chain

| Old chain step | Verdict for the new incident |
|---|---|
| SCENE_RESET → video state left at NEW | **Different**: reset is full (`markDirtyScene` → all assets dirty), video = dirty, not new |
| dispatch sent anyway | **Partially**: dispatch from dirty was correctly **aborted** (fix); job sent only on the second attempt from pending |
| NEW→GENERATING rejected, rejection swallowed | **Old bug FIXED**: rejection is not swallowed — "aborting before any GPU job" (dc00075) observed in logs |
| GPU job dispatched anyway | Only legitimately (from pending) |
| GPU result arrived, file saved, merge completed | Yes, via the designed stale-accept path |
| handleVideoCompleted rejected result (`invalid_asset_state`) | **Old bug FIXED — not reproduced**: state was generating; result accepted → READY |
| success → FAILURE, retry budget burned | **Not reproduced**: FINALIZE_SUCCESS; no retry-budget key for this scene's video at all; circuit untouched (`animastor:circuit:video:last-failure` = 1787716350783 = Aug 26 03:52:30 — legacy of the old incident) |
| retry/re-dispatch loop | **Yes, but a different mechanism — NEW trigger**: duplicate-dispatch accumulation via false stale-lease, not a budget-burning failure loop |

**Overall verdict: the old bug is fixed and did not reproduce; this is a new
regression with a different retry trigger.**

---

## Status of the 2026-08-26 fixes in the current branch

| Fix | Present | Behavior in this incident |
|---|---|---|
| `ensureStageDispatchable` + NEW→PENDING before dispatch (dc00075) | Yes — `scene-orchestrator.js:57`, call sites :88/:236/:314 | Worked: dirty→generating rejected → abort before GPU job → pending → clean dispatch next tick |
| Abort on failed state transition (dc00075) | Yes | Worked (log: "state not dispatchable … aborting before any GPU job") |
| Completion failure taxonomy in `completeStage` (dc00075) | Yes — `orchestrator.js:213-218` | Not needed (handler returned ok) |
| `releaseHalfOpenPermit` on abort paths (50965e4) | Yes — `circuit-breaker.js:257`, `dispatch-engine.js:475` | Not needed (circuit never opened) |

None of the fixes were bypassed; `checkStaleDispatchLeases` was simply **not
covered** by them.

---

## Retry budget / circuit state

- Video retry budget for the scene: **zero consumption** (no
  `animastor:retry-budget:…:sc-5f0068ca:video` key exists).
- Nobody called `finalizeDispatch('failure')` for this scene in the incident
  window; all 85 errors were rejected at the identity gate before `failStage`.
- Circuit breaker video: CLOSED (only the legacy `last-failure` timestamp key).
- The success finalized durably: `dispatch-completed` marker, video-orch DONE,
  asset ready, scene out of the active index.

---

## What needs fixing (conceptual — no patch in this audit)

1. **Primary — `reconciliation-engine.js checkStaleDispatchLeases` (656-705).**
   Staleness must not be decided by `metadata.started_at` age while the lease
   is actively renewed. Options:
   - use the lease key's remaining TTL (renewal keeps it alive) instead of
     metadata age; or
   - refresh `started_at` / add `last_renewed_at` on renewal; or
   - threshold = max(0.9 × lease TTL, per-job `timeout_ms` from metadata).
   Unify with the same heuristic in `dispatch-engine.js:410-412`.
2. **Secondary — duplicate stock after success.** After FINALIZE_SUCCESS, purge
   remaining hub-queue copies of the same `job_id` (hub dedup is dispatch_id-
   scoped today), and/or forbid RELEASE_STALE_LEASE while video-orch phase ∈
   {WAITING_CHUNKS, MERGING}.
3. **Invariant to enforce:** per-job timeout (60 min) must be ≥ stale-lease
   threshold — currently violated (27 min < 60 min).

## Regression tests needed

1. `checkStaleDispatchLeases` does NOT flag a lease whose renewal is active
   (metadata age > 0.9×TTL but lease TTL alive).
2. A dispatch carrying `timeout_ms=60min` is never stale before its timeout.
3. `RELEASE_STALE_LEASE` is not applied while video-orch ∈ {WAITING_CHUNKS,
   MERGING}.
4. After `finalizeDispatch('success')`, duplicate `job_id` entries in the hub
   queue drain with zero side effects (no budget, no state change) — E2E around
   the existing `no_active_dispatch` rejection.
5. E2E: a long (≥28 min) generation on a live backend produces no re-dispatch.

---

## Evidence gaps (honest limit)

No direct access to the GPU instance. Missing artifacts that would confirm the
cache-hit mechanism directly (not required for the verdict — the ~0.7 s
turnaround vs 2.6 min real generation already proves it):

- worker-local journal/log lines (`waitResult`, `downloadResult`, cleanup
  journal CREATED→GENERATED→DELIVERED→CLEANED timestamps: pickup → copy →
  deletion);
- ComfyUI execution log (prompt_id and execution duration for each of the 86
  runs, seed/params comparison between run #1 and the duplicates).

Side observation: `animastor:queue:audio = 214`, `animastor:queue:image = 8`
at audit time — the same duplicate-accumulation pattern likely affects other
stages/scenes (e.g. `sc-5f18dd0f` audio-orch violations, `sc-45d38693` video
retry-budget key present).
