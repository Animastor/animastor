// ======================================================
// Video Orchestrator Tests — phase machine + group collection
// ======================================================
// Tests the Video Orchestrator state machine:
//   GENERATING → WAITING_CHUNKS → MERGING → DONE
//                                    ↘ FAILED ↗
// Plus completeGroup (multi-group collection + merge for player),
// failWaitingScene, and scanAllStates.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMockRedis } = require('./mocks/redis-mock');

// ── Stub runtime-config so video-orch writes to a temp dir ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-orch-test-'));
const configModule = require.resolve('../src/config/runtime-config');
const savedConfigCache = require.cache[configModule];
require.cache[configModule] = {
    id: configModule,
    filename: configModule,
    loaded: true,
    exports: { OUTPUT_DIR: tmpRoot },
};
const videoOrch = require('../src/services/video-orchestrator');
require.cache[configModule] = savedConfigCache;

const BOOK_ID = 'test-book';
const CHAPTER_ID = 'ch-1';
const SCENE_ID = 'sc-42';
const BUILD_ID = 'build-1';
const PREFIX = `${BOOK_ID}_${CHAPTER_ID}_${SCENE_ID}`;

// Fake merge: creates the merged `scene.mp4` by concatenating group files.
const fakeVideoMerge = {
    async mergeSceneVideoGroups(redis, buildId, bookId, chapterId, sceneId, suffixes) {
        const mergedPath = path.join(tmpRoot, buildId, `${bookId}_${chapterId}_${sceneId}.mp4`);
        const parts = (suffixes || []).map(s => path.join(tmpRoot, buildId, `${bookId}_${chapterId}_${sceneId}${s || ''}.mp4`));
        const buf = Buffer.concat(parts.map(p => fs.readFileSync(p)));
        fs.writeFileSync(mergedPath, buf);
        return mergedPath;
    },
};

// Fake orchestrator — records completeStage/failStage calls.
function makeFakeOrchestrator() {
    const calls = { completeStage: [], failStage: [] };
    return {
        calls,
        async completeStage(redis, bookId, chapterId, sceneId, stage, buildId, dispatchId) {
            calls.completeStage.push({ bookId, chapterId, sceneId, stage, buildId, dispatchId });
            return { completed: true };
        },
        async failStage(redis, bookId, chapterId, sceneId, stage, buildId, reason, opts) {
            calls.failStage.push({ bookId, chapterId, sceneId, stage, buildId, reason, opts });
            return { failed: true };
        },
    };
}

function writeGroupFile(suffix, size = 20480) {
    const buildDir = path.join(tmpRoot, BUILD_ID);
    fs.mkdirSync(buildDir, { recursive: true });
    const filePath = path.join(buildDir, `${PREFIX}${suffix || ''}.mp4`);
    fs.writeFileSync(filePath, Buffer.alloc(size, 1));
    return filePath;
}

describe('Video Orchestrator — Phase Machine', () => {
    let redis;

    beforeEach(() => {
        redis = createMockRedis();
    });

    describe('initState', () => {
        it('creates GENERATING state with groups from unit mapping', async () => {
            const state = await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
                { suffix: '_g1', unit_ids: ['u1', 'u2'] },
                { suffix: '_g2', unit_ids: ['u3'] },
            ]);

            expect(state.phase).to.equal(videoOrch.PHASES.GENERATING);
            expect(state.expected_count).to.equal(2);
            expect(state.groups).to.have.length(2);
            expect(state.groups[0]).to.deep.include({ suffix: '_g1', status: 'pending' });
            expect(state.groups[0].unit_ids).to.deep.equal(['u1', 'u2']);
            expect(state.groups[1]).to.deep.include({ suffix: '_g2', status: 'pending' });
            expect(state.build_id).to.equal(BUILD_ID);
        });

        it('getState reads back the same state', async () => {
            await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
                { suffix: '_g1', unit_ids: [] },
            ]);
            const state = await videoOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state).to.not.be.null;
            expect(state.phase).to.equal(videoOrch.PHASES.GENERATING);
        });

        it('returns null for non-existent scene', async () => {
            const state = await videoOrch.getState(redis, 'no-book', 'ch-99', 's-99');
            expect(state).to.be.null;
        });
    });

    describe('happy path transitions', () => {
        beforeEach(async () => {
            await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
                { suffix: '_g1', unit_ids: ['u1'] },
            ]);
        });

        it('GENERATING → WAITING_CHUNKS → MERGING → DONE', async () => {
            expect((await videoOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).success).to.be.true;
            expect((await videoOrch.setMerging(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).success).to.be.true;
            expect((await videoOrch.setDone(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).success).to.be.true;

            const state = await videoOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state.phase).to.equal(videoOrch.PHASES.DONE);
        });

        it('WAITING_CHUNKS → FAILED', async () => {
            await videoOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            const result = await videoOrch.setFailed(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'timeout');
            expect(result.success).to.be.true;

            const state = await videoOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state.phase).to.equal(videoOrch.PHASES.FAILED);
            expect(state.fail_reason).to.equal('timeout');
        });

        it('FAILED → GENERATING (scheduler re-dispatch)', async () => {
            await videoOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await videoOrch.setFailed(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'timeout');

            const result = await videoOrch.transitionState(
                redis, BOOK_ID, CHAPTER_ID, SCENE_ID, videoOrch.PHASES.GENERATING
            );
            expect(result.success).to.be.true;
        });
    });

    describe('invalid transitions', () => {
        it('rejects GENERATING → DONE (skip WAITING_CHUNKS + MERGING)', async () => {
            await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
                { suffix: '_g1', unit_ids: [] },
            ]);
            const result = await videoOrch.setDone(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result.success).to.be.false;
            expect(result.reason).to.equal('invalid_transition');
        });

        it('rejects transition when no state exists', async () => {
            const result = await videoOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result.success).to.be.false;
            expect(result.reason).to.equal('no_state');
        });

        it('rejects DONE → any (terminal)', async () => {
            await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
                { suffix: '_g1', unit_ids: [] },
            ]);
            await videoOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await videoOrch.setMerging(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await videoOrch.setDone(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

            const result = await videoOrch.setFailed(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'late');
            expect(result.success).to.be.false;
            expect(result.reason).to.equal('invalid_transition');
        });
    });

    describe('scanAllStates', () => {
        it('finds all created states with identifiers', async () => {
            await videoOrch.initState(redis, 'book-a', 'ch-1', 's-1', BUILD_ID, [{ suffix: '_g1', unit_ids: [] }]);
            await videoOrch.initState(redis, 'my_long_book', 'ch-1', 'sc-a1b2', BUILD_ID, [{ suffix: '_g1', unit_ids: [] }]);

            const results = await videoOrch.scanAllStates(redis);
            expect(results).to.have.lengthOf(2);
            const long = results.find(r => r.bookId === 'my_long_book');
            expect(long.chapterId).to.equal('ch-1');
            expect(long.sceneId).to.equal('sc-a1b2');
        });
    });
});

describe('Video Orchestrator — completeGroup (multi-group collection)', () => {
    let redis;
    let orchestrator;
    let buildDir;

    beforeEach(() => {
        redis = createMockRedis();
        orchestrator = makeFakeOrchestrator();
        buildDir = path.join(tmpRoot, BUILD_ID);
        fs.rmSync(buildDir, { recursive: true, force: true });
    });

    it('accepts groups one by one, waits in WAITING_CHUNKS until all present', async () => {
        const groups = [
            { suffix: '_g1', unit_ids: ['u1'] },
            { suffix: '_g2', unit_ids: ['u2'] },
            { suffix: '_g3', unit_ids: ['u3'] },
        ];
        await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, groups);

        // First group arrives → file written by task-handler before completeGroup
        writeGroupFile('_g1');
        let result = await videoOrch.completeGroup(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g1', BUILD_ID, {
            orchestrator,
            videoMerge: fakeVideoMerge,
            dispatchId: 'dispatch-1',
        });
        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('waiting_groups');
        let state = await videoOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(state.phase).to.equal(videoOrch.PHASES.WAITING_CHUNKS); // safety-net transition
        expect(state.groups_received).to.equal(1);
        expect(orchestrator.calls.completeStage).to.have.length(0); // НЕ завершаем на первом

        // Second group
        writeGroupFile('_g2');
        result = await videoOrch.completeGroup(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g2', BUILD_ID, {
            orchestrator,
            videoMerge: fakeVideoMerge,
            dispatchId: 'dispatch-1',
        });
        expect(result.completed).to.be.false;
        expect(orchestrator.calls.completeStage).to.have.length(0);

        // Third group → all present → MERGING → DONE + completeStage
        writeGroupFile('_g3');
        result = await videoOrch.completeGroup(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g3', BUILD_ID, {
            orchestrator,
            videoMerge: fakeVideoMerge,
            dispatchId: 'dispatch-1',
        });
        expect(result.completed).to.be.true;
        state = await videoOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(state.phase).to.equal(videoOrch.PHASES.DONE);

        // Merged file for the player exists, group files retained
        expect(fs.existsSync(path.join(buildDir, `${PREFIX}.mp4`))).to.be.true;
        expect(fs.existsSync(path.join(buildDir, `${PREFIX}_g1.mp4`))).to.be.true;
        expect(fs.existsSync(path.join(buildDir, `${PREFIX}_g2.mp4`))).to.be.true;
        expect(fs.existsSync(path.join(buildDir, `${PREFIX}_g3.mp4`))).to.be.true;

        expect(orchestrator.calls.completeStage).to.have.length(1);
        expect(orchestrator.calls.completeStage[0]).to.deep.include({
            bookId: BOOK_ID, chapterId: CHAPTER_ID, sceneId: SCENE_ID, stage: 'video', buildId: BUILD_ID,
        });
    });

    it('completeGroup on already DONE is a no-op', async () => {
        await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
            { suffix: '_g1', unit_ids: ['u1'] },
        ]);
        writeGroupFile('_g1');
        await videoOrch.completeGroup(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g1', BUILD_ID, {
            orchestrator, videoMerge: fakeVideoMerge, dispatchId: 'dispatch-1',
        });
        expect(orchestrator.calls.completeStage).to.have.length(1);

        const again = await videoOrch.completeGroup(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g1', BUILD_ID, {
            orchestrator, videoMerge: fakeVideoMerge, dispatchId: 'dispatch-1',
        });
        expect(again.completed).to.be.true;
        expect(again.reason).to.equal('already_done');
        expect(orchestrator.calls.completeStage).to.have.length(1); // не дублируется
    });

    it('merge returning null (lock held by another caller) → NOT a failure, waits in MERGING', async () => {
        const lockHeldMerge = {
            async mergeSceneVideoGroups() { return null; },
        };
        await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
            { suffix: '_g1', unit_ids: ['u1'] },
        ]);
        writeGroupFile('_g1');
        const result = await videoOrch.completeGroup(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g1', BUILD_ID, {
            orchestrator,
            videoMerge: lockHeldMerge,
            dispatchId: 'dispatch-1',
        });
        // Проигравший гонку merge-лока не валит сцену в FAILED — ждёт победителя.
        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('merging');

        const state = await videoOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(state.phase).to.equal(videoOrch.PHASES.MERGING);
        expect(orchestrator.calls.completeStage).to.have.length(0);
    });

    it('merge throwing (ffmpeg error) → FAILED, no completeStage', async () => {
        const throwingMerge = {
            async mergeSceneVideoGroups() { throw new Error('ffmpeg exited with code 1'); },
        };
        await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
            { suffix: '_g1', unit_ids: ['u1'] },
        ]);
        writeGroupFile('_g1');
        const result = await videoOrch.completeGroup(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g1', BUILD_ID, {
            orchestrator,
            videoMerge: throwingMerge,
            dispatchId: 'dispatch-1',
        });
        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('merge_error');

        const state = await videoOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(state.phase).to.equal(videoOrch.PHASES.FAILED);
        expect(state.fail_reason).to.include('ffmpeg');
        expect(orchestrator.calls.completeStage).to.have.length(0);
    });

    it('stale-dispatch late group accepted while WAITING_CHUNKS', async () => {
        await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
            { suffix: '_g1', unit_ids: ['u1'] },
            { suffix: '_g2', unit_ids: ['u2'] },
        ]);
        await videoOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

        // Late group from a PREVIOUS dispatch — still accepted (stale-accept path
        // происходит в task-handler, здесь проверяем, что completeGroup сам не
        // отвергает по dispatch identity).
        writeGroupFile('_g1');
        writeGroupFile('_g2');
        const result = await videoOrch.completeGroup(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g2', BUILD_ID, {
            orchestrator,
            videoMerge: fakeVideoMerge,
            dispatchId: 'stale-dispatch-old',
        });
        expect(result.completed).to.be.true;
        expect(orchestrator.calls.completeStage).to.have.length(1);
    });

    it('legacy single-group (no state) completes via direct completeStage', async () => {
        const result = await videoOrch.completeGroup(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '', BUILD_ID, {
            orchestrator,
            videoMerge: fakeVideoMerge,
            dispatchId: 'legacy-dispatch',
        });
        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('no_state_legacy');
        expect(orchestrator.calls.completeStage).to.have.length(1);
    });
});

describe('Video Orchestrator — failWaitingScene', () => {
    let redis;
    let orchestrator;

    beforeEach(() => {
        redis = createMockRedis();
        orchestrator = makeFakeOrchestrator();
    });

    it('fails scene stuck in WAITING_CHUNKS with missing groups', async () => {
        await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
            { suffix: '_g1', unit_ids: ['u1'] },
            { suffix: '_g2', unit_ids: ['u2'] },
        ]);
        await videoOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

        const result = await videoOrch.failWaitingScene(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, 'stall:120s', {
            orchestrator,
            dispatchId: 'dispatch-1',
        });
        expect(result.failed).to.be.true;
        expect(result.missing).to.deep.equal(['_g1', '_g2']);

        const state = await videoOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(state.phase).to.equal(videoOrch.PHASES.FAILED);
        expect(state.fail_reason).to.equal('stall:120s');
        expect(orchestrator.calls.failStage).to.have.length(1);
        expect(orchestrator.calls.failStage[0]).to.deep.include({ stage: 'video', buildId: BUILD_ID });
    });

    it('is a no-op when not in WAITING_CHUNKS', async () => {
        await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
            { suffix: '_g1', unit_ids: [] },
        ]);
        const result = await videoOrch.failWaitingScene(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, 'x', {
            orchestrator,
        });
        expect(result.failed).to.be.false;
        expect(result.reason).to.equal('not_waiting_chunks');
        expect(orchestrator.calls.failStage).to.have.length(0);
    });
});

describe('Video Orchestrator — group helpers', () => {
    it('groupFilePath builds correct path with suffix', () => {
        expect(videoOrch.groupFilePath(BUILD_ID, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g2'))
            .to.equal(path.join(tmpRoot, BUILD_ID, `${PREFIX}_g2.mp4`));
        expect(videoOrch.groupFilePath(BUILD_ID, BOOK_ID, CHAPTER_ID, SCENE_ID, ''))
            .to.equal(path.join(tmpRoot, BUILD_ID, `${PREFIX}.mp4`));
    });

    it('isGroupFileValid returns false for missing/empty file', () => {
        expect(videoOrch.isGroupFileValid(BUILD_ID, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g9')).to.be.false;
        const tiny = path.join(tmpRoot, BUILD_ID, `${PREFIX}_tiny.mp4`);
        fs.mkdirSync(path.dirname(tiny), { recursive: true });
        fs.writeFileSync(tiny, Buffer.alloc(10, 1));
        expect(videoOrch.isGroupFileValid(BUILD_ID, BOOK_ID, CHAPTER_ID, SCENE_ID, '_tiny')).to.be.false;
    });

    it('allGroupsDone / groupSuffixes reflect group status', async () => {
        const redis = createMockRedis();
        await videoOrch.initState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, [
            { suffix: '_g1', unit_ids: [] },
            { suffix: '_g2', unit_ids: [] },
        ]);
        expect(videoOrch.allGroupsDone(await videoOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID))).to.be.false;
        await videoOrch.markGroupDone(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g1');
        await videoOrch.markGroupDone(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, '_g2');
        const state = await videoOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(videoOrch.allGroupsDone(state)).to.be.true;
        expect(videoOrch.groupSuffixes(state)).to.deep.equal(['_g1', '_g2']);
        expect(state.groups_received).to.equal(2);
    });
});
