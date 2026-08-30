# TODO: Orchestration System — Consolidated Status

> **Date:** 19 July 2026
> **Basis:** `docs/02-orchestration/ORCHESTRATION.md`
> All historical TODOs consolidated into a single list. Completed tasks: ✅,
> incomplete/deferred: 🔴.

---

## ✅ T0–T10: Core Stabilization — ALL COMPLETE

| Phase | Status | Result |
|-------|--------|--------|
| T0: Worker + syntax-smoke | ✅ | `worker.cjs` passes `node --check`. `pretest` checks all JS/CJS. Worker version in beacon. |
| T1: Callback result contract | ✅ | `completeStage` checks `handler.ok`. Mandatory return format `{ ok, retryable, reason, artifact }`. |
| T2: Single finalization path | ✅ | `failStage` → `finalizeDispatch('failure')` with `recordFailure` + `consumeRetryBudget`. NOT recordSuccess. |
| T3: Honest executor | ✅ | `execute*Dispatch` returns `{ dispatched, jobs, reason }`. Lease/quota freed on `dispatched:false`. |
| T4: dispatchId + stale callback | ✅ | `verifyDispatchIdentity` in every callback. `dispatch_id` end-to-end. |
| T5: Force reset + quota ownership | ✅ | `resetScenes` frees only resources of reset scenes. |
| T6: Lease renewal | ✅ | Starts after `dispatched:true`. Stops in `finalizeDispatch`. |
| T7: Non-overlapping runtime loop | ✅ | Tick (5s) without reconcile. Reconcile (60s) with distributed lock. |
| T8: Single asset state owner | ✅ | Facade `orchestrator.js` — sole writer. `unsafe*` methods for restore/debug. |
| T9: GPU Hub contract + auth | ✅ | `x-api-key` passed to all callers. `GPU_HUB_API_KEY` env. Version in heartbeat. |
| T10: Worker verification | ✅ | Syntax-smoke passes. Version logged on startup.

---

## ✅ S1: Dead-Code Resilience — COMPLETE

| Sub-phase | Status | Commit | Effect |
|-----------|--------|--------|--------|
| S1.1: Remove `fairness-engine.js` | ✅ | `45b2485` | −618 lines |
| S1.2: Trim `failure-taxonomy.js` + remove `retry-manager.js` | ✅ | `d4444cb` | −736 lines |
| S1.3: Trim `retry-budget-manager.js` | ✅ | `dba7298` | −296 lines |
| S1.4: Remove Phase C3 | ✅ | `10ecf33` | −32 lines |

> **S1 Total:** −1682 lines (plan −580). **Over-delivered.**
> Note: C4/C5 not removed — they are alive (PG deps and resumeIncompleteSessions passed from `backend.cjs`).
> `retry-budget` not fully removed — `consumeRetryBudget` is embedded in production finalization.

---

## ✅ S2: Restore/Debug State Writes — COMPLETE

| Sub-phase | Status |
|-----------|--------|
| S2.1: Rename `setAssetState` → `unsafeRestoreAssetState` | ✅ |
| S2.2: Isolate writes within facade | ✅ (simplified — no `_writeAssetState`, just facade) |
| S2.3: Migrate restore/debug callers to `unsafe*` | ✅ (7 files, 11 calls) |
| S2.4: JSDoc whitelist | ✅ |

---

## ✅ S3: Production-Readiness — COMPLETE

| Sub-phase | Status |
|-----------|--------|
| S3.1: Graceful shutdown (SIGTERM/SIGINT) in `backend.cjs` | ✅ |
| S3.2: `/health` endpoint (200/503, loop + redis ping) | ✅ |
| S3.3: `/readiness` (optional) | ⚠️ skipped (sufficient `/health`) |
| S3.4: `GPU_TIMEOUT` env config | ✅ (`.env.example`, docker-compose) |
| S3.5: `GPU_HUB_API_KEY` for prod | ✅ (deployment-only — secret not committed) |

---

## ✅ S4: Test Mocks — COMPLETE

| Sub-phase | Status |
|-----------|--------|
| S4.1: Mock audioOrch (initPlaceholderReady etc.) | ✅ zero warnings |
| S4.2: Clean empty test files | ✅ |

---

## ✅ M5: Single Facade — ALL STEPS COMPLETE

| Step | Status | Risk |
|------|--------|------|
| Step 1: `completeStage` — single READY | ✅ | Low |
| Step 2: `scene-window` → facade | ✅ | Medium |
| Step 3: `syncLinearState` — facade side-effect | ✅ | Medium |
| Step 4: Reconciliation → audit-only (via facade) | ✅ | Low |
| Step 5: Version gate on READY | ✅ | Medium (graceful fallback) |

---

## ✅ Regeneration System — ALL TASKS COMPLETE

| Task | Status |
|------|--------|
| R0: Audio→Video dependency fix | ✅ |
| R1: SceneText diff | ✅ |
| R2: Character→Scene Index | ✅ |
| R3: Location→Scene Index | ✅ |
| R4: Voice-only dirty (video NOT dirty) | ✅ |
| R5: Unify book-sync / book-diff | ✅ |
| R6: Prompt Dependency Registry | ✅ |
| R7: Lua transactions markDirtyScenes | ✅ |
| R8: Lock on /regenerate | ✅ |
| R9: FSM-reset instead of force redis.set | ✅ |
| R10: Placeholder ≠ valid content | ✅ |
| R11: Unit tests (295+ tests) | ✅ |
| R12: Book-sync after PUT | ✅ |
| R13: PG schema (content_version, audio_config_version) | ✅ |
| R14: Dual mode (versions + flags) | ✅ |
| R15: Versions as source of truth | ✅ |
| R16: Cross-cutting via versions | ✅ |
| R17: Redis persistence / startup recovery | ✅ |
| R18: Callback chain repair | ✅ |
| R19: Frontend audio cache invalidation | ✅ |

> **Bugfixes (per-unit regeneration):** Worker toggle fix, `ensureSceneRow`, GPU hub dedup key cleanup, in-flight tracking, progress display — all complete.

---

## 🔴 Phases 2–11: Convergence (audio-orch via facade) — INCOMPLETE

| Phase | Priority | Status | Description |
|-------|----------|--------|-------------|
| 1: DONE guard in facade | HIGH | 🟡 **Partial** | Guard exists in `scene-orchestrator.js` but not moved to `orchestrator.setSceneGenerating()` |
| 2: completeStage syncs audio-orch | HIGH | ✅ **Done** | `completeChunk` → `completeStage` → asset READY + audio-orch DONE synchronous |
| 3: failStage syncs audio-orch | HIGH | ✅ **Done** | `failStage` → asset FAILED + audio-orch FAILED |
| 4: markDirtyScene cleans audio-orch | HIGH | ✅ **Done** | DONE → deleteState |
| 5: setScenePending cleans audio-orch | MED | 🔴 | DONE → deleteState (needs test) |
| 6: setSceneAllReady sets DONE | LOW | 🔴 | Cache hit → audio-orch DONE (needs test) |
| 7: Reconciliation enforce invariants | MED | 🟡 **Partial** | checkStalledAudioScenes works. checkAudioOrchInvariants without auto-fix. |
| 8: task-handler via facade | MED | 🔴 | `audioOrch.completeChunk()` directly |
| 9: reconciliation via facade | LOW | 🔴 | `audioOrch.*()` directly in reconciliation-engine |
| 10: scene-orchestrator via facade | MED | 🟡 **Partial** | DONE guard exists, rest — via facade |
| 11: debug logs | LOW | 🟡 **Partial** | `/gpu/task/result` logs, `completeChunk`/`transitionState` — not all |

> **Summary:** Phases 1–4 (HIGH) mostly done. Phases 5–11 — MED/LOW priority TODOs.

---

## ✅ What NOT To Do (Agreed)

| Task | Verdict |
|------|---------|
| Kafka, RabbitMQ, BullMQ | 🔴 Do not add |
| Second state machine on top of asset FSM | 🔴 Do not introduce |
| Move lifecycle to PG in one PR | 🔴 Do not do |
| Rewrite audio/image/video pipeline | 🔴 Do not do |
| New reconciliation service | 🔴 Do not add |
| Expand facade beyond 13 commands | 🔴 Not needed |

---

## Final Definition of Done

| Criterion | Status |
|-----------|--------|
| All production JS passes `node --check` (syntax-smoke) | ✅ |
| `npm test` > 570 passing, zero warnings | ✅ (576 passing) |
| `completeStage` NEVER writes `READY` without `handler.ok` | ✅ |
| `failStage` NEVER writes `recordSuccess` | ✅ |
| `executor` NEVER `dispatched:true` without real job | ✅ |
| Renewal starts after `dispatched:true`, stops in `finalizeDispatch` | ✅ |
| Runtime-loop does NOT run full `reconcileAll` every 5s | ✅ |
| `active-scenes` — single API (`active-scenes-index.js`) | ✅ |
| Direct asset-state writes only through `unsafe*` restore-methods | ✅ |
| Graceful shutdown + `/health` | ✅ |
| `GPU_HUB_API_KEY` set in prod-.env | ⚠️ (deployment-only) |
| Audio-orch phases 5–11 full refactor | 🔴 (MED/LOW) |

<!-- === Footer === -->
---
*Consolidated TODO. All historical lists merged into one. 19 July 2026.*
