# Animastor — Technical Debt (confirmed)

> Only debt **confirmed by code** during Reconnaissance #1 is listed. Severity: Critical / High / Medium / Low (not inflated; ugliness ≠ risk).
> Source of truth for evidence: `audit.md`, `architecture-map.md` (this project), plus the code paths cited inline.

---

## 1. Dead schema (PostgreSQL) — **Medium**

Tables/columns created by `backend/src/storage/postgres/schema.js` but never written by any code:

| Item | Evidence | Fix |
|---|---|---|
| `asset_states` | 0 INSERT/UPDATE in repo; only in purge lists (`cache-routes.cjs`, `core-routes.cjs`) | drop table |
| `scenes.status` (+ CHECK) | 0 `UPDATE scenes SET status` | drop column + constraint |
| `workers` | 0 queries | drop table |
| `cache_entries`, `output_manifests`, `reconciliation_events`, `asset_dependencies`, `storyboard_elements`, `audio_layers` | schema + purge only | drop or explicitly re-purpose |

*Why it matters:* readers of the schema cannot tell live from dead state; a future migration or AI-coder may start "using" a table nobody maintains, creating a second status system.

## 2. Dead code module: `runtime-persistence.js` (840 LOC) — **Medium**

- Removed from `runtime/index.js` exports with comment "files preserved on disk".
- `initializeRuntime()`/`initiateRecovery()` have **zero production callers**.
- Dangerous trap: `initiateRecovery` does `redis.del('animastor:active-scenes')` (line 573) — if someone wires it naively, the scheduler's work list is wiped.

*Fix:* delete the file (or explicitly re-wire with a design doc).

## 3. Dead / test-only services — **Low**

- `services/scene-asset-registry.js` — PG registry wrapper required only by tests; production writes go through `scene-assets-repo`/SQL directly. Either wire it or delete it.
- `services/startup-recovery.js` — referenced by comments (reconcile C1/C1b origin, `recoverIuImagesFromDisk` in `reconciliation-engine.js:1786`), **not required anywhere in production** (verified: only comment mentions). Leftover from the pre-T6 split.

> Note: `audio-recovery.cjs` is **not** dead — it is still required by `debug-routes.cjs:23` (debug/manual recovery endpoint). Its *logic* was merged into `reconcileCycle` Phase A, but the file remains wired for debug. Do not delete without checking that debug route.

## 4. Redis fossils — **Low**

- `animastor:priority:queue` — only the dead `runtime-persistence` touches it.
- `animastor:scene-transition-lock` — in config + reconcile `LOCK_KEYS`, never set (FSM locks removed).
- `animastor:video-lock` — **mostly vestigial**: set only from the debug path (`debug-routes.cjs:343`); the main generation loop uses dispatch leases. `audio-scene-lock`/`audio-merge-lock` are still set in `audio/generation.js` and `audio/pipeline.js` — keep those.

## 5. Backend dependency cycles (lazy-require mitigated) — **Medium**

`dispatch-engine ⇄ orchestration ⇄ runtime-scheduler` cross each other via function-body `require()`. Safe at load time (verified), but the design coupling remains; the facade's header comments explicitly defer "развязка интерфейсом".

## 6. God-modules with real boundaries — **Medium**

- `frontends/app/src/state/generateStore.ts` (1147 LOC): file/import screen + generate screen + session persistence + nav-icon state in one store. Split candidates are real.
- `backend/src/routes/generation-routes.cjs` (1284 LOC): public book API + internal GPU callback API + SSE + worker status. Consider splitting the internal callback surface.
- `backend/src/runtime/reconciliation-engine.js` (1844 LOC): whole recovery subsystem. Cohesive; only split if watchdogs / mailbox replay / auto-fix evolve independently.
- `backend/src/runtime/dispatch-engine.js` (1368 LOC): leases/quota/dispatch/finalize/cancel/metrics. Lease concerns already extracted to `lease-manager`; further splits optional.

*Note:* do **not** split `playbackStore.ts` (1261) or `EditPage.tsx` (2148) for size alone — they are cohesive subsystems.

## 7. Two event journals — **Low**

Redis `event-journal.js` (scene lifecycle, 7 d TTL) vs PG `book_events` (`book-event-log`, persistent). Both live and written; overlapping purpose, different consumers. Not harmful today; keep or consolidate deliberately.

## 8. Two "asset registry" modules — **Low**

`storage/asset-registry.js` (Redis) vs `services/scene-asset-registry.js` (PG). Distinct now (C3 fix), names still confuse.

## 9. Frontend hard-coded Android parity constants — **Low**

`SUCCESS_PULSE_MS`/`SUCCESS_HOLD_MS` (12 s/10 s), `COMPLETED_TASK_DISPLAY_MS` (10 s), `STALE_DONE_TOLERANCE_MS` (3 s) mirror Android animator/OkHttp constants exactly (documented 1:1 parity). Couples web behavior to Android implementation details; a deliberate port choice.

## 10. `resetScenes` multi-step ritual in the facade — **Low**

`orchestrator.resetScenes` (10 steps: force-flag, journal, active-index, leases, hub queues, PNG deletes, iu-progress, markDirty, re-add, journal) is the widest function in the facade. Cohesive but worth extracting helpers if it grows further.

## 11. Startup clears all dispatch leases — **Low**

`backend.cjs` deletes every `animastor:dispatch-lease:*` on boot. Correct for orphans, but any genuinely in-flight GPU job's callback is then rejected as stale (audio/video stale-accept mitigates). Acceptable trade-off; document.

## 12. Docs-vs-code drift — **Low**

`docs/03-audit/ARCHITECTURAL_DEBT.md` is stale on: book-routes god-module (routes were split), dual state model §16 (`syncLinearState` removed), orchestrator size (173-line note predates current 665-LOC facade). `docs/01-overview/ARCHITECTURE.md` should be checked for `scenes.status` claims. Refresh as part of this project.

---

## Priority order (per Cathedral rules: data loss > state races > reliability > coupling)

1. **Dead schema cleanup** (§1) + **dead `runtime-persistence`** (§2) — lowest risk, removes traps.
2. **Redis `active-scenes` durability review** (§14/R2 in audit.md) — the only genuinely dangerous gap (generation stall on Redis loss).
3. **Callback API isolation/auth** (§14/R6).
4. **Facade-routing of recovery state writes** (§14/R3).
5. **Frontend store split** (§6) — maintainability.
