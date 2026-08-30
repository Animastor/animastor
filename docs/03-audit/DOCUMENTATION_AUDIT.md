# 05. Documentation vs Code Audit — Animastor

> Comparison of `docs/` contents with actual implementation. Goal is to find outdated,
> contradictions, missing sections, incorrect diagrams.
> Based on source code and document reading. Date: 2026-06-25.
>
> **Source:** Original analysis `docs-claude/05_Documentation_Audit.md`.
> **Status:** Historical audit. Cross-cutting contradictions (rate limit, lease TTL, sendVideo, etc.) fixed
> during documentation restructuring (June 2026).

---

## Status Scale

- **Current** — matches code; minor inaccuracies absent or non-critical.
- **Needs Update** — fundamentally correct, but contains specific facts/diagrams diverging from code.
- **Outdated** — describes architecture/numbers no longer in code; dangerous for onboarding.
- **Missing** — section/document that doesn't exist but is needed.

---

## Summary Table (25 Documents)

| Document | Status | Main Issue |
|---|---|---|
| `AGENTS.md` | Current | correctly explains agent model/steps (compose override accounted) |
| `ARCHITECTURE.md` | ✅ Updated | rate limit 500, `sendVideo` removed, governance live, 6 routes |
| `SYSTEM_OVERVIEW.md` | ✅ Updated | same numbers; "6 steps" explained |
| `DATA_FLOW.md` | ✅ Updated | lease TTL 15/20/30, version-stale in scheduler |
| `PROJECT_STRUCTURE.md` | ✅ Updated | workflow-manager, startup-recovery mentioned |
| `ARCHITECTURAL_DEBT.md` | ✅ Updated | orchestrator 173 lines, rate limit 500 |
| `CONFLICTING_SUBSYSTEMS.md` | Current | "4 decision centers" confirmed by code |
| `ARCHITECTURAL_AUDIT_TODO.md` | ✅ Archived | all items completed |
| `ARCHITECTURE_REVIEW.md` | 🗄 Archive | point-in-time review |
| `architectural-essence.md` | Current | principles, minimally tied to numbers |
| `REGENERATION_SYSTEM.md` | Needs Update | core mechanism described correctly |
| `ORCHESTRATOR_LIFECYCLE.md` | Current | matches current architecture |
| `PLAYER_AUDIT.md` | Needs Update | player audit at time of writing |
| `PLAYER_STATE.md` | Current | matches current code |
| `CONNECTORS.md` | Current | connector layer exists in code |
| `CONNECTOR_ARCHITECTURE.md` | Current | connector design document |
| `WORKFLOWS.md` | Current | workflow-loader/manager present |
| `WORKFLOW_ARCHITECTURE.md` | Current | workflow layer design |
| `WORKFLOW_ASSISTANT_VISION.md` | Needs Update | vision/roadmap |
| `WORKFLOW_ROADMAP.md` | Needs Update | roadmap, item statuses |
| `GENERATORS.md` | Current | audio/image/video generators match |
| `DEPENDENCY_ANALYSIS.md` | Needs Update | dependency graph may have shifted |
| `LLM_AUDIT_CONTEXT.md` | 🗄 Archive | repeats old numbers |
| `DONT_DO.md` | Current | prohibitions/anti-patterns |
| `CHANGELOG.md` | Current | fresh (Jun 26) |

### Missing Sections (Now Added)

1. **Generation Lifecycle / State Ownership** — ✅ `ORCHESTRATOR_LIFECYCLE.md`
2. **System Map (as-is)** — ✅ `SYSTEM_MAP.md`
3. **Architectural Audit** — ✅ `ARCHITECTURAL_AUDIT.md`
4. **Frontend Handoff (GPU Progress)** — ✅ `PROGRESS_HANDOFF.md`

---

## Update Priority (At Time of Audit)

1. **LLM_AUDIT_CONTEXT.md** — 🗄 Archived. Its errors no longer propagated.
2. **DATA_FLOW.md** — ✅ Updated: lease TTL 15/20/30, version-stale in scheduler, callbacks without syncLinearState.
3. **ARCHITECTURE.md / SYSTEM_OVERVIEW.md** — ✅ Updated: rate limit 500, 6 routes, governance live.
4. **ARCHITECTURAL_DEBT.md** — ✅ Updated: orchestrator 173 lines, closed items marked.
5. **ARCHITECTURAL_AUDIT_TODO.md** — 🗄 Archived (all items ✅).

---

## Cross-Cutting Contradictions (Repeated Across Multiple Documents)

| Incorrect Fact | Where Found | Fixed |
|---|---|---|
| Rate limit 100 req/min | ARCHITECTURE, SYSTEM_OVERVIEW, LLM_AUDIT_CONTEXT | ✅ 500 |
| `gpu-dispatcher.sendVideo` | SYSTEM_OVERVIEW, ARCHITECTURE | ✅ no such method |
| Lease TTL 30/60/120 min | DATA_FLOW | ✅ 15/20/30 |
| orchestrator ~1200 lines | ARCHITECTURAL_DEBT | ✅ 173 |
| All governance — dead code | ARCHITECTURE, ARCHITECTURAL_DEBT | ✅ 3 of 6 alive |

---

*End of documentation audit. Completed 2026-06-25, updated 2026-06-28.*
