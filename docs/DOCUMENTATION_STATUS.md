# Documentation Status Map

> **Purpose:** Help LLMs and developers identify which documents are authoritative sources of truth, and which are historical/audit/supporting materials that should not be used for current architecture decisions.
>
> **Date:** 31 August 2026.
> **Scope:** All documentation in `docs/` + root-level `.md` files.

---

## Status Definitions

| Status | Meaning | Use as source of truth? |
|--------|---------|------------------------|
| **Current** | Accurate description of the present system. Regularly updated. | ✅ Yes — primary reference |
| **Draft** | Work-in-progress or partially complete. May be superseded. | ⚠️ Only for the area it covers |
| **Historical** | Snapshot of a past state. Documents findings, incidents, or decisions from a specific point in time. | ❌ No — do not use for current architecture |
| **Deprecated** | Explicitly replaced by a newer document or no longer applies (feature removed). | ❌ No — kept only for historical record |
| **Archived** | Legacy material from earlier development phases. Kept for reference only. | ❌ No — see `docs/99-archive/` |
| **Utility** | CSS, HTML, config — not prose documentation. | N/A |

---

## Root-Level Documents

| File | Status | Description |
|------|--------|-------------|
| `README.md` | **Current** | Project overview, quick start, architecture at a glance |
| `ARCHITECTURE.md` | **Current** | Domain map (domains, auth, repository layout) — single-page reference |
| `MEMORY.md` | **Historical** | GPU instance work notes (ComfyUI debugging, Jul–Aug 2026). Not a general architecture doc. |
| `ANDROID_WEB_PARITY.md` | **Current** | Detailed audit of Android ↔ Web feature parity with gap tracking |
| `CONTRIBUTING.md` | **Current** | Contribution guidelines |
| `SECURITY.md` | **Current** | Security policy and deployment best practices |
| `THIRD_PARTY_NOTICES.md` | **Current** | Third-party licenses and dependencies |

---

## docs/01-overview/ — System Overview

**Canonical reference for:** system purpose, subsystems, architecture, data flow, project structure.

> **LLM guidance:** `ARCHITECTURE.md` is the most detailed technical reference (backend layers, routes, services, storage). `SYSTEM_OVERVIEW.md` gives the big picture. `SYSTEM_MAP.md` documents code-vs-doc discrepancies. `DATA_FLOW.md` traces specific scenarios. `PROJECT_STRUCTURE.md` maps files to modules.

| File | Status | Notes |
|------|--------|-------|
| `SYSTEM_OVERVIEW.md` | **Current** | Subsystems, use cases, data flow — highest-level overview |
| `ARCHITECTURE.md` | **Current** | Backend layers, components, dependencies — detailed technical reference |
| `SYSTEM_MAP.md` | **Current** | As-is system map with documentation-vs-code discrepancies (§7). Dated 2026-07-06. |
| `DATA_FLOW.md` | **Current** | 11 scenarios: import → bootstrap → generation → playback |
| `PROJECT_STRUCTURE.md` | **Current** | File tree with module descriptions |

> **Note:** `SYSTEM_OVERVIEW.md` and `ARCHITECTURE.md` cover overlapping territory. `SYSTEM_OVERVIEW.md` is broader (all subsystems); `ARCHITECTURE.md` is deeper (backend layers). Both are canonical for their scope.

---

## docs/02-orchestration/ — Orchestration

**Canonical reference for:** orchestration lifecycle, state machines, dispatch, audio/video merge.

> **LLM guidance:** `ORCHESTRATION.md` explicitly supersedes all older orchestration documents. For any orchestration question, start here. `VIDEO_ORCHESTRATION.md` and `AUDIO_VIDEO_SYNC.md` are supplementary deep-dives.

| File | Status | Notes |
|------|--------|-------|
| `ORCHESTRATION.md` | **Current** | **Single source of truth** for all orchestration. Supersedes all older orchestration docs. |
| `VIDEO_ORCHESTRATION.md` | **Current** | Video pipeline specifics (groups, merge, dirty-regeneration) |
| `AUDIO_VIDEO_SYNC.md` | **Current** | Audio/video synchronization details |
| `ORCHESTRATION_TODO.md` | **Current** | Consolidated TODO status for orchestration items |
| `AUDIO_ORCH_ARCHITECTURAL_FIXES.md` | **Historical** | Specific fixes applied to audio orchestrator (Jun 2026) |
| `AUDIO_ORCH_ARCHITECTURAL_TODO.md` | **Historical** | Migration TODO — many items completed |
| `ORCHESTRATION_AUDIT_2026-07-27.md` | **Historical** | Point-in-time audit of orchestration system |
| `ORCHESTRATION_FOLLOWUP_REVIEW_2026-07-27.md` | **Historical** | Follow-up review of recent commits |
| `ORCHESTRATION_STABILIZATION_RECOMMENDATIONS.md` | **Historical** | Stabilization recommendations from audit |

---

## docs/03-audit/ — Audits and Incident Reports

**Purpose:** Point-in-time analysis and incident forensics. Most are **Historical** snapshots.

| File | Status | Notes |
|------|--------|-------|
| `ARCHITECTURAL_AUDIT.md` | **Historical** | Original audit (Jun 2026). All findings C1–C4, M1–M5 closed. |
| `ARCHITECTURAL_DEBT.md` | **Current** | Living technical debt tracker. Updated with fix statuses. |
| `ARCHITECTURAL_AUDIT_TODO.md` | **Deprecated** | All items completed and archived |
| `CATHEDRAL.md` | **Current** | Architectural improvement guiding principles ("The Cathedral") |
| `CONFLICTING_SUBSYSTEMS.md` | **Historical** | Analysis of 4 competing decision centers. Most recommendations implemented. |
| `DOCUMENTATION_AUDIT.md` | **Historical** | Documentation-vs-code audit (Jun 2026). Cross-cutting contradictions fixed. |
| `DEPENDENCY_ANALYSIS.md` | **Historical** | Dependency graph at time of writing |
| `PLAYER_AUDIT.md` | **Historical** | Player audit at time of writing |
| `PLAYER_AUDIO_MASTER_TIMELINE.md` | **Historical** | Audio timeline analysis |
| `PLAYER_AUDIO_MASTER_TIMELINE_TODO.md` | **Historical** | Related TODO items |
| `AUDIO_8_9_RACE_CONDITION.md` | **Historical** | Audio race condition analysis |
| `COMFYUI_CLEANUP_RECOVERY_AUDIT.md` | **Historical** | ComfyUI cleanup recovery audit |
| `COMFYUI_TEMP_FILES_CLEANUP_AUDIT.md` | **Historical** | ComfyUI temp files cleanup |
| `CONTEXT_POISONING_RULES_EXAMPLES.md` | **Historical** | Context poisoning rules |
| `CROSS_PROMPT_CONSISTENCY.md` | **Historical** | Cross-prompt consistency analysis |
| `DELETE_LIFECYCLE_AUDIT.md` | **Historical** | Delete lifecycle audit |
| `ORCHESTRATION_AUDIT_REPORT.html` | **Historical** | HTML audit report |
| `video-retry-fix/` (6 files) | **Historical** | Video retry incident forensics (Aug 2026) |
| `image-ghost-generating/` (2 files) | **Historical** | Image ghost incident forensics (Aug 2026) |

---

## docs/04-planning/ — Planning and Roadmaps

**Purpose:** Roadmaps, feature plans, research. Most represent a **point-in-time plan**, not current state.

| File | Status | Notes |
|------|--------|-------|
| `ROADMAP_6M.md` | **Historical** | 6-month roadmap (Jun 2026). Many items completed (Н.0–Н.9, М.1–М.5, К.1–К.4). |
| `PLATFORM_ARCHITECTURE.md` | **Current** | Platform architecture overview |
| `INSTALLER_ARCHITECTURE.md` | **Current** | Private worker installer architecture |
| `WORKFLOW_ROADMAP.md` | **Historical** | Workflow feature roadmap |
| `GOLDEN_BOOK_EVOLUTION.md` | **Historical** | Golden book evolution plan |
| `TXT_IMPORT_STRUCTURE_V2.md` | **Historical** | TXT import v2 design |
| `TXT_IMPORT_PARALLEL_ANALYSIS.md` | **Historical** | Parallel analysis design |
| `EXPERIMENTAL_BETA_REDTEAM_AUDIT.md` | **Historical** | Beta red-team audit |
| `EXPERIMENTAL_BETA_RECONNAISSANCE_AUDIT.md` | **Historical** | Beta reconnaissance audit |
| `EXPERIMENTAL_BETA_VERSION.md` | **Historical** | Beta version planning |
| `NEAR_HORIZONS_GAP_ANALYSIS.md` | **Historical** | Gap analysis |
| `RunPod_Integration_GPU_Hub.md` | **Historical** | RunPod integration research |
| `private-worker-installer-architecture.md` | **Current** | Private worker installer architecture |
| `private-worker-installer-dependency-research.md` | **Current** | Dependency research for installer |
| `private-worker-installer-manifest-resolver.md` | **Current** | Manifest resolver design |
| `private-worker-installer-phase15.md` | **Current** | Phase 15 implementation details |
| `private-worker-installer-frontend-integration.md` | **Current** | Frontend integration for installer |
| `private-worker-installer-e2e-acceptance.md` | **Current** | E2E acceptance criteria |
| `private-worker-setup-contract-api.md` | **Current** | Setup contract API spec |

---

## docs/05-frontend/ — Frontend

**Purpose:** Player, editor, progress panel. Mix of current reference and historical audits.

| File | Status | Notes |
|------|--------|-------|
| `PLAYER_STATE.md` | **Current** | Player state contract — reusable reference |
| `TASK_ARCHITECTURE.md` | **Current** | Task/progress architecture (SSE, panel) |
| `EDITOR_ENTITY_CRUD.md` | **Current** | Editor entity add/delete operations |
| `PLAYER_STATE_MACHINE_DESIGN.md` | **Historical** | Player state machine design document |
| `PLAYER_STATE_MACHINE_T4_MANUAL_REGRESSION.md` | **Historical** | T4 regression test plan |
| `PLAYER_STATE_MACHINE_AUDIT_T6.md` | **Historical** | Player audit after T6 changes |
| `PLAYER_STATE_MACHINE_ANDROID_WEB_PARITY_AUDIT.md` | **Historical** | Android/Web parity audit |
| `PLAYER_SEEK_ENGINEERING.md` | **Historical** | Seek engine engineering notes |
| `SCENE_LENGTH_REFACTOR.md` | **Historical** | Scene length refactoring |
| `PROGRESS_HANDOFF.md` | **Historical** | GPU progress frontend handoff |
| `VIDEO_LOADING_RESEARCH.md` | **Historical** | Video loading research |

---

## docs/06-workflows/ — Workflows and Connectors

**Canonical reference for:** ComfyUI workflow system, connector architecture.

| File | Status | Notes |
|------|--------|-------|
| `WORKFLOWS.md` | **Current** | Workflow system overview — loader, builders, execution, lifecycle |
| `WORKFLOW_ARCHITECTURE.md` | **Current** | Workflow layer design |
| `CONNECTORS.md` | **Current** | Connector system overview |
| `CONNECTOR_ARCHITECTURE.md` | **Current** | Connector design document |
| `SCENE_PIPELINE.md` | **Current** | Scene pipeline architecture |
| `WORKFLOW_ASSISTANT_VISION.md` | **Historical** | Workflow assistant vision/roadmap |
| `UNIT_SPLIT_POST_STEP.md` | **Historical** | Unit split post-step analysis |

---

## docs/07-agents-and-generators/ — AI Agents and Generators

**Canonical reference for:** AI pipeline, generator types, prompt engineering.

> **LLM guidance:** `AGENTS.md` covers the AI analysis pipeline (steps 0–7b, parallel analysis, window processing). `GENERATORS.md` covers audio/image/video generation services and prompt assembly. These two documents are complementary — one handles text analysis, the other handles asset generation.

| File | Status | Notes |
|------|--------|-------|
| `AGENTS.md` | **Current** | Agent pipeline architecture — steps, parallel analysis, window processing |
| `GENERATORS.md` | **Current** | Generator types (audio/image/video), prompt assembly |
| `IMAGINATION_UNIT.md` | **Current** | IU (visual unit) design |
| `LANGUAGE_ARCHITECTURE.md` | **Current** | Language architecture |
| `DIALOGUE_TTS_PIPELINE.md` | **Current** | Dialogue TTS pipeline |
| `AI_PROFILE_AUTO_SELECTION.md` | **Current** | AI profile auto-selection |
| `AGENT_PROMPT_PROFILES.md` | **Current** | Agent prompt profiles |
| `IMAGINATION_UNIT_VERIFICATION.md` | **Historical** | IU verification at time of writing |
| `COREFERENCE_RESOLUTION.md` | **Deprecated** | Coreference resolution was removed from pipeline (Jul 2026) |
| `COREFERENCE_ARCHITECTURE_REVIEW.md` | **Deprecated** | Coreference architecture review — feature removed |
| `COREFERENCE_TODO.md` | **Deprecated** | Coreference TODO — feature removed |
| `SYSTEM_PROMPT_RULES_MIGRATION.md` | **Historical** | System prompt rules migration |
| `IU_MODAL_REFACTORING.md` | **Historical** | IU modal refactoring |
| `VBOOK_GENERATION_COVERAGE_TODO.md` | **Historical** | VBook generation coverage TODO |

---

## docs/08-mobile-web-migration/ — Android → Mobile Web Migration

**Status:** Stages 0–7 completed. `frontends/mobile/` built and functional.

| File | Status | Notes |
|------|--------|-------|
| `README.md` | **Current** | Migration overview and status |
| `01-MIGRATION-STRATEGY.md` | **Current** | Migration strategy |
| `02-DESIGN-PRESERVATION-PRINCIPLES.md` | **Current** | Design preservation principles |
| `03-MOBILE-WEB-ARCHITECTURE.md` | **Current** | Mobile web architecture |
| `04-MAPPING-TABLES.md` | **Current** | Screen/component mapping tables |
| `05-SCREEN-IMPLEMENTATION-ORDER.md` | **Current** | Screen implementation order |
| `06-RISKS-AND-ALTERNATIVES.md` | **Current** | Risks and alternatives |
| `07-MOBILE-WEB-TESTER.md` | **Current** | Mobile web tester |
| `TODO.md` | **Current** | Remaining migration TODO |

---

## docs/09-desktop-migration/ — Mobile Web → Desktop Migration

**Status:** Plan approved, desktop shell prototype implemented.

| File | Status | Notes |
|------|--------|-------|
| `README.md` | **Current** | Migration overview and key decisions |
| `01-MIGRATION-PLAN.md` | **Current** | Full migration plan (phases 1–10) |
| `02-PROGRESS.md` | **Current** | Phase progress tracker |

---

## docs/runtime-audits/ — Runtime Audit Reports

**Purpose:** Point-in-time runtime validation and incident analysis.

| File | Status | Notes |
|------|--------|-------|
| `README.md` | **Current** | Runtime audits overview |
| `phase-3.3-e2e-validation-2026-08-27.md` | **Historical** | E2E validation results |
| `phase-3.4-e2e-blockers-2026-08-27.md` | **Historical** | E2E blocker analysis |
| `local-ai-connector-e2e-2026-09-04.md` | **Current** | Local AI Connector + Ollama E2E on VPS |
| `audio-qwen/audit-2026-08-25.txt` | **Historical** | Audio Qwen runtime audit |
| `image-qwen/animastor-image-qwen-runtime-audit-2026-08-26.md` | **Historical** | Image Qwen runtime audit |
| `video-ltx-2.3/audit-2026-08-26.txt` | **Historical** | Video LTX 2.3 runtime audit |

---

## docs/99-archive/ — Archived Documents

**All files in this directory are Archived.** They represent earlier development phases and should not be used as sources for current architecture decisions.

Contains 25 files across subdirectories:
- `02-orchestration/` — Pre-facade orchestration docs (superseded by `docs/02-orchestration/ORCHESTRATION.md`)
- `03-audit/` — Pre-consolidation orchestration audits (superseded by current audit docs)
- `04-planning/` — Pre-completion planning docs
- Root — LLM audit context, TODO files, architecture review (point-in-time)

---

## docs/ Root Utility Files

| File | Status | Notes |
|------|--------|-------|
| `DOCUMENTATION_CONSISTENCY_REPORT.md` | **Current** | Meta-document: translation progress and terminology unification |
| `docs-browser.css` | **Utility** | CSS for documentation browser |
| `index.html` | **Utility** | Documentation browser entry point |

---

## Summary Statistics

| Status | Count | Description |
|--------|-------|-------------|
| **Current** | ~55 | Authoritative reference documents |
| **Historical** | ~50 | Point-in-time snapshots, audits, incident reports |
| **Deprecated** | ~4 | Replaced by newer docs (coreference, audit TODO) |
| **Archived** | ~25 | Legacy material in `docs/99-archive/` |
| **Utility** | ~3 | CSS, HTML, meta-documentation |

---

## Canonical References by Area

> **Rule for LLMs:** When a question falls into a specific area, read the **Canonical** document first. Only consult **Supporting** documents if the canonical document does not cover the specific detail.

### 1. System Overview and Architecture

Five documents describe the overall system. They have different scopes and levels of detail:

| Document | Scope | Canonical for |
|----------|-------|---------------|
| **`docs/01-overview/ARCHITECTURE.md`** | Backend layers, all components, dependencies | ✅ **Architecture details** — API routes, orchestration layers, services, storage, GPU infrastructure, dependency graph |
| **`docs/01-overview/SYSTEM_OVERVIEW.md`** | All subsystems at higher level | ✅ **System overview** — purpose, use cases, subsystem summaries, data flow diagram, key components table |
| **`docs/01-overview/SYSTEM_MAP.md`** | As-is map with code discrepancies | ✅ **Code-vs-doc discrepancies** — §7 documents where docs diverge from code |
| **`docs/01-overview/DATA_FLOW.md`** | 11 specific scenarios | ✅ **Data flow** — step-by-step traces for import, bootstrap, generation, playback, shutdown, recovery |
| **`docs/01-overview/PROJECT_STRUCTURE.md`** | File tree with descriptions | ✅ **File locations** — where each module lives and what it does |
| `ARCHITECTURE.md` (root) | Domain map + repo layout | Supporting — high-level domain map, repository layout, key facts |
| `README.md` (root) | Project overview | Supporting — architecture at a glance table, quick start |

> **Overlap note:** `SYSTEM_OVERVIEW.md` and `docs/01-overview/ARCHITECTURE.md` both describe the orchestration layer, agent pipeline, storage, and services. When both cover the same component, `ARCHITECTURE.md` is more detailed (includes API signatures, dependencies, inputs/outputs). `SYSTEM_OVERVIEW.md` is better for understanding the overall picture.

### 2. Orchestration

| Document | Canonical for |
|----------|---------------|
| **`docs/02-orchestration/ORCHESTRATION.md`** | ✅ **All orchestration** — facade, dispatch engine, audio/video orchestrators, state machines, call flows, configuration. Explicitly supersedes all older orchestration docs. |
| `docs/02-orchestration/VIDEO_ORCHESTRATION.md` | Supporting — video pipeline specifics |
| `docs/02-orchestration/AUDIO_VIDEO_SYNC.md` | Supporting — audio/video synchronization |
| `docs/02-orchestration/ORCHESTRATION_TODO.md` | Supporting — TODO status |
| `docs/01-overview/ARCHITECTURE.md` §3 | Supporting — orchestration layer overview (less detail than ORCHESTRATION.md) |
| `docs/01-overview/SYSTEM_OVERVIEW.md` §Orchestration | Supporting — five-component summary |

### 3. Agent Pipeline and Generators

| Document | Canonical for |
|----------|---------------|
| **`docs/07-agents-and-generators/AGENTS.md`** | ✅ **Agent pipeline** — all steps (0–7b), parallel analysis, window processing, knowledge base, limitations |
| **`docs/07-agents-and-generators/GENERATORS.md`** | ✅ **Generators** — audio/image/video services, prompt assembly, IU processing, passport system |
| `docs/07-agents-and-generators/IMAGINATION_UNIT.md` | Supporting — IU design details |
| `docs/07-agents-and-generators/DIALOGUE_TTS_PIPELINE.md` | Supporting — dialogue TTS specifics |
| `docs/07-agents-and-generators/LANGUAGE_ARCHITECTURE.md` | Supporting — language detection/processing |
| `docs/07-agents-and-generators/AI_PROFILE_AUTO_SELECTION.md` | Supporting — profile selection logic |
| `docs/07-agents-and-generators/AGENT_PROMPT_PROFILES.md` | Supporting — prompt profiles |
| `docs/01-overview/SYSTEM_OVERVIEW.md` §Agent Service | Supporting — high-level summary |
| `docs/01-overview/ARCHITECTURE.md` §4.5 | Supporting — pipeline steps and key changes |

### 4. Workflows and Connectors

| Document | Canonical for |
|----------|---------------|
| **`docs/06-workflows/WORKFLOWS.md`** | ✅ **Workflow system** — loader, builders, execution mechanism, lifecycle, node ID maps |
| **`docs/06-workflows/CONNECTORS.md`** | ✅ **Connector system** — overview and usage |
| **`docs/06-workflows/WORKFLOW_ARCHITECTURE.md`** | ✅ **Workflow architecture** — design decisions and layer structure |
| **`docs/06-workflows/CONNECTOR_ARCHITECTURE.md`** | ✅ **Connector architecture** — design details |
| `docs/06-workflows/SCENE_PIPELINE.md` | Supporting — scene pipeline architecture |
| `docs/01-overview/SYSTEM_OVERVIEW.md` §Workflow Loader | Supporting — one-paragraph summary |

### 5. Frontend (Player, Editor, Progress)

| Document | Canonical for |
|----------|---------------|
| **`docs/05-frontend/PLAYER_STATE.md`** | ✅ **Player state contract** — state machine, transitions, Android/web behavior |
| **`docs/05-frontend/TASK_ARCHITECTURE.md`** | ✅ **Task/progress architecture** — SSE progress panel, worker display |
| **`docs/05-frontend/EDITOR_ENTITY_CRUD.md`** | ✅ **Editor CRUD** — entity add/delete operations |
| `ANDROID_WEB_PARITY.md` (root) | ✅ **Android ↔ Web parity** — the only document covering this area |

### 6. Auth, Workers, Admin

| Document | Canonical for |
|----------|---------------|
| **`docs/01-overview/ARCHITECTURE.md` §2.7–2.9, §4.24–4.28** | ✅ **Auth, worker auth, admin, workspace AI provider** — API signatures, middleware, credential model |
| **`docs/01-overview/SYSTEM_OVERVIEW.md` §Auth/Worker Auth/Admin/Workspace AI** | ✅ **Auth subsystem overview** — higher-level summaries of each |
| `ARCHITECTURE.md` (root) §Domains | Supporting — domain map, auth flow, cross-subdomain sessions |

### 7. Storage

| Document | Canonical for |
|----------|---------------|
| **`docs/01-overview/ARCHITECTURE.md` §6** | ✅ **Storage details** — PG tables, Redis key structures, filesystem format, repositories |
| **`docs/01-overview/SYSTEM_MAP.md` §4** | ✅ **Storage architecture** — responsibility model (PG=facts, Redis=derived, Files=artifacts) |
| `docs/01-overview/SYSTEM_OVERVIEW.md` §Storage | Supporting — high-level summary |

### 8. Technical Debt and Architecture Improvement

| Document | Canonical for |
|----------|---------------|
| **`docs/03-audit/ARCHITECTURAL_DEBT.md`** | ✅ **Technical debt** — living tracker with fix statuses |
| **`docs/03-audit/CATHEDRAL.md`** | ✅ **Architecture improvement principles** — the "Cathedral" process |
| `docs/03-audit/CONFLICTING_SUBSYSTEMS.md` | Historical — analysis of 4 decision centers (recommendations implemented) |
| `docs/03-audit/ARCHITECTURAL_AUDIT.md` | Historical — original audit (Jun 2026), all findings closed |
| `docs/03-audit/DOCUMENTATION_AUDIT.md` | Historical — doc-vs-code audit, contradictions fixed |

### 9. Migrations

| Document | Canonical for |
|----------|---------------|
| **`docs/08-mobile-web-migration/README.md`** | ✅ **Android → Mobile Web migration** — status, section index |
| **`docs/09-desktop-migration/README.md`** | ✅ **Mobile Web → Desktop migration** — status, section index |

### 10. Private Worker Installer

| Document | Canonical for |
|----------|---------------|
| **`docs/04-planning/private-worker-installer-architecture.md`** | ✅ **Installer architecture** — the primary design document |
| `docs/04-planning/private-worker-setup-contract-api.md` | Supporting — API contract spec |
| Other `private-worker-installer-*.md` | Supporting — specific aspects (dependency research, manifest resolver, phase 15, frontend integration, E2E acceptance) |
| `docs/04-planning/INSTALLER_ARCHITECTURE.md` | Supporting — installer architecture (may overlap with `private-worker-installer-architecture.md`) |

---

*End of documentation status map. Updated 31 August 2026.*
