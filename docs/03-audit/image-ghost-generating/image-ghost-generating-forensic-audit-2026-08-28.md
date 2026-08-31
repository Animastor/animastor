# Forensic: Image Worker «0/9» — orphaned `image=generating` state (no_jobs_sent)

Investigation date: 2026-08-28
Book: `import_1786345731767_1786345734345`
Scene: `ch-1bb5123c / sc-45c789c6`, stage=`image`

## Symptom in Production UI

- "Image workers: 0"
- task shows "0/9"
- progress "0%"
- time "00:00:00"
- generation block looks like an active/incomplete task

## Verdict

**Orphaned/ghost image state. There is NO real executing task — but this is not a UI glitch.**
The UI honestly reflects the zombie asset state in the backend: the task row is synthesized
by the legacyTasks()-fallback in progress-panel from the active-scenes index + asset state `image=generating`.

## Source of Each UI Value

| UI | Source | Reality |
|---|---|---|
| "Image workers: 0" | `/worker/counts` → `image:0 + private_image:0` (`frontends/app/src/pages/GeneratePage.tsx:177,350`) | Actually 0 registered image workers (no heartbeat), not stale |
| "0/9" | progress-panel: `total=9` = 9 `image_units` rows in PG for `sc-45c789c6` (created 2026-08-13 14:35:40 UTC); `ready=0` — no `animastor:iu-progress:*` counter and no `dirty_unit_ids` (`backend/src/routes/book/iu-progress-utils.cjs:26-39`) | Actually 9 IU, 0 ready |
| "0%" | `round(0*100/9)` (`backend/src/routes/book/progress-panel.cjs:298-300`) | Consequence of 0/9 |
| "00:00:00" | `started_at: null` on synthesized task + no client session → `timerStartedAt<=0` → elapsed frozen at 0 (`frontends/app/src/state/generateStore.ts:457-459`) | Task never started in this session |

Why the task is displayed: `generationProgress.listTasks()` returned 0 real tasks →
progress-panel uses `legacyTasks()` (`progress-panel.cjs:339-382`): any active scene
with asset state PENDING/GENERATING synthesizes a row with `task_id: null`, `started_at: null`,
`visible: true`, `done: false`.

## Facts from Runtime (Redis / PG / journal)

- PG `generation_tasks`: no rows for image of this scene (only audio 2026-08-25, completed).
- Lease: none. Dispatch metadata: none. Worker: none. Retry: none. Stale lease: none
  (no `animastor:dispatch-lease:*` keys exist at all).
- Redis `animastor:queue:image`: 8 orphan jobs from OTHER books; no jobs for this book.
- `animastor:iu-in-flight:*`: empty (TTL 1200s expired long ago).
- Asset state hash for scene: `audio=ready, image=generating` (video absent → NEW).
- Scene present in `animastor:active-scenes`; scheduler every tick:
  `Active: 1, Dispatched: 0, Skipped: 1` (no_dispatchable_stages).
- Second identical ghost: `ch-1bb5123c/sc-5f18dd0f` — `image=generating`, same
  `no_jobs_sent` from 2026-08-19 03:55:27 UTC (dispatch `dispatch-1787060532026-orv4uo2o`);
  not visible in UI because not in active-index.
- Additionally: 214 orphan audio-jobs and 8 image-jobs from old books in queues — separate debris.

## Breakage Timeline (scene event-journal, 2026-08-26 UTC)

1. `03:02:55.054` — DISPATCH_STARTED image, `dispatch-1787713375053-7e0e0124a551002a31a8f3158febcee3`.
   `03:02:55.056` — `INVALID_STATE_CALLBACK: image new→generating rejected` — race condition:
   concurrent scene reset (non-atomic `RESET_SCENE_LUA`, see below) in the DEL→HSET window
   gave the reader all states as NEW. Dispatch #1 aborted.
2. `03:03:00.148` — DISPATCH_CANCELLED #1, reason `force_reset`
   (per-book flag `animastor:force-dispatch:{bookId}`, TTL 120s, set by regen of another scene in the book).
3. `03:03:00.149` — DISPATCH_STARTED #2 `dispatch-1787713380147-4fb466dbc506ed58d593f0d4cabbe278`
   → `03:03:00.155` SCENE_PENDING (image) → `03:03:00.156` DISPATCH_CANCELLED: **`no_jobs_sent`**.
4. `03:03:05.166` — DISPATCH_STARTED #3 `dispatch-1787713385164-b314294528bb7d5ff5ba8879f62ad3a9`
   → `03:03:05.167` IMAGE_DISPATCHED + **SCENE_GENERATING (image→generating)**
   → `03:03:05.173` `INVALID_STATE_CALLBACK: generating→pending rejected`
   → `03:03:05.174` DISPATCH_CANCELLED: **`no_jobs_sent`**.
5. After this — no dispatch attempts. The `generating` state frozen forever.

## Where the Chain Broke

`UI task created → backend queue → dispatch → [BREAK] → generation → result → completion`

The break is between **dispatch** and **generation**: the last dispatch transitioned state to GENERATING,
but sent zero GPU jobs, and on cancellation could not roll the state back.

## Root Cause (Mechanism)

1. **`no_jobs_sent`:** in dispatch #3 all 9 IU were skipped via fast-path in 7 ms
   (network failure excluded — `gpu.send` has 30s timeout × 3 retry): the `animastor:iu-in-flight:*`
   markers from the aborted dispatch #1 were still active. Markers are set BEFORE
   `gpu.send` (`backend/src/image/iu-processor.js:190`) and are NOT cleared in
   `cancelActiveDispatch` or `finalizeDispatch` (`backend/src/runtime/dispatch-engine.js`).
2. **State rollback failure:** `no_jobs_sent` → `finalizeDispatch(cancelled)` correctly removed
   lease/quota, but state rollback is broken: `backend/src/orchestration/scene-orchestrator.js:528`
   calls `setScenePending`, but the **generating→pending transition is forbidden by FSM**
   (`backend/src/state/scene-state.js:50-58`) → rejection swallowed → state remains GENERATING.
3. **Eternal skip:** scheduler treats GENERATING = "someone is working" →
   `no_dispatchable_stages` → skip every tick (`backend/src/runtime/runtime-scheduler.js:328-333,552-556`).
4. **No recovery mechanism:** `checkStaleDispatchLeases`/`shouldSkipDispatch` only work
   when a lease exists — here there is none. Stall-failsafe exists ONLY for audio and video
   (`checkStalledAudioScenes`/`checkStalledVideoScenes`, `backend/src/runtime/reconciliation-engine.js:287/388`).
   No equivalent for image. Reconciliation only re-adds the scene to the active-index (every 60s),
   but cannot dispatch it.

### Contributing Defects

- **Non-atomic `RESET_SCENE_LUA`** (`backend/src/services/book-diff.cjs:307-310`):
  `DEL` asset-state hash + step-by-step `HSET` — a concurrent reader in this window sees
  all states as NEW (recorded in dispatch #1 journal).
- **Per-book force-flag:** regen of one scene sets `animastor:force-dispatch:{bookId}`
  (TTL 120s), which the scheduler applies to ALL scenes in the book — force-reset of other
  active dispatches becomes possible.

## Connection to Recent Lease Fix (37e21c22 / 487bc4a0)

**Not connected — proven:**

- The hang occurred 2026-08-26 03:03 UTC; fix deployed 2026-08-28 04:19+ UTC.
- Fix only changes liveness detection WITH EXISTING lease (TTL instead of `started_at`).
  Here there is no lease at all — neither `checkStaleDispatchLeases` nor `shouldSkipDispatch`
  ever trigger for this state.
- Indirectly the fix confirms the gap: it documents that "hung jobs are caught by
  stall-failsafe" — but for image stage this failsafe is absent. This is the hole.

## What Needs to Be Fixed

1. **`no_jobs_sent` rollback:** on dispatch cancellation after setting GENERATING, roll back
   state via FSM-valid path `generating→dirty→pending` (currently direct `setScenePending`
   is silently rejected by FSM).
2. **Image stall-failsafe** in reconciliation: `image=generating` without lease/metadata/queue-job
   older than threshold → reset to dirty + re-dispatch (analog of checkStalledAudio/VideoScenes).
3. **Clear `animastor:iu-in-flight:*`** on `finalizeDispatch(cancelled)` / force-reset —
   otherwise re-dispatch after any abort guaranteed hits `no_jobs_sent`.
4. **Atomicity of `RESET_SCENE_LUA`:** eliminate the DEL→HSET window (e.g., HSET all fields +
   HDEL extras, or write to temp key + RENAME).
5. **Standard resolution of current ghost:** re-run "Generate Images" for this scene via UI —
   `resetScenes` → Lua `transitionToPending` explicitly handles `generating→pending`
   (`book-diff.cjs:291-301`) and re-dispatches. Safe.
6. (hygiene) Clean orphan queues: 214 audio-jobs + 8 image-jobs from old books.

## Tests / runtime verification

- API response matched UI 1:1: `progress-panel` returned exactly
  `{task_id:null, type:image, scope:whole_book, total:9, ready:0, percent:0, started_at:null, visible:true, done:false}`,
  `worker/counts` → `image:0, private_image:0, active_image:0` — UI is not lying.
- Live observation: every scheduler tick `Active: 1, Dispatched: 0, Skipped: 1` —
  scene actively skipped, no dispatch occurring, no lease created.
- Full lifecycle test (0/2 → generation → 1/2 → 2/2 → completed) impossible at time of
  investigation: 0 image workers in the system (no heartbeat) — any test generation
  would queue as dead weight and reproduce the same symptom. Plan: connect image worker →
  clear ghost via standard regen → run 1–2 IU.
