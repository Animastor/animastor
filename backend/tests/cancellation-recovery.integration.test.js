// ======================================================
// Cancellation Tombstone — Integration Recovery Test (real PG)
// ======================================================
// Cathedral Recon #3 §5.4 / Operation #1 Definition of Done:
//
//   cancel
//     → PG tombstone
//     → Redis wiped
//     → backend restart
//     → startup-resume (Phase C5)
//     → cancelled session NOT resumed
//
// Uses the real PostgreSQL connection (same pattern as book-sync.test.js)
// and the REAL startup-resume module. Only `runBgGen` is faked — it is the
// entry point into window generation and must never fire for a cancelled book.

const { expect } = require('chai');
const path = require('path');

const TEST_BOOK_CANCELLED = 'recovery-test-cancelled';
const TEST_BOOK_LIVE = 'recovery-test-live';

const postgres = require('../src/storage/postgres');
const genSessionRepo = require('../src/storage/postgres/repositories/gen-session-repo');
const generationCancelRepo = require('../src/storage/postgres/repositories/generation-cancel-repo');
const { resumeIncompleteSessions } = require('../src/startup-resume');

const flushImmediates = () => new Promise(resolve => setImmediate(resolve));

// resumeIncompleteSessions scans ALL book_generation_sessions in the real DB,
// not just our test books. Filter out unrelated books so leftover/real dev data
// can never break the assertions.
const onlyTestBooks = (started) => started.filter(s =>
    s.bookId === TEST_BOOK_CANCELLED || s.bookId === TEST_BOOK_LIVE
);

describe('cancellation tombstone — recovery integration (real PG)', function () {
    this.timeout(20000);

    before(async () => {
        await postgres.initialize();
    });

    afterEach(async () => {
        // Clean up all rows created by the tests.
        for (const bookId of [TEST_BOOK_CANCELLED, TEST_BOOK_LIVE]) {
            await postgres.query('DELETE FROM book_generation_sessions WHERE book_id = $1', [bookId]);
            await postgres.query('DELETE FROM generation_cancellations WHERE book_id = $1', [bookId]);
            await postgres.query('DELETE FROM agent_sessions WHERE book_id = $1', [bookId]);
            await postgres.query('DELETE FROM generation_tasks WHERE book_id = $1', [bookId]);
        }
    });

    it('cancel → tombstone in PG → startup-resume SKIPS the cancelled book (Redis wiped simulation)', async () => {
        // ── Given: a VBook generation session that was interrupted (still 'generating') ──
        const session = await genSessionRepo.createSession(TEST_BOOK_CANCELLED, 0, 3);
        await genSessionRepo.updateSession(session.id, { status: 'generating' });

        // ── And: the user cancelled (tombstone persisted in PG, survives Redis loss) ──
        await generationCancelRepo.setCancelled(TEST_BOOK_CANCELLED, {
            reason: 'user_cancelled',
            createdBy: 'cancel-generation',
        });

        // ── When: backend restarts (Redis state is gone — startup-resume reads only PG) ──
        const started = [];
        await resumeIncompleteSessions(() => {}, async (bookId, sessionId) => {
            started.push({ bookId, sessionId });
        });
        await flushImmediates();

        // ── Then: the cancelled session is NEVER resumed ──
        expect(onlyTestBooks(started)).to.deep.equal([]);

        // And its status is untouched (not flipped to 'pending' for resume).
        const rows = await postgres.query(
            'SELECT status FROM book_generation_sessions WHERE id = $1',
            [session.id]
        );
        expect(rows.rows[0].status).to.equal('generating');
    });

    it('live book (no tombstone) IS resumed on startup', async () => {
        const session = await genSessionRepo.createSession(TEST_BOOK_LIVE, 0, 3);
        await genSessionRepo.updateSession(session.id, { status: 'generating' });

        const started = [];
        await resumeIncompleteSessions(() => {}, async (bookId, sessionId) => {
            started.push({ bookId, sessionId });
        });
        await flushImmediates();

        expect(onlyTestBooks(started)).to.deep.equal([{ bookId: TEST_BOOK_LIVE, sessionId: session.id }]);
    });

    it('cancelled book IS resumable after regenerate clears the tombstone (explicit new run)', async () => {
        // User cancelled, then explicitly started a new run → regenerate clears tombstone.
        await generationCancelRepo.setCancelled(TEST_BOOK_CANCELLED, { reason: 'user_cancelled' });
        await generationCancelRepo.clear(TEST_BOOK_CANCELLED);

        const session = await genSessionRepo.createSession(TEST_BOOK_CANCELLED, 0, 3);
        await genSessionRepo.updateSession(session.id, { status: 'generating' });

        const started = [];
        await resumeIncompleteSessions(() => {}, async (bookId, sessionId) => {
            started.push({ bookId, sessionId });
        });
        await flushImmediates();

        expect(onlyTestBooks(started)).to.deep.equal([{ bookId: TEST_BOOK_CANCELLED, sessionId: session.id }]);
    });

    it('regenerate-style flow: cancel then regenerate then restart → resumed (full cycle)', async () => {
        const session = await genSessionRepo.createSession(TEST_BOOK_CANCELLED, 0, 3);
        await genSessionRepo.updateSession(session.id, { status: 'generating' });

        // cancel-generation
        await generationCancelRepo.setCancelled(TEST_BOOK_CANCELLED, { reason: 'user_cancelled' });

        // Redis wiped here (no Redis state consulted by startup-resume)

        // startup-resume #1: skipped
        let started = [];
        await resumeIncompleteSessions(() => {}, async (bookId, sessionId) => {
            started.push({ bookId, sessionId });
        });
        await flushImmediates();
        expect(onlyTestBooks(started)).to.deep.equal([]);

        // user explicitly re-runs → regenerate clears tombstone
        await generationCancelRepo.clear(TEST_BOOK_CANCELLED);

        // startup-resume #2 (another restart): resumed
        started = [];
        await resumeIncompleteSessions(() => {}, async (bookId, sessionId) => {
            started.push({ bookId, sessionId });
        });
        await flushImmediates();
        expect(onlyTestBooks(started)).to.deep.equal([{ bookId: TEST_BOOK_CANCELLED, sessionId: session.id }]);
    });
});
