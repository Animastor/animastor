# TODO — Today (June 27, 2026)

> Context: Releases A/B/C (`04_Migration_Plan.md`) closed — C1–C4, M1–M5, §5.1.
> M5 (P2/P4/P5/P6 + L1–L7) and O2 completed June 26. See yesterday's `TODO_TODAY` in git (`9668f4c`).
> Remaining: **1 overdue security item** + **Release D "cleanup"** (Long-term D.1–D.5 from `06_Roadmap.md`).
>
> **Rule:** each step = separate commit → `npm test` (base 381 passing) → push.

---

## 🔴 S.1: Move Secrets from Git + Rotation (N.4 — OVERDUE)

**Risk:** low technically, but **critical for security**. **Do first.**

In `docker-compose.yml` (tracked by git) — production secrets in plaintext:
- `OPENROUTER_API_KEY=sk-live-…bd0b` (line 59)
- `POSTGRES_PASSWORD=<redacted>` (line 22) + `PG_PASSWORD` (line 57)

`.gitignore` already covers `.env` / `*.env` — infrastructure ready, no `.env` files yet.

To do:
- [ ] `.env` (not committed) + `.env.example` with placeholders.
- [ ] `docker-compose.yml` → `${OPENROUTER_API_KEY}` / `${POSTGRES_PASSWORD}` via `env_file`.
- [ ] **Rotate leaked OpenRouter key and PG password** — key in git history, considered compromised.
- [ ] (optional) clean key from git history or accept as "rotated, old dead".

---

## 🟢 D.1: Clean Dead Limits Duplicate (M4 / D.1) — Verified

**Risk:** low. M4 closed (`0adc930`), but roadmap D.1 is broader: ensure scheduler's `getMetrics`
returns **real** dispatch-engine counters, not dead zeros.

Verified ✅ (no changes needed):
- [x] `grep` — no dead `MAX_CONCURRENT/concurrent-/canScheduleStage/incrementConcurrent`.
- [x] `getMetrics` (`runtime-scheduler.js:403`) delegates `dispatchEngine.getQuotaStatus` —
  returns real per-stage counters (audio/image/video current+max), not zeros.
- [x] D.1 already fully closed in `0adc930` (N.9). Nothing to duplicate.

---

## ✅ D.3: Remove Dead Governance and Broken `require` (L1 / D.3) — Completed

**Commit:** `311f44a`

The finding was broader and **safer** than planned: `src/api/runtime.js` (1758 lines)
**not imported anywhere** — dead file and sole consumer of 16 debug-only
`runtime/` modules. Six of them did `require()` on non-existent files
(trace-compactor, invariant-engine, safe-mode, state-graph/*, policies, admission-control) →
accessing `/debug/runtime/governance-health` and `/execution-semantics` would return 500.
Live debug routes (`debug-routes.cjs`) **don't touch** this cluster (only `reconciliation`).

Done:
- [x] Removed `src/api/runtime.js` (unrelated dead code).
- [x] Removed 16 dead `runtime/` modules (snapshot/priority/policy-engine/workload/cost/
  decision-trace/feedback/governance-metrics/adaptation/governance-stability/governance-health/
  execution-semantics/policy-simulator/governance-sandbox/failure-replay/governance-validator).
- [x] Removed `debug: { ... }` facade from `runtime/index.js` (only read by `api/runtime.js`).
- [x] Kept live `circuit-breaker`/`fairness-engine`/`retry-budget-manager` —
  they are `require()`-d directly from `dispatch-engine`/`runtime-persistence`.
- [x] Verified: no broken requires, `runtime/index.js`+`debug-routes` load clean, **381 passing**.

---

## ⚪ Deferred (not today — large/dependent)

- **D.2 — Linear projection removal (L3):** remove `SceneState`/`syncLinearState`/`deriveLinearState`.
  Blocks frontend — player and debug still read `scene-state` keys. Do **after** stabilization.
- **D.4 — Break circular dependencies (L2):** remove inline `require()` inside functions
  (8+ locations in `scene-callbacks.js`). Per roadmap — **after** K.4 (Orchestrator already provides boundary).
- **D.5 — Missing docs:** backpressure/quotas/lease, per-asset vs linear, callback idempotency.

---

## 🟢 Doc Tail (quick, low-risk)

- [ ] `ARCHITECTURAL_AUDIT_TODO.md` lines 32–34: remove R1.1 divergence warning —
  version-stale in `startup-recovery.js:284-288` already goes through `orchestrator.markDirtyScene` (`2807a38`).

---

## Day Summary

| # | Step | Closes | Status | Commit |
|---|---|---|---|---|
| 1 | **S.1** secrets in `.env` + rotation | N.4 | ✅ code / ⏳ rotation (manual) | `6dca53a` |
| 2 | D.1 limits cleanup | M4/D.1 | ✅ already closed in `0adc930` | — |
| 3 | D.3 dead governance + dead api/runtime.js | L1/D.3 | ✅ completed | `311f44a` |
| — | doc tail (R1.1 divergence) | — | ✅ removed | (this commit) |

**Remaining manual (outside code):** rotate leaked `OPENROUTER_API_KEY` and PG password
(old values in git history since `380a777`, 2026-06-09). After rotation — update `.env`.

**Deferred:** D.2 (linear projection removal, blocks frontend), D.4 (circular dependencies,
after K.4), D.5 (missing docs) — see "Deferred" section above.

---

*Date: 2026-06-27. Releases A/B/C closed. Today — S.1 (security), D.3 (L1 cleanup), D.1 (verified).
Tests: 381 passing. Based on `docs-claude/06_Roadmap.md` (Long-term) and `04_Migration_Plan.md` (Step 12).*
