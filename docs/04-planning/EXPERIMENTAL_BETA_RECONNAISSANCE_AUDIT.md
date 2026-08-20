# Experimental Beta — Reconnaissance Audit

> **Status:** Reconnaissance (read-only, no code changes)
> **Related:** [EXPERIMENTAL_BETA_VERSION.md](./EXPERIMENTAL_BETA_VERSION.md)
> **Principle:** Bring Your Own AI + Bring Your Own GPU
> **Date:** 2026-08-20

---

## 1. Purpose

Read-only audit of the current Animastor codebase to prepare the Experimental Beta
("workspace-scoped AI provider + private worker"). Maps AI configuration, workspace
ownership, chat/TXT/agent flows, worker lifecycle, Settings UI, database state,
security surface and tests — and derives a minimal implementation path.

Nothing in this document changes code. It is the Phase A reconnaissance
prescribed by EXPERIMENTAL_BETA_VERSION.md §20.

---

## 2. Verdict (short)

The Beta is achievable with **minimal architectural change** — every required
subsystem already exists. The only real gaps:

1. AI credentials are **global** (`runtime-config.js` / env), not **workspace-scoped**.
2. Workers are **global and unauthenticated** — no workspace binding, no private routing.

Both are extensions of existing infrastructure, not new subsystems. The agent
pipeline, prompts, skills, dispatch, leases and orchestration should remain
unchanged ("replace the credential/configuration source, not the agent").

---

## 3. AI Architecture Map

### 3.1 Configuration source (global)

| Config | Location | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | `backend/src/config/runtime-config.js:225`, exported `:289-290` | env |
| `OPENROUTER_MODEL` | `runtime-config.js:229` | `qwen/qwen3-32b` |
| `AI_API_BASE_URL` (ai-service) | `backend/src/services/ai-service.js:10` | `https://api.aicredits.in/v1` |
| `AI_API_BASE_URL` (chat-engine) | `backend/src/services/chat-engine.cjs` | `https://integrate.api.nvidia.com/v1` |
| `AI_MODEL` | env (read in `ai-routes.cjs`) | `qwen/qwen3-32b` |
| `AI_PROFILE_PATH`, `AI_DIR`, `AI_CACHE_TTL` | `chat-engine.cjs`, `ai-loader.js` | env |

> ⚠️ Two different AI base URLs with different defaults exist
> (`api.aicredits.in/v1` vs `integrate.api.nvidia.com/v1`). A workspace provider
> should unify this.

### 3.2 Call sites (all read global config)

- **`services/ai-service.js`** — server-side wrapper.
  - `callAI` (L16-97): key `config.OPENROUTER_API_KEY`, model
    `options.model || config.OPENROUTER_MODEL || 'qwen/qwen3.5-122b-a10b'`,
    base `AI_API_BASE_URL`.
  - `refineDraft` (L145) → `callAI` (bootstrap refinement).
  - `checkAIHealth` (L457): `cfg?.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY`.
- **`services/agent/ai-caller.js`** — agent chokepoint: wraps `aiService.callAI`;
  model `options?.model || config.OPENROUTER_MODEL || 'qwen/qwen3.5-122b-a10b'`;
  `parseJsonResponse`; `logConversation` writes `agent_conversations`.
- **`services/agent/bootstrap.js:43`** — guard `if (!config.OPENROUTER_API_KEY)`.
- **`routes/ai-routes.cjs`** — direct `fetch(${chatEngine.AI_API_BASE_URL}/chat/completions)`
  at L315, L511, L738; header `Authorization: Bearer ${config.OPENROUTER_API_KEY || process.env.AI_API_KEY || ''}`;
  model `process.env.AI_MODEL || 'qwen/qwen3-32b'`.
- **Consumers of the agent chokepoint:** `agent/pipeline-steps.js` (~12 `callAI`
  sites: L283, 324, 356, 410, 468, 563, 709, 812, 922, 1046, 1225, 1551),
  `agent/unit-splitter.js:155`, `bootstrapImportedText`, `bootstrapNextWindow`.

### 3.3 Implication

Replacing credentials at **three chokepoints** covers every AI operation:

- `ai-service.callAI` / `refineDraft` / `checkAIHealth`
- `agent/ai-caller.js`
- `ai-routes.cjs` + `chat-engine.cjs` (chat + streaming)

Agent prompts/skills/validation stay untouched.

---

## 4. Workspace / Ownership Map

### 4.1 Schema

- `workspaces` (`schema.js:25`): id, name, owner_user_id, type
  (`personal`|`temporary`|`team`), expires_at.
- `books` (`:79`): `workspace_id` column.
- `workers` (`:191`): **exists but unused** (registry is Redis-only).
- `ai_chat_sessions` (`:323`), `agent_sessions`/`agent_steps`/`agent_conversations` (`:398-460`).

### 4.2 Repositories / middleware

- `workspace-repo.js`: `createWorkspace`, `findPersonalWorkspace`, `listUserWorkspaces`,
  `getMembership`, `checkBookAccess`, `getWorkspaceIdForBook`.
- `auth-service.js`: register/login create user + personal workspace + owner membership
  atomically; guest conversion keeps `workspace_id`; `resolveDefaultWorkspace` (L86)
  lazy-creates a personal workspace; `bookAccessDecision` (L307).
- `auth-context.js`: `authContext` middleware sets `req.user` / `req.guest` /
  `req.workspace`; a content WRITE on `/api/v1` auto-provisions a guest workspace;
  `requireBookAccess` → `checkBookAccess` (403 / 410 expired).
- `workspace-ownership.js`: self-heals `books.workspace_id`; default developer workspace.
- `backend.cjs:112-155`: `requireBookAccess` mounted on `/api/v1/book/:bookId`,
  `/scene/:bookId`, `/iu-image/:bookId`, `/preview/:bookId`, and `/api/v1/ai*`
  via `aiBookGuard` (book resolved from query/body/session).
- Import flows attach ownership via `attachBookWorkspace(bookId, title, req.workspace?.id)`
  (`import-routes.cjs:205, 282, 302, 433`); cross-tenant guards `dedupOwnedByCaller` /
  `importBookAllowed`.

### 4.3 Anchor

`req.workspace.id` is available on every relevant request. Background jobs carry
`book_id` only (no workspace) — **the key gap** for both features.

---

## 5. Chat Flow

- Frontend → `POST /api/v1/ai/chat` and `/api/v1/ai/chat/stream` (ai-routes.cjs);
  guarded by `aiBookGuard`.
- Sessions in `ai_chat_sessions` (book_id, mode, messages JSONB); book loaded from disk
  (`book.loadBook` / `lazyBook.loadDraftBook`).
- Prompt: `chatEngine.loadSystemPrompt()` + `buildBookContext(bookData)`; tools per mode
  via `chatEngine.getToolsForMode`.
- Direct fetch to `AI_API_BASE_URL/chat/completions` with **global** key/model.
  Streaming path is SSE.
- Tool handling: `edit_book` → `chatEngine.applyPatches` → `book.saveBookBundle`.

---

## 6. TXT Import / Agent Flow

- Entry: `POST /api/v1/book/import` (unified, format-detect), `/import-txt`,
  `/load-vbook` (import-routes.cjs). All behind `requireBookAccess` and attach workspace.
- TXT → `lazyBook.createDraftBook` → `book_source` dedup (cross-tenant-safe) →
  `attachBookWorkspace`.
- `POST /api/v1/book/:bookId/bootstrap` / `bootstrap-next-window` →
  `txtImporter.bootstrapImportedText` / `bootstrapNextWindow` → agent pipeline
  (`pipeline-steps.js` ~12 AI calls, `unit-splitter.js`), sessions in
  `agent_sessions`, steps in `agent_steps`, convos in `agent_conversations`.
- `trigger-next-window` also triggers windows for TXT books; VBook path uses `windowGenerator`.

---

## 7. Worker Architecture

### 7.1 Backend

- `generation-routes.cjs`: `POST /worker/heartbeat` (L490; validates
  `WORKER_HEARTBEAT_TYPES`; **no auth**), `GET /worker/status` (L505),
  `GET /worker/counts` (L515).
- `worker-health.js`: Redis heartbeats `WORKER_HEARTBEAT_KEY(type, workerId)`, TTL 30s;
  counts via SCAN.
- `dispatch-engine.js` / `lease-manager.js`: per-type lease TTLs, renewal, release.
- `gpu-dispatcher.js`: `sendUnified` → `POST ${config.HUB_URL}/task` with optional
  `x-api-key`; payload carries `job_id` (parsed into book/chapter/scene), `build_id`,
  `protocol_version`.

### 7.2 GPU Hub (gpu-hub/gpu-hub.js)

- `requireApiKey` (L33) — **open access when `GPU_HUB_API_KEY` is null** (L34).
- Redis registry `animastor:gpu-hub:workers`; `/beacon`, `/task` (auth), `/task/next`,
  `/task/result`, `/task/error`; queues `animastor:queue:{audio,image,video}`;
  `animastor:running`; `/queue/clear` (auth).

### 7.3 Worker (worker/worker/worker.cjs)

- `HUB_URL` default `https://animastor.in/gpu`; `WORKER_ID = env.WORKER_ID || 'gpu-'+hostname`.
- **No auth token anywhere** — beacon sends only `{id}`; polls `/task/next?worker=..&type=..`;
  reports `/task/result` / `/task/error`.

### 7.4 Key facts

- Worker registry is **Redis-only**; the PG `workers` table is unused.
- Heartbeats (backend and hub) have **no credential**.
- gpu-hub is effectively **open** when `GPU_HUB_API_KEY` is unset.

---

## 8. Private Worker Path

Not implemented. Per EXPERIMENTAL_BETA_VERSION.md §9-10:

- Worker must register with a **workspace-scoped token** → backend validates →
  records `workspace_id` on the worker (PG `workers` table or Redis registry).
- gpu-hub must route tasks by `workspace_id` (a private worker must never receive
  another workspace's jobs).
- Jobs currently carry `book_id` only; the hub needs `workspace_id` in the task
  payload (backend stamps it at dispatch) or a backend→hub lookup.
- Reuse heartbeat/lease/dispatch/orchestration unchanged; add the token to beacon + `/task/next`.

---

## 9. Settings

- `frontends/app/src/pages/SettingsPage.tsx`: sections — `/settings` (General),
  `/settings/vbook` (VBook), `/settings/worker` (Worker). `WorkerSection` (L336):
  loads `/book/:id/layer-config`, `/connectors/profiles`, `/connectors/grouped`,
  `/worker/counts`; per-type timeout + profile via `putJson`.
- API client `frontends/app/src/api/client.ts`: `getJson/postJson/putJson/patchJson/deleteJson`,
  `postJsonLong` (15 min), SSE, blob download, retryWithBackoff.
- `config-routes.cjs` serves only `{ limits: { image_prompt_max_chars } }`.
  **No AI-provider or worker-management API exists yet.**

---

## 10. Database Changes

- **New:** `workspace_ai_providers` (workspace_id FK, provider, endpoint, encrypted
  api_key, model, temperature, max_tokens, enabled, timestamps) — doc §5.3.
- **Extend:** `workers` table (unused, schema.js:191) — add `workspace_id`,
  `auth_token_hash` (or new `worker_tokens` table). Reuse, don't duplicate.
- **Optional:** stamp `workspace_id` into `generation_tasks` / job payloads for routing.
- No change to `books` (already has `workspace_id`) or AI/agent session tables.

---

## 11. Security Risks (found during recon)

1. **gpu-hub open access** — `requireApiKey` passes through when `GPU_HUB_API_KEY`
   unset (gpu-hub.js:34); production must enforce a key.
2. **No worker auth** — worker→hub beacon has no token; anyone can impersonate a
   worker; backend `/worker/heartbeat` accepts any type+worker_id.
3. **Two AI base URLs** with different defaults — drift risk; unify via workspace provider.
4. **Global key in chat header** — must stay server-side, never leaked to frontend.
5. **Cross-tenant surface mostly guarded** (imports, dedup, aiBookGuard). New
   provider/worker endpoints must use `req.workspace.id` (never client-supplied ids)
   and enforce membership.
6. **Global worker counts** — private workers must not be counted for other workspaces.

---

## 12. Tests

`backend/tests/` (~60 files) already covers the foundation:
`auth-mvp.test.js`, `guest-workspace.test.js`, `account-workspace.test.js`,
`ai-editor-mode.test.js`, `unit-splitter.test.js`, `coreference-agent.test.js`,
`generation-routes.test.js`, `config-routes.test.js`, `job-schema.test.js`,
`gpu-hub-cleanup.test.js`, `runtime-timeouts.test.js`, `happy-path.test.js`,
`gen-scope.test.js`. New provider/worker tests should mirror these.

---

## 13. Minimal Implementation Plan

### Phase B — Workspace AI Provider

1. Add `workspace_ai_providers` table (encrypted key server-side).
2. `resolveWorkspaceAIProvider(workspaceId)` → provider config; fallback to global env.
3. Inject at the 3 chokepoints: `ai-service.callAI/refineDraft/checkAIHealth`,
   `agent/ai-caller.js`, `ai-routes.cjs` + `chat-engine.cjs`.
4. CRUD API (workspace-scoped via `req.workspace.id`), Test Connection, Settings UI.

### Phase C — Private Workers

1. `workspace_id` + auth token on the worker registry (PG `workers`).
2. Worker token generation API in Settings; worker sends token in beacon + `/task/next`.
3. gpu-hub private routing: backend stamps `workspace_id` in task payload; hub filters.
4. Reuse heartbeat/lease/dispatch/orchestration; add connect/disconnect/status UI.

### Phase D — E2E acceptance

Register → workspace → own AI → own worker → TXT import → parse → generate → play;
then isolation with a second workspace (per doc §20).

---

## 14. Change Surface

- **DB:** 1 new table + extend `workers` (schema.js + migration).
- **Backend services:** `ai-service.js`, `agent/ai-caller.js`, `ai-routes.cjs`,
  `chat-engine.cjs`, `gpu-dispatcher.js`, new workspace-ai-provider service.
- **Backend routes:** workspace-provider + worker-token routes; extend config/worker routes.
- **gpu-hub:** token validation + workspace routing in `/beacon`, `/task`, `/task/next`.
- **worker:** read `WORKER_TOKEN` env + include in beacon/headers.
- **Frontend:** AI Provider + Workers sections in `SettingsPage.tsx`.
- **Deploy:** docker-compose / .env.example — document `WORKER_TOKEN`, keep global AI
  env as fallback.

---

## 15. Conclusion

The minimal path is real: workspace-scoped AI provider injected at ~3 chokepoints,
plus worker auth + workspace binding + private routing. No new subsystem, no rewrite
of the agent or orchestration. The codebase already provides identity, workspace
ownership, AI abstraction and full worker orchestration.