# Experimental Beta Readiness Audit

**Audit date:** 2026-08-21
**HEAD:** `c9b638f` (`docs(beta): add personal AI provider security review`)
**Role:** Reconnaissance / architect — NO implementation, NO code changes, NO test edits.
**Method:** Code-level evidence only. Commit messages were verified against the actual
runtime paths; several inconsistencies are noted.

---

## Target User Journey

The Beta user is **one technically-capable external person** with their own OpenRouter
key, their own GPU box, and a small TXT book. They should be able to:

```
1. Register / Login
   ↓
2. Create / enter Workspace
   ↓
3. Configure Personal AI Provider
   ↓
4. Configure Private Worker
   ↓
5. Start Worker on own machine/GPU
   ↓
6. Import TXT book
   ↓
7. AI parses book
   ↓
8. Use Chat
   ↓
9. Generate content
   ↓
10. See resulting visual book
   ↓
11. Play / inspect result
```

Per-step verdict:

| # | Step | Status |
|---|------|--------|
| 1  | Register / Login              | **READY** |
| 2  | Create / enter Workspace     | **READY** (auto-provisioned at register) |
| 3  | Configure Personal AI Provider | **READY** |
| 4  | Configure Private Worker (UI) | **PARTIAL** — token + env vars surfaced, no run command / prereqs |
| 5  | Start Worker on own GPU       | **PARTIAL** — code works, instructions don't |
| 6  | Import TXT book               | **READY** (with caveat on sync execution) |
| 7  | AI parses book                | **READY** when provider configured; silent global fallback otherwise |
| 8  | Chat                          | **READY** when provider configured; silent global fallback otherwise |
| 9  | Generate content              | **PARTIAL** — pipeline works, but UI silently stalls when worker absent |
| 10 | See visual book               | **READY** |
| 11 | Play / inspect                | **READY** |

**One-line summary:** the backend + isolation + provider/worker machinery is Beta-grade;
the **access gate, onboarding hints, and worker boot instructions** are not yet
finishable by a brand-new external user from the UI alone.

---

## Ready

Solid, working, evidence-backed. No further work required for Beta.

### Account / Workspace

- **Registration** — `POST /api/v1/auth/register` — `backend/src/routes/auth-routes.cjs:31`
  → `authService.register` — `backend/src/auth/auth-service.js:104` (atomic tx: user +
  workspace + owner membership + session). Real validation, no admin gate, rate-limited.
- **Login** — `POST /api/v1/auth/login` — `auth-routes.cjs:60` →
  `auth-service.js:210`. HttpOnly cookie `animastor_sid`, SHA-256-only persistence
  (`session-repo.js:30`), timing-equalized failure, 30-day TTL.
- **Session middleware** — `authContext` `backend/src/middleware/auth-context.js:41`
  propagates `req.user` / `req.workspace` from cookie. Fail-closed helpers:
  `requireBookAccess` (`auth-context.js:213`), `checkBookAccess` (`:157`).
- **Workspace creation** — auto-provisioned on register (`auth-service.js:138`),
  self-healed on every login (`resolveDefaultWorkspace` `auth-service.js:86`). No
  manual "create workspace" UI; one personal workspace per user is implicit.
- **Workspace isolation** — every workspace-scoped route resolves `req.workspace.id`
  from the authenticated session, never from the body. `ON DELETE CASCADE` on all
  workspace-owned tables (`schema.js`).
- **Guest / anonymous workspaces** — `guestRepo` (`guest-repo.js`) supports temporary
  workspaces + conversion on register (`convertTemporaryWorkspace` `:152`). Active but
  optional; not required for Beta.

### Personal AI Provider (Phase 4)

- **Data model + encryption at rest** — AES-256-GCM, `workspace_ai_providers.api_key_enc`
  (`schema.js:74`), `encryptSecret`/`decryptSecret` (`workspace-ai-provider.js:54-90`),
  12-byte IV per encryption, `setAuthTag` on decrypt.
- **CRUD endpoints** — `/api/v1/settings/ai/{provider,providers,test}` —
  `settings-ai-routes.cjs`. Per-workspace authorization (`identityGuard` `:20`),
  SSRF validation at save time (`assertPublicEndpoint` `:91`) and per fetch
  (`safeFetch({ validatePublic })`).
- **Provider_type selector** — UI at `SettingsPage.tsx:371-382`, backend allowlist at
  `workspace-ai-provider.js:28`. Save = active (singleton row per workspace).
- **Key non-echo** — `publicMeta()` returns `api_key_masked` only; test asserts no
  plaintext in HTTP responses (`workspace-ai-provider.test.js:402`). Frontend
  clears React state on save (`SettingsPage.tsx:286`).
- **Test Connection button** — `POST /settings/ai/test` persists `status` +
  `last_tested_at`; `sanitizeTestError()` neutralizes upstream error detail.
- **Cross-workspace isolation** — verified by red-team at
  `EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER_SECURITY_REVIEW.md:61-91`: "NO
  cross-workspace isolation bypass found".

### Private Worker (data + dispatch + isolation)

- **Worker data model** — `workers` table (`schema.js:230`): only `token_hash`
  (SHA-256) at rest. Plaintext returned exactly once at create/rotate
  (`worker-routes.cjs:135,198`).
- **CRUD** — `/api/v1/workers{,/:id/rotate,/:id}` `worker-routes.cjs`. Workspace from
  `req.workspace.id` only (line 110, 129).
- **Worker auth** — Bearer `wrk.<workerId_b64>.<secret_b64>`,
  `worker-auth-middleware.js:29`, worker tokens are a disjoint identity namespace
  from user sessions (`:19-21`).
- **Heartbeat / status** — Redis heartbeat keys (30s TTL, `gpu-hub.js:526-536`).
  UI status pill: `ONLINE`/`OFFLINE`/`REVOKED` (`worker-routes.cjs:68-82`).
- **Job polling + claim** — `GET /gpu/task/next` `gpu-hub.js:652`. **Workspace
  isolation is enforced at FOUR layers** (Phase 2 work, verified):
  1. Backend dispatcher injects `workspace_id` server-side
     (`gpu-dispatcher.js:128-143` — "any client-supplied value is overwritten").
  2. Hub uses `queueKeyFor(type, workspace_id)` — per-workspace Redis list
     (`gpu-hub.js:200`).
  3. Worker's queue key is derived from its **token's** workspace, never client input
     (`gpu-hub.js:702`).
  4. Poison-write cross-check + claimer-only result submission
    (`gpu-hub.js:716-722`, `:808-817`).
  Worker A structurally cannot derive the queue key for workspace B.
- **Result submission** — `POST /gpu/task/result` `gpu-hub.js:778`, claimer-checked,
  then forwarded to backend which re-verifies workspace
  (`generation-routes.cjs:67-84`, `verifyCallbackWorkspace`).
- **Private Worker IS the live dispatch path** — `gpu-hub` is not legacy; the private
  worker isolation logic runs INSIDE `gpu-hub`. Workspace jobs go to
  `animastor:queue:<type>:ws:<id>`; jobs without a private worker fall back to the
  system pool (`animastor:queue:<type>`).

### TXT Import → Parsing

- **Upload route** — `POST /api/v1/book/import` `import-routes.cjs:105` (multipart).
- **Bootstrap route** — `POST /api/v1/book/:id/bootstrap` `import-routes.cjs:608`.
- **Provider resolution** — `agent/bootstrap.js:46` calls `resolveAIForBook(bookId)`
  → `resolveAIForWorkspace` → decrypts the stored workspace provider. With a
  provider configured, parsing uses the user's own `{endpoint, apiKey, model}`.
  Proven by `personal-ai-provider-phase4.test.js:461-484`.
- **Persistence** — `lazy-book/create.js` writes per-chapter JSON files
  (`chapters/<chapter_id>.json` `:671`) + characters / locations / voices / bible /
  mentions + PG `agent_sessions` row + book ownership registry.
- **Frontend progress** — Redis pub/sub → SSE `GET /book/:id/progress-stream`
  (`generation-routes.cjs:633`) consumed by `generateStore.ts:655`. Polling fallback
  every 2s on `/agent-status`. Errors recorded to PG `agent_sessions.status='failed'`
  and surfaced in UI.

### Chat

- **Routes** — `/api/v1/ai/chat`, `/chat/stream`, `/prompt` (`ai-routes.cjs:246,507,759`).
- **Provider resolution** — `resolveChatAI(bookId)` `ai-routes.cjs:29` calls
  `resolveAIForBook(bookId)` → decrypts workspace provider. With a provider
  configured, chat uses the user's own `{endpoint, apiKey, model}` end-to-end
  (`workspace-ai-provider.test.js:353-382` proves outbound `Bearer sk-route`).
- **History** — PG `ai_chat_sessions.messages` JSONB (`ai-routes.cjs:484`).
- **Streaming** — SSE with `data: {type:'content',...}` chunks and `done` event
  (`ai-routes.cjs:597,612`).
- **Tool-calling / book editing** — robust, with Qwen3 `<TResult>` padding for
  nested JSON (`ai-routes.cjs`).

### Generation

- **Trigger** — `POST /book/:id/regenerate` `generation-routes.cjs:307` (selective)
  or `/generate-next` `:30` (slide-window).
- **Queue** — custom Redis list queue via `ioredis` (NOT BullMQ — grep returned 0
  matches). Producer `gpu-dispatcher.js:158` POSTs to `${HUB_URL}/task`; hub does
  `LPUSH queueKeyFor(type, workspace_id)` (`gpu-hub.js:612`).
- **Worker side** — `worker/worker/worker.cjs:487` `workerLoop()`: beacon, poll
  `/task/next`, save inputs to `COMFY_INPUT_DIR`, `runWorkflow` POSTs `task.params`
  (the workflow JSON authored by the backend) to local ComfyUI `/prompt`, poll
  `/history`, base64-encode result, POST `/task/result`.
- **Result storage** — atomic write to `OUTPUT_DIR/<build_id>/...` via
  `filesystem-store.js:93`. Served back by `generation-routes.cjs:688`
  (`/api/v1/chunk/:id/audio`).
- **Workflows shipped** — `backend/ai/workflows/` contains all 9 JSONs
  (`img-qwen-image.json`, `tts-qwen-narrator.json`, `tts-qwen-dialogue.json`,
  `video-ltx-1p..4p.json`). Mounted read-only into backend
  (`docker-compose.yml:78`). Backend fatal-exits if workflow-loader fails
  (`backend.cjs:302-311`).
- **Progress** — SSE + assets-state polling reconcile.

---

## Partial

Works for the configured case but has gaps that need cleanup; not blockers as long
as documented.

### Personal AI Provider — Phase 4 Chk B "personal-only fail-closed"

- `resolveAIProvider(workspaceId, purpose)` exists and is tested
  (`workspace-ai-provider.js:375`), but is **NEVER called by production code** —
  verified by global search. Both the chat route (`ai-routes.cjs:29`) and the parser
  (`agent/bootstrap.js:46`) call `resolveAIForBook` / `resolveAIForWorkspace`
  directly, which **silently fall back to the global `OPENROUTER_API_KEY` /
  `process.env.AI_API_KEY`** when no workspace provider is configured.
- This is documented and rated **LOW** by the Phase-4 security review
  (`EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER_SECURITY_REVIEW.md:584` F-04). The
  review's final verdict is `PASS WITH WARNINGS — Personal AI Provider: READY`.
- **Net effect for Beta**: with a workspace provider configured, chat + parser use
  the user's own key as intended. Without one, they silently use the operator's
  global OpenRouter key (if set) rather than failing with "configure your AI
  provider". This is only a Beta blocker if the operator expects a strict
  personal-only deployment; it is NOT a blocker for the historical "operator
  default + per-user override" model.

### Private Worker UI setup

- The **credential disclosure modal** properly shows token + env-var block
  (`PrivateWorkersSection.tsx:218-272`, `privateWorkers.ts:97-114`) with all four
  vars `worker.cjs` actually reads (`HUB_URL`, `ANIMASTOR_WORKER_TOKEN`,
  `WORKER_TYPE`, `WORKER_ID`). One-time disclosure + status pill.
- **Missing pieces**:
  1. No instructions for how to **obtain `worker.cjs`** (no clone URL, no npm
     tarball, no download button). The file ships in the repo at
     `worker/worker/worker.cjs` but the UI never tells the user where to get it.
  2. No **prerequisites** — the UI doesn't mention Node 20+, a running local
     ComfyUI on `127.0.0.1:8188`, or the model files the workflows reference.
  3. No literal **run command** — step 3 of the UI says only "Start the worker".
  4. **`worker/start-worker.sh` does NOT export `ANIMASTOR_WORKER_TOKEN`** (only
     `HUB_URL`, `WORKER_TYPE`, `COMFY_PORT`, `COMFY_INPUT_DIR` — `:133-137`). A
     user copying that script verbatim ends up in **system-pool mode** with a
     useless token.
  5. **`.env.example` has no `ANIMASTOR_WORKER_TOKEN=` line** — `.env.example:19`
     only has `GPU_HUB_API_KEY`.

### TXT import — synchronous execution

- Parsing runs synchronously inside `POST /book/:id/bootstrap`
  (`import-routes.cjs:608`). The HTTP socket is held for the entire multi-step AI
  pipeline (structure → characters → locations → scenes → units → visuals). Frontend
  uses `postJsonLong` with a 15-minute client timeout (`generateStore.ts:786`).
- Progress updates stream over a *parallel* SSE channel; the long request itself is
  the server-resolver. No BullMQ, no job queue split between producer and consumer.
- **OK for one or two concurrent Beta users**. Not safe for production load.

### Local filesystem storage

- Source TXT (`/data/books`), generated assets (`/data/output`), parsed chapter
  JSON (`/data/books/<id>/chapters/`) — all on local FS (`runtime-config.js:60-61`,
  `filesystem-store.js`). No S3 / object store anywhere in the chain. Both
  `docker-compose.yml:79,80` mount these as host volumes; a single-instance deploy
  can run Beta.

### Frontend onboarding

- After register, dialog closes and the user lands on `/file` with **zero hinting**
  that they need to configure an AI provider and a worker before chat / parse /
  generation will work. No checklist, no welcome state, no banner.
- `ai_provider_none` text "the server global configuration applies"
  (`SettingsPage.tsx:362`) **misleads** — if neither workspace nor global is set,
  nothing applies and the user gets a raw upstream error in the chat bubble.
- `GeneratePage.tsx:181` only paints the section icon red when no worker is
  registered; **no toast / banner / link** to `/settings/private-workers`.

---

## Missing

### Worker boot UX (the gap between "got the token" and "worker is online")

Required for Beta, currently missing:

- A copy-pasteable **start command** (`node worker.cjs` or equivalent).
- A **download** mechanism for `worker/worker/` files (`worker.cjs` + small `package.json`).
- A **prerequisites list** (Node 20+, local ComfyUI, model files matching the
  shipped `backend/ai/workflows/*.json`).
- A `start-worker.sh` variant (or env-var instructions) that exports
  `ANIMASTOR_WORKER_TOKEN`.

No code change is required on the worker side; **only UI text + a delivery path for
`worker/worker/`** is needed.

### Smaller missing (assumed-by-developer)

- No `npm run migrate` CLI — migrations run only at backend boot, non-fatal on
  failure (`backend.cjs:317`). The `PW-1` legacy-workers rebuild path skips silently
  if the old table has rows (`schema.js:1222`).
- No in-UI hint when a job is queued but no worker exists — only a red icon.

---

## P0 Blockers

These block a Beta launch completely.

### P0-1 — Nginx Basic Auth gates the entire SPA

- **Location:** `proxy/conf/default.conf:286-288` —
  `auth_basic "Animastor - restricted access"; auth_basic_user_file /etc/nginx/.htpasswd;`
- **Effect:** the whole `app.animastor.in` SPA sits behind a shared `.htpasswd` file.
  A brand-new external user reaches the SPA only after entering the operator's
  shared Basic Auth password. Register/Login buttons are useless until past Basic
  Auth. `/api/v1/auth/*` is also unreachable in the public-network path because
  nginx gates it under the same `location /` block — only parallel-routed
  `/api/` locations exist (lines 82, 206).
- **Why P0:** there is no Beta for an external user if they cannot reach the app.
  This single fact invalidates "fresh-user" Beta independent of every other piece
  working. Either remove Basic Auth (rely on the real account system) or replace it
  with a "Beta invite list" the operator controls.
- **Operator workaround:** create one `.htpasswd` entry per beta user and send the
  password out of band. Technically possible, ~~not~~ but it makes the in-app
  register/login show meaningless.

### P0-2 — Net-disk / public site mount assumes operator host paths

- **Location:** `docker-compose.yml:117-118` —
  `- /home/sureg/net-disk:/net-disk:ro` and
  `- /home/sureg/sureg-dev/site:/usr/share/nginx/sureg:ro`.
- **Effect:** any external operator copying `docker-compose.yml` will see nginx fail
  to start because those host paths don't exist on their machine.
- **Why P0:** a Beta release to a third party requires their `docker-compose up` to
  work. These volumes are operator-only artifacts from the dev environment.

### ~~P0-3~~ — `WORKSPACE_SECRET_KEY` dev fallback in the backend process

**RESOLVED** by commit `0fa55ac`.

- **Fix:** `getSecretKey()` now validates the key and throws when `NODE_ENV=production`
  and the key is missing, empty, or whitespace-only. The dev fallback is preserved
  only when `NODE_ENV !== production` and is clearly marked as insecure.
- **Tests:** 13 new tests cover fail-closed behavior, validation, and encryption
  compatibility. All 99 existing tests pass.

### P0-4 — Worker setup instructions are incomplete

- **Location:** `frontends/app/src/features/workers/PrivateWorkersSection.tsx:218-272`
  + `i18n.ts:139-146,643-647` + `worker/start-worker.sh:130-137`.
- **Effect:** a Beta user following the UI in order can copy a token and copy env
  vars, but has **no path to actually launch worker.cjs**: no download/clone URL,
  no run command, no prerequisites text, and the only start script in the repo
  doesn't set `ANIMASTOR_WORKER_TOKEN`. The user is stuck at step 5 of the journey.
- **Why P0:** without a running worker the user can configure an AI provider
  (working) and import a TXT (working, AI-only), but cannot generate visual content
  (steps 9-11 of the Beta journey). Generation is the entire value proposition.

---

## P1 Issues

Important, but a workaround exists.

- **P1-1** — Silent global fallback in chat & parser when no workspace provider is
  configured (`ai-routes.cjs:35`, `agent/bootstrap.js:47-49`). Allowed under §26
  spec; contradicts §10. Confirmed and rated LOW by Phase-4 security review. For a
  personal-only Beta the operator simply leaves `OPENROUTER_API_KEY` empty; chat +
  parser then fail clearly. For the "shared operator key + per-user override" Beta
  model this is the documented behavior. **Not a blocker** for either model.

- **P1-2** — Generate silently stalls when no worker is configured
  (`GeneratePage.tsx:181-182`). Add a toast + link to `/settings/private-workers`.

- **P1-3** — `.env` file in the working tree contains a real `OPENROUTER_API_KEY`
  and a 30-character `WORKSPACE_SECRET_KEY` (`.env.example` demands 32+). Rotate
  before any external Beta and lengthen the key.

- **P1-4** — PostgreSQL migration failure is non-fatal at startup
  (`backend.cjs:317-319` only logs). A half-migrated DB serves 500s at runtime
  instead of failing at boot. Mirror the workflow-loader fatal-exit pattern at
  `backend.cjs:309-311`.

- **P1-5** — No `npm run migrate` CLI / no migration path for replicas. Operators
  cannot pre-apply migrations before rolling a new backend image.

- **P1-6** — `GPU_HUB_API_KEY` and `OPENROUTER_API_KEY` have no startup warning
  when unset (`runtime-config.js:212,225-228`). `HUB_URL` defaults silently to
  `https://animastor.in/gpu` (`runtime-config.js:62`) which is wrong for any
  non-canonical deploy.

- **P1-7** — Chat base-url default (`chat-engine.cjs:15` =
  `https://integrate.api.nvidia.com/v1`) **differs from** parser default
  (`ai-service.js:11` = `https://api.aicredits.in/v1`). Documented as INFO in
  `EXPERIMENTAL_BETA_IMPLEMENTATION_VERIFICATION.md:172` but confusing for a Beta
  user who omits `endpoint` and gets different providers for chat vs parser.

- **P1-8** — `worker.cjs` env defaults assume the E2E/Jovyan notebook layout
  (`worker/worker/worker.cjs:43-44` — `COMFY_INPUT_DIR=/home/jovyan/ComfyUI/input`).
  Beta user on a vanilla Linux GPU box must override `COMFY_INPUT_DIR` or jobs fail
  silently with file-not-found errors.

- **P1-9** — Workflows / Connectors are a dead-end for non-developers
  (`WorkflowTypeListPage.tsx:142-146` — Add via JSON upload, no template, no docs).
  Generation requires at least one enabled workflow per layer; ships working out of
  the box (`backend/ai/workflows/*`), but if the user disables one, recovery is hard.

- **P1-10** — `frontends/app/src/app/i18n.ts` exposes developer terms to end users:
  "worker.cjs", "GPU Hub", "Connector", "VBook" (never expanded), raw env-var
  names, ComfyUI node-vocabulary pages reachable from Settings. Polish, not a
  blocker.

---

## P2/P3 Polish

Do NOT turn these into scope creep.

- **P2** — Deterministic dev-key fallback is also a leak risk if someone deploys
  without compose (P0-3 fixes the runtime; mention in the deploy doc that
  compose is the supported Beta path).
- **P2** — Plaintext cache of decrypted keys in process-global `Map` for 30s
  (`workspace-ai-provider.js:158`) — single-threaded Node, acceptable. Documented
  F-02 LOW.
- **P2** — DNS-rebinding TOCTOU window in `safeFetch` (F-03 LOW, mitigated by
  per-redirect re-validation).
- **P2** — SSRF error message includes the blocked IP (F-05 INFORMATIONAL); strip
  in the logging layer.
- **P2** — Tests don't cover `/ai/chat` (non-streaming) or `/ai/chat/stream` with
  a workspace provider — only `/ai/prompt`. Add an e2e test per route.
- **P2** — Tests don't cover the `POST /book/:id/bootstrap` HTTP path with a
  workspace provider end-to-end — only the lower-level resolver + ai-caller.
- **P2** — `worker/worker/` directory is doubled (a pre-existing oddity) — fold it
  to `worker/` when packaging for download.
- **P3** — Synchronous TXT parsing blocks the request thread for minutes. Move to
  a real queue for production — explicitly NOT a Beta blocker.
- **P3** — Local-filesystem source/master storage (`/data/books`, `/data/output`).
  Migrate to object storage for production scale. Beta-blocking only for
  multi-node deploys (out of scope for first Beta).

---

## External Requirements

Minimum viable external setup a Beta user must bring:

| Component | Required? | Notes |
|-----------|-----------|-------|
| **OpenRouter / OpenAI-compatible API key** | REQUIRED (per-user) | Without it, chat + parser fail unless the operator sets a global key. The Beta model is per-user. |
| **Local GPU box** with CUDA | REQUIRED for generation | Without it, the user can import + chat + see parsed structure but cannot generate audio/image/video. |
| **Node.js 20+** on the GPU box | REQUIRED | `worker.cjs` uses global `fetch` (`worker.cjs:4`). |
| **ComfyUI** running on `127.0.0.1:8188` | REQUIRED | Worker calls ComfyUI HTTP API; does not install it. |
| **Model files matching shipped workflows** | REQUIRED | `backend/ai/workflows/*.json` reference ~33 GB of LTX 2.3 video models + Qwen-image GGUFs + Qwen3 TTS. User must place these in ComfyUI's `models/` dir. |
| **Custom nodes for video gen** | REQUIRED for video | kjnodes (patched), comfyui-videohelpersuite, comfyui-easy-use, rgthree-comfy. `worker/start-video.sh` lists them. |
| **Private Worker token + HUB_URL** | REQUIRED | Surfaced in UI at create time. |
| **PostgreSQL** | PROVIDED by operator | `docker-compose.yml` ships postgres:16. |
| **Redis** | PROVIDED by operator | `docker-compose.yml` ships redis:7. Used for queues, heartbeats, progress pub/sub. |
| **Operator OpenRouter key (global)** | OPTIONAL | Only needed if the operator wants a "system pool" AI fallback. Per-user is the Beta model. |
| **Operator system-pool worker** | OPTIONAL | If the operator runs one or more workers WITHOUT an `ANIMASTOR_WORKER_TOKEN`, jobs from workspaces without a private worker land in the system pool. Useful as a Beta safety net if a user's GPU is down. |

---

## Temporary Workarounds

Acceptable for first Beta; documented, not blockers.

1. **Operator can run the backend on a single-node `docker-compose`** with host
   volumes for `/data/books` and `/data/output`. Local-FS storage works for
   single-instance Beta. (P3 for scale.)
2. **Operator can provide a system-pool worker** (no `ANIMASTOR_WORKER_TOKEN`) so
   Beta users whose GPU is misconfigured still get visual results — they then
   migrate to their own private worker when ready.
3. **Operator can set `OPENROUTER_API_KEY`** as a deployment-wide fallback so a
   Beta user who hasn't yet set their own OpenRouter key can still chat and parse.
   Once the user sets their workspace provider, the workspace provider wins.
4. **Operator can pre-share a Basic-Auth password** (`.htpasswd`) per Beta user if
   P0-1 stays in place for the very first invite-only Beta round. Not acceptable
   for any "external user signs themselves up" model.
5. **Operator can hand-deliver `worker/worker/worker.cjs` + `package.json` plus a
   one-pager** ("`node worker.cjs` with these env vars, ComfyUI must be running")
   outside the UI as a stop-gap while P0-4 is implemented.

---

## What We Should NOT Build Yet

Confirmed non-Beta. Do not expand scope.

| Candidate | Beta blocker? | Verdict |
|------------|---------------|---------|
| Share Workers | No | **NOT YET** — `mode='private'` is the only used mode; `'share'` is referenced in the schema CHECK but no UI / dispatch reads it. Per-user worker is the Beta model. |
| GPU marketplace | No | **NOT YET** — out of scope. |
| Billing / quotas | No | **NOT YET** — every user brings their own OpenRouter key + own GPU. No metering needed. |
| Admin UI | No | **NOT YET** — no admin role beyond the seeded `developer` user (`schema.js:1037`). Beta doesn't need one. |
| System provider management UI | No | **NOT YET** — global `OPENROUTER_API_KEY` is an env var, not a CRUD resource. Out of scope. |
| Docker installer for the worker | No | **NOT YET** — Beta users are "technically capable" per the spec; a shell command suffices. |
| Worker marketplace | No | **NOT YET** — out of scope. |
| Automatic model discovery | No | **NOT YET** — workflows reference exact model filenames; discovery would break determinism. |
| Advanced provider routing | No | **NOT YET** — one active provider per workspace; that is the Beta contract. |
| Per-user analytics | No | **NOT YET** — out of scope. |
| Per-user rate-limit / quotas | No | **NOT YET** — relies on the user's own OpenRouter quota. |
| Per-tier feature flags | No | **NOT YET** — out of scope. |
| Multi-workspace per user | No | **NOT YET** — one personal workspace per user is auto-provisioned; that is the Beta contract. |
| S3 object storage | No | **NOT YET** — local FS is sufficient for single-instance Beta (P3 for scale). |
| BullMQ refactor of the parser | No | **NOT YET** — synchronous parsing works for a handful of concurrent Beta users (P3 for scale). |

---

## Recommended Implementation Order

Smallest scope-first. NONE of these are architecture changes; all are configuration,
UI text, or single-file edits. Total estimated work: a small focused PR.

1. **P0-1 — Remove (or invite-list) nginx Basic Auth on `app.animastor.in`**.
   Either drop `auth_basic` from `proxy/conf/default.conf:286-288` and rely on the
   real account system, or generate one `.htpasswd` entry per Beta invite. Required
   before any external user can reach register/login.

2. **P0-2 — Make `docker-compose.yml` portable for Beta operators**. Remove or
   make conditional the `/home/sureg/net-disk` and `/home/sureg/sureg-dev/site`
   host-volume mounts (`docker-compose.yml:117-118`). These are operator-dev
   artifacts that will crash a fresh operator's `docker-compose up`.

3. ~~**P0-3 — Make `WORKSPACE_SECRET_KEY` mandatory at runtime**~~. **RESOLVED** (`0fa55ac`) — `getSecretKey()` throws when `NODE_ENV=production` and key is missing/empty/whitespace. Dev fallback preserved only for `NODE_ENV !== production`. Tests: 13 new + 99 existing passing.

4. **P0-4 — Finish worker setup instructions in the UI**.
   - Add a download link / copy button for `worker/worker/worker.cjs` (or a tiny zip
     of `worker/worker/`) to `PrivateWorkersSection.tsx`.
   - Add a literal start command ("`node worker.cjs`" or "`npm i && node
     worker.cjs`") and a short prerequisites list (Node 20+, local ComfyUI on
     `127.0.0.1:8188`, override `COMFY_INPUT_DIR` if not the Jovyan layout).
   - Update `worker/start-worker.sh:130-137` to also export
     `ANIMASTOR_WORKER_TOKEN`.
   - Add an `ANIMASTOR_WORKER_TOKEN=` example line to `.env.example` so the env var
     is visible.
   - No backend changes required — backend worker auth, dispatch routing, and
     workspace isolation are all already complete.

5. **P1-2 — Add an in-UI warning when Generate is clicked with no worker**.
   `GeneratePage.tsx:181-182` should toast + link to `/settings/private-workers`
   when `total === 0`. Few lines.

6. **P1-3 — Rotate `.env`**: rotate `OPENROUTER_API_KEY`, lengthen
   `WORKSPACE_SECRET_KEY` to 32+ random chars. Out-of-code, operator-only.

7. **P1-4 / P1-5 — Make migration startup fatal + add a `node scripts/migrate.js`
   CLI** (mirror `backend.cjs:302-311`). Single-file edits.

8. **P1-6 — Add `console.warn` for missing `GPU_HUB_API_KEY` /
   `OPENROUTER_API_KEY`, and refuse the `HUB_URL` production default in non-prod**.
   `runtime-config.js:62,212,225-228`.

9. **P1-8 — Document `COMFY_INPUT_DIR` requirement** in the worker setup text
   added in step 4 above.

The Phase-4 security review's verdict (`PASS WITH WARNINGS — Personal AI Provider:
READY`) is corroborated. No additional Phase-4 work is required for Beta.

---

## Final Verdict

### Main question

> "If we wanted to give this application to one technically capable external beta
> user tomorrow, what exactly would stop them?"

### Answer (concrete blockers only)

1. **They cannot reach register/login** — nginx Basic Auth on `app.animastor.in`
   blocks the SPA behind a shared operator password (`P0-1`).
2. **They cannot start the worker from the UI** — no run command, no download
   link, no prerequisites text, and the only repo start script silently drops the
   token (`P0-4`). Without a worker, they cannot generate visual content (the
   core Beta proposition).
3. **They cannot safely deploy their own backend instance from the open tree**
   — `WORKSPACE_SECRET_KEY` dev fallback uses a publicly-visible hardcoded key
   (`P0-3`); `docker-compose.yml` references operator-only host paths that will
   crash on a fresh machine (`P0-2`).

None of these are architectural. Each is a small, localized fix (config / UI text /
single-file guard). Once the four P0s are closed, a fresh external user can
register, configure their OpenRouter key, configure their worker, start it, import
a TXT book, chat, and generate visual content end-to-end.

### Beta readiness

**READY WITH SMALL FIXES**

- P0 blockers: **4**
- P1 issues: **10**
- P2/P3 polish: **8**

### Recommended next step

A single short PR that (a) unbuckles Basic Auth (or ships per-invite `.htpasswd`
entries), (b) strips the two operator-only host volume mounts from
`docker-compose.yml`, (c) hard-fails `WORKSPACE_SECRET_KEY` in production, and (d)
adds a worker.cjs download button + literal `node worker.cjs` command +
prerequisites block to the worker setup modal — closes all four P0s in one focused
change without touching any backend dispatch, auth, isolation, or provider code
which is already Beta-complete.
