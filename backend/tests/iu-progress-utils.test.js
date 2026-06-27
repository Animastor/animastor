const assert = require('assert');
const { iuReadyFromCounters } = require('../src/routes/book/iu-progress-utils.cjs');

describe('iu-progress-utils', () => {
    describe('iuReadyFromCounters', () => {
        it('fresh generation: ready equals confirmed, capped by total', () => {
            assert.strictEqual(iuReadyFromCounters(4, 0, 0), 0);
            assert.strictEqual(iuReadyFromCounters(4, 0, 2), 2);
            assert.strictEqual(iuReadyFromCounters(4, 0, 4), 4);
        });

        it('never exceeds total even if the counter overshoots', () => {
            assert.strictEqual(iuReadyFromCounters(4, 0, 99), 4);
        });

        it('never goes negative', () => {
            assert.strictEqual(iuReadyFromCounters(4, 0, -5), 0);
            assert.strictEqual(iuReadyFromCounters(0, 0, 3), 0);
        });

        it('regeneration: non-dirty units count as ready immediately', () => {
            // 5 total, 2 dirty, 0 confirmed yet → 3 non-dirty are ready
            assert.strictEqual(iuReadyFromCounters(5, 2, 0), 3);
            // 1 of the 2 dirty confirmed → 4
            assert.strictEqual(iuReadyFromCounters(5, 2, 1), 4);
            // both dirty confirmed → 5
            assert.strictEqual(iuReadyFromCounters(5, 2, 2), 5);
        });

        it('regeneration: confirmed beyond dirtyCount does not overcount', () => {
            // counter kept rising but only 2 were dirty → cap at total
            assert.strictEqual(iuReadyFromCounters(5, 2, 9), 5);
        });

        it('dirtyCount larger than total is clamped', () => {
            assert.strictEqual(iuReadyFromCounters(3, 10, 0), 0);
            assert.strictEqual(iuReadyFromCounters(3, 10, 3), 3);
        });

        it('is monotonic non-decreasing as confirmed rises (fresh)', () => {
            let prev = -1;
            for (let c = 0; c <= 10; c++) {
                const r = iuReadyFromCounters(4, 0, c);
                assert.ok(r >= prev, `ready dropped at confirmed=${c}: ${r} < ${prev}`);
                prev = r;
            }
        });

        it('is monotonic non-decreasing as confirmed rises (regen)', () => {
            let prev = -1;
            for (let c = 0; c <= 10; c++) {
                const r = iuReadyFromCounters(6, 3, c);
                assert.ok(r >= prev, `ready dropped at confirmed=${c}: ${r} < ${prev}`);
                prev = r;
            }
        });

        it('tolerates non-integer/garbage inputs', () => {
            assert.strictEqual(iuReadyFromCounters(NaN, NaN, NaN), 0);
            assert.strictEqual(iuReadyFromCounters(4.9, 0, 2.9), 2);
        });
    });
});
