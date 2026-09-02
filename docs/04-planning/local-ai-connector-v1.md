# Local AI Connector — Technical Audit and V1 Specification

> 2026-09-02 · Revision 2 (finalization pass) · Research / architecture
> only — **no production code, no schema migrations, no API, no
> Web/Android changes**. Companion to `llm-agent-resource-sharing-model.md`
> (the LLM sharing design; its §13 and §15/V3 already reserve an "LLM
> Connector" with an `llmc.*` credential family) and to
> `EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER.md` (the private tier this
> builds on).
>
> Revision 2 fixes: credential namespace reconciled to `llmc.*` (AD-1);
> Connector ≠ Provider invariant (AD-2); atomic single-use registration
> exchange (AD-3); security model split chat/agent/tool/patch (AD-4,
> AD-5); metadata-only local logging (AD-6); no automatic model-loading
> probes (AD-7). Normative decision register: §17.
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
   `ai-connector` / `llmc.*` vocabulary; in UI use "Local AI" — the
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
2. **Connector identity = `llmc.<connector_id>.<secret>` credential** — an
   exact copy of the `wrk.*` contract: hash-only in PG, one-time
   disclosure, rotate/revoke. Workspace binding as workers have it: FK +
   identity only from the credential. The prefix `llmc.*` is **reconciled
   with the sharing doc §17** (AD-1) — one credential namespace for the
   connector, reused unchanged when LLM Sharing lands; no second namespace
   for the same entity is ever created.
3. **Two-phase credential:** a one-time **registration token** (created in
   the UI, TTL ≤ 15 min, single-use, hash-only) which the connector
   exchanges on first connect for the persistent `llmc.*` credential.
   The exchange is **atomic and exactly-once** (AD-3, §8.1). Differs from
   workers (where the token is issued together with the row) because an
   LAC token is pasted into a terminal — the exposure window is wider.
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

### 3.1 Invariant — Connector ≠ Provider (normative, AD-2)

**Connector = a connected local runtime / compute resource.
Provider = the Animastor-selected route for using AI.** Two entities,
two lifecycles, never conflated:

```
Workspace
├── Local Connector A → Ollama → Qwen3      (online · 3 models · NOT selected)
├── Local Connector B → vLLM → Llama-70B    (offline · registered)
└── Provider selection → Connector A, model "qwen3:32b"
    (the single workspace_ai_providers row)
```

Normative consequences for V1:

- A Connector exists, connects, goes online/offline and reports any
  number of models **regardless of whether it is currently selected as
  the Provider**. Selection is a separate, explicit act.
- Storage split: `ai_connectors` rows are **N per workspace** (several
  machines/runtimes allowed); `workspace_ai_providers` remains the
  **singleton consumer binding** (PK = `workspace_id`). A `local-ai`
  binding row carries `connector_id` + free-text `model` — nothing else
  changes structurally.
- Selecting / switching = one UPDATE on the provider row; the resolver
  cache invalidates as today (≤ 30 s). Deregistering a selected
  connector leaves the binding pointing at a dead `connector_id` →
  requests fail closed with "Local AI is offline" until the user
  re-binds (no silent fallback, §9).
- Capabilities / models / health facts belong to the **Connector**; the
  Provider binding only references them. The UI shows both truths:
  "Ollama · Qwen3 32B · Online" is a connector fact; "AI Provider:
  Local AI" is the binding fact.
- **V1 boundary:** no multi-provider system, no provider-list UI; the
  dormant `GET /settings/ai/providers` stays dormant. This split is the
  V1-safe subset of the sharing doc's V2 direction ("the provider becomes
  a pure consumer binding" — sharing doc §1/§15-V2): it fixes the
  vocabulary without implementing V2.

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
                   -- reg_token = llmcreg.* (one-time) | credential = llmc.*
S→C  ready        { connector_id, heartbeat_interval_ms, server_time }
C→S  heartbeat    { models[], capabilities{tools,vision,context},
                    runtime_ok, latency_ms, runtime{type, version} }
                   — every 10-15 s; latency_ms from real traffic only (AD-7)
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

**Phase-2 implementation note (updated, 2026-09-02):** the WS endpoint
`GET /api/v1/ai-connector/ws` authenticates `hello` in exactly one of two
modes: the **persistent `llmc.*` credential**, or the **one-time
`llmcreg.*` registration token** — the atomic activation exchange of §8.1
runs inside the hello handler, and `ready` discloses the freshly minted
`llmc.*` exactly once (`{ connector_id, heartbeat_interval_ms, server_time,
credential, credential_prefix }`; on the credential path `ready` carries no
credential field). Presenting both modes in one hello is a policy
violation (close 1008); a re-hello after authentication is refused
(fail-closed, never a self-replacement in the registry). The HTTP surface
(`ai-connector-routes.cjs`): `POST /ai-connector/registrations` (create →
one-time token, users-only, rate-limited per §10.2), `GET
/ai-connector/registrations/:id/token` (re-arm, pending only), `GET /POST
/DELETE /ai-connector/connectors[...]` (list / detail / rotate / revoke —
the worker-routes discipline verbatim; rotate and revoke evict the live WS
session). There is deliberately **no HTTP exchange endpoint** — the
exchange happens only over the connector's own authenticated WS session
(§15 Phase 2). Unknown message types are ignored safely; malformed frames
and auth/protocol violations close the socket; incoming frames are capped
(64 KB); a single live session per connector is enforced (`replaced` close
code 4000); PG `status/last_seen` are the durable state (online while
connected, offline on disconnect/heartbeat timeout, writes throttled to
~1/min) with the Redis TTL key `animastor:ai-connector:hb:<id>` as a
liveness mirror (§7, §8.1.5).

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
- **Runtime health** (heartbeat): the WS session is alive (implicit) and
  the runtime is reachable — `GET {base}/v1/models` answered. This check
  is cheap, loads no model, locally cached ~30 s; reported as
  `runtime_ok`.
- **Model availability**: a model discovered via `/v1/models` /
  `heartbeat.models` counts as *available* (discovered). This does **not**
  imply loaded or warm — cold-load state is learned only from real
  request timing.
- **Inference latency**: measured only over **real** `chat.request`
  completions (rolling value reported as `latency_ms`; null until the
  first real request). **No automatic completion probes at startup or on
  heartbeat** (AD-7) — a probe would cold-load a multi-GB model just to
  produce a health number. Latency as a UI hint appears only once real
  traffic exists.
- **Health check ("Test connection")**: **explicit and user-initiated**
  only — one `chat.request` with `max_tokens:1` through the live WS (the
  `testConnection` / `checkAIHealth` analog). The UI warns it may trigger
  a cold model load and take tens of seconds. Never scheduled, never
  heartbeat-driven.

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
  token_hash        TEXT UNIQUE                  -- persistent llmc.* credential
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
workers contract verbatim. Namespace: `llmc.*` (AD-1).

### 8.1 Registration token — atomic exchange (normative, AD-3)

**Exactly-once activation.** One registration token activates at most one
connector session, ever. The exchange is a single serialized DB
transaction; two connector processes racing with the same token produce
exactly one active credential and one loser.

Transaction shape (conceptual — no code):

```
BEGIN (row-level lock on the connector row: SELECT … FOR UPDATE)
  1. locate row by reg_token_hash  (timing-safe compare, as workers do)
  2. validate: reg_token_hash IS NOT NULL
              AND reg_expires_at > now()
              AND revoked_at IS NULL
              AND status = 'pending'
  3. invalidate: reg_token_hash := NULL, reg_expires_at := NULL
  4. activate:  token_hash := SHA-256(new llmc.* secret)
                token_prefix := mask, status := 'online'
  5. issue:     plaintext llmc.<connector_id>.<secret> returned once
COMMIT
```

Race-condition protection, layer by layer:

1. **`SELECT … FOR UPDATE` on the row** — the second concurrent exchanger
   blocks on the row lock; when the first transaction commits, the loser
   re-reads the row and finds `reg_token_hash IS NULL` → fails with
   `registration_already_used`. PG row locks serialize the critical
   section; no application-level mutex needed for a single backend.
2. **Fail-closed validation order** — expiry and revocation are checked
   *inside* the lock, immediately before mutation, so a token expiring
   mid-race cannot be revived by the loser.
3. **Hash-only storage** — both racers present the same plaintext, but
   activation state lives only in the row the lock guards; there is no
   secondary state to desynchronize.
4. **Single backend (V1)** — the in-process WS registry plus the row lock
   cover the whole state space. **If the backend ever scales
   horizontally**, the WS handshake must route (or the registry must
   delegate) so that exchange and live-session registration consult the
   same PG row lock — the row lock *is* the cross-instance primitive; no
   Redis flag may become authoritative (PG-only truth, the worker-mirror
   doctrine).
5. **Stale-session sweep** — a second *live WS session* presenting the
   same persistent `llmc.*` credential after activation: the registry
   closes the older session when a newer one authenticates (single
   live session per connector_id; last-writer-wins, the older socket gets
   a `replaced` close code). This prevents two live sessions from one
   credential regardless of how it was obtained.

After activation the registration token is dead by construction
(hash nulled inside the committed transaction) — replay attempts fail at
step 2 and are logged (rate-limited per workspace).

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
   **user-initiated** `chat.request{max_tokens:1}` through the live WS
   (the `checkAIHealth` probe semantics; may cold-load the model — the UI
   warns, AD-7). Never invoked automatically by the backend or connector.

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

### 10.1 Layered security model (normative, AD-4/AD-5)

**Master invariant:** the Connector executes only the operations the
Local AI Connector protocol explicitly defines. It is **not** a universal
remote proxy and receives **no** arbitrary access to the local machine —
no filesystem paths, no shell, no arbitrary URLs, no "run this for me"
extension point. The protocol surface is finite and enumerable: `hello`,
`heartbeat`, `models.list`, `chat.request → chat.delta/chat.response/
chat.error`, `chat.cancel`. Anything not in that list does not exist.

Responses are **data, never instructions** (the standing repo rule).
Protection is layered per response class, and each layer is independent —
**agent patch validation does NOT backstop plain chat responses, and no
layer relies on the connector being trusted**:

| Response class | Path after the connector | Server-side protection (independent layers) |
|---|---|---|
| **Plain chat response** | `/ai/chat` → `reply` string to the user | Rendered as text/data in the clients. No server-side "validation" of prose is possible or claimed — the honest model: a malicious connector can return **any text**, including social-engineering content. Mitigation is transport trust (the user's own machine, §10.2) + the clients never execute response content. Tool calls *inside* a chat response go through the tool row below. |
| **Agent response** (import pipeline) | `ai-caller` → `parseJsonResponse` | JSON parsing + structure checks in the pipeline; a malformed/hostile response fails the step (fail-closed), retries per `STEP_RETRIES`, never silently accepted. |
| **Tool call** (chat tools) | `extractToolCallsFromContent` / tool schema | Tool schemas are **fixed Animastor code** (`chat-engine.cjs`); a connector can at most produce calls for pre-declared tools — it cannot define new tools or invoke undeclared capabilities. |
| **Patch / action** (book edits) | `applyPatchesValidated` (JSON-Patch + bundle contract) | Every patch validated server-side against the bundle contract **before any write**; a hostile connector cannot write arbitrary state into a book. This layer guards *writes only* — it is not a chat-content filter. |

Consequence for the threat table: "server-side patch validation"
protects **patch/action** rows only. Plain chat text from a compromised
connector reaches the user's screen as-is (minus `<think>` stripping) —
this residual risk is owned by §10.2 (the connector runs on the user's
own machine) and is the same trust model as any local runtime.

### 10.2 Threat table

| Threat | Mitigation |
|---|---|
| **Stolen registration token** (`llmcreg.*`) | TTL ≤ 15 min, single-use with **atomic exactly-once exchange** (§8.1), workspace-bound, shown once. Worst case: an attacker's connector activates on *your* workspace first — detectable as "unexpected connector online", curable by revoke. Grants no access to others' data. |
| **Stolen connector credential** (`llmc.*`) | The attacker can impersonate your connector and intercept your prompts/responses (prompt leakage) or substitute replies — including arbitrary chat text (§10.1, chat row). Grants **no**: access to workspace B (identity fail-closed, the `worker-auth.js` pattern verbatim), key material, or book writes (patch layer, §10.1). Mitigations: rotate/revoke (copy of the worker routes), UI "Connector active since…" + alert on fingerprint change (client-generated pubkey hash in hello, optional V1.1), single-live-session rule (§8.1.5). |
| **Connector spoofing (MITM)** | TLS mandatory — the connector only connects to `wss://` on the registered domain; self-signed certificates rejected. |
| **Cross-workspace access** | `workspace_id` never from body/query; derived from the credential (the `worker-auth-middleware.js` invariant, copied verbatim). The WS session binds to connector_id; the registry hands out a connection only after `provider.connector_workspace == caller_workspace`. |
| **SSRF** | The cloud **never** fetches any address associated with a connector; `assertPublicEndpoint` is untouched and not weakened — the cloud→localhost path simply does not exist. Connector→runtime: one fixed `--base-url` from local config. |
| **Connector as universal proxy / arbitrary local execution** | Structural defense (master invariant, §10.1): `chat.request` has **no URL field**; the adapter knows only `POST {base}/v1/chat/completions` and `GET {base}/v1/models`; no arbitrary paths, no redirect-following on runtime calls, no filesystem/shell surface at all. A second runtime means a second connector instance. This commitment must not be eroded "for convenience". |
| **Malicious cloud → user LAN** | A compromised cloud can send prompts into the local model and read responses (trust boundary stated honestly, §10.1 chat row). It cannot reach other LAN hosts/ports (allowlist above) or execute code — the protocol has no operation beyond chat completion. The adapter defaults to loopback-only base URLs and refuses non-loopback unless `--allow-lan` is explicitly set. |
| **Prompt/data leakage** | Honest model per sharing doc §7.4/§9.2: the local runtime and connector see the user's prompts (their own machine — operator class `self`). Under future sharing the operator becomes `peer` and the consumer warning is mandatory. Local logging is **metadata-only by default** (§10.3). No privacy promises in UI. |
| **Registration flooding** | Rate limit on the registration route (existing `express-rate-limit` pattern, `backend.cjs:68`); at most one pending registration per workspace. |
| **Token replay after activation** | Dead by construction — hash nulled inside the committed exchange transaction (§8.1); replay attempts fail validation and are rate-limited per workspace. |

### 10.3 Local request logging (normative, AD-6)

**Default: metadata-only.** The connector stores **no** prompts, messages,
or model responses on disk by default — they may contain the user's
private content, and a connector log must never become a second copy of
the user's conversations.

Metadata-only log record (safe fields only):

```
request_id, model, duration_ms, status (ok|error|cancelled),
error_code, stream (bool), timestamp
```

- Written locally, size-capped (rotate at a fixed small bound, e.g. a few
  hundred records) — diagnostics without content.
- **Verbose/full logging (prompts + responses) must satisfy all of:**
  explicitly enabled by a local CLI flag (`--log-requests`), off by
  default, a printed warning that prompts/responses will be stored in
  plaintext, and a hard size cap. Never enabled remotely — the cloud
  **cannot** turn it on via the protocol (no such message exists).
- This resolves the earlier "local request log with cap" wording: the cap
  applies to metadata; content logging is opt-in-only.

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
  sender, **metadata-only request log** (AD-6). Install shape:
  `npx animastor-ai-connector --token <reg_token>` mirroring the worker
  one-command bootstrap.
- Web: `LocalAISection` in Settings + the connection wizard + model picker.

**Do not touch:**
- `gpu-hub/*` (D9); `worker/*` (different resource class);
  `url-safety.js` (SSRF stays as-is); `system-ai.js` kill switch;
  `workers` / `share_policies` tables; agent pipeline internals
  (`agent/*` — covered automatically); `ai-caller.js`;
  `resolveAIProvider` signature and cache semantics.
- Android client in V1 (backend + Web UI only; see §13).

**Decisions BEFORE implementation — final status (normative register: §17):**
1. WS termination in the backend monolith vs a dedicated service —
   **resolved (AD-8)**: backend monolith (single deploy, single auth
   boundary).
2. Credential family — **resolved (AD-1)**: `llmc.*` persistent /
   `llmcreg.*` registration, reconciled with the sharing doc (§13 table,
   §17, glossary). No second namespace for the same entity; the earlier
   `aic.*` proposal is dropped.
3. Relaxing `api_key_enc NOT NULL` for local-ai rows vs a marker value —
   **resolved (AD-11)**: marker value (no schema constraint change in V1).
4. Whether the registration token lives in `ai_connectors.reg_token_hash`
   or a separate short-lived table — **resolved (AD-3)**: same row,
   claimed inside the atomic exchange transaction (§8.1).
5. Multi-connector per workspace in V1 — **resolved (AD-2)**: allow N
   connector rows, but only one active provider binding (the singleton PK
   stays on the provider side).

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
    ├─ GET    /ai-connector/status         └─ metadata-only log (AD-6)
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
- **Credential namespace (AD-1):** the connector uses `llmc.*` — the same
  family the sharing doc reserves for its V3 LLM Connector (§13
  worker-mechanism table, §17, glossary: "an outbound-registered local
  runtime (worker-pattern credential + heartbeat) for home GPUs behind
  NAT"). One namespace for one entity across private (V1) and shared
  (V3) use; the sharing doc's alternative ("or reuse of the `wrk.*`
  envelope", §17) is declined — identity namespaces stay disjoint
  (sessions / guests / workers / llm-connectors). No edit to the sharing
  doc is required: it offered both options; this document fixes the
  choice.

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
  worker-repo; `llmc.*` + `llmcreg.*` families per AD-1);
  `backend/src/routes/ai-connector-routes.cjs`
  (registration create → one-time token; atomic exchange over WS hello
  per §8.1).
- Concurrency test is mandatory: two simultaneous exchanges with the same
  registration token → exactly one winner, one clean
  `registration_already_used` loser; replay after activation fails.
- Wire: `backend/src/backend.cjs` (route require, after
  `settings-ai-routes.cjs:230`).
- Tests: `backend/tests/ai-connector-auth.test.js` (fail-closed matrix,
  atomic exchange, revoke, rotate — clone of
  `fail-closed-worker-auth.test.js`).

### Phase 3 — Runtime Discovery
- Connector distributable skeleton: `local-ai-connector/`
  (hello/ready, heartbeat with models + capabilities + `runtime_ok`,
  `GET {base}/v1/models`, reconnect backoff, loopback enforcement,
  **metadata-only logging** per AD-6, **no automatic probes** per AD-7).
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
  surface (real-traffic stats only, AD-7); verbose-log opt-in with
  warning + size cap (AD-6); `DONT_DO` / parity docs update;
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
   singleton (deliberate; matches the sharing doc V2 boundary — the
   Connector ≠ Provider split, AD-2, is what keeps this boundary clean
   when V2 arrives).
4. **WS through nginx** — upgrade config is trivial but must be tested
   against the current `Connection ""` default; failure mode is a silent
   200-without-upgrade.
5. **Tool-calling through local models** — many local models are weak at
   Qwen-style tool syntax; chat degrades gracefully (existing extraction
   workarounds), but the UI should not promise tool parity until
   capabilities prove it.
6. **Guest workspaces** — recommend registered users only (sharing doc
   Q1 analog): guests are ephemeral; binding a long-lived connector to
   them is incoherent.
7. **Horizontal backend scaling** — V1 assumes a single backend instance
   (consistent with today's in-process resolver cache and registry). If
   the deployment ever scales out, the WS registry must become
   instance-aware and the atomic exchange (§8.1.4) must keep PG row locks
   as the only serialization point. Not a V1 work item — recorded as a
   boundary condition.

---

## 17. Architecture Decisions — V1 Final

Normative register. Each decision is final for V1 unless a later
revision of this document supersedes it; the sharing doc remains the
companion authority for anything sharing-related.

| # | Decision | Rationale / where |
|---|---|---|
| **AD-1** | **Credential namespace = `llmc.*`** (persistent credential) + `llmcreg.*` (one-time registration token). Reconciled with `llm-agent-resource-sharing-model.md` §13/§17/glossary, which reserve `llmc.*` for the LLM Connector. One namespace for one entity — reused unchanged when LLM Sharing lands. The earlier `aic.*` proposal is dropped. | §3, §8, §14 |
| **AD-2** | **Connector ≠ Provider.** Connector = connected local runtime (N per workspace, own lifecycle, online/offline, models). Provider = the singleton `workspace_ai_providers` binding that *references* one connector + model. V1 adds no multi-provider system; the split only fixes the boundary the sharing doc's V2 will need. | §3.1 |
| **AD-3** | **Registration token: atomic, exactly-once exchange.** Single PG transaction with `SELECT … FOR UPDATE`: validate → invalidate reg hash → activate `llmc.*` → commit. Racing processes produce one winner, one loser (`registration_already_used`). Reg-token hash lives in the connector row; single live WS session per connector (older session closed with `replaced`). | §8.1 |
| **AD-4** | **Layered response security, chat ≠ agent ≠ tool ≠ patch.** Master invariant: the connector executes only protocol-defined operations; it is not a remote proxy and has no arbitrary local-machine access. Agent patch validation protects patches only — plain chat responses are data rendered to the user; no layer claims otherwise. | §10.1 |
| **AD-5** | **Allowlist adapter, not proxy.** Cloud never sends a URL; the adapter knows exactly two paths (`POST {base}/v1/chat/completions`, `GET {base}/v1/models`); `--base-url` is local-config-only, loopback default, `--allow-lan` explicit. No filesystem/shell/arbitrary-path surface exists in the protocol. | §3.4, §10.1 |
| **AD-6** | **Local logging: metadata-only by default** (request_id, model, duration, status, error code, stream, timestamp; size-capped). Full prompt/response logging only via an explicit local flag, with a printed warning and a hard cap; never remotely enableable — the protocol has no such message. | §10.3 |
| **AD-7** | **No automatic inference probes.** Health = WS alive + `GET /v1/models` reachable (loads no model). Latency measured only over real requests; latency hint appears after first real traffic. "Test connection" (a `max_tokens:1` completion) is user-initiated only, with a cold-load warning. | §7, §9 |
| **AD-8** | **WS terminates in the backend monolith** (not gpu-hub, not a new service). nginx gains one upgrade location. V1 assumes a single backend instance; horizontal scaling requires PG-row-lock-backed registry coordination (boundary condition, not V1 work). | §3, §16.7 |
| **AD-9** | **LLM inference never rides gpu-hub** (inherited D9). The connector rides the `resolveAIProvider` seam; the worker stack is untouched. | §2.4, §15 |
| **AD-10** | **V1 = PRIVATE LOCAL AI ONLY.** No sharing, credits, billing, community pool, marketplace, Android implementation, or production code in this revision. Nothing in the schema or protocol carries sharing state; the sharing bridge is one future resolver stage (§14). | §14, §15 |
| **AD-11** | **`api_key_enc` for `local-ai` provider rows: marker value**, no NOT NULL relaxation in V1 (the empty-key blocker from sharing doc §4 is thus resolved without a schema-constraint change). | §8, §11.3 |
| **AD-12** | **Fail-closed offline semantics:** a selected connector that is offline yields an explicit "Local AI is offline" error; never a silent fallback to system/env AI (resolver predictability + sharing doc §9.2.3 no-tier-mixing). | §9 |

---

## 18. Final V1 Architecture (ASCII)

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
│  │ meta-log     │  completions        │ LM Studio      │ │
│  └──────────────┘  GET /v1/models     └────────────────┘ │
│                          127.0.0.1 only                   │
└───────────────────────────────────────────────────────────┘

V1: PRIVATE LOCAL AI ONLY — no sharing, no credits, no pool.
Connector ≠ Provider (AD-2): connectors are resources; the provider
row binds one. Decisions register: §17 (AD-1…AD-12).
V2+ bridge (sharing doc §6.2): connector endpoint → ai_endpoints
row → share policy → pool resolver stage 2. Owner traffic never
traverses the pool.
```
