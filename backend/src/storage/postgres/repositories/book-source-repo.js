// ======================================================
// Book Source Repository
// ======================================================
// Maps SHA256 file hashes to book_id for TXT deduplication
// and vbook identity restoration.
// ======================================================

const { query } = require('../database');

/**
 * Register a new source file → book_id mapping.
 */
async function registerSource(fileHash, fileName, fileSize, bookId, sourceType) {
    const result = await query(
        `INSERT INTO book_source (file_hash, file_name, file_size, book_id, source_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (file_hash) DO UPDATE SET
           book_id = EXCLUDED.book_id,
           file_name = EXCLUDED.file_name,
           file_size = EXCLUDED.file_size
         RETURNING *`,
        [fileHash, fileName || '', fileSize || 0, bookId, sourceType || 'txt']
    );
    return result.rows[0];
}

/**
 * Find a book by file hash.
 */
async function findByHash(fileHash) {
    if (!fileHash) return null;
    const result = await query(
        `SELECT * FROM book_source WHERE file_hash = $1 LIMIT 1`,
        [fileHash]
    );
    return result.rows[0] || null;
}

/**
 * Find a source record by book_id.
 */
async function findByBookId(bookId) {
    if (!bookId) return null;
    const result = await query(
        `SELECT * FROM book_source WHERE book_id = $1 LIMIT 1`,
        [bookId]
    );
    return result.rows[0] || null;
}

/**
 * Quick check by filesize only (fast pre-filter before SHA256).
 * Does NOT check file_name because Android file picker generates random temp filenames.
 * Returns up to 5 most recent candidates — caller must verify SHA256.
 */
async function findCandidateBySize(fileSize) {
    if (!fileSize) return null;
    const result = await query(
        `SELECT * FROM book_source WHERE file_size = $1 ORDER BY created_at DESC LIMIT 5`,
        [fileSize]
    );
    return result.rows;  // return all candidates — caller must verify SHA256
}

/**
 * List the most recently imported source records (newest first).
 * Used by GET /api/v1/books so any client can discover which books exist on
 * the server (e.g. a book imported from the web app, then opened on Android).
 *
 * Every row is LEFT JOINed with the books registry so callers see the owning
 * workspace (workspace_id is NULL for books with no registry row yet).
 *
 * @param {number} limit
 * @param {object} [options]
 * @param {string} [options.workspaceId] - When set, only return records that
 *   already belong to this workspace OR have no owner row yet (self-heal
 *   candidates). Books owned by a different workspace are never returned.
 */
async function listRecent(limit = 20, { workspaceId = null } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    let sql;
    let params;
    if (workspaceId) {
        sql = `SELECT bs.*, b.workspace_id AS workspace_id
               FROM book_source bs
               LEFT JOIN books b ON b.book_id = bs.book_id
               WHERE b.workspace_id IS NULL OR b.workspace_id = $1
               ORDER BY bs.created_at DESC LIMIT $2`;
        params = [workspaceId, safeLimit];
    } else {
        sql = `SELECT bs.*, b.workspace_id AS workspace_id
               FROM book_source bs
               LEFT JOIN books b ON b.book_id = bs.book_id
               ORDER BY bs.created_at DESC LIMIT $1`;
        params = [safeLimit];
    }
    const result = await query(sql, params);
    return result.rows;
}

/**
 * Delete a source record by book_id (when book is deleted).
 */
async function deleteByBookId(bookId) {
    await query(`DELETE FROM book_source WHERE book_id = $1`, [bookId]);
}

module.exports = {
    registerSource,
    findByHash,
    findByBookId,
    findCandidateBySize,
    listRecent,
    deleteByBookId,
};
