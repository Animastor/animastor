# LLM Sharing — Phase 2: Consumer Resolver & Shared Inference

> 2026-09-03 · Implementation document for the SECOND production phase of
> LLM sharing: the first real consumer flow. Companions (authorities):
> `llm-sharing-phase1-control-plane.md` (Phase 1 — entities, share policy,
> pool resolver seam), `local-ai-connector-v1.md` (the connector — §9
> resolver seam, AD-5 allowlist adapter, AD-12 fail-closed offline),
> `llm-agent-resource-sharing-model.md` (the sharing design — §6.2 resolver
> ladder, §6.3 invariants).
>
> Core flow realized here:
>
> ```
> AI request → existing AI resolver → Private Local AI OR Shared AI
>            → Connector Transport → Runtime
> ```
>
> The shared endpoint is a RESOURCE consumed through the EXISTING provider
> abstraction — no second provider system, no new transport, no new
> protocol. Phase 1's control plane (entities, policy, eligibility) is
> unchanged; Phase 2 wires the consumer side.

---

## 1. What Was Already There (Phase 1 — CURRENT)

- `ai_endpoints` + `ai_endpoint_share_policies` (SH-AI-1): connector-backed
  shareable endpoints, Private by default, explicit owner sharing act.
- `ai-endpoint-repo.listSharedEndpoints()`: PG-side filters (policy on,
  endpoint on, connector not revoked), stable `created_at ASC, endpoint_id
  ASC` order.
- `ai-connector/shared-pool.js` (SH-AI-2): eligibility ladder + the
  deterministic selector + in-process concurrency slots +
  `resolveSharedAI`/`releaseSharedAI`/`withSharedAI`. Deliberately NOT
  wired into the resolver in Phase 1.
- `ai-connector/transport.js`: non-streaming + streaming chat over the
  connector WS (`connectorChat` / `connectorChatStream`), authoritative
  cloud timer → `chat.cancel`, sanitized codes, session-bound pending
  requests, `failPendingFor` on disconnect.

## 2. The Wired Resolver Chain (SH-AI-3)

`resolveAIForWorkspace(workspaceId, { purpose, model })`
(`workspace-ai-provider.js`) now implements, exactly:

```
1. workspace_ai_providers row   (cloud OR local-ai binding — byte-identical
                                 to pre-sharing behavior; CACHED 30s as before)
2. shared pool                  (NEW — selectSharedAI: full eligibility
                                 ladder, SLOTLESS; NEVER cached — per request)
3. system provider / env        (kill-switch gated — unchanged)
4. fail closed                  ('none' / 'unconfigured' — unchanged)
```

Key semantics:

- **The owner's row always wins.** A configured cloud provider keeps
  resolving exactly as before (same snapshot, same cache discipline). A
  local-ai binding that is offline/revoked still resolves to ITS connector
  and fails closed at the transport step (`Local AI is offline`, AD-12) —
  the pool is NEVER a silent substitution for an explicitly chosen private
  binding (resolver predictability, no-tier-mixing).
- **The shared stage fires only when stage 1 yields nothing**: no row,
  disabled row, or undecryptable credential. Pool failure degrades to the
  next stage — never throws, never blocks resolution.
- **Shared snapshots are never cached.** The pool is capacity, not
  configuration: every request re-runs the eligibility ladder, so a
  revocation depools consumers within ONE request (the security-critical
  direction has no stale window). The complementary direction (empty pool
  → system fallback) caches with the established ≤30s TTL — a stale cache
  can only keep serving a valid tier, never EXTEND sharing.
- `resolveAIForBook` / `resolveAIProvider` pass `purpose`/`model` through
  to the shared selection; `resolveAIProvider`'s purpose tag does not
  re-tag shared snapshots (`transport === 'connector'` is exempt from the
  empty-key fail-closed hint, as private connector snapshots already were).

### 2.1 Eligibility ladder (unchanged from Phase 1, enforced per request)

sharing enabled → endpoint enabled → connector live (registry) → not
revoked → non-owner workspace (D3) → runtime_ok → selected model in the
connector's discovered list (requested → configured → first discovered;
strict) → concurrency slot available. ONE implementation
(`shared-pool.checkEligibility`) serves `resolveSharedAI` (Phase 1,
acquiring) and `selectSharedAI` (Phase 2, slotless).

## 3. Per-Inference Reservation (the slot lifecycle)

A resolve-held slot cannot survive the resolver cache or an agent pipeline
(ONE snapshot, MANY calls). Phase 2 therefore binds capacity to the
INFERENCE, using the existing Phase 1 slot machinery:

```
callAI / resolveChatAI / callAIStream          (transport branches)
  → sharedPool.runSharedInference(snapshot, payload, {timeoutMs, onDelta, signal})
      → reserveSharedInference(snapshot)   — checked acquire (busy → sanitized)
      → transport.connectorChat(...)       — non-streaming OR streaming
      → finally releaseSharedAI(snapshot)  — ALL exits
```

Released on: **success**, **chat.error** (runtime error), **timeout**
(cloud timer → chat.cancel → `timeout`), **cancellation** (consumer
AbortSignal → chat.cancel → `cancelled`), **disconnect**
(`failPendingFor` → `session_closed`), and a **stream that fails after
deltas were already delivered** (adapter mid-stream failure →
`stream_failed`). Every exit settles `connectorChat` and falls through
the same finally — the slot cannot leak. The chat route additionally
aborts a shared inference when the HTTP client disconnects before the
reply (`res.on('close')` → AbortSignal → chat.cancel), so a consumer
that walks away stops burning the owner's slot (test 12b). The Phase 1
in-process limitation is kept (no Redis/global scheduler); a leaked slot
can only make the pool MORE conservative until a restart.

Private connector snapshots ride the SAME `runSharedInference` entry as a
no-op pass-through — the private path behaves exactly as before Phase 2.

## 4. Transport (unchanged, one additive capability)

No new transport, no protocol change. `Cloud → registered connector WS →
local runtime` is the only path (AD-5 intact; `chat.request` carries no
URL; the cloud never fetches the runtime). One additive option:

- `connectorChat(..., { signal })` — consumer-side cancellation. An
  aborted AbortSignal mirrors the §5 timeout path exactly: `chat.cancel`
  downstream, caller settles with sanitized `cancelled`; an
  already-aborted signal never sends a frame. The listener is detached on
  settle (`cleanupEntry`) and in `failPendingFor`.

Streaming is reachable through `ai-service.callAIStream(messages, options,
provider, { onDelta })` — the callAI-shaped streaming seam over the same
snapshot/params contract and the same slot lifecycle (deltas fire per
increment; the terminal frame carries the full content). There is still NO
production SSE chat route (unchanged from the LAC phases); `callAIStream`
is the tested consumer seam a future route uses.

## 5. Sanitized Errors

Shared-specific codes live in `shared-pool.SHARED_MESSAGES`
(`shared_unavailable` — pool empty/invalid selection), mapped by
`describeSharedError` which delegates connector codes to
`transport.describeConnectorError`. Consumers surface fixed sanitized
strings only — never raw runtime detail, URLs or credential material.
The chat route maps `connector_offline`/`shared_unavailable`/`busy` → 503,
`timeout`/`cancelled` → 504, else 502.

## 6. Security (unchanged boundaries, re-verified)

The consumer snapshot is exactly the Phase 1 safe shape: `transport:
'connector'`, `endpoint: null`, `apiKey: null`, plus `shared:
{endpointId, endpointName, ownerWorkspaceId, concurrencyLimit}` (safe,
owner-independent metadata) and the selected model. NEVER present on any
consumer surface: runtime URL, `llmc.*`/`llmcreg.*` credential material,
registration tokens, secrets/hashes, internal connector details. The chat
API response gains only a safe source token (`ai_source`: 'private-local'
| 'shared' | 'cloud' | 'system'); the settings GET gains only
`shared_ai: { available: boolean }` (slotless read-only scan — no names,
no counts, no owner detail). Workspace isolation: no phantom provider rows
for consumers; endpoint management routes stay owner-only with
indistinguishable 404s (Phase 1 discipline, re-tested through the flow).

## 7. UI (minimal, no marketplace)

- `POST /ai/chat` responses carry `ai_source` — the consumer-side source
  badge is API-ready for both clients.
- Web `AIProviderSection` (Settings → AI Provider): when the workspace has
  no provider and the pool is available, a small hint shows the Shared
  fallback (EN/RU i18n) with the honest trust note. No ratings, no search,
  no public profiles, no marketplace of any kind.

## 8. What Is Deliberately NOT In Phase 2

Billing, credits, payments, marketplace, reputation, ratings, public
profiles, anonymous sharing, GPU marketplace, model file transfer,
worker/gpu-hub integration (D9 permanent), load balancing / pool scoring
(deterministic first-eligible), Redis/global scheduler, a second provider
system, `shared_ai_providers` tables, consumer trust interstitial (§7.4 of
the sharing doc — the settings hint is the minimal placeholder), Android
UI mirror, SSE chat route, usage counters/ledger, `expires_at` presets,
`access_mode='users'`.

## 9. Files

- Resolver stage: `backend/src/services/workspace-ai-provider.js`
  (`resolveSharedPoolStage`, `resolveAIForWorkspace`, `resolveAIForBook`)
- Pool seam extensions: `backend/src/services/ai-connector/shared-pool.js`
  (`selectSharedAI`, `reserveSharedInference`, `isSharedSnapshot`,
  `runSharedInference`, `describeSharedError`)
- Transport signal: `backend/src/services/ai-connector/transport.js`
  (`signal` option, `cleanupEntry`)
- Consumer transport branches: `backend/src/services/ai-service.js`
  (`callAIOverConnector` via `runSharedInference` + signal; new
  `callAIStream`), `backend/src/routes/ai-routes.cjs` (`resolveChatAI`
  shared passthrough, chat connector branch via `runSharedInference` with
  disconnect-abort for shared, `ai_source` in responses)
- Settings hint: `backend/src/routes/settings-ai-routes.cjs` (GET provider
  `shared_ai`)
- Web: `frontends/app/src/pages/SettingsPage.tsx` + `app/i18n.ts`
- Tests: `backend/tests/ai-shared-inference.test.js` (23 cases),
  `backend/tests/ai-model-propagation.test.js` (14 cases — the model
  propagation regression suite)
- This document.

## 10. Known Limitations (accepted for Phase 2)

- **In-process concurrency** — slots live in one backend process (Phase 1
  limitation kept by design); horizontal scaling is a later phase.
- **No consumer trust interstitial** — the sharing doc §7.4 warning flow
  arrives with the consumer-facing UX phase; the settings hint carries the
  minimal honest note.
- **Empty-pool → system fallback caches ≤30s** — a newly shared endpoint
  becomes visible to a no-provider consumer within one TTL (established
  resolver discipline; revocation remains immediate).
- **`checkAIHealth` treats shared snapshots as "not alive"** — the
  vbook/availability counter reports 0 for no-provider workspaces served
  by the pool (health probing over a stranger's endpoint is deliberately
  not done; AD-7 discipline).
- **Model continuity is strict** — a shared selection's model is requested
  at inference time; if it disappears from every discovered list mid-flow,
  the consumer gets `shared_unavailable` rather than a silent model switch
  (no-tier/model-mixing rule).
- **Streaming has no production route yet** — `callAIStream` is the tested
  seam; the SSE chat route remains deferred (LAC Phase 5 note unchanged).
