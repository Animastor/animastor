const { query } = require('../database');

const logPrefix = '[BOOK-REPO]';

async function ensureBook(bookId, title, author, language) {
    await query(`
        INSERT INTO books (book_id, title, author, language, updated_at)
        VALUES ($1, $2, $3, $4, EXTRACT(EPOCH FROM NOW())::bigint)
        ON CONFLICT(book_id) DO UPDATE SET
            title = COALESCE(NULLIF($5, ''), books.title),
            author = COALESCE(NULLIF($6, ''), books.author),
            language = COALESCE(NULLIF($7, ''), books.language),
            updated_at = EXTRACT(EPOCH FROM NOW())::bigint
    `, [bookId, title || null, author || null, language || 'en',
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

module.exports = {
    ensureBook,
    saveBookSnapshot,
    loadLatestSnapshot,
    loadSnapshotByVersion,
    markSnapshotState,
    getSnapshotHistory,
    deleteBookSnapshots,
};
