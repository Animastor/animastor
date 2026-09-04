# Phase 5 — Break Orchestration ↔ Runtime Cycle

Status: implemented (minimal seam, cycle frozen and narrowed — not fully eliminated, see §9).
Predecessors: [Phase 1 guardrails](PHASE_1_GUARDRAILS.md), [Phase 2 contracts](PHASE_2_CONTRACTS.md), [Phase 3 provider gateway](PHASE_3_PROVIDER_GATEWAY.md), [Phase 4 book model](PHASE_4_BOOK_MODEL.md).
Tests: `backend/tests/architecture/phase5-runtime-result.test.js` (T1–T8), updated baseline in `dependency-guardrails.test.js` R5.

## 1. The cycle that existed

```
orchestration ──▶ services (task-handler) ──▶ runtime (dispatch-engine, job-schema)
      ▲                                              │
      └──────────────────────────────────────────────┘
            runtime requires orchestration modules
```

The runtime layer reports job execution outcomes by calling orchestration
modules directly. Orchestration (and the task-handler in services, which
orchestration owns as `deps.taskHandler`) in turn calls back into runtime
(`dispatch-engine`). That is a structural cycle: neither layer can be loaded,
tested or extracted without the other.

Verified against current code (not the old audit) on 2026-09-04.

## 2. Real files forming the cycle (recon)

### 2.1 runtime → orchestration (reverse edges, the cycle backbone)

Baseline was frozen by `dependency-guardrails.test.js` R5 (`RUNTIME_TO_ORCH_BASELINE`):

| Runtime file | Orchestration import | Purpose | Kind |
|---|---|---|---|
| `runtime/dispatch-engine.js` | `../orchestration/event-journal` | `logDispatchEvent` — journal appends for dispatch lifecycle | top-level |
| `runtime/dispatch-engine.js` | `../orchestration` | Step 6 of `dispatchStage` — executor (`orchestrator.dispatchStage`) performs actual generation | lazy, in-function |
| `runtime/dispatch-engine.js` | `../orchestration/orchestrator` | `repairOrphanGeneratingStates` → `rollbackStageToPending`; dispatch-error rollback | lazy, in-function |
| `runtime/reconciliation-engine.js` | `../orchestration/event-journal` | journal appends | top-level |
| `runtime/reconciliation-engine.js` | `../orchestration/orchestrator` | `failStage` / `markDirtyScene` / `setScenePending` / `rollbackStageToPending` during reconciliation | mixed: top-level + lazy + `deps.orchestrator` (DI) |
| `runtime/runtime-scheduler.js` | `../orchestration/orchestrator` | `markVersionStaleDirty` → `markDirtyScene` | lazy, in-function |
| `runtime/scene-window.js` | `../orchestration/orchestrator` | window slide → `setSceneAllReady` / `setScenePending` / `setScenePlaceholder` | top-level |
| `runtime/runtime-persistence.js` | `../orchestration/event-journal` | **dead import** (no `journal.` usage anywhere in the file) | top-level — removed in Phase 5 |

### 2.2 orchestration → runtime (forward edges — expected direction)

- `orchestration/orchestrator.js` — lazy requires of `runtime-scheduler`,
  `dispatch-engine`, `runtime-metrics`, `reconciliation-engine`, `failure-taxonomy`.
- `orchestration/scene-orchestrator.js` — top-level `gpu-dispatcher`,
  `runtime-scheduler`, `job-schema`.
- `orchestration/scene-callbacks.js` — `runtime-scheduler`, `dispatch-engine`, `scene-window`.
- `orchestration/scene-restoration.js` — `runtime-scheduler`, `scene-window`.

### 2.3 services involvement

- `services/task-handler.cjs` requires `runtime/job-schema` (top-level) and
  `runtime/dispatch-engine` (`verifyDispatchIdentity`, lazy). It calls
  `orchestrator.completeStage(...)` — this is the *services → runtime + services → orchestration* part of the cycle.
- `services/provider-gateway.js` → `runtime/gpu-dispatcher` (expected direction).
- `services/scene-asset-registry.js`, `services/placeholder-audio.js` → `orchestration/orchestrator` (lazy).
- runtime → `services` imports **do** exist and are one more leg of the cycle
  (verified again in the final audit):
  `runtime/scene-window.js` → `services/gen-scope`, `services/placeholder-audio`,
  `services/generation-progress`, `services/audio-orchestrator`;
  `runtime/runtime-scheduler.js` → `services/generation-progress`;
  `runtime/reconciliation-engine.js` → `services/audio-orchestrator`,
  `services/video-orchestrator`, `services/layer-config`, `services/placeholder-audio`.
- Only one of those bridges back into orchestration:
  `services/placeholder-audio.js` → `orchestration/orchestrator` (lazy). Both
  runtime importers of `placeholder-audio` (`scene-window.js`,
  `reconciliation-engine.js`) already hold the pinned direct
  `runtime → orchestration/orchestrator` edge (R5/T2 baseline), so the services
  hop opens **no new** orchestration endpoint.

### 2.4 Where results actually flow (execution paths)

1. **Success path (job completed).** GPU Hub → `POST /gpu/task/result`
   (`routes/generation-routes.cjs:1338`) → dedup + identity check →
   `deps.taskHandler.handleTaskResult(...)` → writes artifact to disk → routes
   by kind (`iu_image` / `audio_chunk` / `scene_video` / `scene_image`) →
   `orchestrator.completeStage(...)` / audio-orch / video-orch →
   `dispatch-engine.finalizeDispatch(outcome:'success')` (via
   `markDispatchCompleted`).
2. **Failure path (job failed).** GPU Hub → `POST /gpu/task/error`
   (`generation-routes.cjs:1435`) → identity check →
   `orchestrator.failStage(...)` → `dispatch-engine.finalizeDispatch(outcome:'failure')`.
3. **Cancellation path.** Stop All / force dispatch / empty executor result →
   `dispatch-engine.cancelActiveDispatch` / `finalizeDispatch(outcome:'cancelled')`.
4. **Recovery path.** Result/error Redis keys replayed by
   `reconciliation-engine.recoverResultKeys` → `taskHandler.handleTaskResult` /
   `deps.orchestrator.failStage` (already DI-shaped).

The runtime-side terminal point for all three outcomes is
`dispatch-engine.finalizeDispatch` — the single finalization point (idempotent,
Lua-claimed). This makes it the natural producer location.

## 3. The seam created

**Owner of the contract:** `backend/src/contracts/runtime-result.js` — a new
`contracts/` layer, below both orchestration and runtime (imports nothing from
either). Ownership is neutral: the contract is not "runtime's" nor
"orchestration's", it sits at the boundary both already share.

Producer side (runtime): `runtime/runtime-result-emitter.js` — a tiny module
that

- normalizes a dispatch finalization into the Runtime Result shape
  (`createRuntimeResult`, status ∈ `completed | failed | cancelled`),
- notifies the consumer **only via an injected callback** (`setConsumer(fn)`),
  never via `require('../orchestration/...')`.

Consumer side (orchestration): `orchestration/runtime-result-consumer.js` —
an adapter implementing `handleRuntimeResult(result)`; it maps statuses onto
the existing orchestration surface and is designed to absorb the semantic
handling incrementally. It is registered at the composition root:

```
backend.cjs (composition root)
    ├─▶ runtime/runtime-result-emitter.setConsumer(
    │        orchestration/runtime-result-consumer.handleRuntimeResult)
    ▼
runtime dispatch-engine.finalizeDispatch
    └─▶ emitRuntimeResult(...)  ──callback──▶  orchestration consumer
```

Direction after Phase 5:

```
orchestration ──▶ runtime ──▶ Runtime Result Contract (callback) ──▶ orchestration consumer
```

No event bus, no Redis channel, no new global — a plain injected callback with
a hard guarantee: **emitter failures are logged, never thrown into the
dispatch path** (finalization semantics must not change).

### 3.1 Contract shape

```js
{
  jobId: string|null,        // Job Protocol v2 job id, when the finalization is job-scoped
  dispatchId: string|null,
  bookId, chapterId, sceneId,
  stage,                     // 'audio' | 'image' | 'video' | null
  status,                    // 'completed' | 'failed' | 'cancelled' (1:1 with finalizeDispatch outcomes)
  result: null,              // artifact payload — artifacts stay on disk; reserved for future use
  error: string|null,        // reason string
  metadata: { outcome, finalizedAt, cleanupErrors }
}
```

- `completed` ⇔ `finalizeDispatch(outcome:'success')`, `failed` ⇔ `'failure'`,
  `cancelled` ⇔ `'cancelled'`. The dispatch-internal outcome vocabulary
  (`success|failure|cancelled`) is intentionally kept inside runtime; the
  contract exposes job-level statuses.
- The contract is a *notification of dispatch finalization*. It does **not**
  carry artifact bytes and does **not** replace `handleTaskResult` (the
  Job Protocol v2 artifact path via `/gpu/task/result` is untouched).

### 3.2 Producer wiring

`dispatch-engine.finalizeDispatch` emits once per accepted finalization
(after the Lua claim succeeds, alongside the journal append, before the
return). Emission is best-effort: wrapped in try/catch, cleanup-style errors
logged and never propagated.

## 4. Ownership

- **Runtime Result Contract**: `backend/src/contracts/` (new neutral layer).
- **Producer**: `runtime/runtime-result-emitter.js` + emission site in
  `runtime/dispatch-engine.js` (`finalizeDispatch` only).
- **Consumer**: `orchestration/runtime-result-consumer.js`, registered in
  `backend.cjs`. Orchestration stays the consumer of runtime outcomes.

## 5. Dependencies changed

1. `runtime/runtime-persistence.js`: dead top-level
   `require('../orchestration/event-journal')` **removed** (verified unused).
2. `dependency-guardrails.test.js` R5 baseline: one runtime→orchestration
   edge removed (`runtime-persistence.js:../orchestration/event-journal`);
   `dispatch-engine.js` additionally requires the contracts-layer emitter —
   allowed (contracts is below both layers, not a cycle edge).
3. `backend.cjs`: registers the consumer via `setConsumer` (composition root
   wiring, the only place that knows both sides).

Nothing else moved; no public API changed; Job Protocol v2, Redis/GPU Hub
protocol, worker protocol, Provider Gateway, Book Model, VBook, Local AI
Connector, Generation, frontend and DB schema untouched.

## 6. What was NOT migrated (deliberate)

- `dispatch-engine.js` executor call (`require('../orchestration')` in
  `dispatchStage` Step 6) — this is the *dispatch* direction, not result
  reporting; migrating it means reworking the executor injection, out of
  Phase 5 scope.
- `dispatch-engine.repairOrphanGeneratingStates` → `orchestrator.rollbackStageToPending`
  — state-repair write, not result reporting.
- `scene-window.js`, `runtime-scheduler.js` orchestrator calls — window/state
  writes, not result reporting.
- `reconciliation-engine.js` — mostly DI-shaped already (`deps.orchestrator`);
  its top-level `event-journal` and lazy orchestrator requires remain.
- `event-journal` top-level requires in `dispatch-engine.js` /
  `reconciliation-engine.js` — journaling is observability, not result
  reporting; a journal seam is future work.

## 7. Technical debt remaining (the cycle is NOT fully eliminated)

The **result-reporting** back-edge now goes through the contract seam, but the
following runtime→orchestration imports remain (pinned by the updated R5
baseline):

1. `dispatch-engine.js: ../orchestration/event-journal` (top-level) — journal
   appends; should become an injected journal port.
2. `dispatch-engine.js: ../orchestration` (lazy) — executor call in Step 6;
   should become an injected executor port.
3. `dispatch-engine.js: ../orchestration/orchestrator` (lazy) —
   `repairOrphanGeneratingStates` rollback; should move to a repair port.
4. `reconciliation-engine.js: ../orchestration/event-journal` (top-level) and
   `../orchestration/orchestrator` (lazy, several sites) — partially DI
   (`deps.orchestrator`), partially hard requires.
5. `runtime-scheduler.js: ../orchestration/orchestrator` (lazy) —
   version-stale DIRTY reset.
6. `scene-window.js: ../orchestration/orchestrator` (top-level) — window
   slide writes.

Additionally, `services/task-handler.cjs` still requires
`runtime/dispatch-engine` directly, and
`services/scene-asset-registry.js` / `services/placeholder-audio.js` require
`orchestration/orchestrator` lazily — the services leg of the cycle is
untouched.

The structural cycle therefore still exists at the module level; what Phase 5
removes is the runtime→orchestration edge on the **job-result path** and one
dead edge. Future phases: journal port, executor port, scheduler/window write
ports, then the services leg.

## 8. Architecture tests (T1–T11)

`backend/tests/architecture/phase5-runtime-result.test.js`:

- **T1** contract shape — every `createRuntimeResult` output has exactly the
  documented fields with correct types; statuses limited to
  `completed|failed|cancelled`.
- **T2** static dependency check — no runtime file requires
  `../orchestration/...` *through the result path*: emitter and contracts
  modules contain no orchestration requires; the residual R5 baseline is
  explicitly asserted so any new edge fails.
- **T3** seam presence — emitter exists, exposes `setConsumer`/`emitRuntimeResult`,
  dispatch-engine emits, consumer implements `handleRuntimeResult`, wiring
  present in `backend.cjs`.
- **T4** completion — a `completed` result is delivered to the registered
  consumer through `emitRuntimeResult` (spy consumer); the dispatch-engine
  `success → completed` mapping is asserted via `statusFromOutcome` plus a
  source check that `finalizeDispatch` emits.
- **T5** failure — a `failed` result carries the error reason; consumer
  errors are contained (never propagated into finalization).
- **T6** cancellation — a `cancelled` result is delivered; unregistered
  consumer degrades to a safe no-op (`delivered: false`).
- **T7** no protocol regression — Job Protocol v2 constants
  (`PROTOCOL_VERSION === 2`, `parseJobId`, `STAGE_BY_KIND`) unchanged; the
  result contract carries `jobId` only as data and the emitter is not on the
  artifact path (`handleTaskResult` untouched).
- **T8** no new architectural cycle — contracts layer requires nothing from
  orchestration/runtime/services; orchestration's consumer requires the
  contract (forward edge only); no services/event-helper module is involved
  in the seam.
- **T9–T11** (final audit) — full `runtime/**` freeze: computed/template/concat
  `require` and `import()` cannot reach orchestration (only the
  `runtime/index.js` `lazyRequire` host, runtime-internal targets only);
  runtime→services imports open no orchestration endpoint beyond the pinned
  direct edges (the only bridge is `placeholder-audio` → `orchestrator`, and
  its importers already hold that direct edge); the emitter is the only module
  that requires the runtime-result contract (single egress point).

## 9. Honest status

Phase 5 delivers a **minimal safe seam** per the phase goal: runtime result
reporting no longer needs orchestration imports, and one dead edge is gone.
The orchestration↔runtime cycle as a whole **still exists** (§7) and is
documented debt with a pinned baseline — it cannot grow, and the result path
is now the first edge extracted from it.

Final audit (Phase 5 close): re-scanned `runtime/**` — the frozen edge set
matches the code 1:1 (no hidden static, dynamic, or services-mediated
runtime→orchestration edge; the only services bridge, `placeholder-audio` →
`orchestrator`, reaches endpoints already pinned directly). This document was
corrected: §2.3 previously claimed runtime has no services imports; the
runtime→services leg exists and is now accounted for above. Semantic reactions
(state writes, re-dispatch policy) remain in the existing flows
(task-handler → completeStage/failStage, reconciliation) and were **not**
migrated into the consumer in Phase 5 (§6, §7).
