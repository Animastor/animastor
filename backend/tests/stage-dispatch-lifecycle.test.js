// ======================================================
// Stage dispatch lifecycle guard — regression tests
// ======================================================
// Fix for docs/runtime-audits/video-retry-targeted-investigation-2026-08-26.md:
// a partial SCENE_RESET left video at NEW while image was READY.
// dispatchStage skipped initialization, setSceneGenerating(new→generating)
// was rejected and swallowed, the GPU job was sent anyway, the successful
// result was rejected by handleVideoCompleted ('invalid_asset_state'),
// converted to FAILURE, burned retry budget and opened the circuit breaker.
//
// CASE A: image READY + video NEW → NEW→PENDING→GENERATING before dispatch
// CASE B: rejected state transition → no GPU job (dispatch aborts)
// CASE C: successful video callback with GENERATING → ok:true (not FAILURE);
//         legacy NEW state is still rejected by the handler whitelist
// CASE D: after successful completion (READY) scheduler does NOT re-dispatch
// CASE E: stale callback of an old dispatch cannot damage the new dispatch

const { expect } = require('chai');
const state = require('../src/state');
const orchestrator = require('../src/orchestration/orchestrator');
const sceneOrchestrator = require('../src/orchestration/scene-orchestrator');
const callbacks = require('../src/orchestration/scene-callbacks');
const dispatchEngine = require('../src/runtime/dispatch-engine');
const runtimeScheduler = require('../src/runtime/runtime-scheduler');
const videoService = require('../src/video/video-service');
const { createMockRedis } = require('./mocks/redis-mock');

const B = 'test_book', C = 'ch-1', S = 'sc-1';

async function setState(redis, asset, value) {
    await state.setAssetState(redis, B, C, S, asset, value);
}

async function getState(redis, asset) {
    const states = await state.getAssetStates(redis, B, C, S);
    return states[asset];
}

async function createActiveDispatch(redis, stage, dispatchId) {
    const quota = await dispatchEngine.acquireQuota(redis, stage);
    expect(quota.acquired).to.equal(true);
    const lease = await dispatchEngine.acquireStageLease(redis, B, C, S, stage);
    expect(lease.acquired).to.equal(true);
    await dispatchEngine.setDispatchMetadata(
        redis, B, C, S, stage,
        dispatchEngine.createDispatchMetadata(dispatchId, stage, 'test', {
            leaseKey: lease.leaseKey,
            leaseToken: lease.token,
            quotaOwned: true,
        })
    );
    return dispatchId;
}

describe('stage dispatch lifecycle guard (video re-dispatch incident fix)', () => {

    describe('CASE A: partial scene (image READY + video NEW)', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('initializes NEW → PENDING → GENERATING and reports dispatchable', async () => {
            await setState(redis, 'image', state.AssetState.READY);
            await setState(redis, 'video', state.AssetState.NEW);

            const result = await sceneOrchestrator.ensureStageDispatchable(
                redis, B, C, S, 'video'
            );

            expect(result.ok).to.equal(true);
            // The job may only be sent from a valid in-flight state
            expect(await getState(redis, 'video')).to.equal(state.AssetState.GENERATING);
        });

        it('NEW → PENDING step is applied through the facade (valid transition)', async () => {
            await setState(redis, 'video', state.AssetState.NEW);
            const init = await orchestrator.setScenePending(redis, B, C, S, 'video');
            expect(init.changed).to.equal(true);
            expect(await getState(redis, 'video')).to.equal(state.AssetState.PENDING);
        });
    });

    describe('CASE B: rejected state transition must abort BEFORE any GPU job', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('READY asset is not dispatchable (no transition to GENERATING)', async () => {
            await setState(redis, 'video', state.AssetState.READY);

            const result = await sceneOrchestrator.ensureStageDispatchable(
                redis, B, C, S, 'video'
            );

            expect(result.ok).to.equal(false);
            expect(result.reason).to.match(/^generating_transition_failed:/);
            // State untouched — nothing was sent
            expect(await getState(redis, 'video')).to.equal(state.AssetState.READY);
        });

        it('DIRTY asset aborts (must pass through reset→PENDING first)', async () => {
            // DIRTY allows only PENDING/PLACEHOLDER — never GENERATING.
            // The scheduler's version-stale pre-pass owns DIRTY→PENDING;
            // the executor must not send a job from DIRTY directly.
            await setState(redis, 'video', state.AssetState.DIRTY);
            const result = await sceneOrchestrator.ensureStageDispatchable(
                redis, B, C, S, 'video'
            );
            expect(result.ok).to.equal(false);
            expect(result.reason).to.match(/^generating_transition_failed:/);
            expect(await getState(redis, 'video')).to.equal(state.AssetState.DIRTY);
        });

        it('already-GENERATING asset stays dispatchable (idempotent)', async () => {
            await setState(redis, 'video', state.AssetState.GENERATING);
            const result = await sceneOrchestrator.ensureStageDispatchable(
                redis, B, C, S, 'video'
            );
            expect(result.ok).to.equal(true);
        });

        it('executor aborts a DIRTY video dispatch with zero GPU jobs sent', async () => {
            // Scenario 16-18 (audit c8b79f6 old-fix regression): dirty→generating is
            // an invalid transition, so the executor must abort BEFORE any GPU job.
            await setState(redis, 'video', state.AssetState.DIRTY);

            const result = await sceneOrchestrator.dispatchStage(
                redis,
                { book_id: B, chapter_id: C, scene_id: S },
                null,           // loadedBook unused — abort happens before book load
                'build-1',
                'video',
                'dispatch-dirty-abort'
            );

            expect(result.dispatched).to.equal(false);
            expect(result.jobs).to.equal(0);
            expect(result.reason).to.match(/^generating_transition_failed:/);
        });
    });

    describe('CASE C: successful video callback must be SUCCESS, not FAILURE', () => {
        let redis;
        let originalValidate;
        beforeEach(() => {
            redis = createMockRedis();
            originalValidate = videoService.validateVideoFile;
            // Stub disk validation: unit test must not touch /data/output
            videoService.validateVideoFile = () => ({
                valid: true, duration: 5, metadata: { width: 640, height: 480 }
            });
        });
        afterEach(() => { videoService.validateVideoFile = originalValidate; });

        it('GENERATING + valid artifact → ok:true (SUCCESS path)', async () => {
            await setState(redis, 'video', state.AssetState.GENERATING);
            const result = await callbacks.handleVideoCompleted(redis, B, C, S, 'b1');
            expect(result.ok).to.equal(true);
            expect(result.artifact).to.exist;
        });

        it('incident regression: legacy NEW state is still rejected (whitelist intact)', async () => {
            await setState(redis, 'video', state.AssetState.NEW);
            const result = await callbacks.handleVideoCompleted(redis, B, C, S, 'b1');
            expect(result.ok).to.equal(false);
            expect(result.reason).to.equal('invalid_asset_state');
            expect(result.retryable).to.equal(false);
        });
    });

    describe('CASE D: completed video (READY) is not re-dispatched', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('shouldScheduleAssets excludes video once it is READY', async () => {
            await setState(redis, 'audio', state.AssetState.READY);
            await setState(redis, 'image', state.AssetState.READY);
            await setState(redis, 'video', state.AssetState.READY);

            const { stages, allDone } = await runtimeScheduler.shouldScheduleAssets(
                redis, B, C, S
            );
            expect(allDone).to.equal(true);
            expect(stages).to.not.include('video');
        });

        it('partially ready scene schedules only the missing stage', async () => {
            await setState(redis, 'audio', state.AssetState.READY);
            await setState(redis, 'image', state.AssetState.READY);
            await setState(redis, 'video', state.AssetState.PENDING);

            const { stages } = await runtimeScheduler.shouldScheduleAssets(
                redis, B, C, S
            );
            expect(stages).to.deep.equal(['video']);
        });
    });

    describe('CASE E: stale callback cannot damage the new dispatch', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('completeStage with old dispatch_id is rejected; new metadata intact', async () => {
            const newId = await createActiveDispatch(redis, 'video', 'dispatch-NEW');
            await setState(redis, 'video', state.AssetState.GENERATING);

            const result = await orchestrator.completeStage(
                redis, B, C, S, 'video', 'b1', 'dispatch-OLD'
            );

            expect(result.completed).to.equal(false);
            expect(result.reason).to.equal('stale_dispatch');

            // New dispatch ownership unchanged
            const meta = await dispatchEngine.getDispatchMetadata(redis, B, C, S, 'video');
            expect(meta.dispatch_id).to.equal(newId);
            // Asset state untouched by the stale callback
            expect(await getState(redis, 'video')).to.equal(state.AssetState.GENERATING);

            // No completion was recorded for any dispatch
            const events = (await redis.lrange(`animastor:event-journal:${B}:${C}:${S}`, 0, -1))
                .map(JSON.parse);
            expect(events.find(e => e.type === 'DISPATCH_COMPLETED')).to.not.exist;
        });
    });
});
