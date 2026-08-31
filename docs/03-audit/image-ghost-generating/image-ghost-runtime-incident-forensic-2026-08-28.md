# Forensic: Runtime Incident "Ghost Image Task 0/9" — 2026-08-28

Follow-up forensic investigation of a real runtime incident discovered after
deploying fix `226178f0` / `70e55fd3` (audit `6929ba5`).

## Symptoms

- Frontend: "Image workers: 0".
- Stuck task progress: "0/9".
- Task displayed after rebuild and backend restart.
- "Stop All" does not remove or complete the task.

## Task Identification

- book: `import_1786345731767_1786345734345`
- chapter: `ch-1bb5123c`
- scene: `sc-45c789c6`
- stage: **image**
- image units: 9 (`iu-0c92b6b9` … `iu-ec4410b8`, PG `image_units`)

## 1. Actual State (UI → DB → Redis → scheduler → dispatch → worker)

| Level | State |
|---|---|
| UI | "0/9", "Image workers: 0" — polls `/progress-panel` + `/worker/counts` |
| PG `generation_tasks` | **no image task** for sc-45c789c6 (only audio completed 25.08) |
| PG `image_units` | 9 units — denominator "9" |
| PG `scene_assets` | only audio ready; no image rows |
| PG `generation_cancellations` | tombstone from 2026-08-28 06:04:01 (Stop All) |
| Redis `asset-state` | **`image: generating`** ← ghost; `audio: ready` |
| Redis `active-scenes` | scene present |
| Redis queue / lease / dispatch-meta / iu-in-flight | **empty** (0 lease, 0 meta, 0 markers, 0 book entries in queues) |
| Scheduler | every tick `Active: 1, Skipped: 1` — dispatch impossible |
| Workers | 0 live heartbeats (no workers of any type) |

## 2. Why UI Shows "0/9"

`progress-panel` (`backend/src/routes/book/progress-panel.cjs:387-389`): no progress
tasks in Redis (Stop All cleared them via `generationProgress.clear`) → fallback `legacyTasks()`
(lines 339-382) **synthesizes** a task from `active-scenes` + asset-state `GENERATING` →
`countImage` (line 153) counts 9 units from PG `image_units`, 0 ready → "0/9".

Frontend is not at fault — it renders the backend response.

## 3. Why the Task Survived Backend Restart

The ghost-creating event was recorded in the scene event journal (3668 entries):

```
26.08 03:03:05.167  SCENE_GENERATING        (image, dispatch-1787713385164)
26.08 03:03:05.173  INVALID_STATE_CALLBACK  (image: generating→pending, ignored:true)
26.08 03:03:05.174  DISPATCH_CANCELLED      (reason=no_jobs_sent)
```

The old code rolled back `no_jobs_sent` via `setScenePending`; FSM blocked
`GENERATING→PENDING` (`backend/src/state/scene-state.js:54`,
`GENERATING → [ready, failed, dirty]`); the rejection was swallowed.

`asset-state` and `active-scenes` live in persistent Redis (`redis-data` volume) →
the state survived all restarts. Each restart `rebuildWorkList` re-added the scene
to the active index (`needsWork=true`: no image file on disk → PENDING target).

## 4. What Happens on "Stop All"

The click was recorded in logs: `2026-08-28 06:04:01 POST /cancel-generation → 200`.

Executed (`backend/src/routes/book/generation-routes.cjs:226-302`):

- cancel flag `animastor:generation:cancel:<bookId>` (no TTL);
- PG tombstone `generation_cancellations`;
- `clearBookFromActiveIndex`;
- `clearAllLeasesForBook`;
- PG `generation_tasks` cancelled (video row sc-5f0068ca);
- GPU hub queue cleared via HTTP.

**Not executed: per-asset state rollback.**

`clearAllLeasesForBook` (`backend/src/runtime/dispatch-engine.js:1295`) only
rolls back GENERATING via `cancelActiveDispatch` → `rollbackStageToPending` for
**found leases**. The ghost's lease expired long ago → nothing to roll back →
`image: generating` remained.

## 5. Where Cancellation Breaks — Three Independent Defects

### 5.1 Stop All Does Not Clean orphan-GENERATING

No sweep of book asset-states after lease cleanup: GENERATING without
a lease/meta/in-flight marker survives cancel-generation.

### 5.2 Reconciliation Resurrects the Cancelled Scene

Fix-action `REGENERATE_MISSING_ASSET`
(`backend/src/runtime/reconciliation-engine.js:1044-1052`) calls
`addSceneToActiveIndex` **without checking** either the cancel flag or PG tombstone —
unlike `rebuildWorkList`, which respects the tombstone (line 1936).

Log: immediately after cancel 06:04:01 → next 60s cycle →
`[SCHEDULER] + ACTIVE: …sc-45c789c6 added to active index`.

The resurrection trigger — false `orphan_audio_state`:
`checkOrphanAudioState` (line 146) uses **hardcoded `buildId='default'`**
and looks for the file in `/data/output/default/…`, while the file exists in
`/data/output/build_import_1786345731767_1786345734345/…` → false positive
every 60 seconds (3648 `INVALID_STATE_CALLBACK` audio ready→pending entries in journal).

### 5.3 Self-Heal Cannot Fix orphan-GENERATING

- rebuild-guard "do not touch GENERATING/PENDING" (line 2041) — correct for
  live dispatch but blocks orphan-state repair;
- `setScenePending` rejected by FSM for GENERATING;
- action `MOVE_TO_PENDING` for `stuck_state` (lines 901-907) **not implemented**
  in `executeFix` — falls into `default → unknown_action`.

## 6. Why Worker Count = 0

`/worker/counts` (`backend/src/routes/generation-routes.cjs:565`) counts live
heartbeats (`worker-health.getAvailability`, `scanFreshHeartbeats`). Redis has **no
heartbeat keys at all**: after gpu-hub restart no GPU worker
reconnected (0 audio / 0 image / 0 video; vbook=1 — AI API alive).
PG `workers` (5 rows) — registrations, not liveness.

**Scenario A: both the real ghost and the real absence of workers — both problems are genuine.**

## 7. Connection to Lifecycle 6929ba5 → 226178f0 → 70e55fd

This is **the same bug** from audit `6929ba5` (no_jobs_sent → setScenePending rejected →
swallowed → eternal GENERATING). Ghost created **26.08 — 2 days before the fix deployment**
(`226178f0` / `70e55fd3`, 28.08).

Fix closes creation of new ghosts in the dispatch cancel path
(`rollbackStageToPending`, GENERATING→DIRTY→PENDING), but this incident showed:

1. pre-fix ghost not fixed by any self-heal;
2. **new cancellation gap**: Stop All does not remove GENERATING without lease;
3. **new reconciliation gap**: fix-actions resurrect cancelled scenes despite tombstone.

Regression tests passed because they cover ghost creation, not
pre-fix ghost survival/resurrection.

## 8. Root Cause

Pre-fix `no_jobs_sent` ghost (26.08) + no repair path:

- Stop All only rolls back lease-backed GENERATING;
- reconciliation fix-actions resurrect the scene in active index, ignoring tombstone;
- no FSM-valid self-heal for orphan-GENERATING;
- false `orphan_audio_state` (hardcoded `buildId='default'`) serves as the resurrection trigger.

## 9. Minimal Fix Plan

1. **One-time ghost cleanup** (ops): `rollbackStageToPending(image)` for
   sc-45c789c6 (GENERATING→DIRTY→PENDING) + SREM from active-scenes; tombstone
   blocks regeneration until explicit user restart.
2. **cancel-generation**: after `clearAllLeasesForBook` — sweep book asset-state:
   each GENERATING without lease/dispatch-meta → `rollbackStageToPending`.
3. **Reconciliation**:
   - fix-actions check tombstone/cancel flag before `addSceneToActiveIndex`;
   - detector "GENERATING without lease/meta" (orphan generating) → repair via
     `rollbackStageToPending`;
   - implement `MOVE_TO_PENDING` via `rollbackStageToPending`.
4. **checkOrphanAudioState / checkOrphanImageState**: use actual `build_id`
   from manifest instead of `'default'`.

## 10. Required Regression Tests

- Stop All during GENERATING without lease → state rolled back, scene does not resurrect,
  progress-panel empty after N reconcile cycles;
- reconcile fix-action does not call `addSceneToActiveIndex` for book with tombstone;
- orphan-GENERATING (no lease/meta/in-flight) detected and fixed via
  `rollbackStageToPending`, not `setScenePending`;
- orphan-audio/image-check without false-positive with actual build_id;
- end-to-end: ghost → restart → Stop All → reconcile ×3 → task does not return.

## Appendix: Key Evidence

- Scene event journal: `animastor:event-journal:import_1786345731767_1786345734345:ch-1bb5123c:sc-45c789c6`
  (3668 entries; ghost creation ts=1787713385167-174; 3648 audio / 3 image INVALID_STATE_CALLBACK).
- Asset state: `animastor:asset-state:…:sc-45c789c6` = `{audio: ready, image: generating}`.
- Stop All in logs: `2026-08-28T06:04:01.331Z [CANCEL-GENERATION] … → 200 (72ms)`.
- Resurrection: `[SCHEDULER] + ACTIVE: …sc-45c789c6 added to active index` in the next
  reconcile cycle after cancel.
- Scheduler ticks: `Active: 1, Dispatched: 0, Skipped: 1` continuously.
- `/worker/counts`: `{"audio":0,"image":0,"video":0,"vbook":1,"active_scenes":1}`.
