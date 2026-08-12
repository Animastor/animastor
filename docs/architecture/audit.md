# Animastor — Architecture Audit (Reconnaissance #1)

> **Cathedral Project — Architecture Deep Reconnaissance #1**
> Date: August 2026 · Scope: whole repository, code-first (docs only as a secondary source).
> Rule applied: *if documentation contradicts code, code wins*; *hypotheses not confirmed by code are explicitly rejected*.

---

## 1. Method

- Read ~25 core backend modules in full or in key sections (orchestration, runtime, storage, state, services, routes), `gpu-hub`, `worker`, and both web stores.
- Enumerated every Redis key prefix and every PG table, then searched for **writers** (INSERT/UPDATE/SET) vs readers.
- Used git history (last ~100 commits + targeted search) as an architectural source.
- Cross-checked the preliminary audit docs (`docs/03-audit/ARCHITECTURAL_DEBT.md`, `CATHEDRAL.md`).

---

## 2. Hypothesis verification (from the preliminary audit)

| # | Preliminary hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | `orchestrator.js` is a thin facade, not a god module | ✅ **CONFIRMED** | 665 LOC, thin delegation to `bookDiff`, `dispatch-engine`, `scene-callbacks`, `scene-assets-repo`, `reconciliation-engine`; comment "тонкий фасад" |
| H2 | `scene-orchestrator.js` is huge/god module | ⚠️ **OUTDATED** | Now 497 LOC of pure executors; heavy logic moved to `scene-callbacks.js`/`scene-restoration.js` (this matches the old debt doc's own update note) |
| H3 | Per-asset Redis state is the source of truth | ✅ **CONFIRMED** | `state/scene-state.js`: "Per-asset states (`animastor:asset-state:*`) are the ONLY source of truth. SceneState/linear state has been removed." |
| H4 | `asset_states` PG table is a live state store | ❌ **REJECTED** | Table is created in `schema.js` and only *purged* on book delete. **Zero INSERT/UPDATE** anywhere in the repo. |
| H5 | `scenes.status` is a live status | ❌ **REJECTED** | Constraint allows `pending/generating/ready/failed/dirty`, but the column is **never explicitly set**: inserts (`ensureSceneRow`, `book-sync.js`) omit it, so rows always carry only the DEFAULT `'pending'`; no code SELECTs it either. Vestigial. |
| H6 | There is a startup-recovery + audio-recovery + cleanup-service trio that conflicts | ⚠️ **MOSTLY RESOLVED** | All four (incl. `reconcileAll`) are merged into a single `reconcileCycle` (T6). `audio-recovery.cjs` logic lives in Phase A, but the file is **still required by `debug-routes.cjs:23`** (debug recovery endpoint); `cleanup-service.cjs` keeps only build/file ops. |
| H7 | `runtime-persistence` (snapshot recovery) is part of the active recovery path | ❌ **REJECTED** | `initializeRuntime()` has **no callers** in production; `runtime/index.js` explicitly lists `runtime-persistence` as REMOVED from exports ("files preserved on disk"). 840 LOC dead module. |
| H8 | Dual state model (linear FSM + per-asset) still exists | ✅ **CONFIRMED-as-cleaned** | `syncLinearState`/`deriveLinearState` were removed (comments "T8: syncLinearState удалён" in orchestrator). Debt doc §16 is stale on this point — doc-vs-code divergence. |
| H9 | Two event journals (Redis + PG) duplicate each other | ✅ **CONFIRMED** | `event-journal.js` (Redis, 7 d TTL, scene lifecycle) and `book-event-log` → PG `book_events` (persistent, book evolution) both exist and are both written; different consumers, overlapping purpose. |
| H10 | `scene-asset-registry` duplicates `asset-registry` | ⚠️ **RESOLVED (C3)** | Two registries still exist but are now clearly separated: Redis (`storage/asset-registry.js`) vs PG (`services/scene-asset-registry.js` → `scene-assets-repo`). Naming comment in asset-registry.js references the C3 fix. |
| H11 | `workers` PG table is the worker registry | ❌ **REJECTED** | **Zero** queries against it; worker state lives in Redis (`animastor:gpu-hub:workers`, `animastor:worker:heartbeat:*`). |
| H12 | Governance modules (policy-engine etc.) are loaded in the dispatch path | ❌ **REJECTED (already cleaned)** | `dispatch-engine.js` comment: "policyEngine, workloadClassifier, costEstimator … UNUSED (removed in Phase 6)"; only circuit-breaker + retry-budget are live. |

---

## 3. What was NOT found in the preliminary audit (new findings)

1. **`scenes.status` and `asset_states` are never-written fossils** (see H4/H5) — schema-level dead weight, purge-listed everywhere, misleading for future readers.
2. **`animastor:priority:queue` is a Redis fossil** — only the dead `runtime-persistence` reads/writes it; nothing enqueues.
3. **`scene-transition-lock` is a Redis fossil** — in config + reconcile LOCK_KEYS but never set (FSM locks were removed). `audio-scene-lock`/`audio-merge-lock` are still live; `video-lock` is set only from the debug path.
4. **Legacy cache-forecast tables** (`cache_entries`, `output_manifests`, `reconciliation_events`, `asset_dependencies`, `storyboard_elements`, `audio_layers`) — schema-only.
5. **`book-routes.cjs` no longer exists** — routes were split (`book/core-routes.cjs`, `book/import-routes.cjs`, `book/generation-routes.cjs`, `book/cache-routes.cjs`, `book/versions-routes.cjs`, …). The old debt doc entry "book-routes.cjs ~1800+ строк" is **stale**.
6. **Frontend duplicates backend orchestration logic** in a limited, deliberate way (progress panel math) — see §11.

---

## 4. Writer Maps (verified call sites)

### 4.1 Per-asset Redis state (`animastor:asset-state:*`)
Writers (all through `unsafeRestoreAssetState(s)`, whitelist enforced by comment + lint convention):
```
orchestrator.js  (facade: completeStage→READY, failStage→FAILED/PENDING,
                  markDirtyScene→DIRTY, setScene* → PENDING/GENERATING/READY/PLACEHOLDER,
                  resetScenes→via markDirty)
scene-restoration.js   (disk restore)
book-diff.cjs          (markDirtyScenes → PENDING via Lua+setAssetStates)
reconciliation-engine.js  (startup C1/C1b direct writes — whitelisted but NOT through facade,
                           Phase D auto-fix via facade)
debug-routes.cjs       (debug endpoints)
helpers/redis-helpers.cjs  (book-wide restore)
```
**One normal owner: the orchestrator facade.** Everything else is a client or a whitelisted recovery path.

### 4.2 `scene_assets.status` (PG)
> Note: `services/scene-asset-registry.js` (PG registry wrapper) is required only by tests (`scene-asset-registry.test.js`, `book-sync.test.js`); production writes go directly through `scene-assets-repo` / raw SQL (`book-sync.cjs`).
- `ready` — `completeStage` → `scene-assets-repo.markReady` (after version-gate). Only writer.
- `stale` — `markDirtyScene` (PG side-effect, graceful on failure) + `book-sync` (syncBook).
- `failed` — `services/scene-asset-registry.markFailed` → `scene-assets-repo.markFailed` — **but the service has no production callers** (only tests); in production `failed` is effectively never written.
- `placeholder` — `placeholder-audio` (`replacePlaceholderWithRealAudio` etc.).
- `pending` — `upsertAsset` default.

### 4.3 Audio state machine (`animastor:audio-orch:*`)
Owners: `executeAudioDispatch` (init/setGenerating/setWaitingChunks), `completeChunk` (WAITING_CHUNKS→MERGING→DONE, FAILED→WAITING_CHUNKS), `failWaitingScene` (→FAILED, watchdog/recovery), startup C1. Read by: scheduler executors, task-handler, reconcile, iu-processor. **Single logical owner per transition** (table of owners in the module header).

### 4.4 Video state machine (`animastor:video-orch:*`)
Owners: `executeVideoDispatch` (initState, markGroupDone cache-hit), `completeGroup` (per-group receipt → MERGING → merge-for-player → DONE), `failWaitingScene` (→FAILED). Read by: scheduler, task-handler, reconcile.

### 4.5 Generation task (PG `generation_tasks`)
Writers: `task-repo` (`createTask`, `updateTaskStatus` running/completed/cancelled, `cancelActiveTasksForBook`) called from `routes/book/generation-routes.cjs` (selective generation) and `runtime-scheduler.tick` (persist 'completed' after `generationProgress.reconcileCompletedTasks`).

### 4.6 Active scene index (`animastor:active-scenes`)
Writers: `active-scenes-index` API ← scheduler (`addSceneToActiveIndex`), scene-window `startScene`, orchestrator `resetScenes`, callbacks (`removeSceneFromActiveIndex` on video complete), cancel routes. **Owner: scheduler** (readers: scheduler tick only).

### 4.7 Worker state
Writers: **gpu-hub** (beacon → `animastor:gpu-hub:workers` + heartbeats; hub interval refreshes running-job heartbeats). Readers: backend `worker-health` (counts/status), hub (task/next validation). PG `workers` table unused.

### 4.8 Dirty state
Writers: `book-diff.computeBookDiff` → `markDirtyScenes` (Lua reset of chunks + per-asset PENDING + `bumpSceneVersions` → `is_dirty=TRUE`, `content_version`/`audio_config_version` bump), `orchestrator.markDirtyScene` (per-scene DIRTY + PG stale), `setDirtyUnitIds` (per-unit). Readers: scheduler (`detectVersionStale`, `getDirtyScenesByVersion`), executors (`getDirtyUnitIds`).

### 4.9 Leases
Writers: `dispatch-engine` (NX EX acquire, release, finalize Lua, force-clear, cancel), `lease-manager` (renewal). Readers: dispatch-engine, `task-handler` (`verifyDispatchIdentity`), reconcile.

### 4.10 Progress
Writers: `progress-pubsub.publishProgress` (Redis pub/sub, per-book channel) — called from callbacks, task-handler (IU), pipeline-runner/bootstrap; backend `generation-progress` (task state in Redis); `animastor:iu-progress:*` counters. Readers: SSE stream route (`/progress-stream`), `progress-panel` route, frontend poll.

---

## 5. Orchestration module verdicts

| Module | Responsibility (declared) | Actual | Deps | Consumers | Side effects | Verdict |
|---|---|---|---|---|---|---|
| `orchestrator.js` | Facade: single owner of lifecycle writes | Thin facade, exactly as declared; some fat in `resetScenes` (10-step ritual incl. FS deletes) | bookDiff, dispatch-engine, callbacks, state, scene-assets-repo (all lazy) | routes, executors, task-handler, watchdogs, reconcile | Redis state, PG scene_assets, FS (PNG deletes), hub queues | **Good** (resetScenes slightly too broad) |
| `scene-orchestrator.js` | Executors — dispatch execution only | Confirmed; video executor contains the most logic (grouping, cache-hit, timeouts) | state, audio/image/video, gpu, scheduler, orch machines, facade | dispatch-engine | Redis state (via facade), hub (sendUnified) | **Good** |
| `scene-callbacks.js` | Validate artifact + registries | Confirmed; also drives IU timing recalculation and window slide | state, storage, audio/image/video, iu-repo, placeholder-audio | orchestrator.completeStage, task-handler(legacy exports) | Redis registry/chunks, PG image_units, pub/sub, active-index | **Acceptable** |
| `dispatch-engine.js` | Single dispatch authority | Confirmed; also owns cancellation, quotas, finalization, hub cleanup | state, journal, lease-manager, circuit-breaker, retry-budget, counter-reconciliation | scheduler, task-handler, orchestrator, routes, reconcile | Redis (leases/meta/counters), hub (`/queue/clear`) | **Too broad (boundary: resilience concerns in one file)** — but every concern is a separate function; split candidates are already extracted (lease-manager) |
| `runtime-scheduler.js` | Decides WHEN, not HOW | Confirmed; tick is single-flight with lock | dispatch-engine, generation-progress, task-repo, active-scenes | runtime-loop | Redis counters/leases via dispatch, PG task status | **Good** |
| `runtime-loop.js` | Heartbeat | Confirmed; tick/reconcile separated (T7) | scheduler, reconciliation, metrics, counter-reconciliation, prometheus | backend.cjs | Redis metrics | **Good** |
| `reconciliation-engine.js` | Self-healing | Confirmed + more: it now *is* the whole recovery subsystem (mailbox replay, watchdogs, startup recovery, auto-fix) | state, storage, config, journal, scheduler, dispatch-engine | runtime-loop, backend.cjs (startup) | Redis state (facade/whitelisted), journal | **Too broad — but cohesive** (all recovery in one place is a deliberate trade-off; splitting is optional) |
| `audio-orchestrator.js` | Audio merge state machine | Confirmed; owns chunk completeness, empty-chunk cleanup, merge | audio, orchestrator, chunks | task-handler, executors, reconcile | Redis state, FS (chunk deletes), hub dedup keys | **Good** |
| `video-orchestrator.js` | Video group state machine | Confirmed; owns group cache-hit, merge-for-player | video-merge, orchestrator, dispatch-engine (meta) | task-handler, executors, reconcile | Redis state, FS, hub dedup keys | **Good** |
| `task-handler.cjs` | Callback routing + file write | Confirmed; identity check with deliberate stale-accept for audio/video chunks | audio/image/video, orchestrator, orch machines, iu-repo | `/gpu/task/result` route, reconcile Phase A | FS (artifact write), Redis (chunk meta, iu-progress), PG (iu read) | **Acceptable** |

---

## 6. God-module candidates (by size + responsibility count)

| File | LOC | Responsibilities | Verdict |
|---|---|---|---|
| `frontends/app/src/pages/EditPage.tsx` | 2148 | Editor UI | UI page, not architectural risk per se |
| `backend/src/runtime/reconciliation-engine.js` | 1844 | Whole recovery subsystem (5+ phases, watchdogs, auto-fix, invariant checks) | **Cohesive god-module**; splitting justifiable only along real boundaries (watchdogs vs mailbox replay vs auto-fix) |
| `backend/src/services/agent/pipeline-steps.js` | 1594 | All agent pipeline steps (structure, chars, locations, scenes, units, prompts, polish, repair) | Domain-pipeline god-module; boundaries exist per step type |
| `backend/src/runtime/dispatch-engine.js` | 1368 | Leases + quota + dispatch + finalize + cancel + metrics + hub cleanup | Too broad; extract candidates: cancellation (already partly in orchestrator.resetScenes), metrics |
| `backend/src/routes/generation-routes.cjs` | 1284 | ~15 endpoints incl. GPU callbacks, progress stream, worker status, queue clear | Route god-module (mixed public API + internal callback API + SSE) |
| `backend/src/services/agent/pipeline-runner.js` | 1232 | Pipeline orchestration + progress + repair | Cohesive |
| `backend/src/services/structure-detector.js` | 1231 | TXT structure detection | Cohesive |
| `frontends/app/src/state/playbackStore.ts` | 1261 | Whole player engine | Cohesive subsystem (split across Android files originally) |
| `frontends/app/src/state/generateStore.ts` | 1147 | File screen + Generate screen + nav icon + session + SSE | **Multiple responsibilities in one store** — a real frontend god-store; boundaries exist (file/import vs generate vs session) |
| `backend/src/runtime/scene-window.js` | 793 | Window init/slide + chunk restore + cancel handling | Cohesive |
| `backend/src/runtime/runtime-persistence.js` | 840 | **Dead** | Remove or wire (do not keep as tempting-but-unused recovery) |

**Recommendation rule:** do **not** split big files for size alone. Split candidates with real boundaries: `generateStore` (file vs generate vs session), `generation-routes` (public vs callback API), optionally reconcile watchdogs.

---

## 7. The three PostgreSQL entities — the 10 questions

Entities: `scenes.status`, `scene_assets.status`, `asset_states.status` (plus the Redis `asset-state` as the live counterpart).

1. **What does `scenes.status` mean?** — Intended: coarse scene lifecycle. Actual: **nothing** — the column is never explicitly set; inserts omit it so rows always carry only the DEFAULT `'pending'`, and nothing reads it.
2. **What does `asset_states.status` mean?** — Intended: per-layer PG state (clean/dirty/queued/generating/ready/failed). Actual: **nothing** — table is never INSERTed into.
3. **What does `scene_assets.status` mean?** — Persistent record of the asset *file* state: `ready` (file registered+validated), `stale` (content changed), `failed`, `placeholder` (TTS placeholder), `pending`, `missing`. It is the "path of truth for asset files + metadata" (schema comment).
4. **Can they contradict each other?** — `scenes.status`/`asset_states` can't contradict anything (never explicitly set / never inserted). `scene_assets.status` vs Redis asset-state **can and will diverge transiently** (two separate stores, no transaction): crash between `markReady` and Redis `READY` leaves PG=ready, Redis=generating. This is *tolerated by design*: scheduler trusts Redis, version-gate + reconcile heal the mirror. Documented code comments acknowledge it (e.g. `orchestrator.js` T5/T1.10).
5. **Who may change each value?** — `scene_assets.status`: only `scene-assets-repo` (markReady/markStale/markFailed/upsert) called from `completeStage`, `markDirtyScene`, book-sync, placeholder-audio. `scenes.status`/`asset_states`: nobody.
6. **Who decides READY?** — Redis: `orchestrator.completeStage` after handler `ok:true` **and** version-gate pass. PG mirror: `markReady` called only after the same gate (T1.10, fail-closed on PG errors).
7. **Who decides DIRTY?** — `book-diff.markDirtyScenes` (content diff) and `orchestrator.markDirtyScene` (recovery/version-stale); PG `is_dirty` set by `bumpSceneVersions`, cleared by `clearDirtyFlag` on video completion.
8. **Who decides FAILED?** — `orchestrator.failStage` (only owner; validates transition — a late error after READY is ignored and journaled). Mirror PG `failed` via `markFailed` (services/scene-asset-registry).
9. **How does synchronization work?** — There is **no transaction**; instead: (a) version-gate before PG write, (b) `detectVersionStale` (PG is authority on staleness), (c) `getDirtyScenesByVersion` (book-sync), (d) reconcile Phase D orphan/invariant checks, (e) `scene_assets` updated as a *side-effect* of facade operations (markReady after gate; markStale with graceful failure — "если PG недоступен — только warning").
10. **What happens after a crash between two writes?** — Either (a) Redis changed, PG not → next completion's version-gate still validates against PG versions; reconcile re-derives; (b) PG changed, Redis not → scheduler re-dispatches (duplicate GPU work) or `detectVersionStale` re-dirties; no data corruption in either case. The system is **eventually consistent with a bounded window**, not strictly consistent.

**Conclusion:** contradictions between the *live* layers are possible but architecturally acknowledged and healed; the *fossil* layers cannot contradict anything.

---

## 8. Redis vs PostgreSQL — one asset's lifecycle

Example transition `DIRTY → PENDING → GENERATING → (GPU) → READY` for one layer:

| Step | Initiator | Where written | Atomic? | Idempotency | On repeat | On crash | Reconcile role |
|---|---|---|---|---|---|---|---|
| DIRTY | `book-diff` / `markDirtyScene` / version-stale | Redis hash (per-asset) + PG `is_dirty`/versions + `scene_assets=stale` | HSET atomic; PG separate | N/A | Idempotent | Survives in PG (is_dirty, versions) | Phase D checks stale assets |
| PENDING | `markDirtyScenes` (Lua), `failStage`, `setScenePending`, scene-window | Redis hash | Lua (chunks reset) / HSET | yes | no-op | Re-derived from PG versions | — |
| GENERATING | executor via facade | Redis hash + orch machines | HSET/transition | transition-validated | rejected (`invalid_transition`) | Startup C1/C1b → FAILED or drive merge | C1/C1b |
| Dispatch | dispatch-engine | Redis lease NX EX + meta | NX | `dispatch-completed` marker | `DISPATCH_SKIPPED_DUPLICATE` | startup deletes leases → re-dispatch | stale-lease check |
| GPU job | hub | Redis queue/running/result | NX dedup | `animastor:job:*`, `result-processed` | duplicate ignored | result key left → Phase A replay | Phase A |
| Artifact | task-handler | FS file | single write | — | file overwritten | FS survives | orphan check (state≠file) |
| Callback | hub→backend | Redis result key → handler | dedup key | yes | deduped | Phase A replay | Phase A |
| READY | `completeStage` | Redis hash (after version-gate) + PG `markReady` | not transactional | dispatch identity + marker | rejected/stale | gate revalidates; reconcile invariants | audio/video invariant checks |

---

## 9. Cyclic dependencies

Backend (verified by code paths, all lazy `require()` in function bodies):
- `dispatch-engine.dispatchStage` → `require('../orchestration')` → `scene-orchestrator` → `require('../runtime/runtime-scheduler')` → `require('./dispatch-engine')` — **cycle**: dispatch-engine ⇄ orchestration ⇄ runtime-scheduler.
- `orchestrator.js` → (beginStage/completeStage/failStage) → `dispatch-engine`; `dispatch-engine` → (dispatchStage) → orchestration. Direct 2-cycle.
- `scene-callbacks` → `runtime-scheduler` (remove from active index) → `dispatch-engine` → orchestration. 
- `reconciliation-engine` → `runtime-scheduler` + `dispatch-engine` + orchestration (facade). One-direction into the cluster, no return.

**Risk assessment:** all cycles cross via **function-body lazy requires**, so module load order is safe (no load-time cycle crashes; verified: no circular-require errors in tests). Runtime cycle `scheduler → dispatch → orchestrator → scheduler` is real but bounded: `orchestrator.planScene` → `scheduler.shouldScheduleAssets` is pure read. Verdict: **harmless at load time, architectural smell at design time** — the facade's own header comment acknowledges it ("сознательный компромисс Шага 0 … развязка интерфейсом — отдельная задача").

Frontend: `generateStore ⇄ playbackStore` (generateStore imports `closeBook` from playbackStore for the runtime-only circular import — documented in the import comment; playbackStore imports `onPlaybackPrepared` from generateStore). One intentional cycle, documented, harmless (ESM import of functions used at runtime).

---

## 10. Generation lifecycle & recovery findings

- **Duplicate prevention is layered and effective:** hub enqueue NX + backend result dedup + dispatch lease + identity verification. The stale-accept exception for audio/video chunks (WAITING_CHUNKS/MERGING) is deliberate and well-commented (`task-handler.cjs`).
- **Stale callbacks:** rejected by `verifyDispatchIdentity`; terminally rejected results are *dropped* (key deleted) in Phase A to avoid 60 s retry loops (TERMINAL_REJECTIONS set).
- **Chunks/groups merging:** audio via `completeChunk` (min-chunk-size guard 100 B, empty-chunk delete + dedup clear); video via `completeGroup` with `mergeSceneVideoGroups` NX-lock race guard.
- **Cancellation:** per-worker (`/cancel-worker`), per-book (`/cancel-generation`), reset-scope (`resetScenes` clears only relevant stage leases — an Image regen does not kill a running Audio lease).
- **Crash recovery per step:** table in §8; key insight — PG versions + `is_dirty` are the crash-surviving anchor; Redis is rebuilt from disk (`recoverAllBooksFromDisk`) and mailboxes (Phase A).
- **Recovery vs normal execution:** reconciled writes go through the facade; atomic `finalizeDispatch` prevents double-finalization; residual race = startup C1/C1b direct `unsafeRestoreAssetState` writes vs scheduler (bounded, low harm).

---

## 11. Frontend

- **Backend-sourced state:** book JSON, layer-config, asset-state (`/assets-state`), worker counts, progress panel (server-computed task list), agent-status, VBook progress (SSE + poll), diff summary (`/regenerate` response).
- **Frontend-computed state:** timer, progress-panel row derivation (ready floors, 10 s done-window, stale-done gating, new-gen gate), nav-icon SUCCESS auto-reset (22 s), `phase`, dirty indicator persistence.
- **Frontend-only state:** `localStorage` book session (`animastor:currentBook`), `sessionStorage` playback position, Cache API media cache, blob URLs, module-scoped player internals.
- **Backend-state reconstruction attempts:** `computeProgressRows` re-derives per-task progress from server tasks + local floors (deliberate, matches Android parity); `checkVBookAgentStatus`/`pollVBookProgress` reconstruct VBook state from `/agent-status`. The **authority stays on the backend** — the store treats poll + SSE as advisory.
- **Hardcoded assumptions:** `timerStartedAt <= 0` session heuristic; `STALE_DONE_TOLERANCE_MS 3000`; `COMPLETED_TASK_DISPLAY_MS 10 s`; `SUCCESS_PULSE_MS/HOLD_MS` mirroring Android's exact animator timings (documented parity, but a coupling to Android constants).
- **Duplication of backend orchestration in frontend:** limited to presentation math (progress panel); no frontend writes to lifecycle state. The `generateStore` does duplicate *client* responsibilities (file screen + generate screen + session + nav icon in one module) — a split candidate.
- **playbackStore** (1261 LOC): the player engine — queue, preload-ahead 3, gapless dual audio (−200 ms switch), IU cycling via rAF, silent-timer mode for cover, soft refresh on generation completion, Cache API media caching, position save/restore. Mirrors Android `PlaybackViewModel`/`PlayFragment` 1:1; deviations documented in `docs/05-frontend/` §16. Contains the "fetchSceneData: status → audio/video/IU" mapping (READY/NOT_GENERATED/FAILED for IUs) — this is where frontend interprets backend asset availability.

---

## 12. Git history (architectural milestones)

The **orchestration stabilization era** is fully visible in history (the current architecture is its direct result):
- `a092f44` — Orchestrator facade (Шаг 0) + markDirty routed through it; `b9554e3→891e335` — M5 steps 1–5: completeStage owns READY → scene-window via facade → syncLinearState as facade side-effect → reconcile applyFix via facade → **version gate** in completeStage; `2807a38`/`5d5e1a3` — P4/P5/P6 and P2 direct `setAssetState` calls routed through the facade.
- `912dbe9` — linear FSM validation removed, per-asset states made sole source of truth; `18afacb` — raw setters renamed `unsafe*` (whitelist); `41f7ed3` — T8 state ownership + active-scenes consolidation.
- `cf1fb25→065dffd` — T1 unified timeout registry → T2 job_id contract (`job-schema`) + authoritative dedup → T3 honest executor results → T4 dispatch identity (protocol v2) → T5 force reset + quota ownership → T6 lease renewal + non-overlapping loop → T7 audio-orch completeChunk.
- `137e021` — failStage + worker→backend error channel; `90c1559` — resetScenes in facade; `bb675b2` — facade spread to top-level exports; `ed1c459` — "remove runtime require for orchestrator" (cycle mitigation); `968d1f6` — circular-dependency fix in /regenerate (restoreSceneChunkStatus).
- `50a686d`/`197f838`/`b7ad7fc` — audio-orch state machine → event-driven completeChunk → stalled-chunk watchdog (the "WAITING_CHUNKS before sending jobs" race class was systematically rebuilt).
- `8e70117` — per-worker timeouts; `d55b3d6` — graceful shutdown + /health; `00ab58d` — hub auth + protocol enforcement.

More recent history is dominated by **frontend/web/Android parity**, **TXT import hardening**, **AI prompt engineering** (prompt-dependency-registry, coreference, snake-id repair, video actions), and **infra** (nginx/domains/certs). Other structural signals:
- Version-gate + `is_dirty` + `dirty_unit_ids` were introduced as persistent staleness mechanisms after Redis-loss incidents (R4.1, R13/R14, R15).
- "Эволюционное пахтание" (Golden Books) concept introduced — quality baseline initiative.
- Dead code removal is systematic (D.3: 16 dead runtime modules + api/runtime.js; S1: fairness-engine, retry-manager; R6.4: policy cluster out of dispatch) — the current fossils are the *remaining* residue of this practice.

---

## 13. Architectural fossils (confirmed)

| Fossil | Type | Evidence | Recommendation |
|---|---|---|---|
| PG `asset_states` | schema | created, purged, never written | remove or repurpose |
| PG `scenes.status` | column | constraint exists, never explicitly set (DEFAULT `'pending'` only, no reads) | remove column + constraint |
| PG `workers` | table | never queried | remove |
| PG `cache_entries`, `output_manifests`, `reconciliation_events`, `asset_dependencies`, `storyboard_elements`, `audio_layers` | tables | schema + purge only | remove (or keep only if a feature is planned) |
| Redis `animastor:priority:queue` | key | only dead runtime-persistence touches it | remove with runtime-persistence |
| Redis `animastor:scene-transition-lock` | key | config + reconcile check only, never set | remove from LOCK_KEYS |
| `runtime-persistence.js` (840 LOC) | module | removed from runtime facade, no callers | delete or wire deliberately |
| `services/startup-recovery.js` | module | merged into reconcileCycle phase C; **not required anywhere** in production (comments only) | delete |
| `services/audio-recovery.cjs` | module | logic merged into Phase A, **but still required by `debug-routes.cjs:23`** | keep (debug), or fold into the debug route |
| Old debt-doc entries (book-routes god module, dual state model §16, "173-line orchestrator" note) | doc | code has moved on (routes split, syncLinearState removed) | refresh ARCHITECTURAL_DEBT.md |
| `scenes.status` semantic in docs/01-overview (ARCHITECTURE.md claims scenes.status is used) | doc-vs-code | code never writes it | update doc |

---

## 14. Risk assessment

| # | Problem | Evidence | Risk | Probability | Impact | Recommendation |
|---|---|---|---|---|---|---|
| R1 | Three status layers + fossils mislead new developers and future refactors | §7, §13 | **Medium** | High | Medium (no runtime harm, high confusion cost) | Clean fossils after freezing behavior; document the live two |
| R2 | Redis is the only scheduler work-list (`animastor:active-scenes`); Redis loss ⇒ stalled generation until reconcile rebuilds | runtime-scheduler, startup clears (in dead code path only) | **High** | Low–Medium (Redis is volume-persisted) | High (generation stalls) | Verify Redis persistence config; add active-index rebuild from PG on startup |
| R3 | `recoverAudioOrchStates`/`recoverVideoOrchStates` write `unsafeRestoreAssetState` directly, not via facade | reconciliation-engine C1/C1b | **Low** | Low | Low (transition-validated downstream) | Route through facade `markDirtyScene` for consistency |
| R4 | `runtime-persistence` dead module is a trap (would delete active-scenes if ever wired naively) | runtime-persistence.initiateRecovery line 573: `redis.del('animastor:active-scenes')` | **Medium** | Low | High | Delete the module |
| R5 | Frontend `generateStore` mixes 3 responsibilities (file/import, generate, session/nav) | §6, §11 | **Low** | n/a | Medium (maintainability) | Split along real boundaries |
| R6 | Callback API (`/gpu/task/result`, `/gpu/task/error`) co-located in public `generation-routes.cjs` with no auth | routes/generation-routes.cjs | **Medium** | n/a | Medium (hub-auth via network boundary; API key exists on hub side only) | Consider internal-only mounting or hub API-key on backend callbacks |
| R7 | Doc-vs-code drift (ARCHITECTURAL_DEBT.md, ARCHITECTURE.md scenes.status) | §12, §13 | **Low** | High | Low | Refresh docs as part of this project |
| R8 | `services/scene-asset-registry.js` (PG) and `storage/asset-registry.js` (Redis) both named "asset registry" | §2, H10 | **Low** | n/a | Low (clear comment exists) | Rename for clarity when touching |
| R9 | Audio/video stale-accept exception weakens dispatch identity | task-handler.cjs | **Low** | Low | Low (guarded by orch phase) | Keep; document |
| R10 | Version-gate fail-closed blocks READY on PG errors (scene never completes while PG down) | orchestrator.js T1.11 | **Medium** | Low | Medium (generation blocked while PG down) | Acceptable design; ensure PG is in health check |

Severity is deliberately not inflated: most items are **architectural ugliness** (R5, R7, R8, fossils) rather than **actual reliability risks** (only R2, R4, R6 approach real risk).

---

## 15. Confirmed strengths (see architecture-map.md §12)

Facade ownership, pure decision/mutation split, per-asset FSM with validation, Lua-atomic primitives, dispatch identity + idempotency, dumb-hub/smart-scheduler separation, audio/video orch state machines with late-chunk recovery, unified reconcileCycle with distributed lock, PG version-based staleness surviving Redis loss, graceful shutdown.

---

## 16. Definition of Done — answers

- **State / Source of truth:** generation lifecycle → Redis `animastor:asset-state:*` (written only via facade); staleness → PG `scenes` versions + `is_dirty`; files → FS + PG `scene_assets`; worker presence → Redis heartbeats; book content → FS JSON + PG registry.
- **Ownership:** one facade owns lifecycle writes; dispatch-engine owns leases/quotas/finalization; audio/video orch own merge state machines; scheduler owns progression; hub owns transport.
- **Generation:** §9.1 (audio/image/video all route through the same skeleton with per-layer state machines).
- **Recovery:** §10 (startup + 60 s cycles, mailboxes, watchdogs, disk rebuild, session resume).
- **Orchestration:** decisions are made by: scheduler (when), dispatch-engine (dispatch/finalize), facade (state transitions), callbacks+gate (READY), hub+watchdogs (failures).
- **Dependencies:** §11 of architecture-map.md; cycles are lazy-require-mitigated.
- **Risk:** §14 — the real risk points are R2/R4/R6.
- **Strengths:** §15.
