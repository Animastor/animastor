# PR: Orchestrator Facade — Single State Arbiter (Releases A/B/C + security/cleanup)

**Branch:** `feat/orchestrator-facade` → `master`
**Tests:** 381 passing, 0 failing
**Net diff:** +1.9k / −13.7k LOC (most deletions — dead governance cluster)

---

## What and Why

This branch closes the audit diagnosis: the system had **7 state writers, 3 stores, and 3
definitions of "ready"**. Here they are consolidated to **a single arbiter** (Orchestrator facade) with PG as
lifecycle canon, Redis and disk as derivatives. Plus the overdue security debt is closed and
dead code is removed. Principle: each step is autonomous, the project deploys after any commit.

Corresponds to plan `docs-claude/04_Migration_Plan.md`: Releases **A** (stop the bleeding),
**B** (single source of truth), **C** (single owner), partially **D** (cleanup).

---

## By Blocks

### Release A — critical quota/completion bugs
- **C4** `/gpu/task/result` idempotency (`SET NX` by `job_id+build_id`) — `d804a77`
- **C1** single quota release owner (`markDispatchCompleted`) — `4e007e2`
- **M2** atomic quotas (Lua EVAL) — `636da04`

### Release B — single truth PG↔Redis
- **C2** write `scene_assets.status='ready'` to PG — `cf0a48a`
- **C3** two registries separated by name — `5182455`
- **§5.1** per-asset `GENERATING` at dispatch — `f0b81de`
- **M1** atomic per-asset RMW (HSET/HGETALL) — `1a0867d`

### Release C — single state owner
- **Step 8** Orchestrator facade (`markDirty/planScene/beginStage/completeStage/reconcile`) — `a092f44`
- **M5** all writers through facade: P2 (`5d5e1a3`), P4/P5/P6 (`2807a38`),
  linear-state L1–L7 → `deriveLinearState` (`3562778`…`cadad04`)
- **M3** disk as fact, not decision: version-gate before disk-based `ready` — `91f104f`, `cc7d706`

### Security + Observability + Cleanup
- **S.1 / N.4** secrets from `docker-compose.yml` → gitignored `.env` (+ `.env.example`) — `6dca53a`
  ⚠️ **rotation required** for leaked key/password (in git history since `380a777`)
- **O2** Prometheus metrics (quota/lease-age/tick-duration) — `40acaf4`
- **D.3 / L1** dead governance cluster + dead `api/runtime.js` removed;
  `runtime/`: 37 → 21 modules, no broken `require` remaining — `311f44a`

---

## Verification (smoke)
1. TXT import → bootstrap → one chapter reaches `video=ready`.
2. Player plays scene (audio + image + video).
3. `GET /api/v1/debug/runtime/quotas` — counters return to 0 after idle.
4. force-regen: text edit → old file on disk does NOT cancel regeneration (M3).
5. Restart + flush Redis: recovery from PG, no mass regeneration.

## Invariant
`grep -rn "setAssetState" backend/src` → writes only within orchestrator path.

## After merge (outside this PR)
- **Rotate** `OPENROUTER_API_KEY` + PG password (S.1, manual step).
- D.2 (linear projection removal, blocks frontend), D.4 (circular dependencies),
  D.5 (missing docs) — separate PRs.
