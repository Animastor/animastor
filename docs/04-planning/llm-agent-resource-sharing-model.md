# LLM / AI Resource Sharing Model — Design Document

> 2026-08-31 · Research / architecture only — **no production code, no schema,
> no API, no Web/Android changes**. Companion to
> `worker-sharing-model-design.md` (the GPU-worker sharing design, v2) and
> `docs/architecture/EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER.md` (the Personal
> AI Provider spec, Phase 4).
>
> **Reading guide.** This document strictly separates two layers:
> - **CURRENT IMPLEMENTATION** — facts about the code as it exists today
>   (verified against files; nothing proposed).
> - **PROPOSED FUTURE MODEL** — design intent. Tables, endpoints, routing
>   stages and UI in those sections **do not exist yet** and must not be
>   assumed to exist.

---

## 1. Executive Summary

Animastor already has a working **two-tier LLM resource model** that mirrors
the worker modes more closely than the repository's vocabulary suggests:

- **Private** — the *Personal AI Provider* (`workspace_ai_providers`, one row
  per workspace, AES-256-GCM-encrypted key, free-text endpoint + model,
  Experimental Beta Phase 4). This **is** the "private mode" the sharing
  model needs; it already supports custom endpoints and user-provided models.
- **System** — the *System AI Provider* (`system_ai_providers`, admin-managed
  via `/admin`, `System AI Control` kill switch in `system_settings`) plus the
  legacy env fallback (`OPENROUTER_API_KEY` / `AI_API_BASE_URL`).
- **Share** — **does not exist for LLMs at all.** There is no registration of
  LLM endpoints as resources, no sharing policy, no shared-pool fallback, no
  health registry, and no user-hosted runtime concept.

The central architectural finding: **what would be shared is not the model
and not the Agent — it is the inference endpoint (its serving capacity).**
The model (`qwen/qwen3-32b`) is free-text metadata; the Agent is a
backend-resident prompt/pipeline that *consumes* whatever provider the
resolver returns. The endpoint is the only addressable, ownable, shareable
thing.

**Main recommendation** (details in §6–§13):

1. Keep **"AI Provider"** as the consumer-side binding (credential + model
   choice) — do not rename or restructure what works.
2. Treat the **inference endpoint** as the future shareable resource. In V1
   the provider row *implicitly is* the endpoint (as today); from V2 the
   endpoint becomes a first-class **AI Endpoint** record (registered,
   capability-advertised, health-tracked) and the provider becomes a pure
   consumer binding.
3. Mirror the worker-sharing decision: **a private AI provider's endpoint may
   carry an active share policy without changing its ownership** — the
   owner's own resolution path is untouched; the shared pool only borrows
   spare capacity, with owner traffic always prioritized.
4. **Do not route LLM inference through gpu-hub.** Chat is synchronous/SSE
   request–response; gpu-hub is a job queue for ComfyUI media tasks
   (`audio|image|video`). LLM dispatch stays in the backend's existing
   `resolveAIProvider(workspaceId, purpose)` seam, which was explicitly built
   as the extension point for future routing.
5. Sharing a **paid API key endpoint** shares the owner's money; sharing a
   **self-hosted runtime** (Ollama/vLLM/llama.cpp on the owner's GPU) shares
   unmetered compute. V1 UX must make this distinction explicit and nudge
   toward self-hosted sharing.

---

## 2. Current Animastor LLM/Agent Architecture (CURRENT IMPLEMENTATION)

### 2.1 Where text LLMs actually run

All text-LLM traffic is **direct server→provider HTTP** to OpenAI-compatible
`{base}/chat/completions`. Nothing LLM-related passes through gpu-hub or any
queue. The six call sites:

| Call site | Location | Notes |
|---|---|---|
| `callAI(messages, options, provider)` | `backend/src/services/ai-service.js:20-117` | Core wrapper; 3 retries w/ backoff; `stream:false`; model chain `options.model → provider.model → OPENROUTER_MODEL → 'qwen/qwen3.5-122b-a10b'` |
| `checkAIHealth(cfg, provider)` | `backend/src/services/ai-service.js:487-535` | `max_tokens:1` probe, model `qwen/qwen3-8b`, 60s per-provider cache |
| `refineDraft(chapterText)` | `backend/src/services/ai-service.js:165-406` | Import-time literary analysis |
| `resolveChatAI(bookId)` + fetches | `backend/src/routes/ai-routes.cjs:31-44` (chat `:360`, stream `:600`, prompt `:846`) | model chain `provider.model → AI_MODEL → 'qwen/qwen3-32b'`; `enable_thinking:true` |
| `testConnection({endpoint, apiKey, model})` | `backend/src/services/workspace-ai-provider.js:512-549` | Settings "Test connection" |
| `callAI` (agent wrapper) | `backend/src/services/agent/ai-caller.js:30-59` | AsyncLocalStorage provider context; logs to `agent_conversations`/`agent_messages` |

### 2.2 The provider resolver — the existing routing seam

`resolveAIProvider(workspaceId, purpose)` (`workspace-ai-provider.js:460-482`)
is the **single addressable entry point** for every LLM consumer, with
`purpose ∈ {'chat','parser','agent'}`. Today it is a thin alias over
`resolveAIForWorkspace`, but the code comments explicitly reserve it as the
insertion point for "future per-purpose routing, fallback chains, or
per-agent provider trees". Resolution chain today:

```
workspace_ai_providers row (per-workspace, PK = workspace_id)
  → global env fallback (OPENROUTER_API_KEY, legacy path)
  → system_ai_providers row (`system-ai.js:80-123`, admin path)
  → source:'unconfigured' (fail-closed)
```

Every resolution is cached in-process for 30s (metadata only — **plaintext
keys never enter Redis**), invalidated on writes.

### 2.3 AI Agents — what "agent" means here

"Agents" are **not** model owners. They are the book-import/analysis
pipeline ("step 0 + 5 steps") in `backend/src/services/agent/`:

- Steps: `stepAnalyzeStructure`, `stepExtractCharacters`,
  `stepExtractLocations`, `stepCreateScenes`, `stepCreateUnits`,
  `stepGenerateVoices`, plus reconciliation/polish/repair passes
  (`pipeline-steps.js:202-1551`).
- Prompts are **files, not DB**: `backend/ai/rules/*.md` (13 rule files,
  enumerated in `agent-prompts.js:77-83`), `backend/ai/skills/`,
  `backend/ai/examples/*.json`, loaded via `ai-loader.js` with a 60s cache.
- **No per-agent or per-step model choice exists.** Every step calls
  `aiCaller.callAI(messages, { maxTokens: 4096 })` with no `options.model`;
  the model comes exclusively from the resolved provider
  (`bootstrap.js:64-77` wraps the whole pipeline in
  `runWithProvider(resolved, …)` via AsyncLocalStorage, fails closed:
  "AI assistant is not available — cannot import book").
- The only persisted model name is provenance: `agent_conversations.model`
  (`schema.js:534`) records which model served each conversation.

### 2.4 AI Assistant (chat)

Book-scoped chat under `/api/v1/ai/*` (`backend/src/routes/ai-routes.cjs`):
`POST /ai/chat` (`:257`), `POST /ai/chat/stream` (**SSE**, `:553`), session
CRUD (`:161-223`), `/ai/modeswitch` (`:694`), `/ai/prompt` (`:811`, with
vision `image_base64` support `:832-837`). The chat engine
(`backend/src/services/chat-engine.cjs`) builds system prompts, defines
tools (`EDIT_BOOK_TOOL`, `STORYBOARD_TOOL`, `IMPORT_BOOK_TOOL`,
`EXTRACT_ENTITIES_TOOL`, `VALIDATE_BOOK_TOOL`), and model patches are
validated server-side (`applyPatchesValidated` — JSON-Patch + bundle-contract
gate). Qwen3-specific workarounds exist: tool-call extraction from content
blocks (`extractToolCallsFromContent :59-156`) and `<think>` stripping
(`:386`).

History: `ai_chat_sessions` (messages as JSONB in-row) — plus a richer
`chat_sessions`/`chat_messages` pair (`chat-repo.js`) currently written only
by agent bootstrap progress messages. **No conversation state lives on the
provider/endpoint side; every LLM call is stateless.**

### 2.5 Storage (relevant tables)

All in `backend/src/storage/postgres/schema.js` (`SCHEMA_SQL :3-551`,
migrations `:553-1454`):

| Table | Key columns | Role |
|---|---|---|
| `workspace_ai_providers` (:74-86; PAP-1 :1375-1407) | `workspace_id UUID PK`, `provider_type` (`openrouter\|openai-compatible\|custom`), `endpoint TEXT NOT NULL`, `api_key_enc TEXT NOT NULL` (AES-256-GCM), `model TEXT` free-text, `enabled`, `status ('untested\|ok\|failed')`, `last_tested_at` | **Private LLM tier.** Singleton per workspace. No visibility/sharing column. |
| `system_ai_providers` (:103-113; SYS-1 :1432-1442) | `id TEXT PK DEFAULT 'default'`, same credential envelope | **System LLM tier**, admin-only CRUD. |
| `system_settings` (:91-95) | `key='system_ai' → {enabled}` | Kill switch ("System AI Control"); toggling it does **not** affect personal providers (`system-ai.js:6-9`). |
| `ai_chat_sessions` (:411-420) | `book_id`, `mode`, `messages JSONB` | Chat history (book-scoped). |
| `chat_sessions` / `chat_messages` (:425-453) | `user_id`, `book_id`, `topic`, `role` | Secondary history (agent progress). |
| `agent_sessions` / `agent_steps` / `agent_conversations` / `agent_messages` (:486-548) | `model TEXT` on conversations | Agent pipeline state + provenance. |
| `workers` (:263-284) | `worker_type CHECK ('audio','image','video')`, `mode CHECK ('private','share','system')`, `workspace_id` (NULL only for `mode='system'`), `token_hash` | **GPU workers only — no LLM worker type exists.** |
| `books` (:135-147) | `visibility CHECK ('private','public','shared')` (:142) | **Dormant** — declared, never read/written by any route. |

**Not present anywhere:** a model registry, an endpoint registry, multi-
provider rows per workspace, LLM usage metering, quotas/credits tables,
or any local-inference concept (zero matches for Ollama / LM Studio /
llama.cpp / vLLM / text-generation-webui under `backend/`).

### 2.6 Auth context (relevant parts)

- Sessions: HttpOnly cookie `animastor_sid` (+ `animastor_gid` for guests;
  guest workspaces auto-provisioned on content writes, `auth-context.js:85-95`).
- Admin: `requireAdmin` (`auth-context.js:130-144`) — `role='admin'` OR
  `ADMIN_USERNAMES` env allowlist; guards all `/api/v1/admin/*`.
- Provider isolation: `workspace_id` is always server-resolved from
  `req.workspace` — never from the request body; `aiBookGuard` blocks
  cross-tenant book operations (`middleware/ai-book-guard.js`).
- Secrets: `WORKSPACE_SECRET_KEY` → AES-256-GCM `iv:tag:payload` envelope for
  both provider tables; plaintext keys live only in the 30s in-memory cache
  and the AsyncLocalStorage context of one call.
- SSRF: `assertPublicEndpoint` (`url-safety.js:191-234`) rejects loopback/
  private/link-local/metadata targets, enforced at save time
  (`settings-ai-routes.cjs:91`) **and per fetch hop** (`safeFetch`,
  `url-safety.js:249`).
  Consequence: a cloud user **cannot** point a personal provider at their own
  `localhost` Ollama today; only a self-hosted operator can, via env config.

---

## 3. Current Terminology

Do **not** assume "LLM", "model", "provider", "endpoint" or "agent" mean what
a generic AI-platform glossary would suggest. The actual vocabulary:

| Concept (this document) | Actual term in Animastor | Where the user sees it |
|---|---|---|
| Text LLM access config | **"AI Provider"** / "Personal AI Provider" / "workspace AI provider" | Settings → "AI Provider" (`ai_provider_title`, EN/RU i18n `i18n.ts:930-957`) |
| Provider kind | `provider_type`: `openrouter` / `openai-compatible` / `custom` | "Provider type" select, exactly 3 options |
| Inference URL | **`endpoint`** (field) | "Endpoint" label — a plain text field, not a managed resource |
| Model identifier | **`model`** (free-text string, never a registry — spec §15 of the PAP doc) | "Model" text input; hint "Leave empty to use the default model" |
| Credential | **"API Key"** (`api_key_enc`) | "API Key" password field; one-time entry, `••••last4` afterwards |
| System tier | **"System AI Control"** / "System Provider" | Admin page only (`AdminPage.tsx:150-360`); kill switch copy: "Platform-level AI. Turning this off blocks all system/provider AI calls." |
| Chat feature | **"AI Assistant"** / "AI chat" | Header chip "AI", route `/ai`, Android `AiAssistantFragment` |
| Book-analysis pipeline | **"Agents"** / "VBook agents" | Generator card "VBook Agents: {n}" (`generate_section_vbook`) |
| GPU media compute | **"Workers"** / "Private Workers" / "GPU Hub" | Settings → "Private Workers"; counts card "Workers" |
| Worker modes | `mode`: `private` / `share` / `system` | **Backend-only today** — no UI exposes the mode |
| AI availability metric | `vbook` / `active_vbook` fields in `/api/v1/worker/counts` | Feeds the "VBook Agents: {n}" count |
| Media-model configs | **"Prompt Profiles"** / connectors / workflows (`qwen-tts`, `qwen-image`, `ltx-2.3`) | Settings → "Prompt Profiles" — these are ComfyUI workflow configs, **not** LLM models |

Key naming hazard: Animastor's word **"model"** in worker/connector contexts
(`qwen-image`, `ltx-2.3`) means *media-generation prompt profiles*, while the
LLM "model" is a free-text string inside the AI Provider form. Any future UI
must disambiguate (recommendation: keep "AI Provider" for the LLM tier;
never reuse bare "Model" as a top-level noun).

---

## 4. Existing Private/Custom Model Functionality (CURRENT)

The Personal AI Provider (Experimental Beta Phase 4) **already delivers most
of the "private" mode**:

- ✅ BYO API key, stored encrypted server-side, never returned
  (`GET /settings/ai/provider` returns `api_key_masked` + `configured` only).
- ✅ Custom endpoint: any http(s) OpenAI-compatible URL (user-hosted servers
  included — *for self-hosted deployments only*, see the SSRF note in §2.6).
- ✅ User-provided model: free-text, no registry, no code change for new
  models.
- ✅ Consumed uniformly by chat **and** the agent pipeline (same snapshot,
  AsyncLocalStorage-scoped).
- ✅ Test Connection with sanitized error mapping
  (`workspace-ai-provider.js` `sanitizeTestError`); status pill `OK`/`Failed`/
  `Untested` persisted on the row.
- ✅ Kill-switch independence: system toggle never disables personal
  providers.
- ✅ Both clients in parity: Web `SettingsPage.tsx:206-474` (AIProviderSection)
  and Android `AiProviderSettingsFragment.kt` share identical fields,
  validation strings and API contract; key never persisted client-side on
  either.
- ✅ A **list endpoint already exists as a future hook**:
  `GET /api/v1/settings/ai/providers` (`settings-ai-routes.cjs:62-76`,
  "so future multi-provider Consumers can switch off the same endpoint
  without a breaking change") — unused by both clients today.

What "private" **cannot** do today:

- ❌ Multiple providers per workspace (singleton row; PK `workspace_id`).
- ❌ Per-purpose models (chat vs parser vs agent — same provider for all).
- ❌ A user on cloud Animastor pointing at their own home GPU (`localhost`
  blocked by SSRF policy; deliberate).
- ❌ Any form of sharing, visibility, or multi-user consumption of a personal
  provider.
- ❌ Empty API key (column `NOT NULL`) — an unauthenticated local runtime
  (Ollama default) cannot be saved as-is.

---

## 5. Relationship between Model / Endpoint / Agent / Worker (CURRENT)

```
User ──> Workspace ──> AI Provider row (endpoint + api_key_enc + model)
                              │
              resolveAIProvider(workspace, purpose)
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   AI Assistant (chat)   Agent pipeline        refineDraft / others
   (ai_chat_sessions)    (agent_*)             (ai-service)
                              │
                     direct HTTPS chat/completions   ← NO queue, NO gpu-hub
                              ▼
                     External provider (OpenRouter / aggregator /
                     self-hosted OpenAI-compatible server)

   separately and in parallel:

   Generation orchestration ──> gpu-hub queues ──> Workers (ComfyUI)
   (audio | image | video jobs only; worker modes private/share/system)
```

The four concepts are **orthogonal today**:

| Concept | Nature | Owns a model? | Shareable? | Lifecycle owner |
|---|---|---|---|---|
| **Model** | free-text string in a provider row / env default | — | n/a | the user types it |
| **Endpoint** | a field (`endpoint`) inside the provider row | references one by string | ❌ | implicit |
| **Agent** | backend code: prompts (files) + pipeline steps + DB state | ❌ consumes whatever the resolver returns | ❌ (never — it is code, not a resource) | Animastor releases |
| **Worker** | registered GPU machine with credential + heartbeat | media models via ComfyUI workflows | ✅ (`mode` private/share/system) | the owning workspace / admin |

The example from the design brief maps as:

```
Qwen 32B            = the `model` string (metadata; multiple rows may name it)
User's RTX 5090     = hardware — invisible to Animastor (no registration exists)
Inference endpoint  = what the provider row's `endpoint` points at — the only
                      thing Animastor can address; today reachable only from
                      the server's network position (SSRF-guarded)
```

**Therefore: the shareable resource, if any, is the endpoint's serving
capacity — not the model file, not the agent.** Two machines running the
same Qwen 32B are two distinct resources; one machine serving two models is
one addressable endpoint with per-request model selection (already how the
OpenAI-compatible protocol works: `model` is a request field).

---

## 6. PROPOSED — The Three-Mode Model

The three modes are **ownership/governance models**, exactly as defined for
workers in `worker-sharing-model-design.md` §1. The same table applies, with
LLM-specific consequences:

| Mode | Owner | Governance | Available to | LLM-specific meaning |
|---|---|---|---|---|
| `private` | user's workspace | the owner's will | the owner only | Today's Personal AI Provider, unchanged |
| `share` | user's workspace (ownership never transfers) | the owner's will, expressed as a **contribution** | consumers routed by the platform | The owner's *inference capacity* serves other users' chat/agent requests, proxied by the backend |
| `system` | **Animastor / platform** — no user owner | **Animastor's policy** | community per platform rules | Today's System AI Provider + env fallback (kill switch, admin CRUD); future: multiple system providers (free tier, premium tier, rate-limited public tier) |

### 6.1 What already exists vs what is new

| Mode | Status |
|---|---|
| Private | **Exists** (Personal AI Provider, Phase 4). Needs no redesign; gains optional capabilities metadata in V2. |
| System | **Exists** (System AI Provider + kill switch + env fallback). Gains multi-provider admin UI in V2/V3. |
| Share | **Does not exist.** All LLM sharing is greenfield: a policy record, a pool-aware resolver stage, owner-priority routing, and health/visibility. |

### 6.2 Core architectural decision (the LLM analog of the worker decision)

> **Decision:** **A private AI provider's endpoint may have an active
> `share_policy` without changing its ownership or the owner's resolution
> path.**

```
personal AI provider (workspace-owned)
    │
    ├── owner's own traffic             (always; never taken away;
    │                                    resolved exactly as today)
    └── active share_policy             (voluntary, time-bounded)
          ├── public                    (V1)
          └── specific users            (V2)
```

The resolver chain gains exactly one stage, and the seam for it already
exists (`resolveAIProvider`, §2.2):

```
PROPOSED resolution chain (V1):
  1. workspace provider          (today's behavior, untouched)
  2. shared pool                 (NEW — endpoints with an active policy,
                                  health-checked, owner-priority)
  3. system provider             (today's system_ai_providers)
  4. env fallback                (legacy, unchanged)
  5. source:'unconfigured'       (fail-closed, unchanged)
```

Purpose-aware refinement (V2+): `purpose='chat'` may prefer tools-capable
endpoints; `purpose='agent'` (long imports) may prefer high-context or
system providers; the `purpose` tag already rides the resolver snapshot.

### 6.3 Invariants to preserve forever (same spirit as the worker doc)

1. **Ownership never transfers** — a share policy re-parents nothing;
   `workspace_ai_providers.workspace_id` (and its V2 successor
   `ai_endpoints.workspace_id`) is immutable.
2. **Consumers are not stakeholders** — a consumer never gains read or write
   authority over the endpoint, its credential, or its policy. The backend
   proxies; the consumer never even learns the endpoint URL (V1).
3. **The owner's path is sacred** — owner traffic resolves exactly as before
   the policy existed; sharing only adds a route for *others*.
4. **Fail-closed identity** — the consumer never names the resource it wants;
   eligibility is derived server-side from credential/session + policy row.
5. **Model stays free text** — no model registry, ever (explicit spec §15
   decision; registries rot).
6. **No LLM state on endpoints** — Animastor never relies on endpoint-side
   sessions, caches, or memory for correctness or isolation (§9).

---

## 7. PROPOSED — What Exactly Is Owned / Shared

Answering the brief's first design question precisely:

| Candidate | Verdict | Why |
|---|---|---|
| **Model (weights/file)** | ❌ never shared | Animastor never touches model files for LLMs; the string is metadata. Two endpoints can serve the same model; the model cannot be "given" to anyone. |
| **Model as configuration** | ⚠️ shared *implicitly* | Consumers learn at most `model` (provenance display, V3). They do not configure it. |
| **Inference endpoint** | ✅ **the shared resource** | The addressable `POST /chat/completions` service — the only thing the backend can call. Sharing it = admitting consumers' requests. |
| **Inference capacity** | ✅ shared *in effect* | What consumers actually consume is spare serving capacity (concurrent requests). V1 has no counters; capacity is enforced by owner-priority + coarse limits (§11), counters are V3. |
| **GPU resource** | ❌ not as such | The GPU is behind the endpoint; Animastor sees only the HTTP surface. (Contrast: ComfyUI workers expose a job protocol, so the *machine* is the resource there.) |
| **API credential** | ❌ never exposed | The owner's key is decrypted only inside the backend proxy call. Consumers never see it. Note the economic caveat in §7.1. |
| **Agent** | ❌ never shared | Agents are Animastor code + prompt files; they run in the backend on the *consumer's* resolved provider. There is no "agent instance" to hand over. |

### 7.1 The critical economics distinction: self-hosted vs paid endpoints

For workers, sharing donates *idle machine time*. For LLM endpoints there
are two radically different cases:

| Endpoint kind | What "sharing" donates | Risk |
|---|---|---|
| **Self-hosted runtime** (Ollama / vLLM / llama.cpp / LM Studio on the owner's GPU) | unmetered compute | Privacy of prompts flowing to the owner's machine (§9); load on the owner's hardware |
| **Paid API key** (OpenRouter, aggregator, hosted API) | **the owner's money/quota** — every consumer request bills the owner's key | Real financial exposure; abuse amplification |

**V1 rule:** sharing is *designed* for self-hosted runtimes. A provider row
whose endpoint is a known paid aggregator (`openrouter` type or the
platform's default hosts) may only be shared after an explicit, separate
confirmation (the analog of `confirm_share=true` in `worker-routes.cjs:158-173`),
with UI copy stating plainly that consumer requests will consume the owner's
paid quota. A `metered` hint recorded at policy creation drives this (§12).

### 7.2 Answers to the remaining structural questions

- **Can one model have multiple endpoints?** Yes — trivially and already
  semantically true (`model` is per-provider metadata; any number of
  workspaces can name `qwen/qwen3-32b`). Nothing in the design couples
  models to endpoints beyond a string.
- **Can one endpoint serve multiple Agents?** Yes — today even. Agents carry
  no model identity; the pipeline runs under whatever provider the
  resolver returns. A shared endpoint can serve the chat assistant of user
  A and the import pipeline of user B in the same minute, isolated per
  request (§9).
- **Can a user share only spare inference capacity?** Yes, in the same sense
  as the worker model: there is no reservation and no partitioning; the
  owner's requests always win, and consumers use whatever the endpoint can
  still take (§11). Hard per-endpoint concurrency caps arrive in V2.
- **Can the owner continue using the model while others use it?** Always.
  The owner's resolution path and traffic are untouched by the policy —
  this is invariant §6.3.3 and is the direct analog of the worker doc's
  "lane priority" rule.

---

## 8. PROPOSED — Access and Sharing Policies

Mirroring the worker design's V1 simplification (one active policy per
resource, scope widening later):

| Policy aspect | V1 | V2 | V3+ |
|---|---|---|---|
| Scope | `public` only (CHECK-enforced) | + `users` (allowlist/friends) | + groups/projects (if ever) |
| Lifetime | `expires_at` optional; `NULL` = "until stopped"; presets 1h / 4h / until stopped | same | same |
| Policies per endpoint | **one active** (partial UNIQUE index) | one active (unchanged) | revisit only with real need |
| Stop sharing | policy `revoked_at` set; owner path unaffected; in-flight requests finish | same | same |
| Feature gate | `SHARED_AI_ENABLED` flag, default **off** | on by default (if healthy) | — |

**Proposed V1 policy record** (sketch — do **not** deploy; deliberately
minimal, same philosophy as the worker doc §5):

```sql
CREATE TABLE ai_share_policies (
  policy_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- V1: addresses the workspace's provider row (1:1 by PK).
  -- V2: re-addresses ai_endpoints.endpoint_id once endpoints are first-class.
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('public')),
  metered      BOOLEAN NOT NULL DEFAULT FALSE,   -- paid-key endpoint hint (§7.1)
  starts_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
  expires_at   BIGINT,           -- NULL = "until manually stopped"
  revoked_at   BIGINT,
  note         TEXT,
  created_by   UUID REFERENCES users(user_id),
  created_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);
CREATE UNIQUE INDEX idx_ai_share_policies_one_active
  ON ai_share_policies(workspace_id) WHERE revoked_at IS NULL;
```

**Proposed API surface (V1)** — thin wrappers over the policy table, same
authorization pattern as the provider routes (`workspace_id` server-resolved,
never from the body; foreign ids 404 indistinctly; system tier unreachable):

```
POST   /api/v1/settings/ai/share          — start sharing own provider (V1)
DELETE /api/v1/settings/ai/share          — stop sharing
GET    /api/v1/settings/ai/share          — own policy state (owner view)
GET    /api/v1/ai/pool/status             — community pool visibility (V1.5; analog of /worker/counts)
```

Policy state reaches the request path through the existing 30s resolver
cache discipline: PG is authoritative, the cache is invalidated on writes,
and expiry is re-checked on read — a stale cache can never extend a policy
(the direct analog of the worker doc's D4 mirror rule, using the mechanism
that already exists instead of the hub auth mirror).

---

## 9. PROPOSED — Privacy and Context Isolation

**The hard guarantee first:** a shared LLM must never expose one user's
conversation/context to another user. The current architecture already
satisfies the *isolation* half structurally; the design adds the
*cross-user* guarantees:

### 9.1 Why isolation is structural (CURRENT facts)

- Every conversation lives **server-side in PostgreSQL**, keyed by
  `book_id`/workspace (`ai_chat_sessions`, `chat_sessions`/`chat_messages`).
  Nothing conversational is stored on, or fetched from, the endpoint.
- Every LLM call is **stateless**: the backend assembles the full prompt
  (system prompt + the consumer's own history slice) per request. No
  endpoint-side session id is ever sent; no `store`/persistence flags are
  used. Qwen "thinking" is stripped in responses (`ai-routes.cjs:386`);
  nothing upstream is trusted as memory.
- `aiBookGuard` scopes every `/api/v1/ai/*` request to one authorized book;
  tool results (`edit_book` patches) are validated server-side
  (`applyPatchesValidated`) — a malicious or buggy shared endpoint cannot
  silently patch another user's book or inject arbitrary state.
- Requests only ever contain **the consumer's own** context. There is no
  code path where user B's history could be appended to a request routed
  anywhere.

### 9.2 The real privacy direction: consumer → endpoint owner

The genuine risk of sharing runs **the opposite way** from what one might
assume: the endpoint **is the owner's machine/key**, so the owner (or their
runtime logs) can observe consumer prompts. This cannot be cryptographically
prevented while proxying in plaintext to an OpenAI-compatible endpoint; it
must be handled by policy:

1. **Consent on both sides.** Sharing is voluntary for the owner; consuming
   the pool is voluntary for the user (a personal provider always wins
   first — the pool is only a fallback; users can disable pool fallback in
   settings, V2).
2. **Transparency (V3):** a consumer-facing indicator of which tier served a
   response (`Private` / `Shared` / `System`), and for shared, the model
   name only — never the owner identity or URL.
3. **Never mix tiers mid-conversation:** the resolver snapshot is captured
   once per request; a conversation is not silently re-pointed between
   endpoints except after explicit errors, and a tier change is surfaced in
   the chat UI (V3).
4. **Sensitive-content rule:** tool results embedded in prompts contain only
   the consumer's own book data (already enforced); no platform secrets,
   credentials, or other users' data ever enter prompt construction — there
   is no code path that could.

### 9.3 Preventing the shared endpoint from reaching the owner's data

The brief asks how to stop a shared model from touching the *owner's*
filesystem/secrets/private data. In Animastor's architecture this is
already impossible by construction, and the design must keep it so:

- The endpoint receives exactly one artifact: the chat-completions HTTP
  body built in `ai-service`/`ai-routes`. It has **no Animastor execution
  role** — no filesystem, no DB, no Redis, no worker access.
- The agent pipeline executes in the **backend**, not on the endpoint; the
  endpoint only completes text. ComfyUI workers are a separate protocol
  (`/task`) and never receive LLM tasks.
- Tool schemas are fixed Animastor code (`chat-engine.cjs:192-301`); the
  endpoint cannot define or invoke anything beyond text completion (and the
  Qwen content-block tool syntax is parsed and validated server-side).
- The owner's provider credential never travels to a shared consumer
  request in any readable form; the proxy injects it per request.

The residual exposure is what §9.2 covers (the owner observes prompts) plus
prompt-injection from model output — mitigated today by server-side patch
validation, and by the standing rule that model output is data, never code.

---

## 10. PROPOSED — Authentication and Security

| Concern | V1 approach | Later |
|---|---|---|
| Consumer auth | Existing session/guest cookies; pool fallback is just another resolver stage — **no new tokens, no new auth type** | unchanged |
| Owner authorization | Policy routes workspace-scoped (`workspace_id` from `req.workspace`), identical to `settings-ai-routes.cjs` and the worker policy routes | unchanged |
| Owner credential | Never leaves the server; proxy injects `Authorization: Bearer` per request from the AES-256-GCM envelope; consumers get responses only | unchanged |
| Key-less local runtimes | V2: relax `api_key_enc NOT NULL` on new endpoint records (empty credential = anonymous local runtime); the proxy then sends no auth header | V2 |
| Third-party endpoint spoofing | **Ownership probe**: registering a share policy triggers a signed challenge (`X-Animastor-Share-Challenge`) the endpoint must echo/prove, preventing users from registering endpoints they don't control (e.g., pointing at Animastor's own system provider or someone else's API) | V1 (required, see §18 D7) |
| SSRF | `assertPublicEndpoint` **stays** for V1 sharing: only publicly reachable endpoints may be shared from the cloud deployment. Self-hosted Animastor operators can exempt their LAN (the existing env-based exemption). Outbound-tunnel runtimes (no inbound exposure needed) are the V3 answer for home GPUs | V3 |
| Kill switch | `system_ai` toggle keeps governing only the system tier (documented in `system-ai.js:6-9`); `SHARED_AI_ENABLED` is a separate, independent flag | unchanged |
| Abuse / rate limiting | Per-workspace pool request budget in the resolver (coarse, in-process) — same spirit as the existing `express-rate-limit` and GPU quotas `QUOTAS = {MAX_ACTIVE_AUDIO:8,...}` (`runtime-config.js:129-133`) | V2 counters, V3 quotas |
| Audit | Policy events logged via the existing backend log/journal pattern (worker doc §5.2 precedent — no dedicated audit table in V1) | V3 |

---

## 11. PROPOSED — Concurrency and Inference Routing

### 11.1 Why not gpu-hub queues (summary; full analysis in §13)

Chat is synchronous/streaming; queues fit batch jobs. The agent pipeline
already has its own async semantics (retry with backoff, session state in
PG, `analysis_parallelism 1..8` for parallel analysis). V1 routes LLM
requests directly, as today — the only change is *which endpoint* the
resolver returns.

### 11.2 Routing stages (V1)

```
request (chat / agent step / prompt)
  → resolveAIProvider(workspace, purpose)
      1. own provider                     → proxy (today's path, untouched)
      2. shared pool: pick active-policy endpoint
           filter: health ok (§12), not metered-blocked, not expired
           prefer: least-recently-failed (V1 coarse); capability match (V2)
      3. system provider                  → proxy
      4. env fallback                     → proxy
      5. else fail closed ('unconfigured')
  → safeFetch to chosen endpoint (SSRF + per-hop validation, unchanged)
```

### 11.3 Concurrency semantics

| Question | V1 answer |
|---|---|
| Owner's request while consumers are queued? | **Owner wins, always.** Owner traffic doesn't even traverse the pool stage. |
| Concurrent consumer requests to one endpoint? | Bounded by an in-process per-endpoint semaphore (default small, e.g. 1–2, overridable by the owner's policy `max_concurrent` in V2); overflow waits briefly, then the resolver marks the endpoint busy and tries the next stage. |
| Consumer request already in flight when owner stops sharing? | **Finishes normally.** The proxy call was opened under a then-valid policy; conversations are unaffected (state is in PG). |
| New requests after stop? | Routed to the next stage (or fail closed) within one resolver-cache TTL (≤30s). Direct analog of the worker doc §6. |
| Endpoint dies mid-stream? | Existing per-call timeout (`AI_FETCH_TIMEOUT_MS` 60s) + retry semantics (`ai-caller` 3× backoff for the agent path; chat surfaces a sanitized error). Health cache (§12) then depools the endpoint. |
| Fairness among many consumers? | V1: none needed at expected scale (flag-off default, small pool); coarse per-workspace budget (§10). V3: proper per-consumer quotas from the usage ledger. |

No preemption ever: a shared endpoint never cancels the owner's (or anyone's)
in-flight completion to make room — the same "no preemption" rule as the
worker doc §6.

---

## 12. PROPOSED — Model Capabilities / Metadata

Today capabilities are *implicit*: `enable_thinking:true` is sent regardless,
tools are sent regardless, vision only via `/ai/prompt`, context length is
discovered by failure. For sharing to route sanely (and for the system tier
to advertise a "premium" model), endpoints need **advertised capabilities**:

| Capability | Source | Used by |
|---|---|---|
| `model` (string) | endpoint config / probe response | provenance display, routing |
| `context_length` | declared by owner; optionally verified by probe (V3) | agent/import routing (long imports need big context), UI hints |
| `tools` (function calling) | declared + probe (send a trivial tool call in Test Connection v2) | chat routing (chat without tools is degraded) |
| `vision` (image input) | declared + probe | `/ai/prompt` image flow |
| `structured output / JSON mode` | declared | parser steps (tolerant today; valuable for stricter models) |
| `thinking` (`enable_thinking` Qwen-style) | declared | avoids sending unsupported flags (§2.4 workarounds) |
| `metered` (paid-key) | owner declaration + endpoint-type heuristic (§7.1) | sharing consent UX, pool policy |
| `max_concurrent` | owner declaration | consumer-side semaphore (§11.3) |
| `empty_key_ok` | derived (no credential on record) | key-less local runtimes (V2) |

**Storage shape (V2, when endpoints become first-class):** a `capabilities
JSONB` column on the endpoint record — exactly the pattern `workers.capabilities
JSONB` already uses for GPU workers (declared at registration, refined by
heartbeat), so the codebase has an established precedent. **V1 keeps
capabilities implicit** and routes the pool opportunistically (any healthy
active-policy endpoint), accepting degraded behavior on mismatched
capabilities rather than pre-building a matching engine.

Health/availability (brief question 12) reuses the existing pattern:
`checkAIHealth`-style probes (1-token completion, short TTL cache, keyed per
endpoint so one endpoint's state cannot shadow another's — the per-provider
health cache in `ai-service.js:466-476` is the template). Registered
runtimes (V3) would additionally heartbeat, exactly like GPU workers, and
the pool-status endpoint would report `available · active` counts in the
established format (`"{0} available · {1} active"`, and `vbook`/`active_vbook`
already demonstrates the AI-analog fields in `/worker/counts`).

---

## 13. PROPOSED — Worker Integration Analysis

The brief's key question: should a user's LLM endpoint ride the existing
Worker infrastructure?

```
Option A (proposed for V1):            Option B (considered):
User GPU                               User GPU
  ↓ Ollama / vLLM                        ↓ Animastor LLM Connector (wrk.*-style)
  ↓ public OpenAI-compatible URL         ↓ outbound registration → hub
  ↓                                      ↓
Backend resolver → direct proxy        Backend → hub queue → connector
```

**Decision: LLM inference stays OUT of gpu-hub in V1 (and likely
permanently for chat).** Reasons, each anchored in current code:

1. **Protocol mismatch.** gpu-hub is a job queue: backend `POST /task` →
   Redis list → worker `GET /task/next` → `POST /task/result`
   (`gpu-hub.js:597/705/838`), with `GPU_TIMEOUT_MS` (default 10 min) and
   orphan requeue. Chat is a synchronous or SSE request–response with
   60s timeouts and incremental tokens (`/ai/chat/stream`). Queuing a
   streaming chat adds latency, breaks SSE, and turns every prompt into a
   lease/timeout/requeue problem it doesn't have.
2. **Job-type enum is media-only, deliberately.** `worker_type CHECK
   ('audio','image','video')` and `SYSTEM_JOB_TYPES = ['audio','image','video']`
   (`gpu-hub.js:53`) encode the ComfyUI contract end-to-end (workflows,
   artifacts, installer profiles). An LLM job type would fork the hub's
   contract for no routing benefit.
3. **The LLM dispatch seam already exists and was built for this.**
   `resolveAIProvider(workspaceId, purpose)` with its documented extension
   point ("per-purpose routing, fallback chains... added HERE") is exactly
   a resource-selection layer — the LLM analog of `gpu-dispatcher.sendUnified`.
   The shared pool is one more resolver stage, not a new dispatcher.
4. **Batch LLM workloads (agent imports) don't need the hub either.** The
   agent pipeline is already async, resumable (`agent_sessions.status`),
   retry-budgeted, and parallelism-limited (`analysis_parallelism`); a queue
   would duplicate what it already does.

**What IS worth borrowing from the worker stack (and when):**

| Worker mechanism | LLM analog | Version |
|---|---|---|
| One-time credential, hash-only storage, rotation, revoke (`wrk.*`, `worker-repo.js`) | **LLM Connector** credential for outbound-registered runtimes (home GPU behind NAT) | V3 |
| Beacon/heartbeat + 30s TTL + fail-closed classification (`worker-health.js`) | Runtime heartbeat for connector-run endpoints; pool counts | V3 |
| `share_policies` + owner-priority lane + kill-switch flag (`worker-sharing-model-design.md`) | `ai_share_policies` + owner-priority resolver stage + `SHARED_AI_ENABLED` | V1 (the design mirrors it throughout) |
| `capabilities JSONB` advertisement | Endpoint capabilities metadata (§12) | V2 |
| Setup Center wizard + installer profiles | "Set up a local AI runtime" guide (Ollama/vLLM presets, tunnel setup) | V3 |

Net: **separate registration/dispatch for LLM resources (V1–V2), converging
on worker *patterns* (not worker *infrastructure*) for outbound runtimes in
V3.** The gpu-hub process itself is never extended for LLMs.

---

## 14. Web/Android Implications

### 14.1 Current parity baseline (CURRENT)

- The AI Provider screens are **1:1 in parity** (Phase 4 was built that way):
  same fields, same validation strings, same one-time-key invariant
  (`SettingsPage.tsx:206-474` ↔ `AiProviderSettingsFragment.kt`).
- Settings nav order is parity-managed (AI Provider → Private Workers →
  VBook → Generation Settings; `ANDROID_WEB_PARITY.md` §D).
- **Web-only:** the Admin page with "System AI Control" (`AdminPage.tsx`) —
  Android has zero admin surface (deliberate; admin is a web persona).
- **Neither client** exposes worker `mode` anywhere; `WorkerMode` in web TS
  is `'private' | 'share'` without `'system'` (`privateWorkers.ts:14`).
- Neither client has model selection beyond the free-text provider field;
  chat has no model picker, no streaming (blocking POST), and no pool
  awareness.

### 14.2 Changes the three-mode model would require (PROPOSED)

| Version | Web | Android |
|---|---|---|
| V1 | "Shared AI" section under Settings → AI Provider: owner-side Start/Stop sharing + expiry presets + metered warning; pool status line in the existing "Workers"-card format (`"{0} available · {1} active"` precedent); i18n EN/RU | same, mirrored in `AiProviderSettingsFragment`/new section; strings EN/RU; update `ANDROID_WEB_PARITY.md` |
| V2 | capability display on the provider card; "use community pool" opt-out toggle; system-tier multi-provider admin UI (web-only, as today) | parity for user-facing parts; admin stays web-only |
| V3 | consumer transparency indicator (which tier served this reply) in `AiAssistantPage` + `AiAssistantFragment`; local-runtime setup guide linking the LLM Connector | parity |

Terminology rules for UI (both clients):

- Keep **"AI Provider"** as the settings entry (it is the established,
  parity-locked label for the private tier).
- Use **"Shared AI"** for the share tier (consistent with the worker doc's
  "Shared" badge direction) — avoid inventing a fourth noun.
- Reserve **"System AI"** wording for the admin context only (as today).
- Never show bare "Model" as a standalone settings noun (collides with
  Prompt Profiles); always inside the provider/AI context.

---

## 15. PROPOSED — V1 / V2 / V3 Roadmap

### V0 — exists today (no work)

- Private tier (Personal AI Provider), System tier (admin + kill switch +
  env fallback), `resolveAIProvider(purpose)` seam, fail-closed unconfigured
  state, SSRF policy, encrypted credentials, web/Android parity for the
  provider screens.

### V1 — public spare-capacity sharing (flag-gated, dormant by default)

1. `ai_share_policies` table + migrations (additive only; §8 sketch).
2. Policy CRUD routes (`/settings/ai/share`), workspace-scoped, metered
   confirmation for paid endpoints.
3. Resolver stage 2: shared-pool fallback with owner-priority, health cache,
   expiry re-check, per-endpoint semaphore.
4. Ownership probe for registering a share policy (§10).
5. `SHARED_AI_ENABLED` flag, default off; kill switch untouched.
6. Minimal UI both clients (badge + start/stop + presets); no consumer-facing
   pool UI beyond a status count.
7. Tests: policy authz matrix (owner yes / foreign 404 / system unreachable),
   resolver stage order, owner-priority, expiry staleness ≤ TTL, stop-sharing
   mid-flight, metered confirmation, flag-off = today's behavior exactly.

### V2 — targeted sharing + first-class endpoints

- `ai_endpoints` table (registered endpoint resource: ownership, capabilities
  JSONB, health state, optional empty key); provider row becomes a consumer
  binding referencing it; the dormant `GET /settings/ai/providers` list
  endpoint becomes live multi-provider.
- Scope `users` (allowlist) on policies; per-endpoint `max_concurrent`.
- Capability-aware routing (chat↔tools, agent↔context length); capability
  probe in Test Connection v2.
- Pool opt-out toggle for consumers; multi-provider selection UI.

### V3 — local runtimes, transparency, metering

- **LLM Connector** (worker-pattern credential + outbound heartbeat) so a
  home GPU behind NAT can host an endpoint without inbound exposure.
- Consumer transparency (tier indicator per reply), endpoint ownership probe
  hardening, pool dashboards.
- **Usage ledger** (`endpoint, policy, consumer, purpose, tokens, duration`)
  — the prerequisite for quotas and anything economic; no metering in the
  request hot path beyond event emission (worker doc §9 rule).

### V4 — economics

- Credits/quotas settled against the ledger; premium system tiers;
  possible marketplace. Everything attaches at the ledger layer; the
  dispatch/resolver path stays economics-free (worker doc §9 rule,
  adopted wholesale).

---

## 16. Monetization Compatibility

The vision's gap analysis (`NEAR_HORIZONS_GAP_ANALYSIS.md` §14) names the
business tiers: **Free / BYOG (bring your own GPU), Community, Managed**.
The three-mode LLM model maps onto them without structural strain:

| Business tier | LLM realization | Architectural fit |
|---|---|---|
| Free | System tier free model (rate-limited public system provider) | `system_ai_providers` gains rows + policy fields (V2 admin UI); kill switch already governs the tier |
| BYOG | Private tier (own key / own runtime) | exists today; V2 endpoints + V3 connector complete the story |
| Community | Share tier (altruistic pool) | V1 design; no payment logic by construction |
| Managed / paid inference | System premium tier or metered sharing | V4 ledger + credits; the resolver's `purpose`/`source` tags and the ledger join keys (`policy_id`, `endpoint_id`, consumer workspace) are the metering seams |

Hard rule (inherited from the worker doc, normative here too): **no payment,
metering, or pricing logic in the resolver/proxy hot path, ever.** V1's
`metered` flag is consent UX metadata, not billing.

---

## 17. Migration Considerations

- **V1 is one additive table + routes + one resolver stage**, mirroring the
  worker doc's "one new table" discipline. No changes to
  `workspace_ai_providers`, `system_ai_providers`, `workers`, or any client
  contract.
- **Flag-default-off** means the migration ships fully dormant: code and
  schema land, behavior changes only when `SHARED_AI_ENABLED=1`. Rollback is
  a flag flip (policy rows persist harmlessly).
- **No client contract changes in V1** beyond new, optional endpoints; both
  clients degrade gracefully (unknown routes unused).
- **V2's provider→endpoint split is the one genuinely invasive migration**
  (provider rows gain a logical endpoint reference; the singleton PK
  invariant is retained at the binding level). It must preserve: encrypted
  credential envelope, the `workspace_id`-from-session rule, resolver cache
  invalidation semantics, and the PAP spec's fail-closed contract.
- **V3's connector introduces a second credential family** (`llmc.*` or
  reuse of the `wrk.*` envelope) — must be designed against the existing
  one-time-disclosure + hash-only + rotation lifecycle, not a new scheme.
- Fresh and long-lived databases must migrate identically (the schema.js
  single-file migration pattern, as all prior migrations did).

---

## 18. Open Architectural Questions

| # | Question | Working recommendation |
|---|---|---|
| Q1 | Does the shared pool serve guests (auto-provisioned workspaces) or only registered users? | Registered users only in V1 (guest workspaces are ephemeral; pool abuse surface) |
| Q2 | Should pool fallback apply to agent imports (heavy, bursty) or chat only? | Chat + parser in V1; agent imports opt-in per policy field (they multiply cost 5–10× per book) |
| Q3 | Ownership probe mechanism: challenge header vs callback registration vs DNS/HTTP proof? | Signed challenge echo in Test Connection v2 flow (cheapest, no endpoint code for Ollama-style servers is impossible — fallback: URL re-entry + probe; see D7) |
| Q4 | Is one endpoint allowed to serve both the owner privately AND the pool with different models? | Yes via per-request `model`; pool policy may pin a cheaper model (owner choice, V2 field) |
| Q5 | Should consumers be able to *prefer* a specific shared endpoint (friend's machine) before V2's `users` scope? | No — endpoint addressing by consumers breaks the "consumers are not stakeholders" invariant; wait for V2 scope |
| Q6 | Interplay of `system_ai` kill switch with the pool when a workspace has no provider? | Independent flags; kill switch never gates personal/share tiers (preserves the documented Phase 4 semantic) |
| Q7 | Streaming over the pool: passthrough SSE or buffer-then-forward? | Passthrough (existing `data:` delta parser already forwards typed events; buffering would double latency) |
| Q8 | Data-retention duty of the *owner* runtime logs? | Out of platform control (§9.2) — covered by consent + transparency, stated in the share-flow copy |
| Q9 | Does `books.visibility` (dormant, `schema.js:142`) get consumed by this model? | No — book visibility and AI resource sharing are orthogonal; leave dormant |
| Q10 | Multi-model endpoints (one URL serving many models) — one resource or N? | One resource with `model` as a request parameter; capability list may enumerate served models (V2+) |

### Decisions to finalize before any coding

| # | Decision | Recommendation |
|---|---|---|
| D1 | One active policy per provider/workspace (UNIQUE index) | **Yes** — mirrors worker D1; removes resolver ambiguity |
| D2 | V1 scope = `public` only, CHECK-enforced | **Yes** — V2 widens the CHECK |
| D3 | Owner traffic never traverses pool stage (priority by construction, not by queue) | **Yes** |
| D4 | Policy state reaches the resolver via the existing 30s cache + invalidation (PG authoritative) | **Yes** — no new mirror needed; re-check expiry on read |
| D5 | `expires_at = NULL` allowed ("until stopped") | **Yes**; UI presets 1h / 4h / until stopped |
| D6 | Stop-sharing semantics: in-flight finishes; new requests reroute within ≤30s | **Yes** |
| D7 | Ownership probe required before a policy can activate | **Yes for public cloud** (prevent third-party endpoint registration); simplest workable form: verification completion must pass with a challenge marker; accept residual gaps documented in the security review |
| D8 | Metered (paid-key) sharing allowed but separately confirmed | **Yes** — financial exposure must never be a silent side effect |
| D9 | LLM stays out of gpu-hub (separate dispatch via resolver) | **Yes** for chat permanently, for batch agent workloads revisit only if V3 ledger shows queueing need |
| D10 | Pool requests carry no client-identifying metadata beyond the standard proxy headers | **Yes** — consumer workspace/user identity never sent to shared endpoints |

---

## 19. Recommended Next Steps

1. **Socialize the core decision set (D1–D10)**, especially D3 (owner
   priority by construction), D7 (ownership probe), D8 (metered consent),
   and D9 (no gpu-hub for LLMs).
2. **Security review of the share-proxy surface** — extend
   `EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER_SECURITY_REVIEW.md` with: proxy
   abuse (Animastor as open SSRF relay via shared endpoints), ownership
   probe design, consumer-request anonymity (D10), prompt-logging exposure
   copy.
3. **Spec the V1 slice** in the house style (like
   `EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER.md`): table, routes, resolver
   stage, flag, tests — one new table, dormant by default.
4. **Prototype the resolver stage behind the flag** in a branch to measure
   real pool behavior (latency overhead, cache staleness, semaphore
   contention) before any UI work.
5. **Draft the V2 `ai_endpoints` RFC** (provider/endpoint split) as its own
   document — it is the only invasive migration and deserves its own review
   cycle.
6. **Update `ANDROID_WEB_PARITY.md`** when V1 UI lands on either client.
7. Keep this document's CURRENT/PROPOSED separation intact as code lands;
   move facts from PROPOSED into CURRENT sections per shipped version.

---

## Appendix — Glossary

- **AI Provider** — Animastor's established term for the consumer-side LLM
  binding (provider_type + endpoint + encrypted key + free-text model).
  Private tier today; never renamed.
- **AI Endpoint (proposed, V2)** — the first-class registered inference
  resource (ownership, capabilities, health). In V1 it exists implicitly as
  the provider row's endpoint field.
- **Share policy** — a record granting consumption of a private endpoint's
  spare capacity (scope + lifetime), the direct analog of the worker doc's
  `share_policies`. Access policy, never ownership.
- **System tier** — `system_ai_providers` + env fallback + "System AI
  Control" kill switch; admin-governed platform resources.
- **Pool** — the set of endpoints with an active public share policy and
  passing health; consulted by the resolver only after the owner's own
  provider.
- **Owner / Consumer** — the workspace owning the provider/endpoint / any
  user whose chat or agent request is served through the pool. Consumers
  hold zero authority over the resource or its policy.
- **Agent** — the backend book-import/analysis pipeline (prompt files +
  step code + session tables). Consumes the resolved provider; never a
  shareable resource.
- **LLM Connector (proposed, V3)** — an outbound-registered local runtime
  (worker-pattern credential + heartbeat) for home GPUs behind NAT.
- **Metered endpoint** — an endpoint backed by a paid API key; sharing it
  donates the owner's money and requires explicit confirmation (D8).
