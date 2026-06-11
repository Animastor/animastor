const { query } = require('../database');

const logPrefix = '[CACHE-REPO]';

async function ensureAssetEntry(bookId, chapterId, sceneId, assetType) {
    const assetKey = `${bookId}:${chapterId}:${sceneId}:${assetType}`;

    const result = await query('SELECT id FROM cache_entries WHERE asset_key = $1', [assetKey]);
    if (result.rows.length > 0) return result.rows[0].id;

    const insert = await query(`
        INSERT INTO cache_entries (asset_key, book_id, chapter_id, scene_id, asset_type, status)
        VALUES ($1, $2, $3, $4, $5, 'pending')
        RETURNING id
    `, [assetKey, bookId, chapterId || null, sceneId || null, assetType]);

    return insert.rows[0].id;
}

async function markAssetReady(bookId, chapterId, sceneId, assetType, filePath, fileSize, contentHash) {
    const assetKey = `${bookId}:${chapterId}:${sceneId}:${assetType}`;

    const existing = await query('SELECT id, version FROM cache_entries WHERE asset_key = $1', [assetKey]);

    if (existing.rows.length > 0) {
        await query(`
            UPDATE cache_entries
            SET status = 'ready', file_path = $1, file_size = $2, content_hash = $3,
                version = version + 1, updated_at = EXTRACT(EPOCH FROM NOW())::bigint
            WHERE asset_key = $4
        `, [filePath, fileSize, contentHash, assetKey]);
    } else {
        await query(`
            INSERT INTO cache_entries (asset_key, book_id, chapter_id, scene_id, asset_type,
                status, file_path, file_size, content_hash, version)
            VALUES ($1, $2, $3, $4, $5, 'ready', $6, $7, $8, 1)
        `, [assetKey, bookId, chapterId || null, sceneId, assetType, filePath, fileSize, contentHash]);
    }

    return { asset_key: assetKey, status: 'ready' };
}

async function markAssetStale(bookId, chapterId, sceneId, assetType) {
    const assetKey = `${bookId}:${chapterId}:${sceneId}:${assetType}`;
    const result = await query(`
        UPDATE cache_entries SET status = 'stale', updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE asset_key = $1
    `, [assetKey]);
    return (result.rowCount || 0) > 0;
}

async function getAssetEntry(bookId, chapterId, sceneId, assetType) {
    const assetKey = `${bookId}:${chapterId}:${sceneId}:${assetType}`;
    const result = await query('SELECT * FROM cache_entries WHERE asset_key = $1', [assetKey]);
    return result.rows[0] || null;
}

async function getSceneAssets(bookId, chapterId, sceneId) {
    const result = await query(`
        SELECT * FROM cache_entries
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
        ORDER BY asset_type
    `, [bookId, chapterId, sceneId]);
    return result.rows;
}

async function getStaleAssets(bookId) {
    const result = await query(`
        SELECT * FROM cache_entries
        WHERE book_id = $1 AND status = 'stale'
        ORDER BY updated_at
    `, [bookId]);
    return result.rows;
}

async function isSceneCached(bookId, chapterId, sceneId, assetType) {
    const entry = await getAssetEntry(bookId, chapterId, sceneId, assetType);
    return entry ? entry.status === 'ready' : false;
}

async function deleteBookCache(bookId) {
    await query('DELETE FROM cache_entries WHERE book_id = $1', [bookId]);
}

async function getCacheSummary(bookId) {
    const [total, ready, stale, pending] = await Promise.all([
        query('SELECT COUNT(*)::int as c FROM cache_entries WHERE book_id = $1', [bookId]),
        query("SELECT COUNT(*)::int as c FROM cache_entries WHERE book_id = $1 AND status = 'ready'", [bookId]),
        query("SELECT COUNT(*)::int as c FROM cache_entries WHERE book_id = $1 AND status = 'stale'", [bookId]),
        query("SELECT COUNT(*)::int as c FROM cache_entries WHERE book_id = $1 AND status = 'pending'", [bookId]),
    ]);

    return {
        total: total.rows[0].c,
        ready: ready.rows[0].c,
        stale: stale.rows[0].c,
        pending: pending.rows[0].c,
    };
}

module.exports = {
    ensureAssetEntry,
    markAssetReady,
    markAssetStale,
    getAssetEntry,
    getSceneAssets,
    getStaleAssets,
    isSceneCached,
    deleteBookCache,
    getCacheSummary,
};
