# Phase 2 — VBook Runtime Contract + Local AI / Worker Boundary

**Status:** active (architecture boundary documentation + guardrails)
**Date:** 2026-09-04
**Parent plan:** `MODULAR_PRODUCT_ARCHITECTURE_FINAL_REVIEW.md` §6
**Prerequisite:** Phase 1 guardrails active (`docs/architecture/PHASE_1_GUARDRAILS.md`).
**Phase rule:** no runtime behavior change, no protocol change, no refactor of existing
book/AI/hub/worker code. Contracts are derived from **current behavior** and documented
through minimal facades, seams, and architecture tests.

---

## 1. Purpose

Phase 1 froze growth of existing coupling. Phase 2 turns **two already-existing technical
contours** into **explicit, stable contracts** so that later phases (3, 5, 6, 7) can change
internal implementation without breaking consumers:

1. **Canonical Book Model / VBook Runtime**
2. **Local AI Connector / Worker / GPU Hub**

Not a microservice split. Not a file move. Not a protocol change. A **boundary description +
testable guardrail** for each contour.

---

## 2. Canonical Book Model

### 2.1 Where the canonical bundle lives

- **Canonical storage:** `config.BOOKS_DIR` → `/data/books/<bookId>/` (multi-file v2 format).
- **Legacy fallback still readable:** `/data/books/<bookId>.json` (single-file legacy import format),
  handled by `book.loadBook()` read path only.
- **Import ingress:** zipped `.vbook` → `book.extractBookBundle()` → `book.buildBookFromBundle()`
  → `book.saveBookBundle(book, files)` writes canonical multi-file layout.
- **Edit ingress:** `book.loadBook(bookId)` → in-memory mutation → `book.saveBookBundle(book, null)`.

**Source of truth for book content:** the **disk bundle** under `BOOKS_DIR`. Canonical fields
(below) are whatever `loadBook()` returns from that layout.

### 2.2 What is canonical (bundle)

These keys belong to the **canonical book model** — they are persisted as bundle files and
round-tripped through `buildBookFromBundle` / `saveBookBundle` / `loadBook`:

| File | Role | Required? |
|---|---|---|
| `manifest.json` | Canonical identity + VBook version. **Required.** Contains `book_id` (canonical id), `vbook_version`, `build_id`, `state`, plus import render metadata. | yes |
| `book.json` | Book metadata + `structure.chapters_order` (ordered chapter filenames). Required for a loadable book. | yes |
| `chapters/*` | Actual scene content: one chapter file per entry in `chapters_order`. Each chapter is an object with `chapter_id`, `scenes[]`. | yes |
| `bible.json` | World/render context (country, epoch, render_rules, narrator, etc.). | no |
| `locations.json` | Locations keyed by id. | no |
| `voices.json` | Voices keyed by id. | no |
| `behavior.json` | Per-character behavior keyed by `character_id`. Always written (starts as `{}`). | no (but present) |
| `characters.json` | Characters array. | no |

**Canonical id (`bookId`):** the value of `manifest.book_id`. Defined by the bundle, not by
PostgreSQL. PostgreSQL `books` table is a **derived ownership/audit record**, not the id source.

**Manifest version:** `vbook_version: "3.1"` at HEAD (bundle validator / draft / entity routes).

### 2.3 What is derived in PostgreSQL

These are **not** canonical for book content. They are derived / secondary / ownership state:

- `books` table — ownership, workspace, bookkeeping. Synced from/after bundle events, but `book_id`
  in PG must match the canonical `manifest.book_id`. PG does **not** originate canonical book data.
- `scenes` table — scene hash + version bookkeeping for asset/generation tracking. Derived from
  `book-source.getBookFingerprint()` / `book-sync` reconciliation. Not the scene content itself.
- `scene_assets`, `generation_tasks`, `image_units`, `storyboard_elements`, `audio_layers`,
  `asset_states`, `cache_entries` — runtime/audit artifacts keyed by book/chapter/scene.
- `book_source` — import source hash tracking (dedup). Not book content.
- `agent_sessions`, `agent_*` — import/bootstrap progress.

### 2.4 What is runtime/ephemeral

- Redis `animastor:runtime:*`, `animastor:vbook:*`, `animastor:chunk:*`, `animastor:active-scenes`,
  playback snapshots, scene cursors, progress markers, etc.
- In-memory book snapshots held by orchestration/runtime for dispatch windows.
- These can be rebuilt from the canonical bundle (possibly slowly). They are **not** canonical.

### 2.5 Manifest shape (canonical, current)

Current manifest (from `book/index.js` header + draft + entity routes + tests):

```json
{
  "book_id": "<canonical id>",
  "vbook_version": "3.1",
  "build_id": "<build id, default 'default'>",
  "state": "<BOOTSTRAPPED|ACTIVE|...>",
  "created_at": "...",
  "...render/import metadata..."
}
```

`manifest.book_id` is the **only** field that is required for a loadable bundle identity and is
enforced by `buildBookFromBundle()` and `validateBundleObject()`.

### 2.6 What is already a VBook contract vs implementation detail

**Already a contract (today):**

- Bundle file set + manifest `book_id` + `vbook_version` + `buildBookFromBundle` / `saveBookBundle` /
  `loadBook` / `resetBook` as the **canonical CRUD surface** for book content.
- Bundle validator (`bundle-validator.cjs`) as the **post-mutation, pre-write contract guard**.
- Canonical id format for chapters/scenes/units (`ch-`, `sc-`, `iu-` hex) enforced by validator +
  `buildBookFromBundle`.
- `book-source` as the **canonical scene existence / hash** abstraction layered on top of the
  bundle (read-only auditor in production; `reconcileFromDiff` primary path). This is the VBook
  → DB derived-bridge contract.

**Still implementation detail (today):**

- Internal split between `backend/src/book/index.js` and `backend/src/book/lazy-book/**` (draft /
  parse / status / create / metadata helpers). This split is a **backend implementation detail**,
  not a consumer contract.
- Which module physically writes which derived DB rows (book-sync, scene-asset-registry, etc.).
- Redis runtime bookkeeping shapes.

---

## 3. VBook Runtime Contract

### 3.1 Single conceptual entrypoint

Consumer-facing contract:

```
loadBook(bookId, options) -> book | null
```

`options` at minimum distinguishes **load intent**, not internal storage variation:

| option | meaning |
|---|---|
| `{ canonical: true }` (default) | canonical full book from disk bundle (`book.loadBook(bookId)`). Consumers that need real content use this. |
| `{ lazy: true }` | draft/lazy book (`lazyBook.loadDraftBook(bookId)`). Used by import/bootstrap/agent flows where the canonical bundle may not yet exist. |
| consumer-specific runtime/view options | **not introduced now**. If a real consumer-only projection is needed later, add it as a **separate named seam**, not by widening loadBook with private flags. |

**Existing reality:** many consumers already call `book.loadBook(bookId)` directly, and two
AI/chat paths already use `book.loadBook(bookId) || lazyBook.loadDraftBook(bookId)` as a
**two-tier fallback** (canonical → draft). That fallback is **documented behavior**, not a new
invention — Phase 2 records it as part of the contract: *canonical-first, draft as fallback for
import/agent/chat context paths that legitimately need a book instance even before canonical
materialization*.

### 3.2 Facade / adapter

At Phase 2 we do **not** rewrite all consumers. The contract is enforced by:

1. A documented canonical surface: `book.loadBook`, `book.saveBookBundle`, `book.resetBook`,
   `book.extractBookBundle`, `book.buildBookFromBundle`, `book.collectScenes` / `collectSceneList`.
2. `book-source` as the **canonical read/validity seam** for DB-side consumers (`loadBookJson`,
   `getCanonicalScenes`, `sceneExists`, `assertSceneExists`, `getBookFingerprint`, `listScenes`).
3. Architecture tests that verify consumers don't bypass the canonical seam where a seam already
   exists and is cheap to guard.

### 3.3 Load semantics (lazy vs full)

- **Full/canonical** = what is on disk under `BOOKS_DIR`. This is the stable, exportable, releasable
  book. Player/export/editor content reads ultimately resolve here.
- **Lazy/draft** = in-progress import/bootstrap state. It exists only until canonical materialization.
  It is **not** a stable public book; it is an **ingress/construction** state.

The contract requirement: **no consumer may assume lazy state is canonical**, and **no consumer may
write canonical content through lazy paths**. Writers go through `saveBookBundle`; readers go through
`loadBook` (canonical) or documented draft seams for import/agent flows.

---

## 4. Book Ownership Boundary

### 4.1 Who owns canonical Book

**Owner:** `backend/src/book` (canonical persistence) + the **disk bundle** itself. The book module
is the **canonical book CRUD authority**. PostgreSQL does not own canonical content; it mirrors/
derives/consumes it.

### 4.2 Who can read

- Backend services/routes via the canonical seam (`book.loadBook`, `book-source`).
- Consumers (Player, Editor, AI context paths) via routes that ultimately go through the canonical
  load or documented fallback.
- GPU Hub does **not** read the book bundle directly — it receives **dispatch identity fields**
  (book_id/chapter_id/scene_id/stage) authored by the backend dispatcher.

### 4.3 Who can modify

- **Canonical writes:** `book.saveBookBundle` (import bundle, editor save, re-import). Only paths
  that own the edit go here.
- **Derived/ownership writes:** PostgreSQL rows via repositories/book-sync/ownership middleware.
  These may change **derived** state but must not invent canonical content.

### 4.4 Who works only with derived representation

- GPU Hub: knows `book_id` etc. only as **envelope fields** from the backend.
- Orchestration/runtime dispatch: uses scene identity + derived runtime state, not direct storage
  of canonical content.
- Frontends: consume API projections, never disk bundle directly.

### 4.5 Who must not reach directly into storage

- **Frontends** must not read/write `BOOKS_DIR` — they go through API.
- **GPU Hub** must not access backend filesystem/PG for book content — it is transport/orchestration.
- **Worker** must not access backend storage — it is execution only, HTTP to hub.
- **AI routes** that need a book for context go through the documented canonical/draft fallback seam
  — they do **not** invent a new book-storage access path.

### 4.6 Current gap (documented, not fixed in Phase 2)

Today many backend consumers call `book.loadBook(bookId)` directly. That is **fine** as long as they
stay on the canonical seam. The **gap** is that there is **not yet a hard formal gate** preventing a
future consumer from reading raw disk JSON outside `book.loadBook` or from mixing canonical content
with derived PG identity. Phase 2 records this as a gap and adds the **cheap available guardrails**
(contract tests + seam documentation), not a big refactor.

---

## 5. Local AI Connector Contract

### 5.1 Two transports, strictly separated

**Transport A — Backend → Local AI Connector → User's local model**

```
backend (cloud)
  → WebSocket (outbound from connector)  # connector dials backend, never inbound
  → Local AI Connector (standalone CLI, ws-only dep)
    → local runtime adapter (allowlist: GET {base}/v1/models, POST {base}/chat/completions)
      → user's local model (Ollama / vLLM / llama.cpp / LM Studio / openai-compatible)
```

- Connector identity: `connector_id` + `workspace_id` derived **only** from credential /
  registration token (hash-only, timing-safe). Never from client query/body.
- One live session per connector (replacement closes old with `replaced`).
- Liveness: WS heartbeat + Redis mirror `animastor:ai-connector:hb:<id>` (TTL 45s) + PG
  `ai_connectors.status` (online while live session registered).
- Cloud never touches runtime URL — connector fetches only its local config base (AD-5).

**Transport B — Backend → Provider Gateway → external/cloud provider**

- Separate path: `services/ai-service.js` / workspace provider resolution / OpenRouter/global key.
- This path does **not** go through the LAC WS session, does **not** use connector snapshots, and
  does **not** carry `transport:'connector'`. It is a **different transport** and must stay separate.

These two are **not** interchangeable. A connector snapshot is not a cloud provider; a cloud provider
is not a connector.

### 5.2 Connector contract

**Protocol version:** 1 (LAC v1).

**Authenticated WS surface (connector-facing, cloud → connector):**
- `hello` { protocol_version, credential|reg_token } — exactly one auth mode, fail-closed.
- `ready` { connector_id, heartbeat_interval_ms, server_time, credential?, credential_prefix? } —
  credential disclosed exactly once on activation.
- `chat.request` { request_id, model, messages, params, timeout_ms, params.stream? } — sent **only**
  by transport service, cloud-generated `request_id`, no URL.
- `chat.cancel` { request_id } — authoritative cloud timer expiry / consumer abort.

**Connector → cloud surface:**
- `heartbeat` { models[], capabilities{tools,vision,context}, runtime_ok, latency_ms, runtime{type,version} }
- `models.list` { models[] | error_code } — reply to `models.refresh`.
- `chat.delta` { request_id, delta } — Phase 5 streaming increment (text only, transport-validated).
- `chat.response` { request_id, model, content, finish_reason, usage }
- `chat.error` { request_id, code, message } — allowlisted codes only.

**Inference contract (connector-side):**
- `chat.request` → `POST {base}/v1/chat/completions` with `stream:false` (non-streaming default) or
  `stream:true` (Phase 5).
- Limits enforced on **both sides**: model length, message count/size, total prompt size, max_tokens,
  temperature, response size, delta size, streamed content cap.
- Timeout: cloud timer authoritative; on expiry sends `chat.cancel`, connector aborts local fetch.
- Cancellation: consumer `AbortSignal` → `chat.cancel` downstream → sanitized `cancelled`.
- Errors: allowlisted `chat.error` codes; unknown → `runtime_error`. No raw runtime detail leaks.
- Session-bound request correlation: reply accepted only for the session that sent the request.

### 5.3 Response / errors / timeout / cancellation (contract)

- Success: `{ ok:true, content, finishReason?, usage?, model, requestId }`.
- Failure: `{ ok:false, code, message }` — **sanitized**, fixed strings by code, never raw runtime
  content/URL/credentials.
- Timeout: `code:'timeout'`.
- Cancellation: `code:'cancelled'`.
- Session closed before completion: `code:'session_closed'`.
- Connector offline at call time: `code:'connector_offline'` (fail-closed; never silent fallback).

### 5.4 Shared-pool lifecycle (connector-backed provider availability)

Shared pool (`services/ai-connector/shared-pool.js`) rides the **same connector transport**. Its
contract:

- **Selection** (`selectSharedAI` / `resolveSharedAI`): deterministic V1 "first eligible endpoint"
  from repo `listSharedEndpoints()`, with eligibility ladder: sharing on, endpoint on, connector live
  (authoritative WS liveness — PG status is a stale trace, never consulted), not revoked, non-owner
  workspace (V1 public mode), runtime_ok (fail-honest), model present in discovered, concurrency slot
  available.
- **Snapshot shape:** `source:'shared', transport:'connector', provider:'local-ai', shared:{...},
  connectorId, endpoint:null, apiKey:null, model, workspaceId, purpose?`. **No runtime URL, no
  credentials.**
- **Reservation:** per-inference `reserveSharedInference` → slot acquired → inference → **always**
  `releaseSharedAI` in finally. Shared snapshot resolution-held slot is **not** used for the wired
  consumer flow (it cannot survive resolver cache / multi-call pipelines).
- **No-slot leak guarantee:** every shared inference path releases in `finally`; on connector error,
  timeout, cancellation, session disconnect — `connectorChat` settles and the finally still runs.
- **Non-shared / private snapshot:** no pool interaction; direct transport.
- **Invalid snapshot:** `shared_unavailable`.

### 5.5 Connector-backed provider availability (contract)

A shared endpoint is **available** only when **all** of: policy enabled, endpoint enabled, connector
live (WS), not revoked, runtime_ok, model present in discovered, concurrency slot available. A
previously-eligible endpoint can become unavailable mid-resolution only by one of those becoming false;
the eligibility check is re-evaluated per selection (not cached), and the concurrency slot is taken
per inference.

---

## 6. Shared Pool Contract

### 6.1 Reserve / execution / release / timeout / disconnect / failure / concurrency

| Phase | Contract |
|---|---|
| reserve | `reserveSharedInference(snapshot)` checks owner concurrency_limit vs in-flight count; on success acquires one slot and returns `{ok:true}`; on full returns `{ok:false, code:'busy'}`. Non-shared snapshot → no-op `{ok:true}`. |
| execution | `runSharedInference` calls `connectorChat` (same transport as private path). Streaming when `onDelta` present. Result enriched with safe provenance `shared:{endpointId, endpointName}` on success. |
| release | `releaseSharedAI(snapshot)` decrements slot; release is idempotent-safe and always in `finally`. Slot counter resets on negative (no leaked positive after correct release). |
| timeout | Cloud timer authoritative; on expiry `chat.cancel` + `cancelled`/`timeout`; finally still releases slot. |
| disconnect | Dying session → `failPendingFor(session)` settles pending requests with `session_closed`; slot still released via finally because settle + finally both run. |
| failure | Connector error / `chat.error` settles request; finally still releases slot. Streaming-after-delta failure → `stream_failed`. |
| concurrency semantics | In-process per-endpoint slot counter (Map). Simple gate, not a scheduler. Overflow → "not eligible right now", never wait. Backend restart clears map (fail-safe: a leaked slot only makes pool more conservative until restart). |

### 6.2 No-stuck-slot guarantee

The critical invariant: **a connector request that completed (success/error/timeout/cancel/disconnect)
must not leave the slot occupied.** This is guaranteed by:

- `runSharedInference` wrapping the transport call in `try/finally { releaseSharedAI(snapshot) }`.
- `connectorChat` always settling (never leaving pending unresolved) — timeout, cancel, session close,
  chat.response, chat.error all settle.
- `releaseSharedAI` tolerating missing/partial snapshot fields safely.

Phase 2 adds a contract test that stresses this lifecycle (see Part D, shared-pool lifecycle).

---

## 7. GPU Hub / Worker Contract

### 7.1 Chain formalization

**Backend → GPU Hub → Worker**

```
backend (dispatcher)
  → POST /task  (api-key authenticated; backend-authored identity fields in envelope)
    → GPU Hub (transport/orchestration boundary; Redis-backed queues/running/heartbeat/registry)
      → worker pops via GET /task/next (Bearer credential, token-derived identity)
        → worker executes (execution boundary; ComfyUI/local runtime)
          → POST /task/result  or  POST /task/error  (claimer-only, credential required)
```

**Worker → GPU Hub**

```
worker
  → POST /beacon      (credential; registry + heartbeat write)
  → GET  /task/next   (credential; lane-scoped pop, claim write)
  → POST /task/result  (credential; claimer-only finish)
  → POST /task/error   (credential; claimer-only error)
```

### 7.2 Role separation (semantic contract)

- **GPU Hub = transport/orchestration boundary.** It does not own book-generation business logic.
  It validates envelope shape, enforces protocol version, manages queues/running/heartbeat/registry,
  does claimer-only result/error, and **forwards** results/errors to backend. Book-identity fields
  in the envelope are **backend-authored**; the hub validates shape but does not originate them.
- **Worker = execution boundary.** It does not become a backend module. It holds no PG/redis direct
  access, no backend code deps. It owns local runtime execution (ComfyUI) + artifact I/O + hub HTTP
  lifecycle. Identity/mode/worker_type come **from the registry**, not from the worker's own choice.

### 7.3 Task envelope (current, pinned)

Current `/task` required identity fields (today's `incomplete_dispatch_identity` check):

`dispatch_id`, `build_id`, `book_id`, `chapter_id`, `scene_id`, `stage`.

Transport-level optional routing fields: `workspace_id`, `policy_id`, `timeout_ms`, `protocol_version`,
`job_id`, `params`, `assets`, `job_type`.

**Phase 2 notes this as current coupling core:** hub today must know book identity fields because the
envelope carries them. This is **documented**, not changed. Future `payload.meta` extraction (Phase 5)
is noted as a future opportunity, not done now.

### 7.4 Worker identity

Worker identity comes **only** from Bearer credential `wrk.<worker_id_b64url>.<secret_b64url>`,
resolved via Redis mirror `animastor:worker-auth` (SHA-256 of secret → identity JSON). `worker` /
`type` query params are **labels only**, never identity. Hub fails closed: missing/invalid credential
→ 401, never SYSTEM/SHARE.

### 7.5 Protocol version

`PROTOCOL_VERSION = 2` in all three synced copies (backend `job-schema.js`, `gpu-hub/gpu-hub.js`,
`worker/worker/worker.cjs`). Mismatch → 409 on hub entry points; worker rejects mismatched tasks.
Not changed in Phase 2.

### 7.6 Endpoints (current, pinned)

Hub contract routes:

- `POST /beacon`
- `POST /task`
- `GET /task/next`
- `POST /task/result`
- `POST /task/error`
- `DELETE /queue/clear`

(Delivery surface `/worker-bundle*`, `/workflow/:id`, `/installer*`, `/health` is pinned but not
part of the **job-protocol** contract.)

Worker consumes: `/beacon`, `/task/next`, `/task/result`, `/task/error`.

Backend dispatcher sends: `POST /task`.

### 7.7 Auth / heartbeat / result-error lifecycle

- Auth: Bearer credential only. Token parsed → secret hash → Redis mirror lookup → identity. Cross-check
  token's self-locator vs mirror. `mode` + `workspace_id` derived from mirror (private/share/system).
- Heartbeat: hub writes `animastor:worker:heartbeat:<type>:<worker_id>` (TTL 30s) on beacon/claim/
  result; backend `worker-health` reads. (Ownership note: hub owns heartbeat keys; backend reads — see
  Part C.)
- Result/error lifecycle: claimer-only. Running record bind worker+workspace. On result: write
  `animastor:result:*` (TTL 1h), clear running + processing + dedup, forward to backend with retry,
  clear busy heartbeat. On error: forward to backend with retry, fallback `animastor:error:{job_id}`
  (TTL 1h). Claimer check + lane match enforced on both.

### 7.8 Not transferred

Phase 2 explicitly does **not** move business logic between hub and worker. If later phases need
book-identity decoupling, that is a future extraction (see Part E), not this phase.

---

## 8. Job Protocol v2

### 8.1 Status

`protocol_version = 2`. Not changed in Phase 2. Three synced copies (backend job-schema, gpu-hub,
worker) pinned by existing `gpu-hub-contract.test.js`. Phase 2 adds a contract test that re-anchors
the protocol boundary as a **Phase 2 consumer boundary** (see Part D, Job Protocol v2).

### 8.2 Format

`job_id = ${assetId}:${type}` where `type ∈ {audio, image, iu_image, video}`, parsed from the end.
Current shape families (from `job-schema.js`):

- audio chunk: `{bookId}_{chapterId}_{sceneId}_{NNNN}:audio`
- IU image: `{bookId}_{chapterId}_{sceneId}_{iuId}:iu_image`
- scene image: `{bookId}_{chapterId}_{sceneId}:image`
- video: `{bookId}_{chapterId}_{sceneId}[_gN]:video`

`bookId` may contain `_`; chapter/scene/index/iuId may not → parse from end.

### 8.3 SYNC copies

- Canonical: `backend/src/runtime/job-schema.js` (full `parseJobId`).
- Hub: `gpu-hub/gpu-hub.js` (simplified copy; splits type suffix with same anchored family; result key
  embeds identity segments).
- Worker: `worker/worker/worker.cjs` (splits `/:(iu_image|image|audio|video)$/`).

Changing the format requires updating all three. That is **future work**, not Phase 2.

---

## 9. Redis Ownership

### 9.1 Ownership table (Phase 2 view)

Phase 2 does not change Redis protocol. It documents ownership/writers/readers/contract using the
existing Phase 1 registry (`tests/architecture/redis-registry.js`) and the audit findings, and adds
the **dangerous places** explicitly.

**Legend:** Owner / Writers / Readers / Contract

| Redis area / key family | Owner | Writers | Readers | Contract |
|---|---|---|---|---|
| `animastor:worker-auth` | backend (`services/worker-auth.js`) | backend (only worker-auth.js) | gpu-hub (mirror read) | Token-hash → worker identity mirror. PG is source of truth; mirror rebuilt on startup + periodic. Hub reads for hot path. Only worker-auth.js may write. |
| `animastor:worker:heartbeat:*` | gpu-hub (beacon/claim/result authoring) | gpu-hub + **backend debt** (worker-routes purge del; worker-health legacy write kept) | backend (worker-health reads) | Hub-authored heartbeat payload with scope fields (workspace_id/mode/version). Backend counts capacity from public markers. DEBT: backend writes this family — documented, Phase 5 routes through hub API. |
| `animastor:gpu-hub:workers` | gpu-hub | gpu-hub + **backend debt** (worker-routes purge hdel) | backend (reads registry) | Hub worker registry (hash, TTL 15min). DEBT: backend purge mutates hub-owned registry — documented, Phase 5 hub API. |
| `animastor:queue:*` (system + ws + policy lanes) | gpu-hub | gpu-hub + **backend debt** (worker-routes `drainPolicyLane` RPOPLPUSH + task-body mutation) | gpu-hub | Hub owns job lanes. DEBT: backend drains policy lanes on stop/revoke and mutates task bodies — documented, Phase 5 hub API. |
| `animastor:processing` / `running` / `processing-claimed` / `dead-letter` | gpu-hub | gpu-hub | gpu-hub (backend does not own these) | In-flight/claim/orphan/dead-letter bookkeeping owned by hub. |
| `animastor:job:*` (enqueue dedup) | gpu-hub | gpu-hub + **backend deliberate del** before re-dispatch (iu-processor, audio/video-orchestrator, scene-restoration, entity-cleanup, generation/debug routes) | backend, gpu-hub | Hub-owned dedup; backend deliberately clears before legitimate re-dispatch — documented intentional cross-module contract, Phase 5 hub API. |
| `animastor:result:*` / `animastor:error:*` | gpu-hub | gpu-hub | backend (consumes), gpu-hub | Result/error handoff from hub to backend. Backend also cleans stale blobs during purge (cleanup, not authorship). |
| `animastor:runtime:*` / `animastor:runtime:active` / `animastor:dispatch-*` / chunk/snapshot/locks/... | backend | backend | backend | Backend-internal runtime/orchestration state. Not hub-owned. |
| `animastor:vbook:*` / `animastor:vbook-scene-idx:*` | backend | backend (agent pipelines, vbook export state) | backend | VBook export/agent-pipeline cursor state, backend-owned. |
| `animastor:ai-connector:hb:*` | backend (ai-connector-routes) | backend | backend | LAC liveness mirror on backend (TTL 45s). LAC itself talks WS only, not Redis. |
| shared-pool in-process state (`services/ai-connector/shared-pool.js` inflight Map) | backend (in-process) | backend | backend | Per-endpoint concurrency slot map. Not Redis. Backend restart clears it (fail-safe). |
| LAC in-process state (`services/ai-connector/registry.js` sessions Map, `transport.js` pending Map, `discovery.js` pending Map) | backend (in-process) | backend | backend | LAC session/request/discovery state is in-memory only; not Redis. LAC itself is WS-only client. |

**Components:** `backend`, `gpu-hub`, `worker`, `local-ai-connector`. Frontends never touch Redis.

### 9.2 Dangerous places (documented, not changed)

1. **Backend writes worker heartbeat, Hub reads.**
   - Family: `animastor:worker:heartbeat:*`. Owner = gpu-hub; backend has legacy writes (`worker-health
     .reportHeartbeat`, worker-routes purge `del`).
   - Contract: hub is the production author; backend reads for capacity panel. The legacy write is
     documented debt; Phase 5 routes through hub API.

2. **Backend works with worker-auth.**
   - Family: `animastor:worker-auth`. Owner = backend; **only** `services/worker-auth.js` may write.
   - Contract: hub reads mirror for hot path; worker-auth.js is the auth boundary. This is **not** a
     gap — it is an explicit backend-owned auth mirror with a single writer guard (enforced by existing
     `redis-ownership.test.js`).

3. **Backend mutates policy queues via `drainPolicyLane`.**
   - Family: `animastor:queue:*:policy:*` (and related `animastor:queue:*`). Owner = gpu-hub; backend
     mutates on policy stop/revoke.
   - Contract: documented debt; backend drains the lane when a policy stops; hub orphan-requeue uses the
     policy stamp. Phase 5 replaces with hub API.

4. **Book DELETE touches runtime Redis active state.**
   - Book deletion (`book.resetBook`) removes the canonical disk bundle. Runtime Redis keys that reference
     the book (chunks, active scene cursors, vbook export state, generation cancel markers, etc.) are
     **not** canonical and may become stale. Today some cleanup paths exist (redis-helpers purge, entity
     cleanup, generation cancel flags), but a full active-state invalidation on book delete is **not**
     guaranteed atomically.
   - Contract: book delete is canonical-content removal; derived/runtime state is best-effort cleaned.
     This is a documented gap (Phase 5/6), not a Phase 2 fix. No Redis protocol change.

---

## 10. Current Gaps / Technical Debt

1. **Book ownership boundary is documented but not hard-gated everywhere.** Many consumers call
   `book.loadBook` directly (acceptable on seam); there is no universal block on raw-disk JSON access
   outside the seam without a refactor. Recorded as a gap; cheap guardrails added.
2. **GPU Hub envelope carries book-identity fields today.** This is current coupling core. Not changed
   in Phase 2; future `payload.meta` extraction noted.
3. **4 queue-clear copies + cross-owner Redis writes** still exist (Phase 1 baseline). Documented as debt;
   Phase 5 removes via hub API. Not touched in Phase 2.
4. **Book DELETE / runtime Redis active state** invalidation is best-effort, not atomic. Documented gap.
5. **runtime SQL outside repositories** still exists (Phase 1 baseline). Not touched in Phase 2.
6. **orchestration ↔ runtime cycle** still exists (Phase 1 baseline). Not touched in Phase 2.
7. **LAC + workspace provider resolution** are getting tighter (recent commits). Contract still holds
   (two transports separated), but the boundary deserves watching in future phases.
8. **Shared-pool slot lifecycle** is correct by construction today, but not yet covered by a dedicated
   lifecycle contract test — added in Phase 2 (cheap, existing seams).

---

## 11. Future Extraction Opportunities

These boundaries are **potential independent products/packages later**, without extraction now:

- **VBook Runtime** — canonical bundle CRUD + manifest + validator + collectScenes as a stable runtime
  library. Consumers (Player/Editor/AI) would depend on the VBook contract, not on backend internals.
- **Player** — the playback/consumption projection of a VBook (chunks, snapshots, scene list). Could
  become its own package sitting on top of VBook Runtime.
- **Editor** — the book-editing contract (load → mutate → saveBundle + derived PG sync). Could become its
  own package with a clear canonical-write boundary.
- **Local AI Connector** — already mostly standalone (`ws` only, distributable CLI). Could become a
  first-class external package/client with the LAC contract formally published.
- **Worker** — already standalone (HTTP to hub, no backend deps). Could become its own distributable with
  the Job Protocol v2 + hub contract as its interface.

None of these are extracted in Phase 2. They are flagged as **future opportunities** only.

---

## 12. How to run

```bash
cd backend && npm run test:arch
cd backend && npm test
cd backend && npm run test:syntax
```

Phase 2 adds:

- `tests/architecture/phase2-vbook-contract.test.js`
- `tests/architecture/phase2-lac-transport-contract.test.js`
- `tests/architecture/phase2-shared-pool-lifecycle.test.js`
- `tests/architecture/phase2-job-protocol-v2.test.js`
- `tests/architecture/phase2-hub-worker-boundary.test.js`

These are written to be **resilient to internal refactors**: they check behavior/contract where possible
and reserve source-inspection only for dependency/protocol-version anchor guardrails (same discipline
as Phase 1).
