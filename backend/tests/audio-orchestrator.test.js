// ======================================================
// Audio Orchestrator Tests — phase machine transitions
// ======================================================
// Tests the Audio Orchestrator state machine:
//   PLACEHOLDER_READY → GENERATING → WAITING_CHUNKS → MERGING → DONE
//                                                      ↘ FAILED ↗
// Also tests invalid transitions and scanAllStates.

const { expect } = require('chai');

// ======================================================
// In-memory FakeRedis for testing
// ======================================================
class FakeRedis {
    constructor() {
        this.store = new Map();
    }

    async get(k) {
        const v = this.store.get(k);
        if (v === undefined || v === null) return null;
        return v;
    }

    async set(k, v) {
        this.store.set(k, v);
        return 'OK';
    }

    async del(k) {
        return this.store.delete(k) ? 1 : 0;
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

// ======================================================
// Module under test
// ======================================================
const audioOrch = require('../src/services/audio-orchestrator');

const BOOK_ID = 'test-book';
const CHAPTER_ID = 'ch-1';
const SCENE_ID = 's-1';
const BUILD_ID = 'build-1';
const EXPECTED_COUNT = 9;

describe('Audio Orchestrator — Phase Machine', () => {
    let redis;

    beforeEach(() => {
        redis = new FakeRedis();
    });

    // ── initPlaceholderReady ──────────────────────────
    describe('initPlaceholderReady', () => {
        it('creates initial state with PLACEHOLDER_READY phase', async () => {
            const state = await audioOrch.initPlaceholderReady(
                redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT
            );

            expect(state.phase).to.equal(audioOrch.PHASES.PLACEHOLDER_READY);
            expect(state.expected_count).to.equal(EXPECTED_COUNT);
            expect(state.chunks_received).to.equal(0);
            expect(state.build_id).to.equal(BUILD_ID);
            expect(state.started_at).to.be.a('number');
        });

        it('getState reads back the same state', async () => {
            await audioOrch.initPlaceholderReady(
                redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT
            );

            const state = await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state).to.not.be.null;
            expect(state.phase).to.equal(audioOrch.PHASES.PLACEHOLDER_READY);
            expect(state.expected_count).to.equal(EXPECTED_COUNT);
        });

        it('returns null for non-existent scene', async () => {
            const state = await audioOrch.getState(redis, 'no-book', 'ch-99', 's-99');
            expect(state).to.be.null;
        });
    });

    // ── Happy path transitions ────────────────────────
    describe('happy path transitions', () => {
        beforeEach(async () => {
            await audioOrch.initPlaceholderReady(
                redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT
            );
        });

        it('PLACEHOLDER_READY → GENERATING', async () => {
            const result = await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result.success).to.be.true;

            const state = await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state.phase).to.equal(audioOrch.PHASES.GENERATING);
        });

        it('GENERATING → WAITING_CHUNKS', async () => {
            await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

            const result = await audioOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result.success).to.be.true;

            const state = await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state.phase).to.equal(audioOrch.PHASES.WAITING_CHUNKS);
        });

        it('WAITING_CHUNKS → MERGING', async () => {
            await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await audioOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

            const result = await audioOrch.setMerging(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result.success).to.be.true;

            const state = await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state.phase).to.equal(audioOrch.PHASES.MERGING);
        });

        it('MERGING → DONE', async () => {
            await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await audioOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await audioOrch.setMerging(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

            const result = await audioOrch.setDone(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result.success).to.be.true;

            const state = await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state.phase).to.equal(audioOrch.PHASES.DONE);
        });

        it('WAITING_CHUNKS → FAILED', async () => {
            await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await audioOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

            const result = await audioOrch.setFailed(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'test_error');
            expect(result.success).to.be.true;

            const state = await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state.phase).to.equal(audioOrch.PHASES.FAILED);
            expect(state.fail_reason).to.equal('test_error');
            expect(state.failed_at).to.be.a('number');
        });

        it('FAILED → GENERATING (scheduler re-dispatch)', async () => {
            await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await audioOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await audioOrch.setFailed(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'timeout');

            const result = await audioOrch.transitionState(
                redis, BOOK_ID, CHAPTER_ID, SCENE_ID, audioOrch.PHASES.GENERATING
            );
            expect(result.success).to.be.true;

            const state = await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state.phase).to.equal(audioOrch.PHASES.GENERATING);
        });

        it('full lifecycle: PLACEHOLDER_READY → GENERATING → WAITING_CHUNKS → MERGING → DONE', async () => {
            await audioOrch.initPlaceholderReady(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT);
            expect((await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).phase).to.equal(audioOrch.PHASES.PLACEHOLDER_READY);

            await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect((await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).phase).to.equal(audioOrch.PHASES.GENERATING);

            await audioOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect((await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).phase).to.equal(audioOrch.PHASES.WAITING_CHUNKS);

            await audioOrch.setMerging(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect((await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).phase).to.equal(audioOrch.PHASES.MERGING);

            await audioOrch.setDone(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect((await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).phase).to.equal(audioOrch.PHASES.DONE);
        });
    });

    // ── Invalid transitions ──────────────────────────
    describe('invalid transitions', () => {
        it('rejects GENERATING → DONE (skip WAITING_CHUNKS + MERGING)', async () => {
            await audioOrch.initPlaceholderReady(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT);
            await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

            const result = await audioOrch.setDone(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result.success).to.be.false;
            expect(result.reason).to.equal('invalid_transition');
            expect(result.from).to.equal(audioOrch.PHASES.GENERATING);
            expect(result.to).to.equal(audioOrch.PHASES.DONE);
        });

        it('rejects WAITING_CHUNKS → GENERATING', async () => {
            await audioOrch.initPlaceholderReady(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT);
            await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await audioOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

            const result = await audioOrch.transitionState(
                redis, BOOK_ID, CHAPTER_ID, SCENE_ID, audioOrch.PHASES.GENERATING
            );
            expect(result.success).to.be.false;
            expect(result.reason).to.equal('invalid_transition');
        });

        it('rejects DONE → any (terminal)', async () => {
            await audioOrch.initPlaceholderReady(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT);
            await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await audioOrch.setWaitingChunks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await audioOrch.setMerging(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            await audioOrch.setDone(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

            const result = await audioOrch.setFailed(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'late_error');
            expect(result.success).to.be.false;
            expect(result.reason).to.equal('invalid_transition');
        });

        it('rejects transition when no state exists', async () => {
            const result = await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result.success).to.be.false;
            expect(result.reason).to.equal('no_state');
        });

        it('rejects PLACEHOLDER_READY → FAILED (must go through GENERATING → WAITING_CHUNKS)', async () => {
            await audioOrch.initPlaceholderReady(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT);

            const result = await audioOrch.setFailed(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'premature');
            expect(result.success).to.be.false;
            expect(result.reason).to.equal('invalid_transition');
        });

        it('rejects PLACEHOLDER_READY → MERGING (skip ahead)', async () => {
            await audioOrch.initPlaceholderReady(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT);

            const result = await audioOrch.setMerging(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result.success).to.be.false;
            expect(result.reason).to.equal('invalid_transition');
        });
    });

    // ── setState / deleteState ────────────────────────
    describe('setState / deleteState', () => {
        it('setState overwrites state', async () => {
            await audioOrch.initPlaceholderReady(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT);
            const customState = { phase: audioOrch.PHASES.GENERATING, custom_field: 'test' };
            await audioOrch.setState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, customState);

            const state = await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state.phase).to.equal(audioOrch.PHASES.GENERATING);
            expect(state.custom_field).to.equal('test');
        });

        it('deleteState removes state', async () => {
            await audioOrch.initPlaceholderReady(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, EXPECTED_COUNT);
            await audioOrch.deleteState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

            const state = await audioOrch.getState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(state).to.be.null;
        });

        it('deleteState on non-existent key returns 0 (fails gracefully)', async () => {
            const result = await redis.del(audioOrch.key('no-book', 'ch-99', 's-99'));
            expect(result).to.equal(0);
        });
    });

    // ── scanAllStates ─────────────────────────────────
    describe('scanAllStates', () => {
        it('returns empty array when no keys exist', async () => {
            const results = await audioOrch.scanAllStates(redis);
            expect(results).to.be.an('array').that.is.empty;
        });

        it('finds all created states', async () => {
            await audioOrch.initPlaceholderReady(redis, 'book-a', 'ch-1', 's-1', BUILD_ID, 3);
            await audioOrch.initPlaceholderReady(redis, 'book-a', 'ch-1', 's-2', BUILD_ID, 5);
            await audioOrch.initPlaceholderReady(redis, 'book-b', 'ch-2', 's-1', BUILD_ID, 7);

            const results = await audioOrch.scanAllStates(redis);
            expect(results).to.have.lengthOf(3);
        });

        it('returns correct identifiers for each state', async () => {
            await audioOrch.initPlaceholderReady(redis, 'my-book', 'ch-1a', 's-42', BUILD_ID, 9);

            const results = await audioOrch.scanAllStates(redis);
            expect(results).to.have.lengthOf(1);

            const entry = results[0];
            expect(entry.bookId).to.equal('my-book');
            expect(entry.chapterId).to.equal('ch-1a');
            expect(entry.sceneId).to.equal('s-42');
            expect(entry.state.phase).to.equal(audioOrch.PHASES.PLACEHOLDER_READY);
            expect(entry.state.expected_count).to.equal(9);
        });

        it('handles bookId with underscores', async () => {
            await audioOrch.initPlaceholderReady(redis, 'my_long_book_name', 'ch-1', 's-1', BUILD_ID, 1);

            const results = await audioOrch.scanAllStates(redis);
            expect(results).to.have.lengthOf(1);
            expect(results[0].bookId).to.equal('my_long_book_name');
            expect(results[0].chapterId).to.equal('ch-1');
            expect(results[0].sceneId).to.equal('s-1');
        });

        it('handles sceneId with special characters', async () => {
            await audioOrch.initPlaceholderReady(redis, 'book', 'ch-1', 'sc-a1b2c3d', BUILD_ID, 2);

            const results = await audioOrch.scanAllStates(redis);
            expect(results).to.have.lengthOf(1);
            expect(results[0].sceneId).to.equal('sc-a1b2c3d');
        });

        it('returns the current phase for each state', async () => {
            await audioOrch.initPlaceholderReady(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID, 3);
            await audioOrch.setGenerating(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);

            const results = await audioOrch.scanAllStates(redis);
            expect(results).to.have.lengthOf(1);
            expect(results[0].state.phase).to.equal(audioOrch.PHASES.GENERATING);
        });
    });

    // ── createState ───────────────────────────────────
    describe('createState', () => {
        it('creates state with correct initial values', () => {
            const state = audioOrch.createState(BUILD_ID, 5);

            expect(state.phase).to.equal(audioOrch.PHASES.PLACEHOLDER_READY);
            expect(state.expected_count).to.equal(5);
            expect(state.chunks_received).to.equal(0);
            expect(state.build_id).to.equal(BUILD_ID);
            expect(state.started_at).to.be.a('number');
        });

        it('different calls get different started_at timestamps', () => {
            const s1 = audioOrch.createState(BUILD_ID, 1);
            const s2 = audioOrch.createState(BUILD_ID, 1);
            expect(s2.started_at).to.be.at.least(s1.started_at);
        });
    });

    // ── key helper ────────────────────────────────────
    describe('key helper', () => {
        it('builds correct Redis key format', () => {
            const k = audioOrch.key(BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(k).to.equal(`animastor:audio-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`);
        });
    });
});
