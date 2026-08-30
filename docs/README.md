# Animastor Documentation

> **Organized by topic.** Documents from `docs-claude/` are integrated.
> Status: current as of August 24, 2026 (documentation audit).
> 
> **Audit Aug 2026:** ARCHITECTURE.md, SYSTEM_MAP.md, SYSTEM_OVERVIEW.md, PROJECT_STRUCTURE.md, DATA_FLOW.md updated — added auth, worker auth, admin, workspace AI provider, audio/video orchestrators, entity cleanup, book routes decomposition, new repositories.

---

## 📖 System Overview — `01-overview/`

| Document | Description |
|---|---|
| [`ARCHITECTURE.md`](01-overview/ARCHITECTURE.md) | Backend architecture: layers, components, dependencies |
| [`SYSTEM_OVERVIEW.md`](01-overview/SYSTEM_OVERVIEW.md) | System overview: scenarios, subsystems, data flow |
| [`DATA_FLOW.md`](01-overview/DATA_FLOW.md) | 10 scenarios: import → bootstrap → generation → player |
| [`PROJECT_STRUCTURE.md`](01-overview/PROJECT_STRUCTURE.md) | Project file tree with description of each module |
| [`SYSTEM_MAP.md`](01-overview/SYSTEM_MAP.md) | **NEW.** Detailed "as-is" map: subsystems, lifecycle, storage, code/doc contradictions |

---

## 🔄 Orchestration and Lifecycle — `02-orchestration/`

| Document | Description |
|---|---|
| [`ORCHESTRATOR_LIFECYCLE.md`](02-orchestration/ORCHESTRATOR_LIFECYCLE.md) | **Single Orchestrator:** "as-is" analysis + proposed architecture (Part 1+2). Updated with M5 progress |
| [`REGENERATION_SYSTEM.md`](02-orchestration/REGENERATION_SYSTEM.md) | Regeneration system: diff, dirty, version-based, dependency graph |
| [`ORCHESTRATOR_FACADE_PR.md`](02-orchestration/ORCHESTRATOR_FACADE_PR.md) | PR description for `feat/orchestrator-facade` branch: what, why, releases A/B/C |
| [`M5_COMPETING_WRITERS.md`](02-orchestration/M5_COMPETING_WRITERS.md) | **M5 completed.** 5 steps to unify all writers under the Orchestrator facade |
| [`STATE_WRITERS_MAP.md`](02-orchestration/STATE_WRITERS_MAP.md) | Map of all locations writing scene/asset state (P1-P8, L1-L7, D1-D3) |

---

## 🔍 Audits — `03-audit/`

| Document | Description |
|---|---|
| [`ARCHITECTURAL_AUDIT.md`](03-audit/ARCHITECTURAL_AUDIT.md) | **NEW.** Full architectural audit: C1-C4, M1-M5, L1-L3. All critical findings closed |
| [`CONFLICTING_SUBSYSTEMS.md`](03-audit/CONFLICTING_SUBSYSTEMS.md) | Audit of 4+ subsystems competing for state management + target architecture |
| [`DEPENDENCY_ANALYSIS.md`](03-audit/DEPENDENCY_ANALYSIS.md) | Analysis of circular dependencies, coupling, single points of failure |
| [`DOCUMENTATION_AUDIT.md`](03-audit/DOCUMENTATION_AUDIT.md) | **NEW.** Documentation audit against code: 25 documents, cross-cutting contradictions |
| [`PLAYER_AUDIT.md`](03-audit/PLAYER_AUDIT.md) | Android player audit: architecture, network preloading, caching |
| [`PLAYER_AUDIO_MASTER_TIMELINE.md`](03-audit/PLAYER_AUDIO_MASTER_TIMELINE.md) | **NEW.** Audio master timeline audit: reveal gate by position, unitId-seek, unit boundaries, race first-frame/gate |
| [`PLAYER_AUDIO_MASTER_TIMELINE_TODO.md`](03-audit/PLAYER_AUDIO_MASTER_TIMELINE_TODO.md) | **NEW.** TODO tracker for audio master timeline audit (stages 1-7) |
| [`ARCHITECTURAL_DEBT.md`](03-audit/ARCHITECTURAL_DEBT.md) | Technical debt: known issues (updated: orchestrator 173 lines, rate limit 500, 3 governance LIVE) |
| [`ARCHITECTURAL_AUDIT_TODO.md`](03-audit/ARCHITECTURAL_AUDIT_TODO.md) | Historical audit TODO tracker (all Phase 1-6 ✅ completed) |

---

## 📋 Plans and Roadmaps — `04-planning/`

| Document | Description |
|---|---|
| [`MIGRATION_PLAN.md`](04-planning/MIGRATION_PLAN.md) | Migration plan to unified Orchestrator: 12 steps, 4 releases (A/B/C/D) |
| [`ROADMAP_6M.md`](04-planning/ROADMAP_6M.md) | **NEW.** Half-year roadmap: week → month → 3 months → long-term |
| [`WORKFLOW_ROADMAP.md`](04-planning/WORKFLOW_ROADMAP.md) | Workflow Manager roadmap: stages 1-5 (backend, frontend, parameters, dev mode, AI) |
| [`GOLDEN_BOOK_EVOLUTION.md`](04-planning/GOLDEN_BOOK_EVOLUTION.md) | **"Evolutionary Churning" concept:** Raw/Golden Books, Quality Delta, evolution cycle + honest critique (future vision) |
| [`NEAR_HORIZONS_GAP_ANALYSIS.md`](04-planning/NEAR_HORIZONS_GAP_ANALYSIS.md) | **NEW.** Gap analysis of "Near Horizons" vision vs code: what's implemented (Cloud + workers), what's partial, what's not |
| [`INSTALLER_ARCHITECTURE.md`](04-planning/INSTALLER_ARCHITECTURE.md) | **NEW.** Canonical Animastor Installer architecture: components, lifecycle, invariants, tests as contracts |

---

## 📱 Frontend — `05-frontend/`

| Document | Description |
|---|---|
| [`PROGRESS_HANDOFF.md`](05-frontend/PROGRESS_HANDOFF.md) | **NEW.** GPU Progress: SSE client, monotonicity, stuck detection, poller (F1-F7 ✅) |
| [`PLAYER_STATE.md`](05-frontend/PLAYER_STATE.md) | Player state after regeneration: soft refresh, `needsContentRefresh`, buildId |
| [`PLAYER_STATE_MACHINE_DESIGN.md`](05-frontend/PLAYER_STATE_MACHINE_DESIGN.md) | **NEW.** Player state machine design: 7 states, single source of truth `selectedUnit` (T6) |
| [`EDITOR_ENTITY_CRUD.md`](05-frontend/EDITOR_ENTITY_CRUD.md) | **NEW.** Editor: manual Add/Delete for characters/locations/voices (unified pattern, web + Android, reusable for Unit/Scene) |

---

## ⚙️ Workflows and Connectors — `06-workflows/`

| Document | Description |
|---|---|
| [`WORKFLOWS.md`](06-workflows/WORKFLOWS.md) | Workflow system: types, loader, builders, lifecycle |
| [`WORKFLOW_ARCHITECTURE.md`](06-workflows/WORKFLOW_ARCHITECTURE.md) | Workflow architecture (v1.0.0): three layers (schema/connector/workflow) |
| [`CONNECTOR_ARCHITECTURE.md`](06-workflows/CONNECTOR_ARCHITECTURE.md) | Connector architecture: entity-schema, bindings, compatibility (v1.2.0) |
| [`CONNECTORS.md`](06-workflows/CONNECTORS.md) | Connector System: overview, files, API, adding new workflows |
| [`WORKFLOW_ASSISTANT_VISION.md`](06-workflows/WORKFLOW_ASSISTANT_VISION.md) | AI Workflow Assistant vision (future) |

---

## 🤖 Agents and Generators — `07-agents-and-generators/`

| Document | Description |
|---|---|
| [`AGENTS.md`](07-agents-and-generators/AGENTS.md) | AI agents: 6-step pipeline, steps, storage, knowledge base |
| [`GENERATORS.md`](07-agents-and-generators/GENERATORS.md) | Generators: audio/image/video/AI/placeholder, shared abstraction layer |

---

## 📱 Android → Mobile Web Migration — `08-mobile-web-migration/`

| Document | Description |
|---|---|
| [`README.md`](08-mobile-web-migration/README.md) | Section overview + main project rule (web version = Android by design/UX) |
| [`01-MIGRATION-STRATEGY.md`](08-mobile-web-migration/01-MIGRATION-STRATEGY.md) | Overall strategy for migrating Android UI to Mobile Web |
| [`02-DESIGN-PRESERVATION-PRINCIPLES.md`](08-mobile-web-migration/02-DESIGN-PRESERVATION-PRINCIPLES.md) | Design/layout/scenario preservation principles |
| [`03-MOBILE-WEB-ARCHITECTURE.md`](08-mobile-web-migration/03-MOBILE-WEB-ARCHITECTURE.md) | Proposed `frontends/mobile/` architecture |
| [`04-MAPPING-TABLES.md`](08-mobile-web-migration/04-MAPPING-TABLES.md) | Screen→Page, Component→Web Component mapping tables, `cinema_*` tokens, API, i18n |
| [`05-SCREEN-IMPLEMENTATION-ORDER.md`](08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md) | Screen migration plan (simple → complex) |
| [`06-RISKS-AND-ALTERNATIVES.md`](08-mobile-web-migration/06-RISKS-AND-ALTERNATIVES.md) | High-risk components + alternatives. Play screen — detailed |

---

## 🖥 Mobile Web → Desktop Migration — `09-desktop-migration/`

| Document | Description |
|---|---|
| [`README.md`](09-desktop-migration/README.md) | Section overview + key decision (desktop inside `frontends/mobile/`, not `frontends/main`) |
| [`01-MIGRATION-PLAN.md`](09-desktop-migration/01-MIGRATION-PLAN.md) | Full plan: desktop shell, Editor/Generator/Player workspace, Assistant, phases 1–10 |
| [`02-PROGRESS.md`](09-desktop-migration/02-PROGRESS.md) | Progress tracker: shell prototype done, Editor in progress |

---

## 🗂 Knowledge Base (root `docs/`)

| Document | Description |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | Project change log |
| [`DONT_DO.md`](DONT_DO.md) | **Forbidden changes:** what broke the system in the past |
| [`architectural-essence.md`](architectural-essence.md) | **Project philosophy:** book as a sequential reading process |

---

## 🗄 Archive — `99-archive/`

Outdated documents preserved for history:

| Document | Why archived |
|---|---|
| [`LLM_AUDIT_CONTEXT.md`](99-archive/LLM_AUDIT_CONTEXT.md) | Contained outdated numbers (rate limit 100, lease TTL). Replaced by `SYSTEM_MAP.md` + `ARCHITECTURAL_AUDIT.md` |
| [`ARCHITECTURE_REVIEW.md`](99-archive/ARCHITECTURE_REVIEW.md) | Point-in-time review; many items outdated/fixed |
| [`TODO_IMMEDIATE.md`](99-archive/TODO_IMMEDIATE.md) | All H.0-H.9, Д.0-Д.3 ✅ completed. C1-C4, M1-M5, §5.1 closed |
| [`TODO_TODAY.md`](99-archive/TODO_TODAY.md) | All tasks S.1, D.1, D.3 ✅ completed |
| [`REGENERATION_SYSTEM_TODO.md`](99-archive/REGENERATION_SYSTEM_TODO.md) | All R0-R19 ✅ completed. v2 and v3 implemented |

---

## Documentation Structure

```
docs/
├── README.md                          ← you are here
├── CHANGELOG.md                       ← change log
├── DONT_DO.md                         ← anti-patterns
├── architectural-essence.md           ← philosophy
│
├── 01-overview/                       ← system overview
│   ├── ARCHITECTURE.md
│   ├── SYSTEM_OVERVIEW.md
│   ├── DATA_FLOW.md
│   ├── PROJECT_STRUCTURE.md
│   └── SYSTEM_MAP.md                  ← NEW (from docs-claude/01)
│
├── 02-orchestration/                  ← orchestration
│   ├── ORCHESTRATOR_LIFECYCLE.md
│   ├── REGENERATION_SYSTEM.md
│   ├── ORCHESTRATOR_FACADE_PR.md
│   ├── M5_COMPETING_WRITERS.md
│   └── STATE_WRITERS_MAP.md
│
├── 03-audit/                          ← audits
│   ├── ARCHITECTURAL_AUDIT.md         ← NEW (from docs-claude/02)
│   ├── CONFLICTING_SUBSYSTEMS.md
│   ├── DEPENDENCY_ANALYSIS.md
│   ├── DOCUMENTATION_AUDIT.md         ← NEW (from docs-claude/05)
│   ├── PLAYER_AUDIT.md
│   ├── ARCHITECTURAL_DEBT.md
│   └── ARCHITECTURAL_AUDIT_TODO.md
│
├── 04-planning/                       ← plans
│   ├── MIGRATION_PLAN.md
│   ├── ROADMAP_6M.md
│   ├── WORKFLOW_ROADMAP.md
│   ├── INSTALLER_ARCHITECTURE.md       ← canonical Installer architecture
│   └── GOLDEN_BOOK_EVOLUTION.md        ← "Evolutionary Churning" concept (vision)
│
├── 05-frontend/                       ← frontend
│   ├── PROGRESS_HANDOFF.md            ← NEW (from docs-claude/PROGRESS_FRONTEND_HANDOFF)
│   └── PLAYER_STATE.md
│
├── 06-workflows/                      ← workflows and connectors
│   ├── WORKFLOWS.md
│   ├── WORKFLOW_ARCHITECTURE.md
│   ├── CONNECTOR_ARCHITECTURE.md
│   ├── CONNECTORS.md
│   └── WORKFLOW_ASSISTANT_VISION.md
│
├── 07-agents-and-generators/          ← AI agents and generators
│   ├── AGENTS.md
│   └── GENERATORS.md
│
├── 08-mobile-web-migration/           ← Android → Mobile Web migration (historical: m.animastor.in → app.animastor.in)
│   ├── README.md
│   ├── 01-MIGRATION-STRATEGY.md
│   ├── 02-DESIGN-PRESERVATION-PRINCIPLES.md
│   ├── 03-MOBILE-WEB-ARCHITECTURE.md
│   ├── 04-MAPPING-TABLES.md
│   ├── 05-SCREEN-IMPLEMENTATION-ORDER.md
│   └── 06-RISKS-AND-ALTERNATIVES.md
│
├── 09-desktop-migration/             ← Mobile Web → Desktop migration
│   ├── README.md
│   ├── 01-MIGRATION-PLAN.md
│   └── 02-PROGRESS.md
│
└── 99-archive/                        ← outdated documents
    ├── LLM_AUDIT_CONTEXT.md
    ├── ARCHITECTURE_REVIEW.md
    ├── TODO_IMMEDIATE.md
    ├── TODO_TODAY.md
    └── REGENERATION_SYSTEM_TODO.md
```

---

## What Was Integrated from `docs-claude/`

| Source File | Integrated Into | Status |
|---|---|---|
| `01_System_Map.md` | `01-overview/SYSTEM_MAP.md` | ✅ New document |
| `02_Claude_Audit.md` | `03-audit/ARCHITECTURAL_AUDIT.md` | ✅ New + closed issue statuses |
| `03_Orchestrator.md` | `02-orchestration/ORCHESTRATOR_LIFECYCLE.md` (partial) | ✅ Supplements existing |
| `04_Migration_Plan.md` | `04-planning/MIGRATION_PLAN.md` | ✅ Existing updated |
| `05_Documentation_Audit.md` | `03-audit/DOCUMENTATION_AUDIT.md` | ✅ New document |
| `06_Roadmap.md` | `04-planning/ROADMAP_6M.md` | ✅ Existing updated |
| `PROGRESS_FRONTEND_HANDOFF.md` | `05-frontend/PROGRESS_HANDOFF.md` | ✅ New document |
