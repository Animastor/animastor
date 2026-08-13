const { expect } = require('chai');
const cb = require('../src/runtime/circuit-breaker');
const { createMockRedis } = require('./mocks/redis-mock');

describe('Circuit breaker automatic recovery (tryRecover wiring)', () => {
    let redis;

    beforeEach(() => {
        redis = createMockRedis();
    });

    async function tripCircuit(service) {
        // 5 failures → OPEN
        for (let i = 0; i < cb.CIRCUIT_CONFIG.failureThreshold; i++) {
            await cb.recordFailure(redis, service);
        }
        const state = await cb.getCircuitState(redis, service);
        expect(state).to.equal(cb.CircuitState.OPEN);
    }

    describe('checkDispatchWithRecovery', () => {
        it('allows dispatch when circuit is closed', async () => {
            const result = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(result.allowed).to.be.true;
            expect(result.reason).to.equal('circuit_closed');
            expect(result.recovered).to.be.undefined;
        });

        it('blocks immediately after trip (recovery timeout not met)', async () => {
            await tripCircuit('video');
            const result = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(result.allowed).to.be.false;
            expect(result.reason).to.equal('circuit_open');
            expect(result.recovered).to.be.undefined;
        });

        it('recovers to HALF_OPEN and allows a test dispatch after the timeout', async () => {
            await tripCircuit('video');

            // Rewind the last-failure timestamp past the recovery timeout.
            const lastFailureKey = 'animastor:circuit:video:last-failure';
            const past = (Date.now() - cb.CIRCUIT_CONFIG.recoveryTimeoutMs - 1000).toString();
            await redis.set(lastFailureKey, past);

            const result = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(result.allowed).to.be.true;
            expect(result.recovered).to.be.true;
            expect(result.isTestRequest).to.be.true;

            // State transitioned OPEN → HALF_OPEN
            const state = await cb.getCircuitState(redis, 'video');
            expect(state).to.equal(cb.CircuitState.HALF_OPEN);
        });

        it('test dispatch success heals the circuit back to CLOSED', async () => {
            await tripCircuit('video');

            const lastFailureKey = 'animastor:circuit:video:last-failure';
            const past = (Date.now() - cb.CIRCUIT_CONFIG.recoveryTimeoutMs - 1000).toString();
            await redis.set(lastFailureKey, past);

            const check = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(check.allowed).to.be.true;
            expect(check.recovered).to.be.true;

            // Simulate the test dispatch succeeding.
            const success = await cb.recordSuccess(redis, 'video');
            expect(success.healed).to.be.true;
            expect(success.state).to.equal(cb.CircuitState.CLOSED);

            const state = await cb.getCircuitState(redis, 'video');
            expect(state).to.equal(cb.CircuitState.CLOSED);

            // Failures were reset — next dispatch is a normal closed dispatch.
            const after = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(after.allowed).to.be.true;
            expect(after.reason).to.equal('circuit_closed');
        });

        it('test dispatch failure re-opens the circuit immediately', async () => {
            await tripCircuit('video');

            const lastFailureKey = 'animastor:circuit:video:last-failure';
            const past = (Date.now() - cb.CIRCUIT_CONFIG.recoveryTimeoutMs - 1000).toString();
            await redis.set(lastFailureKey, past);

            const check = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(check.allowed).to.be.true;
            expect(check.recovered).to.be.true;

            // Simulate the test dispatch failing.
            await cb.recordFailure(redis, 'video');

            const state = await cb.getCircuitState(redis, 'video');
            expect(state).to.equal(cb.CircuitState.OPEN);

            // Still blocked.
            const after = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(after.allowed).to.be.false;
        });

        it('half-open limits concurrent test requests', async () => {
            await tripCircuit('video');

            const lastFailureKey = 'animastor:circuit:video:last-failure';
            const past = (Date.now() - cb.CIRCUIT_CONFIG.recoveryTimeoutMs - 1000).toString();
            await redis.set(lastFailureKey, past);

            const first = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(first.allowed).to.be.true;
            expect(first.isTestRequest).to.be.true;

            // Second concurrent test request is allowed up to halfOpenMaxRequests
            const second = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(second.allowed).to.be.true;
            expect(second.isTestRequest).to.be.true;

            // Third exceeds the limit — blocked until a test completes.
            const third = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(third.allowed).to.be.false;
            expect(third.reason).to.equal('half_open_limit_reached');
        });

        it('forceOpen is not immediately recoverable (cooldown respected)', async () => {
            await cb.forceOpen(redis, 'video', 'manual_stop');

            const result = await cb.checkDispatchWithRecovery(redis, 'video');
            expect(result.allowed).to.be.false;
            expect(result.reason).to.equal('circuit_open');
        });
    });
});
