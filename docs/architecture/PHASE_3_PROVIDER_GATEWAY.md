# Phase 3 — Provider Gateway Contract & Facade

**Status:** active (architecture boundary documentation + facade + guardrails)
**Date:** 2026-09-04
**Parent plan:** `MODULAR_PRODUCT_ARCHITECTURE_FINAL_REVIEW.md` §6
**Prerequisite:** Phase 2 contracts active (`docs/architecture/PHASE_2_CONTRACTS.md`).
**Phase rule:** boundary only. No runtime behavior change, no protocol change
(LAC v1, Job Protocol v2, GPU Hub API, Redis ownership untouched), no consumer
mass-migration, no ComfyUI workflow rewrite.

> **Provider Gateway — это логическая модульная граница внутри modular monolith,
> а не отдельный microservice.** Это facade-модуль и набор контрактов; он не
> разворачивается, не слушает сеть и не владеет состоянием.

---

## 1. Purpose

Phase 1 froze coupling growth; Phase 2 fixed the VBook and Local AI Connector /
Worker / Hub contours. Phase 3 formalizes the third contour already visible in
the code: **AI provider access**. The codebase has three different provider
directions with genuinely different semantics:

| Direction | Protocol | Transport | Consumer |
|---|---|---|---|
| **Agent** (`callAI`) | non-streaming JSON (`stream:false`) | cloud HTTP (safeFetch + SSRF guard) or connector WS via shared-pool | agent pipeline steps (`services/agent/*`) |
| **Chat** | SSE (`text/event-stream`) + tools + cancellation | cloud HTTP (non-streaming upstream re-emitted as one delta) or connector WS via shared-pool | browser/Android (`/api/v1/ai/chat`, `/api/v1/ai/chat/stream`) |
| **Generation** | ComfyUI workflow job (Job Protocol v2) | GPU Hub HTTP (`POST /task`) via gpu-dispatcher | audio / image / video generation domain |

These are **three explicit contracts**, not one universal API. There is
deliberately **no** `provider.generate(...)` method that mixes JSON
completions, SSE streaming and GPU job dispatch — merging them is forbidden by
the Phase 1 guardrails (see `tests/architecture/chat-transport.test.js`).

## 2. Provider Gateway boundary

The gateway is one facade module:

```
backend/src/services/provider-gateway.js
```

with a provider-specific seam module:

```
backend/src/generation/comfyui-provider.js
```

Structure:

```
ProviderGateway (services/provider-gateway.js)
├── resolve      — provider resolution seam (transport-independent)
├── agent        — AgentProvider contract
├── chat         — ChatProvider contract
└── generation   — GenerationProvider contract
                    └── comfyui — ComfyUIProvider seam
```

The facade **delegates only** — it reimplements nothing. Existing
implementations stay in place:

- agent → `services/ai-service.js` + `services/agent/ai-caller.js`
- chat → `routes/ai-routes.cjs` (transport) + `services/ai-connector/shared-pool.js`
- generation → `runtime/gpu-dispatcher.js` + generation domain modules

Guardrail tests: `backend/tests/architecture/phase3-provider-gateway.test.js`.

## 3. Agent Provider contract

Entry: `ProviderGateway.agent.callAI(messages, options, provider)`
→ `{ content, finishReason, usage }`.

- **non-streaming**: the upstream request is `stream:false`;
- **JSON result**: the caller receives a parsed JSON object (or uses
  `agent.parseJsonResponse` for fenced/reasoning-wrapped output);
- **no SSE** — no `text/event-stream`, no delta frames;
- **no chat-specific tools lifecycle** — no `tools`/`tool_choice`, no
  `edit_book` handler loop, no session persistence;
- **retries live above the seam**: `ai-caller.callAI` applies `STEP_RETRIES`
  and the AsyncLocalStorage provider context (`runWithProvider`);
- connector snapshots ride the shared-pool reservation-aware entry and **fail
  closed** with sanitized errors — never a silent system-AI fallback;
- no callAI-level retry of connector calls (cold model loads legitimately
  take 30–60 s; LAC §16.2).

Consumers: `services/agent/*` (bootstrap, pipeline steps, parallel analysis),
`refineDraft`, `checkAIHealth`.

## 4. Chat Provider contract

Transport owner: `routes/ai-routes.cjs` (`/api/v1/ai/chat`,
`/api/v1/ai/chat/stream`). The gateway exposes the pieces a chat consumer
needs without importing route internals
(`ProviderGateway.chat.*`):

- **request id / correlation**: connector transport correlates every request
  (`request_id`, LAC v1 frames `chat.request` / `chat.cancel` /
  `chat.delta` / `chat.response` / `chat.error`); sessions are persisted in
  PG (`ai_chat_sessions`), failed turns included (survive a reload);
- **timeout**: cloud timer authoritative, `AI_FETCH_TIMEOUT_MS` = 180 s on the
  routes; stream route accepts a client `timeout_ms` clamped to the same
  ceiling; on expiry → `chat.cancel` downstream → sanitized `timeout`;
- **AbortSignal / cancellation**: client disconnect (`res 'close'`) →
  `AbortController.abort()` → `chat.cancel` → local runtime abort → shared
  slot released by the transport's `finally`. No pending request and no
  shared slot survives any failure path;
- **SSE**: `text/event-stream`, frames `meta` → `delta`×N → exactly one
  terminal `done` XOR `error`; heartbeat comments keep proxies alive during
  cold loads;
- **tools**: mode-scoped (`getToolsForMode` — `edit_book` only when unlocked),
  `tool_choice:auto`, high token budget with tools, content-embedded tool
  call extraction, validated patch application (`applyPatchesValidated`);
- **connector transport**: `ai.transport === 'connector'` branch — no
  server-side URL/key (AD-5); a binding without a usable model fails closed
  (`local_ai_not_ready`);
- **shared-pool**: SHARED snapshots (source `shared`) reserve/release the
  per-inference slot via `runSharedInference`; the resolver stage is never
  cached;
- **sanitized errors**: `connector_offline`/`shared_unavailable`/`busy` → 503,
  `timeout`/`cancelled` → 504, others → 502 with fixed messages
  (`describeSharedError`); raw runtime errors, URLs and credentials never
  cross;
- **request correlation / ai_source**: safe tokens only —
  `private-local | shared | cloud | system` (`chat.sourceToken`).

Gateway surface: `chat.resolveProvider(bookId, { fallbackBaseUrl })`,
`chat.sourceToken(ai)`, `chat.runSharedInference(...)`,
`chat.describeSharedError(code)`, `chat.SSE_EVENTS`,
`chat.SOURCE_TOKENS`, `chat.DEFAULT_TIMEOUT_MS`.

**Chat and callAI are not merged.** Test 3 (transport separation) fails on
any cross-wiring.

## 5. Generation Provider contract

Entry: `ProviderGateway.generation.sendJob(taskSpec)` →
`{ sent, jobId?, error? }`, with `generate(request)` on the ComfyUI seam.

- request is a **Job Protocol v2** job spec (`job_id`, `params` = built
  workflow JSON, `job_type ∈ {audio,image,video}`, `build_id`,
  `dispatch_id`);
- dispatch goes through `runtime/gpu-dispatcher.sendUnified` → GPU Hub
  `POST /task` (server-derived workspace lane / policy lane / system pool;
  routing is backend-authored — callers cannot inject `workspace_id`);
- per-type timeouts and retry budget are the dispatcher's, unchanged;
- **ComfyUI-specific details (workflow JSON, node ids, payloads) are NOT part
  of the Agent/Chat contracts** — they live in the generation domain and
  behind the ComfyUIProvider seam (§9);
- generation must not import the LLM transports (`ai-service`, `ai-caller`,
  `chat-engine`, connector shared-pool/transport) — Test 4 guards this.

## 6. Provider resolution

Resolution is **separated from transport**:

```
request
   ↓
provider resolution (ProviderGateway.resolve / workspace-ai-provider)
   ↓
Agent / Chat / Generation direction
   ↓
конкретный transport (cloud HTTP | connector WS | GPU Hub)
```

`ProviderGateway.resolve` delegates to `services/workspace-ai-provider.js`
(the existing 3-stage chain, byte-identical):

1. `workspace_ai_providers` row (cloud or `local-ai` connector binding);
2. **shared pool** (slotless selection, never cached);
3. gated system fallback (admin kill switch enforced);
4. fail closed (`none` / `unconfigured`).

Chat-specific normalization (`resolveChatProvider`) moved verbatim from
`routes/ai-routes.cjs` into the gateway: connector snapshots get the first
DISCOVERED model when none is bound, cloud snapshots keep the
workspace/env model chain, `validatePublic` is set only for user-controlled
workspace endpoints (SSRF guard). The route now delegates to the gateway —
one consumer rewired as the demonstration of the seam; **no other consumers
were migrated**.

**Current coupling (documented, not rewritten):** the resolver internally
consults the shared pool and system-ai — that dependency is intentional and
pinned; a future scheduler replaces `selectSharedAI` without touching this
seam (Phase 2 contract).

## 7. Local AI Connector relationship

- LAC protocol v1 is **unchanged** (frames, limits, identity rules — Phase 2
  contract §5).
- The connector transport (`ai-connector/transport.js`) is the ONLY place
  that turns a chat request into `chat.request` / `chat.cancel` frames.
- The gateway never speaks to the connector directly: Agent and Chat both go
  through `shared-pool.runSharedInference`, which owns the slot lifecycle and
  the sanitized code surface (`connector_offline`, `session_closed`,
  `timeout`, `cancelled`, …).
- Provider resolution may produce a connector snapshot, but the decision of
  WHICH transport executes a snapshot stays inside each direction's branch
  (`provider.transport === 'connector'`).

## 8. Shared Pool relationship

- Shared-pool semantics are **unchanged**: eligibility ladder, deterministic
  V1 selector, per-inference slot lifecycle, never-cached snapshots (Phase 2
  contract §6).
- The pool is reached from TWO directions — Agent (connector branch of
  `callAI`) and Chat (connector branch of both chat routes). It is **not** a
  third transport and not chat-specific; the gateway exposes it to Chat as
  `chat.runSharedInference` for convenience and keeps it addressable
  directly where Phase 2 consumers already use it.
- Pool failure degrades honestly (sanitized codes), never to a silent
  system-AI substitution (AD-12).

## 9. ComfyUI boundary

**Home of ComfyUI knowledge today:**

| Knowledge | Location |
|---|---|
| Workflow loading + connector (node-id/field) mapping | `workflows/workflow-loader.js`, `workflows/connector-loader.js` |
| Audio TTS workflow names + **raw node ids** (`"108"`, `"71"`, `"80"`, `"82"`, `"74"`, clone prompts `73/81/83`) | `audio/generation.js` — **documented leak** |
| Image workflow (`img-qwen-image`) + value application | `image/connector-utils.js`, `image/iu-processor.js` |
| Video LTX workflow family + group building | `workflows/video/video-workflows.js`, `video/video-service.js` |

**Seam created (not a rewrite):** `backend/src/generation/comfyui-provider.js`
exposes `PROVIDER_NAME`, `WORKFLOW_NAMES` (narration/dialogue/image/video
family), `loadWorkflow`, `getConnector`, `getWorkflowHash`, `generate`
(dispatch via `sendUnified`) and `buildJobId`. It is the single
provider-specific entry future refactors plug into; Phase 3 does NOT migrate
the existing `gpu.send` / `wfLoader` call sites.

Test 6 pins the leak: `wfAudio["108"]` must stay inside `audio/generation.js`
and must never appear in the LLM contract files.

## 10. Error / timeout / cancellation semantics

| Direction | Timeout | Cancellation | Errors |
|---|---|---|---|
| Agent | per-call `options.timeout` (default 60 s; pipeline default 180 s); no connector retry | not part of the contract (pipeline steps are synchronous request/response) | sanitized: connector codes via `describeSharedError`; 4xx surfaced verbatim-shape (`AI API error (4xx)`); fail closed when no provider |
| Chat | `AI_FETCH_TIMEOUT_MS` (180 s), client `timeout_ms` clamped; cloud timer authoritative → `chat.cancel` | `res 'close'` → AbortSignal → `chat.cancel`; shared slot released in `finally` | sanitized only: fixed messages + allowlisted codes; exactly one terminal SSE frame |
| Generation | per-type dispatcher defaults → `config.GPU_TIMEOUT_MS` | dispatch-scope cancellation (in-flight markers, Job Protocol v2) | `{ sent:false, error }` / hub error callbacks — no LLM error surface |

## 11. Current implementation mapping

| Gateway surface | Delegates to |
|---|---|
| `resolve.forWorkspace / forBook / byPurpose / systemFallback` | `services/workspace-ai-provider.js` |
| `agent.callAI / parseJsonResponse / checkAIHealth` | `services/ai-service.js` |
| `agent.callForPipeline / runWithProvider / getActiveProvider` | `services/agent/ai-caller.js` |
| `chat.resolveProvider / sourceToken` | gateway-owned (moved verbatim from `routes/ai-routes.cjs`) |
| `chat.runSharedInference / describeSharedError` | `services/ai-connector/shared-pool.js` |
| `generation.sendJob` | `runtime/gpu-dispatcher.sendUnified` |
| `generation.comfyui.*` | `workflows/workflow-loader.js`, `runtime/job-schema.js`, `runtime/gpu-dispatcher.js` |
| Chat transport (SSE/tools/session) | `routes/ai-routes.cjs` + `services/chat-engine.cjs` (unchanged owner) |

## 12. Current gaps / technical debt

1. **ComfyUI raw node knowledge in `audio/generation.js`** (`wfAudio["108"]`,
   static node ids `71/80/82/74/73/81/83`) — pinned by test, to be moved
   behind `ComfyUIProvider` in a later phase (requires workflow-assembly
   refactor, out of Phase 3 scope).
2. **Generation call sites bypass the seam**: `audio/generation.js`,
   `image/iu-processor.js`, `orchestration/scene-orchestrator.js` call
   `gpu.send`/`gpu.sendUnified` directly; `image/iu-processor.js` calls
   `wfLoader.getWorkflow` directly. Migration is mechanical but touches hot
   generation paths — deferred.
3. **Chat transport lives in the route module** (1370-line file mixing HTTP
   concerns, session persistence and the SSE pipeline). The gateway owns the
   resolution seam; extracting the transport itself is a future phase.
4. **Provider resolution coupling**: `workspace-ai-provider` internally
   consults the shared pool and system-ai (documented current dependency,
   pinned by Phase 2 tests).
5. **Video workflow knowledge in `video-workflows.js`** includes book-domain
   imports (frozen baseline in `dependency-guardrails.test.js`) — same future
   seam migration as (1).

## 13. Future extraction opportunities

- Replace `selectSharedAI` with a real pool scheduler behind the unchanged
  resolver seam (Phase 2 hook).
- Move workflow assembly (audio/image/video) fully behind
  `ComfyUIProvider.generate(...)` and delete direct `gpu.send` call sites.
- Extract the chat SSE transport from `ai-routes.cjs` into
  `services/` once a second consumer (e.g. push transport) exists.
- Extract `ComfyUIProvider` into its own deployable only if generation load
  ever justifies it — **the modular monolith stays the default**
  (`MODULAR_PRODUCT_ARCHITECTURE.md` §14).
