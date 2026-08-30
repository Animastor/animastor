# Dependency Analysis: Animastor

## Analysis Method

Analysis performed based on static code analysis: `require()`/`import` dependencies, architectural call patterns, and logical connections between modules.

---

## 1. Circular Dependencies

### 1.1 backend.cjs ↔ task-handler.cjs

- `backend.cjs` imports `task-handler.cjs`
- `task-handler.cjs` receives `backend.cjs` via DI (deps object) and uses exported modules

**Type:** Indirect circular dependency through DI container.

### 1.2 scene-orchestrator.js ↔ dispatch-engine.js

- `scene-orchestrator.js` is called by `dispatch-engine.js` for dispatch execution
- `dispatch-engine.js` is part of the runtime imported by `scene-orchestrator.js` through the call chain

**Type:** Functional circular dependency. Orchestrator calls dispatch-engine (via runtime-scheduler), dispatch-engine calls orchestrator.

---

## 2. High Coupling

### 2.1 backend.cjs (Central Binding Point)

**Problem:** `backend.cjs` is the **single point** of DI for all dependencies. It imports ~30 modules and passes dependencies to 4 route modules.

**Coupling:** High. Any new dependency requires changes in backend.cjs.

**Affected components:**
- All 4 route modules (book-routes, generation-routes, ai-routes, debug-routes)
- task-handler.cjs (receives deps)
- book-diff.cjs (receives deps)
- audio-recovery.cjs (receives deps)

### 2.2 scene-orchestrator.js (~173 lines, Facade)

**Problem (was):** Contained dispatch logic, callback handling, state management, layer config checks, padded text trimming.

**Fixed:** Logic extracted to `scene-callbacks.js`, `scene-restoration.js`, `scene-utils.js`. Now `scene-orchestrator.js` is a facade of **~173 lines**.

**Coupling (historical):** Depends on:
- audio/index.js, image/index.js, video/index.js
- scene-state.js (dual model: per-asset + linear FSM)
- event-journal.js
- active-scenes-index.js
- layer-config.js
- gpu-dispatcher.js
- asset-registry.js
- placeholder-audio.js
- dispatch-engine.js
- runtime-scheduler.js
- scene-window.js
- worker-health.js

### 2.3 book-routes.cjs (~1800+ lines)

**Problem:** Contains all endpoints for books, including import, bootstrap, trigger-next-window, agent-status, generation-state, and dozens more.

**Coupling:** Extremely high. Depends on ~20+ services.

---

## 3. Potential Architectural Bottlenecks

### 3.1 GPU Hub (Single Point of Failure)

**Problem:** All GPU tasks pass through a single GPU Hub.

**Current state (improved):**
- ✅ REQUEUE on worker timeout (10 min)
- ✅ Task deduplication
- ✅ Graceful shutdown
- ❌ No failover, no replication

### 3.2 Redis (Single Point of Failure for Runtime)

**Problem:** Runtime state (active scenes, dispatch leases, quotas, event journal, worker health, queues) depends entirely on Redis.

**Current state:**
- ✅ Redis persistence via docker volume (redis-data:/data)
- ❌ No Redis Sentinel/Cluster configuration in docker-compose

### 3.3 OpenRouter API / Nvidia API (Single Point of Failure for AI)

**Problem:** The entire AI pipeline (agent-service, chat-engine) depends on external APIs.

**Current state:**
- ✅ AI_API_BASE_URL is configurable (OpenRouter, Nvidia, custom)
- ❌ No automatic provider failover
- ❌ No fallback chain

### 3.4 Runtime Scheduler (Single Scheduler)

**Problem:** All generation progress depends on a single tick scheduler (5s). When it stops — scene generation halts.

---

## 4. Components with Excessive Responsibility

### 4.1 scene-orchestrator.js

> **UPDATE 2026-06-26:** Callback logic extracted to `scene-callbacks.js` (R3). Now orchestrator is a facade of ~173 lines.
> stale state tolerance removed (R3.1 = R6.5).
> GENERATING per-asset added at dispatch (N.7/§5.1).

**Current responsibility:**
- Dispatch execution for audio/image/video
- Layer config checks (audio_enabled/image_enabled/video_enabled)
- Lane management (completeWithoutVideo/Image)
- Event journal logging

**Responsibility (EXTRACTED to scene-callbacks.js):**
- Callback handling for all three types
- State machine management (per-asset state)

**Removed:**
- stale state tolerance (R6.5)
- padded text trimming (in audio-service, passed via DI)
- syncLinearState calls (→ per-asset API, R6.1)

**Assessment:** Substantially reduced, but still a facade with multiple responsibilities.

### 4.2 book-routes.cjs

**Responsibility:**
- Book CRUD
- TXT import (decoding, deduplication)
- Bootstrap (AI pipeline launch)
- Trigger next window
- Agent status
- Generation state
- Chunk management
- Slide window
- Scene reorder
- Book diff/apply

**Assessment:** Too much responsibility for a single file.

### 4.3 dispatch-engine.js (~1000 lines)

**Responsibility:**
- Lease management
- Quota management
- Circuit breaker integration (safeRequire)
- Retry budget integration (safeRequire)
- Fairness engine integration (safeRequire)
- Policy engine integration (safeRequire)
- Decision tracing
- Counter reconciliation

**Assessment:** Integrates too many cross-cutting concerns. However, governance modules are lazy-loaded (safeRequire).

### 4.4 scene-state.js

**Responsibility:**
- Dual state model (per-asset + linear FSM)
- State transitions for both models
- Heartbeat management
- Stuck detection
- Redis read/write

---

## 5. Components with Too Much Logic Flowing Through Them

### 5.1 backend.cjs

**Logic flow:**
- Initialization → Redis/PG connection
- Workflow loading
- DI of all services (30+)
- Mounting all routes
- Starting runtime loop
- Starting cleanup/audio-recovery/startup-resume
- Graceful shutdown

**Assessment:** ~265 lines for ~30 dependencies.

### 5.2 task-handler.cjs

**Logic flow:**
- Callback from GPU Hub (audio, image, video)
- IU image completion with PG validation
- Audio merge with padded text trimming
- Asset registration

### 5.3 scene-orchestrator.js

**Logic flow:**
- dispatching → execution → callback → state update → window slide
- Virtually all business logic flows through the orchestrator

**Assessment:** Acts as the central "brain" of the system.

---

## 6. Slim Runtime (v2.0.0)

The `runtime/index.js` module exports only the core pipeline. Governance modules are lazy-loaded via `runtime.index.debug`.

**Core (always loaded):**
- scheduler, loop, activeScenes, reconciliation, dispatch, leaseManager, counterReconciliation, metrics, gpuDispatcher, workerHealth, sceneWindow

**Error handling (loaded):**
- failureTaxonomy, retryManager, retentionManager

**Debug (lazy-loaded):**
- snapshotManager, circuitBreaker, priorityManager, fairness, retryBudget, policyEngine, workloadClassifier, costEstimator, decisionTrace, feedback, governanceMetrics, adaptationController, governanceStability, governanceHealth, executionSemantics

**Debug/Experimental (lazy-loaded):**
- policySimulator, sandbox, failureReplay, validator

---

## Dependency Graph Visualization (Critical Paths)

```
                    ┌──────────────────────┐
                    │     backend.cjs      │◄─── Central DI (30+ dependencies)
                    └──────────┬───────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                      ▼
   ┌──────────┐       ┌──────────────┐       ┌──────────────┐
   │ Routes   │       │  Runtime     │       │  Services    │
   │ (4 files)│       │  Scheduler   │       │  (20+)       │
   └──────────┘       └──────┬───────┘       └──────────────┘
                             │
                    ┌────────┴────────┐
                    │  Dispatch       │
                    │  Engine         │
                    │  (lazy gov.)    │
                    └────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │  Scene          │◄─── Excessive responsibility
                    │  Orchestrator   │     (1200 lines, layer-aware)
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                    ▼
   ┌──────────┐      ┌───────────┐       ┌──────────┐
   │  Audio   │      │   Image   │       │  Video   │
   │  Service │      │  Service  │       │  Service │
   └──────────┘      └───────────┘       └──────────┘
         │                  │                   │
         └──────────────────┼───────────────────┘
                            ▼
                    ┌──────────────┐
                    │GPU Dispatcher│
                    │  (3 retries) │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │   GPU Hub    │◄─── Single point of failure
                    │ (10min t/o)  │     (+ requeue)
                    └──────────────┘
```
