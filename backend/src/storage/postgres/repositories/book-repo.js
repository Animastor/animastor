const { query } = require('../database');

const logPrefix = '[BOOK-REPO]';

async function ensureBook(bookId, title, author, language, workspaceId) {
    await query(`
        INSERT INTO books (book_id, title, author, language, workspace_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, EXTRACT(EPOCH FROM NOW())::bigint)
        ON CONFLICT(book_id) DO UPDATE SET
            title = COALESCE(NULLIF($6, ''), books.title),
            author = COALESCE(NULLIF($7, ''), books.author),
            language = COALESCE(NULLIF($8, ''), books.language),
            workspace_id = COALESCE(books.workspace_id, EXCLUDED.workspace_id),
            updated_at = EXTRACT(EPOCH FROM NOW())::bigint
    `, [bookId, title || null, author || null, language || 'en', workspaceId || null,
        title || '', author || '', language || '']);
}

async function saveBookSnapshot(bookId, bookJson) {
    await ensureBook(bookId);

    const result = await query(
        'SELECT COALESCE(MAX(version), 0) as v FROM book_snapshots WHERE book_id = $1',
        [bookId]
    );
    const lastVersion = result.rows[0]?.v || 0;
    const newVersion = lastVersion + 1;

    await query(`
        INSERT INTO book_snapshots (book_id, version, snapshot, state)
        VALUES ($1, $2, $3::jsonb, 'new')
    `, [bookId, newVersion, JSON.stringify(bookJson)]);

    return { book_id: bookId, version: newVersion };
}

async function loadLatestSnapshot(bookId) {
    const result = await query(`
        SELECT * FROM book_snapshots
        WHERE book_id = $1
        ORDER BY version DESC LIMIT 1
    `, [bookId]);

    const row = result.rows[0];
    if (!row) return null;
    return { ...row, snapshot: row.snapshot };
}

async function loadSnapshotByVersion(bookId, version) {
    const result = await query(
        'SELECT * FROM book_snapshots WHERE book_id = $1 AND version = $2',
        [bookId, version]
    );

    const row = result.rows[0];
    if (!row) return null;
    return { ...row, snapshot: row.snapshot };
}

async function markSnapshotState(bookId, version, state) {
    await query(
        'UPDATE book_snapshots SET state = $1 WHERE book_id = $2 AND version = $3',
        [state, bookId, version]
    );
}

async function getSnapshotHistory(bookId, limit = 10) {
    const result = await query(`
        SELECT id, book_id, version, state, created_at
        FROM book_snapshots WHERE book_id = $1
        ORDER BY version DESC LIMIT $2
    `, [bookId, limit]);

    return result.rows;
}

async function deleteBookSnapshots(bookId) {
    await query('DELETE FROM book_snapshots WHERE book_id = $1', [bookId]);
    await query('DELETE FROM books WHERE book_id = $1', [bookId]);
}

/**
 * Resolve a book's workspace_id from the books registry.
 * @returns {Promise<string|null>} workspace_id or null (book absent / unattached)
 */
async function getWorkspaceId(bookId) {
    if (!bookId) return null;
    const result = await query(
        `SELECT workspace_id FROM books WHERE book_id = $1 LIMIT 1`,
        [bookId]
    );
    return result.rows[0]?.workspace_id || null;
}

/**
 * Detached book recovery: attach a workspace to a book that has none
 * (ONLY when the row currently has workspace_id IS NULL).
 * Returns true when a row was attached. Never overwrites an existing workspace.
 */
async function attachWorkspaceIfMissing(bookId, workspaceId) {
    if (!bookId || !workspaceId) return false;
    const result = await query(
        `UPDATE books SET workspace_id = $2, updated_at = EXTRACT(EPOCH FROM NOW())::bigint
         WHERE book_id = $1 AND workspace_id IS NULL RETURNING book_id`,
        [bookId, workspaceId]
    );
    return result.rowCount > 0;
}

/**
 * List the book_ids owned by a workspace (ownership registry — books table).
 * Source of truth for "which books does this workspace own"; book_source only
 * indexes TXT-imported sources, so blank/.vbook books live here exclusively.
 * @returns {Promise<Array<{book_id:string, workspace_id:string}>>}
 */
async function listBookIdsByWorkspace(workspaceId) {
    if (!workspaceId) return [];
    const result = await query(
        `SELECT book_id, workspace_id FROM books WHERE workspace_id = $1`,
        [workspaceId]
    );
    return result.rows;
}

module.exports = {
    ensureBook,
    getWorkspaceId,
    attachWorkspaceIfMissing,
    listBookIdsByWorkspace,
    saveBookSnapshot,
    loadLatestSnapshot,
    loadSnapshotByVersion,
    markSnapshotState,
    getSnapshotHistory,
    deleteBookSnapshots,
};
