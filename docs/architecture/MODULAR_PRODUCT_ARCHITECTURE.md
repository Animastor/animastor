# Animastor — Modular Product Architecture

**Status:** Architectural Direction (unified concept)
**Date:** 2026-09-02
**Last updated:** 2026-09-06 — §20–§30 appended (levels of modularity, package/npm architecture, versioning & release, contract registry, plugin architecture direction, governance & parallel development, current-state assessment, transition plan). §1–§19 unchanged.

**Document tree of this concept:**

| Document | Role |
|---|---|
| `MODULAR_PRODUCT_ARCHITECTURE.md` (this file) | The concept: goals, module principles, levels of modularity, package architecture, versioning, governance, transition plan |
| `PLUGIN_EXTENSION_ARCHITECTURE.md` | Child doc: plugin/extension architecture in depth (extension points, manifest, lifecycle, security model) |
| `MODULAR_PRODUCT_ARCHITECTURE_RECONNAISSANCE*.md`, `_FINAL_REVIEW.md` | Measured audits (historical, point-in-time) |
| `PHASE_1..8F_*.md` | Execution reports of the migration roadmap (§5 of the Final Review) |

---

## 1. Purpose

Animastor should gradually evolve toward a modular architecture in which major logical capabilities are designed as independent modules.

A module should not merely be a folder or a collection of files.

A well-designed Animastor module should represent a coherent capability with:

- a clear responsibility;
- a defined public interface;
- minimal knowledge of internal implementation of other modules;
- its own tests;
- its own domain logic;
- controlled dependencies;
- the potential to be extracted into an independent product in the future.

**Core principle**

> «Every major module should be designed so that it could eventually become an independent product without requiring a fundamental rewrite.»

This does not mean that every module must immediately become a separate service, package, repository, or Docker container.

The initial goal is **logical modularity**, not microservices.

---

## 2. Why This Architecture

Animastor is gradually accumulating multiple substantial capabilities:

- books and book processing;
- visual book format;
- parsing and analysis;
- generation;
- AI provider integrations;
- ComfyUI integration;
- GPU orchestration;
- workers;
- player;
- editor;
- navigation;
- caching;
- future local AI/model infrastructure.

Keeping all of these capabilities tightly coupled inside one backend will gradually increase architectural complexity.

Instead, Animastor should grow as a collection of cooperating modules.

The backend may remain a **modular monolith** for a long time.

The important distinction is:

```
Modular monolith  ≠  Monolithic architecture
```

A modular monolith can later be split into independent services or products when there is a real reason to do so.

---

## 3. Module Extraction Principle

Every significant module should answer four questions:

### 3.1 What does this module own?

The module should have a clearly defined area of responsibility.

### 3.2 What does the outside world need from it?

The module should expose a small public interface.

### 3.3 What should remain private?

Internal implementation details should not become dependencies of other modules.

### 3.4 Could it be extracted?

If the module were moved into another repository, what would be required?

The goal is to progressively reduce that list.

---

## 4. Target Architectural Map

The target architecture is approximately:

```
                         ┌─────────────────────┐
                         │      Animastor      │
                         │        Core         │
                         └──────────┬──────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
      Book Domain              Generation               Projects
          │                         │
    ┌─────┴─────┐           ┌───────┴────────┐
    ▼           ▼           ▼                ▼
 Parser       VBook      Providers       Compute
    │           │           │                │
    │           │      ┌────┼────┐            ▼
    │           │      ▼    ▼    ▼         GPU Hub
    │           │   API   Local  ...          │
    │           │                          Workers
    │           │
    └──────┬────┘
           ▼
      Book Model
           │
      ┌────┼─────────────┐
      ▼    ▼             ▼
   Player Editor      Navigator
```

The exact boundaries may evolve.

The important part is that each major capability has a recognizable architectural identity.

---

## 5. Candidate Independent Modules

### 5.1 VBook

The VBook format should eventually be treated as a first-class format module.

**Potential future product:** Animastor VBook

**Responsibilities:**

- VBook format specification;
- versioning;
- manifest;
- validation;
- serialization;
- deserialization;
- asset references;
- compatibility;
- migration between VBook versions;
- runtime representation.

The VBook module should not depend on the Animastor web application.

**Potential future usage:**

```
.vbook
   │
   ▼
VBook Runtime
   │
   ├── Web
   ├── Android
   ├── Desktop
   └── Third-party applications
```

---

## 6. Player

The Player is a strong candidate for future extraction.

**Potential future product:** Animastor Player

The Player should consume a canonical book/runtime representation rather than directly depending on backend implementation details.

**Conceptually:**

```
VBook / Book Model
        │
        ▼
   Book Runtime
        │
        ▼
      Player
        │
        ├── Web renderer
        ├── Android renderer
        └── Desktop renderer
```

The Player should ideally be capable of operating locally.

A future user could potentially download a `.vbook` and open it directly without requiring the full Animastor backend.

---

## 7. Editor

The Editor should become a distinct logical module.

**Potential future product:** Animastor Editor

The Editor operates on a canonical book/project model.

It should not need to understand how the backend stores database records internally.

**Conceptually:**

```
Book Model
    │
    ▼
Editor Engine
    ├── scenes
    ├── characters
    ├── timeline
    ├── assets
    ├── audio
    └── metadata
    │
    ▼
VBook / Project Export
```

This creates the possibility of eventually providing the editor independently from the main Animastor application.

---

## 8. Parser / Import System

Parsing should be considered separate from the VBook format.

A parser converts an external source into a canonical Animastor Book Model.

**Potential inputs:**

- EPUB
- PDF
- DOCX
- TXT
- HTML
- Web content
- Other formats

**Conceptually:**

```
External Format
       │
       ▼
    Parser
       │
       ▼
Canonical Book Model
       │
       ├── analysis
       ├── structure
       ├── characters
       ├── scenes
       └── generation
```

Then:

```
Canonical Book Model
       │
       ▼
VBook Exporter
       │
       ▼
.vbook
```

This separation is important.

**Parser ≠ VBook.**

Parser understands how to import something.

VBook understands how to store and distribute the Animastor visual-book representation.

---

## 9. Generation

Generation should gradually become a provider-independent module.

**Conceptually:**

```
Generation API
      │
      ▼
Provider Gateway
      │
 ┌────┼───────────────┐
 ▼    ▼               ▼
ComfyUI  Paid APIs   Local Models
```

The generation domain should not be tightly coupled to a specific provider.

This allows Animastor to add:

- cloud providers;
- ComfyUI;
- user-provided API keys;
- local models;
- shared models;
- future providers.

without redesigning the generation domain.

---

## 10. Compute / GPU Hub

GPU Hub is already an important architectural boundary.

It should remain an independent infrastructure component.

**Conceptually:**

```
Generation / Jobs
       │
       ▼
   Compute API
       │
       ▼
    GPU Hub
       │
 ┌─────┼────────────┐
 ▼     ▼            ▼
Worker Worker      Worker
```

GPU Hub should own:

- worker registration;
- worker availability;
- task dispatch;
- queues;
- scheduling;
- worker health;
- worker capabilities;
- shared/private worker routing.

The business logic of a generated artifact should not be embedded into GPU Hub.

GPU Hub should primarily answer:

> «Where and how should this compute task execute?»

---

## 11. Worker

Workers should be treated as independently deployable compute agents.

**Potential future product:** Animastor Worker

A worker should know how to:

- connect to GPU Hub;
- advertise capabilities;
- receive jobs;
- execute jobs;
- report progress;
- return results;
- maintain its local runtime.

It should not need the complete Animastor application.

This is especially important for:

- private user GPUs;
- shared workers;
- future worker marketplace;
- local installations;
- distributed compute.

---

## 12. Provider Gateway

External AI APIs should be behind a provider abstraction.

**Examples:**

- OpenAI
- OpenRouter
- Other paid APIs
- ComfyUI
- Local LLM
- Future providers

**Conceptually:**

```
Application
     │
     ▼
Provider Gateway
     │
 ┌───┼────┬────────┐
 ▼   ▼    ▼        ▼
API Local ComfyUI  ...
```

The application should request a capability rather than directly depending on a provider implementation.

For example:

```js
generateText(...)
generateImage(...)
generateAudio(...)
```

rather than:

```js
callOpenRouter(...)
callComfy(...)
```

in arbitrary business logic.

---

## 13. Player, Editor and VBook Relationship

These three modules should be particularly clean.

```
              Canonical Book Model
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
          Editor              Player
             │                   │
             ▼                   │
           VBook ◄───────────────┘
```

**Possible long-term ecosystem:**

```
Animastor VBook
       │
       ├── Animastor Player
       ├── Animastor Editor
       ├── Animastor Parser
       └── Third-party ecosystem
```

This could eventually become an ecosystem rather than merely an internal implementation detail.

---

## 14. Modular Monolith First

The immediate architectural strategy is not to split Animastor into many microservices.

Instead:

**Current:**

```
backend
 ├── book
 ├── auth
 ├── generation
 ├── services
 └── ...
```

**Target:**

```
backend
 ├── core
 └── modules
      ├── book
      ├── parser
      ├── vbook
      ├── generation
      ├── providers
      └── ...
```

These modules may initially run in the same process.

Only later, when justified by:

- scale;
- deployment requirements;
- independent release cycles;
- resource isolation;
- external reuse;
- performance;
- organizational boundaries;

should a module become a separate service or product.

---

## 15. Rules for New Development

When adding substantial new functionality, developers should ask:

### Rule 1 — Is this a new capability?

If yes, consider creating a module boundary rather than adding more code to an existing generic service.

### Rule 2 — Does this module have a clear owner?

A module should have an obvious responsibility.

### Rule 3 — Can another module use it through an interface?

Prefer public APIs/interfaces over direct access to internal implementation.

### Rule 4 — Avoid reverse dependencies

A low-level module should not unexpectedly depend on the entire application.

### Rule 5 — Do not leak database structures

Other modules should preferably consume domain objects/interfaces rather than raw database implementation details.

### Rule 6 — Keep extraction in mind

When implementing a module, ask:

> «If we wanted to extract this into a separate repository in two years, what would prevent us?»

Avoid creating those dependencies unnecessarily.

---

## 16. What This Document Does NOT Require

This document does not require:

- immediate refactoring;
- moving existing files;
- creating microservices;
- creating new Docker containers;
- splitting repositories;
- changing production behavior;
- rewriting working code.

It is an **architectural direction**.

Existing code should be migrated gradually and opportunistically.

---

## 17. Gradual Migration Strategy

Migration should happen when code is already being modified.

**Preferred approach:**

```
New feature
    │
    ▼
Identify logical module
    │
    ▼
Define boundary
    │
    ▼
Implement new code inside boundary
    │
    ▼
Gradually move related old code
    │
    ▼
Reduce dependencies
```

Avoid large "big bang" architectural migrations.

A module becomes cleaner over time.

---

## 18. Definition of Architectural Success

Animastor does not need to become a collection of dozens of services.

Success means that major capabilities become logically independent enough that:

- Animastor Player
- Animastor Editor
- Animastor VBook
- Animastor Parser
- Animastor Worker
- Animastor GPU Hub

could potentially exist as independent products or packages if the future business direction requires it.

The architecture should make this possible **without requiring a rewrite**.

---

## 19. Guiding Principle

> «Build Animastor as an ecosystem of capabilities, not as one ever-growing application.»

Keep the deployment simple.

Keep the backend practical.

Keep working code working.

But when new capabilities are created, give them boundaries.

Over time, those boundaries become the architecture.

---
---

# Part II — From Logical Modules to npm Packages

*(Added 2026-09-06. Extends §1–§19; does not replace them. Grounded in the executed Phase 1–8 roadmap and the Phase 7 extraction-readiness audit.)*

## 20. Where We Are (Status 2026-09-06)

The direction of §1–§19 has been executed for three contours and is frozen by guard tests for the rest:

| Milestone | State | Evidence |
|---|---|---|
| Phase 1 — guardrails (SQL boundary, Redis ownership, hub/protocol/chat contracts frozen) | done | `PHASE_1_GUARDRAILS.md`, `backend/tests/architecture/*` |
| Phase 2 — VBook runtime + LAC/Worker/Hub boundary contracts | done | `PHASE_2_CONTRACTS.md` |
| Phase 3 — Provider Gateway facade (resolve/agent/chat/generation) | done | `PHASE_3_PROVIDER_GATEWAY.md` |
| Phase 4 — Canonical Book Model facade (`loadBook(id,{mode})`, manifest identity) | done | `PHASE_4_BOOK_MODEL.md` |
| Phase 5 — orchestration↔runtime cycle broken via Runtime Result Contract seam | done (residual debt pinned) | `PHASE_5_ORCHESTRATION_RUNTIME.md` |
| Phase 6 — Player/Editor facades over Book Model | done (contours still coupled) | `PHASE_6_EDITOR_PLAYER.md` |
| Phase 7 — extraction-readiness audit + guards P7-T1..T8 | done | `PHASE_7_EXTRACTION_READINESS.md` |
| Phase 8 — Local AI Connector extracted to standalone package `ai-connector/` (`animastor-ai-connector@0.1.0`, SPEC, own tests, MIT) | done; npm publish **blocked only on npm auth** | `PHASE_8*_*.md` (recon, design, verification, post-extraction audit, release readiness, 8F report) |

Current repository packaging state (measured):

- **No root `package.json`, no npm workspaces yet.** Each package is directory-isolated with its own `package.json`: `ai-connector` (`animastor-ai-connector@0.1.0`), `worker/worker` (`animastor-worker@2.0.0`), `gpu-hub` (`gpu-hub@0.1.0` — unscoped generic name, see §22.2), `backend` (`animastor-backend@0.1.0`, host — must never be published), `frontends/app` (`animastor-app`, private).
- **No CI** (no `.github/`): all guardrails run locally via `cd backend && npm run test:arch`.
- Cross-package isolation is currently **structural** (zero inbound/outbound requires for LAC, worker, hub — pinned by guards), not yet **npm-level** (no workspace linking, no published artifacts).

The remaining direction — npm packages, workspaces, independent versioning and a plugin ecosystem — is specified in §21–§30 below.

---

## 21. Levels of Modularity

Modularity is a ladder, not a binary. Every functional block sits on a level and moves up one step at a time. A block must satisfy the §26 module checklist before moving from L1 to L2+.

```
L5  Standalone products / services        (independent distribution & lifecycle)
L4  Community / third-party modules       (implemented by outsiders, against L2 contracts)
L3  Official modules                      (published npm packages, maintained by us)
L2  Public APIs / contracts               (stable, versioned interfaces between blocks)
L1  Internal packages                     (workspace modules, private)
L0  Monolith code                         (backend-internal folders)
```

| Level | What it means | Distribution | Who can build it | Examples |
|---|---|---|---|---|
| **L0** | Code inside the host monolith, organized by domain folders | none | us | most of `backend/src/*` today |
| **L1** | Internal package: own package.json, own tests, consumed only inside the monorepo via workspace | workspace link only | us | `backend` (host), `frontends/app`, future `packages/vbook-runtime` |
| **L2** | Contract: versioned spec / schema / protocol. No implementation. The *agreement* that makes L3–L5 possible | spec + schema + contract tests | us (defines), anyone (implements) | LAC v1 protocol, Job Protocol v2, GPU Hub HTTP API, VBook bundle format 3.1 |
| **L3** | Official module: published package owned by Animastor, runs out-of-process or behind ports | public npm (`animastor-*` / `@animastor/*`) | us | `animastor-ai-connector` (ready), `animastor-worker`, future `@animastor/provider-*` |
| **L4** | Community module: e.g. `@someone/animastor-seedance`. Must not require any knowledge of Core internals — only L2 contracts | npm / GitHub, installed by the operator | anyone | future video providers, parsers, workers |
| **L5** | Standalone product/service: a module that has its own product identity and can be used without the Animastor platform | own distribution | us | Animastor Player, Animastor VBook runtime, GPU Hub as a service, LAC (already effectively L5) |

Rules of the ladder:

1. **L2 precedes L3.** Nothing is published before its contract is written down and pinned by contract tests (LAC is the reference process: SPEC → contract-sync test → package).
2. **L4 is only possible on top of L2.** A third-party module that needs "a peek at Core internals" is a design error — the contract must be extended instead.
3. **L1 is not a parking lot.** An L1 package that fails the §26 checklist is a *folder*, not a module, and should not be extracted.
4. **Movement is one level per phase,** with guards updated in the same PR.

---

## 22. Package Architecture (npm Packages & Workspaces)

### 22.1 Target workspace layout

A single root `package.json` declares npm workspaces. Adoption is **additive**: no file moves, no behavior change — only npm linking and root-level scripts.

```
/                        ← root package.json: workspaces + shared scripts (NEW, Phase 9)
├── backend/             ← host / composition root. private: true, never published
├── frontends/app/       ← web app (private)
├── frontends/android/   ← Kotlin app (not an npm workspace)
├── ai-connector/        ← L3: animastor-ai-connector (publishable, name frozen by UI)
├── gpu-hub/             ← L3 after rename (see §22.2): animastor-gpu-hub
├── worker/worker/       ← L3: animastor-worker
└── packages/            ← future L1/L2 packages
    └── contracts/       ← @animastor/contracts: schemas + protocol grammar (Phase 10)
```

Workspace dependency linking during development uses `workspace:*` (or `file:`) protocol; npm resolves it to real versions at publish time. Until workspaces exist, packages stay dependency-free of each other — **no relative imports across package directories, ever** (already true and pinned by guards).

### 22.2 Package naming

| Rule | Detail |
|---|---|
| Frozen names | `animastor-ai-connector` (CLI name shown to users on two platforms), `animastor-worker` (bundle version contract). Renaming = product UI change; forbidden without a major decision |
| New publishable packages | prefer the `@animastor/*` scope (e.g. `@animastor/contracts`, `@animastor/provider-runpod`) — scoped names cannot collide and enable organization-level access control |
| Rename required | `gpu-hub` is an unscoped, generic npm name — unacceptable for publishing. Before any publish: `animastor-gpu-hub` (name used in Phase 7 §4.3) or `@animastor/gpu-hub`, decided by ADR |
| Host | `backend` stays `private: true`; publishing the host is never a goal |
| Name reservation | reserve the `@animastor` npm scope and product names **early** — squatting is a security risk (per `PHASE_8_LAC_EXTRACTION_DESIGN.md` §3) |

### 22.3 Dependency direction

The dependency graph is a DAG. Contracts sit at the bottom; everything points downward.

```
            ┌───────────────────────────────┐
            │ host (backend.cjs composition) │   L1 — may depend on anything below
            └───────┬───────────┬───────────┘
                    │           │
         ┌──────────▼──┐   ┌────▼─────────────────────┐
         │ domain pkgs │   │ infrastructure services  │   L1
         │ (vbook, ...)│   │ (gateway, hub client)    │
         └──────┬──────┘   └────┬─────────────────────┘
                │               │
                ▼               ▼
        ┌───────────────────────────────┐
        │  contracts (schemas, protocol)│   L2 — zero runtime deps
        └───────────────────────────────┘
                ▲
                │  implements
   ┌────────────┴────────────┐
   │ official / community    │   L3/L4 — depend only on contracts,
   │ modules (out-of-process)│   never on host internals
   └─────────────────────────┘
```

Hard rules (enforced by guards — see §27):

1. **No circular dependencies between packages.** A→B and B→A is always a design error; break it with an event, a port, or a new L2 contract (the orchestration↔runtime cycle and its Phase 5 resolution is the in-repo precedent).
2. **A package never requires across another package's boundary** — only its public entry point (§22.4).
3. **Contracts have zero runtime dependencies** (LAC precedent: one dep, `ws`; contracts package: none).
4. **Infrastructure leakage is forbidden:** `express`, `pg`, `ioredis`, `sharp` stay in the host (worker/hub/LAC isolation rules in Phase 1 §8 are the model and already enforce this per-package).
5. **New dependency edges are blocked by failing guard tests by design** — the developer/agent then either redesigns or writes an ADR and consciously updates the baseline (never silently).
6. Current exception to keep in view (debt, already pinned, not new): the orchestration↔runtime↔services↔image 14-module SCC inside the host. It is host-internal and does not block L1+ extraction of other packages, but **it must never be promoted into a package boundary as-is**.

### 22.4 Public vs private APIs

A package exposes **one entry point** and nothing else:

- CJS packages: `main` + the `exports` map; everything not in `exports` is private by construction.
- Package-internal layout (`lib/`, `internal/`) may change in any release without notice; only the entry surface is covered by semver.
- **Published = frozen.** After a public release, the entry surface can only grow additively in minor versions.
- Reference precedent: LAC's public API is exactly two things — the CLI and the LAC v1 wire protocol; everything in `lib/` is internal (`PHASE_8_LAC_EXTRACTION_DESIGN.md` §2).
- Consumers (including the host) import packages only via the entry point; deep imports are a guard-test violation, not a style issue.
- Test-time imports of package internals (the pre-extraction LAC pattern) must be **migrated into the package's own tests**; the consumer keeps only contract-level tests. This is a graduation requirement (§26).

### 22.5 Shared types

The problem today: contract knowledge is duplicated by hand (Job Protocol v2 in three SYNC copies; LAC limits mirrored in `transport.js`; Android contract ~2337 lines as a deliberate parity mirror; frontend `api/models.ts`).

Rules:

1. **JSON Schema is the canonical machine-readable source** wherever the contract is data (VBook bundle 3.1 first — it is an open Phase 1 item; then the job envelope).
2. TS types for frontends are **generated** from schemas or derived from one shared package (`@animastor/contracts`), not hand-copied.
3. Existing SYNC mirrors are legitimate only as **temporary, pinned contract tests** that fail loudly on drift (`lac-contract-sync.test.js` is the reference pattern). A mirror without a contract test is debt.
4. The Android parity mirror stays hand-synced **by explicit decision** (1:1 platform parity); it is out of npm scope.
5. New cross-package types go to `packages/contracts` from day one; host-internal types stay in the host.

### 22.6 Dependency management

| Rule | Detail |
|---|---|
| Minimal runtime deps | A package's dependency list is part of its public surface; adding one requires the same care as adding an export (LAC: `ws` only) |
| No framework leakage | Web frameworks, DB drivers, Redis clients never appear in domain/contract packages |
| Engines | Every package declares `engines.node` explicitly (node ≥ 18 baseline for published packages) |
| Lockfiles | One root lockfile after workspaces; per-package until then |
| Supply chain | No `postinstall`/`preinstall` scripts in published packages (LAC security posture); `--provenance` on publish once CI exists; deps reviewed on every version bump |
| Workspace discipline | Workspace deps use `workspace:*`; consumers never assume hoisted transitive deps |

---

## 23. Versioning, Compatibility & Release

### 23.1 Two version axes

- **Package semver** — the implementation's release lifecycle (`1.4.2`).
- **Protocol version** (`protocol_version`) — the wire/contract generation, negotiated and enforced fail-closed by both sides (LAC `hello` rejects unsupported; worker rejects ≠2).

These are **deliberately decoupled** (LAC precedent): package v1.4.2 speaks protocol v1. A protocol bump is always a package major, but a package major is not necessarily a protocol bump.

### 23.2 What is a breaking change

Generalized from the LAC compatibility policy (`PHASE_8_LAC_EXTRACTION_DESIGN.md` §4):

**Breaking → major (+ protocol bump if wire-visible):**
- removing or renaming a public export, CLI flag, or wire frame;
- changing the meaning or type of a documented field;
- tightening a documented limit below the published contract;
- making an optional field mandatory;
- changing token/credential grammar or error-code semantics;
- changing validation from permissive to strict in a way that rejects previously accepted input.

**Non-breaking → minor/patch:**
- new optional fields; new exports; new error codes; new capability/runtime-type labels;
- relaxing limits; new wire frames the peer may safely ignore;
- internal refactors behind an unchanged entry surface.

### 23.3 Deprecation policy

1. Mark deprecated in docs + CHANGELOG (JSDoc `@deprecated` where types exist).
2. Keep working for **at least one minor release** (three for L2 contracts).
3. Remove only in the next major, with a migration note.

### 23.4 Release / publish workflow

Manual until CI exists (§30 Phase 11); the sequence is the Phase 8E/8F pre-flight, generalized:

```
1. Clean worktree, release commit = version bump + CHANGELOG entry.
2. Package tests green (npm test inside the package, standalone).
3. Cross-side contract tests green (host side: npm run test:arch).
4. npm pack --dry-run: file allowlist reviewed — no secrets, no dev
   artifacts, no node_modules, no monorepo paths inside the tarball.
5. Registry pre-check: name@version returns E404 (no collision).
6. npm auth verified (npm whoami) — publish is BLOCKED without it
   (Phase 8F precedent: never publish from an unauthenticated state).
7. npm publish [--provenance once CI exists].
8. Post-publish: clean-env install of the published version + smoke
   (npx <pkg> --help / require works), tag the release commit.
```

Release order respects the dependency DAG: **contracts → runtime libs → CLI/service packages → (never) host**. A released package's version never moves backwards; a botched publish is deprecated, not unpublished (72h unpublish window is not a plan).

---

## 24. Contract Registry

All stable interfaces live in one registry. A contract that is not in this table is not public. Detailed protocol semantics live in the referenced sources — this table is the index.

| # | Contract | Version | Canonical source | Consumers | Guard |
|---|---|---|---|---|---|
| C1 | VBook bundle format (manifest, layout, ids) | 3.1 | `book/index.js` + `bundle-validator.cjs`; JSON Schema **pending** (Phase 1 open item) | backend, export/import, future player/runtime | `phase2-vbook-contract.test.js` |
| C2 | Canonical Book Model API (`loadBook(id,{mode})`, identity) | internal v1 | `book/book-model.cjs` | host routes only | `phase4-book-model.test.js`, P7-T5 |
| C3 | LAC v1 wire protocol (frames, limits, errors) | 1 | `ai-connector/SPEC.md` | backend ↔ connector | `lac-contract-sync.test.js`, package contract tests |
| C4 | Job Protocol (envelope, job_id grammar, types) | 2 | `runtime/job-schema.js` + 2 SYNC copies (hub, worker) | backend, gpu-hub, worker | `gpu-hub-contract.test.js`, `phase2-job-protocol-v2.test.js` |
| C5 | GPU Hub HTTP API (6 routes) | 2 | `gpu-hub/gpu-hub.js` | backend, worker | `gpu-hub-contract.test.js` |
| C6 | Redis keyspace ownership | registry | `tests/architecture/redis-registry.js` | backend, gpu-hub | `redis-ownership.test.js` |
| C7 | Chat transport (SSE+tools+abort+connector+pool) | internal v1 | `routes/ai-routes.cjs` | browser/Android | `chat-transport.test.js` |
| C8 | Provider Gateway surface (resolve/agent/chat/generation) | internal v1 | `services/provider-gateway.js` | routes (demo consumer) | P7-T6/T8 |
| C9 | Runtime Result Contract (job outcome events) | internal v1 | `contracts/runtime-result.js` | runtime → orchestration | `phase5-runtime-result.test.js` |
| C10 | CLI contract (`animastor-ai-connector` flags/env/exit codes) | 1 | `ai-connector/README.md` | users, web+Android UI | Phase 8E §3 |
| C11 | Worker bundle delivery (hub artifacts API) | 2 | `gpu-hub` `/worker-bundle*`, `/workflow/:id` | worker | pinned in `gpu-hub-contract.test.js` |
| C12 | **Media generation provider contract** | **missing** | — (today: ComfyUI specifics behind `comfyui-provider.js` + envelope business fields) | future providers (Seedance, cloud video…) | to be created (Phase 12) |
| C13 | **Parser / import contract** (`import(source) → DraftBook`) | **missing** | — (today: TXT importer + agent pipeline, draft semantics unified in Phase 4 `lazy` mode) | future EPUB/PDF/DOCX importers | to be created |
| C14 | **Plugin manifest & capability schema** | **missing** | — | future L3/L4 modules | to be created (`PLUGIN_EXTENSION_ARCHITECTURE.md`) |

Registry rules:

1. A contract becomes public (L2) only with: spec/schema source, version, guard test, and an owner.
2. C1–C5 are publishable as-is; C12–C14 must be **stabilized before any third-party ecosystem work** (§29).
3. Changing a registry row = ADR + CHANGELOG + contract tests updated in the same commit (§28).

---

## 25. Plugin / Extension Architecture (Direction)

Full design: **`PLUGIN_EXTENSION_ARCHITECTURE.md`** (child of this document). Summary:

- **Goal:** independent modules for local LLM runtimes (exists — LAC), ComfyUI workers (exists — worker), external API workers (planned — RunPod), image/video/audio providers, storage connectors, import/export formats, and future community modules such as `@someone/animastor-seedance` — none of which modify Core internals.
- **Method:** every extension point is an **L2 contract** + a **host port**. Plugins implement the contract; the host consumes the port. The three existing contracts (LAC, Job Protocol, Hub HTTP) are the first extension points and the reference implementation pattern: **out-of-process, credential minting, fail-closed negotiation, allowlisted capabilities**.
- **Default integration model is out-of-process.** In-process (npm-require) plugins are allowed only for T1 official modules, only via explicit ports, and never receive DB/Redis/credential access (rationale and trust tiers in the child doc).
- **Missing contracts to get there:** C12 (media provider), C13 (parser/import), C14 (manifest/capabilities). These are the prerequisite work items, sequenced in §30.

---

## 26. Module Graduation Checklist

§1 and §3 define the philosophy. This is the **verifiable** checklist. A block moves L0→L1→L3 only when every item is true — otherwise it is a folder with a package.json.

| # | Criterion | How it is verified |
|---|---|---|
| 1 | One-sentence responsibility; no "and/misc/utils" scope | README first line; owner sign-off |
| 2 | Public API is minimal and documented (entry point + exports map) | package.json `exports`; API doc or SPEC |
| 3 | Internals hidden; consumers use only the entry point | guard test (deep-import scan; LAC P7-T1 pattern) |
| 4 | Controlled dependencies (no host internals, no infra leakage, minimal deps) | dependency-guardrails test per package |
| 5 | Own test suite, runnable standalone (`npm test` inside the dir, no PG/Redis/host) | package CI / local run (LAC 69-test precedent) |
| 6 | Protocol involved → cross-side contract test exists and is non-vacuous | `lac-contract-sync` pattern |
| 7 | package.json complete: name/version/description/files/engines/license/repository/bugs | release checklist §23.4 |
| 8 | CHANGELOG.md seeded; version policy §23 applied | review |
| 9 | No upward references; host services consumed only via ports/injection | guard tests + facade review (book-model pattern) |
| 10 | `npm pack --dry-run` + clean-env install rehearsal passed | release checklist |
| 11 | Named owner (human or agent role) | ownership table §28 |

Anti-patterns (automatic disqualification):

- "package" is a folder without its own tests;
- public API = "everything exported";
- package requires host config/env/paths;
- package knows Redis key names or SQL of another module;
- SYNC mirror without a contract test;
- version string that nobody bumps (§23).

---

## 27. Guards & Testing Strategy

Testing serves two goals: correctness of each module, and **safe parallel work** (§28). The in-repo reference patterns are already established — new packages copy them, they do not invent new ones.

### 27.1 Test levels

| Level | What | Where | Reference |
|---|---|---|---|
| Unit (package) | Package logic, standalone, no infra | `<pkg>/test/` | `ai-connector/test/` (69 tests, zero-infra harness) |
| Contract (package-side) | Package honors its published SPEC (frames, limits, error codes) | `<pkg>/test/contract.*` | `ai-connector/test/contract.test.cjs` |
| Contract (cross-side) | Host-side mirrors of contract numbers fail on drift; non-vacuous | `backend/tests/architecture/` | `lac-contract-sync.test.js` (22 tests) |
| Architecture guards | Boundaries: SQL whitelist, Redis ownership, dependency direction, cycle pins, facade edges | `backend/tests/architecture/` | Phase 1 suite, P7-T1..T8 |
| Integration | Multi-service contour (backend+PG+Redis+hub+worker) against docker-compose | backend tests + acceptance scripts | runtime-audit docs, `docs/runtime-audits/` |
| E2E / acceptance | Product scenario: import → generate → play; LAC hello→ready→chat | acceptance docs + scripts | `docs/04-planning/private-worker-installer-e2e-acceptance.md`, `local-ai-connector-e2e` |

### 27.2 Rules

1. **A package's tests must not require the host.** If they do, the boundary is not real yet (this was the LAC blocker fixed in Phase 8B).
2. **Guards must be non-vacuous** — negative controls are part of the suite (Phase 8E practice: a guard that cannot fail is deleted or fixed).
3. **Baselines only shrink.** Whitelists (SQL boundary, cross-owner Redis writes, pinned cycles, bypass sets) can be reduced freely; growing one requires an ADR.
4. **Integration tests speak contracts, not internals** — they exercise documented HTTP/WS surfaces so they survive refactors.
5. **Golden E2E is the release gate** for anything touching generation or playback behavior.
6. Since there is no CI yet, `npm run test:arch` is the mandatory pre-merge command for every PR; automating it in CI is Phase 11 (§30).

---

## 28. Code Ownership & Parallel Development

Animastor is developed by multiple coders and AI agents in parallel. Ownership rules exist so that parallelism produces merge conflicts in *tests* (cheap) rather than in *runtime* (expensive).

### 28.1 Ownership

- Every package, contract, and guard baseline has **exactly one owner** (a person, or an agent session role). Ownership is recorded here and in module READMEs.
- The ownership table is the single source of truth:

| Area | Owner role | May touch | Must not touch without owner's ADR |
|---|---|---|---|
| `ai-connector/` | LAC owner | package + its tests | SPEC (C3), protocol_version, host-side `services/ai-connector/*` |
| `worker/worker/`, `gpu-hub/` | Compute owner | packages + tests | Job Protocol (C4), Hub routes (C5), Redis registry (C6) |
| `backend/src/book/` | Book Model owner | book domain + facades | C1 format, PG ownership handshake |
| `backend/src/orchestration/` + `runtime/` | Generation core owner | orchestration/runtime/services internals | C9, guard baselines, cycle pins |
| Provider surface (`provider-gateway`, `ai-routes`, shared-pool) | Provider owner | gateway + transports | C7, C8 semantics |
| `frontends/app`, `frontends/android` | Frontend owners (per platform) | UI, stores | `api/client.ts` seam semantics, parity mirror |
| Guard baselines (`tests/architecture/*`) | Architecture owner (any ADR author) | via ADR only | — |

### 28.2 Rules for parallel coders / AI agents

1. **Work inside your owned package.** Cross-module changes go through the other module's public API, never through its internals (§22.4).
2. **One PR = one package** (+ its tests). A PR that spans two packages is a contract change (rule 4).
3. **A red guard test is a stop sign, not an obstacle.** Do not extend a whitelist/baseline to make it green; file an ADR or redesign.
4. **Contract changes (registry §24) are special PRs:** proposal → ADR → contract test updates on **both** sides in one commit → CHANGELOG → version plan (§23). Never edit one side of a SYNC mirror only.
5. **No commits to `main` that change a baseline, a contract, or a published package without the corresponding ADR/CHANGELOG.**
6. **Doc-first for cross-module work:** the interface between two agents is the contract doc + module README, not Slack/chat context.
7. **Rebase discipline:** module-scoped branches (`pkg/<name>-<topic>`, `contract/<name>-v<n>`, `docs/<topic>`) rarely conflict; when they do, the contract test suite arbitrates.

### 28.3 Why this works without CI

The guard suite makes cross-module interference observable: an agent touching a foreign module fails *that module's* guard tests, deterministically, locally. CI (Phase 11) turns this from discipline into enforcement. Until then, PRs must include the `test:arch` output.

---

## 29. Current-State Assessment (2026-09-06)

The measured per-module extraction matrix is **`PHASE_7_EXTRACTION_READINESS.md` §3** — it stays canonical and is not duplicated here. Summary + new observations from the 2026-09-06 repo scan:

**Ready for packaging now (low risk):**

- `ai-connector` — 🟢 extraction done; publish blocked only on npm auth (Phase 8F).
- `worker/worker` — 🟢 standalone bundle; publish needs the Job Protocol grammar published as a contract first (C4 source-of-truth work, Phase 10).
- `gpu-hub` — 🟢 as a service; publish needs rename (§22.2) + Redis-ownership cleanup (below).
- Book Model facade — 🟢 as an L1 seam.

**Risky / blocked (do not extract yet):**

- Generation, orchestration/runtime (14-module SCC, SQL in runtime, reconciliation 2326 LOC) — 🔴 host-internal until further seam work.
- Cache — 🔴 not a module (cross-cutting); out of scope indefinitely.
- Player/Editor contours — 🟠 facades clean; route-layer legs (generation-mixed `generation-routes.cjs`, post-commit derived-state fan-out) must be ported first.
- VBook runtime — 🟡 needs detector decoupling, config-path injection, ownership-handshake interface (Phase 7 §4.4 list).

**Dangerous cross-module couplings still open (from V2/Final audits, unchanged):**

1. Book purge in route layer: 24 tables + runtime Redis reset + hub queue clear from `core-routes.cjs` DELETE (move to `entity-cleanup` — planned).
2. Shared Redis backend↔hub with 4 cross-owner key families (`worker-auth`, heartbeat, workers-registry, policy-queues incl. `drainPolicyLane` mutations) — blocks GPU Hub productization (Final Review Phase 5 leftovers).
3. Business identity fields (`book_id`/`chapter_id`/`scene_id`) mandatory in the hub envelope — hub must move to opaque `payload.meta` (C12 prerequisite).
4. 17 files with direct SQL outside storage (frozen whitelist — growing stopped, shrinking pending Phase 3 debt work).
5. Identity/ownership of a book is PG-only while content is bundle-canonical — VBook portability needs a design decision (Phase 2 §12 of the Final Review).

**Contracts to stabilize first** (enables the plugin ecosystem, ordered):

1. **C4 → single source of truth** (`@animastor/contracts`, Phase 10): unblocks worker/hub publishing and any third-party worker.
2. **C12 media provider contract** (Phase 12): unblocks image/video/audio providers incl. `@someone/animastor-seedance`.
3. **C13 parser contract** (Phase 13): unblocks EPUB/PDF/DOCX importers (currently absent from the codebase — greenfield, cheapest to design as plugins from the start).
4. **C14 manifest/capabilities** (Phase 13): unblocks installation/registration/admin surfaces.

**Housekeeping findings (new, 2026-09-06):**

- `gpu-hub` package name is unscoped and generic — must be renamed before any publish (ADR).
- `backend/package.json` lacks `private: true` — add in Phase 9 to prevent accidental host publish.
- `worker/worker/package.json` declares `"type": "module"` while sources are `.cjs` — harmless, but clean it up before publishing.
- No CI at all — for a multi-agent parallel workflow this is now the highest-leverage infrastructure gap (Phase 11).
- `animastor-ai-connector@0.1.0` release remains blocked on npm authentication only; `@animastor` scope reservation is pending the same account setup.

---

## 30. Transition Plan (Phase 9+)

Continues the executed roadmap (§20). Ordering = dependency order; every phase keeps the Phase-1 rule: **zero runtime behavior change unless the phase says otherwise.**

### Phase 9 — Workspaces foundation
- Root `package.json` with `workspaces: ["backend", "frontends/app", "ai-connector", "gpu-hub", "worker/worker", "packages/*"]` + root scripts (`test:arch` delegate, syntax smoke, per-package test runner).
- `backend` gets `private: true`; `gpu-hub` rename decided by ADR (`animastor-gpu-hub` vs `@animastor/gpu-hub`).
- Guard extension: workspace-level dependency-direction tests (§22.3 rules become machine-checked).
- Risk: low (npm linking only). Depends on: nothing.

### Phase 10 — Contracts package (`packages/contracts`, `@animastor/contracts`)
- JSON Schemas: VBook 3.1 (closes the Phase 1 open item), Job Protocol v2 envelope + job_id grammar, LAC v1 limits.
- The three SYNC copies of the Job Protocol become generated/pinned from one source (version stays 2 — not a breaking change).
- TS types generated for frontends where applicable.
- Risk: low-medium (schema extraction is textual; contract tests keep drift visible). Depends on: Phase 9.

### Phase 11 — CI + release automation
- Minimal GitHub Actions: backend `test:arch` + package tests + `npm pack --dry-run` on PRs; release job with §23.4 checklist.
- Unblock npm auth; publish `animastor-ai-connector@0.1.0`; reserve `@animastor` scope.
- Risk: low; infra-only. Depends on: Phase 9 (root scripts), owner account setup.

### Phase 12 — Compute contract completion + worker/hub publishing
- Final Review Phase 5 leftovers: envelope business fields → `payload.meta`; hub-owned heartbeat/registry (remove `drainPolicyLane`, `hdel` debt); artifact delivery via API instead of volume mounts.
- Publish `animastor-worker` and renamed `gpu-hub` with C4/C5 as their published contracts.
- Risk: medium (protocol-adjacent; guarded by C4/C5 tests). Depends on: Phase 10.

### Phase 13 — Plugin foundation (first-class extension points)
- Define **C12 media provider contract** and **C13 parser contract**; implement the host ports.
- Build **C14** manifest + capability schema; plugin registration/admin surface.
- Validate the model with **one official out-of-process plugin** (RunPod worker adapter per `docs/04-planning/RunPod_Integration_GPU_Hub.md`, or a Seedance-style video provider) built strictly against C12/C14 — no Core changes.
- Risk: medium; new surface, additive. Depends on: Phase 12 (payload.meta), §28 ownership in place.

### Phase 14+ — Ecosystem growth (opportunistic)
- VBook runtime package (`@animastor/vbook-runtime`) after Phase 7 §4.4 blockers close; player/editor contour ports; community onboarding docs; marketplace/registry decisions deferred until there is a second real consumer.

Standing rule for all phases: **one level of the ladder (§21) per phase**, guards updated in the same PR, ADR for every baseline change.

---
