const { expect } = require('chai');
const genScope = require('../src/services/gen-scope');
const path = require('path');
const fs = require('fs');
const Module = require('module');

class FakeRedis {
    constructor() { this.store = new Map(); this.sets = new Map(); }
    async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
    async set(k, v) { this.store.set(k, v); return 'OK'; }
    async del(k) { this.store.delete(k); if (this.sets.has(k)) this.sets.delete(k); return 1; }
    async sadd(k, v) {
        if (!this.sets.has(k)) this.sets.set(k, new Set());
        this.sets.get(k).add(v);
        return 1;
    }
    async srem(k, v) {
        if (this.sets.has(k)) {
            const deleted = this.sets.get(k).delete(v) ? 1 : 0;
            return deleted;
        }
        return 0;
    }
    async keys(pattern) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return [...this.store.keys()].filter(k => regex.test(k));
    }
    async scan(cursor, ...args) {
        let pattern = null;
        for (let i = 0; i < args.length; i++) {
            if (args[i] === 'MATCH') pattern = args[i + 1];
        }
        if (!pattern) return ['0', []];
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        const matched = [...this.store.keys()].filter(k => regex.test(k));
        return ['0', matched];
    }
}

const allScenes = [
    { chapter_id: 'ch-1', scene_id: 's-1' },
    { chapter_id: 'ch-1', scene_id: 's-2' },
    { chapter_id: 'ch-1', scene_id: 's-3' },
    { chapter_id: 'ch-2', scene_id: 's-1' },
    { chapter_id: 'ch-2', scene_id: 's-2' },
    { chapter_id: 'ch-3', scene_id: 's-1' },
];

function makeStartedState(chapterId, sceneId) {
    return JSON.stringify({ state: 'video_ready', build_id: 'b1' });
}

function loadSceneWindowWithStubs({ redis, startedStateByScene = new Set(), addActiveSceneResult = true, collectScenes = allScenes }) {
    const cwd = path.resolve(__dirname, '..');
    const bookPath = path.join(cwd, 'src/book/index.js');
    const bookStub = {
        loadBook: () => ({ chapters: [], manifest: { build_id: 'b1' } }),
        collectScenes: () => collectScenes,
    };
    require.cache[bookPath] = { exports: bookStub, id: bookPath, loaded: true, filename: bookPath, children: [], paths: [] };

    const statePath = path.join(cwd, 'src/state/index.js');
    const stateStub = {
        SCENE_STATE_KEY_PREFIX: 'animastor:scene-state',
        SceneState: {
            AUDIO_PENDING: 'audio_pending',
            AUDIO_GENERATING: 'audio_generating',
            AUDIO_READY: 'audio_ready',
            IMAGE_PENDING: 'image_pending',
            IMAGE_GENERATING: 'image_generating',
            IMAGE_READY: 'image_ready',
            VIDEO_PENDING: 'video_pending',
            VIDEO_GENERATING: 'video_generating',
            VIDEO_READY: 'video_ready',
            FAILED: 'failed',
        },
        transitionSceneState: async (r, bId, chId, scId, newState) => {
            const key = `animastor:scene-state:${bId}:${chId}:${scId}`;
            const raw = await r.get(key);
            if (raw) {
                const data = JSON.parse(raw);
                data.state = newState;
                await r.set(key, JSON.stringify(data));
            } else {
                await r.set(key, JSON.stringify({ state: newState, build_id: 'b1' }));
            }
            return { success: true };
        },
    };
    require.cache[statePath] = { exports: stateStub, id: statePath, loaded: true, filename: statePath, children: [], paths: [] };

    const activeScenesPath = path.join(cwd, 'src/runtime/active-scenes-index.js');
    const activeScenesStub = { addActiveScene: async () => ({ added: addActiveSceneResult }) };
    require.cache[activeScenesPath] = { exports: activeScenesStub, id: activeScenesPath, loaded: true, filename: activeScenesPath, children: [], paths: [] };

    const audioPath = path.join(cwd, 'src/audio/audio-service.js');
    const audioStub = {
        buildSegments: (s) => [{ padded: `segment-for-${s.chapter_id}-${s.scene_id}` }],
        makeChunkId: (chapterId, sceneId, chunkIndex, bookId) => `${bookId}_${chapterId}_${sceneId}_${String(chunkIndex).padStart(4, '0')}`,
    };
    require.cache[audioPath] = { exports: audioStub, id: audioPath, loaded: true, filename: audioPath, children: [], paths: [] };

    for (const key of startedStateByScene) {
        redis.store.set(`animastor:scene-state:book-1:${key.chapter_id}:${key.scene_id}`, makeStartedState());
    }

    const sceneWindowPath = path.join(cwd, 'src/runtime/scene-window.js');
    delete require.cache[sceneWindowPath];
    return require(sceneWindowPath);
}

describe('scope-aware slideWindow', () => {
    let redis;
    beforeEach(() => { redis = new FakeRedis(); });

    afterEach(() => {
        const cwd = path.resolve(__dirname, '..');
        const bookPath = path.join(cwd, 'src/book/index.js');
        const statePath = path.join(cwd, 'src/state/index.js');
        const activeScenesPath = path.join(cwd, 'src/runtime/active-scenes-index.js');
        const audioPath = path.join(cwd, 'src/audio/audio-service.js');
        const sceneWindowPath = path.join(cwd, 'src/runtime/scene-window.js');
        for (const p of [bookPath, statePath, activeScenesPath, audioPath, sceneWindowPath]) {
            delete require.cache[p];
        }
    });

    it('setWindowBounds with whole_book sets [0, total)', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        const b = await sw.setWindowBounds(redis, 'book-1', { scope: 'whole_book' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 0, endIndex: 6 });
        expect(parseInt(await redis.get(sw.BOOK_SCENE_TOTAL('book-1')))).to.equal(6);
        expect(parseInt(await redis.get(sw.BOOK_SCENE_NEXT('book-1')))).to.equal(0);
        expect(parseInt(await redis.get(sw.BOOK_WINDOW_START('book-1')))).to.equal(0);
    });

    it('setWindowBounds with current_chapter sets the chapter range', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        const b = await sw.setWindowBounds(redis, 'book-1', { scope: 'current_chapter', chapter_id: 'ch-2' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 3, endIndex: 5 });
        expect(parseInt(await redis.get(sw.BOOK_SCENE_TOTAL('book-1')))).to.equal(5);
        expect(parseInt(await redis.get(sw.BOOK_SCENE_NEXT('book-1')))).to.equal(3);
        expect(parseInt(await redis.get(sw.BOOK_WINDOW_START('book-1')))).to.equal(3);
    });

    it('setWindowBounds with current_scene sets single-element range', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        const b = await sw.setWindowBounds(redis, 'book-1', { scope: 'current_scene', chapter_id: 'ch-1', scene_id: 's-2' }, allScenes);
        expect(b).to.deep.equal({ startIndex: 1, endIndex: 2 });
        expect(parseInt(await redis.get(sw.BOOK_SCENE_TOTAL('book-1')))).to.equal(2);
        expect(parseInt(await redis.get(sw.BOOK_SCENE_NEXT('book-1')))).to.equal(1);
    });

    it('slideWindow within current_scene scope only starts that scene', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'current_scene', chapter_id: 'ch-1', scene_id: 's-2' }, allScenes);
        const result = await sw.slideWindow(redis, 'book-1', null, 'b1');
        expect(result.started).to.equal(1);
        expect(result.remaining).to.equal(0);
        expect(parseInt(await redis.get(sw.BOOK_SCENE_NEXT('book-1')))).to.equal(2);
        expect(parseInt(await redis.get(sw.BOOK_WINDOW_START('book-1')))).to.equal(1);
    });

    it('slideWindow within current_chapter scope only starts scenes in chapter', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'current_chapter', chapter_id: 'ch-1' }, allScenes);
        const result = await sw.slideWindow(redis, 'book-1', null, 'b1');
        expect(result.started).to.equal(3);
        expect(result.remaining).to.equal(0);
        expect(parseInt(await redis.get(sw.BOOK_SCENE_NEXT('book-1')))).to.equal(3);
    });

    it('slideWindow across windows chains through scope', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'current_chapter', chapter_id: 'ch-1' }, allScenes);
        // Window is [0,3); WINDOW_SIZE=3 so all 3 scenes start in one call
        const r1 = await sw.slideWindow(redis, 'book-1', null, 'b1');
        expect(r1.started).to.equal(3);
        expect(r1.remaining).to.equal(0);
    });

    it('slideWindow skips already-started scenes within scope', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'whole_book' }, allScenes);
        // Pre-seed ch-1/s-1 as video_ready (terminal state — cached content)
        redis.store.set('animastor:scene-state:book-1:ch-1:s-1', makeStartedState());
        const r = await sw.slideWindow(redis, 'book-1', null, 'b1');
        // Window has 3 slots. Slot 0 consumed by cached ch-1/s-1 (counts toward budget).
        // Slots 1-2 start ch-1/s-2, ch-1/s-3. ch-2/s-1 is beyond the window.
        expect(r.started).to.equal(3);
        expect(parseInt(await redis.get(sw.BOOK_SCENE_NEXT('book-1')))).to.equal(3);
    });

    it('isWindowComplete uses BOOK_WINDOW_START, not WINDOW_SIZE-based', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        // Set bounds for current_scene at ch-1/s-2 (index 1)
        await sw.setWindowBounds(redis, 'book-1', { scope: 'current_scene', chapter_id: 'ch-1', scene_id: 's-2' }, allScenes);
        // Simulate slide started that 1 scene
        await sw.slideWindow(redis, 'book-1', null, 'b1');
        // Mark ONLY ch-1/s-2 as video_ready; ch-1/s-1 is not in scope but is video_ready
        redis.store.set('animastor:scene-state:book-1:ch-1:s-1', makeStartedState());
        redis.store.set('animastor:scene-state:book-1:ch-1:s-2', makeStartedState());
        const ok = await sw.isWindowComplete(redis, 'book-1');
        expect(ok).to.be.true;
    });

    it('isWindowComplete returns false if any in-scope scene not ready', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'current_scene', chapter_id: 'ch-1', scene_id: 's-2' }, allScenes);
        await sw.slideWindow(redis, 'book-1', null, 'b1');
        // ch-1/s-2 has state but not in final form
        redis.store.set('animastor:scene-state:book-1:ch-1:s-2', JSON.stringify({ state: 'audio_pending', build_id: 'b1' }));
        const ok = await sw.isWindowComplete(redis, 'book-1');
        expect(ok).to.be.false;
    });

    it('trySlideWindowOnComplete advances to next batch when current window complete', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'whole_book' }, allScenes);
        // Start first window (3 scenes)
        const r1 = await sw.slideWindow(redis, 'book-1', null, 'b1');
        expect(r1.started).to.equal(3);
        // Mark all started scenes as video_ready
        for (let i = 0; i < 3; i++) {
            const s = allScenes[i];
            redis.store.set(`animastor:scene-state:book-1:${s.chapter_id}:${s.scene_id}`, makeStartedState());
        }
        // Try slide — should start next batch
        const r2 = await sw.trySlideWindowOnComplete(redis, 'book-1', null, 'b1');
        expect(r2.started).to.equal(3);
        expect(parseInt(await redis.get(sw.BOOK_SCENE_NEXT('book-1')))).to.equal(6);
    });

    it('trySlideWindowOnComplete does nothing if window not complete', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'whole_book' }, allScenes);
        await sw.slideWindow(redis, 'book-1', null, 'b1');
        // Don't mark any as ready
        const r = await sw.trySlideWindowOnComplete(redis, 'book-1', null, 'b1');
        expect(r.started).to.equal(0);
        expect(r.reason).to.equal('window_incomplete');
    });

    it('trySlideWindowOnComplete returns done when scope fully covered', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'current_scene', chapter_id: 'ch-1', scene_id: 's-2' }, allScenes);
        await sw.slideWindow(redis, 'book-1', null, 'b1');
        redis.store.set('animastor:scene-state:book-1:ch-1:s-2', makeStartedState());
        const r = await sw.trySlideWindowOnComplete(redis, 'book-1', null, 'b1');
        expect(r.started).to.equal(0);
        expect(r.remaining).to.equal(0);
    });
});

describe('cancel-generation flag', () => {
    let redis;
    beforeEach(() => { redis = new FakeRedis(); });

    afterEach(() => {
        const cwd = path.resolve(__dirname, '..');
        for (const p of [
            path.join(cwd, 'src/book/index.js'),
            path.join(cwd, 'src/state/index.js'),
            path.join(cwd, 'src/runtime/active-scenes-index.js'),
            path.join(cwd, 'src/audio/audio-service.js'),
            path.join(cwd, 'src/runtime/scene-window.js'),
        ]) {
            delete require.cache[p];
        }
    });

    it('setCancelFlag and isCancelled work correctly', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        expect(await sw.isCancelled(redis, 'book-1')).to.be.false;
        await sw.setCancelFlag(redis, 'book-1');
        expect(await sw.isCancelled(redis, 'book-1')).to.be.true;
        await sw.clearCancelFlag(redis, 'book-1');
        expect(await sw.isCancelled(redis, 'book-1')).to.be.false;
    });

    it('slideWindow returns early when cancelled', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'whole_book' }, allScenes);
        await sw.setCancelFlag(redis, 'book-1');
        const r = await sw.slideWindow(redis, 'book-1', null, 'b1');
        expect(r.started).to.equal(0);
        expect(r.reason).to.equal('cancelled');
    });

    it('slideWindow stops mid-window when cancel is set', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'whole_book' }, allScenes);
        // Start sliding - should get up to WINDOW_SIZE scenes
        // Simulate cancel after first scene starts by manually checking in the loop
        // We do this by starting 1 scene, then setting cancel, then calling slideWindow again
        const r1 = await sw.slideWindow(redis, 'book-1', null, 'b1');
        expect(r1.started).to.equal(3);
        // Mark the 3 started scenes as complete
        for (let i = 0; i < 3; i++) {
            redis.store.set(`animastor:scene-state:book-1:${allScenes[i].chapter_id}:${allScenes[i].scene_id}`, makeStartedState());
        }
        await sw.setCancelFlag(redis, 'book-1');
        const r2 = await sw.trySlideWindowOnComplete(redis, 'book-1', null, 'b1');
        expect(r2.started).to.equal(0);
        expect(r2.reason).to.equal('cancelled');
    });

    it('trySlideWindowOnComplete returns cancelled when flag is set', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'whole_book' }, allScenes);
        await sw.slideWindow(redis, 'book-1', null, 'b1');
        // Mark all as ready
        for (let i = 0; i < 3; i++) {
            redis.store.set(`animastor:scene-state:book-1:${allScenes[i].chapter_id}:${allScenes[i].scene_id}`, makeStartedState());
        }
        await sw.setCancelFlag(redis, 'book-1');
        const r = await sw.trySlideWindowOnComplete(redis, 'book-1', null, 'b1');
        expect(r.started).to.equal(0);
        expect(r.reason).to.equal('cancelled');
    });

    it('startScene returns false when cancelled', async () => {
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setCancelFlag(redis, 'book-1');
        const result = await sw.startScene(redis, allScenes[0], 'b1', 'book-1');
        expect(result).to.be.false;
        // No scene state should have been created
        const stateKey = 'animastor:scene-state:book-1:ch-1:s-1';
        expect(await redis.get(stateKey)).to.be.null;
    });
});

describe('scene cache-skip (content on disk)', () => {
    let redis;
    let buildDir;

    beforeEach(() => {
        redis = new FakeRedis();
        buildDir = '/tmp/opencode/test-cache-skip';
        // Clean and create test dir
        try { fs.rmSync(buildDir, { recursive: true }); } catch {}
        fs.mkdirSync(buildDir, { recursive: true });
        // Set OUTPUT_DIR before loading any module that reads it
        process.env.OUTPUT_DIR = buildDir;
        // Clear the cached config module so it picks up the new env value
        const cwd = path.resolve(__dirname, '..');
        delete require.cache[path.join(cwd, 'src/config/runtime-config.js')];
    });

    afterEach(() => {
        try { fs.rmSync(buildDir, { recursive: true }); } catch {}
        delete process.env.OUTPUT_DIR;
        const cwd = path.resolve(__dirname, '..');
        for (const p of [
            path.join(cwd, 'src/book/index.js'),
            path.join(cwd, 'src/state/index.js'),
            path.join(cwd, 'src/runtime/active-scenes-index.js'),
            path.join(cwd, 'src/audio/audio-service.js'),
            path.join(cwd, 'src/runtime/scene-window.js'),
            path.join(cwd, 'src/config/runtime-config.js'),
        ]) {
            delete require.cache[p];
        }
    });

    it('slideWindow resets and restarts non-terminal scene without content on disk', async () => {
        // No content files created — scene should be reset and restarted
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'whole_book' }, allScenes);

        // Seed scene ch-1/s-1 with non-terminal state
        const stateKey = `animastor:scene-state:book-1:ch-1:s-1`;
        redis.store.set(stateKey, JSON.stringify({ state: 'audio_pending', build_id: 'b1' }));

        const r1 = await sw.slideWindow(redis, 'book-1', null, 'b1');
        // Scene is reset+restarted + 2 more to fill the window = 3 total
        expect(r1.started).to.equal(3);
        // ch-1/s-1 should now have a fresh state
        const state = JSON.parse(redis.store.get(stateKey));
        expect(state.state).to.equal('audio_pending');
        expect(state.build_id).to.equal('b1');
    });

    it('slideWindow skips terminal state scene regardless of disk content', async () => {
        // Content does NOT exist on disk but scene state is VIDEO_READY
        // Scene should still be skipped (we trust the state machine)
        const sw = loadSceneWindowWithStubs({ redis });
        await sw.setWindowBounds(redis, 'book-1', { scope: 'whole_book' }, allScenes);

        const stateKey = `animastor:scene-state:book-1:ch-1:s-1`;
        redis.store.set(stateKey, JSON.stringify({ state: 'video_ready', build_id: 'b1' }));

        const r1 = await sw.slideWindow(redis, 'book-1', null, 'b1');
        // First window has 3 slots: slot 0 consumed by cached scene, slots 1-2 start fresh
        expect(r1.started).to.equal(3);
        expect(parseInt(await redis.get(sw.BOOK_SCENE_NEXT('book-1')))).to.equal(3);
    });
});
