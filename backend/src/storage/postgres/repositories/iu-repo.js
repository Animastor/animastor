const { query } = require('../database');

const logPrefix = '[IU-REPO]';

async function upsertImageUnit(buildId, bookId, chapterId, sceneId, unitId, data) {
    await query(`
        INSERT INTO image_units (build_id, book_id, chapter_id, scene_id, unit_id, scene_order,
            text, text_length, text_proportion, scene_duration_sec, estimated_duration_sec, scene_audio_file, start_ms, end_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT(build_id, book_id, chapter_id, scene_id, unit_id) DO UPDATE SET
            scene_order = COALESCE($15, image_units.scene_order),
            text = COALESCE($16, image_units.text),
            text_length = COALESCE($17, image_units.text_length),
            text_proportion = COALESCE($18, image_units.text_proportion),
            scene_duration_sec = COALESCE($19, image_units.scene_duration_sec),
            estimated_duration_sec = COALESCE($20, image_units.estimated_duration_sec),
            scene_audio_file = COALESCE($21, image_units.scene_audio_file),
            start_ms = COALESCE($22, image_units.start_ms),
            end_ms = COALESCE($23, image_units.end_ms)
    `, [
        buildId, bookId, chapterId, sceneId, unitId,
        data.scene_order || 0,
        data.text || null,
        data.text_length || 0,
        data.text_proportion || 0,
        data.scene_duration_sec || 0,
        data.estimated_duration_sec || 0,
        data.scene_audio_file || null,
        data.start_ms != null ? Number(data.start_ms) : null,
        data.end_ms != null ? Number(data.end_ms) : null,
        data.scene_order || null,
        data.text || null,
        data.text_length || null,
        data.text_proportion || null,
        data.scene_duration_sec || null,
        data.estimated_duration_sec || null,
        data.scene_audio_file || null,
        data.start_ms !== undefined ? data.start_ms : null,
        data.end_ms !== undefined ? data.end_ms : null,
    ]);
}

async function upsertIuTiming(buildId, bookId, chapterId, sceneId, unitId, startMs, endMs) {
    await query(`
        INSERT INTO image_units (build_id, book_id, chapter_id, scene_id, unit_id, start_ms, end_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT(build_id, book_id, chapter_id, scene_id, unit_id) DO UPDATE SET
            start_ms = $8,
            end_ms = $9
    `, [buildId, bookId, chapterId, sceneId, unitId, startMs, endMs, startMs, endMs]);
}

async function getImageUnitsForScene(buildId, bookId, chapterId, sceneId) {
    const result = await query(`
        SELECT * FROM image_units
        WHERE build_id = $1 AND book_id = $2 AND chapter_id = $3 AND scene_id = $4
        ORDER BY scene_order ASC
    `, [buildId, bookId, chapterId, sceneId]);
    return result.rows;
}

async function getImageUnit(buildId, bookId, chapterId, sceneId, unitId) {
    const result = await query(`
        SELECT * FROM image_units
        WHERE build_id = $1 AND book_id = $2 AND chapter_id = $3 AND scene_id = $4 AND unit_id = $5
    `, [buildId, bookId, chapterId, sceneId, unitId]);
    return result.rows[0] || null;
}

async function deleteImageUnitsForBuild(buildId) {
    await query('DELETE FROM image_units WHERE build_id = $1', [buildId]);
}

async function deleteImageUnitsForScene(buildId, bookId, chapterId, sceneId) {
    await query(
        'DELETE FROM image_units WHERE build_id = $1 AND book_id = $2 AND chapter_id = $3 AND scene_id = $4',
        [buildId, bookId, chapterId, sceneId]
    );
}

async function countImageUnits(buildId, bookId) {
    const result = await query(
        'SELECT COUNT(*)::int as cnt FROM image_units WHERE build_id = $1 AND book_id = $2',
        [buildId, bookId]
    );
    return result.rows[0]?.cnt || 0;
}

async function getAllBuildIds() {
    const result = await query('SELECT DISTINCT build_id FROM image_units');
    return result.rows.map(r => r.build_id);
}

module.exports = {
    upsertImageUnit,
    upsertIuTiming,
    getImageUnitsForScene,
    getImageUnit,
    deleteImageUnitsForBuild,
    deleteImageUnitsForScene,
    countImageUnits,
    getAllBuildIds,
};
