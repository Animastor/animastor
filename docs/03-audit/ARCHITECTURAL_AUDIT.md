# 02. Architectural Audit — Animastor

> Audit conducted by reading source code (not just documentation), based on `01_System_Map.md`.
> Date: 2026-06-25.
> Context: project targets **small number of concurrent users**. Therefore the criterion is not scalability,
> but **simplicity, clarity, and reliability**.
> Recommendations in this file are minimal — the main task is to find and prove problems.
>
> **Source:** Original analysis `docs-claude/02_Claude_Audit.md`.
> **Status:** Historical audit. All findings C1-C4, M1-M5, §5.1 closed (see `M5_COMPETING_WRITERS.md`, `ORCHESTRATOR_FACADE_PR.md`, `ARCHITECTURAL_DEBT.md`).

## Severity Scale

- **Critical** — currently capable of causing state loss/corruption, generation "stuckness," or diverging sources of truth.
- **Medium** — works stably on happy path, but breaks on races, restarts, duplicate callbacks, or complicates maintenance to the point where bugs are nearly inevitable.
- **Low** — noise/inconsistency that doesn't harm yet, but increases cognitive load and risk of future errors.

---

## Summary Table

| # | Severity | Problem | Where | Status |
|---|---|---|---|---|
| C1 | Critical | Double decrement of quota counter | `dispatch-engine.js`, `scene-callbacks.js`, `task-handler.cjs` | ✅ Closed (Н.2) |
| C2 | Critical | PG `scene_assets.status` not transitioning to `ready` | `scene-callbacks.js`, `services/scene-asset-registry.js` | ✅ Closed (Н.5) |
| C3 | Critical | Two registries with identical function names | `storage/asset-registry.js` vs `services/scene-asset-registry.js` | ✅ Closed (Н.8) |
| C4 | Critical | `/gpu/task/result` not idempotent | `generation-routes.cjs`, `task-handler.cjs` | ✅ Closed (Н.1) |
| M1 | Medium | Non-atomic read-modify-write per-asset state | `state/scene-state.js` | ✅ Closed (Н.6) |
| M2 | Medium | Non-atomic check-then-incr in quota | `dispatch-engine.js` | ✅ Closed (Н.3) |
| M3 | Medium | Disk as source of truth | `runtime/scene-window.js`, `services/startup-recovery.js` | ✅ Closed (Д.3) |
| M4 | Medium | Two parallel limit systems | `runtime-scheduler.js` vs `dispatch-engine.js` | ✅ Closed (Н.9) |
| M5 | Medium | Multiple state write centers | `scene-callbacks.js`, `scene-window.js`, `reconciliation`, `recovery` | ✅ Closed (M5) |
| L1 | Low | 18 of 36 `runtime/` modules are debug-only | `runtime/*` | ✅ Closed (Д.3) |
| L2 | Low | Mass inline `require()` inside functions | `scene-callbacks.js` and others | ⏳ Deferred (Д.4) |
| L3 | Low | Dual state model + `syncLinearState` | `state/scene-state.js` | ⏳ Deferred (Д.2) |

[Full original audit text from docs-claude/02_Claude_Audit.md follows]
