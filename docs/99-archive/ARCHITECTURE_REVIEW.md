# Architecture Review: Animastor

## What's Already Good

### 1. Dual-storage Strategy (PostgreSQL + Redis)

Correct separation of concerns: PostgreSQL is the canonical truth, Redis is runtime state and queues. Redis persistence via docker volume `redis-data:/data` — additional protection.

### 2. Lease-based Dispatch

Lease mechanism via Redis `SET NX` + TTL (30min audio, 60min image, 120min video) — reliable protection against dispatch duplication. Stale lease cleanup on startup — correct practice.

### 3. Per-asset State Machine (DUAL MODEL)

Dual State Model implemented: per-asset states (NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER) are the canonical source of truth. Linear FSM retained as a derived projection for backward compatibility. Audio and image can be dispatched independently (in parallel). Video correctly depends on image=READY.

### 4. Governance Layer (although in DEBUG)

Circuit breaker, retry budget, fairness engine, policy engine — mature set of mechanisms, lazily loaded. Not in core pipeline, but ready for activation.

### 5. Scene Window + Scope-aware Generation

Windowed processing (3 scenes at a time) + scope (`current_scene`, `current_chapter`, `from_current_scene`, `whole_book`). Added content-on-disk verification (`sceneHasValidContent`), chunk status reconciliation (`reconcileWindowStatuses`, `restoreChunkStatusForScene`), cancel flag.

### 6. Workflow Loader + Deep Clone

Templates are immutable — each `getWorkflow()` call returns `JSON.parse(JSON.stringify(template))`.

### 7. Architectural Essence (`architectural-essence.md`)

Project philosophy (book = sequential reading process) — clear and well-designed model.

### 8. Graceful Shutdown — FIXED

SIGTERM handlers added to backend.cjs AND gpu-hub.js. Sequential termination: HTTP → Redis → PostgreSQL.

### 9. Startup Resume

Mechanism added to resume interrupted generation sessions on startup (startup-resume.js). PostgreSQL queries active sessions → restart.

### 10. Book Source / Sync / Integrity

Three new services implemented to maintain Book JSON ↔ PostgreSQL consistency:
- **Book Source** — canonical scene index
- **Book Sync** — synchronization via scene_hash (added/changed/removed detection)
- **Book Integrity** — orphan detection across all scene-keyed tables

---

## What Should Be Changed

### 🔴 Critical (system failure risk)

#### 1. GPU Hub — Single Point of Failure

All GPU tasks pass through a single GPU Hub instance.

**Improved:** Health check with auto-restart, requeue on timeout (10 min), deduplication, graceful shutdown.

**What to do:**
- Add multi-instance GPU Hub with Redis Pub/Sub for state synchronization
- Or, at minimum, document RTO/RPO

**Affected components:** `gpu-hub/gpu-hub.js`, `docker-compose.yml`

#### 2. Dual State Model — Excessive Complexity

Per-asset + linear FSM. Per-asset is canonical, linear is a derived projection. Requires `syncLinearState()` after every `setAssetState()`.

**What to do:** After full migration to per-asset model — remove linear FSM and all `syncLinearState` calls.

**Affected components:** `scene-state.js`, `scene-orchestrator.js`

#### 3. Two Event Journals (Redis + PostgreSQL)

Redis event-journal.js (TTL 7 days) duplicates book-event-log.js (PostgreSQL) functionality.

**What to do:** Remove Redis event journal, keep only PostgreSQL.

**Affected components:** `event-journal.js`, `book-event-log.js`

---

### 🟡 High Priority (code quality)

#### 4. No Unified Generator Abstraction

Audio, Image, Video — three independent services with different interfaces. Adding a new generation type requires changes in 5+ files.

**What to do:** Introduce a Generator interface with registry, make orchestrator work through the registry.

#### 5. Missing Tests for Critical Components

Of 14 test files, none covers scene-orchestrator, dispatch-engine, runtime-scheduler, agent-service.

**What to do:** scene-state.js (dual model) — pure functions, start there.

#### 6. book-routes.cjs — Excessive Responsibility (~1800+ lines)

~30 endpoints in one file.

**What to do:** Split into import-routes, agent-routes, book-routes.

---

### 🟢 Medium Priority (long-term improvements)

#### 7. No AI Provider Abstraction

OpenRouter API and Nvidia API both supported, but no automatic switching mechanism.

**What to do:** `class AIProvider` with `call()` → OpenRouterProvider, NvidiaProvider. Strategy: primary → fallback → error.

#### 8. Governance Modules in DEBUG

15+ modules on disk, loaded via safeRequire (may not be loaded). Dead code.

**What to do:** Either integrate into core pipeline or remove from disk.

#### 9. AI Knowledge Base Not Used

knowledge-base.js + ai-loader.js load rules/skills but don't use them in prompts. (Exception: refineDraft uses examples.)

**What to do:** Either use or remove.

#### 10. No API Versioning

All `/api/v1/`, but no backward compatibility mechanism.

---

### ⚪ Low Priority (optional)

#### 11. Russian Progress Messages
PROGRESS_STAGES in Russian. Move to locale files.

#### 12. Logs via console.log
Replace with pino/winston with JSON format.

#### 13. AI Pipeline Window Size
WINDOW_SIZE=3, MAX_WINDOW_CHARS=4000 — conservative. Make dynamic.

---

## Summary

### DO NOT TOUCH
- Project philosophy (book = reading process)
- Dual-storage strategy (PG + Redis)
- Lease-based dispatch
- Scene window + scope-aware generation
- Multi-file book format (v2.1)

### DO FIRST (days, not weeks)
1. Clean dead code: governance modules from DEBUG (integrate or remove)
2. Clean duplicate event journals
3. Tests for state machine (dual model)

### PLAN (sprints)
4. Unified Generator interface (Generator interface + registry)
5. AI provider abstraction (OpenRouter ↔ Nvidia ↔ local)
6. Full migration to per-asset model (remove linear FSM)

### DISCUSS
7. API versioning
8. Redis persistence for queues
9. Multilingualism
