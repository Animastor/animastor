# Local AI Connector — Technical Audit and V1 Specification

> 2026-09-02 · Research / architecture only — **no production code, no schema
> migrations, no API, no Web/Android changes**. Companion to
> `llm-agent-resource-sharing-model.md` (the LLM sharing design; its §13
> and §15/V3 already reserve an "LLM Connector" with an `llmc.*` credential
> family) and to `EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER.md` (the private
> tier this builds on).
>
> V1 scope, fixed: **PRIVATE LOCAL AI ONLY.** The user connects their own
> local LLM runtime (Ollama / vLLM / llama.cpp / LM Studio) to cloud
> Animastor over an **outbound** connection initiated by the local side. No
> inbound ports, no port forwarding, no public IP on the user's machine.
> No sharing, no credits, no billing, no community pool — but the design
> must not block them later (§14–§15).
>
> Hard constraint inherited from the sharing doc (D9, §13): **LLM inference
> never goes through gpu-hub.** The connector rides the backend's resolver
> seam, not the worker queue.

---

## 1. Executive Summary

The architecture is favorable: the repository already contains every
pattern Local AI Connector (LAC) needs — an outbound worker (gpu-hub
polling), a fail-closed credential lifecycle (`wrk.*`, hash-only,
rotate/revoke), heartbeat, the `resolveAIProvider` seam, and SSE plumbing.
The task reduces to: **one new table `ai_connectors`, one WebSocket channel
in the backend, a transport branch in `callAI`/`resolveChatAI`, and a
`local-ai` provider type.** Nothing in the worker/gpu-hub/share stack needs
to change.

Two audit facts that shape the plan:

1. **Chat does not stream today at all** — the only route is
   `POST /api/v1/ai/chat` (blocking; `ai-routes.cjs:324`). Streaming is
   therefore Phase 5 greenfield work, not "forward the existing SSE".
2. **The name "connector" is taken**: `connector-routes.cjs` serves ComfyUI
   workflow connectors (Prompt Profiles). In code/DB use the
   `ai-connector` / `aic.*` vocabulary; in UI use "Local AI" — the
   terminology hazard is documented in the sharing doc §3.

---

## 2. What the Current Code Contains (CURRENT)

### 2.1 Resolver — the integration seam

`resolveAIProvider(workspaceId, purpose)` —
`backend/src/services/workspace-ai-provider.js:462`, a thin wrapper over
`resolveAIForWorkspace` (`:386`). Snapshot shape:
`{source, provider, endpoint, apiKey, model, workspaceId, purpose}`. The
comment at `:445-448` explicitly reserves the insertion point for
per-purpose routing. Chain today: workspace row → system provider
(kill-switch gated) → fail-closed. Singleton per workspace
(PK = `workspace_id`, schema.js:74-86).

### 2.2 LLM transport call sites (complete list)

| Site | Location | Notes |
|---|---|---|
| `callAI` | `backend/src/services/ai-service.js:20-117` | core; 3× retry; `stream:false` always; `safeFetch` + SSRF `validatePublic` (`:69`); **fails when `apiKey` is empty** (`:24-33`) — must be bypassed for key-less local runtimes |
| `resolveChatAI` | `backend/src/routes/ai-routes.cjs:31-44` | chat transport; separate fetch inside the route |
| agent caller | `backend/src/services/agent/ai-caller.js:30-59` | goes through `ai-service.callAI`; covered automatically by any change there |
| `testConnection` | `workspace-ai-provider.js:512-549` | Settings "Test connection" |

### 2.3 Worker infrastructure (what gets reused)

- **Credential**: `backend/src/storage/postgres/repositories/worker-repo.js:57-83`
  — `wrk.<id_b64url>.<secret_b64url>`, SHA-256 hash-only storage, one-time
  disclosure, timing-safe compare (`:156`), rotate/revoke routes
  (`worker-routes.cjs:306`, `:340`).
- **Auth**: `worker-auth.js` + `middleware/worker-auth-middleware.js` —
  fail-closed Bearer; identity derived exclusively from the credential;
  rebuildable Redis mirror (`animastor:worker-auth`).
- **Heartbeat**: the worker POSTs `/beacon` every 10 s
  (`worker/worker/worker.cjs:59`); the hub writes
  `animastor:worker:heartbeat:*` to Redis; workers live on `/task/next`
  polling (500 ms → 8 s backoff). **A proven outbound model in this very
  production** — the strongest argument that an outbound connector fits the
  deployment reality.
- **UI registration**: `POST /api/v1/workers` returns a one-time token
  (`worker-routes.cjs:196`); Setup Center wizard (`worker-setup-routes.cjs`);
  installer (`gpu-hub.js:1586+`).

### 2.4 gpu-hub

A job queue for ComfyUI only: `worker_type CHECK ('audio','image','video')`,
`SYSTEM_JOB_TYPES`, `PROTOCOL_VERSION=2`. The sharing design (§13, D9)
already decided LLMs stay out — the connector respects that. Streaming +
60 s timeout semantics do not fit a 10-minute-lease queue.

### 2.5 SSRF posture

`url-safety.js:191-234` `assertPublicEndpoint` blocks loopback/private
targets at save time **and per fetch hop** — today a cloud user *cannot*
point a provider at their own `localhost` (sharing doc §4). LAC is the
legitimate bypass: the cloud never fetches the localhost; the connector
does it locally. `url-safety` stays untouched.

### 2.6 WebSocket readiness

There is no `ws` dependency today (backend and gpu-hub `package.json`:
express/ioredis only) and no nginx upgrade config
(`proxy/conf/default.conf` sets `Connection ""`). SSE exists and is
reusable for Phase 5: client parser `frontends/app/src/api/client.ts:147`,
Redis pub/sub `backend/src/services/progress-pubsub.cjs`.

### 2.7 Frontend

`frontends/app/src/pages/SettingsPage.tsx:230` (AIProviderSection);
sections are extensible (`:30-33`). Android:
`AiProviderSettingsFragment.kt` (364 lines, parity-locked). A
multi-provider hook already exists, dormant:
`GET /settings/ai/providers` (`settings-ai-routes.cjs:66`).

### 2.8 Storage

`schema.js` single-file migrations; the workers migration (PW-1,
`schema.js:1316`) is the template. Worker `share_policies` exist
(`schema.js:304`) — worker-sharing scope, untouched by LAC.

---

## 3. Recommended Architecture (PROPOSED)

```
User request (chat / agent step / import)
  → resolveAIProvider(ws, purpose)            [workspace-ai-provider.js:462]
      workspace_ai_providers row, provider_type='local-ai'
      → snapshot { source:'workspace', transport:'connector',
                  connectorId, model }        (apiKey=null, endpoint=null)
  → transport branch:
      ai-service.callAI / resolveChatAI see transport='connector'
      → ai-connector-registry.getLiveConnection(connectorId)
      → WS channel → local Connector
      → runtime adapter → http://127.0.0.1:11434/v1/chat/completions
```

Key decisions:

1. **The backend is the sole WS terminator.** Not gpu-hub (queue semantics
   are wrong for chat; D9 forbids), not a new service (extra surface in
   docker-compose). A new route `GET /api/v1/ai-connector/ws` on the
   backend server; nginx gains `location /api/v1/ai-connector/` with
   upgrade headers.
2. **Connector identity = `aic.<connector_id>.<secret>` credential** — an
   exact copy of the `wrk.*` contract: hash-only in PG, one-time
   disclosure, rotate/revoke. Workspace binding as workers have it: FK +
   identity only from the credential.
3. **Two-phase credential:** a one-time **registration token** (created in
   the UI, TTL ≤ 15 min, single-use, hash-only) which the connector
   exchanges on first connect for the persistent `aic.*` credential.
   Differs from workers (where the token is issued together with the row)
   because an LAC token is pasted into a terminal — the exposure window is
   wider.
4. **The runtime adapter is an allowlist, not a proxy.** The cloud sends
   only `{model, messages, params, stream}`. **The runtime base URL never
   comes from the cloud** — it lives in the connector's local config
   (`--base-url`, default `http://127.0.0.1:11434`). The adapter knows
   exactly two paths: `POST {base}/v1/chat/completions` and
   `GET {base}/v1/models`. This is the structural defense against
   becoming a universal proxy (§10).
5. **Provider binding:** V1 extends
   `workspace_ai_providers.provider_type` with `local-ai`; model choice is
   the row's free-text `model` field (the no-registry principle, sharing
   doc invariant §6.3.5, is preserved). Connector and provider remain
   separate entities — a connector can exist offline while the user has
   not selected it as their provider.

---

## 4. Cloud ↔ Connector Protocol (PROPOSED)

**Transport: WebSocket** — the single primary choice.

- *SSE down + HTTP POST up*: works behind nginx without new config, but
  two connections with desynchronized lifecycle, uplink responses need
  request-id routing over HTTP anyway, and cancellation becomes a separate
  POST. For streamed tokens this adds ~1 RTT per chunk batch and notable
  code overhead.
- *Long polling (the worker pattern)*: proven in this production, but
  500 ms+ latency per request is unacceptable for chat; streaming is
  impossible.
- *WS*: one connection, bidirectional, multiplexing by `request_id`,
  native ping/pong for liveness, cancellation as a downstream message.
  Cost: the `ws` dependency (~zero-dep) + ~6 lines of nginx upgrade —
  acceptable.

**Minimal protocol (JSON frames, version 1):**

```
C→S  hello        { protocol_version, reg_token | credential }
S→C  ready        { connector_id, heartbeat_interval_ms, server_time }
C→S  heartbeat    { models[], capabilities{tools,vision,context},
                    latency_ms, runtime{type, version} }     — every 10-15 s
S→C  models.refresh {}                                        — on demand (UI)
C→S  models.list  { models[] }

S→C  chat.request { request_id, model, messages, params{max_tokens,
                    temperature, stream}, timeout_ms }
C→S  chat.delta   { request_id, delta }                      — only if stream
C→S  chat.response{ request_id, content, finish_reason, usage }
C→S  chat.error   { request_id, code, sanitized_message }
S→C  chat.cancel  { request_id }
S→C  pong / C→S ping (app-level, duplicating WS control frames)
```

Rules:

- The server rejects `protocol_version != 1` (a 409 analog, as `/beacon`
  does at `gpu-hub.js:678-684`).
- `request_id` is generated by the cloud.
- The connector holds at most N concurrent local requests (default 2);
  overflow answers `chat.error{code:'busy'}` immediately.
- Timeouts: both sides apply the same limit; the cloud timer is
  authoritative — on expiry the request is cancelled with `chat.cancel`
  regardless of connector state.
- Error surface: sanitized codes only (`timeout`, `runtime_unreachable`,
  `model_not_found`, `context_length`, `runtime_error`, `busy`) —
  mirroring `sanitizeTestError` discipline (`workspace-ai-provider.js:491`).

**Phase 5 streaming:** `chat.delta` from the connector → the backend
re-emits OpenAI-style SSE frames → the existing SSE client
(`client.ts:147`). The wire format Cloud↔Connector is the simplified own
`{delta}`, not raw SSE passthrough — easier to parse, and the connector
normalizes runtime differences (§6).

---

## 5. Request Path Animastor → Connector → Local Runtime

| Concern | V1 answer |
|---|---|
| Plain request/response | `chat.request` → `chat.response` (blocking local POST, `stream:false`) |
| Streaming | `chat.request{stream:true}` → N× `chat.delta` → terminal `chat.response` (or `chat.error`); backend buffers nothing |
| Errors | `chat.error` with code + sanitized message; backend maps to the existing 503/`ai_unavailable` or per-call error paths; never leaks local host detail |
| Timeout | Cloud-side timer per `request_id` (default = the existing `AI_FETCH_TIMEOUT_MS` 180 s chat window); on expiry → `chat.cancel` downstream + fail the caller; the connector aborts the local fetch on cancel |
| Cancellation | `chat.cancel` frame; connector aborts the local runtime request (AbortController); late `chat.response` for a cancelled id is dropped by the cloud |
| Concurrency | Multiplexed `request_id`s over one WS; connector-side semaphore (default 2) protects small local runtimes; busy → immediate sanitized error |

Retry semantics: the caller-side retries (3× backoff in `ai-service`,
`STEP_RETRIES` in agents) apply unchanged — the transport branch is just
another fetch.

---

## 6. Runtime Unification via OpenAI-compatible API

All four runtimes expose OpenAI-compatible `/v1/chat/completions` +
`/v1/models` — **unification via this API is possible and sufficient for
V1**. One `openai-compatible` adapter covers everything; `runtime_type` is
a UI label.

| Runtime | /v1/chat/completions | /v1/models | Differences that matter |
|---|---|---|---|
| Ollama | yes | yes | models carry `:tag` suffixes; cold model load can take 30-60 s (needs a generous first-request timeout + honest UI status) |
| vLLM | yes (native) | yes | the cleanest OpenAI-compat; solid tools support |
| llama.cpp (`llama-server`) | yes | yes | historically one model per process; limited tools — capability detection is mandatory |
| LM Studio | yes | yes | `/v1/models` lists unloaded models too; first generation pays a load latency spike |

Capability differences (tools, thinking flags) are handled through the
heartbeat `capabilities` block: the backend drops `enable_thinking` and
tool payloads when the connector advertises no support — the existing
Qwen workaround layer (`extractToolCallsFromContent` in chat-engine) stays
the safety net for nonstandard outputs. Default posture: assume a plain
completion model until the heartbeat proves more.

---

## 7. Health, Models, Latency

- **Online/offline**: live = active WS session in the registry + Redis
  TTL key (`animastor:ai-connector:hb:<id>`, TTL ~45 s), refreshed by
  heartbeat; WS close → immediate offline. PG `last_seen` is a coarse
  persistent trace (workers pattern: Redis primary, PG ~1/min).
- **Models list**: from the latest `heartbeat.models` / `models.list`;
  `models.refresh` on demand when the user opens the picker.
- **Capabilities**: heartbeat-advertised per model where the runtime
  supports it (Ollama capabilities, vLLM metadata), else connector-level
  defaults + first-call probing (V1.1).
- **Latency**: connector self-measures a tiny completion on startup and
  includes `latency_ms` in heartbeats; UI shows it as a quality hint.
- **Health check**: "Test connection" = one `chat.request` with
  `max_tokens:1` through the live WS — the direct analog of
  `testConnection` / `checkAIHealth`.

---

## 8. DB Model (no migrations yet — shape only)

One new table + one enum extension, mirroring workers PW-1
(`schema.js:1316`):

```
ai_connectors
  connector_id      UUID PK
  workspace_id      UUID NOT NULL REFERENCES workspaces ON DELETE CASCADE
  name              TEXT NOT NULL                -- "My Home Ollama"
  runtime_type      TEXT ('ollama'|'vllm'|'llamacpp'|'lmstudio'|
                    'openai-compatible')          -- UI label only
  status            TEXT ('pending'|'online'|'offline')
                    -- pending = registered, waiting for first connect
  token_hash        TEXT UNIQUE                  -- persistent aic.* credential
                                                  -- (NULL until activation)
  reg_token_hash    TEXT                         -- one-time registration
                                                  -- (NULL after activation)
  reg_expires_at    BIGINT
  token_prefix      TEXT                         -- mask '••••abcd'
  last_seen         BIGINT                       -- heartbeat stamp, ~1/min
  models            JSONB                        -- latest models.list
  capabilities      JSONB                        -- heartbeat advertisement
  runtime_meta      JSONB                        -- {version, adapter, latency_ms}
  revoked_at        BIGINT
  created_by        UUID REFERENCES users
  created_at        BIGINT

workspace_ai_providers:
  provider_type CHECK + 'local-ai'
  connector_id      UUID NULL REFERENCES ai_connectors
  -- api_key_enc: for local-ai rows the key is unused — either the NOT NULL
  -- is relaxed for this type or a marker value is stored (the "empty key"
  -- blocker named in sharing doc §4).
```

Live status deliberately stays **out** of the 30 s resolver cache —
liveness is checked at the transport step against the in-process registry
of live WS sessions, so a connector going offline fails fast with a clear
"Local AI is offline" error rather than a stale-cache hallucination.

Credentials: hash-only storage, plaintext disclosed exactly once — the
workers contract verbatim.

---

## 9. Integration with resolveAIProvider

**The only resolver change:** `buildWorkspaceProvider`
(`workspace-ai-provider.js:197-214`) for `provider_type='local-ai'`
returns `{source:'workspace', transport:'connector',
connectorId: row.connector_id, apiKey:null, endpoint:null, model}`.
Everything else — cache, fallback chain, kill switch, purpose tagging —
untouched.

**Transport branch in exactly three places:**

1. `ai-service.callAI` (`:24-39`):
   `if (provider?.transport === 'connector') return connectorTransport(...)`
   — **before** the apiKey check. No safeFetch, no `validatePublic` —
   there is no cloud-side URL at all.
2. `resolveChatAI` (`ai-routes.cjs:31-44`): the same branch for the chat
   fetch inside the route.
3. `testConnection` (`workspace-ai-provider.js:512`): for local-ai — a
   `chat.request{max_tokens:1}` through the live WS, reusing the probe
   semantics of `checkAIHealth`.

The agent pipeline (`ai-caller` → `ai-service.callAI`) is **covered
automatically — zero changes in `agent/*`**. The once-per-pipeline
snapshot capture (`bootstrap.js:68`, `:338`) is preserved.

Fail semantics: connector offline at request time → explicit
"Local AI is offline" error (analog of the 503 `ai_unavailable`), **no**
silent fallback to the system provider — the user explicitly chose a
local model; silent substitution would violate resolver predictability
and the sharing doc §9.2.3 "never mix tiers mid-conversation".

---

## 10. Security — Threat Model

| Threat | Mitigation |
|---|---|
| **Stolen registration token** | TTL ≤ 15 min, single-use (hash removed at exchange), workspace-bound, shown once. Worst case: an attacker's connector attaches to *your* workspace — detectable as "unexpected connector online", fixable by revoke. Grants no access to others' data. |
| **Stolen connector credential** (`aic.*`) | The attacker can impersonate your connector and intercept your prompts/responses (prompt leakage) or substitute replies. Grants **no**: access to workspace B (identity fail-closed, the `worker-auth.js` pattern verbatim), key material, or book writes (tool patches validated server-side — `applyPatchesValidated`). Mitigations: rotate/revoke (copy of the worker routes), UI "Connector active since…" + alert on fingerprint change (client-generated pubkey hash in hello, optional V1.1). |
| **Connector spoofing (MITM)** | TLS mandatory — the connector only connects to `wss://` on the registered domain; self-signed certificates rejected. |
| **Cross-workspace access** | `workspace_id` never from body/query; derived from the credential (the `worker-auth-middleware.js` invariant, copied verbatim). The WS session binds to connector_id; the registry hands out a connection only after `provider.connector_workspace == caller_workspace`. |
| **SSRF** | The cloud **never** fetches any address associated with a connector; `assertPublicEndpoint` is untouched and not weakened — the cloud→localhost path simply does not exist. Connector→runtime: one fixed `--base-url` from local config. |
| **Connector as universal proxy** | Structural defense: `chat.request` has **no URL field**. The adapter knows only `POST {base}/v1/chat/completions` and `GET {base}/v1/models`; no arbitrary paths, no redirect-following on runtime calls. A second runtime means a second connector instance. This is the main V1 architectural commitment; it must not be eroded "for convenience". |
| **Malicious cloud → user LAN** | A compromised cloud can send arbitrary prompts into the local model (prompt injection into replies — but replies pass server-side patch validation) and read responses. It cannot reach other LAN hosts/ports (allowlist above) or execute code (chat is the only operation). The adapter defaults to loopback-only base URLs and refuses non-loopback unless `--allow-lan` is explicitly set. |
| **Prompt/data leakage** | Honest model per sharing doc §7.4/§9.2: the local runtime and connector see the user's prompts (their own machine — operator class `self`). Under future sharing the operator becomes `peer` and the consumer warning is mandatory. The connector must log requests locally with a disk-space cap. No privacy promises in UI. |
| **Registration flooding** | Rate limit on the registration route (existing `express-rate-limit` pattern, `backend.cjs:68`); at most one pending registration per workspace. |

---

## 11. Reuse vs Create vs Do-Not-Touch

**Reuse as-is:**
- `wrk.*` credential contract & repo pattern (`worker-repo.js` → clone to
  `ai-connector-repo.js`).
- `worker-auth` middleware discipline (fail-closed identity derivation).
- Redis heartbeat key pattern (`animastor:worker:heartbeat:*` →
  `animastor:ai-connector:hb:*`).
- Resolver cache/invalidation semantics; SSE client (`client.ts:147`) for
  Phase 5; settings route guard pattern (`identityGuard`).
- One-time Setup Center UX precedent (`worker-setup-routes.cjs`) as a
  template for the registration wizard.
- Dormant `GET /settings/ai/providers` as the natural home for adding the
  local-ai provider row.

**Create:**
- `backend/src/services/ai-connector/` — registry (live WS sessions),
  transport (`callAI` equivalent), protocol codec, request multiplexer.
- `backend/src/routes/ai-connector-routes.cjs` — registration/exchange/
  WS/rotate/revoke/status/models.
- `backend/src/storage/postgres/repositories/ai-connector-repo.js`.
- `ai_connectors` table (shape in §8).
- **New distributable**: `local-ai-connector/` (Node ≥18, zero-dep besides
  `ws`) — the process the user runs: config (base-url, runtime type,
  server URL), reconnect with backoff, allowlist adapter, heartbeat
  sender, local request log. Install shape: `npx animastor-ai-connector
  --token <reg_token>` mirroring the worker one-command bootstrap.
- Web: `LocalAISection` in Settings + the connection wizard + model picker.

**Do not touch:**
- `gpu-hub/*` (D9); `worker/*` (different resource class);
  `url-safety.js` (SSRF stays as-is); `system-ai.js` kill switch;
  `workers` / `share_policies` tables; agent pipeline internals
  (`agent/*` — covered automatically); `ai-caller.js`;
  `resolveAIProvider` signature and cache semantics.
- Android client in V1 (backend + Web UI only; see §13).

**Decisions required BEFORE implementation:**
1. WS termination in the backend monolith vs a dedicated service —
   recommendation: backend monolith (single deploy, single auth boundary).
2. Credential family: new `aic.*` prefix vs reusing `wrk.*` —
   recommendation: new prefix (disjoint identity namespaces, like
   sessions vs guests vs workers).
3. Relaxing `api_key_enc NOT NULL` for local-ai rows vs a marker value —
   recommendation: marker value (no schema constraint change in V1).
4. Whether the registration token lives in `ai_connectors.reg_token_hash`
   or a separate short-lived table — recommendation: same row (simpler
   lifecycle; hash nulled at activation).
5. Multi-connector per workspace in V1 — recommendation: allow N rows but
   only one active provider binding (the singleton PK stays on the
   provider side).

---

## 12. Component Structure (validated against the code)

```
CLOUD                                     LOCAL (user machine)
─────────                                 ─────────────────────
nginx (proxy/conf)                        animastor-ai-connector
  location /api/v1/ai-connector/ (WS up)    ├─ config (base-url, runtime type)
backend.cjs                                ├─ reconnect/backoff
  ai-connector-routes.cjs                  ├─ allowlist adapter
    ├─ POST   /ai-connector/registrations  │    POST {base}/v1/chat/completions
    ├─ POST   /ai-connector/exchange       │    GET  {base}/v1/models
    ├─ GET    /ai-connector/ws  (WS)       ├─ heartbeat sender (models+caps)
    ├─ GET    /ai-connector/status         └─ local request log (capped)
    ├─ GET    /ai-connector/models
    ├─ POST   /ai-connector/:id/rotate     Ollama / vLLM / llama.cpp /
    ├─ DELETE /ai-connector/:id            LM Studio on 127.0.0.1
  ai-connector-registry (live WS map)
  ai-connector-transport (callAI branch)
  workspace-ai-provider.js (snapshot + 'local-ai' type)
PG: ai_connectors + workspace_ai_providers
Redis: hb TTL keys
Web: Settings → AI → Local AI
```

The suggested structure survives the audit; the corrections are: the
registry lives in the backend process (not a separate service), the
"endpoint/provider layer" is the existing `workspace-ai-provider.js` (no
new layer), and the request router is the existing resolver + transport
branch rather than a new component.

---

## 13. Android / Web Client Impact

**V1: backend + Web UI only.** Reasons: the Web client is the persona for
provider configuration (admin stays web-only already); the Android
provider screen is parity-locked (`ANDROID_WEB_PARITY.md`); no client
contract changes are needed because chat keeps consuming the same
`/api/v1/ai/chat` response — the model just runs locally. Android sees
nothing new; when the user's provider is local-ai, error text may say
"Local AI is offline" — already compatible.

Android work is deferred to Phase 6.5/7 (mirror of the Local AI section,
i18n RU/EN, parity doc update), same pattern as the worker sharing V2
Android parity commit.

---

## 14. V1 Constraint and the Path to Sharing

V1 = PRIVATE LOCAL AI ONLY: no sharing, no credits, no billing, no
community pool. But the design already aligns with the sharing doc's
ladder:

```
Owner → Private Local AI → Share spare capacity → Shared AI Pool
        (V1: this doc)     (V2: ai_endpoints +    (V3/V4: pool resolver
                              share_policy rows       stage + ledger)
                              on connector endpoints)
```

- The connector endpoint is exactly the "shareable resource = inference
  endpoint / serving capacity" the sharing doc §5 defines — **not** model
  weights, **not** the GPU.
- The `ai_connectors` row is the natural future `ai_endpoints` record
  (V2 of the sharing doc): ownership, capabilities JSONB, health state —
  column-for-column compatible with the doc's §12 table
  (`workers.capabilities` precedent).

**The bridge to the sharing doc is one resolver stage** (its §6.2/§11.2):
today's chain stays steps 1/3/4/5; the shared pool becomes stage 2,
consulting `ai_endpoints` rows (connector-backed or provider-backed)
with active policies — owner traffic never traverses the pool (D3),
and connector-backed capacity slots into the same health/semantics as
provider-backed endpoints. No LLM Sharing is implemented or implied by
this V1 — the connector merely must not foreclose it.

---

## 15. Implementation Plan (phases; files to create/modify)

### Phase 1 — Infrastructure
- Create: `ai_connectors` table migration in
  `backend/src/storage/postgres/schema.js` (workers-PW-1 pattern);
  `backend/src/services/ai-connector/registry.js` (live session map).
- Add: `ws` dependency to `backend/package.json`.
- Modify: `proxy/conf/default.conf` —
  `location /api/v1/ai-connector/` with `Upgrade`/`Connection` headers.

### Phase 2 — Registration & Auth
- Create: `ai-connector-repo.js` (credential lifecycle, clone of
  worker-repo); `backend/src/routes/ai-connector-routes.cjs`
  (registration create → one-time token; exchange over WS hello).
- Wire: `backend/src/backend.cjs` (route require, after
  `settings-ai-routes.cjs:230`).
- Tests: `backend/tests/ai-connector-auth.test.js` (fail-closed matrix,
  exchange, revoke, rotate — clone of `fail-closed-worker-auth.test.js`).

### Phase 3 — Runtime Discovery
- Connector distributable skeleton: `local-ai-connector/`
  (hello/ready, heartbeat with models + capabilities,
  `GET {base}/v1/models`, reconnect backoff, loopback enforcement).
- Cloud: status/models routes reading registry + PG.

### Phase 4 — Inference (non-streaming)
- Modify: `workspace-ai-provider.js` — `buildWorkspaceProvider`
  local-ai branch; `PROVIDER_TYPES` + `local-ai` (`:28`); `testConnection`
  branch (`:512`).
- Create: `ai-connector/transport.js` — the `callAI`-shaped function the
  transport branch calls.
- Modify: `ai-service.js:20-39` (branch before apiKey check);
  `ai-routes.cjs` `resolveChatAI` (`:31-44`).
- Modify: `settings-ai-routes.cjs` — allow provider_type `local-ai`
  without public-endpoint SSRF check (endpoint is null; connector_id
  validated instead).
- Tests: resolver branch matrix, offline-fail-explicit, concurrency cap.

### Phase 5 — Streaming
- Connector: stream parsing of runtime SSE → `chat.delta` frames.
- Backend: re-emit OpenAI-style SSE for chat; route
  `POST /api/v1/ai/chat/stream` (greenfield — does not exist today).
- Web: incremental rendering in `AiAssistantPage.tsx`.

### Phase 6 — UI
- Web: `LocalAISection` (SettingsPage `:30-33` extension), connection
  wizard (one-time token display + copy), status card ("My Local AI /
  Ollama / Qwen3 32B / Online"), model picker fed by `/ai-connector/models`,
  provider binding via existing PUT `/settings/ai/provider`.
- i18n strings EN/RU in `frontends/app/src/app/i18n.ts`.

### Phase 7 — Production Hardening
- Rate limits on registration; connector fingerprint alert; latency
  surface; local log capping; `DONT_DO` / parity docs update;
  Android parity (deferred, see §13); load test of the WS path;
  security review pass (extend
  `EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER_SECURITY_REVIEW.md`).

---

## 16. Risks and Open Questions

1. **Connector machine asleep/off** — the user's mental model must be set
   honestly (Offline state, offline badge, explicit error). Mitigation is
   UX, not tech.
2. **First-token latency on cold models (Ollama/LM Studio)** — 30-60 s
   spikes exceed current chat timeouts; V1 must surface "model loading…"
   rather than a generic timeout. Open: per-connector timeout overrides?
3. **Multi-provider selection** — V1 keeps the workspace singleton row;
   switching between cloud and local AI is a provider_type flip. The
   dormant multi-provider list endpoint exists, but V1 does not widen the
   singleton (deliberate; matches the sharing doc V2 boundary).
4. **`aic.*` vs `llmc.*`** — the sharing doc §17 names `llmc.*` as the V3
   credential family. `aic.*` is chosen here for the disjoint-namespace
   rule; must be reconciled in the sharing doc before Phase 2 (cosmetic,
   but better settled early).
5. **WS through nginx** — upgrade config is trivial but must be tested
   against the current `Connection ""` default; failure mode is a silent
   200-without-upgrade.
6. **Tool-calling through local models** — many local models are weak at
   Qwen-style tool syntax; chat degrades gracefully (existing extraction
   workarounds), but the UI should not promise tool parity until
   capabilities prove it.
7. **Guest workspaces** — recommend registered users only (sharing doc
   Q1 analog): guests are ephemeral; binding a long-lived connector to
   them is incoherent.

---

## 17. Final V1 Architecture (ASCII)

```
                    ANIMASTOR CLOUD
┌──────────────────────────────────────────────────────────┐
│  nginx  ──/api/v1/ai-connector/──► backend (WS termin.)  │
│                                      │                    │
│           ┌──────────────────────────┼────────────────┐  │
│           ▼                          ▼                ▼  │
│  ai-connector-registry      workspace-ai-provider   Web  │
│  (live WS map, hb TTL)      resolveAIProvider()    UI:   │
│           │                  transport branch      Local │
│  PG: ai_connectors           │                      AI   │
│  workspace_ai_providers      ▼                            │
│  (provider_type='local-ai')  ai-service.callAI            │
│                                      │                    │
└──────────────────────────────────────┼────────────────────┘
                                       │ WSS (outbound,
                                       │ user-initiated)
┌──────────────────────────────────────▼────────────────────┐
│  USER MACHINE — animastor-ai-connector                    │
│  ┌──────────────┐  allowlist adapter  ┌────────────────┐ │
│  │ reconnect,   │────────────────────►│ Ollama / vLLM  │ │
│  │ heartbeat,   │  POST /v1/chat/      │ llama.cpp /    │ │
│  │ local log    │  completions        │ LM Studio      │ │
│  └──────────────┘  GET /v1/models     └────────────────┘ │
│                          127.0.0.1 only                   │
└───────────────────────────────────────────────────────────┘

V1: PRIVATE LOCAL AI ONLY — no sharing, no credits, no pool.
V2+ bridge (sharing doc §6.2): connector endpoint → ai_endpoints
row → share policy → pool resolver stage 2. Owner traffic never
traverses the pool.
```
