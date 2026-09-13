// ======================================================
// Counter Reconciliation Tests (B10 verification)
// ======================================================

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const counterReconciliation = require('../src/runtime/counter-reconciliation');

describe('Counter Reconciliation', () => {
    let redis;

    beforeEach(() => {
        redis = createMockRedis();
    });

    // ── correctCounterWithLua ─────────────────────────
    describe('correctCounterWithLua (B10 regression)', () => {
        it('corrects a drifted counter value', async () => {
            // Simulate drift: counter says 5, but only 3 leases exist
            await redis.set('animastor:runtime:active-audio', '5');

            const result = await counterReconciliation.correctCounterWithLua(redis, 'audio', 3);
            expect(result.success).to.equal(true);
            expect(result.action).to.equal('corrected');
            expect(result.old).to.equal('5');
            expect(result.new).to.equal('3');

            // Verify the counter was actually corrected
            const val = await redis.get('animastor:runtime:active-audio');
            expect(val).to.equal('3');
        });

        it('corrects when counter is zero but leases exist', async () => {
            // Drift: counter is 0, but lease scan finds 2
            // Actually the correct behavior is: counter is too LOW
            await redis.set('animastor:runtime:active-image', '0');

            const result = await counterReconciliation.correctCounterWithLua(redis, 'image', 2);
            expect(result.success).to.equal(true);
            expect(result.old).to.equal('0');
            expect(result.new).to.equal('2');

            const val = await redis.get('animastor:runtime:active-image');
            expect(val).to.equal('2');
        });

        it('corrects when counter key does not exist', async () => {
            const result = await counterReconciliation.correctCounterWithLua(redis, 'video', 1);
            expect(result.success).to.equal(true);
            expect(result.old).to.equal(null);

            const val = await redis.get('animastor:runtime:active-video');
            expect(val).to.equal('1');
        });

        it('B10 bug: ioredis null → "" no longer causes silent no-op', async () => {
            // This test verifies that the fix for B10 works:
            // Previously, correctCounterWithLua passed `null` as an "expected" guard arg,
            // which ioredis serialized to "" (truthy in Lua), causing the guard to
            // always fire and skip the SET. The guard was removed.
            await redis.set('animastor:runtime:active-audio', '10');

            const result = await counterReconciliation.correctCounterWithLua(redis, 'audio', 7);
            expect(result.success).to.equal(true);
            expect(result.old).to.equal('10');
            expect(result.new).to.equal('7');
        });
    });

    // ── getCounterWithDriftCheck ──────────────────────
    describe('getCounterWithDriftCheck', () => {
        it('reports no drift when counter matches lease count', async () => {
            const result = await counterReconciliation.getCounterWithDriftCheck(redis, 'audio');
            expect(result.stage).to.equal('audio');
            expect(result.leaseCount).to.equal(0);
            expect(result.counterValue).to.equal(0);
            expect(result.drift).to.equal(0);
            expect(result.correct).to.equal(true);
        });

        it('detects positive drift (counter > actual leases)', async () => {
            // Set counter higher with no leases
            await redis.set('animastor:runtime:active-audio', '3');

            const result = await counterReconciliation.getCounterWithDriftCheck(redis, 'audio');
            expect(result.drift).to.equal(3);
            expect(result.correct).to.equal(false);
            expect(result.counterValue).to.equal(3);
            expect(result.leaseCount).to.equal(0);
        });
    });

    // ── reconcileCounters ─────────────────────────────
    describe('reconcileCounters', () => {
        it('reports no corrections when counters are balanced', async () => {
            const report = await counterReconciliation.reconcileCounters(redis);

            expect(report.summary.correctedCount).to.equal(0);
            expect(report.summary.totalDrift).to.equal(0);
            for (const stage of ['audio', 'image', 'video']) {
                expect(report.stages[stage].corrected).to.equal(false);
                expect(report.stages[stage].drift).to.equal(0);
            }
        });

        it('corrects drifted counters across all stages', async () => {
            // Create drift: audio=2, image=3, video=1
            await redis.set('animastor:runtime:active-audio', '2');
            await redis.set('animastor:runtime:active-image', '3');
            await redis.set('animastor:runtime:active-video', '1');

            const report = await counterReconciliation.reconcileCounters(redis);

            // All 3 should be corrected to 0 (no leases in mock)
            expect(report.summary.correctedCount).to.equal(3);

            // Verify counters are corrected
            expect(await redis.get('animastor:runtime:active-audio')).to.equal('0');
            expect(await redis.get('animastor:runtime:active-image')).to.equal('0');
            expect(await redis.get('animastor:runtime:active-video')).to.equal('0');
        });

        it('corrects counter even with non-numeric initial value', async () => {
            await redis.set('animastor:runtime:active-audio', 'not-a-number');

            const report = await counterReconciliation.reconcileCounters(redis);
            // Counter should be corrected to 0 (no leases in mock)
            expect(report.stages.audio.corrected).to.equal(true);
            expect(await redis.get('animastor:runtime:active-audio')).to.equal('0');
        });
    });

    // ── countActiveLeasesByStage ──────────────────────
    describe('countActiveLeasesByStage', () => {
        it('returns 0 when no leases exist', async () => {
            const count = await counterReconciliation.countActiveLeasesByStage(redis, 'audio');
            expect(count).to.equal(0);
        });
    });

    // ── getCurrentCounter ────────────────────────────
    describe('getCurrentCounter', () => {
        it('returns 0 for missing key', async () => {
            const val = await counterReconciliation.getCurrentCounter(redis, 'audio');
            expect(val).to.equal(0);
        });

        it('returns stored integer value', async () => {
            await redis.set('animastor:runtime:active-audio', '42');
            const val = await counterReconciliation.getCurrentCounter(redis, 'audio');
            expect(val).to.equal(42);
        });
    });

    // ── manualCounterCorrection ───────────────────────
    describe('manualCounterCorrection', () => {
        it('sets counter to exact value', async () => {
            await redis.set('animastor:runtime:active-audio', '99');
            const result = await counterReconciliation.manualCounterCorrection(redis, 'audio', 5);
            expect(result.success).to.equal(true);
            expect(await redis.get('animastor:runtime:active-audio')).to.equal('5');
        });
    });
});
