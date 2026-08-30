# 06. Development Roadmap — Animastor (6 Months)

> Role: lead architect for the next 6 months.
> Based on `01_System_Map.md`, `02_GPT_Audit.md`, `03_Orchestrator.md`, `04_Migration_Plan.md`, `05_Documentation_Audit.md`.
> Date: 2026-06-26.

---

## Scope and Principles (What Sets the Entire Map)

This document **adds no new features** and **introduces no new technologies**.
Stack is fixed: Node/Express, PostgreSQL, Redis, ComfyUI workers, Android/Kotlin.
Project serves **small number of users** — so the criterion is not scalability,
but **reliability, maintainability, and reduced bug count** (directly from `02 §context`).

Three prioritization rules for all 6 months:

1. **Stop the bleeding first, then treat the cause.** Critical bugs (C1–C4)
   are distorting state today — they come first, before any architecture.
2. **Each step is autonomous, verifiable, and revertible.** No big rewrites;
   after any step the project deploys (principle from `04`).
3. **Only change the decision layer.** GPU Hub, queues, workers, ComfyUI, generators,
   AI analysis, chat, and player — **untouched** (`03 §8`). This reduces regression risk.

Cross-cutting readiness criterion after each step (smoke test, from `04`):
TXT import → bootstrap → one chapter reaches `video=ready`; player plays scene;
`GET /api/v1/debug/runtime/quotas` shows counters returning to 0 after idle.

---

## ⏱ Nearest Week — "Stop the Bleeding" + Security

Week's goal: remove findings that **currently distort state and overload GPU**,
and close the single explicit security risk. Nothing architectural — only targeted fixes
with tests. This is `04` Release A plus secrets.

### Н.0 — Safety Net (Tests on Current Behavior)
- **What:** fix happy-path tests (`04 Step 0`): scene goes through audio→image→video
  to `ready`; callback releases lease; quota returns to 0. Don't touch production code.
- **Why first:** without this net any next fix risks silently introducing regression.
- **Risk:** low. Don't lock broken quota behavior in tests — test only happy path.

### Н.1 — Idempotent `/gpu/task/result` (C4)
- **What:** dedup by `(job_id, build_id)` via `SET NX EX` before `handleTaskResult`
  (`04 Step 1`). Repeat callback/retry from Hub (up to 5 times) and parallel IUs no longer
  trigger completion twice.
- **Closes:** C4 — repeat completions, double auto-slide, unnecessary GPU tasks.
- **Risk:** low. `build_id` in key protects legitimate regeneration.

### Н.2 — Single Quota Release Owner (C1)
- **What:** leave `releaseQuota` **only** in `markDispatchCompleted`, remove from
  `scene-callbacks.js` (`04 Step 2`). One `acquire` → one `release`.
- **Closes:** C1 — double decrement, quota drift, GPU limit overruns.
- **Risk:** medium. Strictly **after Н.1**. Audit all completion branches in `task-handler.cjs`,
   otherwise slot "leaks" upward.

### Н.3 — Atomic Quotas (M2)
- **What:** `acquireQuota` → `INCR`-then-check-then-`DECR` (or Lua), instead of GET+INCR
  (`04 Step 3`). Closes race on off-tick paths (callbacks, force-regen).
- **Closes:** M2.
- **Risk:** low. Guarantee `DECR` on failure (try/Lua).

### Н.4 — Remove Secrets from Repository (`01 §8.11`)
- **What:** move production `OPENROUTER_API_KEY` and PG password from `docker-compose.yml` to `.env`
  (not committed), add `.env.example`, **rotate leaked key and password**.
- **Why this week:** only item across all five documents with direct compromise risk;
  costs little, can't wait.
- **Risk:** low technically; organizationally — coordinate key rotation.

**Week result:** backpressure stops drifting, double completions disappear, secret
no longer in git. Quota counters return to 0; `counter-reconciliation` in logs stops
finding drift (`totalDrift: 0`).

---

## 📅 Nearest Month — "Single Truth"

Month's goal: eliminate **"double truth" Redis↔PG** and state update loss — the root
of most observed "why does it regenerate everything again" and "why is the scene stuck."
This is `04` Release B (steps 4–7) plus beginning of documentation work.
Architecture not introduced yet — preparing ground: after the month PG honestly reflects
"ready" and state isn't lost in races.

### М.1 — Write `scene_assets.status='ready'` in PG (C2)
- **What:** in completion callbacks call `markReady(...)` (function exists but not called) +
  set `scene_content_version`/`scene_audio_config_version` (`04 Step 4`).
- **Closes:** C2 — PG stops being "half-empty canon," version-stale detection starts
  working on current data.
- **Risk:** medium. Accurate `asset_type ↔ version` mapping; test both directions
  (always-stale / never-stale).

### М.2 — Separate Two Registries by Name (C3)
- **What:** `storage/asset-registry.js` → `redisAssetCache`, `services/scene-asset-registry.js`
  → `pgAssetRepo` (or remove PG duplicate if М.1 moved everything to `scene-assets-repo`).
  Update `storage/index.js` (`04 Step 5`).
- **Closes:** C3 — trap of identical names with different signatures, source of C2.
- **Risk:** low but wide. Mechanical rename; caught by grep and tests.
  Strictly **after М.1**.

### М.3 — Introduce per-asset `GENERATING` (`03 §5.1`)
- **What:** in `execute*Dispatch` transition per-asset to `GENERATING` alongside linear
  `*_GENERATING` (`04 Step 6`). Duplicate protection stops relying solely on lease.
- **Closes:** gap `§5.1` — "canon" finally passes "in progress" phase.
- **Risk:** medium. Leave recovery on expired lease (`stale_lease` exists),
  so scene doesn't get stuck in `GENERATING` on worker death.

### М.4 — Atomic per-asset RMW (M1)
- **What:** migrate `setAssetState` from non-atomic JSON-RMW to Redis hash fields (`HSET`,
  field-atomic) or Lua (`04 Step 7`). Parallel audio/image callbacks stop overwriting
  each other.
- **Closes:** M1 — lost `READY` causing scene "hang."
- **Risk:** medium. Key format change → read both formats during rollout;
  sync with Lua in `markDirtyScenes`.

### М.5 — Documentation: Stop Propagating Wrong Facts
- **What:** fix `LLM_AUDIT_CONTEXT.md` and `DATA_FLOW.md` first (`05 §Priority 1–2`):
  rate limit 500 (not 100), lease TTL 15/20/30 (not 30/60/120), remove `sendVideo`, fix
  version-stale check location.
- **Why this month:** `LLM_AUDIT_CONTEXT` poisons every AI codebase analysis;
  `DATA_FLOW` is harmful exactly where we're now fixing lifecycle.
- **Risk:** low. Pure text fix, verified against code.

**Month result:** PG and Redis no longer "two truths," `READY` not lost in races, per-asset
model complete. Regression checks: after Redis flush + restart recovery sees `ready` from PG
and doesn't regenerate; parallel audio+image both preserve `ready`.

---

## 🗓 Nearest Three Months — "Single State Owner"

Quarter's goal: consolidate **seven state writers, three stores, and three "ready" definitions**
(`03 §13`) into **one arbiter** with narrow API. This is `04` Release C (steps 8–11) — most
valuable for reliability, but also most risky, so it comes only after bleeding bugs (week)
and "double truth" (month) are closed. Not a rewrite — introducing facade and gradual
writer migration.

### К.1 — Orchestrator Facade (5 Commands) (`03 §9`, `04 Step 8`)
- **What:** `orchestration/orchestrator.js` with commands `markDirty / planScene / beginStage /
  completeStage / failStage / reconcile`. At this step — **thin wrappers** over already-fixed
  (week/month) functions. Behavior unchanged, single entry point appears.
- **Risk:** medium by scope. Migrate consumers **one per PR**, under tests.

### К.2 — `planScene` as Pure Function (Part of M5) (`04 Step 9`)
- **What:** remove READY→DIRTY side-effect write from `shouldScheduleAssets`; move version-stale
  to `markDirty`. Scheduler only **reads**.
- **Closes:** first sign of blurred ownership — "decide and fix simultaneously" (`03 §2`).
- **Risk:** medium. Preserve same regeneration tick timing (don't add 5s lag).

### К.3 — Disk as Fact, Not Decision (M3) (`04 Step 10`)
- **What:** `sceneHasValidContent`, `restoreChunkStatusForScene`, `recoverIuImagesFromDisk`
  stop writing READY/DIRTY — return **fact** "file for buildId X exists" to `reconcile`,
  which compares with version and decides.
- **Closes:** M3 — force-regen cancelled by old file on disk.
- **Risk:** **high.** Behavioral change in recovery. Depends on М.1 (PG-ready).
  Restart/flush/force-regen scenario tests mandatory before rollout.

### К.4 — Consolidate All Writers to Orchestrator (M5) (`04 Step 11`)
- **What:** `startup-recovery`, `reconciliation-engine`, `scene-restoration`, `markDirtyScenes`
  call facade commands instead of direct writes; after — direct `setAssetState` outside orchestrator
  **removed** (invariant I1: single write point).
- **Closes:** M5 — nondeterministic writer conflicts, state "flickering."
- **Risk:** **high.** Final consolidation. Do **one writer per PR**
  (recovery → reconciliation → restoration → markDirty), after each full smoke + restart.

### К.5 — Sync Overview Documentation (`05 §Priority 3–6`)
- **What:** align `ARCHITECTURE.md`, `SYSTEM_OVERVIEW.md` with code (cross-cutting numbers); mark
  closed items in `ARCHITECTURAL_DEBT.md`, resolve internal contradiction in
  `ARCHITECTURAL_AUDIT_TODO.md`; add `03/04` to `docs/` as missing lifecycle section.
- **Why in quarter:** by then lifecycle rewritten — documentation captures actual
  state, not moving target.
- **Risk:** low.

**Quarter result:** single state transition owner, PG is lifecycle canon, Redis and disk are
derived. Invariant check: `grep -rn "setAssetState" backend/src` shows calls only inside
`orchestrator.js`; conflict test (callback READY vs version-stale) gives deterministic result,
scene doesn't flicker.

---

## 🔭 Long-Term Improvements (After Quarter)

Goal: remove accumulated dead weight and transitional layers, **reducing cognitive load**.
All of this is `04` Release D and Low-priority audit items. No new features; only removing
excess and solidifying what's been achieved. Do only when new paths from quarter are stable.

### Д.1 — Clean Up Dead Duplicate Limits (M4) (`04 Step 12`)
- **What:** remove `MAX_CONCURRENT_*`, `animastor:concurrent-*` keys, dead
  `incrementConcurrent/canScheduleStage`; switch `getMetrics` to real dispatch-engine counters.
- **Closes:** M4 — second "truth" about limits and false zeros in debug metrics.
- **Risk:** low. Before removal — grep for production calls.

### Д.2 — Remove Linear State Projection (L3)
- **What:** migrate player and debug endpoints to per-asset state, then remove
  `SceneState`/`syncLinearState`/`deriveLinearState`. Intentionally deferred in `04 §NOT doing`
  until player migration.
- **Closes:** L3 — dual state representation and desync window.
- **Risk:** medium. Affects frontend; do after Orchestrator stabilization.

### Д.3 — Remove Dead Governance and Broken `require` (L1)
- **What:** remove/archive 18 debug-only `runtime/` modules, five with `require`
  on non-existent files (mine for debug endpoints). Keep alive `circuit-breaker`,
  `retry-budget`, `fairness`.
- **Closes:** L1 — half the "smart" directory ballast and 500s on debug endpoints.
- **Risk:** low. Outside production path; verify reachability before removal.

### Д.4 — Untangle Cyclic Dependencies (L2)
- **What:** remove mass inline `require()` inside functions, untangling cycles
  orchestration↔runtime↔storage via interface. Do **after** К.4 — Orchestrator already
  provides natural boundary for untangling.
- **Closes:** L2 — hidden coupling and risk of partially initialized modules.
- **Risk:** medium. Targeted, under tests.

### Д.5 — Document Missing Sections (`05 §Missing`)
- **What:** write missing documents: backpressure/quotas/lease, per-asset vs linear,
  GPU callback idempotency, secrets/deployment. By then all describe
  stable reality.
- **Risk:** low. Solidification, not moving target.

---

## Horizon Map Summary

| Horizon | Release (`04`) | Steps | Closes | Main Effect |
|---|---|---|---|---|
| **Week** | A + security | Н.0–Н.4 | C1, C4, M2, secrets | Quotas don't drift, no double completions, key rotated |
| **Month** | B | М.1–М.5 | C2, C3, M1, §5.1 | PG = honest canon, state not lost in races |
| **3 Months** | C | К.1–К.5 | M3, M5, §2 | Single state owner, disk doesn't dictate lifecycle |
| **Long-term** | D + Low | Д.1–Д.5 | M4, L1, L2, L3 | Dead weight and transitional layers removed |

### Hard Dependencies (Must Not Violate)
- Н.2 (single release) — only **after** Н.1 (idempotency), otherwise slot leak.
- М.2 (registry) — **after** М.1 (decided who writes PG-ready).
- К.1–К.4 — **after** month: facade wraps already-fixed functions, not bugs.
- К.3 (disk-as-fact) — **after** М.1 (PG as truth anchor for `reconcile`).
- Д.2/Д.4 — **after** К.4 (Orchestrator as untangling boundary).

---

## What Consciously NOT Included in These 6 Months

Directly per "no new features, no chasing technologies":

- **No new features** — player, chat, AI analysis, connectors, workflows remain as-is.
- **No stack replacement** — GPU Hub, queues, workers, ComfyUI, generators untouched;
  they're stable (`03 §8`, `04 §NOT doing`).
- **No enterprise patterns** (sharding, Kafka, CQRS) — for small user count
  this is complexity against reliability (`02 §context`).
- **Scaling is not the goal.** Each map item reduces bug count or maintenance
  cost — nothing more.

---

## Summary

Main architectural diagnosis from audit: system tries to be distributed (leases, quotas,
governance, reconciliation, multi-writer recovery) where a single server would need **one
arbiter and one source of truth** (`02 §diagnosis`, `03 §13`). The 6-month map sequentially
removes this excess complexity: first fixes what's bleeding (week), then consolidates truth
to PG (month), then to single owner (quarter), and finally removes dead weight
(long-term).

Each step tied to proven finding (C/M/L), autonomous, verifiable by smoke test and
revertible by single PR. This is the chosen criterion: **reliability and maintainability
above everything else.**

---

*End of roadmap. All items backed by findings from documents 01–05; new features and
technologies intentionally excluded.*
