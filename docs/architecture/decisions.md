# Animastor — Architectural Decisions (confirmed by code)

> Decisions listed here are **already implemented** in the codebase and confirmed during Reconnaissance #1. Each entry names the code that proves it. New decisions will be appended as the Cathedral project progresses.

---

## D1. Per-asset Redis state is the single source of truth for the generation lifecycle

- **Decision:** One hash `animastor:asset-state:{book}:{ch}:{sc}` with `audio/image/video` values (`new|dirty|pending|generating|ready|failed|placeholder`); linear scene FSM removed.
- **Evidence:** `backend/src/state/scene-state.js` ("Per-asset states … are the ONLY source of truth. SceneState/linear state has been removed."); `orchestrator.js` "T8: syncLinearState удалён"; `asset-state.test.js` asserts the 7-value model.

## D2. All lifecycle state writes go through one facade (`orchestration/orchestrator.js`)

- **Decision:** READY/DIRTY/FAILED/PENDING/GENERATING/PLACEHOLDER are written only via facade commands; direct writes are `unsafe*` with an explicit caller whitelist (restore/recovery/debug only).
- **Evidence:** `state/scene-state.js` UNSAFE whitelist comment + `orchestrator.js` command contract; `reconciliation-engine` auto-fixes route through `orchestrator.markDirtyScene/setScenePending`.

## D3. Decision (when) is separated from mutation (what)

- **Decision:** `shouldScheduleAssets` is a pure read; the version-stale READY→DIRTY reset is an explicit pre-pass (`detectVersionStale` + `markVersionStaleDirty`) in `attemptDispatch`.
- **Evidence:** `runtime-scheduler.js` comments (Д.2) and function structure; state-writers map P3 in `audit.md` §4.

## D4. Redis is runtime transport, PostgreSQL is persistent truth, filesystem is artifact storage

- **Decision:** Three storage layers with distinct roles; no single "database" for everything.
- **Evidence:** `storage/index.js` header comment; PG survives restarts (versions, `is_dirty`, `scene_assets`), Redis is ephemeral coordination, FS holds immutable artifacts.

## D5. PG versions are the crash-surviving staleness anchor

- **Decision:** `scenes.content_version` / `audio_config_version` bumped on edit; `scene_assets` stores the versions it was built with; `READY` requires a version-gate (fail-closed). `is_dirty` + `dirty_unit_ids` persist across Redis loss.
- **Evidence:** `schema.js` R13/R14 migrations; `scene-assets-repo.js` (`bumpSceneVersions`, `getOutdatedByVersions`, `getDirtyScenesByVersion`); `orchestrator.js` version-gate (T1.11); `runtime-scheduler.detectVersionStale`.

## D6. Dispatch is protected by leases + quotas + idempotent finalization

- **Decision:** One active dispatch per scene:stage (NX lease, renewable); per-stage active quotas (Lua-atomic acquire); dispatch metadata with a token; finalization claims atomically (Lua) with an idempotency marker; callbacks verified against `dispatch_id`.
- **Evidence:** `dispatch-engine.js` (`acquireStageLease`, `ATOMIC_ACQUIRE_SCRIPT`, `CLAIM_FINALIZATION_SCRIPT`, `verifyDispatchIdentity`, `getDispatchCompletedKey`).

## D7. GPU Hub is a dumb transport; the backend owns scheduling and retries

- **Decision:** Hub does queues, dedup, timeouts, error forwarding — no requeue, no policy. Retries/circuit-breakers/retry-budgets live in `dispatch-engine`.
- **Evidence:** `gpu-hub/gpu-hub.js` (no requeue; "hub — тупой транспорт" comment); `dispatch-engine` retry budget + circuit breaker.

## D8. Layer-level state machines for chunked/merged generation

- **Decision:** Audio and video each have a Redis state machine (`animastor:audio-orch:*`, `animastor:video-orch:*`) with `WAITING_CHUNKS → MERGING → DONE`, late-chunk recovery (FAILED→WAITING_CHUNKS), and stalled watchdogs. Video keeps per-group files for granular dirty regeneration; player merge is separate.
- **Evidence:** `services/audio-orchestrator.js`, `services/video-orchestrator.js`, reconcile phases B1/B2/C1/C1b.

## D9. One unified reconciliation cycle

- **Decision:** All recovery (mailbox replay, watchdogs, startup recovery, orphan cleanup, auto-fix) runs as phases of a single `reconcileCycle` guarded by a distributed lock; the four historical mechanisms (startup-recovery, audio-recovery, cleanup-service, reconcileAll) were merged.
- **Evidence:** `reconciliation-engine.js` (T6 header, `reconcileCycle`, `CLEANUP_LOCK`); `runtime-loop.js` 60 s cycle; `backend.cjs` startup call.

## D10. Active scene index (Redis set) is the scheduler's work list

- **Decision:** Scenes are added on start/dirty, removed on completion/cancel; the scheduler only processes members of `animastor:active-scenes`. Tick is single-flight under a Redis lock.
- **Evidence:** `active-scenes-index.js`, `runtime-scheduler.tick` + `acquireSchedulerTickLock`.

## D11. Stale/late callbacks are rejected by dispatch identity (with a narrow exception)

- **Decision:** Results/errors must match the active dispatch; otherwise rejected + journaled. Exception: audio/video chunks are accepted while the scene is `WAITING_CHUNKS/MERGING` (batch reorder / late groups).
- **Evidence:** `task-handler.cjs` identity check + stale-accept; `orchestrator.js` T1 contract.

## D12. Graceful shutdown cancels active dispatches

- **Decision:** On SIGTERM/SIGINT: stop loop, cancel every active dispatch (releases lease+quota), close HTTP, close Redis/PG.
- **Evidence:** `backend.cjs` `gracefulShutdown`; `gpu-hub.js` SIGTERM handler.

## D13. Edit → diff → dirty → regenerate ritual is a single facade command

- **Decision:** `POST /regenerate` collapses to `orchestrator.resetScenes` (leases, hub queues, stale PNGs, iu-progress, markDirty, re-add to active index).
- **Evidence:** `routes/book/generation-routes.cjs` regenerate route → `orchestrator.resetScenes`.

## D14. Frontend keeps presentation state only; backend is authoritative

- **Decision:** The web app mirrors the Android architecture (stores = ViewModels); all lifecycle state comes from the backend via REST/SSE; frontend computes only UI-derivations (timer, panel rows) and persists only session/position locally.
- **Evidence:** `generateStore.ts`/`playbackStore.ts` module headers ("1:1 with Android"), API usage, no direct Redis/PG access.

---

*Last verified against code: August 2026 (Reconnaissance #1).*
