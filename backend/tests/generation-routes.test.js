const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
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

describe('Generation routes independent commands', () => {
    const modulePaths = [
        '../src/routes/book/generation-routes.cjs',
        '../src/storage/postgres/repositories/scene-assets-repo',
        '../src/storage/postgres/repositories/task-repo',
        '../src/orchestration',
        '../src/runtime/runtime-scheduler',
        '../src/runtime/scene-window',
    ];
    const savedCache = new Map();

    beforeEach(() => {
        savedCache.clear();
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
        require.cache[resolved] = { exports, id: resolved, filename: resolved, loaded: true };
    }

    it('keeps Audio and Image requests separate without changing layer defaults', async () => {
        const redis = createMockRedis();
        const events = [];
        const originalHset = redis.hset;
        redis.hset = async (...args) => {
            if (args[0].startsWith(`${generationProgress.KEY_PREFIX}:`)) {
                events.push(`task:${JSON.parse(args[2]).type}`);
            }
            return originalHset(...args);
        };

        const persistedLayerConfig = {
            audio_enabled: true,
            image_enabled: true,
            video_enabled: true,
        };
        let layerSetCalls = 0;
        const resetCalls = [];

        stub('../src/storage/postgres/repositories/scene-assets-repo', {
            setDirtyUnitIds: async () => {},
        });
        stub('../src/storage/postgres/repositories/task-repo', {
            createTask: async (_taskId, _bookId, _chapterId, _sceneId, type) => {
                events.push(`pg-create:${type}`);
            },
            updateTaskStatus: async () => {},
        });
        stub('../src/orchestration', {
            orchestrator: {
                resetScenes: async (_redis, _bookId, _buildId, scenes, cfg, options) => {
                    events.push(`reset:${scenes[0].dirty_layers[0]}`);
                    resetCalls.push({ scenes, cfg, options });
                    return { marked: scenes.length, reset_scenes: scenes.length };
                },
            },
        });
        stub('../src/runtime/runtime-scheduler', {
            addSceneToActiveIndex: async (_redis, _bookId, chapterId, sceneId) => {
                events.push(`activate:${chapterId}/${sceneId}`);
            },
            clearBookFromActiveIndex: async () => {},
        });
        stub('../src/runtime/scene-window', {
            clearCancelFlag: async () => {},
        });

        const handlers = new Map();
        const app = {
            post(path, handler) {
                handlers.set(path, handler);
            },
            get() {},
            put() {},
        };
        const allScenes = [
            { chapter_id: 'ch-1', scene_id: 'scene-a', payload: { units: [] } },
            { chapter_id: 'ch-2', scene_id: 'scene-b', payload: { units: [] } },
        ];
        const deps = {
            config: { HUB_URL: 'http://gpu-hub.invalid' },
            book: {
                loadBook: () => ({ manifest: { build_id: 'build-1' } }),
                collectScenes: () => allScenes,
            },
            layerConfig: {
                get: async () => persistedLayerConfig,
                set: async () => {
                    layerSetCalls++;
                    return persistedLayerConfig;
                },
            },
            bookDiff: {
                filterDirtyScenesByScope: (dirty, scope, chapterId, sceneId) => {
                    if (scope !== 'current_scene') return dirty;
                    return dirty.filter(item =>
                        item.chapter_id === chapterId && item.scene_id === sceneId
                    );
                },
            },
            storage: {},
            utils: { log: () => {} },
        };
        require('../src/routes/book/generation-routes.cjs')(app, redis, deps);
        const handler = handlers.get('/api/v1/book/:bookId/regenerate');

        const audioResponse = createResponse();
        await handler({
            params: { bookId: 'parallel-route-book' },
            body: {
                scope: 'current_scene',
                chapter_id: 'ch-1',
                scene_id: 'scene-a',
                worker_types: ['audio'],
                rebuild_all: true,
            },
        }, audioResponse);
        const imageResponse = createResponse();
        await handler({
            params: { bookId: 'parallel-route-book' },
            body: {
                scope: 'current_scene',
                chapter_id: 'ch-2',
                scene_id: 'scene-b',
                worker_types: ['image'],
                rebuild_all: true,
            },
        }, imageResponse);

        expect(audioResponse.statusCode).to.equal(200);
        expect(imageResponse.statusCode).to.equal(200);
        expect(layerSetCalls).to.equal(0);
        expect(resetCalls).to.have.length(2);
        expect(resetCalls[0].cfg).to.deep.equal({
            audio_enabled: true,
            image_enabled: false,
            video_enabled: false,
        });
        expect(resetCalls[1].cfg).to.deep.equal({
            audio_enabled: false,
            image_enabled: true,
            video_enabled: false,
        });
        expect(resetCalls.every(call => call.options.readdToActiveIndex === false))
            .to.equal(true);

        const tasks = await generationProgress.listTasks(redis, 'parallel-route-book');
        expect(tasks).to.have.length(2);
        expect(tasks.map(task => task.type)).to.have.members(['audio', 'image']);
        expect(tasks.find(task => task.type === 'audio').targets)
            .to.deep.equal([{ chapter_id: 'ch-1', scene_id: 'scene-a' }]);
        expect(tasks.find(task => task.type === 'image').targets)
            .to.deep.equal([{ chapter_id: 'ch-2', scene_id: 'scene-b' }]);

        expect(events.indexOf('reset:audio')).to.be.lessThan(events.indexOf('task:audio'));
        expect(events.indexOf('task:audio')).to.be.lessThan(events.indexOf('activate:ch-1/scene-a'));
        expect(events.indexOf('reset:image')).to.be.lessThan(events.indexOf('task:image'));
        expect(events.indexOf('task:image')).to.be.lessThan(events.indexOf('activate:ch-2/scene-b'));
    });
});
