// ======================================================
// Generation Cancellation Tombstone Repository
// ======================================================
// Persistent marker that the user explicitly cancelled generation for a book
// (Cathedral Recon #3 §5.4 option 1). Written on POST /cancel-generation,
// cleared on POST /regenerate (explicit new run). Survives Redis loss so that
// automatic resumption paths (startup-resume, future work-list rebuild) can
// never resurrect an explicitly cancelled generation.
//
// Table: generation_cancellations (book_id PK, cancelled_at, reason, created_by)

const { query } = require('../database');

/**
 * Record a cancellation tombstone for a book. Idempotent — re-cancelling
 * refreshes the timestamp/reason but keeps a single row.
 *
 * @param {string} bookId
 * @param {{ reason?: string, createdBy?: string }} [opts]
 * @returns {Promise<{ book_id: string, cancelled: boolean }>}
 */
async function setCancelled(bookId, opts = {}) {
    const reason = opts.reason || 'user_cancelled';
    const createdBy = opts.createdBy || 'cancel-generation';
    await query(
        `INSERT INTO generation_cancellations (book_id, reason, created_by, updated_at)
         VALUES ($1, $2, $3, EXTRACT(EPOCH FROM NOW())::bigint)
         ON CONFLICT (book_id) DO UPDATE SET
             reason = EXCLUDED.reason,
             created_by = EXCLUDED.created_by,
             updated_at = EXTRACT(EPOCH FROM NOW())::bigint`,
        [bookId, reason, createdBy]
    );
    return { book_id: bookId, cancelled: true };
}

/**
 * Remove the cancellation tombstone (user explicitly started a new run).
 * @param {string} bookId
 * @returns {Promise<{ book_id: string, cancelled: boolean }>}
 */
async function clear(bookId) {
    await query('DELETE FROM generation_cancellations WHERE book_id = $1', [bookId]);
    return { book_id: bookId, cancelled: false };
}

/**
 * @param {string} bookId
 * @returns {Promise<boolean>} true if the book has an active cancellation tombstone
 */
async function isCancelled(bookId) {
    const result = await query(
        'SELECT 1 FROM generation_cancellations WHERE book_id = $1 LIMIT 1',
        [bookId]
    );
    return result.rows.length > 0;
}

/**
 * All books with a cancellation tombstone — the set that automatic resumption
 * and the future work-list rebuild must skip.
 * @returns {Promise<Array<{book_id: string, cancelled_at: number, reason: string, created_by: string}>>}
 */
async function getAllCancelled() {
    const result = await query(
        `SELECT book_id, cancelled_at, reason, created_by
         FROM generation_cancellations
         ORDER BY cancelled_at DESC`
    );
    return result.rows;
}

module.exports = {
    setCancelled,
    clear,
    isCancelled,
    getAllCancelled,
};
