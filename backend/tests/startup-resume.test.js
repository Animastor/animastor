// ======================================================
// Startup Resume — tombstone guard tests
// ======================================================
// Cathedral Recon #3 §5.4 option 1: startup-resume (Phase C5) must NOT
// auto-resume generation sessions of books the user explicitly cancelled.

const { expect } = require('chai');
const path = require('path');

const GEN_SESSION_PATH = require.resolve('../src/storage/postgres/repositories/gen-session-repo');
const CANCEL_REPO_PATH = require.resolve('../src/storage/postgres/repositories/generation-cancel-repo');
const STARTUP_RESUME_PATH = require.resolve('../src/startup-resume');

function loadStartupResume(genSessionMock, cancelRepoMock) {
    delete require.cache[GEN_SESSION_PATH];
    delete require.cache[CANCEL_REPO_PATH];
    delete require.cache[STARTUP_RESUME_PATH];
    require.cache[GEN_SESSION_PATH] = { exports: genSessionMock, loaded: true };
    require.cache[CANCEL_REPO_PATH] = { exports: cancelRepoMock, loaded: true };
    return require(STARTUP_RESUME_PATH);
}

const flushImmediates = () => new Promise(resolve => setImmediate(resolve));

describe('startup-resume tombstone guard', () => {
    afterEach(() => {
        delete require.cache[GEN_SESSION_PATH];
        delete require.cache[CANCEL_REPO_PATH];
        delete require.cache[STARTUP_RESUME_PATH];
    });

    it('skips sessions of cancelled books and resumes the rest', async () => {
        const sessions = [
            { id: 's1', book_id: 'cancelled-book', window_index: 0, status: 'generating' },
            { id: 's2', book_id: 'live-book', window_index: 1, status: 'generating' },
        ];
        const cancelledSet = new Set(['cancelled-book']);
        const updated = [];
        const started = [];

        const genSessionMock = {
            getActiveSessions: async () => sessions,
            updateSession: async (id, updates) => {
                updated.push({ id, updates });
                return {};
            },
        };
        const cancelRepoMock = {
            isCancelled: async (bookId) => cancelledSet.has(bookId),
        };

        const { resumeIncompleteSessions } = loadStartupResume(genSessionMock, cancelRepoMock);
        await resumeIncompleteSessions(() => {}, async (bookId, sessionId) => {
            started.push({ bookId, sessionId });
        });
        await flushImmediates();

        expect(started).to.deep.equal([{ bookId: 'live-book', sessionId: 's2' }]);
        // Only the live book's generating session is flipped to pending.
        expect(updated).to.deep.equal([
            { id: 's2', updates: { status: 'pending', error: null } },
        ]);
    });

    it('resumes all sessions when no book is cancelled', async () => {
        const sessions = [
            { id: 's1', book_id: 'b1', window_index: 0, status: 'generating' },
            { id: 's2', book_id: 'b2', window_index: 1, status: 'pending' },
        ];
        const started = [];

        const genSessionMock = {
            getActiveSessions: async () => sessions,
            updateSession: async () => ({}),
        };
        const cancelRepoMock = {
            isCancelled: async () => false,
        };

        const { resumeIncompleteSessions } = loadStartupResume(genSessionMock, cancelRepoMock);
        await resumeIncompleteSessions(() => {}, async (bookId, sessionId) => {
            started.push({ bookId, sessionId });
        });
        await flushImmediates();

        expect(started).to.deep.equal([
            { bookId: 'b1', sessionId: 's1' },
            { bookId: 'b2', sessionId: 's2' },
        ]);
    });

    it('resumes everything if the tombstone check itself fails (fail-open, logged)', async () => {
        const sessions = [
            { id: 's1', book_id: 'b1', window_index: 0, status: 'pending' },
        ];
        const warnings = [];
        const started = [];
        const origWarn = console.warn;
        console.warn = (msg) => { warnings.push(msg); };

        try {
            const genSessionMock = {
                getActiveSessions: async () => sessions,
                updateSession: async () => ({}),
            };
            const cancelRepoMock = {
                isCancelled: async () => { throw new Error('pg down'); },
            };

            const { resumeIncompleteSessions } = loadStartupResume(genSessionMock, cancelRepoMock);
            await resumeIncompleteSessions(() => {}, async (bookId, sessionId) => {
                started.push({ bookId, sessionId });
            });
            await flushImmediates();

            expect(started).to.deep.equal([{ bookId: 'b1', sessionId: 's1' }]);
            expect(warnings.length).to.be.at.least(1);
            expect(warnings[0]).to.include('Tombstone check failed');
        } finally {
            console.warn = origWarn;
        }
    });
});
