# Fix: Video Stale-Lease False Positive (audit c8b79f6)

**Date:** 2026-08-28
**Incident:** ~86 duplicate video dispatches in 14h due to live renewed leases
flagged as stale every ~27 min.
**Root cause:** `metadata.started_at` never updated by renewal → age check
falsely kills long-running jobs.

---

## Root Cause

`renewLeaseIfOwner` extends the lease key's Redis TTL every 30s while the
owner is alive, but **never touches `metadata.started_at`**. The old
`checkStaleDispatchLeases` (reconciliation) and `shouldSkipDispatch`
(dispatch-engine) both used `started_at` age against a threshold of
`0.9 × LEASE_TTL` to decide staleness. For a video lease with TTL=30min,
that threshold is 27 min — but video jobs legitimately take up to 60 min.

Consequence: every ~27 min, the reconciliation engine (or the
shouldSkipDispatch gate) flagged the healthy dispatch as stale, released the
lease, marked the scene dirty, and triggered a duplicate re-dispatch. The
worker received a new GPU job each time, producing ~86 copies in 14h.

A secondary bug: `LEASE_TOTAL_TTLS` was hardcoded separately in
`lease-manager.js` and had drifted for audio (900s vs. 1860s in
`runtime-config.js`), causing renewal to pin audio leases to a shorter TTL
than intended.

---

## Fix: TTL-Based Liveness

The canonical liveness signal of a dispatch is the **remaining TTL of its
lease key**, NOT `metadata.started_at`.

### How it works

1. `renewLeaseIfOwner` re-pins the lease key's TTL to
   `LEASE_TOTAL_TTLS[stage] + LEASE_RENEWAL_TTL_ADD` every 30s while the
   owner is alive.
2. `isLeaseStale(ttl, stage)` returns `true` only when the remaining TTL has
   decayed below `getRenewalTargetTtlS(stage) - STALE_LEASE_GRACE_S` (10 min
   grace window = 20 missed renewals).
3. Both `checkStaleDispatchLeases` and `shouldSkipDispatch` now use
   `redis.ttl(leaseKey)` + `leaseManager.isLeaseStale()` — identical logic.

A live long-running job (even 60-min video) is never flagged stale because its
TTL stays near the renewal target. A dead owner (crash/restart) is detected
within the grace window, and the lease auto-expires regardless — no eternal
lease after restart.

### Key numbers

| Parameter                | Value   | Rationale                          |
|--------------------------|---------|-------------------------------------|
| `STALE_LEASE_GRACE_S`    | 600s    | 10 min = 20 missed 30s renewals     |
| `LEASE_RENEWAL_TTL_ADD`  | 180s    | 3 min buffer on each renewal pin    |
| Video renewal target     | 1980s   | 1800s (TTL) + 180s                  |
| Stale threshold (video)  | 1380s   | 1980s - 600s = 23 min remaining     |

---

## Files Changed

| File                                         | Change                                               |
|----------------------------------------------|------------------------------------------------------|
| `backend/src/runtime/lease-manager.js`       | `LEASE_TOTAL_TTLS` from runtime-config; `isLeaseStale`, `getRenewalTargetTtlS`, `STALE_LEASE_GRACE_S` |
| `backend/src/runtime/reconciliation-engine.js` | `checkStaleDispatchLeases` uses TTL; `applyFix RELEASE_STALE_LEASE` uses `cancelActiveDispatch` + `clearHubDispatches` |
| `backend/src/runtime/dispatch-engine.js`     | `shouldSkipDispatch` uses TTL; stale recovery uses `cancelActiveDispatch` |
| `backend/tests/mocks/redis-mock.js`         | TTL tracking via `expiries` Map; `ttl()`, `expire()`, `del()` with expiry cleanup; renewal Lua eval branch |
| `backend/tests/stale-lease-semantics.test.js`| **New** — 16 tests (unit + integration)              |
| `backend/tests/reconciliation-engine.test.js`| 10 new tests (TTL-based detection + applyFix + hub dedup purge) |
| `backend/tests/stage-dispatch-lifecycle.test.js` | 1 new regression test (DIRTY abort = zero GPU jobs) |

---

## Tests

**1800 passing, 0 failing** (mocha `--exit`).

### New test coverage

- `isLeaseStale` unit tests: key gone (-2), no expiry (-1), below/above
  threshold, all stages.
- `shouldSkipDispatch` integration: 20-min-old renewed → lease_active; no
  lease → none; TTL decayed → stale_lease.
- `renewLeaseIfOwner` integration: renewal re-pins TTL to target.
- Marathon renewal: 20+ min continuous renewal never flips stale.
- Queued/offline GPU: renewed lease with long elapsed time stays not-stale.
- `checkStaleDispatchLeases`: live 45-min video → not stale; stopped
  renewals → stale_dispatch_lease returned.
- `applyFix RELEASE_STALE_LEASE`: releases quota, marks dirty, re-activates;
  live renewed lease not released (defense in depth).
- Hub dedup purge: `clearHubDispatches` called with cancelled dispatch IDs.
- Old-fix regression (CASE B): DIRTY → generating rejected; executor aborts
  with zero GPU jobs sent.

---

## Hub Dedup Assessment

`gpu-hub.js:283-285` scopes dedup to `dispatch_id`:
`dedup:${params.dispatch_id}`. Each new dispatch gets a new ID, so dedup does
not block re-dispatch. The fix adds `clearHubDispatches` to
`applyFix RELEASE_STALE_LEASE` so cancelled dispatch IDs' hub copies are
purged — preventing accumulation. This is a defensive layer; the primary
protection is now the TTL-based liveness preventing false positives.

Status: **evaluated, not changed**. The existing `dispatch_id`-scoped dedup
is architecturally correct. The fix eliminates the root cause of
accumulation (false-positive stale detection) rather than fighting symptoms
at the hub layer.

---

## What Was NOT Changed

- ComfyUI worker (no concurrency fixes)
- worker-cleaner (not in scope)
- Old retry/circuit-breaker mechanics
- Hub dedup logic (evaluated, documented as correct)
