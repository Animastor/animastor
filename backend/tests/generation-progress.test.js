const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const generationProgress = require('../src/services/generation-progress');

describe('Generation progress task registry', () => {
    it('keeps multiple commands of the same worker type independent', async () => {
        const redis = createMockRedis();
        const bookId = 'generation-progress-parallel';

        const [first] = await generationProgress.createTasks(
            redis,
            bookId,
            ['audio'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'scene-1' },
            [{ chapter_id: 'ch-1', scene_id: 'scene-1', dirty_layers: ['audio'] }]
        );
        const [second] = await generationProgress.createTasks(
            redis,
            bookId,
            ['audio'],
            { scope: 'current_scene', chapterId: 'ch-2', sceneId: 'scene-2' },
            [{ chapter_id: 'ch-2', scene_id: 'scene-2', dirty_layers: ['audio'] }]
        );

        const tasks = await generationProgress.listTasks(redis, bookId);

        expect(first.task_id).to.not.equal(second.task_id);
        expect(tasks).to.have.length(2);
        expect(tasks.map(task => task.task_id)).to.have.members([
            first.task_id,
            second.task_id,
        ]);
    });

    it('cancels one task without changing a sibling task', async () => {
        const redis = createMockRedis();
        const bookId = 'generation-progress-cancel';

        const [first] = await generationProgress.createTasks(
            redis,
            bookId,
            ['image'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'scene-1' },
            [{ chapter_id: 'ch-1', scene_id: 'scene-1', dirty_layers: ['image'] }]
        );
        const [second] = await generationProgress.createTasks(
            redis,
            bookId,
            ['image'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'scene-2' },
            [{ chapter_id: 'ch-1', scene_id: 'scene-2', dirty_layers: ['image'] }]
        );

        await generationProgress.markCancelled(redis, bookId, first.task_id);

        expect((await generationProgress.getTask(redis, bookId, first.task_id)).status)
            .to.equal('cancelled');
        expect((await generationProgress.getTask(redis, bookId, second.task_id)).status)
            .to.equal('active');
    });

    it('reports active worker types independently for each scene', async () => {
        const redis = createMockRedis();
        const bookId = 'generation-progress-scene-state';

        const [audioTask] = await generationProgress.createTasks(
            redis,
            bookId,
            ['audio'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'scene-1' },
            [{ chapter_id: 'ch-1', scene_id: 'scene-1', dirty_layers: ['audio'] }]
        );
        await generationProgress.createTasks(
            redis,
            bookId,
            ['image'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'scene-2' },
            [{ chapter_id: 'ch-1', scene_id: 'scene-2', dirty_layers: ['image'] }]
        );

        const firstState = await generationProgress.getSceneTaskState(
            redis,
            bookId,
            'ch-1',
            'scene-1'
        );
        const secondState = await generationProgress.getSceneTaskState(
            redis,
            bookId,
            'ch-1',
            'scene-2'
        );

        expect(firstState.managed).to.equal(true);
        expect([...firstState.activeTypes]).to.deep.equal(['audio']);
        expect([...secondState.activeTypes]).to.deep.equal(['image']);

        await generationProgress.markCompleted(redis, bookId, audioTask.task_id);
        const completedState = await generationProgress.getSceneTaskState(
            redis,
            bookId,
            'ch-1',
            'scene-1'
        );
        expect(completedState.managed).to.equal(true);
        expect([...completedState.activeTypes]).to.deep.equal([]);
    });

    it('completes tasks from asset state without progress-panel polling', async () => {
        const redis = createMockRedis();
        const bookId = 'generation-progress-backend-completion';
        const [task] = await generationProgress.createTasks(
            redis,
            bookId,
            ['video'],
            { scope: 'current_chapter', chapterId: 'ch-1' },
            [
                { chapter_id: 'ch-1', scene_id: 'scene-1', dirty_layers: ['video'] },
                { chapter_id: 'ch-1', scene_id: 'scene-2', dirty_layers: ['video'] },
            ]
        );
        const states = new Map([
            ['ch-1:scene-1', { video: 'ready' }],
            ['ch-1:scene-2', { video: 'generating' }],
        ]);
        const readStates = async (_redis, _bookId, chapterId, sceneId) =>
            states.get(`${chapterId}:${sceneId}`);

        expect(await generationProgress.reconcileCompletedTasks(
            redis,
            bookId,
            readStates
        )).to.deep.equal([]);
        expect((await generationProgress.getTask(redis, bookId, task.task_id)).status)
            .to.equal('active');

        states.set('ch-1:scene-2', { video: 'ready' });
        const completed = await generationProgress.reconcileCompletedTasks(
            redis,
            bookId,
            readStates
        );

        expect(completed.map(item => item.task_id)).to.deep.equal([task.task_id]);
        expect((await generationProgress.getTask(redis, bookId, task.task_id)).status)
            .to.equal('completed');
    });

    it('removes legacy per-type scope records so active-state fallback can run', async () => {
        const redis = createMockRedis();
        const bookId = 'generation-progress-legacy';
        await redis.hset(
            generationProgress.key(bookId),
            'audio',
            JSON.stringify({
                scope: 'current_scene',
                chapter_id: 'ch-1',
                scene_id: 'scene-1',
                started_at: Date.now(),
            })
        );

        expect(await generationProgress.listTasks(redis, bookId)).to.deep.equal([]);
        expect(await redis.hget(generationProgress.key(bookId), 'audio')).to.equal(null);
    });

    it('does not complete a task that was cancelled during reconciliation', async () => {
        const redis = createMockRedis();
        const bookId = 'generation-progress-cancel-race';
        const [task] = await generationProgress.createTasks(
            redis,
            bookId,
            ['audio'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'scene-1' },
            [{ chapter_id: 'ch-1', scene_id: 'scene-1', dirty_layers: ['audio'] }]
        );
        const readStates = async () => {
            await generationProgress.markCancelled(redis, bookId, task.task_id);
            return { audio: 'ready' };
        };

        const completed = await generationProgress.reconcileCompletedTasks(
            redis,
            bookId,
            readStates
        );

        expect(completed).to.deep.equal([]);
        expect((await generationProgress.getTask(redis, bookId, task.task_id)).status)
            .to.equal('cancelled');
    });
});
