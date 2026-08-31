# Architectural Debt: Animastor

## ✅ Resolved Bugs (N.0–N.9, 2026-06-26)

The following bugs were closed as part of sprint N.0–N.9. Details in `docs/TODO_IMMEDIATE.md`.

| Code | Problem | Status | Commit |
|---|---|---|---|
| **C1** | Double quota release (markDispatchCompleted + callback) | ✅ | `4e007e2` |
| **C2** | PG `status='ready'` not written in callbacks | ✅ | `cf0a48a` |
| **C3** | Two registries with identical names | ✅ | `5182455` |
| **C4** | /gpu/task/result non-idempotent (double processing) | ✅ | `d804a77` |
| **M1** | Non-atomic RMW in per-asset state (GET+merge+SET) | ✅ | `1a0867d` |
| **M2** | Check-then-incr race in quota | ✅ | `636da04` |
| **M4** | Two limit systems (MAX_CONCURRENT + dispatch quotas) | ✅ | `0adc930` |
| **§5.1** | GENERATING not set in per-asset on dispatch | ✅ | `f0b81de` |

---

## 1. No Formal Connector Abstraction

**Problem:** The project has no formal interface or abstraction for connectors/adapters. Integration with GPU Hub, OpenRouter, PostgreSQL, Redis — direct calls via HTTP and SQL.

**Cause:** Evolutionary development. Initially created as a monolith without planning for external system replaceability.

**Potential Consequences:**
- Replacing OpenRouter with another AI provider requires changes in all services calling aiService
- Replacing ComfyUI with another GPU platform requires a new workflow engine
- No ability to A/B test different providers

**Affected Components:** ai-service.js, gpu-dispatcher.js, gpu-hub.js, worker.js, workflow-loader.js

---

## 2. No Abstract Generator Layer

**Problem:** Audio, Image, Video services have different interfaces and don't inherit a common base class. Impossible to add a new generation type without modifying orchestrator, dispatch-engine, scene-state.

**Cause:** Initially only audio generation existed; image and video added later as copies with modifications.

**Potential Consequences:**
- Each new generation type requires changes in 5+ files
- High probability of behavioral inconsistency between new and existing types
- Code duplication in dispatch-engine (audio/image/video sections)

**Affected Components:** scene-orchestrator.js, dispatch-engine.js, scene-state.js, runtime-scheduler.js, layer-config.js

---

## 3. Excessive Responsibility of book-routes.cjs

**Problem:** Single file contains ~1800+ lines and ~30+ REST endpoints. Mixes CRUD, import, AI pipeline, generation management, debugging.

**Cause:** Iteratively adding endpoints to existing file for simplicity.

**Potential Consequences:**
- Maintenance and testing complexity
- High probability of conflicts during parallel development
- Violation of Single Responsibility Principle

**Affected Components:** book-routes.cjs

---

## 4. Excessive Responsibility of scene-orchestrator.js — Partially Fixed

**Problem (was):** ~1200 lines, mixing dispatch execution, callback handling, state management, layer config, padded text trimming.

**What was done:** Logic extracted to `scene-callbacks.js` (~17 KB), `scene-restoration.js`, `scene-utils.js`. Now `scene-orchestrator.js` is a facade **~173 lines**. Stale state tolerance removed (R3.1/R6.5).

**Remaining:** inline require() inside scene-callbacks.js (8+ locations) — hidden cyclic dependencies.

> **UPD 2026-06-26:** Orchestrator size corrected (~173, not ~1200). Code: `orchestration/*`.

---

## 5. Mixed Runtime and Business Logic in dispatch-engine.js

**Problem:** ~1000 lines containing lease management, quota, circuit breaker, retry budget, fairness, policy, decision trace — all cross-cutting concerns in one file.

**Cause:** Gradually adding resilience mechanisms without extracting layers.

**Potential Consequences:**
- Changing one mechanism (e.g., retry budget) risks breaking others
- Impossible to reuse individual mechanisms in other contexts

**Affected Components:** dispatch-engine.js

---

## 6. AI Model Knowledge Hardcoded

**Problem:** Default model (`qwen/qwen3.5-122b-a10b`) set in runtime-config.js. docker-compose uses different model (`qwen/qwen3-32b`). No "AI model" abstraction with interface and different implementations.

**Current State (partially fixed):**
- ✅ `OPENROUTER_API_KEY` unified as single key source across all AI calls
- ✅ AI routes use `config.OPENROUTER_API_KEY` instead of `process.env.AI_API_KEY`
- ✅ AI_API_BASE_URL configurable via env (default: Nvidia)
- ❌ Still no AI provider abstraction
- ❌ No fallback chain between OpenRouter and Nvidia
- ❌ Provider-specific code spread across ai-service.js

**Affected Components:** agent-service.js, ai-service.js, chat-engine.cjs

---

## 7. No Unit Tests for Critical Components

**Problem:** Of 14 test files, most test isolated utilities. Critical components (scene-orchestrator, dispatch-engine, runtime-scheduler, agent-service) have no tests.

**Cause:** Tests written post-factum for most stable or simple modules.

**Potential Consequences:**
- High regression risk when changing orchestrator, dispatch-engine
- Impossible safe refactoring
- Manual testing as only verification method

**Affected Components:** scene-orchestrator.js (refactored to ~173 lines), dispatch-engine.js, runtime-scheduler.js, agent-service.js

---

## 8. GPU Hub as Single Point of Failure

**Problem:** All GPU tasks pass through single GPU Hub instance. On its failure — all generation stops.

**Current State (improved):**
- ✅ REQUEUE on worker timeout (10 min)
- ✅ Task deduplication (NX EX 3600)
- ✅ Graceful shutdown (SIGTERM)
- ❌ No multi-instance GPU Hub
- ❌ No Redis queue replication

**Affected Components:** gpu-hub.js, gpu-dispatcher.js, dispatch-engine.js

---

## 9. No Internationalization of Progress Messages

**Problem:** Progress messages in agent-service.js (PROGRESS_STAGES) are in Russian. Android app expects Russian messages.

**Cause:** Project targets Russian-speaking users.

**Potential Consequences:**
- No localization without backend changes
- Mixed code language (English) and data (Russian)

**Affected Components:** agent-service.js, GenerateViewModel.kt

---

## 10. No API Versioning

**Problem:** All endpoints use `/api/v1/`, but no versioning mechanism (headers, naming, compatibility layer).

**Cause:** Project in early development stage.

**Potential Consequences:**
- No backward-compatible API changes
- Response format changes break all clients

**Affected Components:** All route files, BackendApi.kt

---

## 11. AI Knowledge Base — Partially Used

**Current State:**
- ✅ `ai-loader.js` — loads examples with TTL cache (1 min), used:
  - `visual-utils.js` — `getExamples()` for `formatExamplesForPrompt()` and `buildVisualExemplars()`
- ✅ `knowledge-base.js` — loaded via `agent-service.js` for future use
- ❌ `rules/` and `skills/` from `backend/ai/` not used in main pipeline prompts

**Cause:** Knowledge base partially used (examples), partially reserved for future improvements.

**Affected Components:** agent-service.js, ai-loader.js, knowledge-base.js, visual-utils.js

---

## 12. Window Size and AI Pipeline Limits

**Problem:** `MAX_WINDOW_CHARS=1500` and `MAX_SCENES_PER_CHUNK=3` remain conservative limits. They no longer set book progression boundary, but for large books still cause many agent calls.

**Cause:** Conservative values chosen for stability.

**Potential Consequences:**
- High AI call cost for large books
- Long import time
- Context loss between windows

**Affected Components:** agent-service.js

---

## 13. No Graceful Shutdown — Fixed

**Problem (was):** backend.cjs didn't handle SIGTERM/SIGINT signals for proper process termination, lease release, state preservation.

**Fixed:** SIGTERM handlers added:
- `backend.cjs`: server.close() → redis.quit() → postgres.closePool()
- `gpu-hub.js`: server.close() → redis.quit()

**Affected Components:** backend.cjs, gpu-hub.js

---

## 14. No Metrics and Monitoring

**Problem:** No metrics collection system (Prometheus, OpenTelemetry, etc.).

**Current State (partially fixed):**
- ✅ Security headers added (Helmet.js)
- ✅ Rate limiting added (500 req/min)

> **UPD 2026-06-26:** Rate limit corrected (500, not 100). Code: `backend.cjs:64-65`.

- ✅ Request tracing via requestId added
- ✅ Runtime metrics added (runtime-metrics.js)
- ✅ Runtime loop with history (100 ticks) added
- ❌ Still no CPU/memory/GPU metrics
- ❌ No external monitoring (Prometheus/Grafana)

**Affected Components:** All modules (using console.log/warn/error)

---

## 15. Slim Runtime — Governance Modules in Debug — Fixed

**Problem (was):** In v2.0.0 runtime/index.js was "slimmed": governance modules (circuit-breaker, fairness, policy-engine, etc.) moved from core pipeline to debug section and loaded lazily. Files saved on disk but not in main cycle. Some had `require()` on non-existent files — mine for debug endpoints (500s).

**What was done (Phase 6, R6.4):**
- circuitBreaker, retryBudget, fairness — migrated from safeRequire to direct require() and actively called in dispatch-engine
- policyEngine, workloadClassifier, costEstimator — removed from dispatch-engine (safeRequire removed)
- Dead functions `dispatchStageWithPolicy()` and `evaluateDispatchPolicy()` removed

**What was done (D.3/L1, 2026-06-27, commit `311f44a`):**
- Removed `src/api/runtime.js` (1758 lines) — never imported anywhere, sole debug cluster consumer.
- Removed 16 dead `runtime/` modules (including 6 with broken require: policy-engine, policy-simulator, failure-replay, governance-validator, governance-sandbox, governance-health, execution-semantics, etc.).
- Removed `debug: { ... }` facade from `runtime/index.js`.
- `runtime/` reduced from **37 to 21 modules** — all alive, debug-only governance ballast gone.

**Remaining:** alive `circuit-breaker`/`fairness-engine`/`retry-budget-manager` (used by dispatch-engine directly). No broken requires in codebase.

> **UPD 2026-06-26:** 3 governance modules LIVE, 3 dead removed from dispatch-engine.
> **UPD 2026-06-27:** Dead cluster and dead `api/runtime.js` removed (D.3). Item closed.

---

## 16. Dual State Model — Excess Complexity — Fixed (v2.1.0, Н.6+Н.7)

**Problem (was):** Dual State Model (per-asset + linear FSM) with sequential transition validation that blocked parallel dispatch.

**What was done (v2.1.0):**
- ✅ Transition validation removed (`SceneTransitions`, `transitionSceneState` with locks/CAS)
- ✅ `scene-state-machine.js` removed (`Stage`, `determineNextStage`) — dead code
- ✅ `decideStage` removed from orchestrator — dispatch-engine always passes `overrideStage`
- ✅ `shouldScheduleScene`, `registerScene`, `progressScene` removed from scheduler — legacy
- ✅ `sceneHeartbeat`, `isSceneStuck`, `getRecoveryPendingState` removed — unnecessary without FSM
- ✅ All callbacks (`handleAudioCompleted`, `handleImageCompleted`, `handleVideoCompleted`) check per-asset state instead of linear

**What was done (Н.6, М1 — `1a0867d`):**
- ✅ Per-asset storage: JSON (GET+merge+SET) → Redis Hash (HSET/HGETALL) — non-atomic RMW eliminated

**What was done (Н.7, §5.1 — `f0b81de`):**
- ✅ `executeAudioDispatch/ImageDispatch/VideoDispatch` → `setAssetState(..., AssetState.GENERATING)`

**Remaining (T8 + dead code cleanup, July 2026):**
- ✅ `SceneState` enum, `syncLinearState()`, `deriveLinearState()` — removed. Per-asset is the sole source of truth.
- ✅ Keys `animastor:scene-state:*` no longer written.
- ✅ All consumers migrated to per-asset `getAssetStates()`.

---

## 17. Two Event Journals (Redis + PostgreSQL)

**Problem:** System has two event journals: Redis (event-journal.js, TTL 7 days) and PostgreSQL (book-event-log.js, 30+ event types). They're not synchronized and duplicate functionality.

**Affected Components:** event-journal.js, book-event-log.js

---

## 18. Multi-File Book Format vs. Legacy Single-File

**Problem:** Books migrated to multi-file format (v2.1), but book/index.js still supports legacy single-file format for migration. This adds loading complexity.

**Affected Components:** book/index.js, lazy-book.js
