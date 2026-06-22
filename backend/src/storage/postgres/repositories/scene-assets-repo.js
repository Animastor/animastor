const { query } = require('../database');

const logPrefix = '[SCENE-ASSETS-REPO]';

function rowToAsset(row) {
    if (!row) return null;
    return {
        id: row.id,
        book_id: row.book_id,
        chapter_id: row.chapter_id,
        scene_id: row.scene_id,
        asset_type: row.asset_type,
        path: row.path,
        duration_sec: row.duration_sec,
        width: row.width,
        height: row.height,
        format: row.format,
        sample_rate: row.sample_rate,
        channel_count: row.channel_count,
        chunks: row.chunks,
        build_id: row.build_id,
        scene_hash: row.scene_hash,
        scene_content_version: row.scene_content_version,
        scene_audio_config_version: row.scene_audio_config_version,
        status: row.status,
        error: row.error,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

async function upsertAsset(asset) {
    const {
        book_id, chapter_id, scene_id, asset_type,
        path = null, duration_sec = null, width = null, height = null,
        format = null, sample_rate = null, channel_count = null,
        chunks = null, build_id = null, scene_hash = null,
        scene_content_version = null, scene_audio_config_version = null,
        status = 'pending', error = null, metadata = null,
    } = asset;

    const result = await query(`
        INSERT INTO scene_assets (
            book_id, chapter_id, scene_id, asset_type,
            path, duration_sec, width, height,
            format, sample_rate, channel_count,
            chunks, build_id, scene_hash,
            scene_content_version, scene_audio_config_version,
            status, error, metadata,
            updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19::jsonb,
                EXTRACT(EPOCH FROM NOW())::bigint)
        ON CONFLICT(book_id, chapter_id, scene_id, asset_type, build_id) DO UPDATE SET
            path = COALESCE(EXCLUDED.path, scene_assets.path),
            duration_sec = COALESCE(EXCLUDED.duration_sec, scene_assets.duration_sec),
            width = COALESCE(EXCLUDED.width, scene_assets.width),
            height = COALESCE(EXCLUDED.height, scene_assets.height),
            format = COALESCE(EXCLUDED.format, scene_assets.format),
            sample_rate = COALESCE(EXCLUDED.sample_rate, scene_assets.sample_rate),
            channel_count = COALESCE(EXCLUDED.channel_count, scene_assets.channel_count),
            chunks = COALESCE(EXCLUDED.chunks, scene_assets.chunks),
            scene_hash = COALESCE(EXCLUDED.scene_hash, scene_assets.scene_hash),
            scene_content_version = COALESCE(EXCLUDED.scene_content_version, scene_assets.scene_content_version),
            scene_audio_config_version = COALESCE(EXCLUDED.scene_audio_config_version, scene_assets.scene_audio_config_version),
            status = EXCLUDED.status,
            error = EXCLUDED.error,
            metadata = COALESCE(EXCLUDED.metadata, scene_assets.metadata),
            updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        RETURNING *
    `, [
        book_id, chapter_id, scene_id, asset_type,
        path, duration_sec, width, height,
        format, sample_rate, channel_count,
        chunks ? JSON.stringify(chunks) : null,
        build_id, scene_hash,
        scene_content_version, scene_audio_config_version,
        status, error,
        metadata ? JSON.stringify(metadata) : null,
    ]);
    return rowToAsset(result.rows[0]);
}

async function markReady(bookId, chapterId, sceneId, assetType, path, extras = {}) {
    return upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId, asset_type: assetType,
        path, status: 'ready', ...extras,
    });
}

async function markStale(bookId, chapterId, sceneId, assetType, buildId = null) {
    const where = ['book_id = $1', 'chapter_id = $2', 'scene_id = $3', 'asset_type = $4'];
    const params = [bookId, chapterId, sceneId, assetType];
    if (buildId) {
        where.push('build_id = $5');
        params.push(buildId);
    }
    const result = await query(`
        UPDATE scene_assets SET status = 'stale', updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE ${where.join(' AND ')}
    `, params);
    return result.rowCount || 0;
}

async function markFailed(bookId, chapterId, sceneId, assetType, error, buildId = null) {
    return upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId, asset_type: assetType,
        status: 'failed', error, build_id: buildId,
    });
}

async function getAsset(bookId, chapterId, sceneId, assetType, buildId = null) {
    const where = ['book_id = $1', 'chapter_id = $2', 'scene_id = $3', 'asset_type = $4'];
    const params = [bookId, chapterId, sceneId, assetType];
    if (buildId) {
        where.push('build_id = $5');
        params.push(buildId);
    }
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE ${where.join(' AND ')}
        ORDER BY (build_id IS NOT NULL) DESC, updated_at DESC
        LIMIT 1
    `, params);
    return rowToAsset(result.rows[0]);
}

async function getSceneAssets(bookId, chapterId, sceneId) {
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
        ORDER BY asset_type
    `, [bookId, chapterId, sceneId]);
    return result.rows.map(rowToAsset);
}

async function getAssetsByType(bookId, assetType) {
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1 AND asset_type = $2
        ORDER BY chapter_id, scene_id
    `, [bookId, assetType]);
    return result.rows.map(rowToAsset);
}

async function getAssetsByBuild(buildId) {
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE build_id = $1
        ORDER BY chapter_id, scene_id, asset_type
    `, [buildId]);
    return result.rows.map(rowToAsset);
}

async function getStaleAssets(bookId) {
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1 AND status = 'stale'
        ORDER BY updated_at
    `, [bookId]);
    return result.rows.map(rowToAsset);
}

async function getOutdatedByHash(bookId, currentHashes) {
    if (!currentHashes || currentHashes.size === 0) return [];
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1
    `, [bookId]);
    const outdated = [];
    for (const row of result.rows) {
        const asset = rowToAsset(row);
        const key = `${asset.chapter_id}:${asset.scene_id}`;
        const current = currentHashes.get(key);
        if (current && asset.scene_hash && asset.scene_hash !== current && asset.status === 'ready') {
            outdated.push(asset);
        }
    }
    return outdated;
}

/**
 * R15: Find assets that are outdated based on version comparison.
 * An asset is outdated if its stored version is less than the scene's
 * current version. This is the version-based alternative to hash comparison.
 *
 * @param {string} bookId
 * @param {Map<string, {content_version: number, audio_config_version: number}>} sceneVersions
 *   Map of "chapter_id:scene_id" -> { content_version, audio_config_version }
 * @returns {Promise<Array>} outdated assets
 */
async function getOutdatedByVersions(bookId, sceneVersions) {
    if (!sceneVersions || sceneVersions.size === 0) return [];
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1
    `, [bookId]);
    const outdated = [];
    for (const row of result.rows) {
        const asset = rowToAsset(row);
        const key = `${asset.chapter_id}:${asset.scene_id}`;
        const sv = sceneVersions.get(key);
        if (!sv || asset.status !== 'ready') continue;

        // Check content version
        if (asset.scene_content_version != null && sv.content_version != null &&
            asset.scene_content_version < sv.content_version) {
            outdated.push({
                ...asset,
                _outdated_reason: 'content_version',
                _expected_version: sv.content_version,
            });
            continue;
        }

        // Check audio config version
        if (asset.scene_audio_config_version != null && sv.audio_config_version != null &&
            asset.scene_audio_config_version < sv.audio_config_version) {
            outdated.push({
                ...asset,
                _outdated_reason: 'audio_config_version',
                _expected_version: sv.audio_config_version,
            });
        }
    }
    return outdated;
}

async function isSceneReady(bookId, chapterId, sceneId, assetType) {
    const asset = await getAsset(bookId, chapterId, sceneId, assetType);
    return !!(asset && asset.status === 'ready' && asset.path);
}

async function deleteSceneAssets(bookId, chapterId, sceneId) {
    await query(`
        DELETE FROM scene_assets
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId]);
}

async function deleteBookAssets(bookId) {
    await query('DELETE FROM scene_assets WHERE book_id = $1', [bookId]);
}

async function deleteBuildAssets(buildId) {
    await query('DELETE FROM scene_assets WHERE build_id = $1', [buildId]);
}

async function getBookAssetSummary(bookId) {
    const [total, ready, stale, pending, failed, placeholder] = await Promise.all([
        query('SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1', [bookId]),
        query("SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1 AND status = 'ready'", [bookId]),
        query("SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1 AND status = 'stale'", [bookId]),
        query("SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1 AND status = 'pending'", [bookId]),
        query("SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1 AND status = 'failed'", [bookId]),
        query("SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1 AND status = 'placeholder'", [bookId]),
    ]);
    return {
        total: total.rows[0].c,
        ready: ready.rows[0].c,
        stale: stale.rows[0].c,
        pending: pending.rows[0].c,
        failed: failed.rows[0].c,
        placeholder: placeholder.rows[0].c,
    };
}

/**
 * R13/R14: Bump version counters for dirty scenes.
 * Shared between PUT and /regenerate to eliminate duplicate SQL.
 * First ensures the row exists (UPSERT) so the UPDATE has effect.
 *
 * @param {string} bookId
 * @param {Array<{chapter_id:string, scene_id:string, reason:string, dirty_layers:string[]}>} dirtyScenes
 * @returns {Promise<number>} Number of scenes with bumped versions
 */
async function bumpSceneVersions(bookId, dirtyScenes) {
    let bumped = 0;
    for (const ds of dirtyScenes) {
        if (ds.reason === 'removed') continue;
        const bumpContent = ds.dirty_layers.includes('image') || ds.dirty_layers.includes('video');
        const bumpAudio = ds.dirty_layers.includes('audio');
        if (bumpContent || bumpAudio) {
            // First ensure the row exists (UPSERT — no-op if already present)
            await ensureSceneRow(bookId, ds.chapter_id, ds.scene_id);

            const setClauses = ['updated_at = EXTRACT(EPOCH FROM NOW())::bigint'];
            if (bumpContent) setClauses.push('content_version = content_version + 1');
            if (bumpAudio) setClauses.push('audio_config_version = audio_config_version + 1');
            await query(`
                UPDATE scenes
                SET ${setClauses.join(', ')}
                WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
            `, [bookId, ds.chapter_id, ds.scene_id]);
            bumped++;
        }
    }
    return bumped;
}

/**
 * Ensure a row exists in the scenes table for a given scene.
 * Uses INSERT … ON CONFLICT DO NOTHING to create the row if missing.
 * This is necessary because bumpSceneVersions and setDirtyUnitIds
 * both UPDATE scenes — without an existing row, the UPDATE is a no-op.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 */
async function ensureSceneRow(bookId, chapterId, sceneId) {
    await query(`
        INSERT INTO scenes (book_id, chapter_id, scene_id, content_version, audio_config_version, dirty_unit_ids, updated_at)
        VALUES ($1, $2, $3, 1, 1, '{}', EXTRACT(EPOCH FROM NOW())::bigint)
        ON CONFLICT (book_id, chapter_id, scene_id) DO NOTHING
    `, [bookId, chapterId, sceneId]);
}

/**
 * Set per-unit dirty IDs for a scene in PG.
 * These are the unit_ids whose content changed — used by executeImageDispatch
 * for granular force-regen instead of regenerating ALL units.
 *
 * Empty array = regenerate all units (no granular info available).
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string[]} unitIds - Array of changed unit IDs (empty = all units stale)
 */
async function setDirtyUnitIds(bookId, chapterId, sceneId, unitIds) {
    const ids = (unitIds && Array.isArray(unitIds) && unitIds.length > 0) ? unitIds : [];
    // First ensure the row exists (UPSERT — no-op if already present)
    await ensureSceneRow(bookId, chapterId, sceneId);
    await query(`
        UPDATE scenes
        SET dirty_unit_ids = $4, updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId, ids]);
}

/**
 * Get per-unit dirty IDs for a scene from PG.
 * Returns the array of unit_ids that need regeneration, or null if no row exists.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<string[]|null>}
 */
async function getDirtyUnitIds(bookId, chapterId, sceneId) {
    const result = await query(`
        SELECT dirty_unit_ids FROM scenes
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId]);
    if (result.rows.length > 0 && result.rows[0].dirty_unit_ids) {
        return result.rows[0].dirty_unit_ids;
    }
    return null;
}

/**
 * Clear per-unit dirty IDs for a scene in PG.
 * Called AFTER executeImageDispatch reads and dispatches dirty units,
 * so the next scheduler tick does NOT re-delete already-regenerated files.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 */
async function clearDirtyUnitIds(bookId, chapterId, sceneId) {
    await ensureSceneRow(bookId, chapterId, sceneId);
    await query(`
        UPDATE scenes
        SET dirty_unit_ids = '{}', updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId]);
}

module.exports = {
    upsertAsset,
    markReady,
    markStale,
    markFailed,
    getAsset,
    getSceneAssets,
    getAssetsByType,
    getAssetsByBuild,
    getStaleAssets,
    getOutdatedByHash,
    getOutdatedByVersions,
    bumpSceneVersions,
    ensureSceneRow,
    setDirtyUnitIds,
    getDirtyUnitIds,
    clearDirtyUnitIds,
    isSceneReady,
    deleteSceneAssets,
    deleteBookAssets,
    deleteBuildAssets,
    getBookAssetSummary,
};
