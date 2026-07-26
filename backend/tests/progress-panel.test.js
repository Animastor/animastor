const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const layerConfig = require('../src/services/layer-config');
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

describe('Progress panel parallel workers', () => {
    it('keeps active Audio visible after the latest profile switches to Image', async () => {
        const redis = createMockRedis();
        const bookId = 'parallel-book';
        const chapterId = 'ch-1';
        const sceneId = 'scene-1';
        const chunkIds = [
            `${bookId}_${chapterId}_${sceneId}_0001`,
            `${bookId}_${chapterId}_${sceneId}_0002`,
        ];
        const chunks = new Map(chunkIds.map((id, index) => [id, {
            book_id: bookId,
            chapter_id: chapterId,
            scene_id: sceneId,
            build_id: 'build-1',
            chunk_index: String(index + 1).padStart(4, '0'),
            expected_chunk_count: 2,
            audio_status: index === 0 ? 'ready' : 'pending',
            image_status: 'pending',
            video_status: 'pending',
        }]));

        await layerConfig.set(redis, bookId, {
            audio_enabled: false,
            image_enabled: true,
            video_enabled: false,
        });
        await sceneState.unsafeRestoreAssetStates(redis, bookId, chapterId, sceneId, {
            audio: sceneState.AssetState.GENERATING,
            image: sceneState.AssetState.PENDING,
            video: sceneState.AssetState.NEW,
        });
        await activeScenes.addActiveScene(redis, bookId, chapterId, sceneId);

        let handler = null;
        const app = {
            get(path, callback) {
                if (path.endsWith('/progress-panel')) handler = callback;
            },
        };
        const deps = {
            config: { OUTPUT_DIR: '/tmp/animastor-progress-panel-test' },
            state: sceneState,
            book: { loadBook: () => ({ chapters: [] }) },
            layerConfig,
            activeScenes,
            getAllChunks: async () => chunkIds,
            getChunk: async id => chunks.get(id) || null,
            iuRepo: { getImageUnitsForScene: async () => [] },
            utils: { log: () => {} },
        };

        require('../src/routes/book/progress-panel.cjs')(app, redis, deps);
        const res = createResponse();
        await handler({
            params: { bookId },
            query: {
                scope: 'current_scene',
                chapter_id: chapterId,
                scene_id: sceneId,
            },
        }, res);

        expect(res.statusCode).to.equal(200);
        expect(res.body.profile).to.equal('image_only');
        expect(res.body.workers.map(worker => worker.type)).to.include.members(['audio', 'image']);

        const audio = res.body.workers.find(worker => worker.type === 'audio');
        expect(audio.ready).to.equal(1);
        expect(audio.total).to.equal(2);
        expect(audio.done).to.be.false;
    });

    it('computes each parallel worker from its own stored scope', async () => {
        const redis = createMockRedis();
        const bookId = 'parallel-scopes-book';
        const chunks = new Map();
        const chunkIds = [];

        function addChunk(chapterId, sceneId, index, data) {
            const id = `${bookId}_${chapterId}_${sceneId}_${String(index).padStart(4, '0')}`;
            chunkIds.push(id);
            chunks.set(id, {
                book_id: bookId,
                chapter_id: chapterId,
                scene_id: sceneId,
                build_id: 'build-1',
                chunk_index: String(index).padStart(4, '0'),
                video_status: 'pending',
                ...data,
            });
        }

        addChunk('ch-1', 'audio-scene', 1, {
            expected_chunk_count: 2,
            audio_status: 'ready',
            image_status: 'ready',
        });
        addChunk('ch-1', 'audio-scene', 2, {
            expected_chunk_count: 2,
            audio_status: 'pending',
            image_status: 'ready',
        });
        addChunk('ch-1', 'image-scene', 1, {
            expected_chunk_count: 1,
            audio_status: 'ready',
            image_status: 'pending',
        });

        await layerConfig.set(redis, bookId, {
            audio_enabled: false,
            image_enabled: true,
            video_enabled: false,
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
        await activeScenes.addActiveScene(redis, bookId, 'ch-1', 'audio-scene');
        await activeScenes.addActiveScene(redis, bookId, 'ch-1', 'image-scene');
        await generationProgress.recordScopes(redis, bookId, ['audio'], {
            scope: 'current_scene',
            chapterId: 'ch-1',
            sceneId: 'audio-scene',
        });
        await generationProgress.recordScopes(redis, bookId, ['image'], {
            scope: 'current_scene',
            chapterId: 'ch-1',
            sceneId: 'image-scene',
        });

        let handler = null;
        const app = {
            get(path, callback) {
                if (path.endsWith('/progress-panel')) handler = callback;
            },
        };
        const deps = {
            config: { OUTPUT_DIR: '/tmp/animastor-progress-panel-test' },
            state: sceneState,
            book: { loadBook: () => ({ chapters: [] }) },
            layerConfig,
            activeScenes,
            getAllChunks: async () => chunkIds,
            getChunk: async id => chunks.get(id) || null,
            iuRepo: { getImageUnitsForScene: async () => [] },
            utils: { log: () => {} },
        };

        require('../src/routes/book/progress-panel.cjs')(app, redis, deps);
        const res = createResponse();
        await handler({
            params: { bookId },
            query: {
                scope: 'current_scene',
                chapter_id: 'ch-1',
                scene_id: 'image-scene',
            },
        }, res);

        const audio = res.body.workers.find(worker => worker.type === 'audio');
        const image = res.body.workers.find(worker => worker.type === 'image');
        expect(audio).to.include({ ready: 1, total: 2, done: false });
        expect(image).to.include({ ready: 0, total: 1, done: false });
    });
});
