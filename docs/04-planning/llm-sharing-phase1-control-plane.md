# LLM Sharing — Phase 1: Control Plane

> 2026-09-03 · Implementation-planning document for the FIRST production
> phase of LLM sharing. Companions (authorities):
> `llm-agent-resource-sharing-model.md` (the sharing design — its §6.2
> resolver-stage ladder, §6.3 invariants, §15 roadmap) and
> `local-ai-connector-v1.md` (the connector this phase builds on — §3.1
> Connector ≠ Provider, §8 schema, §14 the sharing bridge, §17 AD register).
>
> Core idea realized here:
>
> ```
> Local AI Connector → Shareable Inference Endpoint → Share Policy
>   → Pool Resolver → Consumer
> ```
>
> The shareable resource is the **inference endpoint / serving capacity** of
> a registered connector — NOT the model file, NOT a bare GPU, NOT the
> agent (sharing doc §5/§7).

---

## 1. What Exists Before This Phase (CURRENT — facts)

- **Local AI Connector V1** (Phases 1–7, shipped): `ai_connectors` rows
  (hash-only `llmc.*`/`llmcreg.*` credentials, AD-1), the backend WS
  terminator `/api/v1/ai-connector/ws` (hello/heartbeat/models/chat
  frames, §4), the in-process live-session **registry** (authoritative
  liveness), discovery (explicit refresh only, AD-7), inference transport
  `ai-connector/transport.js` (chat.request/response/delta/error/cancel,
  at-most-once, §4/§5), and the provider binding
  (`workspace_ai_providers.provider_type='local-ai'` + `connector_id`,
  LAC-2).
- **Private-only by design**: every connector is usable ONLY by its owning
  workspace (AD-10). There is no sharing state, no endpoint registry, no
  pool resolver.
- **Resolver seam**: `resolveAIProvider(workspaceId, purpose)` → workspace
  row (cloud or local-ai connector snapshot) → gated system fallback →
  fail-closed. The sharing doc §6.2 reserves "shared pool" as stage 2.

**Discrepancy audit (task brief §1):** the planning docs' older sketches
(policy on `workspace_ai_providers`, `ai_share_policies` keyed by
`workspace_id`) predate the connector. Production truth: the shareable
resource is **connector-backed**; the endpoint entity therefore references
`ai_connectors` (the sharing doc §15-V2 `ai_endpoints` shape, realized on
the connector seam). Production code is the source of truth for
integration; this phase follows it.

## 2. Entities (SH-AI-1 migration)

Two additive tables; no existing column changes; no destructive step.

```
ai_endpoints
  endpoint_id     UUID PK
  workspace_id    UUID NOT NULL → workspaces ON DELETE CASCADE   (owner)
  connector_id    UUID NOT NULL → ai_connectors ON DELETE CASCADE (transport)
  name            TEXT
  runtime_type    TEXT CHECK ('ollama','vllm','llamacpp','lmstudio','openai-compatible')
  model           TEXT            — free string (no-registry principle, §6.3.5)
  description     TEXT
  enabled         BOOLEAN DEFAULT TRUE  — owner availability switch
  deleted_at      BIGINT          — soft delete
  created_by      UUID → users
  created_at / updated_at  BIGINT

ai_endpoint_share_policies
  policy_id       UUID PK
  endpoint_id     UUID NOT NULL → ai_endpoints ON DELETE CASCADE
  workspace_id    UUID NOT NULL → workspaces ON DELETE CASCADE
  enabled         BOOLEAN DEFAULT FALSE  — FALSE = Private (the default)
  access_mode     TEXT CHECK ('public')   — V1: public only
  concurrency_limit INTEGER DEFAULT 1 CHECK (1..8)
  request_limit   BIGINT NULL   — optional, NOT enforced in V1 (metadata)
  token_limit     BIGINT NULL   — optional, NOT enforced in V1 (metadata)
  revoked_at      BIGINT NULL   — revoke frees the one-live-policy slot
  created_by      UUID → users
  created_at / updated_at  BIGINT

UNIQUE (endpoint_id) WHERE revoked_at IS NULL   — one live policy per endpoint
```

**`ai_endpoints` NEVER stores:** plaintext credentials, runtime URL, API
keys, GPU secrets, model files, filesystem paths. There is nothing secret
on the row by construction — the connector (`ai_connectors`) remains the
ONLY transport to the local machine.

**Relationship:** `ai_endpoints.connector_id → ai_connectors.id` with
`ON DELETE CASCADE` — a connector's deletion (workspace cascade) removes
its endpoints; an endpoint never outlives its connector. `workspace_id` is
denormalized onto both rows for the same workspace-scoped SQL guards used
everywhere else.

**One policy per endpoint (1:1):** enable/disable flips the SAME row.
Private → Shared → Private is a state transition, never a new access path
(worker `share_policies` D1 discipline).

## 3. Lifecycle

```
connector private
      ↓ create endpoint (POST /api/v1/ai-endpoints — explicit owner act)
endpoint private (default; policy row exists, enabled=FALSE)
      ↓ enable sharing (POST …/:id/share, confirm_share=true)
endpoint shared
      ↓ connector online/offline
endpoint availability follows connector   (registry live WS session — authoritative)
      ↓ disable sharing (DELETE …/:id/share)
endpoint private
```

The five lifecycle states are DELIBERATELY separate and never collapsed:

| State | Where it lives |
|---|---|
| endpoint exists | the `ai_endpoints` row (soft-deleted → gone) |
| sharing enabled | `policy.enabled` (Private/Shared) |
| connector live | in-process WS registry `isLive()` — never stored on the endpoint |
| runtime reachable | connector heartbeat `runtime_ok` (discovery/honest) |
| models discovered | connector `models[]` (discovered ≠ loaded, LAC §7) |

The **live WS session remains authoritative** for connector availability
(LAC §7 unchanged); the endpoint's availability is DERIVED at read time,
never persisted.

## 4. Security Boundary (unchanged by sharing)

Sharing does NOT mean "cloud → arbitrary localhost" and does NOT widen any
existing connector boundary. Always:

```
Cloud → registered connector WS → local runtime
```

Forbidden (and structurally impossible in this phase):
- arbitrary URL — no URL field exists on ANY endpoint API/route/frame;
- SSRF — the cloud still never fetches a connector's runtime;
- universal proxy — chat.request carries no URL (AD-5);
- filesystem / shell / arbitrary runtime path — not in the protocol;
- credential forwarding — `llmc.*`/`llmcreg.*` never appear in endpoint
  rows, responses, or the consumer path;
- registration-token disclosure — one-time disclosure path untouched.

The consumer never learns the owner's runtime URL, local IP, or any
credential; the resolver snapshot carries `endpoint:null, apiKey:null`.

Workspace isolation:
- endpoints are created/updated/shared/deleted ONLY by the owner workspace;
- foreign workspaces receive one **indistinguishable 404** on every route
  (no existence oracle, no private-endpoint visibility);
- no route exposes connector credentials or another workspace's data.

## 5. Share Policy (V1)

- `enabled` — Private (default) ↔ Shared. Enable requires explicit
  `confirm_share=true` (worker share precedent — never accidental).
- `access_mode='public'` — CHECK-enforced; V2 widens (worker SH-2 pattern).
- `concurrency_limit` 1..8 (default 1) — enforced by the pool seam as an
  in-process gate.
- `request_limit`/`token_limit` — optional owner-declared metadata; NOT
  enforced in V1 (no counters exist — deliberately deferred with the
  ledger).
- **Not in V1 (by explicit decision):** billing, credits, payments,
  cost_risk declarations, expiry presets, marketplace anything.

Disable resets concurrency to the default baseline. Owner traffic never
traverses the pool (D3) — the owner resolves through their own provider
binding exactly as before.

## 6. Pool Resolver Seam (SH-AI-2)

`backend/src/services/ai-connector/shared-pool.js`:

```
resolveSharedAI({ workspaceId, purpose, model })
        ↓ eligible shared endpoints     (repo.listSharedEndpoints)
        ↓ availability / policy filtering (shared-pool.checkEligibility)
        ↓ selected endpoint             (selectEndpoint — deterministic)
        ↓ connector transport           (existing ai-connector/transport)
```

Eligibility (the brief's minimum, all required):
1. sharing enabled (policy, repo filter);
2. endpoint enabled (repo filter);
3. connector live (registry `isLive` — authoritative);
4. connector not revoked (repo filter);
5. workspace eligibility — any authenticated workspace EXCEPT the owner's
   own (D3);
6. runtime reachable (`runtime_ok`, unknown → unreachable);
7. a usable model exists (requested → configured → first discovered);
8. concurrency available (in-process slots vs `concurrency_limit`).

**Selection:** deterministic "first eligible" ordered by
`created_at ASC, endpoint_id ASC` — stable, repeatable, replaceable. NO
load balancing, NO scoring. `selectEndpoint` is one function so a future
pool scheduler drops in without touching Connector/Provider architecture.

**Consumer contract — no second provider system:** the returned snapshot
is the SAME connector snapshot shape the private path produces
(`transport:'connector'`, `endpoint:null`, `apiKey:null`) plus a `shared`
marker and the chosen model — `callAI` / `resolveChatAI` / the agent
pipeline consume it with ZERO changes:

```
workspace_ai_providers → resolver → private local connector OR shared
endpoint → SAME connector transport
```

The consumer does not know (and cannot learn) whether a resource is a
cloud provider, a private connector or a shared connector.

**Phase 1 does NOT wire the pool into `resolveAIForWorkspace` yet** — the
seam exists and is fully tested; the consumer-side fallback chain wiring
is the next phase (deliberate, keeps this phase reviewable and the
existing resolver byte-identical).

## 7. API (workspace-owner surface)

```
POST   /api/v1/ai-endpoints                   — create (Private default)
GET    /api/v1/ai-endpoints                   — list own
GET    /api/v1/ai-endpoints/:id               — own detail
PATCH  /api/v1/ai-endpoints/:id               — name/model/description/enabled
DELETE /api/v1/ai-endpoints/:id               — soft delete
POST   /api/v1/ai-endpoints/:id/share         — enable (confirm_share:true)
DELETE /api/v1/ai-endpoints/:id/share         — disable
```

- Users only (guests 401/403 — a guest workspace must never own shareable
  resources); `workspace_id` always from `req.workspace`, never the body.
- Sharing state is a separate resource pair (POST/DELETE share) — the
  generic PATCH can never silently flip it.
- Foreign/unknown/revoked/deleted → one indistinct 404.
- Responses NEVER contain: credentials, registration tokens, runtime URLs,
  internal connector secrets (`token_prefix` included), local network
  detail.

Consumer-side shared discovery API — deliberately later phase.

## 8. Web UI (minimal — no marketplace)

In `/settings/local-ai` each connector card gains a **"Share this AI"**
block: endpoint rows with a badge cycling Private / Shared / Offline /
Runtime unavailable (availability outranks sharing state), the endpoint
name, runtime, discovered-models count, concurrency limit, enable/stop
sharing (explicit confirm modal), delete, and create-endpoint. NEVER
shown: credentials, local IP, runtime URL, filesystem info. Android stays
backend-ready (control plane is API-complete); the Android mirror is a
follow-up step.

## 9. Migration Safety (verified by tests)

- Additive only: two new tables, zero existing-column changes; fresh and
  long-lived DBs migrate identically.
- After deploy: every existing connector stays private (no endpoint rows
  are created for them — an endpoint is an explicit owner act); existing
  `workspace_ai_providers` keep working (local-ai binding resolves the
  same connector snapshot); existing Local AI flow byte-identical; sharing
  auto-enables nothing (default Private, flag-free design).
- Rollback = drop the two tables; nothing else references them.

## 10. What Is In Phase 1

Entities + migration; owner API (CRUD + sharing state); share policy V1;
pool resolver seam with deterministic selection and all eligibility
filters; concurrency gate; minimal Web owner UI; full test coverage
(ownership, sharing, connector state, security non-disclosure, resolver,
regression/migration safety).

## 11. What Is Deliberately NOT In Phase 1

Billing, credits, payments, marketplace, reputation, community ratings,
public profiles, complex load balancing / pool scheduling, capability-aware
routing, GPU marketplace, model marketplace, model file transfer,
automatic sharing, anonymous/guest access, public Internet exposure,
worker/gpu-hub integration (D9 permanent), consumer-side pool fallback
wiring in `resolveAIForWorkspace`, consumer trust warnings (§7.4 of the
sharing doc — arrives with consumer-side wiring), usage ledger/counters,
`expires_at` presets, `access_mode='users'`, Android UI. Each is a later
phase (sharing doc §15 ladder).

## 12. Files

- Migration: `backend/src/storage/postgres/schema.js` (SH-AI-1)
- Repo: `backend/src/storage/postgres/repositories/ai-endpoint-repo.js`
- Resolver seam: `backend/src/services/ai-connector/shared-pool.js`
- Routes: `backend/src/routes/ai-endpoint-routes.cjs` (+ `backend.cjs` wire)
- Tests: `backend/tests/ai-endpoint-sharing.test.js`
- Web: `frontends/app/src/features/localAi/localAi.ts` (+ `LocalAISection.tsx`,
  `localAi.test.ts`, `app/i18n.ts`)
- This document.
