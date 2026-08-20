# Experimental Beta — Red-Team Audit of DeepSeek Reconnaissance

> **Status:** Read-only red-team audit (no code changes)
> **Auditing:** `docs/04-planning/EXPERIMENTAL_BETA_RECONNAISSANCE_AUDIT.md` (commit 813e761)
> **Method:** Every material claim re-verified directly against the repository (`backend/src`, `gpu-hub`, `worker`, `proxy`, `docker-compose.yml`, `docs/04-planning/EXPERIMENTAL_BETA_VERSION.md`)
> **Date:** 2026-08-20

---

## 1. Claim-by-claim verification

| # | DeepSeek claim | Verdict | Actual state / evidence |
|---|---|---|---|
| 1 | `OPENROUTER_API_KEY` global in `runtime-config.js:225`, exported `:289-290` | **CONFIRMED** | `backend/src/config/runtime-config.js:225,229,289-290` |
| 2 | Two different AI base URLs with different defaults (`api.aicredits.in` vs `integrate.api.nvidia.com`) | **PARTIALLY CONFIRMED** | Both read the *same* env var `AI_API_BASE_URL`; only the fallback defaults differ (`ai-service.js:10`, `chat-engine.cjs:15`). `docker-compose.yml:58` sets `AI_API_BASE_URL=https://api.aicredits.in/v1`, so in the compose deployment chat and agent use the same host. Drift only occurs when the env var is unset. Also: both freeze the value at `require()` time (module const) — a workspace provider must inject the URL per call, not per process. |
| 3 | `ai-service.callAI` uses `config.OPENROUTER_API_KEY`, model fallback `qwen/qwen3.5-122b-a10b` | **CONFIRMED** | `ai-service.js:16-97` |
| 4 | `refineDraft` is a live chokepoint ("bootstrap refinement") | **INCORRECT (dead code)** | `refineDraft` (`ai-service.js:145`) has **zero callers** anywhere in the repo (grep across `backend/`). Bootstrap refinement runs through the agent pipeline → `agent/ai-caller.js`. The report counts a dead function as part of the change surface. |
| 5 | `agent/ai-caller.js` is the agent chokepoint wrapping `aiService.callAI` | **CONFIRMED** | `agent/ai-caller.js:10-35`; writes `agent_conversations` AND `agent_messages` |
| 6 | ~12 `callAI` sites in `pipeline-steps.js` + `unit-splitter.js:155` | **CONFIRMED** | 12 occurrences confirmed (grep), `unit-splitter.js:155` confirmed |
| 7 | Guard in `bootstrap.js:43`: `if (!config.OPENROUTER_API_KEY)` | **CONFIRMED** | `agent/bootstrap.js:43` (inside `bootstrapWithAgent`) |
| 8 | Direct fetch in `ai-routes.cjs` L315/L511/L738, bearer = `OPENROUTER_API_KEY \|\| AI_API_KEY`, model `AI_MODEL \|\| qwen/qwen3-32b` | **CONFIRMED** | `ai-routes.cjs:315,511,738` — but these serve **three** endpoints: `/ai/chat`, `/ai/chat/stream`, and **`/ai/prompt`** (L713). The report labels the chokepoint "chat + streaming" and omits `/ai/prompt` as an explicit entry point. |
| 9 | `workers` PG table exists but unused; registry is Redis-only | **CONFIRMED** | `schema.js:191`; no `INSERT/SELECT FROM workers` anywhere outside the schema (grep negative) |
| 10 | `/worker/heartbeat` L490 no auth; `/worker/status` L505; `/worker/counts` L515 | **CONFIRMED** | `generation-routes.cjs:489-515`; heartbeat accepts any `type`+`worker_id` |
| 11 | Worker heartbeat keys `animastor:worker:heartbeat:{type}:{worker_id}`, TTL 30s | **CONFIRMED** | `worker-health.js:18-26`, `config.WORKER_HEARTBEAT_KEY` |
| 12 | `gpu-hub requireApiKey` (L33) — open access when key unset | **PARTIALLY CONFIRMED — understated** | See §4: even *with* the key set, `/beacon`, `/task/next`, `/task/result`, `/task/error` are **never** authenticated. |
| 13 | Worker sends no token anywhere; beacon is `{id,...}` only | **CONFIRMED** | `worker/worker/worker.cjs:138-152` — no auth token in beacon, poll, result, or error |
| 14 | Jobs carry `book_id` only; hub payload has no workspace | **CONFIRMED** | `gpu-dispatcher.js:53-62` payload = job_id/params/build_id/book_id/chapter_id/scene_id/stage; `generation_tasks` table has `book_id`, `worker_id` — no `workspace_id` (`schema.js:169-185`) |
| 15 | `req.workspace.id` available on every relevant request | **CONFIRMED with caveat** | `auth-context.js:41-92`; caveat: pre-auth requests pass everything (`hasIdentity()` false → all guards return allow), and any anonymous WRITE under `/api/v1` auto-provisions a guest (`auth-context.js:79-87`). |
| 16 | Background jobs carry `book_id` only — the key gap | **CONFIRMED** | `import-routes.cjs:833` (`setImmediate` → `bootstrapNextWindow`), `import-routes.cjs:934` (`windowGenerator.runBackgroundWindowGeneration`), scheduler/loops in `runtime/` — none carry workspace. |
| 17 | Backend `gpu-dispatcher` sends `x-api-key` only if `GPU_HUB_API_KEY` set | **CONFIRMED** | `gpu-dispatcher.js:64-68` |
| 18 | Settings has General/VBook/Worker sections; no provider/worker-management API | **CONFIRMED** | `SettingsPage.tsx:15-21,136-137`; `config-routes.cjs` (29 lines, limits only) |
| 19 | `workspace_ai_providers` table proposal; extend `workers` with `workspace_id`/`auth_token_hash` | **PLAUSIBLE — needs FK care** | See §8: guest purge hard-deletes workspaces, so FK must be `ON DELETE CASCADE`. |
| 20 | Tests suite (~60 files) mirrors the proposed patterns | **CONFIRMED** | `backend/tests/` 69 files; mocha/chai (`backend/package.json:9`) |
| 21 | `auth-service.resolveDefaultWorkspace` / `bookAccessDecision` | **CONFIRMED** | `auth-service.js:86,307` |
| 22 | `connectors/profiles`, `layer-config` in Worker settings UI | **CONFIRMED** | `SettingsPage.tsx` WorkerSection |

**Missing from the report entirely:** §4 findings (hub endpoint auth matrix), dead `refineDraft`, broken `/ai/prompt`, compose hard-dependency on global key, `rpoplpush` queue semantics, encryption infrastructure absence, stale-dispatch result bypass, `checkAIHealth` global cache.

---

## 2. AI architecture — real dependency graph

```
Chat / Chat-stream / /ai/prompt                Agent / TXT pipeline
────────────────────────────────               ──────────────────────────────
POST /api/v1/ai/chat        (ai-routes:222)    POST /api/v1/book/:id/bootstrap
POST /api/v1/ai/chat/stream (ai-routes:473)          ↓ (import-routes.cjs:608)
POST /api/v1/ai/prompt      (ai-routes:713)    txtImporter.bootstrapImportedText (txt-importer.js:150)
      ↓  (3 × inline fetch)                          ↓
chatEngine.AI_API_BASE_URL                     agentService.bootstrapWithAgent (agent/bootstrap.js:~30)
      +                                              ↓
Bearer config.OPENROUTER_API_KEY               agent/pipeline-runner → pipeline-steps (12 sites)
      || process.env.AI_API_KEY                      ↓
      +                                        agent/ai-caller.callAI
model process.env.AI_MODEL                           ↓
      || 'qwen/qwen3-32b'                      ai-service.callAI  ←── refineDraft (DEAD, 0 callers)
      ↓                                        ←── checkAIHealth (generation-routes:540, /worker/counts)
https://integrate.api.nvidia.com/v1                  ↓
 (default; overridden by AI_API_BASE_URL)      https://api.aicredits.in/v1
                                               (default; same AI_API_BASE_URL env)
```

Answers:

1. **Real AI chokepoints = 2**, not 3-4:
   - `ai-service.callAI` (covers all agent paths, health; `refineDraft` is dead),
   - the three inline `fetch()` sites in `ai-routes.cjs` (chat / stream / prompt).
   `chat-engine.cjs` does not call the AI API — it only exports `AI_API_BASE_URL`.
   A single `resolveWorkspaceAIProvider(workspaceId)` consumed at these 2 points covers everything.
2. **Direct AI calls DeepSeek missed:** `/api/v1/ai/prompt` (L713) is a real entry point (with image input); also note it is **broken** — `ai-routes.cjs:779` references `parsed.reply` where `parsed` is scoped inside an `if` block → guaranteed `ReferenceError`/500 on success. Dead but present.
3. **Background code without workspace context:** `trigger-next-window` `setImmediate` branch (`import-routes.cjs:833`), `window-generator.runBackgroundWindowGeneration` (`import-routes.cjs:934`), `startup-resume.js`, runtime scheduler/loops — all carry only `book_id`. None are a blocker, because workspace can be re-derived: `books.workspace_id` is self-healed by `workspace-ownership.resolveWorkspaceForBook`.
4. **Can Workspace AI be done through one resolver?** **Yes.** API shape:
   ```js
   resolveAI(workspaceId | bookId) → { endpoint, apiKey, model, source: 'workspace'|'global' }
   ```
   with a `bookId` overload (books → workspace). All consumers already hold either `req.workspace` (HTTP) or `bookId` (background).
5. **Where the resolver physically lives:** new `backend/src/services/workspace-ai-provider.js` (service layer, same level as `workspace-ownership.js`). Not in `ai-service.js` — keep `ai-service` transport-only (`callAI(messages, options, aiProvider)` accepting injected provider, falling back to global env).
6. **Functions without req/workspace context:** `callAI`, `checkAIHealth`, all `pipeline-steps` steps, `window-generator`, scheduler. They receive **bookId**; the resolver's bookId overload is how workspace reaches them. No request-context plumbing needed.
7. **Provider identity snapshot for long jobs:** the agent makes dozens of sequential AI calls over a long session. Minimal Beta rule: **resolve once at session start and freeze the `{endpoint, apiKey, model}` on the `agent_sessions` row / window-generator closure**; later settings edits affect only new sessions. Test Connection is the only place a live re-resolve matters. No need for per-request re-resolution.

---

## 3. AI Provider design — red team

- `workspace_id` alone is sufficient **for Beta** because every other dimension is derivable: user_id = workspace owner; book_id → workspace_id; credential_id = the provider row itself. One row per workspace (Beta: single active provider, `enabled` flag). No provider_id, no session context needed.
- **Multiple providers per workspace:** schema should allow rows but Beta semantics = "first enabled row" / a single-row upsert API. Add `UNIQUE(workspace_id)` + partial-index relaxation later. Recommendation: `UNIQUE (workspace_id) WHERE enabled` is overkill — keep one row per workspace in Beta.
- **Model override per endpoint** (e.g. agent vs chat): not in Beta; `model` column is global per workspace. Both chat and agent chokepoints read it. `enable_thinking`/tools stay as-is.
- **Fallback to global env:** required (docker-compose currently *hard-fails* without `OPENROUTER_API_KEY` — see §12). Fallback order: workspace row → `OPENROUTER_API_KEY` env. Missing both → 503 with a clear error.
- **Disabled provider / deleted workspace:** disabled → same fallback as missing. Deleted workspace → FK CASCADE deletes the row; in-flight jobs fail with provider-missing error (acceptable; job fails, retriable).
- **Temporary guest workspace:** allowed to configure a provider (it's the user's own key); row purges with workspace (§11).
- **Concurrent requests:** resolver must cache per workspace (TTL ~30s) to avoid a PG query per AI call; cache invalidation on write. `checkAIHealth` currently has a **global** 60s cache (`ai-service.js:446-447`) — must become per-workspace or it leaks one workspace's health verdict to another.
- **Long-running job + settings change:** snapshot at session start (see §2.7). Already-running job keeps the frozen credential; UI should say so.

**Minimal Beta rule:** 1 row per workspace; resolver with env fallback; snapshot per session.

---

## 4. Worker / GPU Hub security — the report's biggest understatement

Verified endpoint→auth matrix of `gpu-hub/gpu-hub.js`:

| Endpoint | Protection today | Reality |
|---|---|---|
| `POST /task` | `requireApiKey` | shared static key only (backend↔hub) |
| `DELETE /queue/clear` | `requireApiKey` | same |
| `POST /beacon` | **none** | any client registers any `worker_id`; overwrites registry entries |
| `GET /task/next` | **none** (registered id required) | any registered id can **pop any job of the requested type** |
| `POST /task/result` | **none** | needs matching `dispatch_id` of a running entry; see below |
| `POST /task/error` | **none** | same |
| `GET /health` | none | queue sizes |

Key consequences (all verified):

1. **`GPU_HUB_API_KEY` set does NOT secure the worker-facing surface.** DeepSeek wrote "open access *when key is null*"; in truth only task submission is keyed. Worker polling/result submission has never had auth. Severity: **CRITICAL** (and the hub is internet-exposed: `proxy/conf/default.conf:102,226` proxies `/gpu/` → `gpu-hub:5000`).
2. **No workspace routing at all:** queues are global `animastor:queue:{audio,image,video}`; `/task/next` does `rpoplpush` — the first worker poll of matching type takes the job regardless of ownership. Private Worker mode is impossible without hub changes.
3. **`rpoplpush` semantics constrain the routing design:** the hub pops before it can filter. Beta options (ranked): (a) per-workspace queue keys `animastor:queue:{type}:{workspace_id|public}` — dispatch enqueues to the owning key, worker's beacon records its workspace, `/task/next` reads only the worker's key; (b) pop→check→re-push/skip with subtle starvation/race risk. **(a) is simpler and atomic** — recommended.
4. **Result forgery window:** `/task/result` checks `runningInfo.dispatch_id === dispatch_id` (`gpu-hub.js:496`), and backend `verifyDispatchIdentity` re-checks — good. BUT backend has a deliberate bypass (`generation-routes.cjs:1283-1296`): for audio/video, a **stale dispatch_id is accepted** while the scene sits in WAITING_CHUNKS/MERGING. An attacker who obtained a past dispatch_id (it appears in logs and Redis meta keys) can inject fake media into a colleague's active scene in a multi-tenant deployment. Existing weakness; must be closed before shared deployments (worker token on result + workspace match is enough in Beta).
5. **Worker identity spoof:** `worker_id` is libre (`WORKER_ID = env || 'gpu-'+hostname`). Impersonating an existing id hijacks its registry slot and heartbeats.
6. **Global worker counts:** `/worker/counts` (`generation-routes.cjs:515`) and `worker-health` SCAN global keys — private workers are counted for everyone.

Required Beta protections (threat model, §9):

| Attack | Current | Required (Beta) | Severity |
|---|---|---|---|
| forge worker_id | none | token required in beacon; id derived/bound to token | HIGH |
| steal worker token | n/a | hash-only storage (PG, scrypt sha256 style like `password.js`), show once in UI, rotation = new row | HIGH |
| fetch another workspace's task | none | workspace-scoped queue keys; worker→workspace binding checked on `/task/next` | CRITICAL |
| submit result for foreign job | dispatch_id check only | worker token → workspace match against job's workspace | HIGH |
| fake heartbeat/beacon | none | token on beacon; heartbeat provenance bound to registered workspace | MEDIUM |
| impersonate existing worker | trivial | token (bearer) required for poll/result; registry slot keyed by authenticated worker | HIGH |
| get jobs via GPU Hub directly | possible (open endpoints) | hub enforces worker token on all worker-facing endpoints | CRITICAL |
| open hub via nginx `/gpu/` | public | keep endpoint (workers are remote by design) but authenticated; additionally restrict `/task` to backend IP or keep x-api-key mandatory | HIGH |

---

## 5. Secrets storage

Verified state:

- **No encryption utility exists.** Only `crypto.scrypt` password hashing (`auth/password.js`), SHA-256 file hashes, `crypto.randomBytes` for ids. No AES/cipher code anywhere.
- **Logging:** AI errors log `errText.substring(0,500)` of provider responses (`ai-service.js:54`) and never headers/keys — safe. HTTP access log logs method/URL/status only (`backend.cjs:163-169`) — safe. Agent conversations persist **prompts** (`agent_messages.content`) — no keys unless a prompt accidentally contains one; low risk, no action.
- **Frontend:** `ai_chat_sessions`, debug info never carry keys today. The new provider CRUD response **must never serialize `api_key`** — return `{api_key_set: true}` mask only. Test Connection must return only status + provider-side error (sanitized, truncated), never echo the key.
- **Database dumps / backups:** `backups/` + `src-backup.sh` exist → keys land in PG dumps. Hence encryption at rest is mandatory, not optional.

**Minimal Beta answer:**
1. AES-256-GCM via stdlib `crypto`; key from env `WORKSPACE_SECRET_KEY` (32 bytes, base64). Store `iv|tag|ciphertext`. No new dependency.
2. Alternative (equally acceptable): scrypt won't work for secrets (one-way hash) — use GCM.
3. Never return/write the plaintext anywhere; mask `api_key` on all reads; truncate + sanitize provider error text in Test Connection responses.
4. Add WORKSPACE_SECRET_KEY to compose/docs next to existing secrets.

---

## 6. Chat full trace

`POST /api/v1/ai/chat` (`ai-routes.cjs:222`):
auth: `authContext` (backend.cjs:83) → identity or anonymous pass-through; `aiBookGuard` (backend.cjs:125-147) resolves book from query/body `book_id` or `session_id`→`ai_chat_sessions.book_id` → `checkBookAccess` (403/410) — **`if (!bookId) return next()`** — endpoints whose book scope can't be resolved pass unguarded. Every AI endpoint checked supplies `book_id` or `session_id` (including `/ai/modeswitch`, `/ai/mode-router`, `/ai/lock`, `/ai/sessions`), so the gap is latent, not exploited. For **unauthenticated** callers `hasIdentity()` is false → everything allowed (by design, pre-auth compat).
book: `book.loadBook(bookId) || lazyBook.loadDraftBook(bookId)`.
provider/model/key: `chatEngine.AI_API_BASE_URL` + `config.OPENROUTER_API_KEY || process.env.AI_API_KEY` + `process.env.AI_MODEL || qwen/qwen3-32b` (L315-327). Streaming mirror at L511 (SSE, result persisted after stream). Errors → raw `AI API error: status` only; provider body text logged server-side, not returned — acceptable.
Workspace: `req.bookWorkspace` (workspace owning the book) is set by the guard and is the correct provider scope.

**Conclusion: chat can reliably use Workspace AI** — the guard already resolves workspace; inject at the two fetch sites. Only blocker: when there is no identity (pre-auth), there is no workspace → env fallback only (correct Beta behavior).

---

## 7. TXT / Agent pipeline trace — does workspace survive?

```
POST /api/v1/book/import|import-txt       (import-routes.cjs:105,504)
  └─ createDraftBook → attachBookWorkspace(bookId, title, req.workspace?.id)   ← workspace stamped (req.workspace)
POST /api/v1/book/:bookId/bootstrap       (:608)
  └─ requireBookAccess('bookId') guard → req.bookWorkspace
      └─ txtImporter.bootstrapImportedText(bookId)                            ← book_id only from here
          └─ agentService.bootstrapWithAgent(bookId,...)                       ← no workspace
              └─ pipeline-steps (12 AI calls) / unit-splitter
                  └─ ai-caller.callAI → ai-service.callAI (global key)
trigger-next-window (:701) → setImmediate → bootstrapNextWindow(bookId,...)    ← fire-and-forget, book_id only
window-generator.runBackgroundWindowGeneration(bookId,...) (:934)              ← background, book_id only
```

**Workspace identity does NOT survive into the AI layer — but it doesn't need to travel: `books.workspace_id` is the recoverable anchor** (`workspace-ownership.resolveWorkspaceForBook` self-heals rows; `book-repo.getWorkspaceId` used by guest checks). All background paths hold `bookId`, so `resolveAI(bookId)` re-derives the workspace at AI-call time. The report's "key gap" framing is correct; the remedy is resolver-with-bookId-overload, not ctx propagation.
Generation jobs (`gpu-dispatcher.sendUnified`) currently stamp `book_id` only — the hub needs `workspace_id` added at stamp time (§4.3).

---

## 8. Ownership chain & DB design

| Entity | workspace_id? | owner? | resolution | authz | background-safe? | cross-tenant risk |
|---|---|---|---|---|---|---|
| workspaces | — | owner_user_id (nullable for guests) | sessions/guests tables | — | n/a | low |
| books | YES (self-healed) | via workspace | `checkBookAccess` | guards ✓ | ✓ (books.workspace_id) | guarded |
| scenes / IU / assets | book_id only | via book | book guards | ✓ | ✓ | low |
| generation_tasks | book_id only, worker_id | via book | task-repo | none | ✗ needs stamp | job-level low |
| worker registry (Redis) | none | none | none | none | — | **HIGH** |
| workers (PG table) | column does not exist | unused | unused | unused | — | — |
| ai_chat_sessions | book_id only | via book | aiBookGuard | ✓ | ✓ | low |
| agent_sessions/steps/convos | session→book | via book | book guard | ✓ | ✓ | low |
| Redis job keys (`animastor:queue:*`, `running`, `result:*`, heartbeats) | none | book_id inside payload | none | none | — | **HIGH (no routing)** |

DB verdict:
- **`workspace_ai_providers`** — correct. Columns: `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE PRIMARY KEY` (one row/workspace in Beta), `provider, endpoint, api_key_enc, model, temperature, max_tokens, enabled, created_at, updated_at`. **CASCADE is mandatory** — guest purge hard-deletes workspaces (`guest-repo.purgeExpired`) and today deletes books manually because FKs don't cascade; a new table without CASCADE orphans rows.
- **Reuse `workers` table — YES, safe.** It is provably unused; PK `worker_id TEXT` fits `gpu-<hostname>` convention; add `workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE`, `auth_token_hash TEXT`, `last_workspace_seen`, extend the `worker_type` CHECK (already includes audio/image/video/upscale). Indexes: `idx on (workspace_id, worker_type)`; unique on `auth_token_hash`.
- **`worker_tokens` separate table: NO** for Beta (revocation = delete row / set `revoked_at` if rotation wanted later). One table keeps ownership trivial.
- **Guest behavior:** providers and workers on temporary workspaces are allowed, expire/purge with workspace, and **conversion preserves them automatically** — `convertTemporaryWorkspace` keeps the same workspace id (`guest-repo.js:152`), rows survive with unchanged workspace_id. Uniform, minimal rule: *everything keyed by workspace_id inherits the workspace lifecycle*.
- **Migration order:** 1) `workspace_ai_providers` + resolver + fallback (zero-risk), 2) provider API/UI/test-connection, 3) workers table extensions + token issuance, 4) hub workspace queues + worker auth, 5) stamping in dispatcher. Each step independently shippable.

---

## 11 (Guest) / 14 consolidated

- Guest can configure AI provider: **yes** (Beta: instant BYO trial). Never expose conversion problems: conversion keeps workspace id → rows survive; purge (`purgeExpired`, DEFAULT grace 23d) deletes them; expired workspace answers 410 in guards (already wired for books — same pattern for new endpoints).
- Guest workers: allow, purged together. If product wants to forbid, a one-line type check suffices — default recommendation: allow (BYO principle).
- Leak check: purge deletes `books` + `workspaces` rows explicitly; new tables cascade; Redis job keys have TTLs; agent/ai sessions are keyed by book and remain as orphans after purge (pre-existing condition, also affects AI providers' conversations — no new risk).

---

## 12. Additional discovered risks / change-surface corrections

1. `docker-compose.yml:59` uses `${OPENROUTER_API_KEY:?...}` — backend container **refuses to start** without a global key. Must become `${OPENROUTER_API_KEY:-}` for BYO Beta. Same for `AI_API_BASE_URL` hardcoded at `:58`. (Missed by the report.)
2. `ai-routes.cjs:779` — `parsed.reply` ReferenceError: `/ai/prompt` 500s today. Cheap to fix or delete; it shares the chokepoint so it will be touched anyway.
3. `checkAIHealth` 60s **global** cache (`ai-service.js:446`) → per-workspace cache keyed by workspace id.
4. Stale-dispatch audio/video acceptance (`generation-routes.cjs:1283-1296`) is a result-forgery softener; tighten together with worker-token checks.
5. `runtime-scheduler.js` + `task-repo` write `generation_tasks` without workspace — when stamping jobs, add `workspace_id` column here too (cheap, part of `task-repo.createTask` call sites only).

---

## 15/16. Failure & test matrix (architecturally important only)

Must-hold invariants for Beta tests (all expressible with existing mocha/chai HTTP-test patterns):

- Workspace A cannot read/modify Workspace B provider (CRUD; masked api_key on all reads).
- API key never returned to frontend (GET after PUT returns mask only).
- Provider resolution falls back to env when missing/disabled; errors when neither.
- Long session keeps frozen snapshot despite settings change mid-run.
- Worker A of workspace X never receives workspace Y task (queue isolation test against a real Redis).
- Worker without token: beacon 401, `/task/next` 401, `/task/result` 401 (hub).
- Token cannot impersonate another worker (token→worker binding checked).
- Result submission for another workspace's job rejected (workspace mismatch on hub+backend).
- Guest cannot reach another workspace's book/settings; guest conversion preserves provider+worker rows; purge deletes them.
- Deleted workspace → provider row gone (CASCADE), in-flight agent session degrades cleanly.

Concurrency cases that matter architecturally: provider deleted mid-session (snapshot saves it), hub unreachable (existing retry/lease; unchanged), duplicate dispatch (existing dedup; unchanged), lease expiry (unchanged). Provider changed mid-stream-chat (one fetch per request — naturally safe).

---

## 17. Minimal architecture (single recommended variant)

```
User → Workspace → workspace_ai_providers(1 row) → resolveAI(wsId|bookId)
         │                                              ├─ ai-service.callAI(messages, opts, provider)
         │                                              └─ ai-routes /ai/chat, /chat/stream, /ai/prompt inline fetch
         │
         └→ workers(workspace_id, auth_token_hash)
                Worker —Bearer token→ gpu-hub /beacon,/task/next,/task/result,/task/error
                gpu-dispatcher stamps workspace_id → queue animastor:queue:{type}:{workspace_id}
```

- workspace_id is **introduced**: workspace-ai-provider resolver + `workers.workspace_id` + dispatch payload.
- **Persisted**: `workspace_ai_providers`, `workers`, `generation_tasks.workspace_id` (optional), hub task payload `workspace_id`.
- **Checked**: provider CRUD endpoints (`req.workspace.id` + membership), hub token→worker→workspace vs job workspace, Test Connection (masked).
- **Propagated**: never in requests; always re-derived server-side from book/workspace or injected at enqueue time.

## 18. Change surface

**MUST CHANGE**
| File | Change | Reason |
|---|---|---|
| `backend/src/storage/postgres/schema.js` | +`workspace_ai_providers`, extend `workers` (CASCADE FKs, indexes) | new ownership targets |
| `backend/src/services/workspace-ai-provider.js` (new) | resolver + CRUD + AES-GCM encrypt | single source of truth |
| `backend/src/services/ai-service.js` | `callAI(..., provider)` injection; per-workspace health cache | chokepoint 1 |
| `backend/src/routes/ai-routes.cjs` | resolve provider via `req.bookWorkspace`/book→ws; fix L779 | chokepoint 2 |
| `backend/src/services/agent/bootstrap.js` (:43 guard) + session snapshot | allow starting when workspace provider exists; freeze credential | gate correctness |
| `backend/src/routes/config-routes.cjs` or new provider-routes + worker-token routes | CRUD / test-connection / token issue | settings API |
| `backend/src/runtime/gpu-dispatcher.js` (+`task-repo.js` if column added) | stamp `workspace_id` | hub routing input |
| `gpu-hub/gpu-hub.js` | worker-token auth on beacon/next/result/error; `WORKER_AUTH` via backend or hashed token copy; per-workspace queue keys; `/task` enqueues to `queue:{type}:{ws}` | isolation + auth |
| `worker/worker/worker.cjs` | read `WORKER_TOKEN`, bearer on all hub calls | client-side auth |
| `frontends/app/src/pages/SettingsPage.tsx` | AI Provider + Workers(token) sections; i18n keys | UI |
| `docker-compose.yml` (+`.env.example`) | make global key optional, add `WORKSPACE_SECRET_KEY`, document `GPU_HUB_API_KEY` mandatory | deploy-blocker removal |

**MAY CHANGE:** `window-generator.cjs` (pass provider snapshot), `runtime-scheduler.js` (stamp workspace), debug/health endpoints (scope counts).
**DO NOT CHANGE:** agent prompts/steps/skills, pipeline orchestration, dispatch/lease engine, existing auth/workspace system, chat prompt building, existing tests.

## 19. DeepSeek report score

- AI architecture: **7/10** (chokepoints found, but dead `refineDraft` counted, `/ai/prompt` not explicitly tracked, confuses 3 modules vs 2 real chokepoints)
- Workspace analysis: **8/10** (accurate; missed pre-auth pass-through nuance + guest auto-provision)
- Worker analysis: **6/10** (facts right, but critical auth matrix inverted: hub worker endpoints unauthenticated regardless of key; rpoplpush routing constraint absent)
- Security analysis: **5/10** (misses #1-#4 above; stale-dispatch bypass; no secrets-infra check)
- Database analysis: **7/10** (right tables, missing CASCADE/purge interaction, token-table decision, workers-reuse verification done correctly)
- Completeness: **7/10**
- Architectural correctness: **8/10** (minimal-path thesis is correct and validated)

## 20. Final verdict

### A. What DeepSeek got right
Minimal-path thesis is valid: 2 real AI chokepoints exist; workspace anchor recoverable via `books.workspace_id`; workers table safely reusable; orchestration needs no rewrite; test patterns exist; Settings UI extensible.

### B. What DeepSeek missed
Hub worker-endpoint auth fully absent even with key set; nginx exposes `/gpu/`; compose hard-requires global key; `AI_API_BASE_URL` env shared with divergent defaults; `rpoplpush` routing constraint; no encryption infra; `checkAIHealth` global cache; stale-dispatch acceptance bypass; guest auto-provision on any `/api/v1` write; CASCADE requirement against guest purge.

### C. What DeepSeek got wrong
`refineDraft` is dead code (0 callers) yet listed as a chokepoint; "3 chokepoints" is 4 modules but 2 actual; implied hub is secure when key is set; test-connection treated as trivial without secrets audit.

### D. New risks discovered
1. `/gpu/task/result` stale-dispatch acceptance → fake-result injection in multi-tenant mode.
2. `/ai/prompt` broken (ReferenceError).
3. Pre-auth anonymous access still passes all guards (by design) — any "private" endpoint must require identity explicitly.
4. Any anonymous POST under `/api/v1` creates a guest workspace — provider writes without identity land in throwaway workspaces (must require identity for provider endpoints).

### E. Recommended minimal architecture
Snapshot provider in `workspace_ai_providers` (AES-256-GCM, env key) → resolver `resolveAI(wsId|bookId)` injected at 2 chokepoints with env fallback + per-session snapshot; `workers` table extended with workspace+token-hash; hub adds worker-token auth + per-workspace queue keys; dispatcher stamps workspace_id; Settings gets two sections; compose un-blocked.

### F. Recommended implementation order
B1 schema (both tables) → B2 resolver+chokepoint injection (env fallback kept; tests) → B3 provider API/UI/test-connection → B4 worker token API + workers table → B5 hub auth + workspace queues + dispatcher stamping → B6 worker client token → D E2E single-workspace, then two-workspace isolation.

### G. Go / No-Go
**GO.** The repository is sufficiently understood to begin implementation. Residual reconnaissance needed before Phase C (not blocking B): none for AI; for workers — confirm hub deployment network layout (is `/gpu/` intentionally public on the target host) and pick token-verification strategy (backend callback vs shared hashed token in hub). Both are implementation-phase decisions, not reconnaissance gaps.
