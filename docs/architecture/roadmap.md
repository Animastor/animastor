# Animastor — Architecture Roadmap (directions only)

> **Status: planning only.** Nothing here has been started. Each candidate is a *direction* for the next Cathedral operations; the first operation should be chosen after the user reviews the reconnaissance results. Rule: one small, behavior-preserving step at a time; never refactor a working system blindly.

---

## Directions (unordered, with rationale)

### A. Clean the confirmed fossils (lowest risk, highest clarity value)
- Drop never-written PG tables/columns (`asset_states`, `scenes.status`, `workers`, `cache_entries`, `output_manifests`, `reconciliation_events`, `asset_dependencies`, `storyboard_elements`, `audio_layers`).
- Delete dead `runtime-persistence.js` (840 LOC) — its naive wiring would wipe `animastor:active-scenes`.
- Remove Redis fossils (`animastor:priority:queue`, `scene-transition-lock` from LOCK_KEYS).
- *Rationale:* removes traps for future AI-coders and halves the mental model of the schema.

### B. Redis `active-scenes` durability (the only genuinely dangerous gap)
- Investigate Redis persistence settings (AOF/RDB) in `docker-compose.yml` and volumes.
- Optionally rebuild the active-scenes set from PG (`scenes` versions + `is_dirty` + `scene_assets` stale) on startup if empty.
- *Rationale:* if Redis loses the set, generation stalls until reconcile re-adds scenes; PG already holds enough to rebuild it deterministically.

### C. Facade-consistent recovery writes
- Route the direct `unsafeRestoreAssetState` calls in `recoverAudioOrchStates`/`recoverVideoOrchStates` through `orchestrator.markDirtyScene`/`failStage` so every state write has one owner + journal event.
- *Rationale:* audit.md §14 R3 — small, closes the only "recovery writes outside the facade" gap.

### D. Internal callback API isolation
- Move `/gpu/task/result` + `/gpu/task/error` into a dedicated router (separate from the public book API in `generation-routes.cjs`), optionally behind the hub API key on the backend side.
- *Rationale:* audit.md §14 R6; the GPU callback surface is machine-to-machine, not client-facing.

### E. Frontend store split
- Split `generateStore.ts` along real boundaries: (1) file/import flow, (2) generate screen + progress, (3) session persistence + nav icon.
- *Rationale:* 1147 LOC with three responsibilities; real boundaries exist (they were separate Fragments/ViewModels in Android).

### F. Unwind the lazy-require dependency cycles
- Introduce an interface seam so `dispatch-engine` and `runtime-scheduler` do not `require('../orchestration')` at runtime (e.g. callback injection via deps, as already done for `bookDiff`).
- *Rationale:* removes the acknowledged "Step 0 compromise" cycle without changing behavior.

### G. Doc refresh
- Update stale `docs/03-audit/ARCHITECTURAL_DEBT.md` (routes split, dual-state §16) and any `scenes.status` claims in `docs/01-overview/`.
- Keep `docs/architecture/*` as the canonical map going forward.

### H. Select one real architecture operation (after user review)
- Candidate: **D** (callback API isolation) or **C** (facade-consistent recovery writes) — both small, behavior-preserving, and testable with the existing suite (~1000 mocha tests).
- Candidate: **B** (active-scenes rebuild) — higher value, needs design for scope/safety.

---

## Explicitly NOT planned
- Rewriting the orchestration core.
- Merging the three status representations into one.
- Replacing Redis/PG/FS storage layers.
- Any change that alters generation behavior without a bug report or a user-approved operation.

---

*Next step: user reviews `architecture-map.md`/`audit.md` against the real repo, then picks the first operation.*
