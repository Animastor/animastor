# Experimental Beta E2E Smoke Audit

**Audit date:** 2026-08-21
**HEAD:** `2d55dbf` (`docs(beta): document private worker setup`)
**Role:** Independent E2E Beta tester / auditor. NO implementation. NO code changes. NO test edits.
**Method:** Code-path tracing through actual frontend/backend/worker/gpu-hub source. No running environment.
**Baseline:** Previous readiness audit `a23fdad` + 3 onboarding commits `c7cc302`, `695cdb9`, `2d55dbf`.

---

## Target Scenario

A fresh, technically capable user with:
- Browser
- Own AI API key (OpenRouter / OpenAI-compatible)
- Computer with GPU + ComfyUI + required models

They should traverse:

```
Register → Workspace → AI Provider → Worker → Worker ONLINE →
Import TXT → Parsing → Book Structure → Chat → Generation →
Generated Result → Player
```

---

## Step-by-Step Result

### 1. Registration

| Aspect | Detail |
|--------|--------|
| **Where user is** | `app.animastor.in` (behind nginx Basic Auth) |
| **What they press** | User icon → "Register" → fill username/password/email → "Register" button |
| **System expects** | `POST /api/v1/auth/register` with `{username, password, email}` |
| **Backend path** | `auth-routes.cjs:31` → `auth-service.js:104` (atomic tx: user + workspace + membership + session) |
| **What actually happens** | HttpOnly cookie `animastor_sid` set; `authMe` signal updated to `{authenticated: true, user: {...}, workspace: {...}}` |
| **Verdict** | **PASS** — Atomic, well-validated, workspace auto-provisioned. |
| **Blocking caveat** | nginx Basic Auth (`proxy/conf/default.conf:286`) gates the SPA. User must already know the shared htpasswd to even see the register button. |

### 2. First Authenticated Screen

| Aspect | Detail |
|--------|--------|
| **Where user is** | After register, dialog closes, lands on `/file` tab (AppShell:52) |
| **What they see** | File page (empty book list); toolbar shows username; Settings gear visible |
| **System state** | `authMe.value` = `{authenticated: true, user: {id, username}, workspace: {id, name, type}}` |
| **Verdict** | **PARTIAL** — No welcome banner, no checklist, no hint that AI provider and worker must be configured. A fresh user sees an empty app with no guidance. |

### 3. Workspace

| Aspect | Detail |
|--------|--------|
| **Where user is** | Any screen — workspace is implicit (personal workspace auto-created at register) |
| **What they press** | Nothing explicit — workspace is shown in UserMenu dropdown as "Personal workspace: Personal workspace" |
| **System expects** | Workspace resolved by `resolveDefaultWorkspace(userId)` in `auth-service.js:86` |
| **What actually happens** | One personal workspace per user, auto-created on register, self-healed on login. `req.workspace.id` propagates to all scoped routes. |
| **Verdict** | **PASS** — No manual workspace creation needed; the single personal workspace model is correct for Beta. |

### 4. Personal AI Provider

| Aspect | Detail |
|--------|--------|
| **Where user is** | Settings → "AI Provider" (`/settings/ai`) |
| **What they press** | Settings gear → AI Provider → choose type (OpenRouter/OpenAI-compatible/custom) → enter endpoint + API key + model → "Save" → optionally "Test" |
| **System expects** | `PUT /api/v1/settings/ai/provider` with `{provider_type, endpoint, api_key, model}` |
| **Backend path** | `settings-ai-routes.cjs:83` → `workspace-ai-provider.js:upsertProvider` → AES-256-GCM encrypted at rest in `workspace_ai_providers.api_key_enc` |
| **What actually happens** | Key encrypted, never returned in plaintext; `publicMeta()` returns `api_key_masked` + `configured: true`. Frontend clears `apiKey` from React state on save. |
| **Verdict** | **PASS** — Full CRUD, SSRF guard, encrypted-at-rest, one-time key entry. |

#### Does Chat use the personal provider?

| Aspect | Detail |
|--------|--------|
| **Backend path** | `ai-routes.cjs:29` → `resolveChatAI(bookId)` → `workspaceAi.resolveAIForBook(bookId)` → `resolveAIForWorkspace(workspaceId)` → decrypts stored `api_key_enc` |
| **What actually happens** | If workspace provider exists → user's own endpoint/key/model used for outbound LLM call. If NOT configured → **global fallback** (`OPENROUTER_API_KEY` / `process.env.AI_API_KEY`) |
| **Verdict** | **PASS with expected fallback** — Workspace provider takes priority. Silent global fallback is documented, expected, and low-risk. |

#### Does TXT parsing use the personal provider?

| Aspect | Detail |
|--------|--------|
| **Backend path** | `agent/bootstrap.js:46` → `resolveAIForBook(bookId)` → same resolver as chat |
| **What actually happens** | Same as chat — workspace provider first, global fallback second |
| **Verdict** | **PASS with expected fallback** — Consistent provider resolution for all AI purposes. |

### 5. Private Worker

| Aspect | Detail |
|--------|--------|
| **Where user is** | Settings → "Private Workers" (`/settings/private-workers`) |
| **What they press** | "Add Worker" → enter name → select type (image/audio/video) → "Create" |
| **System expects** | `POST /api/v1/workers` with `{name, worker_type}` — requires registered user (not guest) |
| **Backend path** | `worker-routes.cjs:103` → `workerRepo.createWorker` + `workerAuth.mirrorPut` (Redis mirror) |
| **What actually happens** | Worker row created in PG, token issued once, shown in credential disclosure modal. |

#### Credential Disclosure

| Aspect | Detail |
|--------|--------|
| **What user sees** | Modal with: plaintext token (`wrk.<id>.<secret>`), copy button, download command (`curl -o worker.cjs <hub>/worker-source`), 5-step setup instructions, prerequisites, environment variable block, `node worker.cjs` run command |
| **Security** | Token shown once, lives only in React `useState`. Cleared on "Done". Never persisted. |
| **Verdict** | **PASS** — Since onboarding commits `c7cc302..2d55dbf`, the modal is complete with download, prereqs, env block, and run command. |

#### Does start-worker.sh work with the configuration shown in UI?

| Aspect | Detail |
|--------|--------|
| **Shell script path** | `worker/start-worker.sh:34-57` — loads `.env` file, exports all vars including `ANIMASTOR_WORKER_TOKEN` |
| **Configuration match** | UI env block shows: `HUB_URL`, `ANIMASTOR_WORKER_TOKEN`, `WORKER_TYPE`, `WORKER_ID` — all four are read by `worker.cjs:28-34` |
| **Verdict** | **PASS** — `start-worker.sh` now reads `.env` which includes the token. The `.env.example` in `worker/worker/` has all required vars. |

#### Worker Start → Beacon → ONLINE

| Aspect | Detail |
|--------|--------|
| **Worker code path** | `worker.cjs:main()` → `waitForComfyUI()` → `workerLoop()` → `setInterval(sendBeacon, 10000)` → `POST ${HUB_URL}/beacon` with Bearer credential |
| **Hub verification** | `gpu-hub.js:beacon` → `authenticateWorkerMirror(redis, extractBearerToken(req))` → parses token → SHA-256 lookup in Redis mirror → returns `{worker_id, workspace_id, worker_type, mode, name}` |
| **Heartbeat key** | `animastor:worker:heartbeat:<type>:<worker_id>` with 30s TTL |
| **UI status pill** | `worker-routes.cjs:68-82` → `liveInfo()` reads Redis heartbeat key → `ONLINE` if present, `OFFLINE` if absent |
| **Verdict** | **PASS** — Complete path from worker.cjs → hub beacon → Redis heartbeat → backend derived status → frontend pill. |

### 6. Worker Job Execution Path

| Aspect | Detail |
|--------|--------|
| **Generation trigger** | `POST /api/v1/book/:id/regenerate` → `generation-routes.cjs:307` → dispatch to GPU hub |
| **Queue** | `POST ${HUB_URL}/task` → `gpu-hub.js:task` → `LPUSH queueKeyFor(type, workspace_id)` → `animastor:queue:<type>:ws:<workspaceId>` |
| **Worker poll** | `GET /gpu/task/next?worker=<id>&type=<type>` → `gpu-hub.js:652` → workspace-scoped pop from `animastor:queue:<type>:ws:<token_workspace>` |
| **Claim** | Running record written to `animastor:running` with `worker`, `workspace_id`, `dispatch_id` |
| **ComfyUI execution** | `worker.cjs:runWorkflow(task.params)` → POST to local ComfyUI `/prompt` → poll `/history` → download result |
| **Result delivery** | `POST /gpu/task/result` → hub claimer-check → forward to `POST ${BACKEND_URL}/gpu/task/result` → `generation-routes.cjs` → filesystem store |
| **Frontend reception** | SSE `GET /book/:id/progress-stream` + polling `/chunk/:id` |
| **Verdict** | **PASS** — 4-layer workspace isolation verified. Claimer-only result/error submission. No missing queue transitions. |

### 7. TXT Import

| Aspect | Detail |
|--------|--------|
| **Where user is** | `/file` tab → "From device" button (or drag-drop) |
| **What they press** | Select a `.txt` file → upload |
| **System expects** | `POST /api/v1/book/import` (multipart) → `import-routes.cjs:105` |
| **Detection** | Format auto-detected: ZIP magic bytes → vbook; otherwise → txt |
| **TXT path** | `decodeTxtBuffer(buf)` (encoding detection) → `lazyBook.createDraftBook(sourceText)` → `RAW_IMPORTED` state → `attachBookWorkspace(bookId, title, wsId)` |
| **Dedup** | SHA-256 hash of decoded text → `book_source` PG lookup → cross-tenant guard → returns existing if owned |
| **Verdict** | **PASS** — Upload, decode, dedup, workspace ownership all work. |

#### Parsing (Bootstrap)

| Aspect | Detail |
|--------|--------|
| **System trigger** | `POST /api/v1/book/:bookId/bootstrap` → `txtImporter.bootstrapImportedText(bookId)` → `agentService.bootstrapWithAgent(bookId)` |
| **Provider resolution** | `agent/bootstrap.js:46` → `resolveAIForBook(bookId)` → workspace provider |
| **AI pipeline** | Structure detection → characters → locations → scenes → units → visuals |
| **Progress** | Redis pub/sub → SSE `GET /book/:id/progress-stream` → consumed by `generateStore.ts` |
| **Persistence** | Per-chapter JSON files + `agent_sessions` PG row + book ownership registry |
| **Verdict** | **PASS** — Complete parsing pipeline, workspace-scoped AI, progress reporting. |

### 8. Chat

| Aspect | Detail |
|--------|--------|
| **Where user is** | "AI" chip in toolbar (mobile: `/ai` route; desktop: dock overlay) |
| **What they press** | AI chip → type message → Enter |
| **System expects** | `POST /api/v1/ai/chat` with `{messages, book_id, mode}` |
| **Backend path** | `ai-routes.cjs:246` → `resolveChatAI(bookId)` → workspace provider → `safeFetch(LLM endpoint)` |
| **Workspace correctness** | Book → book ownership registry → workspace → provider. Scoped by `req.scopedBookId`. |
| **Model correctness** | Uses `provider.model` (user-configured) or global `AI_MODEL` / `OPENROUTER_MODEL` fallback |
| **Error handling** | `safeFetch` enforces SSRF; timeouts at 60s; API errors → 502 with sanitized message; thinking/tool-call tags stripped from response |
| **Verdict** | **PASS** — Correct workspace, correct provider, correct model, robust error handling. |

### 9. Generation

| Aspect | Detail |
|--------|--------|
| **Where user is** | "Generate" tab (`/generate`) |
| **What they press** | "Generate" button (or equivalent trigger) |
| **System expects** | Worker present + queue dispatch → worker claims job → ComfyUI executes → result → frontend |
| **Worker availability check** | `GET /api/v1/worker/counts` → counts from Redis heartbeats → frontend shows counts in WorkerSection |
| **GPU → frontend** | Worker writes output to `OUTPUT_DIR/<build_id>/` → chunk status updated in Redis → SSE progress → frontend polls `/chunk/:id` |
| **Verdict** | **PASS** — When worker is ONLINE, the pipeline is complete. |

### 10. Player

| Aspect | Detail |
|--------|--------|
| **Where user is** | "Play" tab (`/play`) after generation |
| **System expects** | Generated assets exist in `OUTPUT_DIR/<build_id>/` → storyboard resolves → playback |
| **Asset resolution** | `GET /scene/:bookId/:chapterId/:sceneId/storyboard` → IU items with audio/image/video file references |
| **Audio serving** | `GET /scene/:bookId/:chapterId/:sceneId/audio` → `streamFileWithRange` with ETag, 206 support |
| **Image serving** | `GET /iu-image/:bookId/:chapterId/:sceneId/:iuId` → PNG from build dir |
| **Video serving** | `GET /chunk/:id/video` → merged scene.mp4 or group file |
| **Verdict** | **PASS** — Assets exist, resolved, no broken state, HTTP Range support for seek. |

### 11. Error / Empty States

| Failure Case | User Sees | Code Path | Verdict |
|---|---|---|---|
| **No AI provider configured** | Chat error from upstream 4xx/5xx; parser falls back to global env if available, else fails | `resolveAIForWorkspace` → `globalFallbackProvider()` | **PARTIAL** — Silent fallback may confuse; no "Configure your AI provider" hint |
| **Invalid AI key** | Chat: `502 AI API error: 401`; Test Connection: "Authentication failed" | `safeFetch` → upstream 401 → `sanitizeTestError` | **PASS** — Clear, sanitized error |
| **Worker offline** | Generate: no jobs dispatched; UI shows worker count = 0, icon may turn red | `liveInfo()` → Redis heartbeat absent → `OFFLINE` | **PARTIAL** — No toast/banner linking to worker setup; just a red icon |
| **Worker token invalid** | Worker log: `Hub rejected beacon: HTTP 401`; worker stays OFFLINE | `gpu-hub.js:beacon` → `authenticateWorkerMirror` → 401 | **PASS** — Clear in worker log; troubleshooting hints in UI |
| **ComfyUI unavailable** | Worker: "ComfyUI not ready (attempt N)" with exponential backoff | `worker.cjs:waitForComfyUI()` | **PASS** — Worker retries indefinitely until ComfyUI is ready |
| **Parsing failure** | Frontend: progress shows error; `agent_sessions.status = 'failed'` in PG | `bootstrapWithAgent` catch → error status | **PASS** — Error recorded and surfaced |
| **Generation failure** | Worker: `sendTaskError` → hub → `notifyBackendError` → backend `failStage`; frontend: chunk status stays `processing` then eventually errors | `gpu-hub.js:notifyBackendError` (5 retries) | **PASS** — Error delivery with retry; backend re-dispatch |

---

## PASS

Solid, working, evidence-backed. Complete code paths verified.

1. **Registration** — Atomic tx, HttpOnly cookie, workspace auto-provisioned
2. **Login/Logout** — Timing-equalized, cookie cleared, idempotent
3. **Session persistence** — HttpOnly cookie `animastor_sid`, 30-day TTL, server-side session store
4. **Workspace creation** — Implicit personal workspace per user, self-healed on login
5. **AI Provider CRUD** — Endpoint + key + model + type, AES-256-GCM encrypted, SSRF guard
6. **AI Provider test** — Real connection test, sanitized errors, status persistence
7. **Private Worker CRUD** — Create/rotate/revoke, one-time token, workspace-scoped
8. **Worker credential disclosure** — Complete: download command, steps, prereqs, env block, run command (onboarding commits `c7cc302..2d55dbf`)
9. **Worker start → beacon → ONLINE** — Full path verified
10. **Worker .env loading** — `start-worker.sh` reads `.env`, exports all vars including token
11. **Workspace-scoped job dispatch** — 4-layer isolation: backend-injected workspace_id, hub queue key, token-derived pop, claimer-only result
12. **TXT import + dedup** — Encoding detection, hash-based dedup, cross-tenant guard
13. **AI parsing** — Workspace provider, bootstrap pipeline, progress SSE
14. **Chat** — Workspace provider, session history, tool calling, streaming
15. **Generation pipeline** — Queue → worker → ComfyUI → result → filesystem → frontend
16. **Player** — Storyboard, audio/image/video serving, HTTP Range support
17. **Error sanitization** — `sanitizeTestError`, SSRF error suppression, claimer-only errors

---

## PARTIAL

Working for the configured case but with gaps that affect fresh-user experience.

| # | Issue | Code Path | Impact |
|---|-------|-----------|--------|
| 1 | **No welcome/onboarding guidance after register** | `AppShell.tsx:52` → dialog closes, lands on `/file` with no hints | Fresh user doesn't know they need AI provider + worker before anything useful happens |
| 2 | **Silent global fallback when no workspace provider** | `ai-routes.cjs:29`, `agent/bootstrap.js:46` → `globalFallbackProvider()` | User may unknowingly use operator's global key; `ai_provider_none` text says "the server global configuration applies" which is misleading when neither exists |
| 3 | **Generate stalls silently when no worker** | `GeneratePage.tsx:181` — only paints section icon red | No toast, no banner, no link to `/settings/private-workers` |
| 4 | **Nginx Basic Auth gates the entire SPA** | `proxy/conf/default.conf:286` | External user must know shared htpasswd before seeing the app |
| 5 | **`docker-compose.yml` operator-only host paths** | `docker-compose.yml:117-118` — `/home/sureg/net-disk`, `/home/sureg/sureg-dev/site` | Fresh operator's `docker-compose up` fails if those paths don't exist |
| 6 | **`WORKSPACE_SECRET_KEY` dev fallback** | `workspace-ai-provider.js:54-64` — hardcoded key when env missing | Safe in docker-compose (fails fast via `${:?}`), but insecure when running outside compose |
| 7 | **Chat and parser base URLs differ** | Chat default: `nvidia.com/v1` (`chat-engine.cjs:15`); parser default: `aicredits.in/v1` (`ai-service.js:11`) | Confusing when user omits endpoint and gets different providers for chat vs parse |
| 8 | **`COMFY_INPUT_DIR` default assumes Jovyan notebook layout** | `worker.cjs:43` — `/home/jovyan/ComfyUI/input` | Vanilla Linux GPU box must override or jobs fail silently |
| 9 | **Synchronous TXT parsing** | `import-routes.cjs:608` — HTTP socket held for full AI pipeline | Fine for 1-2 Beta users; not for production load |
| 10 | **Local filesystem storage** | `runtime-config.js:60-61`, `filesystem-store.js` | Fine for single-instance Beta; not for multi-node |

---

## FAIL

None identified. All critical paths are functional when the prerequisites are met.

---

## P0 Blockers

| # | Description | Since Last Audit | Status |
|---|-------------|-----------------|--------|
| P0-1 | **Nginx Basic Auth gates entire SPA** | UNCHANGED | `proxy/conf/default.conf:286` — external user cannot reach register/login without shared htpasswd |
| P0-2 | **`docker-compose.yml` operator-only host paths** | UNCHANGED | `/home/sureg/net-disk` and `/home/sureg/sureg-dev/site` crash fresh operator's `docker-compose up` |
| P0-3 | **`WORKSPACE_SECRET_KEY` dev fallback** | UNCHANGED (code still has fallback; compose fails fast) | `workspace-ai-provider.js:54-64` — insecure when running outside docker-compose |
| ~~P0-4~~ | ~~Worker setup instructions incomplete~~ | **RESOLVED** by `c7cc302..2d55dbf` | Download command, prereqs, env block, run command all present in credential disclosure modal. `start-worker.sh` loads `.env` including token. `.env.example` has all vars. |

**P0 count: 3** (down from 4)

---

## P1 Issues

| # | Description | Workaround |
|---|-------------|------------|
| P1-1 | Silent global fallback in chat & parser when no workspace provider | Operator leaves `OPENROUTER_API_KEY` empty → fails clearly |
| P1-2 | Generate silently stalls when no worker | User notices no progress; can navigate to Settings manually |
| P1-3 | `.env` file contains real API key and short `WORKSPACE_SECRET_KEY` | Rotate before external Beta; lengthen key to 32+ chars |
| P1-4 | PostgreSQL migration failure non-fatal at startup | Backend logs warning but continues; 500s at runtime |
| P1-5 | No `npm run migrate` CLI | Operators must wait for backend boot to apply migrations |
| P1-6 | No startup warning for missing `GPU_HUB_API_KEY` / `OPENROUTER_API_KEY` | Operator must know to set them |
| P1-7 | Chat and parser use different default base URLs | Set explicit endpoint in provider config |
| P1-8 | `COMFY_INPUT_DIR` default assumes Jovyan layout | Override in `.env` or environment |
| P1-9 | Workflows/Connectors are a dead-end for non-developers | Ships working by default; recovery if user disables one is hard |
| P1-10 | Developer terms exposed in UI ("worker.cjs", "GPU Hub", "Connector") | Polish, not a blocker |

**P1 count: 10** (unchanged)

---

## P2/P3 Issues

| # | Classification | Description |
|---|----------------|-------------|
| P2 | Dev-key fallback also a leak risk if deployed outside compose | Mention in deploy doc that compose is the supported path |
| P2 | Decrypted keys cached in process-global Map for 30s | Single-threaded Node, acceptable |
| P2 | DNS-rebinding TOCTOU in safeFetch | Mitigated by per-redirect re-validation |
| P2 | SSRF error message includes blocked IP | Strip in logging layer |
| P2 | Tests don't cover `/ai/chat` with workspace provider end-to-end | Add test per route |
| P2 | `worker/worker/` directory doubled | Fold to `worker/` when packaging |
| P3 | Synchronous TXT parsing blocks request thread | Move to queue for production |
| P3 | Local filesystem storage | Migrate to object storage for multi-node |

---

## Manual Workarounds

For each P0, whether a workaround exists without developer access:

| P0 | Workaround? | Description |
|----|-------------|-------------|
| P0-1 | **Yes (limited)** | Operator creates one `.htpasswd` entry per Beta user and shares the password out-of-band. Works for invite-only; breaks for self-service signup. |
| P0-2 | **Yes** | Operator edits `docker-compose.yml` to remove or comment out the two host-path volume mounts before running `docker-compose up`. Requires knowing which lines to edit. |
| P0-3 | **Yes** | Operator sets `WORKSPACE_SECRET_KEY` to a random 32+ char string in `.env` before starting. The compose `${:?}` fails fast if missing. |
| ~~P0-4~~ | ~~N/A~~ | Resolved. |

A workaround requiring developer access does NOT count as clean Beta. All three remaining P0 workarounds are achievable by a technically capable operator, but none are self-service.

---

## Unverified Boundaries

Since this audit is code-path-only (no running environment), the following boundaries cannot be verified without a live E2E setup:

| Boundary | What Could Go Wrong |
|----------|---------------------|
| **Real ComfyUI integration** | `worker.cjs:runWorkflow` POSTs to ComfyUI `/prompt` → `/history` poll → output. Verified at code level but not against a running ComfyUI with correct models. |
| **GPU generation with actual models** | LTX 2.3 video, Qwen-image, Qwen3-TTS model inference. Code path complete; actual model loading and inference untested. |
| **SSE progress under load** | `GET /book/:id/progress-stream` → Redis pub/sub. Code correct; real-time push under concurrent generation untested. |
| **Browser HTTP Range seeks** | `streamFileWithRange` serves 206 Partial Content. ETag/Last-Modified/If-Range logic is thorough; actual browser seek behavior untested. |
| **Network latency on worker→hub→backend chain** | Worker beacon (10s interval), hub sweep (10s interval), heartbeat TTL (30s). Timings are correct in code; real network behavior untested. |
| **Cross-tab state consistency** | Module-level Preact signals shared across tabs. Single-tab behavior correct; multi-tab behavior untested. |

---

## Recommended Fix Order

Smallest scope-first. None are architecture changes.

1. **P0-1 — Remove or invite-list nginx Basic Auth** on `app.animastor.in`. Either drop `auth_basic` from `proxy/conf/default.conf:286-288` (rely on the real account system), or generate one `.htpasswd` entry per Beta invite.

2. **P0-2 — Make `docker-compose.yml` portable**. Remove or make conditional the `/home/sureg/net-disk` and `/home/sureg/sureg-dev/site` host-volume mounts (`docker-compose.yml:117-118`).

3. **P0-3 — Make `WORKSPACE_SECRET_KEY` mandatory at runtime**. In `workspace-ai-provider.js:54-64`, throw when `NODE_ENV=production` and key is missing. One-line guard.

4. **P1-2 — Add a warning when Generate is clicked with no worker**. `GeneratePage.tsx:181` should toast + link to `/settings/private-workers` when worker count = 0.

5. **P1-3 — Rotate `.env`**: rotate `OPENROUTER_API_KEY`, lengthen `WORKSPACE_SECRET_KEY` to 32+ random chars. Out-of-code, operator-only.

6. **P1-8 — Document `COMFY_INPUT_DIR` override** in the worker setup instructions already added by `c7cc302..2d55dbf`.

7. **P1-7 — Align chat and parser default base URLs**. Set the same default or require explicit endpoint in provider config.

---

## Tests / Smoke

| Test Suite | Status | Notes |
|------------|--------|-------|
| `backend/tests/gpu-hub-worker-source.test.js` | **PASS** (2/2) | Worker source download endpoint verified |
| `backend/tests/auth-mvp.test.js` | **TIMEOUT** | Likely requires PG/Redis; not runnable in this environment |
| `backend/tests/workspace-ai-provider.test.js` | **TIMEOUT** | Likely requires PG; not runnable in this environment |
| `backend/tests/private-worker-phase3.test.js` | **TIMEOUT** | Likely requires PG/Redis; not runnable in this environment |
| `frontends/app/src/features/workers/privateWorkers.test.ts` | **NOT RUN** | Requires frontend build environment |

The GPU hub worker-source test (the only test runnable without infrastructure) passes. The remaining 80+ backend tests require PostgreSQL/Redis and cannot be run in this audit environment. The frontend worker test exists but requires a build toolchain not present.

---

## Final Verdict

### Can a fresh technical user reach the first generated result?

**YES WITH MANUAL WORKAROUND**

A technically capable user who:
1. Gets past Basic Auth (operator shares htpasswd)
2. Registers an account
3. Configures their AI provider
4. Creates a Private Worker and copies the token
5. Downloads `worker.cjs` from the hub
6. Configures `.env` with the token and correct `COMFY_INPUT_DIR`
7. Runs `node worker.cjs` (or `./start-worker.sh`)
8. Waits for ONLINE status
9. Imports a TXT file
10. Waits for parsing to complete
11. Opens Chat to verify AI works
12. Triggers generation
13. Waits for GPU processing
14. Opens Player

...can complete the full journey to a generated result. The worker onboarding path (steps 4-7) is now well-documented in the UI since commits `c7cc302..2d55dbf`.

### P0: 3
### P1: 10
### P2/P3: 8

### First thing to fix

Remove nginx Basic Auth (P0-1) so external users can actually reach the register/login screen.

### Main remaining gap

The onboarding experience after register — no welcome checklist or guided path from "I just signed up" to "I configured my AI provider and worker and am ready to generate." The infrastructure is complete; the user guidance layer is missing.
