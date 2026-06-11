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
    deleteByBookId,
};
