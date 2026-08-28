// ======================================================
// Stale-lease semantics — regression tests
// ======================================================
// Fix for docs/03-audit/video-retry-fix/video-retry-forensic-audit-2026-08-28.md
// (audit c8b79f6): checkStaleDispatchLeases()/shouldSkipDispatch() decided
// liveness from metadata.started_at age, but lease renewal never refreshes
// started_at. A live, continuously renewed video dispatch was declared stale
// at 27 min (0.9 × 30-min lease TTL) while the backend itself dispatches video
// with a 60-min timeout → RELEASE_STALE_LEASE → markDirty → re-dispatch with a
// new dispatch_id every ~28 min → ~86 duplicate hub copies in 14 h.
//
// New semantics: the canonical liveness signal is the lease key's REMAINING
// TTL (renewal keeps it pinned to the renewal target). started_at age is
// irrelevant. These tests pin that contract.

const { expect } = require('chai');
const config = require('../src/config/runtime-config');
const leaseManager = require('../src/runtime/lease-manager');
const dispatchEngine = require('../src/runtime/dispatch-engine');
const { createMockRedis } = require('./mocks/redis-mock');

const B = 'test_book', C = 'ch-1', S = 'sc-1';

// Set up a real lease + metadata pair exactly like dispatchStage does, but with
// a controllable started_at so we can simulate an "old" dispatch.
async function seedDispatch(redis, stage, dispatchId, startedAtAgoMs) {
    const lease = await dispatchEngine.acquireStageLease(redis, B, C, S, stage);
    expect(lease.acquired).to.equal(true);
    const metadata = dispatchEngine.createDispatchMetadata(dispatchId, stage, 'scheduler', {
        leaseKey: lease.leaseKey,
        leaseToken: lease.token,
        quotaOwned: true,
    });
    metadata.started_at = Date.now() - startedAtAgoMs;
    await dispatchEngine.setDispatchMetadata(redis, B, C, S, stage, metadata);
    return lease;
}

describe('stale-lease semantics (audit c8b79f6 fix)', () => {

    // ── Invariants of the new source of truth ────────────────────────────
    describe('lease-manager constants', () => {
        it('LEASE_TOTAL_TTLS is unified with runtime-config LEASE_TTL_S', () => {
            // A single registry must drive both the initial acquire TTL and the
            // renewal target — no second hardcoded copy to drift.
            expect(leaseManager.LEASE_TOTAL_TTLS.audio).to.equal(config.LEASE_TTL_S.AUDIO);
            expect(leaseManager.LEASE_TOTAL_TTLS.image).to.equal(config.LEASE_TTL_S.IMAGE);
            expect(leaseManager.LEASE_TOTAL_TTLS.video).to.equal(config.LEASE_TTL_S.VIDEO);
        });

        it('renewal target = total TTL + renewal add', () => {
            for (const stage of ['audio', 'image', 'video']) {
                expect(leaseManager.getRenewalTargetTtlS(stage))
                    .to.equal(leaseManager.LEASE_TOTAL_TTLS[stage] + leaseManager.LEASE_RENEWAL_TTL_ADD);
            }
        });

        it('grace window covers the pre-first-renewal gap', () => {
            // A fresh lease (TTL = total TTL, first renewal ~5 s later) must NOT
            // be stale: grace > renewal-add + restart delay.
            const freshGap = leaseManager.LEASE_RENEWAL_TTL_ADD + leaseManager.RESTART_DELAY_MS / 1000;
            expect(leaseManager.STALE_LEASE_GRACE_S).to.be.above(freshGap);
        });
    });

    // ── isLeaseStale unit semantics ──────────────────────────────────────
    describe('isLeaseStale', () => {
        const video = 'video';
        const target = leaseManager.getRenewalTargetTtlS(video);

        it('a pinned (just-renewed) lease is NOT stale', () => {
            expect(leaseManager.isLeaseStale(target, video)).to.equal(false);
        });

        it('a fresh lease (total TTL, pre-first-renewal) is NOT stale', () => {
            expect(leaseManager.isLeaseStale(leaseManager.LEASE_TOTAL_TTLS[video], video)).to.equal(false);
        });

        it('a lease decayed past the grace window IS stale', () => {
            expect(leaseManager.isLeaseStale(target - leaseManager.STALE_LEASE_GRACE_S - 1, video)).to.equal(true);
        });

        it('a lease inside the grace window is NOT yet stale', () => {
            expect(leaseManager.isLeaseStale(target - leaseManager.STALE_LEASE_GRACE_S + 30, video)).to.equal(false);
        });

        it('a lease without expiry (-1) is treated as stale (broken)', () => {
            expect(leaseManager.isLeaseStale(-1, video)).to.equal(true);
        });

        it('a gone key (-2) is not "stale" (nothing to recover)', () => {
            expect(leaseManager.isLeaseStale(-2, video)).to.equal(false);
            expect(leaseManager.isLeaseStale(null, video)).to.equal(false);
        });
    });

    // ── Liveness is TTL, never started_at ────────────────────────────────
    describe('shouldSkipDispatch: renewed lease is never stale by age', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('27+ min old (started_at) but renewed lease → lease_active, not stale', async () => {
            const lease = await seedDispatch(redis, 'video', 'dispatch-alive', 28 * 60 * 1000);
            // Simulate the renewal timer keeping the TTL pinned at the target.
            const renewed = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
            expect(renewed.renewed).to.equal(true);

            const verdict = await dispatchEngine.shouldSkipDispatch(redis, B, C, S, 'video');
            expect(verdict.skip).to.equal(true);
            expect(verdict.reason).to.equal('lease_active');
        });

        it('video job alive 45 min into a 60-min timeout → lease_active (no re-dispatch)', async () => {
            const lease = await seedDispatch(redis, 'video', 'dispatch-long', 45 * 60 * 1000);
            await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);

            const verdict = await dispatchEngine.shouldSkipDispatch(redis, B, C, S, 'video');
            expect(verdict.reason).to.equal('lease_active');
        });

        it('renewals stopped → TTL decayed → stale_lease (recovery allowed)', async () => {
            const lease = await seedDispatch(redis, 'video', 'dispatch-dead', 5 * 60 * 1000);
            // Owner died: no renewal; the TTL decayed well below the grace window.
            const decayed = leaseManager.getRenewalTargetTtlS('video') - leaseManager.STALE_LEASE_GRACE_S - 60;
            await redis.expire(lease.leaseKey, decayed);

            const verdict = await dispatchEngine.shouldSkipDispatch(redis, B, C, S, 'video');
            expect(verdict.skip).to.equal(true);
            expect(verdict.reason).to.equal('stale_lease');
            expect(verdict.currentToken).to.equal(lease.token);
        });

        it('no lease → proceed with dispatch', async () => {
            const verdict = await dispatchEngine.shouldSkipDispatch(redis, B, C, S, 'video');
            expect(verdict.skip).to.equal(false);
            expect(verdict.reason).to.equal('no_lease');
        });
    });

    // ── Renewal keeps a lease alive indefinitely ─────────────────────────
    describe('renewLeaseIfOwner pins TTL to the renewal target', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('renewal raises TTL to the target and the lease stays not-stale', async () => {
            const lease = await seedDispatch(redis, 'video', 'dispatch-renew', 0);
            const before = await redis.ttl(lease.leaseKey);
            expect(before).to.equal(leaseManager.LEASE_TOTAL_TTLS.video);

            const renewed = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
            expect(renewed.renewed).to.equal(true);

            const after = await redis.ttl(lease.leaseKey);
            expect(after).to.equal(leaseManager.getRenewalTargetTtlS('video'));
            expect(leaseManager.isLeaseStale(after, 'video')).to.equal(false);
        });

        it('renewal with a wrong token does NOT extend the lease', async () => {
            const lease = await seedDispatch(redis, 'video', 'dispatch-owner', 0);
            const renewed = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, 'dispatch-impostor');
            expect(renewed.renewed).to.equal(false);
            expect(renewed.reason).to.equal('ownership_lost');
        });

        it('many renewals with an old started_at never flip the lease stale', async () => {
            // Simulate a long-running dispatch: started 50 min ago, renewed
            // continuously. At no point may the lease be considered stale.
            const lease = await seedDispatch(redis, 'video', 'dispatch-marathon', 50 * 60 * 1000);
            for (let i = 0; i < 100; i++) {
                const r = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
                expect(r.renewed).to.equal(true);
                const ttl = await redis.ttl(lease.leaseKey);
                expect(leaseManager.isLeaseStale(ttl, 'video')).to.equal(false);
            }
        });
    });

    // ── Healthy renewed lease at real job durations (30 / 60 min) ────────
    describe('healthy renewed video lease at real job durations', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        for (const minutes of [30, 60]) {
            it(`renewed video lease ${minutes} min old → NOT stale (lease_active)`, async () => {
                const lease = await seedDispatch(redis, 'video', `dispatch-${minutes}m`, minutes * 60 * 1000);
                // Renewal timer keeps the TTL pinned regardless of started_at age.
                const renewed = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
                expect(renewed.renewed).to.equal(true);

                const ttl = await redis.ttl(lease.leaseKey);
                expect(leaseManager.isLeaseStale(ttl, 'video')).to.equal(false);

                const verdict = await dispatchEngine.shouldSkipDispatch(redis, B, C, S, 'video');
                expect(verdict.skip).to.equal(true);
                expect(verdict.reason).to.equal('lease_active');
            });
        }
    });

    // ── Exact stale-window boundary, all stages ──────────────────────────
    describe('exact stale-window boundary (audio/image/video)', () => {
        for (const stage of ['audio', 'image', 'video']) {
            it(`${stage}: stale exactly when TTL < target - grace (strict)`, () => {
                const target = leaseManager.getRenewalTargetTtlS(stage);
                const grace = leaseManager.STALE_LEASE_GRACE_S;

                // Exactly at the boundary (target - grace): NOT stale (strict <).
                expect(leaseManager.isLeaseStale(target - grace, stage)).to.equal(false);
                // One second below the boundary: stale.
                expect(leaseManager.isLeaseStale(target - grace - 1, stage)).to.equal(true);
                // Healthy pinned lease (just renewed / mid-cycle): not stale.
                expect(leaseManager.isLeaseStale(target, stage)).to.equal(false);
                expect(leaseManager.isLeaseStale(target - 30, stage)).to.equal(false);
            });
        }
    });

    // ── All stages: healthy renewed vs renewals-stopped (no video-only fix) ─
    describe('audio/image parity — the video fix must not regress other stages', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        for (const stage of ['audio', 'image']) {
            it(`${stage}: renewed lease (old started_at) → lease_active`, async () => {
                const lease = await seedDispatch(redis, stage, `dispatch-${stage}-alive`, 40 * 60 * 1000);
                await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
                const verdict = await dispatchEngine.shouldSkipDispatch(redis, B, C, S, stage);
                expect(verdict.reason).to.equal('lease_active');
            });

            it(`${stage}: renewals stopped → TTL decayed → stale_lease`, async () => {
                const lease = await seedDispatch(redis, stage, `dispatch-${stage}-dead`, 5 * 60 * 1000);
                const decayed = leaseManager.getRenewalTargetTtlS(stage) - leaseManager.STALE_LEASE_GRACE_S - 60;
                await redis.expire(lease.leaseKey, decayed);
                const verdict = await dispatchEngine.shouldSkipDispatch(redis, B, C, S, stage);
                expect(verdict.reason).to.equal('stale_lease');
                expect(verdict.currentToken).to.equal(lease.token);
            });
        }
    });

    // ── Backend restart → lease never becomes eternal ────────────────────
    describe('backend restart → lease never becomes eternal', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('renewal re-pins to a BOUNDED constant: TTL does not grow across renewals', async () => {
            const lease = await seedDispatch(redis, 'video', 'dispatch-bounded', 0);
            const target = leaseManager.getRenewalTargetTtlS('video');
            for (let i = 0; i < 50; i++) {
                const r = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
                expect(r.renewed).to.equal(true);
                // Re-pinned to the SAME constant every time — never accumulates,
                // so a lease can never be extended into an "eternal" one.
                expect(await redis.ttl(lease.leaseKey)).to.equal(target);
            }
        });

        it('after acquire and after renewal the lease TTL is finite (Redis auto-expires it)', async () => {
            const lease = await seedDispatch(redis, 'video', 'dispatch-finite', 0);
            expect(await redis.ttl(lease.leaseKey)).to.be.above(0); // not -1
            await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
            expect(await redis.ttl(lease.leaseKey)).to.be.above(0); // still finite
        });

        it('owner gone after restart: TTL decays past grace → detected stale (finite TTL then expires)', async () => {
            const lease = await seedDispatch(redis, 'video', 'dispatch-restart', 0);
            await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
            const target = leaseManager.getRenewalTargetTtlS('video');
            // Restart kills the in-memory renewal timer; TTL decays past grace.
            await redis.expire(lease.leaseKey, target - leaseManager.STALE_LEASE_GRACE_S - 1);
            const ttl = await redis.ttl(lease.leaseKey);
            expect(ttl).to.be.above(0);                              // finite → will auto-expire
            expect(leaseManager.isLeaseStale(ttl, 'video')).to.equal(true); // detected stale
        });
    });

    // ── TTL = -1 (lease without expiry) policy ───────────────────────────
    describe('TTL = -1 (lease without expiry) is recovered as stale', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('shouldSkipDispatch flags a no-expiry lease as stale_lease', async () => {
            // Hand-craft a lease with NO expiry (TTL=-1): a broken state that
            // would never auto-expire, so it must be surfaced for recovery.
            const leaseKey = dispatchEngine.getLeaseKey(B, C, S, 'video');
            await redis.set(leaseKey, 'dispatch-noexpiry-token'); // no EX → TTL=-1
            expect(await redis.ttl(leaseKey)).to.equal(-1);

            const verdict = await dispatchEngine.shouldSkipDispatch(redis, B, C, S, 'video');
            expect(verdict.skip).to.equal(true);
            expect(verdict.reason).to.equal('stale_lease');
        });
    });
});
