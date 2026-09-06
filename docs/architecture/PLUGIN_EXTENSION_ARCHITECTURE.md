# Animastor — Plugin / Extension Architecture

**Status:** Architectural Direction (design, nothing implemented)
**Date:** 2026-09-06
**Parent:** `MODULAR_PRODUCT_ARCHITECTURE.md` §25 (Part II). Terminology (L0–L5 levels, contracts C1–C14, host = `backend`) is defined there and not repeated here.

---

## 1. Goal

Animastor must be able to grow as a **platform**: independent modules that extend the system without changing Core internals. A third-party developer should be able to build, e.g.:

- `@someone/animastor-seedance` — a video-generation provider;
- a ComfyUI-flavored worker variant;
- a worker for an external API (RunPod-style GPU clouds);
- an image / audio provider;
- a storage connector;
- an import/export module (EPUB, PDF, DOCX);
- future editor or player extensions.

…without a fork, a patch, or any knowledge of `backend/src` internals — only against published Animastor contracts.

**Non-goal today:** building the marketplace, hot-loading, or a public SDK release. This document defines *how we must build so that this becomes possible* — the missing contracts (C12–C14) and the security/governance model.

---

## 2. First Principles

Derived from what already works in this codebase:

1. **Out-of-process by default.** The three proven extension points today (LAC connector, GPU worker, GPU Hub itself) are all separate processes speaking a versioned protocol. This is the house style: isolation, crash safety, language freedom, independent deployment.
2. **Fail-closed negotiation.** Every protocol handshake carries `protocol_version`; an unsupported version is rejected explicitly (LAC `hello`, worker v2). No silent degradation.
3. **Credentials are minted, never shared.** The host issues scoped, revocable credentials (`llmc.*` for LAC, `wrk.*` for workers); the plugin never sees database credentials, Redis, service secrets, or user data beyond its capability scope.
4. **The host owns the port.** A plugin never opens a connection *into* the host's internals; it either connects outbound to a documented endpoint, or is called through a host-managed dispatch (see §5).
5. **Capabilities are allowlisted.** A plugin can do only what its manifest declares and the operator grants. Unknown = denied.
6. **Contracts before plugins.** No third-party ecosystem is invited until C12/C13/C14 exist and are pinned by contract tests (parent doc §24, §30).

---

## 3. Extension Points (Current & Planned)

| Extension point | Status | Contract | Integration model | Examples |
|---|---|---|---|---|
| **Local LLM runtime** | **exists** | C3 (LAC v1) | plugin connects outbound WS to host | `animastor-ai-connector` |
| **GPU worker** | **exists** | C4 + C5 (+C11 delivery) | plugin polls hub, reports results | `animastor-worker` (ComfyUI) |
| **Compute transport** | **exists** | C5 + C6 | separate service | `gpu-hub` |
| **Media generation provider** (image/video/audio) | planned (Phase 12–13) | **C12 — missing** | provider plugin behind Provider Gateway | Seedance, cloud video APIs, TTS providers |
| **Parser / importer** | planned (Phase 13) | **C13 — missing** | host-invoked, sandboxed or out-of-process | EPUB/PDF/DOCX importers |
| **Storage connector** | planned | future C15 | out-of-process, credential-scoped | S3-compatible artifact stores |
| **Exporter / publisher** | planned | future | consumes C1 (VBook bundle) | format converters |
| **Editor/Player UI extensions** | far future | future C1x | out-of-process service + host-rendered | community viewers |

Key structural fact: the **Provider Gateway** (C8) is the natural in-host landing zone for C12 providers, and the **Job envelope with `payload.meta`** (Phase 12) is the landing zone for exotic workers. Both must exist before C12 plugin work starts.

---

## 4. Plugin Manifest & Capabilities (C14)

Every installable plugin ships a **manifest** (JSON, schema-versioned). Draft shape:

```jsonc
{
  "manifest_version": 1,
  "id": "someone.animastor-seedance",        // reverse-DNS, immutable
  "name": "Seedance Video Provider",
  "version": "1.2.0",                        // package semver
  "contracts": { "media_provider": "1" },    // implemented contract versions (C12)
  "kind": "media_provider",                  // media_provider | parser | worker | connector | ...
  "capabilities": [                          // requested, granted by operator (§7)
    "network.outbound:api.seedance.example",
    "secrets:seedance_api_key"
  ],
  "delivery": { "mode": "npm", "package": "@someone/animastor-seedance" },
  "runtime": { "node": ">=18", "process": "detached" }
}
```

Rules:

- The manifest is **declarative** — capabilities cannot be requested at runtime.
- `contracts` names the contract versions the plugin implements; the host refuses mismatches at registration (fail-closed).
- Manifest schema (C14) lives in `@animastor/contracts` with its own contract tests.

**Capability vocabulary (draft):**

| Capability | Grants | Never includes |
|---|---|---|
| `network.outbound:<scope>` | outbound HTTP/WS to the named scope | inbound listeners, host-internal network |
| `secrets:<name>` | a named credential injected at runtime by the host | reading the host's own secrets, other plugins' credentials |
| `job.consume:<type>` | receiving jobs of a job type from the hub | direct Redis access |
| `model.ingest:<format>` | registering a parser for a source format | direct FS access to books/artifacts |
| `storage.artifacts` | artifact get/put through the storage port | raw FS paths, PG access |

---

## 5. Integration Models

| Model | When | Trust tier | Notes |
|---|---|---|---|
| **T1 — Out-of-process (default)** | all providers, workers, connectors | plugins are separate OS processes / containers | crash- and security-isolated; speak C3/C4/C12/C13 over the wire. Host↔plugin auth via minted credentials. This is the LAC/worker pattern |
| **T2 — In-process (official only)** | narrowly scoped host extensions inside our own monorepo | official code, reviewed like Core | allowed **only** through explicit ports (interfaces), never via DI-bag reach-ins, never with direct PG/Redis handles. No third-party in-process loading **ever** (no `require()` of arbitrary npm code in the host process: supply-chain + crash + data-exfiltration risk) |
| **T3 — Sidecar service** | heavy/long-running modules (model servers, render farms) | like T1, own container | registered like workers |

Explicitly forbidden for all plugins (T1–T3), enforced by architecture, not policy:

- direct PG/SQL or Redis access (no credentials exist for them);
- reading host env/filesystem (no shared volumes; the host passes scoped artifacts);
- calling internal host routes not covered by a published contract;
- spawning inbound listeners assumed reachable by the host (host dials out or proxies);
- mutating another plugin's jobs, artifacts, or credentials;
- silent capability use: an undeclared network call is a revocation offense.

---

## 6. Plugin Lifecycle

```
package on npm
   │ operator installs (or ships with deployment)
   ▼
manifest registration (admin surface, Phase 13)
   │ host validates manifest + contract versions + capabilities
   ▼
operator grants/edits capabilities (per workspace or global)
   ▼
host mints scoped credential (llmc.*/wrk.*-style, TTL or revocable)
   ▼
plugin runs (outbound connect / job polling / hosted invocation)
   │ heartbeats, health, usage metering
   ▼
disable / revoke credential / uninstall
   (revocation is immediate: credential refused at next handshake)
```

- **Registration is admin-gated** (the existing `requireAdmin` surface is the seed of the future plugin admin UI).
- **Credentials are per-plugin and per-capability**; a leaked credential can be revoked without touching others.
- **Updates are operator-driven**: npm version pinning; the host records the manifest it approved, and a changed manifest re-enters approval.

---

## 7. Security Model

| Threat | Mitigation |
|---|---|
| Malicious / buggy plugin crashes Core | T1 isolation: process/container boundary; resource limits; hub timeouts |
| Data exfiltration (book content, credentials) | capability-scoped secrets; no DB/Redis credentials exist in plugin context; outbound network allowlisting per capability; artifacts passed via scoped handles |
| Supply-chain (npm) | operator approval at install; version pinning; no in-process loading of third-party code (T2 rule); provenance checks when CI exists |
| Privilege creep | manifest is declarative; grants are explicit; unknown capability = denied; grants auditable |
| Stale/rogue plugin after revocation | minted credentials fail-closed at handshake; queue/dispatch identity checks reject foreign callbacks (existing dispatch-identity pattern) |
| Prompt/content injection via providers | provider responses validated against the contract (limits, error allowlists, size caps — the LAC validation-seam pattern) |
| Plugin sees other users' data | workspace-scoped credentials and dispatch metadata (envelope `policy_id`/`workspace_id` routing already exists in the job protocol) |

Security review process: the Phase 8E static security pass (credentials in logs, secrets in errors, fail-closed validation seams, no fs/net/shell coupling) becomes the **acceptance checklist for every new official plugin and for community plugins at curation time**.

---

## 8. What We Will NOT Do

- No dynamic in-process plugin loading (`require(plugin)` from the host) — permanently rejected.
- No plugin access to shared Redis/PG "for convenience" — the job protocol and contracts exist precisely to avoid this.
- No capability bypasses via debug/admin routes — admin surface is capability-gated too.
- No plugin marketplace/registry before C12–C14 are stable and at least two official out-of-process plugins exist (dogfooding rule).

---

## 9. Relationship to the Roadmap

This document defines the *target*; parent doc §30 sequences it:

- **Phase 12** (compute contract completion) — enables C12 for workers/providers.
- **Phase 13** — C12 + C13 + C14 defined, host ports implemented, **first official out-of-process plugin** validated (RunPod adapter or a Seedance-style provider, built strictly against the contracts).
- **Phase 14+** — community onboarding: published SDK docs (generated from `@animastor/contracts`), plugin template repository (`create-animastor-plugin`), curation process.

Success criterion (echo of parent §18): a developer who has never read `backend/src` can implement `@someone/animastor-seedance` against the published C12+C14 specs, and it works — without any change to Core.
