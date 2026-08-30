# Animastor — Orchestration System

> **Single document.** Current state as of **11 August 2026** (video orchestration implemented), revision `a58676e+`.
> Supersedes: `ORCHESTRATOR_LIFECYCLE.md`, `ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md`,
> `AUDIO_ORCHESTRATOR.md`, `REGENERATION_SYSTEM.md`, `ORCHESTRATION_SYSTEM_AUDIT.md`,
> `CAPACITY_AND_COMPLEXITY.md`. All orchestration answers are here.
> Video pipeline details: `VIDEO_ORCHESTRATION.md`.

---

## 1. Overall Architecture

```
                   ┌──────────────────────────────────────────┐
                   │         runtime-loop (tick 5s)           │
                   │  reconcile cycle (60s) ←── CLEANUP_LOCK   │
                   └────┬───────────┬──────────────┬──────────┘
                        │           │              │
                   ┌────▼───┐  ┌───▼─────┐  ┌─────▼────────┐
                   │Scheduler│  │Counter  │  │Prometheus    │
                   │(tick()) │  │Reconcil.│  │Metrics       │
                   └────┬───┘  └─────────┘  └──────────────┘
                        │
              ┌─────────▼──────────────────────┐
              │     dispatch-engine.js          │
              │  lease + quota + circuit-break  │
              │  + retry-budget + dispatch      │
              └─────────┬──────────────────────┘
                        │
         ┌──────────────▼──────────────────┐
         │    orchestrator.js (FACADE)     │
         │  markDirty / setSceneGenerating │
         │  completeStage / failStage      │
         │  reconcile / resetScenes        │
         └──────┬──────────────┬──────────┘
                │              │
         ┌──────▼──┐    ┌─────▼──────────┐
         │ state.js │    │ audio-orch.js │
         │(per-asset)    │(phase machine)│
         └─────────┘    └────────────────┘
                │              │
         ┌──────▼──────────────▼──────────┐
         │   scene-orchestrator.js        │
         │   executeAudio/Image/Video     │
         │   └ video-orch.js (groups)     │
         └───────────────────────────────┘

    GPU Hub (gpu-hub.js) ←─── backend
      └── Worker (worker.cjs) ←──→ ComfyUI
```

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| **Single Node.js process** | No clustering. Everything: API, tick, reconcile, SSE — in one event loop. |
| **Redis** | Runtime state: queues, locks, asset states, leases, quotas. |
| **PostgreSQL** | Canonical: scenes, versions, scene_assets (status), book JSON. |
| **Filesystem** | OUTPUT_DIR — result bytes (.mp3, .png, .mp4). |

---

## 2. System Components

### 2.1 Orchestrator Facade (`orchestrator.js`)

The only module that writes lifecycle state. **Nobody calls `state.setAssetState()` or `audioOrch.*()` directly** — only through the facade.

```
  Command                | asset state       | audio-orch
  ───────────────────────|───────────────────|──────────────────────────
  setScenePending        | → PENDING         | if DONE → deleteState
  setSceneGenerating     | → GENERATING      | DONE? → skip; otherwise → GENERATING
  setScenePlaceholder    | → PLACEHOLDER     | —
  completeStage          | → READY           | → DONE (synchronous)
  failStage              | → FAILED → PENDING | → FAILED
  markDirtyScene         | → DIRTY           | if DONE → deleteState
  setSceneAllReady       | all → READY       | all → DONE
  resetScenes            | all → DIRTY       | all → deleteState/FAILED
```

### 2.2 Dispatch Engine (`dispatch-engine.js`)

- **Lease** (`SET NX` + TTL): prevents double dispatch. TTL: audio 15min, image 20min, video 30min.
- **Quota** (`INCR` + check): backpressure. Limits: audio 3, image 2, video 1.
- **Circuit breaker**: 5 failures → open → 30s cooldown → half-open.
- **Retry budget**: per-(scene, stage) INCR + TTL counter. `consumeRetryBudget` in `finalizeDispatch('failure')`.
- **Dispatch ID**: UUID v4, `verifyDispatchIdentity` in callback.

### 2.3 Audio Orchestrator (`audio-orchestrator.js`)

Detailed state machine for the audio pipeline:

```
NEW ──→ PLACEHOLDER_READY ──→ GENERATING ──→ WAITING_CHUNKS ──→ MERGING ──→ DONE
                                  │                                │
                                  └──→ FAILED ←────────────────────┘
```

- Key: `animastor:audio-orch:{bookId}:{chapterId}:{sceneId}`
- Stores: `phase, expected_count, chunks_received, last_chunk_at, started_at, build_id`
- Watchdog in reconcileCycle: `checkStalledAudioScenes()` — checks `last_chunk_at || started_at`
- Recovery: if chunks on disk without last_chunk_at → resume merge
- Invariant: `phase == DONE ⇔ asset.audio == READY`

### 2.4 Video Orchestrator (`video-orchestrator.js`)

Detailed state machine for the video pipeline — **mirror of audio-orchestrator**, implemented 2026-08-11 (see `VIDEO_ORCHESTRATION.md`):

```
GENERATING ──→ WAITING_CHUNKS ──→ MERGING ──→ DONE
      │              │               │
      └──→ FAILED ←──┴───────────────┘
```

- Key: `animastor:video-orch:{bookId}:{chapterId}:{sceneId}`
- Stores: `phase, groups (unit_ids + status), groups_received, build_id, dispatch_id`
- Groups remain separate files `_gN.mp4`; `scene.mp4` — only the concatenated result FOR THE PLAYER (not pipeline).
- Stale-accept: late groups with old dispatch_id are accepted in WAITING_CHUNKS/MERGING.
- Dirty-regeneration is targeted: only groups with dirty units are regenerated.
- Watchdog: `checkStalledVideoScenes()` (threshold from layer-config), recovery `recoverVideoOrchStates()`.
- Invariant: `phase == DONE ⇔ asset.video == READY` (checked in reconcileCycle).

### 2.5 Asset State (`state.js`)

High-level per-asset states:

```
NEW → PENDING → GENERATING → READY
              ↘ FAILED → PENDING
  DIRTY → PENDING
```

- Key: `animastor:asset-state:{bookId}:{chapterId}:{sceneId}`
- Fields: `{ audio, image, video }` ∈ {NEW, PENDING, GENERATING, READY, FAILED, DIRTY, PLACEHOLDER}
- **Single source of truth** for lifecycle from the scheduler's perspective.
- ~~`syncLinearState()`~~ — removed (T8). Per-asset is the only source of truth.

### 2.6 Runtime Loop (`runtime-loop.js`)

- **Tick** (every 5s): fast cycle — collect active-scenes, call scheduler.tick(), counter-reconciliation.
- **Reconcile** (every 60s): full self-healing cycle with distributed lock.
  - Phase A: orphan audio state cleanup
  - Phase B1: orphan file reconciliation
  - Phase C0/C1/C2: active state fixes
  - Phase C4: counter reconciliation (with PG deps)
  - Phase C5: session resume
  - Phase D: audio-orch invariants check + video-orch invariants check

### 2.7 Scene Orchestrator (`scene-orchestrator.js`)

Executes dispatch by type: `executeAudioDispatch()`, `executeImageDispatch()`, `executeVideoDispatch()`.
Each:
1. Calls `orchestrator.setSceneGenerating(stage)` via facade
2. Prepares data (segments for audio, IU for image, frames for video)
3. Submits task to GPU Hub via `gpu.send()`
4. Returns `{ dispatched, jobs, reason }`

Video branch additionally: initializes video-orch state (group composition + unit_ids),
regenerates only groups with dirty units (targeted dirty-regeneration),
on full cache — fast-track merge without job submission.

### 2.8 GPU Hub (`gpu-hub/gpu-hub.js`)

Proxy between backend and remote GPU workers:
- Accepts tasks into Redis queues `animastor:queue:{audio|image|video}`
- Deduplicates (`animastor:job:{job_id}`, SET NX EX 3600)
- Tracks worker heartbeats (updates every 10s)
- Re-queue on timeout (10 min)
- Callback: POST /gpu/task/result
- **GPU_HUB_API_KEY** — optional authentication (env, not set → open access)

### 2.9 Regeneration System

```
Edit → Save → PUT /api/v1/book/:bookId → disk
  → Regenerate → POST /api/v1/book/:bookId/regenerate
    → computeBookDiff(oldBook, newBook)
    → filterDirtyScenesByScope(scope)
    → removeScenesFromActiveIndex() (dirty only)
    → clearLeasesForScenes() (dirty only)
    → clearGpuHubQueues() (dirty only)
    → markDirtyScenes() (Lua atomic: chunks + state + active index)
    → restoreChunkStatusForScene()
    → Scheduler picks up dirty scenes
```

**Dependency Graph (versioned):**
```
SceneText ──┬──► Audio (mp3)
            └──► UnitText ──► ImagePrompt ──► Image (png) ──► Video (mp4)
                                              └──► Video does NOT depend on Audio
```
- Audio + Image are independent, parallel.
- Video depends ONLY on Image.
- Audio change does NOT make Video dirty (video without sound, mux on export).
- Cross-cutting: Character.appearance → Image, Character.voice → Audio, Location → Image.

**Data Provenance — how Image Prompt is assembled** (`image-service.js` `buildImagePrompt()`):

```
Final Image Prompt = [renderMode] + [style] + [location_description]
  + [env_epoch/time/season/weather/mood/atmosphere/lighting] ← scene.location.environment
    (merged with locations.json → environment as fallback: scene overrides template per-field)
  + [shot_type] ← unit.visual.shot
  + [character_passport] ← book.characters[id].passport (via inferCharactersFromPrompt())
  + [character_state] ← scene.state[id] || chapter.state[id]
  + [visual_prompt] ← unit.visual.prompt
  + [quality] ← unit.visual.quality || scene.visual.quality
```

Characters are determined **only** through `inferCharactersFromPrompt()`, scanning `visual.prompt` for `character_id`. `unit.participants` has been removed (July 2026).

`resolveVisualStyle()` fallback: `unit.visual.style → scene.visual.style → scene.style → bible.render_rules.style`.

**Prompt Dependency Registry** (`prompt-dependency-registry.js`):
Single registry of fields → dirty layers. `diffScene()` and `buildImagePrompt()` read from the same registry.

---

## 3. Dual State Machine (Design)

### 3.1 Why Two Machines

| Aspect | Asset State | Audio-Orch |
|--------|------------|------------|
| Key | `scene-assets-state:{bid}:{cid}:{sid}` | `audio-orch:{bid}:{cid}:{sid}` |
| Phases | NEW, PENDING, GENERATING, READY, FAILED, DIRTY, PLACEHOLDER | NEW, PLACEHOLDER_READY, GENERATING, WAITING_CHUNKS, MERGING, DONE, FAILED |
| Semantics | High-level asset status | Detailed audio pipeline status |
| Readers | Scheduler (what to dispatch), player | watchdogs, recovery, merge |

**Asset state** — for the scheduler: "should I dispatch" (PENDING/DIRTY → yes, READY → no).
**Audio-orch** — for the pipeline: "how many chunks arrived, time to merge, stuck?"

### 3.2 Invariant

```
audio-orch.phase == DONE   ⇔   asset.audio == READY       [always true]
audio-orch.phase == FAILED ⇒   asset.audio ∈ {FAILED, PENDING}
audio-orch.phase ∈ {WAITING_CHUNKS, MERGING, GENERATING}
                            ⇒   asset.audio == GENERATING
```

Checked in `reconcileCycle` → `checkAudioOrchInvariants()`.

---

## 4. Call Flows

### 4.1 Normal Audio Generation

```
Scheduler tick → attemptDispatch()
  → shouldScheduleAssets(): asset=PENDING → stages=['audio']
  → dispatchStage('audio')
    → acquireLease(), acquireQuota()
    → scene-orchestrator.executeAudioDispatch()
      └─ orchestrator.setSceneGenerating('audio')
        → asset.audio = GENERATING
        → audioOrch.setGenerating() (PLACEHOLDER_READY → GENERATING)
      → audioOrch.setWaitingChunks()
      → audio.generateSceneAudio() → GPU hub (9 chunks)
      → return { dispatched: true }

Chunks 0001-0008 arrive
  → /gpu/task/result → handleTaskResult()
    → save to disk
    → audioOrch.completeChunk() (WAITING_CHUNKS, chunks_received++)

Chunk 0009 arrives
  → audioOrch.completeChunk()
    → WAITING_CHUNKS → MERGING (all 9 present)
    → ffmpeg merge → MERGING → DONE
    → orchestrator.completeStage('audio')
      → handleAudioCompleted()
      → version gate (PG)
      → asset.audio = READY  (synchronous with audio-orch DONE)
      → finalizeDispatch(success)
```

### 4.2 Watchdog (Timeout)

```
reconcileCycle → checkStalledAudioScenes()
  → audioOrch state: WAITING_CHUNKS, last_chunk_at + 5min < now
  → audioOrch.failWaitingScene()
    └─ orchestrator.failStage('audio')
      → asset.audio = FAILED
      → audio-orch = FAILED (synchronous)
      → finalizeDispatch(failure)

Scheduler tick (next)
  → asset.audio = FAILED → PENDING (re-dispatch)
  → dispatchStage('audio')
    └─ orchestrator.setSceneGenerating('audio')
      → audio-orch FAILED → GENERATING (valid)
      → dispatch again
```

### 4.3 Regenerate

```
User edits → POST /regenerate
  → orchestrator.resetScenes()
    → clearLeases, clear queues (dirty only)
    → orchestrator.markDirtyScene('audio')
      → audio-orch DONE? → deleteState
      → asset.audio = DIRTY
  → scheduler.addSceneToActiveIndex()

Scheduler tick
  → asset.audio = DIRTY → stages=['audio']
  → dispatchStage('audio')
    → orchestrator.setSceneGenerating('audio')
      → audio-orch: no state → initPlaceholderReady → setGenerating
      → asset.audio = GENERATING
      → dispatch to GPU
```

### 4.4 Stale Recovery (DONE Guard)

```
After restart: audio-orch in WAITING_CHUNKS (old generation)
  → Scheduler sees asset.audio = GENERATING
  → dispatchStage('audio')
    → orchestrator.setSceneGenerating('audio')
      → setGenerating() → FAILS (WAITING_CHUNKS → GENERATING invalid)
      → stale-phase recovery:
        → deleteState (only WAITING_CHUNKS/GENERATING/FAILED — NOT DONE)
        → initPlaceholderReady → setGenerating ✅
      → dispatch to GPU (fresh generation)
```

---

## 5. Capacity and Performance

### Current Limits

| Resource | Maximum | Description |
|----------|---------|-------------|
| Audio generation | 3 concurrent | quota `maxActiveAudio: 3` |
| Image generation | 2 concurrent | quota `maxActiveImage: 2` |
| Video generation | 1 concurrent | quota `maxActiveVideo: 1` |
| Scheduler tick | 1 instance | distributed lock |
| Node.js process | 1 (single-threaded) | no clustering |
| Redis | 1 instance | Lua scripts |
| GPU Hub | 1 proxy | no sharding |

**System designed for 1–5 concurrent users.** Designed for a single user with one book.

### Without Code Changes (Config Tweaks)

| Change | Result |
|--------|--------|
| `maxActiveAudio: 3 → 10` | 3× more audio |
| `maxActiveImage: 2 → 6` | 3× more image |
| `maxActiveVideo: 1 → 3` | 3× more video |
| GPU Hub → +1 instance | high availability |

→ **10–15 concurrent users** without new code.

### For 50+ Users

Required: job queue (RabbitMQ/Redis Streams), Node.js clustering, S3 storage, GPU Hub load balancing.

---

## 6. Current Status (verified against code, 19 July 2026)

### ✅ Working (verified by code review)

| Hypothesis | Status | Reference |
|------------|--------|-----------|
| Worker syntax error in `waitForFileReady()` | ✅ Fixed | `worker.cjs` — `node --check` OK |
| `completeStage()` ignores result handler | ✅ Fixed | `orchestrator.js:119-184` — `handlerOk` required |
| `failStage()` writes success finalization | ✅ Fixed | `orchestrator.js:280-289` → `finalizeDispatch('failure')` |
| Executor returns `dispatched:true` without sending job | ✅ Fixed | `scene-orchestrator.js` returns `{ dispatched, jobs, reason }` |
| Lease renewal doesn't start | ✅ Fixed | `dispatch-engine.js:594` — after `dispatched:true` |
| Runtime tick runs full reconcile without lock | ✅ Fixed | `runtime-loop.js:65-120` — tick without reconcile |
| `active-scenes` managed by two APIs | ✅ Fixed | `runtime-scheduler.js:82-100` → `active-scenes-index.js` |
| SQL injection in `agent-session.js` | ✅ Fixed | `services/agent-session.js:21` — `ALLOWED_UPDATE_COLUMNS` |
| `redis.keys()` blocks Redis | ✅ Removed | grep finds no `keys('animastor...')` |
| ReferenceError `pendingState` in reconcile | ✅ Fixed | `reconciliation-engine.js:834-851` |
| GPU Hub auth not passed | ✅ Fixed | `gpu-dispatcher.js:46-49` — `x-api-key` |

Additionally:
- `completeStage` NEVER writes `READY` without `handler.ok === true` + version gate (PG)
- `failStage` NEVER writes `recordSuccess` — goes through `finalizeDispatch('failure')`
- Lease/quota freed on `dispatched:false`
- All production JS passes `node --check` (syntax-smoke in pretest)
- **576 tests passing**, zero warnings about missing mock functions
- Graceful shutdown (SIGTERM/SIGINT) + `/health` endpoint
- DONE guard in `scene-orchestrator.js`: doesn't restart completed audio
- Stale phase recovery: WAITING_CHUNKS/GENERATING/FAILED → reset; DONE — untouched
- Direct asset-state writes only through `unsafe*` methods (restore-only)
- `fairness-engine.js` removed (−618 lines)
- `failure-taxonomy.js` reduced from 424 to ~100 lines
- `retry-budget-manager.js` reduced from 520 to ~165 lines (only check/consume)
- Phase C3 removed from reconciliation (−32 lines)
- S4: test mock fixes — zero warnings

### ⚠️ Remaining Defects

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| P1 | Direct state writes bypassing facade (`scene-restoration.js`, `startup-recovery.js`) | Medium | Use `unsafe*` methods → acceptable |
| P2 | GPU Hub auth: env var not set in `.env` | Low | Code correct, needs deploy secret |
| P3 | Counter reconciliation — safety net (needed) | Medium | Kept, useful |
| P4 | No single test for force-regen + stale files | Medium | Coverage gap |

### 🔴 What NOT To Do (Agreed)

- Don't add Kafka, RabbitMQ, BullMQ
- Don't introduce a second state machine on top of asset FSM
- Don't move lifecycle to PostgreSQL in one PR
- Don't rewrite audio pipeline
- Don't add a new reconciliation service
- Don't expand facade beyond 13 commands (current count is sufficient)

---

## 7. Integrations

### 7.1 GPU Hub → Backend Callback

`POST /gpu/task/result` — flow:
1. Validation: `job_id, result_base64, build_id, dispatch_id, protocol_version`
2. `parseJobId` → determine stage (audio_chunk/image/video)
3. `verifyDispatchIdentity` — check dispatch-token
4. Dedup: `animastor:result-processed:{job_id}:{build_id}` SET NX
5. `handleTaskResult()` → save file + complete stage

### 7.2 Frontend (Android)

- `Repository.kt`: chunk cache keyed by `${id}_${buildId}` — stale cache invalidation
- `GenerateViewModel.kt`: `regenerateFromSnapshot()`, `snapshotCurrentBook()`
- `EditFragment.kt`: scene editor → PUT /api/v1/book/:bookId

### 7.3 Storage

| Store | Role | Writer |
|-------|------|--------|
| **PG** `scene_assets` | Canonical lifecycle | only `orchestrator.*` |
| **Redis** `asset-state:*` | Cache for scheduler | only `orchestrator.*` |
| **Redis** lease/quota | Coordination | dispatch-engine |
| **Redis** chunks | Chunk metadata | audio-orch |
| **Files** OUTPUT_DIR | Bytes | worker → fs |

---

## 8. Redis Key Space

```
# Runtime state
animastor:asset-state:{bid}:{cid}:{sid}     # per-asset states (HASH: audio/image/video)
animastor:audio-orch:{bid}:{cid}:{sid}            # audio-orch phase (JSON)
animastor:video-orch:{bid}:{cid}:{sid}            # video-orch phase (JSON, groups)
animastor:dispatch-lease:{bid}:{cid}:{sid}:{type}  # lease (SET NX)
animastor:dispatch-meta:{bid}:{cid}:{sid}:{type}   # dispatch metadata
animastor:active-scenes                            # SMEMBERS

# Quota
animastor:runtime:active-{audio|image|video}      # INCR counters

# Chunks
animastor:chunk:{bid}_{cid}_{sid}_{idx}            # chunk metadata
animastor:iu-progress:{bid}:{cid}:{sid}:image      # IU counter

# GPU Hub
animastor:queue:{audio|image|video}                # LPUSH/BRPOP queues
animastor:job:{job_id}                             # dedup (SET NX)
animastor:result-processed:{job_id}:{build_id}     # result dedup
animastor:iu-in-flight:{imageIUId}                 # in-flight marker
animastor:worker:heartbeat:{type}:{id}              # heartbeat

# Coordination
animastor:regenerate-lock:{bookId}                 # lock (SET NX)
animastor:force-dispatch:{bookId}                  # force flag (EX 120)
animastor:scheduler-tick-lock                      # tick lock
animastor:cleanup-lock                             # reconcile lock
```

---

## 9. Configuration

| Parameter | File | Value |
|-----------|------|-------|
| `maxActiveAudio` | `dispatch-engine.js` | 3 |
| `maxActiveImage` | `dispatch-engine.js` | 2 |
| `maxActiveVideo` | `dispatch-engine.js` | 1 |
| `LEASE_TTL_audio` | `lease-manager.js` | 15 min |
| `LEASE_TTL_image` | `lease-manager.js` | 20 min |
| `LEASE_TTL_video` | `lease-manager.js` | 30 min |
| `GPU_TIMEOUT` | `gpu-hub.js` (env `GPU_TIMEOUT`) | 600000 ms (10 min), per-job overridden by `timeout_ms` from body |
| `SCHEDULER_TICK_INTERVAL` | `runtime-loop.js` | 5000 ms |
| `RECONCILE_INTERVAL_MS` | `runtime-loop.js` | 60000 ms |
| `AUDIO_CHUNK_STALL_MS` | `runtime-config.js` | 300000 ms |
| `VIDEO_CHUNK_STALL_MS` | `runtime-config.js` | fallback watchdog; main threshold from layer-config `video_timeout_minutes` |
| `video_timeout_minutes` | `layer-config.js` | 60 min (default), 10–180 range |
| `VIDEO_RESULT_TIMEOUT_MS` | `worker.cjs` (env) | 7200000 ms (2 hours), worker fallback |

---

## 10. Files

| File | Lines | Role |
|------|-------|------|
| `backend/src/orchestration/orchestrator.js` | ~500 | Facade — single state owner |
| `backend/src/orchestration/scene-orchestrator.js` | ~300 | Dispatch execution by type |
| `backend/src/orchestration/event-journal.js` | ~100 | Event journal (TTL 7d) |
| `backend/src/runtime/dispatch-engine.js` | ~960 | Lease, quota, governance |
| `backend/src/runtime/reconciliation-engine.js` | ~1200 | Self-healing (6 phases) |
| `backend/src/runtime/runtime-loop.js` | ~150 | Tick (5s) + reconcile (60s) |
| `backend/src/runtime/runtime-scheduler.js` | ~320 | Tick dispatch |
| `backend/src/runtime/lease-manager.js` | ~200 | Redis lease (SET NX + TTL + renewal) |
| `backend/src/runtime/counter-reconciliation.js` | ~200 | Quota drift fix |
| `backend/src/runtime/job-schema.js` | ~100 | job_id format |
| `backend/src/runtime/failure-taxonomy.js` | ~100 | Error classification |
| `backend/src/runtime/retry-budget-manager.js` | ~165 | Per-scene retry budget |
| `backend/src/state/scene-state.js` | ~250 | Per-asset state (unsafe* methods) |
| `backend/src/services/audio-orchestrator.js` | ~450 | Audio phase machine |
| `backend/src/services/video-orchestrator.js` | ~400 | Video phase machine (groups, merge for player) |
| `backend/src/video/video-merge.js` | ~210 | Group concatenation → scene.mp4 (NX lock) |
| `backend/src/services/task-handler.cjs` | ~300 | Callback handling |
| `backend/src/services/gen-scope.js` | ~130 | Scope management |
| `backend/src/services/layer-config.js` | ~120 | Profile management |
| `backend/src/services/book-diff.cjs` | ~360 | Diff scenes, mark dirty |
| `backend/src/services/prompt-dependency-registry.js` | ~200 | Prompt field → dirty layer |
| `backend/src/services/startup-recovery.js` | ~300 | 5-step recovery on startup |
| `backend/src/runtime/scene-window.js` | ~680 | Window slide, cache check |
| `gpu-hub/gpu-hub.js` | ~400 | GPU proxy |
| `worker/worker/worker.cjs` | ~250 | GPU worker |

<!-- === Footer === -->
---
*Single orchestration document. Updated 11 August 2026 (video orchestration).*
