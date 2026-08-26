const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const dispatchEngine = require('../src/runtime/dispatch-engine');
const gpuDispatcher = require('../src/runtime/gpu-dispatcher');
const jobSchema = require('../src/runtime/job-schema');
const { createMockRedis } = require('./mocks/redis-mock');

const BOOK_ID = 'stabilization-book';
const CHAPTER_ID = 'ch-1';
const SCENE_ID = 'sc-1';

async function createOwnedDispatch(redis, stage, dispatchId) {
    const quota = await dispatchEngine.acquireQuota(redis, stage);
    expect(quota.acquired).to.equal(true);
    const lease = await dispatchEngine.acquireStageLease(
        redis, BOOK_ID, CHAPTER_ID, SCENE_ID, stage
    );
    expect(lease.acquired).to.equal(true);
    await dispatchEngine.setDispatchMetadata(
        redis,
        BOOK_ID,
        CHAPTER_ID,
        SCENE_ID,
        stage,
        dispatchEngine.createDispatchMetadata(dispatchId, stage, 'test', {
            leaseKey: lease.leaseKey,
            leaseToken: lease.token,
            quotaOwned: true,
        })
    );
    return lease;
}

describe('orchestration stabilization: dispatch ownership', () => {
    let redis;

    beforeEach(() => {
        redis = createMockRedis();
    });

    it('rejects missing and stale dispatch identity without releasing owned resources', async () => {
        const dispatchId = 'dispatch-current';
        const lease = await createOwnedDispatch(redis, 'audio', dispatchId);

        const missing = await dispatchEngine.finalizeDispatch(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', { outcome: 'success' }
        );
        expect(missing).to.deep.include({ finalized: false, reason: 'missing_dispatch_id' });

        const stale = await dispatchEngine.finalizeDispatch(
            redis,
            BOOK_ID,
            CHAPTER_ID,
            SCENE_ID,
            'audio',
            { outcome: 'success', dispatchId: 'dispatch-stale' }
        );
        expect(stale).to.deep.include({ finalized: false, reason: 'stale_dispatch' });
        expect(await dispatchEngine.getActiveCounter(redis, 'audio')).to.equal(1);
        expect(await redis.get(lease.leaseKey)).to.equal(lease.token);
        expect(
            await dispatchEngine.getDispatchMetadata(
                redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
            )
        ).to.deep.include({ dispatch_id: dispatchId, quota_owned: true });
    });

    it('does not release quota or metadata when the lease token belongs to another owner', async () => {
        const dispatchId = 'dispatch-current';
        const lease = await createOwnedDispatch(redis, 'image', dispatchId);
        await redis.set(lease.leaseKey, 'replacement-owner-token');

        const result = await dispatchEngine.finalizeDispatch(
            redis,
            BOOK_ID,
            CHAPTER_ID,
            SCENE_ID,
            'image',
            { outcome: 'failure', dispatchId, reason: 'worker_error' }
        );

        expect(result).to.deep.include({ finalized: false, reason: 'lease_token_mismatch' });
        expect(await dispatchEngine.getActiveCounter(redis, 'image')).to.equal(1);
        expect(
            await dispatchEngine.getDispatchMetadata(
                redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'image'
            )
        ).to.deep.include({ dispatch_id: dispatchId });
    });

    it('releases one quota slot exactly once for duplicate finalization', async () => {
        await dispatchEngine.acquireQuota(redis, 'audio');
        const dispatchId = 'dispatch-once';
        await createOwnedDispatch(redis, 'audio', dispatchId);

        const first = await dispatchEngine.finalizeDispatch(
            redis,
            BOOK_ID,
            CHAPTER_ID,
            SCENE_ID,
            'audio',
            { outcome: 'success', dispatchId }
        );
        const duplicate = await dispatchEngine.finalizeDispatch(
            redis,
            BOOK_ID,
            CHAPTER_ID,
            SCENE_ID,
            'audio',
            { outcome: 'success', dispatchId }
        );

        expect(first).to.deep.include({ finalized: true, reason: 'success' });
        expect(duplicate).to.deep.include({ finalized: false, reason: 'already_finalized' });
        expect(await dispatchEngine.getActiveCounter(redis, 'audio')).to.equal(1);
    });
});

describe('orchestration stabilization: protocol contract', () => {
    it('requires dispatch_id before attempting GPU Hub delivery', async () => {
        let error;
        try {
            await gpuDispatcher.sendUnified({
                job_id: 'book_ch-1_sc-1_0001:audio',
                job_type: 'audio',
                build_id: 'build-1',
                params: {},
            });
        } catch (err) {
            error = err;
        }
        expect(error).to.be.an('error');
        expect(error.message).to.match(/dispatch_id is required/);
    });

    it('keeps backend, GPU Hub, and worker on strict protocol version 2', () => {
        const hubSource = fs.readFileSync(
            path.join(__dirname, '../../gpu-hub/gpu-hub.js'), 'utf8'
        );
        const workerSource = fs.readFileSync(
            path.join(__dirname, '../../worker/worker/worker.cjs'), 'utf8'
        );

        expect(jobSchema.PROTOCOL_VERSION).to.equal(2);
        expect(hubSource).to.match(/const PROTOCOL_VERSION = 2;/);
        expect(workerSource).to.match(/const PROTOCOL_VERSION = 2;/);
        expect(hubSource).to.match(/app\.post\("\/task", requireApiKey/);
        expect(hubSource).to.match(/worker_protocol_mismatch/);
        expect(hubSource).to.match(/redis\.lrem\("animastor:processing"/);
        expect(workerSource).to.match(/Hub rejected beacon/);
    });

    it('keeps long video generation alive: per-job timeout is forwarded hub→worker, not a short fixed cap', () => {
        const hubSource = fs.readFileSync(
            path.join(__dirname, '../../gpu-hub/gpu-hub.js'), 'utf8'
        );
        const workerSource = fs.readFileSync(
            path.join(__dirname, '../../worker/worker/worker.cjs'), 'utf8'
        );

        // gpu-hub принимает timeout_ms из body и кладёт его в очередь (task)
        expect(hubSource).to.match(/timeout_ms\s*}/);
        expect(hubSource).to.match(/timeout_ms: timeout_ms/);

        // worker уважает per-job timeout из задачи вместо короткого дефолта
        expect(workerSource).to.match(/task\.timeout_ms/);
        expect(workerSource).to.match(/VIDEO_RESULT_TIMEOUT_MS/);

        // Дефолт видео-таймаута воркера — НЕ короткий фиксированный потолок:
        // ≥ 1 час (LTX-генерация 5-10 мин, слабый GPU — 20-30+ мин),
        // а не 200 секунд.
        const videoDefaultMatch = workerSource.match(
            /VIDEO_RESULT_TIMEOUT_MS\s*=\s*Number\(process\.env\.VIDEO_RESULT_TIMEOUT_MS\s*\|\|\s*(\d+)/
        );
        expect(videoDefaultMatch).to.exist;
        const videoDefaultMs = Number(videoDefaultMatch[1]);
        expect(videoDefaultMs).to.be.at.least(3600000); // ≥ 1 час
        expect(videoDefaultMs).to.be.above(200000);      // точно не 200 сек
    });
});

describe('orchestration stabilization: executor acceptance', () => {
    const modulePaths = [
        '../src/orchestration/scene-orchestrator',
        '../src/state',
        '../src/audio',
        '../src/image',
        '../src/video',
        '../src/runtime/gpu-dispatcher',
        '../src/runtime/runtime-scheduler',
        '../src/book',
        '../src/orchestration/scene-utils',
        '../src/orchestration/scene-callbacks',
        '../src/orchestration/scene-restoration',
        '../src/orchestration/orchestrator',
        '../src/storage/postgres/repositories/scene-assets-repo',
        '../src/workflows/workflow-loader',
        '../src/services/video-orchestrator',
        '../src/config/runtime-config',
    ];

    let savedCache;

    beforeEach(() => {
        savedCache = new Map();
        for (const request of modulePaths) {
            const resolved = require.resolve(request);
            savedCache.set(resolved, require.cache[resolved]);
            delete require.cache[resolved];
        }
    });

    afterEach(() => {
        for (const request of modulePaths) {
            const resolved = require.resolve(request);
            const saved = savedCache.get(resolved);
            if (saved) require.cache[resolved] = saved;
            else delete require.cache[resolved];
        }
    });

    function stub(request, exports) {
        const resolved = require.resolve(request);
        require.cache[resolved] = { exports, loaded: true };
    }

    function installCommonStubs(overrides = {}) {
        const calls = { pending: [], generating: [] };
        const sceneData = {
            book_id: BOOK_ID,
            chapter_id: CHAPTER_ID,
            scene_id: SCENE_ID,
            payload: {},
        };
        const loadedBook = { id: BOOK_ID };

        stub('../src/state', {
            AssetState: {
                NEW: 'new',
                PENDING: 'pending',
                READY: 'ready',
            },
            getAssetStates: async () => ({
                audio: 'ready',
                image: 'pending',
                video: 'ready',
            }),
        });
        stub('../src/audio', overrides.audio || {});
        stub('../src/image', overrides.image || {});
        stub('../src/video', overrides.video || {});
        stub('../src/runtime/gpu-dispatcher', overrides.gpu || {});
        stub('../src/runtime/runtime-scheduler', { addSceneToActiveIndex: async () => {} });
        stub('../src/book', {
            loadBook: () => loadedBook,
            findSceneRuntimeData: () => sceneData,
        });
        stub('../src/orchestration/scene-utils', {
            log: () => {},
            warn: () => {},
            logEvent: async () => {},
        });
        stub('../src/orchestration/scene-callbacks', {
            handleAudioCompleted: async () => {},
            handleImageCompleted: async () => {},
            handleVideoCompleted: async () => {},
        });
        stub('../src/orchestration/scene-restoration', {
            restoreSceneChunkStatus: async () => {},
        });
        stub('../src/orchestration/orchestrator', {
            completeStage: async () => ({ completed: true }),
            failStage: async () => {},
            setScenePending: async (...args) => { calls.pending.push(args); return { changed: true }; },
            setSceneGenerating: async (...args) => { calls.generating.push(args); return { changed: true }; },
        });
        stub('../src/storage/postgres/repositories/scene-assets-repo', {
            getDirtyUnitIds: async () => [],
        });
        stub('../src/workflows/workflow-loader', { workflows: {} });

        return { calls, sceneData, loadedBook };
    }

    it('uses image sentCount and forwards the dispatch identity', async () => {
        const generatorCalls = [];
        const { sceneData, loadedBook } = installCommonStubs({
            image: {
                generateSceneIUImages: async (...args) => {
                    generatorCalls.push(args);
                    return { sentCount: 2, cachedCount: 0, total: 2 };
                },
            },
        });
        const sceneOrchestrator = require('../src/orchestration/scene-orchestrator');

        const result = await sceneOrchestrator.dispatchStage(
            {}, sceneData, loadedBook, 'build-1', 'image', 'dispatch-image'
        );

        expect(result).to.deep.include({
            dispatched: true,
            jobs: 2,
            dispatchId: 'dispatch-image',
        });
        expect(generatorCalls).to.have.length(1);
        expect(generatorCalls[0][6]).to.equal('dispatch-image');
    });

    it('does not count video jobs rejected by GPU Hub as dispatched', async () => {
        const videoCalls = [];
        const redis = createMockRedis();
        const { calls, sceneData, loadedBook } = installCommonStubs({
            video: {
                generateVideoAnimation: async (...args) => {
                    videoCalls.push(args);
                    return {
                        success: true,
                        jobSpecs: [{ job_id: 'book_ch-1_sc-1_g1:video', unit_ids: ['u1'] }],
                    };
                },
            },
            gpu: {
                sendUnified: async () => ({ sent: false, error: 'hub_unavailable' }),
            },
        });
        const sceneOrchestrator = require('../src/orchestration/scene-orchestrator');

        const result = await sceneOrchestrator.dispatchStage(
            redis, sceneData, loadedBook, 'build-1', 'video', 'dispatch-video'
        );

        expect(result).to.deep.include({
            dispatched: false,
            jobs: 0,
            reason: 'send_failed',
            dispatchId: 'dispatch-video',
        });
        expect(videoCalls[0][4]).to.equal('dispatch-video');
        expect(calls.pending).to.have.length(1);
    });
});

describe('audio-orch invariant (R6)', () => {
    const modulePaths = [
        '../src/orchestration/orchestrator',
        '../src/state',
        '../src/orchestration/scene-callbacks',
        '../src/orchestration/scene-utils',
        '../src/orchestration/event-journal',
        '../src/runtime/dispatch-engine',
        '../src/runtime/failure-taxonomy',
        '../src/storage/postgres/repositories/scene-assets-repo',
        '../src/storage/postgres/database',
    ];

    let redis;
    let savedCache;
    let assetWrites;
    let dispatchFinalizedCalls;

    beforeEach(() => {
        redis = createMockRedis();
        assetWrites = [];
        dispatchFinalizedCalls = [];

        savedCache = new Map();
        for (const request of modulePaths) {
            const resolved = require.resolve(request);
            savedCache.set(resolved, require.cache[resolved]);
            delete require.cache[resolved];
        }
    });

    afterEach(() => {
        for (const request of modulePaths) {
            const resolved = require.resolve(request);
            const saved = savedCache.get(resolved);
            if (saved) require.cache[resolved] = saved;
            else delete require.cache[resolved];
        }
    });

    function stub(request, exports) {
        const resolved = require.resolve(request);
        require.cache[resolved] = { exports, loaded: true };
    }

    it('1. completeStage(audio) with ok handler → asset.audio = READY', async () => {
        stub('../src/state', {
            AssetState: {
                NEW: 'new', DIRTY: 'dirty', PENDING: 'pending',
                GENERATING: 'generating', READY: 'ready', FAILED: 'failed', PLACEHOLDER: 'placeholder',
            },
            getAssetStates: async () => ({ audio: 'generating', image: 'new', video: 'new' }),
            unsafeRestoreAssetState: async (r, bid, cid, sid, asset, status) => {
                assetWrites.push({ asset, status });
            },
            unsafeRestoreAssetStates: async () => {},
            validateAssetTransition: () => ({ valid: true, reason: 'valid' }),
        });
        stub('../src/orchestration/scene-callbacks', {
            handleAudioCompleted: async () => ({ ok: true, artifact: { path: '/tmp/test.mp3' } }),
            handleImageCompleted: async () => ({ ok: true }),
            handleVideoCompleted: async () => ({ ok: true }),
        });
        stub('../src/orchestration/scene-utils', { log: () => {}, warn: () => {}, error: () => {} });
        stub('../src/orchestration/event-journal', {
            EventType: { AUDIO_COMPLETED: 'AUDIO_COMPLETED' },
            appendSceneEvent: async () => ({ success: true }),
        });
        stub('../src/runtime/dispatch-engine', {
            verifyDispatchIdentity: async () => ({ valid: true }),
            finalizeDispatch: async (r, bid, cid, sid, stage, opts) => {
                dispatchFinalizedCalls.push({ stage, opts });
            },
        });
        stub('../src/runtime/failure-taxonomy', {
            classifyFailure: () => ({ type: 'unknown' }),
        });
        stub('../src/storage/postgres/repositories/scene-assets-repo', {
            getAsset: async () => ({
                scene_content_version: 1,
                scene_audio_config_version: 1,
            }),
            markReady: async () => ({
                id: 1, book_id: BOOK_ID, chapter_id: CHAPTER_ID, scene_id: SCENE_ID,
                asset_type: 'audio', status: 'ready', path: '/tmp/test.mp3',
            }),
        });
        stub('../src/storage/postgres/database', {
            query: async () => ({
                rows: [{ content_version: 1, audio_config_version: 1 }],
            }),
        });

        const orchestrator = require('../src/orchestration/orchestrator');
        const result = await orchestrator.completeStage(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'build-1', 'dispatch-ok'
        );

        expect(result).to.deep.include({ completed: true, reason: null });

        // Asset state was written as READY
        const audioWrite = assetWrites.find(w => w.asset === 'audio');
        expect(audioWrite).to.exist;
        expect(audioWrite.status).to.equal('ready');

        // Dispatch finalized as success
        const finalize = dispatchFinalizedCalls.find(c => c.stage === 'audio');
        expect(finalize).to.exist;
        expect(finalize.opts.outcome).to.equal('success');
    });

    it('2. failStage(audio) → asset.audio = FAILED then PENDING', async () => {
        stub('../src/state', {
            AssetState: {
                NEW: 'new', DIRTY: 'dirty', PENDING: 'pending',
                GENERATING: 'generating', READY: 'ready', FAILED: 'failed', PLACEHOLDER: 'placeholder',
            },
            getAssetStates: async () => ({ audio: 'generating', image: 'new', video: 'new' }),
            unsafeRestoreAssetState: async (r, bid, cid, sid, asset, status) => {
                assetWrites.push({ asset, status });
            },
            unsafeRestoreAssetStates: async () => {},
            validateAssetTransition: (from, to) => ({ valid: true, reason: 'valid' }),
        });
        stub('../src/orchestration/scene-utils', { log: () => {}, warn: () => {} });
        stub('../src/orchestration/event-journal', {
            EventType: { AUDIO_FAILED: 'AUDIO_FAILED', IMAGE_FAILED: 'IMAGE_FAILED', VIDEO_FAILED: 'VIDEO_FAILED' },
            appendSceneEvent: async () => ({ success: true }),
        });
        stub('../src/runtime/dispatch-engine', {
            verifyDispatchIdentity: async () => ({ valid: true }),
            finalizeDispatch: async (r, bid, cid, sid, stage, opts) => {
                dispatchFinalizedCalls.push({ stage, opts });
            },
        });
        stub('../src/runtime/failure-taxonomy', {
            classifyFailure: () => ({ type: 'transient' }),
        });

        const orchestrator = require('../src/orchestration/orchestrator');
        const result = await orchestrator.failStage(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'build-1', 'test_error'
        );

        expect(result).to.deep.include({ failed: true, redispatch: true });

        // Asset state was written as FAILED then PENDING
        expect(assetWrites.length).to.equal(2);
        expect(assetWrites[0]).to.deep.include({ asset: 'audio', status: 'failed' });
        expect(assetWrites[1]).to.deep.include({ asset: 'audio', status: 'pending' });

        // Dispatch finalized as failure
        const finalize = dispatchFinalizedCalls.find(c => c.stage === 'audio');
        expect(finalize).to.exist;
        expect(finalize.opts.outcome).to.equal('failure');
    });

    it('3. completeStage(audio) with handler.ok:false → NO asset state change', async () => {
        stub('../src/state', {
            AssetState: {
                NEW: 'new', DIRTY: 'dirty', PENDING: 'pending',
                GENERATING: 'generating', READY: 'ready', FAILED: 'failed', PLACEHOLDER: 'placeholder',
            },
            getAssetStates: async () => ({ audio: 'generating', image: 'new', video: 'new' }),
            unsafeRestoreAssetState: async (r, bid, cid, sid, asset, status) => {
                assetWrites.push({ asset, status });
            },
            unsafeRestoreAssetStates: async () => {},
            validateAssetTransition: () => ({ valid: true, reason: 'valid' }),
        });
        stub('../src/orchestration/scene-callbacks', {
            handleAudioCompleted: async () => ({ ok: false, reason: 'merge_failed' }),
            handleImageCompleted: async () => ({ ok: true }),
            handleVideoCompleted: async () => ({ ok: true }),
        });
        stub('../src/orchestration/scene-utils', { log: () => {}, warn: () => {}, error: () => {} });
        stub('../src/orchestration/event-journal', {
            EventType: { AUDIO_COMPLETED: 'AUDIO_COMPLETED' },
            appendSceneEvent: async () => ({ success: true }),
        });
        stub('../src/runtime/dispatch-engine', {
            verifyDispatchIdentity: async () => ({ valid: true }),
            finalizeDispatch: async (r, bid, cid, sid, stage, opts) => {
                dispatchFinalizedCalls.push({ stage, opts });
            },
        });
        stub('../src/runtime/failure-taxonomy', {
            classifyFailure: () => ({ type: 'unknown' }),
        });
        stub('../src/storage/postgres/repositories/scene-assets-repo', {
            getAsset: async () => null,
            markReady: async () => {},
        });
        stub('../src/storage/postgres/database', {
            query: async () => ({ rows: [] }),
        });

        const orchestrator = require('../src/orchestration/orchestrator');
        const result = await orchestrator.completeStage(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'build-1', 'dispatch-reject'
        );

        // Handler rejected — not completed
        expect(result).to.deep.include({ completed: false });

        // No asset state was written (handler.ok !== true)
        expect(assetWrites.length).to.equal(0);

        // Dispatch finalized as failure
        const finalize = dispatchFinalizedCalls.find(c => c.stage === 'audio');
        expect(finalize).to.exist;
        expect(finalize.opts.outcome).to.equal('failure');
    });
});
