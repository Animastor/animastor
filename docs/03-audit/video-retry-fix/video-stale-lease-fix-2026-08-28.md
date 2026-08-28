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

1. `renewLeaseIfOwner` **re-pins** the lease key's TTL to the fixed target
   `LEASE_TOTAL_TTLS[stage] + LEASE_RENEWAL_TTL_ADD` every 30s while the owner
   is alive (Lua `EXPIRE key, target`). It does **not** add to the remaining
   TTL, so the TTL is bounded above and can never grow into an "eternal" lease.
2. `isLeaseStale(ttl, stage)` returns `true` only when the remaining TTL has
   decayed below `getRenewalTargetTtlS(stage) - STALE_LEASE_GRACE_S`.
3. Both `checkStaleDispatchLeases` and `shouldSkipDispatch` use the SAME
   predicate: `redis.ttl(leaseKey)` + `leaseManager.isLeaseStale()` — they
   cannot diverge.

### Exact semantics (verified per stage)

Formula: `stale ⇔ remainingTTL < getRenewalTargetTtlS(stage) - STALE_LEASE_GRACE_S`.

| Stage | Base TTL (`LEASE_TTL_S`) | Renewal target (`+180`) | Stale threshold (`target−600`) |
|-------|--------------------------|--------------------------|---------------------------------|
| audio | 1860s (31 min)           | 2040s                    | 1440s                           |
| image | 1200s (20 min)           | 1380s                    | 780s                            |
| video | 1800s (30 min)           | **1980s**                | 1380s                           |

(`LEASE_TTL_S.AUDIO = ceil(STALL_FAILSAFE_MS/1000)+60 = 1860s` at the default
`GPU_TIMEOUT_MS=600000`; image/video are fixed 20/30 min.)

The six cases:

1. **Healthy under normal renewal** — renewal re-pins TTL every 30s, so the
   remainder stays in `[target−30, target]`, never below `target−grace`. The
   lease is never stale however long it runs (30- or 60-min video included).
   `started_at` is irrelevant.
2. **Renewal lost (owner died AFTER at least one renewal)** — TTL decays from
   `target`; stale exactly when it drops below `target−grace`, i.e.
   `STALE_LEASE_GRACE_S` (600s ≈ 10 min) after the last successful renewal
   (±30s from the renewal cycle phase).
3. **Backend restart** — in-memory renewal timers are lost, no renewal happens,
   TTL decays and the lease is either detected stale within the grace window or
   auto-expires by TTL. No eternal lease (TTL is always finite).
4. **Truly hung dispatch (backend alive, renewal ticking, GPU job stuck)** — the
   lease stays **healthy** by design: renewal is tied to backend-process liveness,
   not job progress. A hung job is caught by the separate stall-failsafe
   (`checkStalledAudio/VideoScenes`, driven by `last_chunk_at`/`last_group_at`),
   NOT by lease TTL.
5. **TTL = −1 (key exists, no expiry)** — treated as **stale** (defensive): a
   lease with no expiry would never auto-expire, so it is force-recovered. Cannot
   arise in production because acquire/renewal always set `EX`.
6. **TTL = −2 (key gone)** — **not** stale (nothing to recover); callers treat it
   as "no lease" and proceed to dispatch.

> **Note on "10 min".** `STALE_LEASE_GRACE_S = 600s` means exactly 10 min without
> a successful renewal only **after the first successful renewal** (when TTL has
> been raised to `target`). If the owner dies **before** the first renewal, TTL is
> still the base `LEASE_TOTAL_TTLS = target − 180`, so detection happens after
> `grace − 180 = 420s` (7 min). This is a consequence of acquire setting the base
> TTL, not a bug.

### Key numbers

| Parameter                | Value   | Rationale                          |
|--------------------------|---------|-------------------------------------|
| `RENEWAL_INTERVAL_MS`    | 30s     | renewal cadence                     |
| `LEASE_RENEWAL_TTL_ADD`  | 180s    | re-pin buffer above base TTL (NOT additive) |
| `STALE_LEASE_GRACE_S`    | 600s    | 10 min without renewal (post-first-renewal) |
| Video renewal target     | 1980s   | 1800s (base) + 180s                 |
| Stale threshold (video)  | 1380s   | 1980s − 600s = 23 min remaining     |

---

## Files Changed

| File                                         | Change                                               |
|----------------------------------------------|------------------------------------------------------|
| `backend/src/runtime/lease-manager.js`       | `LEASE_TOTAL_TTLS` from runtime-config; `isLeaseStale`, `getRenewalTargetTtlS`, `STALE_LEASE_GRACE_S` |
| `backend/src/runtime/reconciliation-engine.js` | `checkStaleDispatchLeases` uses TTL; `applyFix RELEASE_STALE_LEASE` uses `cancelActiveDispatch` + `clearHubDispatches` |
| `backend/src/runtime/dispatch-engine.js`     | `shouldSkipDispatch` uses TTL; stale recovery uses `cancelActiveDispatch` |
| `backend/tests/mocks/redis-mock.js`         | TTL tracking via `expiries` Map; `ttl()`, `expire()`, `del()` with expiry cleanup; renewal Lua eval branch |
| `backend/tests/stale-lease-semantics.test.js`| **New** — 29 tests (unit + integration)              |
| `backend/tests/reconciliation-engine.test.js`| 12 new tests (TTL-based detection + applyFix + hub dedup purge + cross-consistency) |
| `backend/tests/stage-dispatch-lifecycle.test.js` | 1 new regression test (DIRTY abort = zero GPU jobs) |

---

## Tests

**1815 passing, 0 failing** (mocha `--exit`).

### New test coverage

- `isLeaseStale` unit tests: key gone (-2), no expiry (-1), below/above
  threshold, all stages.
- **Exact stale-window boundary** per stage: stale strictly when
  `TTL < target − grace` (at boundary → not stale; one second below → stale).
- **Healthy renewed lease at real durations**: 30-min and 60-min video → not
  stale (`lease_active`).
- **Audio/image parity**: renewed → `lease_active`; renewals stopped →
  `stale_lease` (the video fix does not regress other stages).
- **Backend restart / no eternal lease**: renewal re-pins to a BOUNDED constant
  (TTL never grows across 50 renewals); TTL always finite; owner-gone TTL decay
  → detected stale.
- **TTL = −1** (no expiry): flagged stale by both `shouldSkipDispatch` and
  `checkStaleDispatchLeases` (recovered, never eternal).
- **Cross-consistency**: `checkStaleDispatchLeases` and `shouldSkipDispatch`
  return matching verdicts for the same lease state (shared `isLeaseStale`).
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

---

## Follow-up verification (post-commit 37e21c2)

Re-verified the math for **all stages** against `runtime-config.js` and pinned
the exact semantics above. Corrections made in this pass:

- **Misleading comment/log fixed**: `LEASE_RENEWAL_TTL_ADD` was commented
  "Add 3 minutes to TTL on renewal" and logged as "ttl extended by 180s". Both
  were wrong — renewal **re-pins** TTL to the fixed target (Lua `EXPIRE key,
  target`), it does not add. Comment and log now say "re-pinned to <target>s".
- **Grace-window semantics made precise**: "10 min" is exact only after the
  first successful renewal; pre-first-renewal owner death detects in 420s
  (7 min). Documented, not masked.
- **Regression tests added** (15): exact stale boundary per stage, 30/60-min
  healthy video, audio/image parity, bounded renewal target (no eternal lease),
  TTL=−1 recovery, and `checkStaleDispatchLeases`/`shouldSkipDispatch`
  cross-consistency.
- Confirmed the prior fix is intact: `started_at` is not used for liveness;
  both call sites use the canonical Redis remaining TTL via the shared
  `isLeaseStale`; stale recovery goes through `cancelActiveDispatch`;
  `LEASE_TOTAL_TTLS` is sourced from `runtime-config.js`.
