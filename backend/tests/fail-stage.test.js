// ======================================================
// orchestrator.failStage — T3 консолидации
// ======================================================
// Канал ошибок worker → gpu-hub → backend: сбой генерации становится
// командой фасада (FAILED → PENDING для передиспатча планировщиком),
// а не истёкшим dispatch-lease через 15–30 минут.

const { expect } = require('chai');
const orchestrator = require('../src/orchestration/orchestrator');
const dispatchEngine = require('../src/runtime/dispatch-engine');
const state = require('../src/state');
const { createMockRedis } = require('./mocks/redis-mock');

const B = 'test_book', C = 'ch-1', S = 'sc-1';

async function createActiveDispatch(redis, stage, dispatchId = `dispatch-${stage}`) {
    const quota = await dispatchEngine.acquireQuota(redis, stage);
    expect(quota.acquired).to.equal(true);
    const lease = await dispatchEngine.acquireStageLease(redis, B, C, S, stage);
    expect(lease.acquired).to.equal(true);
    await dispatchEngine.setDispatchMetadata(
        redis,
        B,
        C,
        S,
        stage,
        dispatchEngine.createDispatchMetadata(dispatchId, stage, 'test', {
            leaseKey: lease.leaseKey,
            leaseToken: lease.token,
            quotaOwned: true,
        })
    );
    return dispatchId;
}

async function setStage(redis, stage, value) {
    await state.setAssetState(redis, B, C, S, stage, value);
}

async function getStage(redis, stage) {
    const states = await state.getAssetStates(redis, B, C, S);
    return states[stage];
}

describe('orchestrator.failStage (T3)', () => {
    let redis;
    beforeEach(() => { redis = createMockRedis(); });

    it('GENERATING → FAILED → PENDING (redispatch по умолчанию)', async () => {
        const dispatchId = await createActiveDispatch(redis, 'audio');
        await setStage(redis, 'audio', state.AssetState.GENERATING);
        const result = await orchestrator.failStage(
            redis, B, C, S, 'audio', 'b1', 'worker_timeout', { dispatchId }
        );
        expect(result.failed).to.equal(true);
        expect(result.redispatch).to.equal(true);
        expect(await getStage(redis, 'audio')).to.equal(state.AssetState.PENDING);
    });

    it('пишет событие *_FAILED в event journal', async () => {
        const dispatchId = await createActiveDispatch(redis, 'video');
        await setStage(redis, 'video', state.AssetState.GENERATING);
        await orchestrator.failStage(redis, B, C, S, 'video', 'b1', 'oom', { dispatchId });
        const events = (await redis.lrange(`animastor:event-journal:${B}:${C}:${S}`, 0, -1))
            .map(JSON.parse);
        const failed = events.find(e => e.type === 'VIDEO_FAILED');
        expect(failed).to.exist;
        expect(failed.details.reason).to.equal('oom');
    });

    it('redispatch:false оставляет FAILED', async () => {
        const dispatchId = await createActiveDispatch(redis, 'image');
        await setStage(redis, 'image', state.AssetState.GENERATING);
        await orchestrator.failStage(
            redis, B, C, S, 'image', 'b1', 'err', { redispatch: false, dispatchId }
        );
        expect(await getStage(redis, 'image')).to.equal(state.AssetState.FAILED);
    });

    it('поздняя ошибка после READY игнорируется (валидация перехода)', async () => {
        const dispatchId = await createActiveDispatch(redis, 'audio');
        await setStage(redis, 'audio', state.AssetState.READY);
        const result = await orchestrator.failStage(
            redis, B, C, S, 'audio', 'b1', 'late_error', { dispatchId }
        );
        expect(result.failed).to.equal(false);
        expect(await getStage(redis, 'audio')).to.equal(state.AssetState.READY);
        const events = (await redis.lrange(`animastor:event-journal:${B}:${C}:${S}`, 0, -1))
            .map(JSON.parse);
        expect(events.some(e => e.type === 'INVALID_STATE_CALLBACK')).to.equal(true);
    });

    it('PENDING → FAILED допустим (ошибка до фактического dispatch)', async () => {
        const dispatchId = await createActiveDispatch(redis, 'image');
        await setStage(redis, 'image', state.AssetState.PENDING);
        const result = await orchestrator.failStage(
            redis, B, C, S, 'image', 'b1', 'dispatch_error', { dispatchId }
        );
        expect(result.failed).to.equal(true);
    });

    it('неизвестный stage бросает ошибку', async () => {
        try {
            await orchestrator.failStage(redis, B, C, S, 'music', 'b1', 'x');
            expect.fail('should have thrown');
        } catch (err) {
            expect(err.message).to.match(/unknown stage/);
        }
    });
});
