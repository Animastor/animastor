// ======================================================
// Generation Cancellation Tombstone Repository Tests
// ======================================================

const { expect } = require('chai');
const path = require('path');

const DB_PATH = require.resolve('../src/storage/postgres/database');
const REPO_PATH = require.resolve('../src/storage/postgres/repositories/generation-cancel-repo');

function loadRepoWithDb(dbMock) {
    delete require.cache[DB_PATH];
    delete require.cache[REPO_PATH];
    require.cache[DB_PATH] = { exports: dbMock, loaded: true };
    return require(REPO_PATH);
}

describe('generation-cancel-repo', () => {
    afterEach(() => {
        delete require.cache[DB_PATH];
        delete require.cache[REPO_PATH];
    });

    it('setCancelled upserts a tombstone row', async () => {
        const queries = [];
        const repo = loadRepoWithDb({
            query: async (text, params) => {
                queries.push({ text, params });
                return { rows: [] };
            },
        });

        const result = await repo.setCancelled('book-1', { reason: 'user_cancelled', createdBy: 'cancel-generation' });

        expect(result).to.deep.equal({ book_id: 'book-1', cancelled: true });
        expect(queries).to.have.length(1);
        expect(queries[0].text).to.include('INSERT INTO generation_cancellations');
        expect(queries[0].text).to.include('ON CONFLICT (book_id) DO UPDATE');
        expect(queries[0].params[0]).to.equal('book-1');
        expect(queries[0].params[1]).to.equal('user_cancelled');
        expect(queries[0].params[2]).to.equal('cancel-generation');
    });

    it('setCancelled uses defaults when options omitted', async () => {
        const queries = [];
        const repo = loadRepoWithDb({
            query: async (text, params) => {
                queries.push({ text, params });
                return { rows: [] };
            },
        });

        await repo.setCancelled('book-2');
        expect(queries[0].params[1]).to.equal('user_cancelled');
        expect(queries[0].params[2]).to.equal('cancel-generation');
    });

    it('clear deletes the tombstone row', async () => {
        const queries = [];
        const repo = loadRepoWithDb({
            query: async (text, params) => {
                queries.push({ text, params });
                return { rows: [] };
            },
        });

        const result = await repo.clear('book-1');
        expect(result).to.deep.equal({ book_id: 'book-1', cancelled: false });
        expect(queries[0].text).to.include('DELETE FROM generation_cancellations');
        expect(queries[0].params).to.deep.equal(['book-1']);
    });

    it('isCancelled returns true when a row exists', async () => {
        const repo = loadRepoWithDb({
            query: async () => ({ rows: [{ '?column?': 1 }] }),
        });
        expect(await repo.isCancelled('book-1')).to.equal(true);
    });

    it('isCancelled returns false when no row exists', async () => {
        const repo = loadRepoWithDb({
            query: async () => ({ rows: [] }),
        });
        expect(await repo.isCancelled('book-1')).to.equal(false);
    });

    it('getAllCancelled returns all tombstones ordered by cancelled_at desc', async () => {
        const rows = [
            { book_id: 'b2', cancelled_at: 200, reason: 'r2', created_by: 'cancel-generation' },
            { book_id: 'b1', cancelled_at: 100, reason: 'r1', created_by: 'cancel-generation' },
        ];
        let sawOrderBy = false;
        const repo = loadRepoWithDb({
            query: async (text) => {
                sawOrderBy = /ORDER BY cancelled_at DESC/.test(text);
                return { rows };
            },
        });

        const result = await repo.getAllCancelled();
        expect(result).to.deep.equal(rows);
        expect(sawOrderBy).to.equal(true);
    });
});
