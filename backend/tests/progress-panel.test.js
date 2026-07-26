const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const sceneState = require('../src/state/scene-state');
const activeScenes = require('../src/runtime/active-scenes-index');
const generationProgress = require('../src/services/generation-progress');

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function createHarness(redis, chunks, chunkIds) {
    let handler = null;
    const app = {
        get(path, callback) {
            if (path.endsWith('/progress-panel')) handler = callback;
        },
    };
    const deps = {
        state: sceneState,
        activeScenes,
        getAllChunks: async () => chunkIds,
        getChunk: async id => chunks.get(id) || null,
        iuRepo: { getImageUnitsForScene: async () => [] },
        utils: { log: () => {} },
    };
    require('../src/routes/book/progress-panel.cjs')(app, redis, deps);
    return async bookId => {
        const res = createResponse();
        await handler({ params: { bookId }, query: {} }, res);
        return res;
    };
}

function addChunk(chunks, chunkIds, bookId, chapterId, sceneId, index, data) {
    const id = `${bookId}_${chapterId}_${sceneId}_${String(index).padStart(4, '0')}`;
    chunkIds.push(id);
    chunks.set(id, {
        book_id: bookId,
        chapter_id: chapterId,
        scene_id: sceneId,
        build_id: 'build-1',
        chunk_index: String(index).padStart(4, '0'),
        ...data,
    });
}

describe('Progress panel independent generation tasks', () => {
    it('shows Audio and Image tasks with their own targets', async () => {
        const redis = createMockRedis();
        const bookId = 'parallel-types-book';
        const chunks = new Map();
        const chunkIds = [];

        addChunk(chunks, chunkIds, bookId, 'ch-1', 'audio-scene', 1, {
            expected_chunk_count: 2,
            audio_status: 'ready',
            image_status: 'ready',
        });
        addChunk(chunks, chunkIds, bookId, 'ch-1', 'audio-scene', 2, {
            expected_chunk_count: 2,
            audio_status: 'pending',
            image_status: 'ready',
        });
        addChunk(chunks, chunkIds, bookId, 'ch-1', 'image-scene', 1, {
            expected_chunk_count: 1,
            audio_status: 'ready',
            image_status: 'pending',
        });

        await sceneState.unsafeRestoreAssetStates(redis, bookId, 'ch-1', 'audio-scene', {
            audio: sceneState.AssetState.GENERATING,
            image: sceneState.AssetState.READY,
            video: sceneState.AssetState.NEW,
        });
        await sceneState.unsafeRestoreAssetStates(redis, bookId, 'ch-1', 'image-scene', {
            audio: sceneState.AssetState.READY,
            image: sceneState.AssetState.GENERATING,
            video: sceneState.AssetState.NEW,
        });

        const [audioTask] = await generationProgress.createTasks(
            redis,
            bookId,
            ['audio'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'audio-scene' },
            [{ chapter_id: 'ch-1', scene_id: 'audio-scene', dirty_layers: ['audio'] }]
        );
        const [imageTask] = await generationProgress.createTasks(
            redis,
            bookId,
            ['image'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'image-scene' },
            [{ chapter_id: 'ch-1', scene_id: 'image-scene', dirty_layers: ['image'] }]
        );

        const res = await createHarness(redis, chunks, chunkIds)(bookId);

        expect(res.statusCode).to.equal(200);
        expect(res.body.workers).to.have.length(2);
        expect(res.body.workers.map(worker => worker.task_id))
            .to.have.members([audioTask.task_id, imageTask.task_id]);

        const audio = res.body.workers.find(worker => worker.task_id === audioTask.task_id);
        const image = res.body.workers.find(worker => worker.task_id === imageTask.task_id);
        expect(audio).to.include({
            type: 'audio',
            scene_id: 'audio-scene',
            ready: 1,
            total: 2,
            done: false,
        });
        expect(image).to.include({
            type: 'image',
            scene_id: 'image-scene',
            ready: 0,
            total: 1,
            done: false,
        });
    });

    it('keeps two Audio commands as two progress rows', async () => {
        const redis = createMockRedis();
        const bookId = 'parallel-audio-book';
        const chunks = new Map();
        const chunkIds = [];

        addChunk(chunks, chunkIds, bookId, 'ch-1', 'scene-a', 1, {
            expected_chunk_count: 2,
            audio_status: 'ready',
        });
        addChunk(chunks, chunkIds, bookId, 'ch-1', 'scene-a', 2, {
            expected_chunk_count: 2,
            audio_status: 'pending',
        });
        addChunk(chunks, chunkIds, bookId, 'ch-2', 'scene-b', 1, {
            expected_chunk_count: 1,
            audio_status: 'pending',
        });

        await sceneState.unsafeRestoreAssetState(
            redis, bookId, 'ch-1', 'scene-a', 'audio', sceneState.AssetState.GENERATING
        );
        await sceneState.unsafeRestoreAssetState(
            redis, bookId, 'ch-2', 'scene-b', 'audio', sceneState.AssetState.PENDING
        );

        const [firstTask] = await generationProgress.createTasks(
            redis,
            bookId,
            ['audio'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'scene-a' },
            [{ chapter_id: 'ch-1', scene_id: 'scene-a', dirty_layers: ['audio'] }]
        );
        const [secondTask] = await generationProgress.createTasks(
            redis,
            bookId,
            ['audio'],
            { scope: 'current_scene', chapterId: 'ch-2', sceneId: 'scene-b' },
            [{ chapter_id: 'ch-2', scene_id: 'scene-b', dirty_layers: ['audio'] }]
        );

        const res = await createHarness(redis, chunks, chunkIds)(bookId);
        const audioRows = res.body.workers.filter(worker => worker.type === 'audio');

        expect(audioRows).to.have.length(2);
        expect(audioRows.map(worker => worker.task_id))
            .to.have.members([firstTask.task_id, secondTask.task_id]);
        expect(audioRows.find(worker => worker.task_id === firstTask.task_id))
            .to.include({ scene_id: 'scene-a', ready: 1, total: 2 });
        expect(audioRows.find(worker => worker.task_id === secondTask.task_id))
            .to.include({ scene_id: 'scene-b', ready: 0, total: 1 });
    });
});
